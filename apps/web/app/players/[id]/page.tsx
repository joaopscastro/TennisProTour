'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  EntitlementDto,
  PlannerWeekDto,
  PlayerDto,
  PlayerMatchesDto,
  PlayerMatchSummaryDto,
  PlayerProfileDto,
  RankingBand,
  RosterDashboardEntryDto,
  TrainingFocus,
  TrainingScheduleWeekDto,
  claimTalentPoolCandidate,
  createDoublesPair,
  fetchEntitlement,
  fetchEntryPlanner,
  fetchPlayer,
  fetchPlayerMatches,
  fetchPlayerProfile,
  fetchRosterDashboard,
  fetchTrainingSchedule,
  setTrainingScheduleEntry,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { EnterTournamentModal } from '../../../components/EnterTournamentModal';
import { Avatar } from '../../../components/ui/Avatar';
import { CelebrationMoment, CelebrationOverlay } from '../../../components/ui/Celebration';
import { AppFrame, Hero, Flag, StatBar, OvrRing, SurfaceBadge } from '../../../components/ui/primitives';
import { FormDots, RankPill, ArchetypeBadge } from '../../../components/ui/PlayerCard';
import {
  WEEKS_PER_SEASON,
  flagFor,
  formatMoney,
  formatScoreline,
  matchRoundLabel,
  stageLabel,
  stageMeta,
  tournamentHistoryResultLabel,
} from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

const JUNIOR_BADGE = { bg: 'oklch(45% 0.1 240 / 0.35)', fg: 'oklch(85% 0.08 240)' };
const ACHIEVEMENT_BADGE = { bg: 'oklch(45% 0.13 80 / 0.3)', fg: 'oklch(85% 0.14 85)' };

const BAND_LABEL: Record<RankingBand, string> = { senior: 'Senior', u14: 'U14', u16: 'U16', u18: 'U18' };

