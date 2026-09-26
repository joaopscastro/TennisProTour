'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PlannerWeekDto,
  PlayerDto,
  TournamentDto,
  fetchEntryPlanner,
  fetchOpenTournaments,
  fetchRoster,
  fetchStartedTournaments,
  registerEntrant,
} from '../../lib/api';
import { AppShell } from '../../components/ui/AppShell';
import { SeasonEvents } from '../../components/SeasonEvents';
import { TournamentRewardSummary } from '../../components/TournamentRewards';
import {
  AgeBandBadge,
  Badge,
  Button,
  PageShell,
  Panel,
  SectionLabel,
  SurfaceBadge,
} from '../../components/ui/primitives';
import { Icon } from '../../components/ui/Icon';
import { Tabs } from '../../components/ui/Tabs';
import { surfaceMeta } from '../../lib/ui/surfaces';
import { formatMoney } from '../../lib/format';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { describeBrowseFilters, isTournamentFinished, managerEntrantLabel, plannerWeekBlockReason, pruneTiersForCategory, sortTournamentsForPicker, tierChipAppliesToCategory, tournamentHasRoom } from '../../lib/tournamentPick';

const PLANNER_WEEKS = 6;

type Category = 'all' | 'senior' | 'junior';
/** Deliberately mixes age bands and senior tiers into one flat chip
 * set — a junior tournament's real tier is one of six J-grades
 * (j30-j500), but the age-band badge (U14/U16), not the J-grade, is
 * what every other screen in this app already surfaces as "which
 * junior tier" (see docs/ui-direction.md's age-band-badge convention),
 * so filtering by U14/U16 here matches that same mental model instead
 * of introducing a second, unfamiliar J-grade filter. */
type TierFilterValue = 'u14' | 'u16' | 'u18' | 'futures' | 'challenger' | 'tour' | 'major';

const TIER_CHIPS: Array<{ value: TierFilterValue; label: string }> = [
  { value: 'u14', label: 'U14' },
  { value: 'u16', label: 'U16' },
  { value: 'u18', label: 'U18' },
  { value: 'futures', label: 'Futures' },
  { value: 'challenger', label: 'Challenger' },
  { value: 'tour', label: 'Tour' },
  { value: 'major', label: 'Major' },
];

const SURFACE_CHIPS: Array<{ value: string; label: string }> = [
  { value: 'clay', label: 'Clay' },
  { value: 'grass', label: 'Grass' },
  { value: 'hard', label: 'Hard' },
  { value: 'indoor', label: 'Indoor' },
];

/** The out-of-the-box filter selection — the senior tour, ALL tiers.
 * This deliberately replaces the old `['tour']` default: pinning a
 * first-time visitor to a single tier (`tour`, the third-highest senior
 * level) hid exactly the futures/challenger events a brand-new, unranked
 * roster should be entering, and made the list read as ~50 identical
 * 64-draw rows. An empty tier set is the filter bar's "no restriction
 * from this group" state, so a newcomer sees a sensible spread of levels;
 * once the manager picks a filter, their last selection is persisted
 * (localStorage) and becomes their default on the next visit. */
const DEFAULT_CATEGORY: Category = 'senior';
const DEFAULT_TIERS: readonly TierFilterValue[] = [];

/** Storage key for the manager's last-used filter state. Versioned so a
 * future change to the filter model (renamed tiers/surfaces) can be
 * introduced without stale stored values wedging the page. Bumped to v3
 * when the default moved off the single-tier `['tour']` selection, so a
 * stale v2 save can't reintroduce the problem. */
const FILTERS_STORAGE_KEY = 'gc-tournaments-filters-v3';

const VALID_CATEGORIES: readonly Category[] = ['all', 'senior', 'junior'];
const VALID_TIERS: readonly TierFilterValue[] = ['u14', 'u16', 'u18', 'futures', 'challenger', 'tour', 'major'];
const VALID_SURFACES: readonly string[] = ['clay', 'grass', 'hard', 'indoor'];

interface PersistedTournamentFilters {
  category: Category;
  tiers: TierFilterValue[];
  surfaces: string[];
}

