'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DoublesPairDto,
  EntitlementDto,
  PlayerLifecycleStage,
  RosterDashboardEntryDto,
  Surface,
  TrainingFocus,
  acceptDoublesPair,
  createDoublesPair,
  dissolveDoublesPair,
  fetchDoublesPairs,
  fetchEntitlement,
  fetchRosterDashboard,
  releasePlayer,
  runPractice,
  setTrainingFocus,
} from '../lib/api';
import { Sidebar } from '../components/Sidebar';
import { EnterTournamentModal } from '../components/EnterTournamentModal';
import { CreateCustomPlayerModal } from '../components/CreateCustomPlayerModal';
import { CoachConversionModal } from '../components/CoachConversionModal';
import { WEEKS_PER_SEASON, flagFor, stageLabel } from '../lib/format';
import { Avatar } from '../components/ui/Avatar';
import { AppFrame, PageShell, Hero, Panel, Button, SectionLabel, Flag } from '../components/ui/primitives';
import { AnimatedNumber, AnimatedOvrRing, Delta, RankShift, FlashOnGain, usePersistedPrevious } from '../components/ui/motion';
import { CelebrationMoment, CelebrationOverlay } from '../components/ui/Celebration';
import { surfaceTheme } from '../lib/surfaces';

// ---------------------------------------------------------------------------
// Static reference data — mirrors the surface-color system and training-focus
// grouping established across the whole Grand Circuit design set
// (docs/ui-direction.md), not just this screen.
// ---------------------------------------------------------------------------

const SURFACES: Array<{ key: Surface; letter: string; color: string }> = [
  { key: 'clay', letter: 'C', color: 'oklch(58% 0.14 45)' },
  { key: 'grass', letter: 'G', color: 'oklch(52% 0.12 142)' },
  { key: 'hard', letter: 'H', color: 'oklch(55% 0.13 240)' },
  { key: 'indoor', letter: 'I', color: 'oklch(48% 0.05 300)' },
];

// Single-attribute selection (see docs/training-redesign-per-attribute.md)
// — no "Mental" group at all: mental attributes are never a training
// target, enforced at the type level by TrainableAttribute, so there is
// no `focus` value this file could even construct for one.
const FOCUS_GROUPS: Array<{ label: string; options: Array<{ label: string; focus: TrainingFocus }> }> = [
  {
    label: 'Surface',
    options: SURFACES.map((s) => ({
      label: s.key[0].toUpperCase() + s.key.slice(1),
      focus: { kind: 'surface', surface: s.key },
    })),
  },
  {
    label: 'Technical',
    options: [
      { label: 'Serve', focus: { kind: 'attribute', attribute: 'serve' } },
      { label: 'Forehand', focus: { kind: 'attribute', attribute: 'forehand' } },
      { label: 'Backhand', focus: { kind: 'attribute', attribute: 'backhand' } },
      { label: 'Volley', focus: { kind: 'attribute', attribute: 'volley' } },
    ],
  },
  {
    label: 'Physical',
    options: [
      { label: 'Speed', focus: { kind: 'attribute', attribute: 'speed' } },
      { label: 'Stamina', focus: { kind: 'attribute', attribute: 'stamina' } },
      { label: 'Strength', focus: { kind: 'attribute', attribute: 'strength' } },
    ],
  },
];

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

function stageMeta(stage: PlayerLifecycleStage): { bg: string; fg: string; noteColor: string } {
  if (stage === 'prime') return { bg: 'oklch(45% 0.13 150 / 0.3)', fg: 'oklch(85% 0.14 150)', noteColor: 'var(--gc-ink-mute)' };
  if (stage === 'decline') return { bg: 'oklch(50% 0.15 40 / 0.28)', fg: 'oklch(80% 0.14 45)', noteColor: 'oklch(72% 0.13 45)' };
  if (stage === 'retired') return { bg: 'var(--gc-s3)', fg: 'var(--gc-ink-mute)', noteColor: 'var(--gc-ink-faint)' };
  return { bg: 'oklch(45% 0.1 240 / 0.28)', fg: 'oklch(83% 0.1 240)', noteColor: 'var(--gc-ink-mute)' };
}

