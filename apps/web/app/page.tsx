'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DoublesPairDto,
  PlayerLifecycleStage,
  PlayerMatchesDto,
  PlannerWeekDto,
  RosterDashboardEntryDto,
  TrainingFocus,
  WorldClockDto,
  acceptDoublesPair,
  createDoublesPair,
  dissolveDoublesPair,
  fetchDoublesPairs,
  fetchEntryPlanner,
  fetchPlayerMatches,
  fetchRosterDashboard,
  fetchWorldClock,
  releasePlayer,
  runPractice,
  setTrainingFocus,
} from '../lib/api';
import { useCountdown, formatCountdown, formatCountdownClock } from '../lib/useCountdown';
import { nextPendingEntry, type PendingEntry } from '../lib/pendingEntry';
import { AppShell } from '../components/ui/AppShell';
import { EnterTournamentModal } from '../components/EnterTournamentModal';
import { CreateCustomPlayerModal } from '../components/CreateCustomPlayerModal';
import { CoachConversionModal } from '../components/CoachConversionModal';
import { RANKING_EARNED_NOTE, RANK_BAND_LABEL, WEEKS_PER_SEASON, disambiguatedNames, rankingBandScopeNote } from '../lib/format';
import { useDevManagerId } from '../lib/managerContext';
import { refreshEntitlement, useEntitlement } from '../lib/entitlement';
import { PageShell, PanelHeader, Button, SectionLabel, Flag } from '../components/ui/primitives';
import { CelebrationMoment, CelebrationOverlay } from '../components/ui/Celebration';
import { ALL_SURFACES, surfaceMeta } from '../lib/ui/surfaces';
import { stageLabel, stageMeta } from '../lib/ui/stage';
import { FOCUS_GROUPS, focusEquals, trainingFocusLabel } from '../lib/ui/focus';

// Static reference data (surface colours, training-focus grouping, stage
// palette) lives in lib/ui/* — shared with the player profile.

// Mirrors StandardAgingPolicy's thresholds (packages/domain) — those
// values are illustrative/not-yet-balanced per CLAUDE.md — the actual
// "seasons until next stage" hint text comes from the API
// (RosterDashboardEntryDto.stageNote), computed server-side against
// the real StandardAgingPolicy, not duplicated here.

function fatigueMeta(f: number): { color: string; label: string } {
  if (f >= 70) return { color: 'oklch(65% 0.18 25)', label: `${f}% · high, rest recommended` };
  if (f >= 40) return { color: 'oklch(75% 0.15 85)', label: `${f}% · moderate` };
  return { color: 'oklch(72% 0.15 150)', label: `${f}% · fresh` };
}

// Mirrors the domain form bands (see StatisticalMatchSimulator.formModifier
// / Player.form): rusty < 8, warming 8–11, sharp 12–25, well-played 26–30,
// overplayed > 30. Both extremes cost effective rating in the sim.
function formMeta(f: number): { color: string; label: string } {
  if (f > 30) return { color: 'oklch(65% 0.18 25)', label: `${f} · overplayed, needs rest` };
  if (f >= 12 && f <= 25) return { color: 'oklch(72% 0.15 150)', label: `${f} · match sharp` };
  if (f >= 26) return { color: 'oklch(75% 0.15 85)', label: `${f} · well-played` };
  if (f >= 8) return { color: 'oklch(75% 0.15 85)', label: `${f} · warming up` };
  return { color: 'oklch(70% 0.14 30)', label: `${f} · rusty, needs matches` };
}

const STAGE_SORT_ORDER: Record<PlayerLifecycleStage, number> = { decline: 0, prime: 1, youth: 2, retired: 3 };

/** First-run guidance shown on an empty roster — a brand-new manager's
 * landing state. The core loop in three steps, each linking to where it
 * actually happens, so a fresh signup knows what to do instead of facing
 * a blank squad list. */
const FIRST_RUN_STEPS: Array<{ n: number; title: string; body: string; href: string; cta: string }> = [
  {
    n: 1,
    title: 'Sign a free agent',
    body: 'Claim a free agent from the shared talent pool. It costs XP — you start with enough for your first player.',
    href: '/scouting',
    cta: 'Sign your first player',
  },
  {
    n: 2,
    title: 'Enter a tournament',
    body: "Register them for an open tournament. This week's draws may already be underway — the planner and the entry picker show the next events still open.",
    href: '/tournaments',
    cta: 'Find a tournament',
  },
  {
    n: 3,
    title: 'Climb the rankings',
    body: 'Matches play out live on the bracket; every win earns ranking points and XP.',
    href: '/rankings',
    cta: 'See the rankings',
  },
];