/** Reads the manager's persisted filter state, tolerating any corrupt
 * blob (returns null so the caller falls back to the defaults). Loaded
 * values are filtered through the VALID_* lists so a future code change
 * that removes a tier/surface can't leave a stale value stuck in a
 * manager's stored prefs. */
function loadPersistedFilters(): PersistedTournamentFilters | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTournamentFilters>;
    const category = parsed.category && VALID_CATEGORIES.includes(parsed.category) ? parsed.category : DEFAULT_CATEGORY;
    const tiers = Array.isArray(parsed.tiers) ? parsed.tiers.filter((t) => VALID_TIERS.includes(t)) : [...DEFAULT_TIERS];
    // Sanitize against the category too — a pre-fix stored combination
    // (e.g. category 'junior' with the senior-only 'tour' chip) would
    // otherwise load into an impossible filter that renders the list empty.
    return {
      category,
      tiers: [...pruneTiersForCategory(category, new Set(tiers))],
      surfaces: Array.isArray(parsed.surfaces) ? parsed.surfaces.filter((s) => VALID_SURFACES.includes(s)) : [],
    };
  } catch {
    return null;
  }
}

/** Writes the manager's filter state. Failures (private mode / full
 * quota) are swallowed — the only consequence is filters not persisting,
 * never a broken page. */
function savePersistedFilters(filters: PersistedTournamentFilters): void {
  try {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // noop — persistence is best-effort
  }
}

function tierKeyFor(t: TournamentDto): TierFilterValue {
  return (t.ageBand ?? t.tier) as TierFilterValue;
}

/** Empty selection in a chip group means "no restriction from this
 * group" — the standard toggle-chip-filter convention (nothing picked
 * = show everything), not "nothing picked = show nothing." Category,
 * tier, and surface are combined with AND: picking "Junior" plus
 * "Futures" is a real, honestly-empty combination (no result), not
 * something this filter bar tries to prevent by disabling chips. */
function matchesFilters(t: TournamentDto, category: Category, tiers: ReadonlySet<TierFilterValue>, surfaces: ReadonlySet<string>): boolean {
  if (category === 'senior' && t.ageBand !== null) return false;
  if (category === 'junior' && t.ageBand === null) return false;
  if (tiers.size > 0 && !tiers.has(tierKeyFor(t))) return false;
  if (surfaces.size > 0 && !surfaces.has(t.surface)) return false;
  return true;
}

function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** One dense list row per tournament (Direction A: a table row, right-aligned
 * mono figures). The `gc-rowcover` anchor covers the whole `<tr>` — a table
 * row cannot itself be an anchor, and a plain `<a>` (never next/link) keeps
 * the immediate-URL-change behaviour the earlier dead-click fix required. */