function trainingFocusLabel(focus: TrainingFocus | null): string {
  if (!focus) return 'Set focus';
  if (focus.kind === 'surface') return focus.surface[0].toUpperCase() + focus.surface.slice(1);
  return focus.attribute[0].toUpperCase() + focus.attribute.slice(1);
}

function focusEquals(a: TrainingFocus | null, b: TrainingFocus): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'surface' && b.kind === 'surface' ? a.surface === b.surface : (a as { attribute: string }).attribute === (b as { attribute: string }).attribute;
}

const STAGE_SORT_ORDER: Record<PlayerLifecycleStage, number> = { decline: 0, prime: 1, youth: 2, retired: 3 };

type SortBy = 'fatigue' | 'stage' | 'overall' | 'name';

// ---------------------------------------------------------------------------
// Animated roster cells (GC-15). Each owns its own persisted-previous hooks so
// hook order stays stable regardless of how the roster is sorted/reordered.
// ---------------------------------------------------------------------------

/** Rank plate: points count up from last seen, a ▲/▼ shift chip shows how many
 *  positions the player moved, and a floating +/− points delta rises off it. */
function AnimatedRankPlate({ playerId, rank, points }: { playerId: string; rank: number | null; points: number }) {
  const prevRank = usePersistedPrevious(`roster:rank:${playerId}`, rank ?? -1);
  const prevPoints = usePersistedPrevious(`roster:pts:${playerId}`, points);
  const nr = rank == null;
  const fromRank = prevRank != null && prevRank > 0 ? prevRank : null;
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>#</span>
      <span style={{ fontSize: 26, fontWeight: 850, lineHeight: 1, letterSpacing: '-0.5px', color: nr ? 'var(--gc-ink-faint)' : 'var(--gc-gold)', fontVariantNumeric: 'tabular-nums' }}>
        {nr ? 'NR' : rank}
      </span>
      {!nr && fromRank != null && <RankShift from={fromRank} to={rank} />}
      {!nr && (
        <span style={{ position: 'relative', fontSize: 11.5, color: 'var(--gc-ink-mute)' }}>
          <AnimatedNumber value={points} from={prevPoints ?? points} mountFrom={prevPoints ?? points} format={(n) => `${Math.round(n).toLocaleString()} pts`} style={{ fontSize: 11.5, color: 'var(--gc-ink-mute)' }} />
          <Delta value={points} />
        </span>
      )}
    </div>
  );
}

/** A single surface-affinity bar that grows from its previously-seen height and
 *  flashes green when the affinity has risen since last seen. */
