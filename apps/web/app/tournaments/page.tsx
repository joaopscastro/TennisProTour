'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, PageShell, Hero, SectionLabel } from '../../components/ui/primitives';
import { surfaceTheme } from '../../lib/surfaces';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

const AGE_BAND_BADGE = { background: 'oklch(45% 0.1 240 / 0.35)', color: 'oklch(85% 0.08 240)' };

const PLANNER_WEEKS = 6;

type Category = 'all' | 'senior' | 'junior';
/** Deliberately mixes age bands and senior tiers into one flat chip
 * set — a junior tournament's real tier is one of six J-grades
 * (j30-j500), but the age-band badge (U14/U16), not the J-grade, is
 * what every other screen in this app already surfaces as "which
 * junior tier" (see docs/ui-direction.md's age-band-badge convention),
 * so filtering by U14/U16 here matches that same mental model instead
 * of introducing a second, unfamiliar J-grade filter. */
type TierFilterValue = 'u14' | 'u16' | 'futures' | 'challenger' | 'tour' | 'major';

const TIER_CHIPS: Array<{ value: TierFilterValue; label: string }> = [
  { value: 'u14', label: 'U14' },
  { value: 'u16', label: 'U16' },
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

function chipStyle(active: boolean) {
  return active
    ? { background: 'var(--gc-ball)', color: 'oklch(22% 0.05 140)', border: '1px solid var(--gc-ball)', fontWeight: 750 }
    : { background: 'var(--gc-s2)', color: 'var(--gc-ink-dim)', border: '1px solid var(--gc-line)' };
}

function TournamentRow({ t, cta }: { t: TournamentDto; cta: string }) {
  const th = surfaceTheme(t.surface);
  const fillPct = Math.round((t.entrants.length / t.drawSize) * 100);
  return (
    <Link
      href={`/tournaments/${t.id}`}
      className="gc-card gc-card--hover"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', textDecoration: 'none', color: 'inherit', position: 'relative', overflow: 'hidden' }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${th.color}, ${th.deep})` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, paddingLeft: 6 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 5, color: 'white', background: `linear-gradient(180deg, ${th.color}, ${th.deep})` }}>
          {t.surface}
        </div>
        {t.ageBand && (
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '4px 9px', borderRadius: 5, ...AGE_BAND_BADGE }}>
            {t.ageBand}
          </div>
        )}
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 750 }}>{t.name}</div>
          <div style={{ fontSize: 12, color: 'var(--gc-ink-mute)', marginTop: 1 }}>
            {t.tier} · {t.drawSize}-draw · <span style={{ color: fillPct >= 100 ? 'var(--gc-ball)' : 'var(--gc-ink-dim)' }}>{t.entrants.length}/{t.drawSize}</span> · S{t.weekScheduled.season} W{t.weekScheduled.week}{t.hostCountry ? ` · 🏠 ${t.hostCountry}` : ''}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--gc-ball)' }}>
        {cta} →
      </div>
    </Link>
  );
}

