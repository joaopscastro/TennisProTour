'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EntitlementDto,
  PlayerLifecycleStage,
  RosterDashboardEntryDto,
  Surface,
  TournamentDto,
  TrainingFocus,
  fetchEntitlement,
  fetchOpenTournaments,
  fetchRosterDashboard,
  hirePlayer,
  registerEntrant,
  releasePlayer,
  setTrainingFocus,
} from '../lib/api';

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

const FOCUS_GROUPS: Array<{ label: string; options: Array<{ label: string; focus: TrainingFocus }> }> = [
  {
    label: 'Surface',
    options: SURFACES.map((s) => ({
      label: s.key[0].toUpperCase() + s.key.slice(1),
      focus: { kind: 'surface', surface: s.key },
    })),
  },
  {
    label: 'Skill',
    options: [
      { label: 'Technical', focus: { kind: 'skill', cluster: 'technical' } },
      { label: 'Physical', focus: { kind: 'skill', cluster: 'physical' } },
      { label: 'Mental', focus: { kind: 'skill', cluster: 'mental' } },
    ],
  },
];

/** Deterministic per-player avatar tint, cycling through the same
 * surface-accent palette used everywhere else — avatar color is
 * presentation only, so it's derived here rather than stored on the
 * backend (see RosterDashboardEntry's doc comment). */
const AVATAR_COLORS = [
  'oklch(58% 0.14 45)',
  'oklch(55% 0.13 240)',
  'oklch(48% 0.05 300)',
  'oklch(52% 0.12 142)',
  'oklch(62% 0.13 75)',
  'oklch(55% 0.16 25)',
];

function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

/** A flat flag glyph from any 2-letter nationality code — no per-country
 * palette to hand-maintain, unlike the original mockup's hardcoded
 * per-seed-player flat-CSS swatches, since real hired players can carry
 * any nationality string, not a fixed curated set. */
function flagFor(nationality: string): string {
  if (!/^[A-Za-z]{2}$/.test(nationality)) return '\u{1F3F3}\u{FE0F}';
  const base = 0x1f1e6;
  return nationality
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(base + c.charCodeAt(0) - 65))
    .join('');
}

// Mirrors StandardAgingPolicy's thresholds (packages/domain) — those
// values are illustrative/not-yet-balanced per CLAUDE.md and aren't
// exposed via API yet, so they're duplicated here only for this
// "seasons until next stage" hint text, not for any real game logic.
const WEEKS_PER_SEASON = 52;
const PRIME_START_WEEK = 20 * WEEKS_PER_SEASON;
const DECLINE_START_WEEK = 30 * WEEKS_PER_SEASON;
const RETIREMENT_WEEK = 38 * WEEKS_PER_SEASON;

function stageLabel(stage: PlayerLifecycleStage): string {
  return stage[0].toUpperCase() + stage.slice(1);
}

function stageNote(stage: PlayerLifecycleStage, ageInWeeks: number): string {
  if (stage === 'retired') return 'Retired';
  if (stage === 'youth') {
    const seasons = Math.max(1, Math.ceil((PRIME_START_WEEK - ageInWeeks) / WEEKS_PER_SEASON));
    return `Prime in ~${seasons} season${seasons === 1 ? '' : 's'}`;
  }
  if (stage === 'prime') {
    const seasons = Math.max(1, Math.ceil((DECLINE_START_WEEK - ageInWeeks) / WEEKS_PER_SEASON));
    return `Decline in ~${seasons} season${seasons === 1 ? '' : 's'}`;
  }
  const seasons = Math.max(1, Math.ceil((RETIREMENT_WEEK - ageInWeeks) / WEEKS_PER_SEASON));
  return seasons <= 1 ? 'Retires in 1 season' : `Retires in ~${seasons} seasons`;
}