function AnimatedAffinityBar({ playerId, surfaceKey, value, letter }: { playerId: string; surfaceKey: Surface; value: number; letter: string }) {
  const pct = Math.round((value / 60) * 100);
  const t = surfaceTheme(surfaceKey);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <FlashOnGain value={value} radius={4}>
        <div style={{ width: 11, height: 34, borderRadius: 4, display: 'flex', alignItems: 'flex-end', overflow: 'hidden', background: 'oklch(0% 0 0 / 0.35)' }} title={`${surfaceKey}: ${value}`}>
          <div className="gc-bar-fill" style={{ width: '100%', height: `${pct}%`, background: `linear-gradient(180deg, ${t.color}, ${t.deep})`, transition: 'height 700ms cubic-bezier(.2,.8,.2,1)' }} />
        </div>
      </FlashOnGain>
      <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>{letter}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function RosterDashboardPage() {
  const [managerId, setManagerId] = useState('seed-m1');
  const [managerIdInput, setManagerIdInput] = useState('seed-m1');
  const [players, setPlayers] = useState<RosterDashboardEntryDto[] | null>(null);
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('fatigue');
  const [openFocusMenu, setOpenFocusMenu] = useState<string | null>(null);
  const [openActionsMenu, setOpenActionsMenu] = useState<string | null>(null);
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const [roster, ent, pairs] = await Promise.all([fetchRosterDashboard(id), fetchEntitlement(id), fetchDoublesPairs(id)]);
      setPlayers(roster);
      setEntitlement(ent);
      setDoublesPairs(pairs);
    } catch (e) {
      setPlayers(null);
      setEntitlement(null);
      setDoublesPairs([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(managerId);
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
    const bandOrder: Record<string, number> = { u14: 0, u16: 1, senior: 2 };
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
          from: storedBand as 'u14' | 'u16',
          to: p.rankBand as 'u16' | 'senior',
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

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  return (
    <AppFrame>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}
      <Sidebar active="roster" tier={tier} xpBalance={entitlement?.xpBalance} />

      <PageShell wash="radial-gradient(120% 60% at 90% -10%, oklch(40% 0.05 122 / 0.16), transparent 60%)">
        {/* HERO */}
        <Hero minHeight={140}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(90% 0.02 150)', opacity: 0.85 }}>Your Academy</div>
              <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Roster</div>
              <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 150)', opacity: 0.8, marginTop: 4 }}>
                Shape careers, set training, and send your players onto the circuit.
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {canCreateCustomPlayer && (
                  <Button variant="ghost" onClick={() => setCustomPlayerModalOpen(true)} style={{ background: 'oklch(100% 0 0 / 0.12)', color: 'white', borderColor: 'oklch(100% 0 0 / 0.25)' }}>
                    Create custom player ({customPlayerCredits})
                  </Button>
                )}
                <Link href="/scouting" style={{ textDecoration: 'none' }}>
                  <Button variant="primary">Browse talent pool →</Button>
                </Link>
              </div>
              {/* Slot pips */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, color: 'oklch(92% 0.01 150)', opacity: 0.85, fontWeight: 600 }}>
                  {usedSlots} / {slotCount} slots
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {Array.from({ length: slotCount }, (_, i) => (
                    <div key={i} style={{
                      width: 20, height: 6, borderRadius: 3,
                      background: i < usedSlots ? 'var(--gc-ball)' : 'oklch(100% 0 0 / 0.2)',
                      boxShadow: i < usedSlots ? '0 0 6px var(--gc-ball)' : 'none',
                    }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Hero>

        {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
          <form
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, fontSize: 11.5, color: 'var(--gc-ink-faint)', marginTop: 12 }}
            onSubmit={(e) => { e.preventDefault(); setManagerId(managerIdInput.trim() || managerId); }}
          >
            Manager ID (dev)
            <input className="gc-input" style={{ padding: '5px 9px', fontSize: 12 }} value={managerIdInput} onChange={(e) => setManagerIdInput(e.target.value)} />
          </form>
        )}

        {error && (
          <div style={{ marginTop: 16, fontSize: 13, borderRadius: 10, padding: '10px 14px', color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {hasPlayers && (
          <>
            <SectionLabel right={
              <select className="gc-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} style={{ padding: '7px 28px 7px 10px', fontSize: 12 }}>
                <option value="fatigue">Sort: Fatigue</option>
                <option value="stage">Sort: Nearest decline</option>
                <option value="overall">Sort: Overall rating</option>
                <option value="name">Sort: Name</option>
              </select>
            }>Squad · {usedSlots} player{usedSlots === 1 ? '' : 's'}</SectionLabel>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sortedPlayers.map((p, idx) => {
                const fat = fatigueMeta(p.fatigue);
                const frm = formMeta(p.form);
                const stg = stageMeta(p.stage);
                const busy = busyPlayerId === p.id;
                return (
                  <Panel key={p.id} hover grain className="gc-rise" style={{ padding: 0, opacity: busy ? 0.55 : 1, animationDelay: `${idx * 55}ms`, overflow: 'visible' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.5fr) auto minmax(0,1.1fr) minmax(0,1.15fr) auto minmax(150px,1.2fr) auto', gap: 16, alignItems: 'center', padding: '15px 18px' }}>
                      {/* Identity */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
                        <Avatar id={p.id} name={p.name} size={52} />
                        <div style={{ minWidth: 0 }}>
                          <Link href={`/players/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 7, textDecoration: 'none', color: 'var(--gc-ink)', fontWeight: 750, fontSize: 15.5 }}>
                            <Flag code={p.nationality} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                          </Link>
                          <div style={{ fontSize: 12, color: 'var(--gc-ink-mute)', marginTop: 2 }}>
                            Age {(p.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)} · <span style={{ color: 'var(--gc-ink-faint)' }}>{p.lastResult ?? 'No matches yet'}</span>
                          </div>
                        </div>
                      </div>

                      {/* OVR */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <AnimatedOvrRing value={p.overall} size={46} persistKey={`roster:ovr:${p.id}`} />
                        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.5px', color: 'var(--gc-ink-faint)' }}>OVR</span>
                      </div>

                      {/* Rank */}
                      <div>
                        <AnimatedRankPlate playerId={p.id} rank={p.rank} points={p.points} />
                        {p.rankBand !== 'senior' && (
                          <span className="gc-badge" style={{ marginTop: 4, background: 'oklch(45% 0.1 240 / 0.3)', color: 'oklch(84% 0.09 240)' }}>{p.rankBand}</span>
                        )}
                      </div>

                      {/* Stage + fatigue + form */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ alignSelf: 'flex-start', padding: '3px 9px', borderRadius: 6, fontSize: 11, fontWeight: 750, background: stg.bg, color: stg.fg }}>
                          {stageLabel(p.stage)}
                        </span>
                        <div className="gc-bar" style={{ width: '100%', maxWidth: 130 }}><i style={{ width: `${p.fatigue}%`, background: fat.color }} /></div>
                        <span style={{ fontSize: 10.5, color: fat.color, fontWeight: 600 }}>{fat.label}</span>
                        <div className="gc-bar" style={{ width: '100%', maxWidth: 130 }}><i style={{ width: `${Math.min(100, p.form)}%`, background: frm.color }} /></div>
                        <span style={{ fontSize: 10.5, color: frm.color, fontWeight: 600 }}>Form {frm.label}</span>
                      </div>

                      {/* Surfaces */}
                      <div style={{ display: 'flex', gap: 7 }}>
                        {SURFACES.map((s) => (
                          <AnimatedAffinityBar key={s.key} playerId={p.id} surfaceKey={s.key} value={p.surfaceAffinities[s.key]} letter={s.letter} />
                        ))}
                      </div>

                      {/* Training focus */}
                      <div style={{ position: 'relative' }}>
                        <button
                          onClick={() => setOpenFocusMenu(openFocusMenu === p.id ? null : p.id)}
                          disabled={busy || p.stage === 'retired'}
                          className="gc-select"
                          style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundImage: 'none' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: p.trainingFocus ? 'var(--gc-ball)' : 'var(--gc-ink-faint)' }} />
                            {trainingFocusLabel(p.trainingFocus)}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--gc-ink-mute)' }}>▾</span>
                        </button>
                        {openFocusMenu === p.id && (
                          <div className="gc-panel" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, minWidth: 180, maxHeight: 320, overflowY: 'auto', zIndex: 20, padding: 5 }}>
                            {FOCUS_GROUPS.map((grp, i) => (
                              <div key={grp.label} style={i > 0 ? { borderTop: '1px solid var(--gc-line)', marginTop: 4, paddingTop: 4 } : undefined}>
                                <div style={{ padding: '5px 9px 3px', fontSize: 10, fontWeight: 800, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--gc-ink-faint)' }}>{grp.label}</div>
                                {grp.options.map((opt) => {
                                  const on = focusEquals(p.trainingFocus, opt.focus);
                                  return (
                                    <div key={opt.label} onClick={() => handleSelectFocus(p.id, opt.focus)}
                                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 9px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7, color: 'var(--gc-ink-dim)', background: on ? 'var(--gc-s3)' : 'transparent' }}>
                                      {opt.label}{on && <span style={{ color: 'var(--gc-ball)', fontWeight: 800 }}>✓</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative', width: 92 }}>
                        <Button variant="primary" onClick={() => setEnterModalPlayer({ id: p.id, name: p.name })} disabled={busy || p.stage === 'retired'} style={{ padding: '7px 10px', fontSize: 12 }}>Enter</Button>
                        <Button variant="ghost" onClick={() => handlePractice(p.id, p.name)} disabled={busy || p.stage === 'retired'} style={{ padding: '6px 10px', fontSize: 12 }} title="Practice — no form change, small fatigue, grants development XP + ladder">Practice</Button>
                        <Button variant="ghost" onClick={() => setOpenActionsMenu(openActionsMenu === p.id ? null : p.id)} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>More ···</Button>
                        {openActionsMenu === p.id && (
                          <div className="gc-panel" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 160, zIndex: 20, padding: 5, overflow: 'hidden' }}>
                            {p.stage !== 'retired' ? (
                              <div onClick={() => { setOpenActionsMenu(null); setCoachModalPlayer({ id: p.id, name: p.name }); }} style={{ padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7, color: 'var(--gc-ink-dim)' }}>Convert to coach</div>
                            ) : (
                              <div style={{ padding: '8px 10px', fontSize: 12.5, borderRadius: 7, color: 'var(--gc-ink-faint)' }} title="Retired players can't become coaches">Convert to coach</div>
                            )}
                            <div onClick={() => handleRelease(p.id, p.name)} style={{ padding: '8px 10px', fontSize: 12.5, cursor: 'pointer', borderRadius: 7, color: 'oklch(72% 0.16 25)' }}>Release player</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </Panel>
                );
              })}

              {showOpenSlot && (
                <Link href="/scouting" style={{ textDecoration: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, padding: 18, fontSize: 13, fontWeight: 650, color: 'var(--gc-ink-mute)', border: '1.5px dashed var(--gc-line)', background: 'oklch(100% 0 0 / 0.02)' }}>
                    + Open roster slot — browse the talent pool
                  </div>
                </Link>
              )}
            </div>
          </>
        )}

        {/* Doubles partnerships (P7a) — form a same-manager pair, and
            manage incoming/outgoing invitations. Pull-based: the other
            manager accepts from their own board. */}
        {doublesPairs !== null && (
          <div style={{ marginTop: 26 }}>
            <SectionLabel right={
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>
                {doublesPairs.filter((p) => p.status !== 'dissolved').length} open
              </span>
            }>Doubles</SectionLabel>

            {/* Form a same-manager pair from two of my own players. */}
            {hasPlayers && usedSlots >= 2 && (
              <Panel grain style={{ padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--gc-ink)', marginBottom: 10 }}>Form a doubles pair</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <select className="gc-select" value={pairA ?? ''} onChange={(e) => setPairA(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                    <option value="">Select player…</option>
                    {sortedPlayers.filter((p) => p.id !== pairB).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 12, color: 'var(--gc-ink-mute)' }}>+</span>
                  <select className="gc-select" value={pairB ?? ''} onChange={(e) => setPairB(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                    <option value="">Select player…</option>
                    {sortedPlayers.filter((p) => p.id !== pairA).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <Button variant="primary" onClick={handleFormPair} disabled={!pairA || !pairB || doublesBusy} style={{ padding: '7px 14px', fontSize: 12.5 }}>
                    {doublesBusy ? 'Working…' : 'Form pair'}
                  </Button>
                </div>
              </Panel>
            )}

            {/* Active pairs + pending invites. */}
            {doublesPairs.filter((p) => p.status !== 'dissolved').length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--gc-ink-faint)', padding: '8px 2px' }}>
                No pairs yet — form one above, or invite a rival&apos;s player from their profile.
              </div>
            )}

            {doublesPairs
              .filter((p) => p.status !== 'dissolved')
              .map((pair) => {
                const incoming = pair.status === 'pending' && pair.playerB.managerId === managerId;
                const outgoing = pair.status === 'pending' && pair.playerA.managerId === managerId;
                return (
                  <Panel key={pair.id} style={{ padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span
                        className="gc-badge"
                        style={{
                          background: pair.status === 'active' ? 'oklch(45% 0.13 150 / 0.3)' : 'oklch(45% 0.1 240 / 0.3)',
                          color: pair.status === 'active' ? 'oklch(85% 0.14 150)' : 'oklch(84% 0.09 240)',
                        }}
                      >
                        {pair.status === 'active' ? 'Active' : incoming ? 'Invite for you' : 'Awaiting reply'}
                      </span>
                      {incoming ? (
                        <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--gc-ink)' }}>
                          <Flag code={pair.playerA.nationality} /> {pair.playerA.name} wants to partner with your player{' '}
                          <Link href={`/players/${pair.playerB.playerId}`} style={{ color: 'var(--gc-ball)', textDecoration: 'none' }}>{pair.playerB.name}</Link>
                        </span>
                      ) : outgoing ? (
                        <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--gc-ink)' }}>
                          You invited <Flag code={pair.playerB.nationality} />{' '}
                          <Link href={`/players/${pair.playerB.playerId}`} style={{ color: 'var(--gc-ball)', textDecoration: 'none' }}>{pair.playerB.name}</Link>{' '}
                          to partner with {pair.playerA.name}
                        </span>
                      ) : (
                        <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--gc-ink)' }}>
                          {pair.playerA.name} <span style={{ color: 'var(--gc-ink-mute)' }}>·</span> {pair.playerB.name}
                          {pair.chemistry > 0 && (
                            <span className="gc-badge" style={{ marginLeft: 8, background: 'oklch(45% 0.1 150 / 0.3)', color: 'oklch(85% 0.12 150)' }}>
                              chem {pair.chemistry}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {incoming && (
                        <Button variant="primary" onClick={() => handleAcceptPair(pair.id)} disabled={doublesBusy} style={{ padding: '6px 12px', fontSize: 12 }}>
                          Accept
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => handleDissolvePair(pair.id)} disabled={doublesBusy} style={{ padding: '6px 12px', fontSize: 12 }}>
                        {incoming ? 'Decline' : outgoing ? 'Cancel' : 'Dissolve'}
                      </Button>
                    </div>
                  </Panel>
                );
              })}
          </div>
        )}

        {showEmpty && (
          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <Panel grain style={{ padding: '64px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <Avatar id="empty-roster-slot" size={72} />
              <div style={{ fontSize: 19, fontWeight: 800 }}>Your academy has no players yet</div>
              <div style={{ fontSize: 14, maxWidth: 380, lineHeight: 1.55, color: 'var(--gc-ink-mute)' }}>
                Claim your first prospect from the talent pool to start entering tournaments. You have {slotCount} roster slot{slotCount === 1 ? '' : 's'} waiting.
              </div>
              <Link href="/scouting" style={{ textDecoration: 'none', marginTop: 4 }}><Button variant="primary" style={{ padding: '12px 24px', fontSize: 14 }}>Browse talent pool →</Button></Link>
            </Panel>
          </div>
        )}

        {players === null && !error && (
          <div style={{ marginTop: 24, fontSize: 13.5, color: 'var(--gc-ink-mute)' }}>Loading roster…</div>
        )}
      </PageShell>

      {notice && (
        <div className="gc-panel gc-pop" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 40, fontSize: 13, fontWeight: 650, padding: '13px 18px', borderColor: 'var(--gc-ball-d)' }}>
          {notice}
        </div>
      )}

      {enterModalPlayer && (
        <EnterTournamentModal
          playerId={enterModalPlayer.id}
          playerName={enterModalPlayer.name}
          managerId={managerId}
          onClose={() => setEnterModalPlayer(null)}
          onEntered={(tournament) => {
            setEnterModalPlayer(null);
            showNotice(`Entered ${tournament.name} (${tournament.tier}, ${tournament.surface}).`);
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
    </AppFrame>
  );
}