/**
 * The category/tier/surface filter bar — the same toggle-chip pattern
 * established on the Scouting page's rarity/potential badges (distinct
 * colors per axis, never hidden/removed, just visually
 * active-vs-inactive) adapted into an interactive filter control,
 * since Scouting itself doesn't yet have its own filter bar to lift
 * markup from directly.
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
      <div className="flex items-center gap-2">
        {(['all', 'senior', 'junior'] as const).map((c) => (
          <button
            key={c}
            onClick={() => onCategory(c)}
            className="px-[12px] py-[6px] rounded-[6px] text-[12.5px] font-semibold cursor-pointer"
            style={chipStyle(category === c)}
          >
            {c === 'all' ? 'All' : c === 'senior' ? 'Senior' : 'Junior'}
          </button>
        ))}
        {anyActive && (
          <button
            onClick={onClear}
            className="ml-1 px-[10px] py-[6px] rounded-[6px] text-[12px] font-semibold cursor-pointer bg-transparent"
            style={{ color: 'var(--gc-ink-mute)', border: 'none' }}
          >
            Clear filters
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        {TIER_CHIPS.map((chip) => (
          <button
            key={chip.value}
            onClick={() => onToggleTier(chip.value)}
            className="px-[10px] py-[5px] rounded-[5px] text-[11.5px] font-semibold cursor-pointer"
            style={chipStyle(tiers.has(chip.value))}
          >
            {chip.label}
          </button>
        ))}
        <div className="w-px h-4 mx-1" style={{ background: 'var(--gc-line)' }} />
        {SURFACE_CHIPS.map((chip) => (
          <button
            key={chip.value}
            onClick={() => onToggleSurface(chip.value)}
            className="px-[10px] py-[5px] rounded-[5px] text-[11.5px] font-semibold cursor-pointer"
            style={chipStyle(surfaces.has(chip.value))}
          >
            {chip.label}
          </button>
        ))}
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
      <div className="mt-2 text-[11.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
        Nothing open this week to register into.{' '}
        <button onClick={onCancel} className="cursor-pointer bg-transparent border-none underline p-0" style={{ color: 'var(--gc-ball)' }}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-[6px]">
      {error && (
        <div className="text-[11px] rounded-[5px] px-2 py-[6px]" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.25)' }}>
          {error}
        </div>
      )}
      {candidates.map((t) => {
        const overCap =
          t.weeklyEntryCountThisWeek !== undefined && t.weeklyEntryCapThisWeek !== undefined && t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek;
        const ageIneligible = t.ageEligible === false;
        const blocked = overCap || ageIneligible;
        const selected = selectedId === t.id;
        return (
          <button
            key={t.id}
            onClick={() => !blocked && setSelectedId(t.id)}
            disabled={blocked}
            className="text-left rounded-[6px] px-[10px] py-[7px] cursor-pointer disabled:cursor-not-allowed"
            style={{
              border: selected ? '1.5px solid var(--gc-ball)' : '1px solid var(--gc-line)',
              background: selected ? 'var(--gc-s3)' : 'var(--gc-s2)',
              opacity: blocked ? 0.55 : 1,
            }}
          >
            <div className="flex items-center gap-[6px] min-w-0">
              <div
                className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[6px] py-[2px] rounded-[4px] text-white flex-none"
                style={{ background: SURFACE_COLOR[t.surface] ?? 'oklch(50% 0.006 75)' }}
              >
                {t.surface}
              </div>
              {t.ageBand && (
                <div className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[6px] py-[2px] rounded-[4px] flex-none" style={AGE_BAND_BADGE}>
                  {t.ageBand}
                </div>
              )}
              <div className="text-[12px] font-semibold truncate">{t.name}</div>
            </div>
            {ageIneligible && (
              <div className="text-[10px] font-semibold mt-[3px]" style={{ color: 'oklch(50% 0.16 30)' }}>
                Too old for this {t.ageBand} draw
              </div>
            )}
            {!ageIneligible && overCap && (
              <div className="text-[10px] font-semibold mt-[3px]" style={{ color: 'oklch(50% 0.16 30)' }}>
                {t.weeklyEntryCapThisWeek === 1
                  ? 'Already entered a tournament this week'
                  : `Already at ${t.weeklyEntryCountThisWeek}/${t.weeklyEntryCapThisWeek} tournaments this week`}
              </div>
            )}
          </button>
        );
      })}
      <div className="flex gap-[6px] mt-1">
        <button
          onClick={confirm}
          disabled={!selectedId || submitting}
          className="flex-1 px-[10px] py-[7px] rounded-[6px] border-none text-[11.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'var(--gc-ball)', color: 'oklch(22% 0.05 140)' }}
        >
          {submitting ? 'Registering…' : 'Register'}
        </button>
        <button
          onClick={onCancel}
          className="px-[10px] py-[7px] rounded-[6px] bg-transparent text-[11.5px] font-semibold cursor-pointer"
          style={{ border: '1px solid var(--gc-line)', color: 'var(--gc-ink-dim)' }}
        >
          Cancel
        </button>
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
  const [managerId, setManagerId] = useState('seed-m1');
  const [managerIdInput, setManagerIdInput] = useState('seed-m1');
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
        <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
          Plan several weeks of entries for one roster player in a single sitting — pick a week below and register
          directly, no need to come back later.
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
            <form
              className="flex items-center gap-[6px] text-[11.5px]"
              style={{ color: 'var(--gc-ink-mute)' }}
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
            <label className="text-[11px] font-semibold" style={{ color: 'var(--gc-ink-mute)' }}>
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
        <div className="mb-4 text-[13px] rounded-[10px] px-4 py-3" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
          {error}
        </div>
      )}

      {roster?.length === 0 && (
        <div className="text-[13.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
          This manager has no roster players yet — nothing to plan for.
        </div>
      )}

      {selectedPlayer && planner === null && !error && (
        <div className="text-[13.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
          Loading {selectedPlayer.name}&apos;s planner…
        </div>
      )}

      {selectedPlayer && planner && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-[10px]" style={{ minWidth: planner.length * 210 }}>
            {planner.map((week) => {
              const weekKey = `${week.week.season}-${week.week.week}`;
              const candidates = (openForPlayer ?? []).filter(
                (t) =>
                  t.weekScheduled.season === week.week.season &&
                  t.weekScheduled.week === week.week.week &&
                  t.entrants.length < t.drawSize &&
                  !t.entrants.some((e) => e.playerId === selectedPlayerId) &&
                  !week.entries.some((entered) => entered.id === t.id),
              );
              return (
                <div
                  key={weekKey}
                  className="flex-none w-[200px] rounded-[10px] gc-card p-[12px] flex flex-col"
                >
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'var(--gc-ink-mute)' }}>
                    Season {week.week.season} · Week {week.week.week}
                  </div>

                  <div className="flex flex-col gap-[6px]">
                    {week.entries.length === 0 && (
                      <div className="text-[11.5px]" style={{ color: 'var(--gc-ink-faint)' }}>
                        No entry yet
                      </div>
                    )}
                    {week.entries.map((t) => (
                      <Link
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        className="rounded-[6px] px-[9px] py-[7px] no-underline block"
                        style={{ background: 'oklch(40% 0.06 145 / 0.22)', border: '1px solid oklch(50% 0.08 145 / 0.3)', color: 'inherit' }}
                      >
                        <div className="flex items-center gap-[5px] min-w-0">
                          <div
                            className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[6px] py-[2px] rounded-[4px] text-white flex-none"
                            style={{ background: SURFACE_COLOR[t.surface] ?? 'oklch(50% 0.006 75)' }}
                          >
                            {t.surface}
                          </div>
                          {t.ageBand && (
                            <div className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[6px] py-[2px] rounded-[4px] flex-none" style={AGE_BAND_BADGE}>
                              {t.ageBand}
                            </div>
                          )}
                        </div>
                        <div className="text-[12px] font-semibold mt-[3px] truncate">{t.name}</div>
                        <div className="text-[10.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
                          {t.hasStarted ? 'Started' : `${t.entrants.length}/${t.drawSize} entrants`}
                        </div>
                      </Link>
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
                  ) : (
                    <button
                      onClick={() => setOpenWeekKey(weekKey)}
                      className="mt-[8px] px-[10px] py-[7px] rounded-[6px] text-[11.5px] font-semibold cursor-pointer"
                      style={{ background: 'var(--gc-s3)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink-dim)' }}
                    >
                      + Register
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {notice && (
        <div
          className="gc-panel gc-pop fixed bottom-6 right-6 z-40 text-[13px] font-semibold px-4 py-3"
          style={{ borderColor: 'var(--gc-ball-d)' }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}

export default function TournamentsIndexPage() {
  const [view, setView] = useState<'browse' | 'planner'>('browse');
  const [open, setOpen] = useState<TournamentDto[] | null>(null);
  const [started, setStarted] = useState<TournamentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState<Category>('all');
  const [tiers, setTiers] = useState<Set<TierFilterValue>>(new Set());
  const [surfaces, setSurfaces] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([fetchOpenTournaments(), fetchStartedTournaments()])
      .then(([o, s]) => {
        setOpen(o);
        setStarted(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const filteredOpen = useMemo(() => open?.filter((t) => matchesFilters(t, category, tiers, surfaces)) ?? null, [open, category, tiers, surfaces]);
  const filteredStarted = useMemo(
    () => started?.filter((t) => matchesFilters(t, category, tiers, surfaces)) ?? null,
    [started, category, tiers, surfaces],
  );

  return (
    <AppFrame>
      <Sidebar active="tournaments" />

      <PageShell wash="radial-gradient(120% 55% at 12% -10%, oklch(45% 0.1 45 / 0.13), transparent 60%)">
        <Hero minHeight={130}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(90% 0.02 150)', opacity: 0.85 }}>The Circuit</div>
              <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Tournaments</div>
              <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 150)', opacity: 0.82, marginTop: 4, maxWidth: 520, lineHeight: 1.5 }}>
                Open draws still taking entrants, brackets already in full swing, and a planner to map out the weeks ahead.
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, borderRadius: 10, padding: 3, background: 'oklch(100% 0 0 / 0.12)', border: '1px solid oklch(100% 0 0 / 0.16)' }}>
              {(['browse', 'planner'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  style={{
                    padding: '7px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none',
                    background: view === v ? 'white' : 'transparent',
                    color: view === v ? 'oklch(22% 0.03 150)' : 'oklch(94% 0.01 150)',
                  }}
                >
                  {v === 'browse' ? 'Browse' : 'Planner'}
                </button>
              ))}
            </div>
          </div>
        </Hero>

        <div className="h-5" />

        {error && (
          <div className="mb-4 text-[13px] rounded-[10px] px-4 py-3" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {view === 'browse' ? (
          <>
            <FilterBar
              category={category}
              onCategory={setCategory}
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

            <div className="mb-8">
              <SectionLabel>Open for entries</SectionLabel>
              <div className="flex flex-col gap-2">
                {open === null && !error && <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>Loading…</div>}
                {open && filteredOpen?.length === 0 && (
                  <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
                    {open.length === 0 ? 'Nothing open right now.' : 'No open tournaments match your filters.'}
                  </div>
                )}
                {filteredOpen?.map((t) => (
                  <TournamentRow key={t.id} t={t} cta="View draw" />
                ))}
              </div>
            </div>

            <div>
              <SectionLabel>Brackets underway</SectionLabel>
              <div className="flex flex-col gap-2">
                {started === null && !error && <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>Loading…</div>}
                {started && filteredStarted?.length === 0 && (
                  <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
                    {started.length === 0 ? 'No brackets underway.' : 'No brackets underway match your filters.'}
                  </div>
                )}
                {filteredStarted?.map((t) => (
                  <TournamentRow key={t.id} t={t} cta="Open bracket" />
                ))}
              </div>
            </div>
          </>
        ) : (
          <PlannerView />
        )}
      </PageShell>
    </AppFrame>
  );
}