function TournamentRow({ t, cta }: { t: TournamentDto; cta: string }) {
  const meta = surfaceMeta(t.surface);
  // Distinguish a finished bracket from one still being played, so a user
  // looking for played results can tell them apart without opening each one.
  const finished = t.hasStarted && isTournamentFinished(t);
  const managersLabel = managerEntrantLabel(t.managerEntrants);
  const championPoints = t.pointsBreakdown[0]?.points ?? 0;
  const championPrize = t.prizeMoneyBreakdown[0]?.prizeMoney ?? 0;
  return (
    <tr className="gc-rowlink">
      <td>
        <div className="gc-pcell">
          <span className="gc-surf4">
            <span className="s" title={meta.label}>
              <span className="gc-dot" style={{ background: meta.color }} />
              <span className="letter">{meta.letter}</span>
            </span>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-[6px] flex-wrap">
              <a className="gc-rowcover" style={{ fontWeight: 600 }} href={`/tournaments/${t.id}`}>
                {t.name}
              </a>
              <AgeBandBadge band={t.ageBand} />
              {t.hasStarted && (
                <Badge
                  title={finished ? 'This bracket has been played to its final — open it to watch any match replay' : 'This bracket is still being played'}
                  style={finished
                    ? { color: 'var(--win)', borderColor: 'color-mix(in srgb, var(--win) 45%, transparent)' }
                    : { color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' }}
                >
                  {finished && <Icon name="check" size={10} />}
                  {finished ? 'Finished' : 'In progress'}
                </Badge>
              )}
            </div>
            <div className="t-body-sm" style={{ fontSize: 11 }}>
              {t.tier} · {meta.label}
              {t.hostCountry && (
                <>
                  {' · '}
                  <Icon name="house" size={11} title="Host country — a player of this nationality has home advantage here" style={{ verticalAlign: 'text-bottom' }} />
                  {' '}{t.hostCountry}
                </>
              )}
              {managersLabel ? ` · ${managersLabel}` : ''}
            </div>
          </div>
        </div>
      </td>
      <td className="r num">{t.drawSize}</td>
      <td className="r num">{t.mainDrawEntrants}/{t.drawSize}</td>
      <td className="r num">{championPoints.toLocaleString()}</td>
      <td className="r num">{championPrize > 0 ? formatMoney(championPrize) : t.circuit === 'junior' ? '—' : formatMoney(0)}</td>
      <td className="num" style={{ color: 'var(--ink-3)' }}>S{t.weekScheduled.season} W{t.weekScheduled.week}</td>
      <td className="r" style={{ color: 'var(--ink-3)' }}>{cta} →</td>
    </tr>
  );
}

/** The dense list table chrome the two Browse sections share. */
function TournamentTable({ children }: { children: React.ReactNode }) {
  return (
    <Panel style={{ overflow: 'visible' }}>
      <table className="gc-table gc-table--dense">
        <thead>
          <tr>
            <th>Tournament</th>
            <th className="r">Draw</th>
            <th className="r">Entrants</th>
            <th className="r">Points</th>
            <th className="r">Prize</th>
            <th>Week</th>
            <th className="r">Open</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Panel>
  );
}

/**
 * The category/tier/surface filter bar — `.gc-chip` toggle chips (the
 * Direction A filter control), the same "empty selection in a group means
 * no restriction" convention as before. The "Showing …" line is the
 * honesty fix for the "All selected but only Tour shown" finding: it names
 * the applied filters so the displayed state can never contradict the list.
 */
function FilterBar({
  category,
  onCategory,
  tiers,
  onToggleTier,
  surfaces,
  onToggleSurface,
  onClear,
}: {
  category: Category;
  onCategory: (c: Category) => void;
  tiers: ReadonlySet<TierFilterValue>;
  onToggleTier: (v: TierFilterValue) => void;
  surfaces: ReadonlySet<string>;
  onToggleSurface: (v: string) => void;
  onClear: () => void;
}) {
  const anyActive = category !== 'all' || tiers.size > 0 || surfaces.size > 0;
  return (
    <div className="mb-5 flex flex-col gap-[10px]">
      <div className="flex items-center gap-2 flex-wrap">
        {(['all', 'senior', 'junior'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onCategory(c)}
            aria-pressed={category === c}
            data-active={category === c}
            title={c === 'all' ? 'Both the senior tour and the junior circuit' : c === 'senior' ? 'Senior tour only' : 'Junior circuit only'}
            className="gc-chip"
          >
            {/* "All" here means all CIRCUITS, not "no filter" — the old bare
                "All" label read as "showing everything" while a tier filter
                was still applied. */}
            {c === 'all' ? 'All circuits' : c === 'senior' ? 'Senior' : 'Junior'}
          </button>
        ))}
        {anyActive && (
          <button type="button" onClick={onClear} className="gc-chip">
            Clear filters
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="t-label">Tier</span>
        {TIER_CHIPS.filter((chip) => tierChipAppliesToCategory(chip.value, category)).map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => onToggleTier(chip.value)}
            aria-pressed={tiers.has(chip.value)}
            data-active={tiers.has(chip.value)}
            className="gc-chip"
          >
            {chip.label}
          </button>
        ))}
        <div className="w-px h-4 mx-1" style={{ background: 'var(--hair)' }} />
        <span className="t-label">Surface</span>
        {SURFACE_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => onToggleSurface(chip.value)}
            aria-pressed={surfaces.has(chip.value)}
            data-active={surfaces.has(chip.value)}
            className="gc-chip"
          >
            {chip.label}
          </button>
        ))}
      </div>
      {/* Names the applied filters explicitly, so the displayed state can
          never contradict the list (the "All selected but only Tour shown"
          finding). */}
      <div className="gc-tbl-note" style={{ padding: 0 }}>
        Showing {describeBrowseFilters(category, tiers, surfaces)}.
      </div>
    </div>
  );
}