type SortBy = 'fatigue' | 'stage' | 'overall' | 'name';

// ---------------------------------------------------------------------------
// Roster table cells (Direction A: values snap, colour encodes state)
// ---------------------------------------------------------------------------

/** The segmented stat bar + mono value shared by the fatigue/form and
 * doubles-chemistry cells. `pct` is clamped for the bar only; the value
 * shown is always the real figure. */
function SegStat({ value, pct, color }: { value: number; pct: number; color: string }) {
  return (
    <span className="gc-seg-wrap">
      <span
        className="gc-seg"
        style={{ ['--p' as string]: Math.max(0, Math.min(100, pct)), ['--seg' as string]: color }}
      />
      <span className="gc-seg-val">{value}</span>
    </span>
  );
}

/** Per-player "what's next" cue — the player's next match from
 * GET /players/:id/current-matches, with a live countdown ONLY to a
 * match that already has a scheduled reveal start. A truly pending
 * match (no schedule yet — its round isn't due) honestly reads
 * "awaiting simulation" rather than counting down to a time that
 * doesn't exist yet. When there is no match at all, a pending TOURNAMENT
 * ENTRY is shown instead ("draw not yet made") so a just-made entry is
 * visible immediately — never a faked match, never a bare "nothing". */
function RosterNextMatch({ matches, pendingEntry }: { matches: PlayerMatchesDto | null | undefined; pendingEntry?: PendingEntry | null }) {
  const next = matches?.next ?? null;
  const remainingMs = useCountdown(next?.scheduledStartAt ?? null);
  // Still loading (no entry yet) — render nothing rather than flashing
  // "No match scheduled" before the per-player read comes back.
  if (matches === undefined) return null;
  if (!next) {
    if (pendingEntry) {
      return (
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>Entered:</span> {pendingEntry.name}
          <span style={{ color: 'var(--ink-4)' }}>
            {' '}· S{pendingEntry.week.season} W{pendingEntry.week.week} — draw not yet made
          </span>
        </div>
      );
    }
    return (
      <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>No match scheduled</div>
    );
  }
  const live = next.scheduledStartAt !== null && remainingMs <= 0;
  return (
    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
      <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>Next:</span> vs {next.opponentName}
      <span style={{ color: 'var(--ink-4)' }}> · {next.tournamentName}</span>
      {next.scheduledStartAt === null ? (
        <span style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}> · awaiting simulation</span>
      ) : live ? (
        <span style={{ color: 'var(--live)', fontWeight: 700 }}> · live now</span>
      ) : (
        <span style={{ color: 'var(--accent)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}> · in {formatCountdownClock(remainingMs)}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function RosterDashboardPage() {
  const devManagerId = useDevManagerId();
  const [managerId, setManagerId] = useState(devManagerId ?? '');
  const [managerIdInput, setManagerIdInput] = useState(devManagerId ?? '');
  const [players, setPlayers] = useState<RosterDashboardEntryDto[] | null>(null);
  const { entitlement } = useEntitlement(managerId);
  // "What's next" cue: each player's next match (the same read the player
  // profile uses) plus the world clock's next tick, so the roster can say
  // when something is actually going to happen without faking a countdown
  // for a match that hasn't been scheduled yet.
  const [matchesByPlayer, setMatchesByPlayer] = useState<Record<string, PlayerMatchesDto | null>>({});
  // Same per-player read pattern for pending entries: GET
  // /players/:id/entry-planner (already exists — no new backend concept)
  // lets a roster row show "Entered: X — draw not yet made" for a tournament
  // whose draw hasn't been seeded, which has no match to show otherwise.
  const [plannerByPlayer, setPlannerByPlayer] = useState<Record<string, PlannerWeekDto[] | null>>({});
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('fatigue');
  const [openFocusMenu, setOpenFocusMenu] = useState<string | null>(null);
  const [openActionsMenu, setOpenActionsMenu] = useState<string | null>(null);
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const [roster, , pairs, clock] = await Promise.all([
        fetchRosterDashboard(id),
        refreshEntitlement(id),
        fetchDoublesPairs(id),
        fetchWorldClock().catch(() => null),
      ]);
      setPlayers(roster);
      setDoublesPairs(pairs);
      setWorldClock(clock);
      // One "next match" + one "pending entry" read per roster player — the
      // roster cap is tiny (2/4), so N parallel GETs to the existing per-player
      // routes is cheaper than a new read model. Failures degrade to "no match"
      // rather than blanking the board.
      const perPlayer = await Promise.all(
        roster.map(async (p) => {
          const [matches, planner] = await Promise.all([
            fetchPlayerMatches(p.id).catch(() => null),
            fetchEntryPlanner(p.id).catch(() => null),
          ]);
          return [p.id, { matches, planner }] as const;
        }),
      );
      setMatchesByPlayer(Object.fromEntries(perPlayer.map(([id, v]) => [id, v.matches])));
      setPlannerByPlayer(Object.fromEntries(perPlayer.map(([id, v]) => [id, v.planner])));
    } catch (e) {
      setPlayers(null);
      setDoublesPairs([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(managerId);
  }, [managerId, load]);

  // Keep the displayed balance (and roster) on the ONE entitlement source when
  // the tab regains focus or is restored from the back/forward cache. Without
  // this the roster could keep showing a stale XP figure while another surface
  // (e.g. Scouting) showed the current one — the exact contradiction reported.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(managerId);
    };
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [managerId, load]);

  const tier = entitlement?.tier ?? 'free';
  const slotCount: number = tier === 'pro' ? 4 : 2;
  const usedSlots = players?.length ?? 0;
  const hasPlayers = (players?.length ?? 0) > 0;
  const showEmpty = players !== null && players.length === 0;
  const showOpenSlot = hasPlayers && usedSlots < slotCount;

  const sortedPlayers = useMemo(() => {
    if (!players) return [];
    const copy = [...players];
    copy.sort((a, b) => {
      if (sortBy === 'fatigue') return b.fatigue - a.fatigue;
      if (sortBy === 'stage') return STAGE_SORT_ORDER[a.stage] - STAGE_SORT_ORDER[b.stage];
      if (sortBy === 'overall') return b.overall - a.overall;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [players, sortBy]);

  // Duplicate full names are real (the generator draws from a finite pool) —
  // disambiguate within the roster list so two "Yuki Okafor" rows stay
  // individually identifiable. Display-only, same helper as the other lists.
  const displayNames = useMemo(() => disambiguatedNames(players ?? []), [players]);

  // Counts down to the world's next DAY tick (the same nextTickAt the
  // topbar and the player profile count to) — the honest "when does the
  // world move next" signal, distinct from any single match's schedule.
  const nextTickMs = useCountdown(worldClock?.nextTickAt ?? null);

  const handleSelectFocus = useCallback(
    async (playerId: string, focus: TrainingFocus) => {
      setOpenFocusMenu(null);
      setBusyPlayerId(playerId);
      try {
        await setTrainingFocus(playerId, focus, managerId);
        await load(managerId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyPlayerId(null);
      }
    },
    [load, managerId],
  );

  const handleRelease = useCallback(
    async (playerId: string, name: string) => {
      setOpenActionsMenu(null);
      if (!window.confirm(`Release ${name}? This frees their roster slot but can't be undone.`)) return;
      setBusyPlayerId(playerId);
      try {
        await releasePlayer(playerId, managerId);
        await load(managerId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyPlayerId(null);
      }
    },
    [load, managerId],
  );

  const handlePractice = useCallback(
    async (playerId: string, name: string) => {
      setBusyPlayerId(playerId);
      try {
        const result = await runPractice(playerId, managerId);
        showNotice(`${name} practiced (+${result.experience} XP, +${result.ladderPoints} ladder, +${result.fatigue} fatigue).`);
        await load(managerId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyPlayerId(null);
      }
    },
    [load, managerId],
  );

  const [enterModalPlayer, setEnterModalPlayer] = useState<{ id: string; name: string } | null>(null);
  const [customPlayerModalOpen, setCustomPlayerModalOpen] = useState(false);
  const [coachModalPlayer, setCoachModalPlayer] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);

  // Doubles partnerships (P7a) — form a same-manager pair, list pairs +
  // incoming invites, accept/decline. Pairs are loaded as part of `load`.
  const [doublesPairs, setDoublesPairs] = useState<DoublesPairDto[] | null>(null);
  const [pairA, setPairA] = useState<string | null>(null);
  const [pairB, setPairB] = useState<string | null>(null);
  const [doublesBusy, setDoublesBusy] = useState(false);

  const reloadDoubles = useCallback(async () => {
    try {
      setDoublesPairs(await fetchDoublesPairs(managerId));
    } catch {
      setDoublesPairs([]);
    }
  }, [managerId]);

  const handleFormPair = useCallback(async () => {
    if (!pairA || !pairB) return;
    setDoublesBusy(true);
    try {
      await createDoublesPair(pairA, pairB, managerId);
      setPairA(null);
      setPairB(null);
      await reloadDoubles();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDoublesBusy(false);
    }
  }, [pairA, pairB, managerId, reloadDoubles]);

  const handleAcceptPair = useCallback(
    async (pairId: string) => {
      setDoublesBusy(true);
      try {
        await acceptDoublesPair(pairId, managerId);
        await reloadDoubles();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDoublesBusy(false);
      }
    },
    [managerId, reloadDoubles],
  );

  const handleDissolvePair = useCallback(
    async (pairId: string) => {
      setDoublesBusy(true);
      try {
        await dissolveDoublesPair(pairId, managerId);
        await reloadDoubles();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDoublesBusy(false);
      }
    },
    [managerId, reloadDoubles],
  );

  // Ranking-milestone + band-graduation celebrations (GC-16). Both are derived
  // client-side by comparing this load's values against the last-seen values in
  // localStorage — no new backend concept. Milestones only ever fire on the
  // FIRST crossing into top 100/10/1 (the best milestone already celebrated is
  // persisted, so re-renders/reloads never re-fire), and graduation only when a
  // player's live band actually changes to a higher one.
  useEffect(() => {
    if (typeof window === 'undefined' || !players) return;
    const bandOrder: Record<string, number> = { u14: 0, u16: 1, u18: 2, senior: 3 };
    const queued: CelebrationMoment[] = [];
    for (const p of players) {
      // --- rank milestone ---
      const mileKey = `gc-cele-rankmile-${p.id}`;
      const storedMile = window.localStorage.getItem(mileKey);
      const prevBest = storedMile === null ? null : Number(storedMile);
      const curBest = p.rank == null ? 0 : p.rank <= 1 ? 1 : p.rank <= 10 ? 10 : p.rank <= 100 ? 100 : 0;
      // smaller nonzero = stronger milestone; fire when we reach a stronger one
      const isStronger = curBest !== 0 && (prevBest === null || prevBest === 0 || curBest < prevBest);
      if (prevBest !== null && isStronger) {
        queued.push({
          kind: 'rank',
          milestone: curBest as 1 | 10 | 100,
          band: p.rankBand,
          playerId: p.id,
          playerName: p.name,
          nationality: p.nationality,
        });
      }
      if (prevBest === null || curBest !== 0) window.localStorage.setItem(mileKey, String(curBest || prevBest || 0));

      // --- band graduation ---
      const bandKey = `gc-cele-band-${p.id}`;
      const storedBand = window.localStorage.getItem(bandKey);
      if (storedBand !== null && storedBand !== p.rankBand && bandOrder[p.rankBand] > (bandOrder[storedBand] ?? 0)) {
        queued.push({
          kind: 'graduation',
          from: storedBand as 'u14' | 'u16' | 'u18',
          to: p.rankBand as 'u16' | 'u18' | 'senior',
          playerId: p.id,
          playerName: p.name,
          nationality: p.nationality,
        });
      }
      window.localStorage.setItem(bandKey, p.rankBand);
    }
    if (queued.length > 0) setCelebrations((cur) => [...cur, ...queued]);
  }, [players]);

  const customPlayerCredits = entitlement?.customPlayerCredits ?? 0;
  const canCreateCustomPlayer = tier === 'pro' && customPlayerCredits > 0;

  // The entry picker's fit guidance reads the player's already-loaded roster
  // row (rank + overall) — no new query.
  const enterModalEntry = enterModalPlayer ? players?.find((p) => p.id === enterModalPlayer.id) ?? null : null;

  // Unranked players get the "a ranking is earned by winning" explanation —
  // once per band present, as a table note (rows stay dense; the explanation
  // stays visible, never hover-only).
  const unrankedBands = useMemo(
    () => Array.from(new Set(sortedPlayers.filter((p) => p.rank == null).map((p) => p.rankBand))),
    [sortedPlayers],
  );

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  return (
    <AppShell active="roster" tier={tier} xpBalance={entitlement?.xpBalance}>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}

      <PageShell>
        {/* Page header — flat, no hero band/wash (Direction A). */}
        <div>
          <div className="t-label">Your Academy</div>
          <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Roster</h1>
          <div className="t-body-sm" style={{ marginTop: 4 }}>
            Shape careers, set training, and send your players onto the circuit.
          </div>
        </div>

        {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
          <form
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, fontSize: 11.5, color: 'var(--ink-4)', marginTop: 12 }}
            onSubmit={(e) => { e.preventDefault(); setManagerId(managerIdInput.trim() || managerId); }}
          >
            Manager ID (dev)
            <input className="gc-input" style={{ padding: '5px 9px', fontSize: 12 }} value={managerIdInput} onChange={(e) => setManagerIdInput(e.target.value)} />
          </form>
        )}

        {error && (
          <div
            className="gc-notice"
            style={{
              marginTop: 16,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {hasPlayers && (
          <>
            {/* Sub-bar: slot meter + tier note + the one primary talent-pool CTA. */}
            <div className="gc-subbar" style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="t-label" style={{ margin: 0 }}>Roster slots</span>
                <span className="gc-slotdots">
                  {Array.from({ length: slotCount }, (_, i) => (
                    <i key={i} className={i < usedSlots ? '' : 'empty'} />
                  ))}
                </span>
                <span className="num" style={{ fontWeight: 600 }}>{usedSlots}/{slotCount} SLOTS</span>
              </div>
              <span style={{ width: 1, height: 22, background: 'var(--hair)' }} />
              <span className="t-body-sm" style={{ fontSize: 12 }}>
                {tier === 'pro' ? '4 roster slots · faster point decay applies' : '2 roster slots · upgrade for more room'}
              </span>
              <div style={{ flex: 1 }} />
              {canCreateCustomPlayer && (
                <Button variant="ghost" onClick={() => setCustomPlayerModalOpen(true)}>
                  Create custom player ({customPlayerCredits})
                </Button>
              )}
              <Link href="/scouting" className="gc-btn gc-btn--primary" style={{ textDecoration: 'none' }}>
                + Claim free agent
              </Link>
            </div>

            <div className="gc-panel" style={{ marginTop: 24, overflow: 'visible' }}>
              <PanelHeader right={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                  <span>{usedSlots} player{usedSlots === 1 ? '' : 's'} · cap {slotCount}</span>
                  {worldClock && (
                    <span style={{ color: 'var(--ink-3)' }}>Next day in {formatCountdown(nextTickMs)}</span>
                  )}
                  <select
                    className="gc-select"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortBy)}
                    style={{ padding: '4px 26px 4px 9px', fontSize: 11.5 }}
                  >
                    <option value="fatigue">Sort: Fatigue</option>
                    <option value="stage">Sort: Nearest decline</option>
                    <option value="overall">Sort: Overall rating</option>
                    <option value="name">Sort: Name</option>
                  </select>
                </span>
              }>Squad</PanelHeader>
              <div className="gc-panel-bd flush">
                <table className="gc-table gc-table--rows">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Stage</th>
                      <th className="r">OVR</th>
                      <th>Rank</th>
                      <th className="r">Pts</th>
                      <th>Fatigue</th>
                      <th>Form</th>
                      <th>Surfaces C·G·H·I</th>
                      <th>Focus</th>
                      <th>Next</th>
                      <th className="r">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPlayers.map((p) => {
                      const fat = fatigueMeta(p.fatigue);
                      const frm = formMeta(p.form);
                      const stg = stageMeta(p.stage);
                      const busy = busyPlayerId === p.id;
                      const selected = openFocusMenu === p.id || openActionsMenu === p.id;
                      return (
                        <tr key={p.id} className={selected ? 'is-selected' : undefined} style={{ opacity: busy ? 0.55 : 1 }}>
                          {/* Identity: flag + name + age (mono); second line = last result. */}
                          <td>
                            <div className="gc-pcell">
                              <Flag code={p.nationality} />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                  <Link
                                    href={`/players/${p.id}`}
                                    className="nm gc-identity-link"
                                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  >
                                    {displayNames.get(p.id) ?? p.name}
                                  </Link>
                                  <span className="ag num">{(p.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)}</span>
                                </div>
                                <div className="t-mono-s" style={{ color: 'var(--ink-3)' }}>
                                  {p.lastResult ?? 'No matches yet'}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Stage + the server-computed ageing note. */}
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <span style={{ alignSelf: 'flex-start', padding: '1px 6px', borderRadius: 'var(--r1)', fontSize: 11, fontWeight: 700, background: stg.bg, color: stg.fg }}>
                                {stageLabel(p.stage)}
                              </span>
                              <span style={{ fontSize: 11, color: stg.noteColor }}>{p.stageNote}</span>
                            </div>
                          </td>

                          <td className="r"><span className="gc-ovr">{p.overall}</span></td>

                          {/* Rank — always labelled with its ladder, never a bare number. */}
                          <td>
                            <span className="gc-rank">
                              <span className="lad">{RANK_BAND_LABEL[p.rankBand]}</span> {p.rank == null ? 'NR' : `#${p.rank}`}
                            </span>
                          </td>

                          <td className="r num">{p.points.toLocaleString()}</td>

                          <td><SegStat value={p.fatigue} pct={p.fatigue} color={fat.color} /></td>
                          <td><SegStat value={p.form} pct={Math.min(100, p.form)} color={frm.color} /></td>

                          <td>
                            <div className="gc-surf4">
                              {ALL_SURFACES.map((key) => (
                                <span key={key} className="s" title={`${surfaceMeta(key).label}: ${p.surfaceAffinities[key]}`}>
                                  <span className="gc-dot" style={{ background: surfaceMeta(key).color }} />
                                  <span className="letter">{surfaceMeta(key).letter}</span>
                                  {p.surfaceAffinities[key]}
                                </span>
                              ))}
                            </div>
                          </td>

                          {/* Training focus — the existing control, unchanged behaviour. */}
                          <td>
                            <div style={{ position: 'relative' }}>
                              <button
                                onClick={() => setOpenFocusMenu(openFocusMenu === p.id ? null : p.id)}
                                disabled={busy || p.stage === 'retired'}
                                className="gc-select"
                                style={{ width: 96, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundImage: 'none', padding: '4px 9px', fontSize: 11.5 }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                  <span style={{ width: 6, height: 6, borderRadius: 999, background: p.trainingFocus ? 'var(--accent)' : 'var(--ink-4)' }} />
                                  {trainingFocusLabel(p.trainingFocus)}
                                </span>
                                <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>▾</span>
                              </button>
                              {openFocusMenu === p.id && (
                                <div className="gc-panel" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 190, maxHeight: 320, overflowY: 'auto', zIndex: 20, padding: 5 }}>
                                  {FOCUS_GROUPS.map((grp, i) => (
                                    <div key={grp.label} style={i > 0 ? { borderTop: '1px solid var(--hair)', marginTop: 4, paddingTop: 4 } : undefined}>
                                      <div style={{ padding: '5px 9px 3px', fontSize: 10, fontWeight: 800, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--ink-4)' }}>{grp.label}</div>
                                      {grp.options.map((opt) => {
                                        const on = focusEquals(p.trainingFocus, opt.focus);
                                        return (
                                          <div key={opt.label} role="button" onClick={() => handleSelectFocus(p.id, opt.focus)}
                                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 9px', fontSize: 12.5, cursor: 'pointer', borderRadius: 'var(--r2)', color: 'var(--ink-2)', background: on ? 'var(--bg-4)' : 'transparent' }}>
                                            {opt.label}{on && <span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>

                          {/* Next match / pending entry / no match. */}
                          <td>
                            <RosterNextMatch matches={matchesByPlayer[p.id]} pendingEntry={nextPendingEntry(plannerByPlayer[p.id])} />
                          </td>

                          {/* Actions — handlers identical to the card layout. */}
                          <td className="r">
                            <div style={{ display: 'inline-flex', gap: 4, position: 'relative' }}>
                              <Button variant="primary" onClick={() => setEnterModalPlayer({ id: p.id, name: p.name })} disabled={busy || p.stage === 'retired'} className="gc-btn--sm">Enter</Button>
                              <Button variant="ghost" onClick={() => handlePractice(p.id, p.name)} disabled={busy || p.stage === 'retired'} className="gc-btn--sm" title="Practice — no form change, small fatigue, grants development XP + ladder">Practice</Button>
                              <Button variant="ghost" onClick={() => setOpenActionsMenu(openActionsMenu === p.id ? null : p.id)} disabled={busy} className="gc-btn--sm">More ···</Button>
                              {openActionsMenu === p.id && (
                                <div className="gc-panel" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 160, zIndex: 20, padding: 5, overflow: 'hidden', textAlign: 'left' }}>
                                  {p.stage !== 'retired' ? (
                                    <div role="button" onClick={() => { setOpenActionsMenu(null); setCoachModalPlayer({ id: p.id, name: p.name }); }} style={{ padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', borderRadius: 'var(--r2)', color: 'var(--ink-2)' }}>Convert to coach</div>
                                  ) : (
                                    <div role="button" aria-disabled="true" style={{ padding: '8px 10px', fontSize: 12.5, borderRadius: 'var(--r2)', color: 'var(--ink-4)' }} title="Retired players can't become coaches">Convert to coach</div>
                                  )}
                                  <div role="button" onClick={() => handleRelease(p.id, p.name)} style={{ padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', borderRadius: 'var(--r2)', color: 'var(--loss)' }}>Release player</div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {showOpenSlot && (
                      <tr>
                        <td colSpan={11} style={{ padding: 0 }}>
                          <Link
                            href="/scouting"
                            className="gc-openslot"
                            style={{ border: 0, borderTop: '1px dashed var(--hair-2)', borderRadius: 0, textDecoration: 'none', justifyContent: 'center' }}
                          >
                            <span className="t">+ Open roster slot — add a player</span>
                          </Link>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Legend + band explanations (relocated from the old per-row
                    labels, never deleted): the letters had no explanation
                    anywhere, and the fatigue/form band words now live here. */}
                <div className="gc-tbl-note">
                  Surfaces:{' '}
                  {ALL_SURFACES.map((key, i) => {
                    const meta = surfaceMeta(key);
                    return (
                      <span key={key}>
                        {i > 0 ? ' · ' : ''}
                        <strong style={{ color: 'var(--ink-2)' }}>{meta.letter}</strong>{' '}
                        {meta.label}
                      </span>
                    );
                  })}
                </div>
                <div className="gc-tbl-note" style={{ paddingTop: 0 }}>
                  Form sweet spot 12–25 = match sharp. Fatigue is a sim modifier, not a hard block.
                </div>
                <details className="gc-details" style={{ margin: '4px 12px 12px' }}>
                  <summary>How to read fatigue and form</summary>
                  <div className="t-body-sm" style={{ marginTop: 8, fontSize: 12 }}>
                    <div>Fatigue: 70%+ high, rest recommended · 40–69% moderate · below 40% fresh.</div>
                    <div style={{ marginTop: 4 }}>Form: below 8 rusty, needs matches · 8–11 warming up · 12–25 match sharp · 26–30 well-played · over 30 overplayed, needs rest.</div>
                  </div>
                </details>
                {unrankedBands.length > 0 && (
                  <div className="gc-tbl-note" style={{ paddingTop: 0 }}>
                    {RANKING_EARNED_NOTE}{' '}
                    {unrankedBands.map((band) => rankingBandScopeNote(band)).join(' ')}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Doubles partnerships (P7a) — form a same-manager pair, and
            manage incoming/outgoing invitations. Pull-based: the other
            manager accepts from their own board. */}
        {doublesPairs !== null && (
          <div style={{ marginTop: 26 }}>
            <SectionLabel right={
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-3)' }}>
                {doublesPairs.filter((p) => p.status !== 'dissolved').length} open
              </span>
            }>Doubles</SectionLabel>

            {/* Form a same-manager pair from two of my own players. */}
            {hasPlayers && usedSlots >= 2 && (
              <div className="gc-panel" style={{ padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 10 }}>Form a doubles pair</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <select className="gc-select" value={pairA ?? ''} onChange={(e) => setPairA(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                    <option value="">Select player…</option>
                    {sortedPlayers.filter((p) => p.id !== pairB).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>+</span>
                  <select className="gc-select" value={pairB ?? ''} onChange={(e) => setPairB(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                    <option value="">Select player…</option>
                    {sortedPlayers.filter((p) => p.id !== pairA).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <Button variant="primary" onClick={handleFormPair} disabled={!pairA || !pairB || doublesBusy} className="gc-btn--sm">
                    {doublesBusy ? 'Working…' : 'Form pair'}
                  </Button>
                </div>
              </div>
            )}

            {/* Active pairs + pending invites. */}
            {doublesPairs.filter((p) => p.status !== 'dissolved').length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-4)', padding: '8px 2px' }}>
                No pairs yet — form one above, or invite a rival&apos;s player from their profile.
              </div>
            )}

            {doublesPairs.filter((p) => p.status !== 'dissolved').length > 0 && (
              <div className="gc-panel">
                <div className="gc-panel-bd flush">
                  <table className="gc-table gc-table--rows">
                    <thead>
                      <tr>
                        <th>Pair</th>
                        <th>Chemistry</th>
                        <th>Status</th>
                        <th className="r">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {doublesPairs
                        .filter((p) => p.status !== 'dissolved')
                        .map((pair) => {
                          const incoming = pair.status === 'pending' && pair.playerB.managerId === managerId;
                          const outgoing = pair.status === 'pending' && pair.playerA.managerId === managerId;
                          return (
                            <tr key={pair.id}>
                              <td>
                                {incoming ? (
                                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                                    <Flag code={pair.playerA.nationality} /> {pair.playerA.name} wants to partner with your player{' '}
                                    <Link href={`/players/${pair.playerB.playerId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{pair.playerB.name}</Link>
                                  </span>
                                ) : outgoing ? (
                                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                                    You invited <Flag code={pair.playerB.nationality} />{' '}
                                    <Link href={`/players/${pair.playerB.playerId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{pair.playerB.name}</Link>{' '}
                                    to partner with {pair.playerA.name}
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                                    {pair.playerA.name} <span style={{ color: 'var(--ink-3)' }}>·</span> {pair.playerB.name}
                                  </span>
                                )}
                              </td>
                              <td><SegStat value={pair.chemistry} pct={pair.chemistry} color="var(--accent)" /></td>
                              <td>
                                <span
                                  className="gc-badge"
                                  style={pair.status === 'active'
                                    ? { color: 'var(--win)', borderColor: 'color-mix(in srgb, var(--win) 40%, transparent)' }
                                    : { color: 'var(--hard)', borderColor: 'color-mix(in srgb, var(--hard) 40%, transparent)' }}
                                >
                                  {pair.status === 'active' ? 'Active' : incoming ? 'Invite for you' : 'Awaiting reply'}
                                </span>
                              </td>
                              <td className="r">
                                <div style={{ display: 'inline-flex', gap: 6 }}>
                                  {incoming && (
                                    <Button variant="primary" onClick={() => handleAcceptPair(pair.id)} disabled={doublesBusy} className="gc-btn--sm">
                                      Accept
                                    </Button>
                                  )}
                                  <Button variant="ghost" onClick={() => handleDissolvePair(pair.id)} disabled={doublesBusy} className="gc-btn--sm">
                                    {incoming ? 'Decline' : outgoing ? 'Cancel' : 'Dissolve'}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {showEmpty && (
          <div className="gc-panel" style={{ marginTop: 24, padding: '44px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }}>
            <div>
              <div className="t-h2">Welcome to the circuit</div>
              <div className="t-body-sm" style={{ maxWidth: 460, lineHeight: 1.55, margin: '8px auto 0' }}>
                Your academy is empty — {slotCount} roster slot{slotCount === 1 ? '' : 's'} ready and waiting. Here&apos;s the loop:
              </div>
            </div>

            <div style={{ width: '100%', maxWidth: 500, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {FIRST_RUN_STEPS.map((step) => (
                <div
                  key={step.n}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderRadius: 'var(--r2)', padding: '12px 14px', border: '1px solid var(--hair)', background: 'var(--bg-3)' }}
                >
                  <div
                    style={{ flex: 'none', width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, background: 'var(--accent)', color: 'var(--accent-ink)' }}
                  >
                    {step.n}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{step.title}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.5, marginTop: 2 }}>{step.body}</div>
                  </div>
                  <Link
                    href={step.href}
                    style={{ flex: 'none', alignSelf: 'center', fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}
                  >
                    {step.cta} →
                  </Link>
                </div>
              ))}
            </div>

            {entitlement && entitlement.xpBalance > 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                You have <strong style={{ color: 'var(--gold)' }}>{entitlement.xpBalance} XP</strong> — enough to sign your first player.
              </div>
            )}
          </div>
        )}

        {players === null && !error && (
          <div style={{ marginTop: 24, fontSize: 13.5, color: 'var(--ink-3)' }}>Loading roster…</div>
        )}
      </PageShell>

      {notice && (
        <div className="gc-panel gc-pop" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 40, fontSize: 13, fontWeight: 650, padding: '13px 18px', borderColor: 'var(--accent)' }}>
          {notice}
        </div>
      )}

      {enterModalPlayer && (
        <EnterTournamentModal
          playerId={enterModalPlayer.id}
          playerName={enterModalPlayer.name}
          managerId={managerId}
          playerFit={enterModalEntry ? { overall: enterModalEntry.overall, rank: enterModalEntry.rank, rankBand: enterModalEntry.rankBand } : null}
          onClose={() => setEnterModalPlayer(null)}
          onEntered={(tournament) => {
            setEnterModalPlayer(null);
            showNotice(`Entered ${tournament.name} (${tournament.tier}, ${tournament.surface}).`);
            // Re-read the roster, each player's pending entry and each
            // player's next match so the row updates in place. Without this
            // the row kept showing the pre-entry state (a stale "next
            // match"/entry line) until a manual reload.
            void load(managerId);
          }}
        />
      )}

      {customPlayerModalOpen && (
        <CreateCustomPlayerModal
          managerId={managerId}
          creditsRemaining={customPlayerCredits}
          onClose={() => setCustomPlayerModalOpen(false)}
          onCreated={(player) => {
            setCustomPlayerModalOpen(false);
            showNotice(`Created ${player.name}.`);
            void load(managerId);
          }}
        />
      )}

      {coachModalPlayer && (
        <CoachConversionModal
          playerId={coachModalPlayer.id}
          playerName={coachModalPlayer.name}
          managerId={managerId}
          tier={tier}
          onClose={() => setCoachModalPlayer(null)}
          onConverted={(coach) => {
            setCoachModalPlayer(null);
            showNotice(`${coachModalPlayer.name} converted to a coach (rating ${coach.coachRating}).`);
            void load(managerId);
          }}
        />
      )}
    </AppShell>
  );
}
