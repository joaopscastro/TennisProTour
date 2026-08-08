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

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};

const AGE_BAND_BADGE = { background: 'oklch(90% 0.1 240)', color: 'oklch(35% 0.14 240)' };

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
    ? { background: 'oklch(20% 0.006 75)', color: 'white', border: '1px solid oklch(20% 0.006 75)' }
    : { background: 'white', color: 'oklch(35% 0.006 75)', border: '1px solid oklch(88% 0.006 75)' };
}

function TournamentRow({ t, cta }: { t: TournamentDto; cta: string }) {
  return (
    <Link
      href={`/tournaments/${t.id}`}
      className="flex items-center justify-between rounded-[8px] bg-white px-4 py-[14px] no-underline hover:opacity-90"
      style={{ border: '1px solid oklch(90% 0.005 75)', color: 'inherit' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px] text-white"
          style={{ background: SURFACE_COLOR[t.surface] ?? 'oklch(50% 0.006 75)' }}
        >
          {t.surface}
        </div>
        {t.ageBand && (
          <div className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px]" style={AGE_BAND_BADGE}>
            {t.ageBand}
          </div>
        )}
        <div>
          <div className="text-[14px] font-semibold">{t.name}</div>
          <div className="text-[12px]" style={{ color: 'oklch(50% 0.006 75)' }}>
            {t.tier} · {t.drawSize}-draw · {t.entrants.length}/{t.drawSize} entrants · Season {t.weekScheduled.season}, week{' '}
            {t.weekScheduled.week}
          </div>
        </div>
      </div>
      <div className="text-[12.5px] font-semibold" style={{ color: 'oklch(45% 0.12 240)' }}>
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
            style={{ color: 'oklch(50% 0.006 75)', border: 'none' }}
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
        <div className="w-px h-4 mx-1" style={{ background: 'oklch(88% 0.006 75)' }} />
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
      <div className="mt-2 text-[11.5px]" style={{ color: 'oklch(55% 0.006 75)' }}>
        Nothing open this week to register into.{' '}
        <button onClick={onCancel} className="cursor-pointer bg-transparent border-none underline p-0" style={{ color: 'oklch(45% 0.12 240)' }}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-[6px]">
      {error && (
        <div className="text-[11px] rounded-[5px] px-2 py-[6px]" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
          {error}
        </div>
      )}
      {candidates.map((t) => {
        const overCap =
          t.juniorEntryCountThisWeek !== undefined && t.juniorEntryCapThisWeek !== undefined && t.juniorEntryCountThisWeek >= t.juniorEntryCapThisWeek;
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
              border: selected ? '1.5px solid oklch(20% 0.006 75)' : '1px solid oklch(90% 0.005 75)',
              background: selected ? 'oklch(97% 0.003 75)' : 'white',
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
                Already at {t.juniorEntryCountThisWeek}/{t.juniorEntryCapThisWeek} junior tournaments this week
              </div>
            )}
          </button>
        );
      })}
      <div className="flex gap-[6px] mt-1">
        <button
          onClick={confirm}
          disabled={!selectedId || submitting}
          className="flex-1 px-[10px] py-[7px] rounded-[6px] text-white border-none text-[11.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'oklch(20% 0.006 75)' }}
        >
          {submitting ? 'Registering…' : 'Register'}
        </button>
        <button
          onClick={onCancel}
          className="px-[10px] py-[7px] rounded-[6px] bg-transparent text-[11.5px] font-semibold cursor-pointer"
          style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
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
        <div className="text-[13px]" style={{ color: 'oklch(50% 0.006 75)' }}>
          Plan several weeks of entries for one roster player in a single sitting — pick a week below and register
          directly, no need to come back later.
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
            <form
              className="flex items-center gap-[6px] text-[11.5px]"
              style={{ color: 'oklch(52% 0.006 75)' }}
              onSubmit={(e) => {
                e.preventDefault();
                setManagerId(managerIdInput.trim() || managerId);
              }}
            >
              Manager ID (dev)
              <input
                value={managerIdInput}
                onChange={(e) => setManagerIdInput(e.target.value)}
                className="rounded px-2 py-1 text-[12px] text-[oklch(22%_0.006_75)]"
                style={{ background: 'white', border: '1px solid oklch(88% 0.006 75)' }}
              />
            </form>
          )}
          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold" style={{ color: 'oklch(52% 0.006 75)' }}>
              Player
            </label>
            <select
              value={selectedPlayerId ?? ''}
              onChange={(e) => setSelectedPlayerId(e.target.value || null)}
              className="rounded px-2 py-[6px] text-[12.5px] text-[oklch(22%_0.006_75)] min-w-[180px]"
              style={{ background: 'white', border: '1px solid oklch(88% 0.006 75)' }}
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
        <div className="mb-4 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
          {error}
        </div>
      )}

      {roster?.length === 0 && (
        <div className="text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
          This manager has no roster players yet — nothing to plan for.
        </div>
      )}

      {selectedPlayer && planner === null && !error && (
        <div className="text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
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
                  className="flex-none w-[200px] rounded-[8px] bg-white p-[12px] flex flex-col"
                  style={{ border: '1px solid oklch(90% 0.005 75)' }}
                >
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'oklch(48% 0.006 75)' }}>
                    Season {week.week.season} · Week {week.week.week}
                  </div>

                  <div className="flex flex-col gap-[6px]">
                    {week.entries.length === 0 && (
                      <div className="text-[11.5px]" style={{ color: 'oklch(58% 0.006 75)' }}>
                        No entry yet
                      </div>
                    )}
                    {week.entries.map((t) => (
                      <Link
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        className="rounded-[6px] px-[9px] py-[7px] no-underline block"
                        style={{ background: 'oklch(96% 0.02 145)', color: 'inherit' }}
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
                        <div className="text-[10.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
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
                      style={{ background: 'oklch(95% 0.006 75)', border: '1px solid oklch(88% 0.006 75)', color: 'oklch(30% 0.006 75)' }}
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
          className="fixed bottom-6 right-6 z-40 text-white text-[13px] font-semibold px-4 py-3 rounded-[8px]"
          style={{ background: 'oklch(20% 0.006 75)', boxShadow: '0 6px 20px rgba(0,0,0,0.2)' }}
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
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="tournaments" />

      <div className="flex-1 p-8 max-w-[1180px] min-w-0">
        <div className="flex items-start justify-between mb-1 flex-wrap gap-3">
          <div>
            <div className="text-[23px] font-bold tracking-[-0.2px] mb-1">Tournaments</div>
            <div className="text-[13.5px]" style={{ color: 'oklch(48% 0.006 75)' }}>
              Open draws still accepting entrants, brackets already underway, and forward planning across upcoming
              weeks.
            </div>
          </div>
          <div className="flex items-center gap-[2px] rounded-[8px] p-[3px]" style={{ background: 'oklch(93% 0.006 75)' }}>
            {(['browse', 'planner'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="px-[14px] py-[7px] rounded-[6px] text-[12.5px] font-semibold cursor-pointer"
                style={
                  view === v
                    ? { background: 'white', color: 'oklch(20% 0.006 75)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                    : { background: 'transparent', color: 'oklch(50% 0.006 75)', border: 'none' }
                }
              >
                {v === 'browse' ? 'Browse' : 'Planner'}
              </button>
            ))}
          </div>
        </div>

        <div className="h-6" />

        {error && (
          <div className="mb-4 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
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
              <div className="text-[12px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'oklch(48% 0.006 75)' }}>
                Open for entries
              </div>
              <div className="flex flex-col gap-2">
                {open === null && !error && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>Loading…</div>}
                {open && filteredOpen?.length === 0 && (
                  <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
                    {open.length === 0 ? 'Nothing open right now.' : 'No open tournaments match your filters.'}
                  </div>
                )}
                {filteredOpen?.map((t) => (
                  <TournamentRow key={t.id} t={t} cta="View draw" />
                ))}
              </div>
            </div>

            <div>
              <div className="text-[12px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'oklch(48% 0.006 75)' }}>
                Brackets underway
              </div>
              <div className="flex flex-col gap-2">
                {started === null && !error && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>Loading…</div>}
                {started && filteredStarted?.length === 0 && (
                  <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
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
      </div>
    </div>
  );
}