// Same focus-picker reference data / helpers as the roster dashboard's
// "Set focus" dropdown (app/page.tsx) — deliberately not extracted to
// a shared module, matching this codebase's existing tolerance for
// small duplicated reference data per screen (e.g. SURFACE_COLOR is
// already repeated across several pages).
const FOCUS_GROUPS: Array<{ label: string; options: Array<{ label: string; focus: TrainingFocus }> }> = [
  {
    label: 'Surface',
    options: (['clay', 'grass', 'hard', 'indoor'] as const).map((surface) => ({
      label: surface[0].toUpperCase() + surface.slice(1),
      focus: { kind: 'surface', surface },
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

function trainingFocusLabel(focus: TrainingFocus | null): string {
  if (!focus) return 'No focus';
  if (focus.kind === 'surface') return focus.surface[0].toUpperCase() + focus.surface.slice(1);
  return focus.attribute[0].toUpperCase() + focus.attribute.slice(1);
}

function focusEquals(a: TrainingFocus | null, b: TrainingFocus): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'surface' && b.kind === 'surface' ? a.surface === b.surface : (a as { attribute: string }).attribute === (b as { attribute: string }).attribute;
}

function NetDivider({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0 my-[2px] ${className ?? 'mb-[18px]'}`}>
      <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'var(--gc-line)' }} />
      <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'var(--gc-line)' }} />
      <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-bold tracking-[0.2px] mb-[10px]" style={{ color: 'var(--gc-ink)' }}>
      {children}
    </div>
  );
}

function overallOf(player: PlayerDto): number {
  const { technical, physical, mental } = player.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

function AttributeGroup({ label, entries }: { label: string; entries: Array<[string, number]> }) {
  return (
    <div>
      <div className="text-[10.5px] font-bold tracking-[0.5px] uppercase mb-[8px]" style={{ color: 'var(--gc-ink-mute)' }}>
        {label}
      </div>
      <div className="flex flex-col gap-[7px]">
        {entries.map(([name, value]) => (
          <StatBar key={name} label={name} value={value} />
        ))}
      </div>
    </div>
  );
}

type AttributeProjection = { current: number; projected: number; mature: boolean };

/** A stat bar with a translucent "ghost cap" extension from the current
 * value out to the scout's projected ceiling — the projected headroom is
 * shown, never a hard promise. `mature` attributes (mental) have no
 * headroom, so they render as a plain solid bar. Respects
 * prefers-reduced-motion via the shared gc-bar transition (CSS-only). */
function GhostStatBar({ label, proj }: { label: string; proj: AttributeProjection }) {
  const currentPct = Math.max(0, Math.min(100, proj.current));
  const projectedPct = Math.max(0, Math.min(100, proj.projected));
  const ghostPct = Math.max(0, projectedPct - currentPct);
  const hue = 30 + (Math.min(100, proj.current) / 100) * 100;
  const c = `oklch(70% 0.15 ${hue})`;
  const hasHeadroom = !proj.mature && ghostPct >= 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 68, fontSize: 11.5, color: 'var(--gc-ink-mute)', textTransform: 'capitalize' }}>{label}</span>
      <div className="gc-bar" style={{ flex: 1, position: 'relative', display: 'flex' }}>
        <i style={{ width: `${currentPct}%`, background: `linear-gradient(90deg, ${c}, color-mix(in oklch, ${c}, white 18%))` }} />
        {hasHeadroom && (
          <i
            title="Projected headroom (scout's read)"
            style={{
              width: `${ghostPct}%`,
              background: `repeating-linear-gradient(135deg, color-mix(in oklch, ${c}, transparent 62%) 0 5px, color-mix(in oklch, ${c}, transparent 82%) 5px 10px)`,
            }}
          />
        )}
      </div>
      <span style={{ width: 26, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(proj.current)}</span>
      <span style={{ width: 34, textAlign: 'right', fontSize: 11, fontWeight: 600, color: hasHeadroom ? 'var(--gc-ink-faint)' : 'transparent', fontVariantNumeric: 'tabular-nums' }}>
        {hasHeadroom ? `~${Math.round(proj.projected)}` : '—'}
      </span>
    </div>
  );
}

function GhostAttributeGroup({ label, entries }: { label: string; entries: Array<[string, AttributeProjection]> }) {
  return (
    <div>
      <div className="text-[10.5px] font-bold tracking-[0.5px] uppercase mb-[8px]" style={{ color: 'var(--gc-ink-mute)' }}>
        {label}
      </div>
      <div className="flex flex-col gap-[7px]">
        {entries.map(([name, proj]) => (
          <GhostStatBar key={name} label={name} proj={proj} />
        ))}
      </div>
    </div>
  );
}

const GROWTH_COPY: Record<'slow' | 'steady' | 'rapid', string> = {
  slow: 'Slow burner',
  steady: 'Steady developer',
  rapid: 'Rapid developer',
};

const TIER_COPY: Record<'limited' | 'promising' | 'high' | 'elite', { label: string; color: string }> = {
  limited: { label: 'Limited', color: 'var(--gc-ink-mute)' },
  promising: { label: 'Promising', color: 'oklch(68% 0.13 145)' },
  high: { label: 'High', color: 'oklch(70% 0.15 250)' },
  elite: { label: 'Elite', color: 'oklch(72% 0.17 300)' },
};

function confidenceCopy(confidence: number, resolved: boolean): { label: string; note: string } {
  if (resolved) return { label: 'Confirmed', note: "The scout has seen enough — this read is who they are." };
  if (confidence >= 0.55) return { label: 'Firming up', note: 'The picture is coming into focus as they mature.' };
  if (confidence >= 0.25) return { label: 'Narrowing', note: "Early signs, but there's still real spread in this read." };
  return { label: 'Speculative', note: "A raw prospect — this projection is a lean, not a promise." };
}

/** One decided match on the profile's Matches strip — win/loss chip,
 * opponent (linkable — every player has a profile), tennis scoreline. */
function MatchResultRow({ m }: { m: PlayerMatchSummaryDto }) {
  const won = m.result === 'win';
  const roundLabel = matchRoundLabel(m.drawSize / 2 ** m.roundNumber);
  return (
    <div className="flex items-center justify-between gap-[12px] gc-card rounded-[8px] px-[13px] py-[10px]" style={{ border: '1px solid var(--gc-line)' }}>
      <div className="flex items-center gap-[11px] min-w-0">
        <div
          className="flex-none w-[24px] h-[24px] rounded-[5px] grid place-items-center text-[11px] font-extrabold text-white"
          style={{ background: won ? 'oklch(58% 0.15 145)' : 'oklch(52% 0.16 25)' }}
          title={won ? 'Win' : 'Loss'}
        >
          {won ? 'W' : 'L'}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold flex items-center gap-[6px] min-w-0">
            <span style={{ color: 'var(--gc-ink-mute)' }}>vs</span>
            <Flag code={m.opponentNationality} size={13} />
            <Link href={`/players/${m.opponentId}`} className="no-underline hover:underline overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: 'var(--gc-ink)' }}>
              {m.opponentName}
            </Link>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--gc-ink-mute)' }}>
            {roundLabel} · {m.tournamentName}
          </div>
        </div>
      </div>
      <div className="flex-none text-[12.5px] font-semibold [font-variant-numeric:tabular-nums]" style={{ color: won ? 'oklch(72% 0.13 145)' : 'var(--gc-ink-mute)' }}>
        {m.setScores ? formatScoreline(m.setScores, won) : ''}
      </div>
    </div>
  );
}

/** Which bands to show in "current standing" — senior always; a junior
 * band otherwise only when it's this player's live band right now, or
 * it's "historically relevant" (a real ranked position or a peak ever
 * recorded there) — both facts already present on the DTO, no
 * additional backend field needed for this rule. */
function visibleCurrentBands(profile: PlayerProfileDto): RankingBand[] {
  const bands: RankingBand[] = ['senior'];
  for (const band of ['u14', 'u16', 'u18'] as const) {
    const current = profile.currentRankings.find((r) => r.band === band);
    const hasPeak = profile.peakRankings.some((p) => p.band === band);
    if (band === profile.currentEligibleBand || (current && current.rank !== null) || hasPeak) {
      bands.push(band);
    }
  }
  return bands;
}

export default function PlayerProfilePage() {
  const params = useParams<{ id: string }>();
  const playerId = params.id;
  const [profile, setProfile] = useState<PlayerProfileDto | null>(null);
  const [player, setPlayer] = useState<PlayerDto | null>(null);
  const [matches, setMatches] = useState<PlayerMatchesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);

  // Free-agent signing (managerId null) — a manager can sign any
  // browsable free agent straight from their profile, same flow the
  // Scouting page uses. Dev manager defaults to seed-m1 (Clerk fills the
  // real one in production).
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const devManagerId = process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1';

  // Doubles partner invitation (P7a): from a managed player owned by a
  // DIFFERENT manager, invite them to be one of my players' doubles
  // partner. Pull-based — the target manager accepts from their own board.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteRoster, setInviteRoster] = useState<RosterDashboardEntryDto[] | null>(null);
  const [inviteInitiator, setInviteInitiator] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  const canInvite = profile && profile.managerId !== null && profile.managerId !== devManagerId && profile.stage !== 'retired';

  async function openInvite() {
    setInviteError(null);
    setInviteOpen(true);
    try {
      setInviteRoster(await fetchRosterDashboard(devManagerId));
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitInvite() {
    if (!inviteInitiator) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const pair = await createDoublesPair(inviteInitiator, playerId, devManagerId);
      setInviteOpen(false);
      setInviteNotice(pair.status === 'active' ? 'Doubles pair formed.' : 'Invitation sent.');
      const fresh = await fetchPlayerProfile(playerId);
      setProfile(fresh);
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setInviteBusy(false);
    }
  }

  // Schedule section (Step 2): two existing, separate backend reads —
  // the tournament entry planner and the new training-schedule planner
  // — combined into one per-week timeline here on the frontend, not a
  // new backend concept (see PlayerTrainingScheduleQuery's own doc
  // comment). Both default to the same DEFAULT_PLANNER_WEEKS window
  // starting at the world's current week, so they line up week-for-week.
  const [plannerWeeks, setPlannerWeeks] = useState<PlannerWeekDto[] | null>(null);
  const [scheduleWeeks, setScheduleWeeks] = useState<TrainingScheduleWeekDto[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [openFocusMenuWeek, setOpenFocusMenuWeek] = useState<number | null>(null);
  const [enterModalWeek, setEnterModalWeek] = useState<number | null>(null);
  const [busyWeek, setBusyWeek] = useState<number | null>(null);

  useEffect(() => {
    fetchPlayerProfile(playerId)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetchPlayer(playerId)
      .then(setPlayer)
      .catch(() => setPlayer(null));
    fetchPlayerMatches(playerId)
      .then(setMatches)
      .catch(() => setMatches(null));
  }, [playerId]);

  // P5 resolution moment (GC-16 reuse): when one of YOUR OWN prospects'
  // scouting read has resolved (age-fuzz collapsed onto the truth) to a
  // high/elite ceiling, the bet paid off — fire it once. Deduped in
  // localStorage per player so revisiting the profile doesn't re-fire it,
  // and gated to the owning manager (browsing a random resolved free
  // agent shouldn't celebrate someone else's find). No new backend
  // concept — it's derived entirely from the profile's own projection.
  useEffect(() => {
    if (!profile?.potential) return;
    const p = profile.potential;
    if (!p.resolved || (p.tier !== 'elite' && p.tier !== 'high')) return;
    if (profile.managerId !== devManagerId) return;
    if (typeof window === 'undefined') return;
    const key = `gc-potential-seen:${profile.playerId}`;
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, String(p.projectedOverallMid));
    setCelebrations([
      {
        kind: 'potential',
        playerId: profile.playerId,
        playerName: profile.name,
        nationality: profile.nationality,
        projected: p.projectedOverallMid,
        tier: p.tier,
      },
    ]);
  }, [profile, devManagerId]);

  const isFreeAgent = profile?.managerId === null && profile?.stage !== 'retired';

  useEffect(() => {
    if (isFreeAgent) {
      fetchEntitlement(devManagerId)
        .then(setEntitlement)
        .catch(() => setEntitlement(null));
    }
  }, [isFreeAgent, devManagerId]);

  async function handleSign() {
    setSigning(true);
    setSignError(null);
    try {
      await claimTalentPoolCandidate(playerId, devManagerId);
      // Reload the profile: it now has an owner, flipping the page from
      // "Sign this free agent" to a normal managed profile.
      const [p, m] = await Promise.all([fetchPlayerProfile(playerId), fetchPlayer(playerId)]);
      setProfile(p);
      setPlayer(m);
      loadSchedule();
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  }

  const loadSchedule = useCallback(() => {
    Promise.all([fetchEntryPlanner(playerId), fetchTrainingSchedule(playerId)])
      .then(([planner, schedule]) => {
        setPlannerWeeks(planner);
        setScheduleWeeks(schedule);
      })
      .catch((e) => setScheduleError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  const scheduleByWeekKey = useMemo(() => {
    const map = new Map<string, TrainingScheduleWeekDto>();
    scheduleWeeks?.forEach((w) => map.set(`${w.week.season}-${w.week.week}`, w));
    return map;
  }, [scheduleWeeks]);

  async function handleSelectFocus(weekIndex: number, week: { season: number; week: number }, focus: TrainingFocus) {
    if (!profile?.managerId) return;
    setOpenFocusMenuWeek(null);
    setBusyWeek(weekIndex);
    try {
      await setTrainingScheduleEntry(playerId, focus, week, profile.managerId);
      loadSchedule();
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyWeek(null);
    }
  }

  const currentBands = useMemo(() => (profile ? visibleCurrentBands(profile) : []), [profile]);

  if (error) {
    return (
      <AppFrame>
        <Sidebar active="roster" />
        <div className="flex-1 p-8">
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)' }}>
            {error}
          </div>
        </div>
      </AppFrame>
    );
  }

  if (!profile) {
    return (
      <AppFrame>
        <Sidebar active="roster" />
        <div className="flex-1 p-8 text-[13.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
          Loading player…
        </div>
      </AppFrame>
    );
  }

  const stg = stageMeta(profile.stage);
  const heroSurface = profile.tournamentHistory[0]?.surface ?? null;
  const titleCount = profile.titles.length;
  const topRank = profile.currentRankings.reduce<number | null>(
    (best, r) => (r.rank !== null && (best === null || r.rank < best) ? r.rank : best),
    null,
  );
  const topRankEntry =
    profile.currentRankings
      .filter((r) => r.rank !== null)
      .sort((a, b) => (a.rank as number) - (b.rank as number))[0] ?? null;
  const heroTagline =
    titleCount > 0
      ? `${titleCount} career ${titleCount === 1 ? 'title' : 'titles'} and counting.`
      : topRank !== null && topRank <= 32
      ? `Climbing fast — world #${topRank} and hungry for a first trophy.`
      : 'Chasing a breakthrough result on tour.';

  return (
    <AppFrame>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}
      <Sidebar active="roster" />

      <div className="flex-1 p-8 max-w-[900px] min-w-0">
        <Link href="/" className="text-[13px] font-semibold no-underline hover:underline" style={{ color: 'var(--gc-ball)' }}>
          ← Back to roster
        </Link>

        {/* Header */}
        <div className="mt-[14px] mb-[24px]">
          <Hero surface={heroSurface} minHeight={168}>
            <div className="flex items-end gap-[20px]">
              <Avatar id={profile.playerId} name={profile.name} size={104} ring />
              <div className="min-w-0 pb-[2px]">
                <div className="flex items-center gap-[10px] flex-wrap">
                  <div className="text-[30px] font-extrabold tracking-[-0.4px] text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
                    {profile.name}
                  </div>
                  <div
                    className="inline-block px-[9px] py-[3px] rounded-[4px] text-[11px] font-bold tracking-[0.3px]"
                    style={{ background: stg.bg, color: stg.fg }}
                  >
                    {stageLabel(profile.stage)}
                  </div>
                </div>
                <div className="text-[14px] mt-[7px] flex items-center gap-[8px] text-white/85">
                  <Flag code={profile.nationality} size={16} />
                  <span className="font-semibold">{profile.nationality}</span>
                  <span className="text-white/45">·</span>
                  <span>Age {(profile.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)}</span>
                </div>
                {profile.doublesPartner && (
                  <div className="text-[13px] mt-[8px] flex items-center gap-[7px] text-white/90">
                    <span
                      className="inline-block px-[7px] py-[2px] rounded-[4px] text-[9.5px] font-extrabold tracking-[0.5px] uppercase"
                      style={{
                        background: profile.doublesPartner.status === 'active' ? 'oklch(45% 0.13 150 / 0.45)' : 'oklch(45% 0.1 240 / 0.45)',
                        color: profile.doublesPartner.status === 'active' ? 'oklch(88% 0.13 150)' : 'oklch(86% 0.1 240)',
                      }}
                    >
                      {profile.doublesPartner.status === 'active' ? 'Doubles partner' : 'Pending partner'}
                    </span>
                    <Link
                      href={`/players/${profile.doublesPartner.playerId}`}
                      className="no-underline hover:underline"
                      style={{ color: 'white', display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Flag code={profile.doublesPartner.nationality} size={14} />
                      <span className="font-bold">{profile.doublesPartner.name}</span>
                    </Link>
                    {profile.doublesPartner.status === 'active' && (
                      <span className="text-white/60">· {profile.doublesPartner.chemistry}% chemistry</span>
                    )}
                  </div>
                )}
                <div className="mt-[11px] flex items-center gap-[16px] flex-wrap">
                  <div style={{ padding: '5px 11px', borderRadius: 8, background: 'oklch(100% 0 0 / 0.12)', border: '1px solid oklch(100% 0 0 / 0.18)' }}>
                    <RankPill
                      rank={topRankEntry ? topRankEntry.rank : null}
                      points={topRankEntry?.totalPoints}
                      bandLabel={topRankEntry ? BAND_LABEL[topRankEntry.band] : undefined}
                    />
                  </div>
                  {profile.careerPrizeMoney > 0 && (
                    <div
                      className="flex items-center gap-[6px]"
                      style={{ padding: '5px 11px', borderRadius: 8, background: 'oklch(100% 0 0 / 0.12)', border: '1px solid oklch(100% 0 0 / 0.18)' }}
                      title={`${formatMoney(profile.seasonPrizeMoney)} this season`}
                    >
                      <span className="text-[9.5px] font-extrabold tracking-[0.5px] uppercase text-white/55">Career earnings</span>
                      <span className="text-[13px] font-bold text-white">{formatMoney(profile.careerPrizeMoney)}</span>
                    </div>
                  )}
                  {profile.tournamentHistory.some((h) => h.hasStarted && (h.won || h.eliminated)) && (
                    <div className="flex items-center gap-[8px]">
                      <span className="text-[9.5px] font-extrabold tracking-[0.5px] uppercase text-white/55">Form</span>
                      <FormDots history={profile.tournamentHistory} />
                    </div>
                  )}
                  {/* GC-10 archetype — degrades to nothing until the backend exposes it */}
                  <ArchetypeBadge archetype={(profile as { archetype?: string | null }).archetype ?? null} />
                </div>
                <div className="text-[13px] mt-[10px] text-white/70 italic">{heroTagline}</div>
              </div>
            </div>
          </Hero>
        </div>

        {/* Free-agent signing — any browsable free agent can be signed
            straight from their profile (same flow as Scouting). */}
        {isFreeAgent && (
          <div
            className="mb-[24px] rounded-[10px] p-[16px] flex items-center justify-between gap-[16px] flex-wrap"
            style={{ background: 'linear-gradient(180deg, oklch(32% 0.09 265), oklch(24% 0.06 265))', border: '1px solid oklch(55% 0.11 265 / 0.4)' }}
          >
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold tracking-[0.6px] uppercase" style={{ color: 'oklch(82% 0.09 265)' }}>Free agent</div>
              <div className="text-[14px] font-semibold text-white mt-[3px]">
                Unsigned — no manager. Read the attributes, weigh the risk, and sign before a rival does.
              </div>
              {entitlement && (
                <div className="text-[12px] mt-[4px] text-white/70">
                  Your XP: <span className="font-bold" style={{ color: 'var(--gc-ball)' }}>{entitlement.xpBalance.toLocaleString()}</span>
                </div>
              )}
              {signError && <div className="text-[12px] mt-[4px]" style={{ color: 'oklch(80% 0.13 25)' }}>{signError}</div>}
            </div>
            <button
              onClick={handleSign}
              disabled={signing}
              className="flex-none rounded-[8px] px-[22px] py-[11px] text-[13.5px] font-extrabold cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              style={{ background: 'linear-gradient(180deg, var(--gc-ball), var(--gc-ball-d))', color: 'oklch(22% 0.05 265)', border: '1px solid oklch(100% 0 0 / 0.2)' }}
            >
              {signing ? 'Signing…' : 'Sign this free agent'}
            </button>
          </div>
        )}

        {/* Doubles partner invitation (P7a) — only for a managed player
            owned by a DIFFERENT manager. Pull-based: the target manager
            accepts from their own board. */}
        {canInvite && (
          <div
            className="mb-[24px] rounded-[10px] p-[16px]"
            style={{ background: 'linear-gradient(180deg, oklch(32% 0.06 150), oklch(24% 0.04 150))', border: '1px solid oklch(55% 0.1 150 / 0.4)' }}
          >
            {!inviteOpen ? (
              <div className="flex items-center justify-between gap-[16px] flex-wrap">
                <div className="min-w-0">
                  <div className="text-[11px] font-extrabold tracking-[0.6px] uppercase" style={{ color: 'oklch(82% 0.09 150)' }}>Doubles</div>
                  <div className="text-[14px] font-semibold text-white mt-[3px]">
                    Invite this player to be one of your players&apos; doubles partner.
                  </div>
                </div>
                <button
                  onClick={openInvite}
                  className="flex-none rounded-[8px] px-[18px] py-[10px] text-[13px] font-extrabold cursor-pointer"
                  style={{ background: 'linear-gradient(180deg, var(--gc-ball), var(--gc-ball-d))', color: 'oklch(22% 0.05 150)', border: '1px solid oklch(100% 0 0 / 0.2)' }}
                >
                  Invite as partner
                </button>
              </div>
            ) : (
              <div>
                <div className="text-[11px] font-extrabold tracking-[0.6px] uppercase" style={{ color: 'oklch(82% 0.09 150)' }}>Pick your initiating player</div>
                <div className="flex items-center gap-[10px] mt-[10px] flex-wrap">
                  <select
                    className="gc-select"
                    value={inviteInitiator ?? ''}
                    onChange={(e) => setInviteInitiator(e.target.value || null)}
                    style={{ padding: '8px 12px', fontSize: 13 }}
                  >
                    <option value="">Select a player…</option>
                    {(inviteRoster ?? []).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={submitInvite}
                    disabled={!inviteInitiator || inviteBusy}
                    className="rounded-[8px] px-[16px] py-[9px] text-[13px] font-extrabold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(180deg, var(--gc-ball), var(--gc-ball-d))', color: 'oklch(22% 0.05 150)', border: '1px solid oklch(100% 0 0 / 0.2)' }}
                  >
                    {inviteBusy ? 'Sending…' : 'Send invitation'}
                  </button>
                  <button onClick={() => setInviteOpen(false)} className="text-[12px] cursor-pointer" style={{ background: 'none', border: 'none', color: 'white', opacity: 0.7 }}>
                    Cancel
                  </button>
                </div>
                {inviteError && <div className="text-[12px] mt-[8px]" style={{ color: 'oklch(80% 0.13 25)' }}>{inviteError}</div>}
              </div>
            )}
            {inviteNotice && <div className="text-[12px] mt-[8px]" style={{ color: 'oklch(82% 0.11 150)' }}>{inviteNotice}</div>}
          </div>
        )}

        {/* Latest results + next match — the profile's most immediate,
            "what just happened / what's next" strip. No per-match timer
            by design (see DrizzlePlayerMatchesQuery's doc comment). */}
        {matches && (matches.recent.length > 0 || matches.next) && (
          <div className="mb-[24px]">
            <SectionLabel>Matches</SectionLabel>
            {matches.next && (
              <div
                className="mb-[10px] rounded-[10px] p-[14px] flex items-center justify-between gap-[14px]"
                style={{ background: 'linear-gradient(180deg, oklch(30% 0.05 200), oklch(23% 0.03 200))', border: '1px solid oklch(50% 0.08 200 / 0.4)' }}
              >
                <div className="flex items-center gap-[12px] min-w-0">
                  <Avatar id={matches.next.opponentId} name={matches.next.opponentName} size={44} />
                  <div className="min-w-0">
                    <div className="text-[10px] font-extrabold tracking-[0.6px] uppercase" style={{ color: 'oklch(80% 0.09 200)' }}>
                      Next up · {matchRoundLabel(matches.next.drawSize / 2 ** matches.next.roundNumber)}
                    </div>
                    <div className="text-[14px] font-semibold text-white mt-[2px] flex items-center gap-[7px]">
                      vs <Flag code={matches.next.opponentNationality} size={14} />
                      <Link href={`/players/${matches.next.opponentId}`} className="no-underline hover:underline" style={{ color: 'white' }}>
                        {matches.next.opponentName}
                      </Link>
                    </div>
                    <div className="text-[11.5px] text-white/65 mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {matches.next.tournamentName}
                    </div>
                  </div>
                </div>
                <div className="flex-none text-right">
                  <SurfaceBadge surface={matches.next.surface} />
                  <div className="text-[10.5px] text-white/55 mt-[6px] italic">Awaiting simulation</div>
                </div>
              </div>
            )}
            {matches.recent.length > 0 && (
              <div className="flex flex-col gap-[6px]">
                {matches.recent.map((m) => (
                  <MatchResultRow key={`${m.tournamentId}-${m.roundNumber}`} m={m} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Attributes — every player is fully inspectable (this is where
            a scout studies a free agent's observable ability). The solid
            bar is observable ability today; the hatched extension is the
            scout's PROJECTED headroom (P5) — an age-fuzzed, profile-only
            read derived server-side from the hidden ceiling, never the
            raw number, and shown nowhere but here (see docs/CLAUDE.md). */}
        {player && (
          <div className="mb-[24px]">
            <SectionLabel>Attributes &amp; potential</SectionLabel>
            <div className="gc-card rounded-[10px] p-[16px]" style={{ border: '1px solid var(--gc-line)' }}>
              <div className="flex items-center gap-[14px] mb-[14px]">
                <OvrRing value={overallOf(player)} size={52} />
                <div>
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase" style={{ color: 'var(--gc-ink-mute)' }}>Overall</div>
                  <div className="text-[12px]" style={{ color: 'var(--gc-ink-faint)' }}>Observable ability today — not a ceiling.</div>
                </div>
              </div>
              {profile?.potential && (() => {
                const p = profile.potential;
                const tier = TIER_COPY[p.tier];
                const conf = confidenceCopy(p.confidence, p.resolved);
                const band =
                  p.projectedOverallLow === p.projectedOverallHigh
                    ? `${p.projectedOverallMid}`
                    : `${p.projectedOverallLow}–${p.projectedOverallHigh}`;
                return (
                  <div
                    className="rounded-[9px] p-[13px] mb-[16px]"
                    style={{ background: 'color-mix(in oklch, var(--gc-surface), transparent 20%)', border: '1px dashed var(--gc-line)' }}
                  >
                    <div className="flex items-center justify-between flex-wrap gap-[10px]">
                      <div>
                        <div className="text-[10.5px] font-bold tracking-[0.5px] uppercase mb-[3px]" style={{ color: 'var(--gc-ink-mute)' }}>
                          Scout&apos;s projection
                        </div>
                        <div className="flex items-baseline gap-[8px]">
                          <span className="text-[22px] font-extrabold tracking-[-0.5px]" style={{ color: 'var(--gc-ink)' }}>~{band}</span>
                          <span className="text-[12px] font-bold px-[7px] py-[2px] rounded-[4px]" style={{ color: tier.color, background: `color-mix(in oklch, ${tier.color}, transparent 86%)` }}>
                            {tier.label} ceiling
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10.5px] font-bold tracking-[0.5px] uppercase mb-[3px]" style={{ color: 'var(--gc-ink-mute)' }}>Developed</div>
                        <div className="text-[22px] font-extrabold tabular-nums" style={{ color: 'var(--gc-ink)' }}>{p.developmentPercent}%</div>
                        <div className="text-[11px]" style={{ color: 'var(--gc-ink-faint)' }}>{GROWTH_COPY[p.growth]}</div>
                      </div>
                    </div>
                    <div className="mt-[10px] pt-[9px]" style={{ borderTop: '1px solid var(--gc-line)' }}>
                      <div className="flex items-center gap-[8px] mb-[4px]">
                        <span className="text-[11px] font-bold" style={{ color: 'var(--gc-ink-dim)' }}>Scout confidence: {conf.label}</span>
                        <div className="gc-bar" style={{ flex: 1, maxWidth: 160 }}>
                          <i style={{ width: `${Math.round(p.confidence * 100)}%`, background: 'linear-gradient(90deg, var(--gc-ink-mute), var(--gc-ink-dim))' }} />
                        </div>
                      </div>
                      <div className="text-[11.5px]" style={{ color: 'var(--gc-ink-faint)' }}>{conf.note}</div>
                    </div>
                  </div>
                );
              })()}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-[24px] gap-y-[16px]">
                {profile?.potential ? (
                  <>
                    <GhostAttributeGroup label="Technical" entries={Object.entries(profile.potential.attributes.technical)} />
                    <GhostAttributeGroup label="Physical" entries={Object.entries(profile.potential.attributes.physical)} />
                    <GhostAttributeGroup label="Mental" entries={Object.entries(profile.potential.attributes.mental)} />
                  </>
                ) : (
                  <>
                    <AttributeGroup label="Technical" entries={Object.entries(player.attributes.technical)} />
                    <AttributeGroup label="Physical" entries={Object.entries(player.attributes.physical)} />
                    <AttributeGroup label="Mental" entries={Object.entries(player.attributes.mental)} />
                    <AttributeGroup label="Doubles" entries={[['doubles', player.attributes.doubles]]} />
                  </>
                )}
                <AttributeGroup label="Surface affinity" entries={Object.entries(player.attributes.surfaceAffinities)} />
              </div>
            </div>
          </div>
        )}
        <SectionLabel>Current standing</SectionLabel>
        <div className="flex gap-[10px] mb-[22px]">
          {currentBands.map((band) => {
            const entry = profile.currentRankings.find((r) => r.band === band)!;
            return (
              <div key={band} className="flex-1 gc-card rounded-[8px] p-[14px]" style={{ border: '1px solid var(--gc-line)' }}>
                <div className="flex items-center gap-[6px] mb-[6px]">
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase" style={{ color: 'var(--gc-ink-mute)' }}>
                    {BAND_LABEL[band]}
                  </div>
                  {band !== 'senior' && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px]"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {band}
                    </div>
                  )}
                </div>
                <div className="text-[24px] font-bold [font-variant-numeric:tabular-nums]">
                  {entry.rank !== null ? `#${entry.rank}` : '—'}
                </div>
                <div className="text-[11.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
                  {entry.totalPoints} pts
                </div>
              </div>
            );
          })}
        </div>

        {/* Peak standing */}
        <SectionLabel>Peak standing</SectionLabel>
        {profile.peakRankings.length === 0 ? (
          <div className="text-[13px] mb-[22px]" style={{ color: 'var(--gc-ink-mute)' }}>
            No peak ranking yet.
          </div>
        ) : (
          <div className="flex gap-[10px] mb-[22px]">
            {profile.peakRankings.map((p) => (
              <div
                key={p.band}
                className="flex-1 rounded-[8px] p-[14px]"
                style={{ background: 'linear-gradient(180deg, oklch(30% 0.06 85), oklch(22% 0.04 85))', border: '1px solid oklch(50% 0.08 85 / 0.4)' }}
              >
                <div className="flex items-center gap-[6px] mb-[6px]">
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase" style={{ color: 'var(--gc-gold)' }}>
                    Peak · {BAND_LABEL[p.band]}
                  </div>
                </div>
                <div className="text-[24px] font-bold [font-variant-numeric:tabular-nums]" style={{ color: 'var(--gc-gold)' }}>
                  {p.peakPoints} pts
                </div>
                <div className="text-[11.5px]" style={{ color: 'var(--gc-gold)' }}>
                  Peaked Season {p.peakAsOfWeek.season}, Week {p.peakAsOfWeek.week}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Titles */}
        <SectionLabel>Titles</SectionLabel>
        {profile.titles.length === 0 ? (
          <div className="text-[13px] mb-[22px]" style={{ color: 'var(--gc-ink-mute)' }}>
            No titles yet.
          </div>
        ) : (
          <div className="flex flex-col gap-[8px] mb-[22px]">
            {profile.titles.map((title) => (
              <Link
                key={title.tournamentId}
                href={`/tournaments/${title.tournamentId}`}
                className="flex items-center justify-between rounded-[8px] px-[14px] py-[11px] no-underline hover:opacity-90"
                style={{ background: ACHIEVEMENT_BADGE.bg, color: ACHIEVEMENT_BADGE.fg }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <span className="text-[16px]">🏆</span>
                  <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">{title.name}</div>
                  {title.ageBand && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px] flex-none"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {title.ageBand}
                    </div>
                  )}
                </div>
                <div className="text-[11.5px] font-semibold flex-none">
                  {title.tier} · S{title.weekEarned.season} W{title.weekEarned.week}
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Doubles (P7c + junior doubles) — peak rankings + pair titles. */}
        {(profile.doublesPeaks.length > 0 || profile.doublesTitles.length > 0) && (
          <>
            <SectionLabel>Doubles</SectionLabel>
            {profile.doublesPeaks.map((peak) => (
              <div
                key={peak.band}
                className="flex items-center justify-between rounded-[8px] px-[14px] py-[11px] mb-[8px]"
                style={{ background: 'linear-gradient(180deg, oklch(30% 0.06 150), oklch(22% 0.04 150))', border: '1px solid oklch(50% 0.08 150 / 0.4)' }}
              >
                <div className="flex items-center gap-[8px]">
                  <span className="text-[16px]">🎾</span>
                  <div className="font-semibold text-[13.5px]" style={{ color: 'oklch(85% 0.11 150)' }}>Doubles peak · {BAND_LABEL[peak.band]}</div>
                </div>
                <div className="text-right">
                  <div className="text-[18px] font-bold [font-variant-numeric:tabular-nums]" style={{ color: 'oklch(85% 0.11 150)' }}>
                    {peak.peakPoints} pts
                  </div>
                  <div className="text-[11px]" style={{ color: 'oklch(85% 0.11 150 / 0.7)' }}>
                    S{peak.peakAsOfWeek.season} W{peak.peakAsOfWeek.week}
                  </div>
                </div>
              </div>
            ))}
            {profile.doublesTitles.map((title) => (
              <Link
                key={title.tournamentId}
                href={`/players/${title.partnerId}`}
                className="flex items-center justify-between rounded-[8px] px-[14px] py-[11px] mb-[8px] no-underline hover:opacity-90"
                style={{ background: ACHIEVEMENT_BADGE.bg, color: ACHIEVEMENT_BADGE.fg }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <span className="text-[16px]">🏆</span>
                  <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">
                    Doubles title with <Flag code={title.partnerNationality} size={13} /> {title.partnerName}
                  </div>
                </div>
                <div className="text-[11.5px] font-semibold flex-none">
                  {title.tier} · S{title.weekEarned.season} W{title.weekEarned.week}
                </div>
              </Link>
            ))}
          </>
        )}

        <NetDivider />

        {/* Schedule — combined frontend view over two existing, separate
            backend reads (tournament entry planner + training schedule),
            not a new backend concept. Same lookahead window as the
            tournament planner elsewhere in this app. */}
        <SectionLabel>Schedule</SectionLabel>
        {!profile.managerId && (
          <div className="text-[12px] mb-[10px]" style={{ color: 'var(--gc-ink-mute)' }}>
            Free agent — no manager to schedule tournaments or training for.
          </div>
        )}
        {scheduleError && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)' }}>
            {scheduleError}
          </div>
        )}
        {plannerWeeks === null && !scheduleError && (
          <div className="text-[13px] mb-[22px]" style={{ color: 'var(--gc-ink-mute)' }}>
            Loading schedule…
          </div>
        )}
        {plannerWeeks && (
          <div className="flex flex-col gap-[8px] mb-[22px]">
            {plannerWeeks.map((pw, i) => {
              const weekKey = `${pw.week.season}-${pw.week.week}`;
              const sw = scheduleByWeekKey.get(weekKey);
              const busy = busyWeek === i;
              return (
                <div
                  key={weekKey}
                  className="flex items-center gap-[12px] gc-card gc-card--hover rounded-[8px] px-[14px] py-[11px]"
                  style={{ border: '1px solid var(--gc-line)', opacity: busy ? 0.6 : 1 }}
                >
                  <div className="text-[11.5px] font-semibold flex-none" style={{ color: 'var(--gc-ink-mute)', width: 76 }}>
                    S{pw.week.season} W{pw.week.week}
                  </div>

                  {/* Tournament entry — reuses the existing registration
                      flow (EnterTournamentModal) rather than a new one. */}
                  <div className="flex-1 min-w-0">
                    {pw.entries.length > 0 ? (
                      <div className="flex flex-col gap-[3px]">
                        {pw.entries.map((t) => (
                          <Link
                            key={t.id}
                            href={`/tournaments/${t.id}`}
                            className="text-[12.5px] font-semibold no-underline hover:underline overflow-hidden text-ellipsis whitespace-nowrap block"
                            style={{ color: 'var(--gc-ink)' }}
                          >
                            {t.name}
                          </Link>
                        ))}
                      </div>
                    ) : profile.managerId ? (
                      <button
                        onClick={() => setEnterModalWeek(i)}
                        disabled={busy}
                        className="text-[11.5px] font-semibold cursor-pointer rounded-[5px] px-[8px] py-[4px] disabled:cursor-not-allowed"
                        style={{ border: '1px solid var(--gc-line)', color: 'var(--gc-ink-mute)' }}
                      >
                        + Enter tournament
                      </button>
                    ) : (
                      <span className="text-[11.5px]" style={{ color: 'var(--gc-ink-faint)' }}>
                        —
                      </span>
                    )}
                  </div>

                  {/* Training focus — resolved from the training
                      schedule; editable inline via the same dropdown
                      shape the roster dashboard already uses. */}
                  <div className="relative flex-none" style={{ width: 150 }}>
                    <button
                      onClick={() => profile.managerId && setOpenFocusMenuWeek(openFocusMenuWeek === i ? null : i)}
                      disabled={!profile.managerId || busy}
                      className="w-full text-left rounded-[6px] px-[10px] py-[6px] text-[12px] font-semibold cursor-pointer flex items-center justify-between gap-[6px] disabled:cursor-not-allowed"
                      style={{ background: 'var(--gc-s2)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink)' }}
                    >
                      <span className="flex items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {trainingFocusLabel(sw?.focus ?? null)}
                        {sw?.isExplicit && (
                          <span className="text-[9px] font-bold flex-none" style={{ color: 'var(--gc-ball)' }} title="Explicit entry for this week">
                            ●
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] flex-none" style={{ color: 'var(--gc-ink-mute)' }}>
                        ▾
                      </span>
                    </button>
                    {openFocusMenuWeek === i && (
                      <div
                        className="absolute top-[calc(100%+4px)] right-0 min-w-[170px] max-h-[260px] overflow-y-auto gc-card rounded-[6px] z-10 py-1"
                        style={{ border: '1px solid var(--gc-line)', boxShadow: '0 4px 14px rgba(0,0,0,0.1)' }}
                      >
                        {FOCUS_GROUPS.map((grp, gi) => (
                          <div key={grp.label} style={gi > 0 ? { borderTop: '1px solid var(--gc-line)' } : undefined}>
                            <div
                              className="px-[10px] pt-[6px] pb-[3px] text-[10px] font-bold tracking-[0.5px] uppercase"
                              style={{ color: 'var(--gc-ink-mute)' }}
                            >
                              {grp.label}
                            </div>
                            {grp.options.map((opt) => (
                              <div
                                key={opt.label}
                                onClick={() => handleSelectFocus(i, pw.week, opt.focus)}
                                className="flex items-center justify-between px-[10px] py-[6px] text-[12px] cursor-pointer hover:bg-[var(--gc-s3)]"
                                style={{ color: 'var(--gc-ink)' }}
                              >
                                {opt.label}
                                {focusEquals(sw?.focus ?? null, opt.focus) && (
                                  <span className="font-bold" style={{ color: 'var(--gc-ball)' }}>
                                    ✓
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {enterModalWeek !== null && profile.managerId && (
          <EnterTournamentModal
            playerId={profile.playerId}
            playerName={profile.name}
            managerId={profile.managerId}
            week={plannerWeeks?.[enterModalWeek]?.week}
            onClose={() => setEnterModalWeek(null)}
            onEntered={() => {
              setEnterModalWeek(null);
              loadSchedule();
            }}
          />
        )}

        <NetDivider />

        {/* Tournament history — compact preview; the full, paginated
            history lives on its own subpage now (/players/[id]/history). */}
        <div className="flex items-center justify-between mb-[10px]">
          <div className="text-[13px] font-bold tracking-[0.2px]" style={{ color: 'var(--gc-ink)' }}>Tournament history</div>
          {profile.tournamentHistory.length > 0 && (
            <Link href={`/players/${playerId}/history`} className="text-[12px] font-semibold no-underline hover:underline" style={{ color: 'var(--gc-ball)' }}>
              View all {profile.tournamentHistory.length} →
            </Link>
          )}
        </div>
        {profile.tournamentHistory.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
            No tournament entries yet.
          </div>
        ) : (
          <div className="flex flex-col gap-[8px]">
            {profile.tournamentHistory.slice(0, 3).map((entry) => (
              <Link
                key={entry.tournamentId}
                href={`/tournaments/${entry.tournamentId}`}
                className="flex items-center justify-between gc-card gc-card--hover rounded-[8px] px-[14px] py-[11px] no-underline"
                style={{ border: '1px solid var(--gc-line)', color: 'inherit' }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <div
                    className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[3px] rounded-[4px] text-white flex-none"
                    style={{ background: SURFACE_COLOR[entry.surface] ?? 'var(--gc-line)' }}
                  >
                    {entry.surface}
                  </div>
                  {entry.ageBand && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px] flex-none"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {entry.ageBand}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--gc-ink-mute)' }}>
                      {entry.tier} · {entry.drawSize}-draw · Season {entry.weekScheduled.season}, Week {entry.weekScheduled.week}
                    </div>
                  </div>
                </div>
                <div className="text-right flex-none">
                  <div className="text-[12px] font-semibold" style={{ color: entry.won ? 'oklch(80% 0.14 85)' : 'var(--gc-ink-mute)' }}>
                    {tournamentHistoryResultLabel(entry)}
                  </div>
                  {entry.prizeMoney > 0 && (
                    <div className="text-[10.5px] font-semibold" style={{ color: 'var(--gc-ink-mute)' }}>
                      {formatMoney(entry.prizeMoney)}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppFrame>
  );
}