function stageMeta(stage: PlayerLifecycleStage): { bg: string; fg: string; noteColor: string } {
  if (stage === 'prime') return { bg: 'oklch(22% 0.006 75)', fg: 'white', noteColor: 'oklch(50% 0.006 75)' };
  if (stage === 'decline') return { bg: 'oklch(90% 0.03 40)', fg: 'oklch(38% 0.1 30)', noteColor: 'oklch(48% 0.13 30)' };
  return { bg: 'oklch(93% 0.006 75)', fg: 'oklch(35% 0.006 75)', noteColor: 'oklch(50% 0.006 75)' };
}

function fatigueMeta(f: number): { color: string; label: string } {
  if (f >= 70) return { color: 'oklch(55% 0.16 25)', label: `${f}% — high, rest recommended` };
  if (f >= 40) return { color: 'oklch(62% 0.13 75)', label: `${f}% — moderate` };
  return { color: 'oklch(55% 0.12 142)', label: `${f}% — fresh` };
}

function trainingFocusLabel(focus: TrainingFocus | null): string {
  if (!focus) return 'Set focus';
  if (focus.kind === 'surface') return focus.surface[0].toUpperCase() + focus.surface.slice(1);
  return focus.cluster[0].toUpperCase() + focus.cluster.slice(1);
}

function focusEquals(a: TrainingFocus | null, b: TrainingFocus): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'surface' && b.kind === 'surface' ? a.surface === b.surface : (a as { cluster: string }).cluster === (b as { cluster: string }).cluster;
}

const STAGE_SORT_ORDER: Record<PlayerLifecycleStage, number> = { decline: 0, prime: 1, youth: 2, retired: 3 };