/** Inline (not modal) picker for registering into ONE specific
 * planner week — deliberately lighter-weight than EnterTournamentModal
 * (no overlay, lives directly in the week's column) since the whole
 * point of the planner is staying on this one page across several
 * registrations in the same sitting. Shares the same over-cap/
 * age-ineligible disabling data EnterTournamentModal reads (both come
 * from the same ?playerId=-scoped GET /tournaments response). */
function WeekRegisterPicker({
  candidates,
  playerId,
  managerId,
  onEntered,
  onCancel,
}: {
  candidates: TournamentDto[];
  playerId: string;
  managerId: string;
  onEntered: (t: TournamentDto) => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const tournament = await registerEntrant(selectedId, playerId, managerId);
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
        Nothing open this week to register into.{' '}
        <button onClick={onCancel} className="cursor-pointer bg-transparent border-none underline p-0" style={{ color: 'var(--accent)' }}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-[6px]">
      {error && (
        <div className="gc-notice" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
          {error}
        </div>
      )}
      {candidates.map((t) => {
        const overCap =
          t.weeklyEntryCountThisWeek !== undefined && t.weeklyEntryCapThisWeek !== undefined && t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek;
        const ageIneligible = t.ageEligible === false;
        const qualifyingFull = t.qualifyingFieldFull === true;
        const blocked = overCap || ageIneligible || qualifyingFull;
        const selected = selectedId === t.id;
        return (
          <button
            key={t.id}
            onClick={() => !blocked && setSelectedId(t.id)}
            disabled={blocked}
            aria-pressed={selected}
            data-selected={selected}
            className="text-left rounded-[6px] px-[10px] py-[7px] cursor-pointer disabled:cursor-not-allowed"
            style={{
              border: selected ? '2px solid var(--accent)' : '1px solid var(--hair)',
              background: selected ? 'var(--bg-3)' : 'var(--bg-2)',
              boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent)' : undefined,
              opacity: blocked ? 0.55 : 1,
            }}
          >
            <div className="flex items-center gap-[6px] min-w-0">
              <SurfaceBadge surface={t.surface} size="sm" />
              <AgeBandBadge band={t.ageBand} />
              {t.entryViaQualifying && <Badge className="gc-badge--q">[Q]</Badge>}
              <div className="text-[12px] font-semibold truncate">{t.name}</div>
              {selected && (
                <span className="flex-none text-[10px] font-extrabold inline-flex items-center gap-[3px]" style={{ color: 'var(--accent)' }} aria-hidden>
                  <Icon name="check" size={11} /> Selected
                </span>
              )}
            </div>
            {t.entryViaQualifying && !qualifyingFull && (
              <div className="text-[10px] mt-[3px]" style={{ color: 'var(--ink-3)' }}>
                Qualifying — {t.qualifyingFieldTaken}/{t.qualifyingFieldSize} spots taken
              </div>
            )}
            {managerEntrantLabel(t.managerEntrants) && (
              <div className="text-[10px] mt-[3px]" style={{ color: 'var(--ink-3)' }}>
                {managerEntrantLabel(t.managerEntrants)}
              </div>
            )}
            {ageIneligible && (
              <div className="text-[10px] font-semibold mt-[3px]" style={{ color: 'var(--loss)' }}>
                Too old for this {t.ageBand} draw
              </div>
            )}
            {!ageIneligible && overCap && (
              <div className="text-[10px] font-semibold mt-[3px]" style={{ color: 'var(--loss)' }}>
                {t.weeklyEntryCapThisWeek === 1
                  ? 'Already entered a tournament this week'
                  : `Already at ${t.weeklyEntryCountThisWeek}/${t.weeklyEntryCapThisWeek} tournaments this week`}
              </div>
            )}
            {!ageIneligible && !overCap && qualifyingFull && (
              <div className="text-[10px] font-semibold mt-[3px]" style={{ color: 'var(--loss)' }}>
                Qualifying field full ({t.qualifyingFieldTaken}/{t.qualifyingFieldSize})
              </div>
            )}
            <TournamentRewardSummary tournament={t} />
          </button>
        );
      })}
      {selectedId && (
        <a
          href={`/tournaments/${encodeURIComponent(selectedId)}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-semibold no-underline hover:underline mt-1"
          style={{ color: 'var(--accent)' }}
        >
          See who&apos;s already entered →
        </a>
      )}
      {!selectedId && (
        <div className="text-[11px] mt-1" style={{ color: 'var(--ink-3)' }}>
          Select a tournament above to enable Register.
        </div>
      )}
      <div className="flex gap-[6px] mt-1">
        <Button variant="primary" className="flex-1" onClick={confirm} disabled={!selectedId || submitting}>
          {submitting ? 'Registering…' : 'Register'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * The multi-week planner: a chosen roster player's real entries (or
 * lack thereof) across the next several upcoming weeks, side by side,
 * with a quick way to register into ANY of those future weeks right
 * here — the point is committing several weeks' worth of entries in
 * one sitting, not returning to this page once per week. Backed by
 * GET /players/:id/entry-planner (see PlayerEntryPlannerQuery on the
 * API side) for the "what's this player doing each week" data, and the
 * existing ?playerId=-scoped GET /tournaments for "what could they
 * register into this week" (same source EnterTournamentModal reads,
 * so eligibility/cap rules never drift between the two entry points).
 */
function PlannerView() {
  const devManagerId = useDevManagerId();
  const [managerId, setManagerId] = useState(devManagerId ?? '');
  const [managerIdInput, setManagerIdInput] = useState(devManagerId ?? '');
  const [roster, setRoster] = useState<PlayerDto[] | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [planner, setPlanner] = useState<PlannerWeekDto[] | null>(null);
  const [openForPlayer, setOpenForPlayer] = useState<TournamentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openWeekKey, setOpenWeekKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchRoster(managerId)
      .then((players) => {
        setRoster(players);
        setSelectedPlayerId((current) => (current && players.some((p) => p.id === current) ? current : players[0]?.id ?? null));
      })
      .catch((e) => {
        setRoster([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [managerId]);

  const loadPlanner = useCallback(async (playerId: string) => {
    setError(null);
    try {
      const [plannerRows, open] = await Promise.all([fetchEntryPlanner(playerId, PLANNER_WEEKS), fetchOpenTournaments(playerId)]);
      setPlanner(plannerRows);
      setOpenForPlayer(open);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!selectedPlayerId) {
      setPlanner(null);
      setOpenForPlayer(null);
      return;
    }
    setPlanner(null);
    void loadPlanner(selectedPlayerId);
  }, [selectedPlayerId, loadPlanner]);

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  async function handleEntered(tournament: TournamentDto) {
    setOpenWeekKey(null);
    showNotice(`Registered into ${tournament.name} (week ${tournament.weekScheduled.week}).`);
    if (selectedPlayerId) await loadPlanner(selectedPlayerId);
  }

  const selectedPlayer = roster?.find((p) => p.id === selectedPlayerId) ?? null;

  return (
    <div>
      <div className="flex items-end justify-between gap-4 mb-5 flex-wrap">
        <div className="t-body-sm">
          Plan several weeks of entries for one roster player in a single sitting — pick a week below and register
          directly, no need to come back later.
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
            <form
              className="flex items-center gap-[6px] text-[11.5px]"
              style={{ color: 'var(--ink-3)' }}
              onSubmit={(e) => {
                e.preventDefault();
                setManagerId(managerIdInput.trim() || managerId);
              }}
            >
              Manager ID (dev)
              <input
                value={managerIdInput}
                onChange={(e) => setManagerIdInput(e.target.value)}
                className="gc-input text-[12px]"
              />
            </form>
          )}
          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold" style={{ color: 'var(--ink-3)' }}>
              Player
            </label>
            <select
              value={selectedPlayerId ?? ''}
              onChange={(e) => setSelectedPlayerId(e.target.value || null)}
              className="gc-select text-[12.5px] min-w-[180px]"
            >
              {roster?.length === 0 && <option value="">No roster players</option>}
              {roster?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="gc-notice mb-4" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
          {error}
        </div>
      )}

      {roster?.length === 0 && (
        <div className="t-body-sm">
          This manager has no roster players yet — nothing to plan for.
        </div>
      )}

      {selectedPlayer && planner === null && !error && (
        <div className="t-body-sm">
          Loading {selectedPlayer.name}&apos;s planner…
        </div>
      )}

      {selectedPlayer && planner && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-[10px]" style={{ minWidth: planner.length * 210 }}>
            {planner.map((week, weekIndex) => {
              const weekKey = `${week.week.season}-${week.week.week}`;
              const candidates = (openForPlayer ?? []).filter(
                (t) =>
                  t.weekScheduled.season === week.week.season &&
                  t.weekScheduled.week === week.week.week &&
                  tournamentHasRoom(t) &&
                  !t.entrants.some((e) => e.playerId === selectedPlayerId) &&
                  !week.entries.some((entered) => entered.id === t.id),
              );
              // The first column is always the world's current week (the
              // planner starts from "now" — see PlayerEntryPlannerQuery), so
              // its draws have usually already started. If nothing here is
              // actually enterable, state why instead of offering a
              // "+ Register" that opens a picker of disabled rows.
              const blockReason = plannerWeekBlockReason(candidates, weekIndex === 0);
              return (
                <div
                  key={weekKey}
                  className="flex-none w-[200px] gc-card p-[12px] flex flex-col"
                >
                  <div className="t-label mb-2">
                    Season {week.week.season} · Week {week.week.week}
                  </div>

                  <div className="flex flex-col gap-[6px]">
                    {week.entries.length === 0 && (
                      <div className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
                        No entry yet
                      </div>
                    )}
                    {week.entries.map((t) => (
                      // Plain `<a>` for the same immediate-navigation reason
                      // as the browse rows above (not next/link).
                      <a
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        className="rounded-[6px] px-[9px] py-[7px] no-underline block"
                        style={
                          t.cancelled
                            ? { background: 'color-mix(in srgb, var(--warn) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)', color: 'inherit' }
                            : { background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', color: 'inherit' }
                        }
                      >
                        <div className="flex items-center gap-[5px] min-w-0">
                          <SurfaceBadge surface={t.surface} size="sm" />
                          <AgeBandBadge band={t.ageBand} />
                        </div>
                        <div className="text-[12px] font-semibold mt-[3px] truncate">{t.name}</div>
                        <div className="text-[10.5px]" style={{ color: 'var(--ink-3)' }}>
                          {t.cancelled
                            ? 'Cancelled — never started'
                            : t.hasStarted
                              ? 'Started'
                              : `${t.mainDrawEntrants}/${t.drawSize} entrants`}
                        </div>
                      </a>
                    ))}
                  </div>

                  {openWeekKey === weekKey ? (
                    <WeekRegisterPicker
                      candidates={candidates}
                      playerId={selectedPlayerId!}
                      managerId={managerId}
                      onEntered={handleEntered}
                      onCancel={() => setOpenWeekKey(null)}
                    />
                  ) : blockReason ? (
                    <div className="mt-[8px] text-[11px] leading-[1.4]" style={{ color: 'var(--ink-3)' }}>
                      {blockReason}
                    </div>
                  ) : (
                    <Button className="mt-[8px]" onClick={() => setOpenWeekKey(weekKey)}>
                      + Register
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {notice && (
        <div
          className="gc-panel fixed bottom-6 right-6 z-40 text-[13px] font-semibold px-4 py-3"
          style={{ borderColor: 'var(--accent)' }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}

export default function TournamentsIndexPage() {
  const [view, setView] = useState<'browse' | 'planner' | 'events'>('browse');
  // Persistent chrome consistency: this screen has a manager context, so it
  // shows the same XP balance every other screen does (shared entitlement
  // source — see lib/entitlement.ts).
  const devManagerId = useDevManagerId();
  const managerId = devManagerId ?? '';
  const { entitlement } = useEntitlement(managerId);
  // Deep link for the tournament page's "Open the Planner" pointer
  // (/tournaments#planner). A hash — not a query param — so this stays a
  // plain client-only read with no Suspense boundary needed.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash === '#planner') setView('planner');
    else if (hash === '#events') setView('events');
  }, []);
  const [open, setOpen] = useState<TournamentDto[] | null>(null);
  const [started, setStarted] = useState<TournamentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState<Category>(DEFAULT_CATEGORY);
  const [tiers, setTiers] = useState<Set<TierFilterValue>>(() => new Set(DEFAULT_TIERS));
  const [surfaces, setSurfaces] = useState<Set<string>>(() => new Set());

  // Restore the manager's last-used filters once on mount (first visit
  // falls through to the Senior + Tour default). Done in an effect, not a
  // lazy initializer, so the server-rendered chips and the hydrated ones
  // never disagree.
  useEffect(() => {
    const persisted = loadPersistedFilters();
    if (!persisted) return;
    setCategory(persisted.category);
    setTiers(new Set(persisted.tiers));
    setSurfaces(new Set(persisted.surfaces));
  }, []);

  // Persist every change so the manager's selection becomes next visit's
  // default. Skips the mount run — the restore effect above (which fires
  // first in the same commit) must not have its result immediately
  // clobbered by re-saving the still-stale default state.
  const hasHydratedFilters = useRef(false);
  useEffect(() => {
    if (!hasHydratedFilters.current) {
      hasHydratedFilters.current = true;
      return;
    }
    savePersistedFilters({ category, tiers: Array.from(tiers), surfaces: Array.from(surfaces) });
  }, [category, tiers, surfaces]);

  useEffect(() => {
    Promise.all([fetchOpenTournaments(), fetchStartedTournaments()])
      .then(([o, s]) => {
        setOpen(o);
        setStarted(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Sort both lists nearest-week-first with the SAME comparator the entry
  // picker uses (lib/tournamentPick). The API's list order was effectively
  // arbitrary — it jumped W3 → W16 → W11 — which read as broken sorting.
  const filteredOpen = useMemo(
    () => (open ? sortTournamentsForPicker(open.filter((t) => matchesFilters(t, category, tiers, surfaces))) : null),
    [open, category, tiers, surfaces],
  );
  const filteredStarted = useMemo(
    () => (started ? sortTournamentsForPicker(started.filter((t) => matchesFilters(t, category, tiers, surfaces))) : null),
    [started, category, tiers, surfaces],
  );

  // Browse leads with the RESULTS (brackets in progress / recently decided)
  // whenever any exist. The open-entries list can be ~90 identical future
  // draws, so burying the played brackets — the payoff, and the only route
  // to a replay — at the bottom meant a user looking for a result had to
  // scroll past everything. Both sections always render; only their ORDER
  // changes, and a one-click "jump to" link keeps the trailing list
  // reachable. The open list is never removed.
  const hasStartedBrackets = (filteredStarted?.length ?? 0) > 0;
  const openSection = (
    <div className="mb-8" id="open-entries">
      <SectionLabel
        right={
          hasStartedBrackets ? (
            <a href="#brackets-underway" className="text-[11.5px] font-semibold no-underline hover:underline" style={{ color: 'var(--accent)' }}>
              Results &amp; live brackets ↑
            </a>
          ) : undefined
        }
      >
        Open for entries{filteredOpen ? ` · ${filteredOpen.length}` : ''}
      </SectionLabel>
      {open === null && !error && <div className="t-body-sm">Loading…</div>}
      {open && filteredOpen?.length === 0 && (
        <div className="t-body-sm">
          {open.length === 0 ? 'Nothing open right now.' : 'No open tournaments match your filters.'}
        </div>
      )}
      {filteredOpen && filteredOpen.length > 0 && (
        <TournamentTable>
          {filteredOpen.map((t) => (
            <TournamentRow key={t.id} t={t} cta="View draw" />
          ))}
        </TournamentTable>
      )}
    </div>
  );
  const startedSection = (
    <div className="mb-8" id="brackets-underway">
      <SectionLabel
        right={
          !hasStartedBrackets && (filteredOpen?.length ?? 0) > 0 ? (
            <a href="#open-entries" className="text-[11.5px] font-semibold no-underline hover:underline" style={{ color: 'var(--accent)' }}>
              Open for entries ↓
            </a>
          ) : undefined
        }
      >
        Results &amp; live brackets{filteredStarted ? ` · ${filteredStarted.length}` : ''}
      </SectionLabel>
      {/* Say plainly what lives here: played results (watch the replay) and
          brackets still in progress. A naive walkthrough reported having to
          GUESS that "Brackets underway" were the played ones. */}
      <div className="gc-tbl-note" style={{ padding: '0 0 6px' }}>
        Finished brackets and ones still being played. Open any bracket to watch its match replays — a
        <span style={{ color: 'var(--win)' }}> <Icon name="check" size={10} /> Finished</span> badge means every result is in.
      </div>
      {started === null && !error && <div className="t-body-sm">Loading…</div>}
      {started && filteredStarted?.length === 0 && (
        <div className="t-body-sm">
          {started.length === 0 ? 'No results or live brackets yet.' : 'No results or live brackets match your filters.'}
        </div>
      )}
      {filteredStarted && filteredStarted.length > 0 && (
        <TournamentTable>
          {filteredStarted.map((t) => (
            <TournamentRow key={t.id} t={t} cta="Open bracket" />
          ))}
        </TournamentTable>
      )}
    </div>
  );

  return (
    <AppShell active="tournaments" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        {/* Page header — flat (Direction A), then the underline view tabs. */}
        <div>
          <div className="t-label">The Circuit</div>
          <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Tournaments</h1>
          <div className="t-body-sm" style={{ marginTop: 4 }}>
            Open draws still taking entrants, brackets already in full swing, and a planner to map out the weeks ahead.
          </div>
        </div>

        <Tabs
          items={[
            { id: 'browse', label: 'Browse' },
            { id: 'planner', label: 'Planner' },
            { id: 'events', label: 'Season events' },
          ]}
          active={view}
          onSelect={(id) => setView(id as 'browse' | 'planner' | 'events')}
          className="mt-2 mb-4"
        />

        {error && (
          <div className="gc-notice mb-4" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
            {error}
          </div>
        )}

        {view === 'browse' ? (
          <>
            <FilterBar
              category={category}
              onCategory={(c) => {
                setCategory(c);
                // Keep the tier chips consistent with the new category —
                // the default 'tour' chip is senior-only, so picking Junior
                // without this left an impossible Senior+Tier=Tour selection
                // and the list rendered empty (the "Junior shows nothing" bug).
                setTiers((current) => pruneTiersForCategory(c, current));
              }}
              tiers={tiers}
              onToggleTier={(v) => setTiers((current) => toggleInSet(current, v))}
              surfaces={surfaces}
              onToggleSurface={(v) => setSurfaces((current) => toggleInSet(current, v))}
              onClear={() => {
                setCategory('all');
                setTiers(new Set());
                setSurfaces(new Set());
              }}
            />

            {hasStartedBrackets ? (
              <>
                {startedSection}
                {openSection}
              </>
            ) : (
              <>
                {openSection}
                {startedSection}
              </>
            )}
          </>
        ) : view === 'planner' ? (
          <PlannerView />
        ) : (
          <SeasonEvents />
        )}
      </PageShell>
    </AppShell>
  );
}