type SortBy = 'fatigue' | 'stage' | 'overall' | 'name';

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
      const [roster, ent] = await Promise.all([fetchRosterDashboard(id), fetchEntitlement(id)]);
      setPlayers(roster);
      setEntitlement(ent);
    } catch (e) {
      setPlayers(null);
      setEntitlement(null);
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
        await setTrainingFocus(playerId, focus);
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
        await releasePlayer(playerId);
        await load(managerId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyPlayerId(null);
      }
    },
    [load, managerId],
  );

  const handleEnter = useCallback(
    async (playerId: string) => {
      setBusyPlayerId(playerId);
      try {
        const open: TournamentDto[] = await fetchOpenTournaments();
        const candidate = open.find(
          (t) => t.entrants.length < t.drawSize && !t.entrants.some((e) => e.playerId === playerId),
        );
        if (!candidate) {
          window.alert('No open tournaments have room for this player right now.');
          return;
        }
        await registerEntrant(candidate.id, playerId);
        window.alert(`Entered ${candidate.tier} (${candidate.surface}).`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyPlayerId(null);
      }
    },
    [],
  );

  const handleHire = useCallback(async () => {
    const name = window.prompt('New player name:');
    if (!name) return;
    const nationality = (window.prompt('Nationality (2-letter code, e.g. BR):', 'BR') || 'XX').slice(0, 2).toUpperCase();
    try {
      await hirePlayer({
        playerId: `p-${Date.now()}`,
        name,
        nationality,
        managerId,
        startingAgeInWeeks: 18 * WEEKS_PER_SEASON,
      });
      await load(managerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, managerId]);

  return (
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      {/* SIDEBAR NAV SHELL */}
      <div className="w-[232px] flex-none flex flex-col p-[22px_16px] text-[oklch(96%_0.004_75)]" style={{ background: 'oklch(18% 0.006 75)' }}>
        <div className="flex items-center gap-[10px] px-2 pt-1 pb-[26px]">
          <div className="w-7 h-7 rounded-[5px] flex-none flex items-center justify-center" style={{ background: 'oklch(24% 0.008 75)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9.5" fill="oklch(76% 0.19 122)" />
              <path d="M5.2 3.6c3 3.4 3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M18.8 3.6c-3 3.4-3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <div className="font-bold text-[15px] tracking-[0.2px]">Grand Circuit</div>
        </div>

        <div className="flex flex-col gap-[2px]">
          <div className="flex items-center gap-[10px] px-3 py-[10px] rounded-[6px] font-semibold text-[13.5px]" style={{ background: 'oklch(28% 0.008 75)' }}>
            <div className="w-[6px] h-[6px] rounded-full" style={{ background: 'oklch(72% 0.14 45)' }} />
            Roster
          </div>
          <div className="flex items-center gap-[10px] px-3 py-[10px] rounded-[6px] text-[13.5px]" style={{ color: 'oklch(80% 0.005 75)' }}>
            <div className="w-[6px] h-[6px] rounded-full bg-transparent" />
            Tournaments
          </div>
          <div className="flex items-center gap-[10px] px-3 py-[10px] rounded-[6px] text-[13.5px]" style={{ color: 'oklch(80% 0.005 75)' }}>
            <div className="w-[6px] h-[6px] rounded-full bg-transparent" />
            Manager Pro
          </div>
          <div className="flex items-center justify-between px-3 py-[10px] rounded-[6px] text-[13.5px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            <div className="flex items-center gap-[10px]">
              <div className="w-[6px] h-[6px] rounded-full bg-transparent" />
              Scouting
            </div>
            <div className="text-[10px] font-semibold tracking-[0.4px] px-[6px] py-[2px] rounded-[4px]" style={{ background: 'oklch(28% 0.008 75)', color: 'oklch(65% 0.006 75)' }}>
              SOON
            </div>
          </div>
          <div className="flex items-center justify-between px-3 py-[10px] rounded-[6px] text-[13.5px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            <div className="flex items-center gap-[10px]">
              <div className="w-[6px] h-[6px] rounded-full bg-transparent" />
              Social
            </div>
            <div className="text-[10px] font-semibold tracking-[0.4px] px-[6px] py-[2px] rounded-[4px]" style={{ background: 'oklch(28% 0.008 75)', color: 'oklch(65% 0.006 75)' }}>
              SOON
            </div>
          </div>
        </div>

        <div className="mt-auto p-3 rounded-[8px] flex flex-col gap-[6px]" style={{ background: 'oklch(24% 0.008 75)' }}>
          <div className="flex items-center gap-[6px] mb-1">
            <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.55)' }} />
            <div className="w-px h-2" style={{ background: 'rgba(255,255,255,0.85)' }} />
            <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.55)' }} />
          </div>
          <div className="text-[11px] font-semibold tracking-[0.4px] uppercase" style={{ color: 'oklch(70% 0.006 75)' }}>
            {tier === 'pro' ? 'Manager Pro' : 'Free Tier'}
          </div>
          <div className="text-[12px] leading-[1.4]" style={{ color: 'oklch(78% 0.005 75)' }}>
            {tier === 'pro' ? '4 roster slots · faster point decay applies' : '2 roster slots · upgrade for more room'}
          </div>
          <label className="mt-2 flex flex-col gap-1 text-[11px]" style={{ color: 'oklch(65% 0.006 75)' }}>
            Manager ID (dev)
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setManagerId(managerIdInput.trim() || managerId);
              }}
            >
              <input
                value={managerIdInput}
                onChange={(e) => setManagerIdInput(e.target.value)}
                className="w-full rounded px-2 py-1 text-[12px] text-[oklch(22%_0.006_75)]"
                style={{ background: 'white' }}
              />
            </form>
          </label>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 p-8 max-w-[1180px] min-w-0">
        <div className="flex items-start justify-between mb-7">
          <div>
            <div className="text-[23px] font-bold tracking-[-0.2px]">Roster</div>
            <div className="text-[13.5px] mt-[3px]" style={{ color: 'oklch(48% 0.006 75)' }}>
              Manage your players, training focus, and tournament entries.
            </div>
          </div>
          <div className="flex flex-col items-end gap-[6px]">
            <button
              onClick={handleHire}
              className="text-white border-none px-[18px] py-[10px] rounded-[6px] text-[13.5px] font-semibold cursor-pointer hover:opacity-90"
              style={{ background: 'oklch(20% 0.006 75)' }}
            >
              Hire player
            </button>
            <div className="text-[11.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
              {tier === 'pro'
                ? `Roster ${usedSlots} of ${slotCount} slots used`
                : `Roster ${usedSlots} of ${slotCount} slots used · Manager Pro adds 2 more (faster point decay applies)`}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        {hasPlayers && (
          <div>
            {/* Toolbar: slot indicator + sort */}
            <div className="flex items-center justify-between mb-[14px]">
              <div className="flex items-center gap-2">
                <div className="text-[12.5px] font-semibold" style={{ color: 'oklch(30% 0.006 75)' }}>
                  Roster {usedSlots}/{slotCount}
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: slotCount }, (_, i) => (
                    <div
                      key={i}
                      className="w-2 h-2 rounded-[2px]"
                      style={{ background: i < usedSlots ? 'oklch(20% 0.006 75)' : 'oklch(88% 0.006 75)' }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 text-[12.5px]" style={{ color: 'oklch(48% 0.006 75)' }}>
                Sort by
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortBy)}
                  className="font-semibold text-[12.5px] rounded-[6px] px-2 py-[6px] cursor-pointer text-[oklch(22%_0.006_75)]"
                  style={{ background: 'white', border: '1px solid oklch(88% 0.006 75)' }}
                >
                  <option value="fatigue">Fatigue (highest first)</option>
                  <option value="stage">Stage / age (nearest decline)</option>
                  <option value="overall">Overall rating</option>
                  <option value="name">Name</option>
                </select>
              </div>
            </div>

            {/* Net-line motif divider */}
            <div className="flex items-center gap-0 my-[2px] mb-[14px]">
              <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
              <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
              <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
              <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
              <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
            </div>

            {/* Table header */}
            <div
              className="grid gap-[14px] px-4 pb-2 text-[11px] font-semibold tracking-[0.5px] uppercase"
              style={{
                gridTemplateColumns: 'minmax(0,2.6fr) minmax(46px,0.6fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,1.3fr) minmax(80px,1fr)',
                color: 'oklch(52% 0.006 75)',
              }}
            >
              <div>Player</div>
              <div>Rank</div>
              <div>Stage</div>
              <div>Fatigue</div>
              <div>Surfaces</div>
              <div>Training focus</div>
              <div className="text-right">Actions</div>
            </div>

            <div className="flex flex-col gap-[10px]">
              {sortedPlayers.map((p) => {
                const fat = fatigueMeta(p.fatigue);
                const stg = stageMeta(p.stage);
                const busy = busyPlayerId === p.id;
                return (
                  <div
                    key={p.id}
                    className="grid gap-[14px] items-center bg-white rounded-[8px] px-4 py-[14px]"
                    style={{
                      gridTemplateColumns:
                        'minmax(0,2.6fr) minmax(46px,0.6fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,1.3fr) minmax(80px,1fr)',
                      border: '1px solid oklch(90% 0.005 75)',
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {/* Player */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-[42px] h-[42px] flex-none rounded-[6px] flex items-center justify-center text-white font-bold text-[14px]"
                        style={{ background: avatarColorFor(p.id) }}
                      >
                        {initialsFor(p.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-[14px] flex items-center gap-[7px] overflow-hidden text-ellipsis">
                          <span className="flex-none">{flagFor(p.nationality)}</span>
                          {p.name}
                        </div>
                        <div className="text-[12px]" style={{ color: 'oklch(50% 0.006 75)' }}>
                          Age {(p.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)}
                        </div>
                        <div className="text-[11px] mt-px" style={{ color: 'oklch(52% 0.006 75)' }}>
                          Last: {p.lastResult ?? 'No matches yet'}
                        </div>
                      </div>
                    </div>

                    {/* Rank */}
                    <div>
                      <div className="text-[19px] font-bold [font-variant-numeric:tabular-nums]">
                        {p.rank !== null ? `#${p.rank}` : '—'}
                      </div>
                      <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                        {p.overall} OVR
                      </div>
                    </div>

                    {/* Stage */}
                    <div className="flex flex-col gap-1 items-start">
                      <div
                        className="inline-block px-[9px] py-[3px] rounded-[4px] text-[11px] font-bold tracking-[0.3px]"
                        style={{ background: stg.bg, color: stg.fg }}
                      >
                        {stageLabel(p.stage)}
                      </div>
                      <div className="text-[11px]" style={{ color: stg.noteColor }}>
                        {stageNote(p.stage, p.ageInWeeks)}
                      </div>
                    </div>

                    {/* Fatigue */}
                    <div className="flex flex-col gap-[5px]">
                      <div className="w-full max-w-[110px] h-[7px] rounded-[4px] overflow-hidden" style={{ background: 'oklch(92% 0.004 75)' }}>
                        <div className="h-full rounded-[4px]" style={{ background: fat.color, width: `${p.fatigue}%` }} />
                      </div>
                      <div className="text-[11px] font-semibold" style={{ color: fat.color }}>
                        {fat.label}
                      </div>
                    </div>

                    {/* Surfaces */}
                    <div className="flex gap-[6px]">
                      {SURFACES.map((s) => {
                        const val = p.surfaceAffinities[s.key];
                        const pct = Math.round((val / 60) * 100);
                        return (
                          <div key={s.key} className="flex flex-col items-center gap-[3px]">
                            <div className="w-[11px] h-8 rounded-[3px] flex items-end overflow-hidden" style={{ background: 'oklch(93% 0.004 75)' }}>
                              <div className="w-full" style={{ height: `${pct}%`, background: s.color }} />
                            </div>
                            <div className="text-[9.5px] font-semibold" style={{ color: 'oklch(52% 0.006 75)' }}>
                              {s.letter}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Training focus */}
                    <div className="relative">
                      <button
                        onClick={() => setOpenFocusMenu(openFocusMenu === p.id ? null : p.id)}
                        disabled={busy || p.stage === 'retired'}
                        className="w-full text-left rounded-[6px] px-[10px] py-2 text-[12.5px] font-semibold cursor-pointer flex items-center justify-between gap-[6px] disabled:cursor-not-allowed"
                        style={{ background: 'oklch(97% 0.003 75)', border: '1px solid oklch(88% 0.006 75)', color: 'oklch(28% 0.006 75)' }}
                      >
                        {trainingFocusLabel(p.trainingFocus)}
                        <span className="text-[10px]" style={{ color: 'oklch(55% 0.006 75)' }}>
                          ▾
                        </span>
                      </button>
                      {openFocusMenu === p.id && (
                        <div
                          className="absolute top-[calc(100%+4px)] left-0 right-0 min-w-[170px] bg-white rounded-[6px] z-10 overflow-hidden py-1"
                          style={{ border: '1px solid oklch(88% 0.006 75)', boxShadow: '0 4px 14px rgba(0,0,0,0.1)' }}
                        >
                          {FOCUS_GROUPS.map((grp) => (
                            <div key={grp.label}>
                              <div
                                className="px-[10px] pt-[6px] pb-1 text-[10px] font-bold tracking-[0.5px] uppercase"
                                style={{ color: 'oklch(55% 0.006 75)' }}
                              >
                                {grp.label}
                              </div>
                              {grp.options.map((opt) => (
                                <div
                                  key={opt.label}
                                  onClick={() => handleSelectFocus(p.id, opt.focus)}
                                  className="flex items-center justify-between px-[10px] py-[7px] text-[12.5px] cursor-pointer hover:bg-[oklch(96%_0.003_75)]"
                                  style={{ color: 'oklch(28% 0.006 75)' }}
                                >
                                  {opt.label}
                                  {focusEquals(p.trainingFocus, opt.focus) && (
                                    <span className="font-bold" style={{ color: 'oklch(55% 0.13 240)' }}>
                                      &check;
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-[5px] relative">
                      <button
                        onClick={() => handleEnter(p.id)}
                        disabled={busy || p.stage === 'retired'}
                        className="w-full text-white border-none px-2 py-[6px] rounded-[6px] text-[11px] font-semibold cursor-pointer leading-[1.25] hover:opacity-90 disabled:cursor-not-allowed"
                        style={{ background: 'oklch(20% 0.006 75)' }}
                      >
                        Enter
                      </button>
                      <button
                        onClick={() => setOpenActionsMenu(openActionsMenu === p.id ? null : p.id)}
                        disabled={busy}
                        className="w-full bg-transparent px-2 py-[5px] rounded-[6px] text-[11px] font-semibold cursor-pointer hover:bg-[oklch(96%_0.003_75)] disabled:cursor-not-allowed"
                        style={{ color: 'oklch(45% 0.006 75)', border: '1px solid oklch(88% 0.006 75)' }}
                      >
                        More···
                      </button>
                      {openActionsMenu === p.id && (
                        <div
                          className="absolute top-[calc(100%+4px)] right-0 min-w-[150px] bg-white rounded-[6px] z-10 overflow-hidden py-1"
                          style={{ border: '1px solid oklch(88% 0.006 75)', boxShadow: '0 4px 14px rgba(0,0,0,0.1)' }}
                        >
                          <div
                            onClick={() => handleRelease(p.id, p.name)}
                            className="px-[10px] py-[7px] text-[12.5px] cursor-pointer hover:bg-[oklch(96%_0.003_75)]"
                            style={{ color: 'oklch(55% 0.16 25)' }}
                          >
                            Release player
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {showOpenSlot && (
                <div
                  onClick={handleHire}
                  className="flex items-center justify-center gap-2 rounded-[8px] p-4 text-[13px] font-semibold cursor-pointer hover:bg-[oklch(97%_0.003_75)]"
                  style={{ border: '1.5px dashed oklch(85% 0.006 75)', color: 'oklch(50% 0.006 75)' }}
                >
                  + Open roster slot &mdash; Hire a player
                </div>
              )}
            </div>
          </div>
        )}

        {showEmpty && (
          <div
            className="rounded-[10px] p-[70px_40px] text-center flex flex-col items-center gap-[14px] mt-[10px]"
            style={{ border: '1.5px dashed oklch(85% 0.006 75)' }}
          >
            <div
              className="w-[52px] h-[52px] rounded-[8px] flex items-center justify-center text-[22px] font-bold"
              style={{ background: 'oklch(93% 0.006 75)', color: 'oklch(55% 0.006 75)' }}
            >
              ?
            </div>
            <div className="text-[16px] font-bold" style={{ color: 'oklch(25% 0.006 75)' }}>
              Your roster is empty
            </div>
            <div className="text-[13.5px] max-w-[340px] leading-[1.5]" style={{ color: 'oklch(50% 0.006 75)' }}>
              Hire your first player to start entering tournaments. You have {slotCount} roster slot
              {slotCount === 1 ? '' : 's'} available.
            </div>
            <button
              onClick={handleHire}
              className="mt-[6px] text-white border-none px-[22px] py-[11px] rounded-[6px] text-[14px] font-semibold cursor-pointer hover:opacity-90"
              style={{ background: 'oklch(20% 0.006 75)' }}
            >
              Hire your first player
            </button>
          </div>
        )}

        {players === null && !error && (
          <div className="text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
            Loading roster…
          </div>
        )}
      </div>
    </div>
  );
}
