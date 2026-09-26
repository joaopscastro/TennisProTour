'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
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
  fetchEntryPlanner,
  fetchPlayer,
  fetchPlayerMatches,
  fetchPlayerProfile,
  fetchRosterDashboard,
  fetchTrainingSchedule,
  setTrainingScheduleEntry,
} from '../../../lib/api';
import { useDevManagerId } from '../../../lib/managerContext';
import { useEntitlement } from '../../../lib/entitlement';
import { EnterTournamentModal } from '../../../components/EnterTournamentModal';
import { useCountdown, formatCountdownClock } from '../../../lib/useCountdown';
import { AppShell } from '../../../components/ui/AppShell';
import { CelebrationMoment, CelebrationOverlay } from '../../../components/ui/Celebration';
import { PageShell, PanelHeader, SectionLabel, Button, Flag, StatBar, SurfaceBadge } from '../../../components/ui/primitives';
import { FormDots, RankPill, ArchetypeBadge } from '../../../components/ui/PlayerCard';
import { Icon } from '../../../components/ui/Icon';
import {
  RANKING_EARNED_NOTE,
  WEEKS_PER_SEASON,
  formatMoney,
  formatScoreline,
  matchRoundLabel,
  rankingBandScopeNote,
  tournamentHistoryResultLabel,
} from '../../../lib/format';
import { SURFACE_COLOR } from '../../../lib/ui/surfaces';
import { stageLabel, stageMeta } from '../../../lib/ui/stage';
import { FOCUS_GROUPS, focusEquals, trainingFocusLabel } from '../../../lib/ui/focus';

const BAND_LABEL: Record<RankingBand, string> = { senior: 'Senior', u14: 'U14', u16: 'U16', u18: 'U18' };

function overallOf(player: PlayerDto): number {
  const { technical, physical, mental } = player.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

function AttributeGroup({ label, entries }: { label: string; entries: Array<[string, number]> }) {
  return (
    <div>
      <div className="t-label" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {entries.map(([name, value]) => (
          <StatBar key={name} label={name} value={value} />
        ))}
      </div>
    </div>
  );
}

type AttributeProjection = { current: number; projected: number; mature: boolean };

/** A segmented stat bar with a translucent "ghost cap" extension from the
 * current value out to the scout's projected ceiling — the projected
 * headroom is shown, never a hard promise. `mature` attributes (mental)
 * have no headroom, so they render as a plain solid bar. */
function GhostStatBar({ label, proj }: { label: string; proj: AttributeProjection }) {
  const currentPct = Math.max(0, Math.min(100, proj.current));
  const projectedPct = Math.max(0, Math.min(100, proj.projected));
  const ghostPct = Math.max(0, projectedPct - currentPct);
  const hasHeadroom = !proj.mature && ghostPct >= 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="t-label" style={{ width: 68, textTransform: 'capitalize' }}>{label}</span>
      <div style={{ position: 'relative', flex: 1, height: 9 }}>
        <span
          className="gc-seg"
          style={{ width: '100%', ['--p' as string]: currentPct, ['--seg' as string]: 'var(--accent)' }}
        />
        {hasHeadroom && (
          <span
            title="Projected headroom (scout's read)"
            style={{
              position: 'absolute',
              left: `${currentPct}%`,
              width: `${ghostPct}%`,
              top: 0,
              bottom: 0,
              borderRadius: 'var(--r1)',
              background:
                'repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 45%, transparent) 0 5px, color-mix(in srgb, var(--accent) 15%, transparent) 5px 10px)',
            }}
          />
        )}
      </div>
      <span className="num" style={{ width: 26, textAlign: 'right', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
        {Math.round(proj.current)}
      </span>
      <span
        className="num"
        style={{ width: 34, textAlign: 'right', fontSize: 11, fontWeight: 600, color: hasHeadroom ? 'var(--ink-4)' : 'transparent' }}
      >
        {hasHeadroom ? `~${Math.round(proj.projected)}` : '—'}
      </span>
    </div>
  );
}

function GhostAttributeGroup({ label, entries }: { label: string; entries: Array<[string, AttributeProjection]> }) {
  return (
    <div>
      <div className="t-label" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
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
  limited: { label: 'Limited', color: 'var(--ink-3)' },
  promising: { label: 'Promising', color: 'var(--win)' },
  high: { label: 'High', color: 'var(--hard)' },
  elite: { label: 'Elite', color: 'var(--gold)' },
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
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        background: 'var(--bg-3)', border: '1px solid var(--hair)', borderRadius: 'var(--r2)', padding: '10px 13px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span
          className="gc-wchip"
          style={
            won
              ? { background: 'var(--win)', color: 'var(--accent-ink)' }
              : { background: 'color-mix(in srgb, var(--loss) 25%, transparent)', color: 'var(--loss)' }
          }
          title={won ? 'Win' : 'Loss'}
        >
          {won ? 'W' : 'L'}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ color: 'var(--ink-3)' }}>vs</span>
            <Flag code={m.opponentNationality} size={13} />
            <Link
              href={`/players/${m.opponentId}`}
              className="gc-identity-link"
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink)' }}
            >
              {m.opponentName}
            </Link>
          </div>
          <div className="t-mono-s" style={{ color: 'var(--ink-3)' }}>
            {roundLabel} · {m.tournamentName}
          </div>
        </div>
      </div>
      <div
        className="num"
        style={{ flex: 'none', fontSize: 12.5, fontWeight: 600, color: won ? 'var(--win)' : 'var(--ink-3)' }}
      >
        {m.setScores ? formatScoreline(m.setScores, won) : ''}
      </div>
    </div>
  );
}

/** The "next up" match's live status: a ticking "playing in 00:03:45"
 * countdown to its scheduled reveal start, then "Live now" during the
 * reveal window, or "Awaiting simulation" when no schedule exists yet
 * (the round isn't due). */
function NextMatchStatus({ m }: { m: PlayerMatchSummaryDto }) {
  const remainingMs = useCountdown(m.scheduledStartAt);
  if (!m.scheduledStartAt) {
    return <div className="t-mono-s" style={{ marginTop: 6, fontStyle: 'italic', color: 'var(--ink-4)' }}>Awaiting simulation</div>;
  }
  if (remainingMs > 0) {
    return (
      <div className="num" style={{ marginTop: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--accent)' }}>
        Playing in {formatCountdownClock(remainingMs)}
      </div>
    );
  }
  return (
    <div
      style={{ marginTop: 6, fontSize: 10.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', color: 'var(--live)' }}
    >
      <span className="gc-live-dot" />
      Live now
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
  // Scouting page uses. The dev manager id comes from useDevManagerId()
  // and is empty under Clerk, where identity is the signed-in session.
  const devManagerId = useDevManagerId() ?? '';
  const { entitlement, refresh: refreshEntitlement } = useEntitlement(devManagerId);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

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

  async function handleSign() {
    // No mid-tournament confirm step any more: the rule forbids signing a
    // free agent with an unfinished tournament commitment outright, so
    // there is no "adopt them into the draw" to disclose. A blocked player's
    // button is disabled from profile.blockingCommitment; if the draw seeded
    // between load and click, the server's honest 409 is shown below.
    setSigning(true);
    setSignError(null);
    try {
      await claimTalentPoolCandidate(playerId, devManagerId);
      // Reload the profile: it now has an owner, flipping the page from
      // "Sign this free agent" to a normal managed profile. The shared
      // entitlement is refreshed too, so the XP shown here (and on every
      // other surface) reflects the spent cost without a reload.
      const [p, m] = await Promise.all([fetchPlayerProfile(playerId), fetchPlayer(playerId)]);
      setProfile(p);
      setPlayer(m);
      loadSchedule();
      void refreshEntitlement();
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
      <AppShell active="roster" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
        <PageShell>
          <div
            className="gc-notice"
            style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)', background: 'color-mix(in srgb, var(--loss) 10%, transparent)' }}
          >
            {error}
          </div>
        </PageShell>
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell active="roster" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
        <PageShell>
          <div className="t-body-sm">Loading player…</div>
        </PageShell>
      </AppShell>
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
    <AppShell active="roster" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}

      <PageShell>
        <Link href="/" className="t-body-sm" style={{ color: 'var(--accent)', fontWeight: 600 }}>
          ← Back to roster
        </Link>

        {/* Identity band — flat panel with a 2px surface-coloured top rule
            (Direction A), carrying the same identity facts as before. */}
        <div style={{ marginTop: 14, marginBottom: 24 }}>
          <div className="gc-band" style={{ ['--surf' as string]: heroSurface ? SURFACE_COLOR[heroSurface] : 'var(--hair-2)', minHeight: 150, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, width: '100%' }}>
              <Flag code={profile.nationality} size={56} />
              <div style={{ minWidth: 0, paddingBottom: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h1 className="t-h1" style={{ margin: 0 }}>{profile.name}</h1>
                  <span className="gc-badge" style={{ background: stg.bg, color: stg.fg, border: '1px solid var(--hair)' }}>
                    {stageLabel(profile.stage)}
                  </span>
                </div>
                <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }} className="t-body-sm">
                  <Flag code={profile.nationality} size={16} />
                  <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{profile.nationality}</span>
                  <span style={{ color: 'var(--ink-4)' }}>·</span>
                  <span>Age {(profile.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)}</span>
                </div>
                {profile.doublesPartner && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                    <span
                      className="gc-badge"
                      style={
                        profile.doublesPartner.status === 'active'
                          ? { color: 'var(--win)', borderColor: 'color-mix(in srgb, var(--win) 40%, transparent)' }
                          : { color: 'var(--hard)', borderColor: 'color-mix(in srgb, var(--hard) 40%, transparent)' }
                      }
                    >
                      {profile.doublesPartner.status === 'active' ? 'Doubles partner' : 'Pending partner'}
                    </span>
                    <Link
                      href={`/players/${profile.doublesPartner.playerId}`}
                      className="gc-identity-link"
                      style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Flag code={profile.doublesPartner.nationality} size={14} />
                      <span style={{ fontWeight: 700 }}>{profile.doublesPartner.name}</span>
                    </Link>
                    {profile.doublesPartner.status === 'active' && (
                      <span style={{ color: 'var(--ink-3)' }}>· {profile.doublesPartner.chemistry}% chemistry</span>
                    )}
                  </div>
                )}
                <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ padding: '5px 11px', borderRadius: 'var(--r2)', background: 'var(--bg-3)', border: '1px solid var(--hair)' }}>
                    <RankPill
                      rank={topRankEntry ? topRankEntry.rank : null}
                      points={topRankEntry?.totalPoints}
                      bandLabel={topRankEntry ? BAND_LABEL[topRankEntry.band] : undefined}
                    />
                  </div>
                  {profile.careerPrizeMoney > 0 && (
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 'var(--r2)', background: 'var(--bg-3)', border: '1px solid var(--hair)' }}
                      title={`${formatMoney(profile.seasonPrizeMoney)} this season`}
                    >
                      <span className="t-label" style={{ fontSize: 9.5 }}>Career earnings</span>
                      <span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{formatMoney(profile.careerPrizeMoney)}</span>
                    </div>
                  )}
                  {profile.tournamentHistory.some((h) => h.hasStarted && (h.won || h.eliminated)) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="t-label" style={{ fontSize: 9.5 }}>Form</span>
                      <FormDots history={profile.tournamentHistory} />
                    </div>
                  )}
                  {/* GC-10 archetype — degrades to nothing until the backend exposes it */}
                  <ArchetypeBadge archetype={(profile as { archetype?: string | null }).archetype ?? null} />
                </div>
                <div className="t-body-sm" style={{ marginTop: 10, fontStyle: 'italic', color: 'var(--ink-3)' }}>{heroTagline}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Free-agent signing — any browsable free agent can be signed
            straight from their profile (same flow as Scouting). */}
        {isFreeAgent && (
          <div className="gc-panel" style={{ marginBottom: 24, padding: 16, borderTop: '2px solid var(--hard)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div className="t-label" style={{ color: 'var(--hard)' }}>Free agent</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 3 }}>
                  Unsigned — no manager. Read the attributes, weigh the risk, and sign before a rival does.
                </div>
                {profile.blockingCommitment && (
                  <div style={{ fontSize: 12.5, marginTop: 4, fontWeight: 600, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="lock" size={12} />
                    Committed to {profile.blockingCommitment.name} — a free agent with an unfinished tournament can&apos;t be signed until it concludes.
                  </div>
                )}
                {!profile.blockingCommitment && matches?.next && (
                  <div style={{ fontSize: 12.5, marginTop: 4, fontWeight: 600, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="gc-live-dot" style={{ background: 'var(--warn)' }} />
                    Currently competing in {matches.next.tournamentName}.
                  </div>
                )}
                {entitlement && (
                  <div style={{ fontSize: 12, marginTop: 4, color: 'var(--ink-3)' }}>
                    Your XP: <span className="num" style={{ fontWeight: 700, color: 'var(--accent)' }}>{entitlement.xpBalance.toLocaleString()}</span>
                  </div>
                )}
                {signError && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--loss)' }}>{signError}</div>}
              </div>
              <Button
                variant="primary"
                onClick={handleSign}
                disabled={signing || Boolean(profile.blockingCommitment)}
                title={profile.blockingCommitment ? `Committed to ${profile.blockingCommitment.name} — can't be signed until it concludes.` : undefined}
                style={{ flex: 'none', padding: '11px 22px', fontSize: 13.5 }}
              >
                {signing ? 'Signing…' : profile.blockingCommitment ? 'Unavailable' : 'Sign this free agent'}
              </Button>
            </div>
          </div>
        )}

        {/* Doubles partner invitation (P7a) — only for a managed player
            owned by a DIFFERENT manager. Pull-based: the target manager
            accepts from their own board. */}
        {canInvite && (
          <div className="gc-panel" style={{ marginBottom: 24, padding: 16 }}>
            {!inviteOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="t-label" style={{ color: 'var(--win)' }}>Doubles</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 3 }}>
                    Invite this player to be one of your players&apos; doubles partner.
                  </div>
                </div>
                <Button variant="primary" onClick={openInvite} style={{ flex: 'none', padding: '10px 18px' }}>
                  Invite as partner
                </Button>
              </div>
            ) : (
              <div>
                <div className="t-label" style={{ color: 'var(--win)' }}>Pick your initiating player</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
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
                  <Button variant="primary" onClick={submitInvite} disabled={!inviteInitiator || inviteBusy} style={{ padding: '9px 16px' }}>
                    {inviteBusy ? 'Sending…' : 'Send invitation'}
                  </Button>
                  <Button variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
                </div>
                {inviteError && <div style={{ fontSize: 12, marginTop: 8, color: 'var(--loss)' }}>{inviteError}</div>}
              </div>
            )}
            {inviteNotice && <div style={{ fontSize: 12, marginTop: 8, color: 'var(--win)' }}>{inviteNotice}</div>}
          </div>
        )}

        {/* Latest results + next match — the profile's most immediate,
            "what just happened / what's next" strip. The next match shows
            a live "playing in X" countdown to its scheduled reveal start
            (see NextMatchStatus). */}
        {matches && (matches.recent.length > 0 || matches.next) && (
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Matches</SectionLabel>
            {matches.next && (
              <div
                className="gc-panel"
                style={{
                  marginBottom: 10, padding: 14, borderTop: '2px solid var(--surf, var(--hard))',
                  ['--surf' as string]: SURFACE_COLOR[matches.next.surface] ?? 'var(--hard)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <Flag code={matches.next.opponentNationality} size={30} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t-label" style={{ fontSize: 10 }}>
                      Next up · {matchRoundLabel(matches.next.drawSize / 2 ** matches.next.roundNumber)}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 7 }}>
                      vs <Flag code={matches.next.opponentNationality} size={14} />
                      <Link href={`/players/${matches.next.opponentId}`} className="gc-identity-link" style={{ color: 'var(--ink)' }}>
                        {matches.next.opponentName}
                      </Link>
                    </div>
                    <div style={{ fontSize: 11.5, marginTop: 2, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {matches.next.tournamentName}
                    </div>
                  </div>
                </div>
                <div style={{ flex: 'none', textAlign: 'right' }}>
                  <SurfaceBadge surface={matches.next.surface} />
                  <NextMatchStatus m={matches.next} />
                </div>
              </div>
            )}
            {matches.recent.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Attributes &amp; potential</SectionLabel>
            <div className="gc-panel" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                <span className="num" style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }}>{overallOf(player)}</span>
                <div>
                  <div className="t-label">Overall</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>Observable ability today — not a ceiling.</div>
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
                    style={{ borderRadius: 'var(--r2)', padding: 13, marginBottom: 16, background: 'var(--bg-3)', border: '1px dashed var(--hair-2)' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                      <div>
                        <div className="t-label" style={{ marginBottom: 3 }}>Scout&apos;s projection</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span className="num" style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px', color: 'var(--ink)' }}>~{band}</span>
                          <span
                            className="gc-badge"
                            style={{ color: tier.color, borderColor: `color-mix(in srgb, ${tier.color} 40%, transparent)` }}
                          >
                            {tier.label} ceiling
                          </span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="t-label" style={{ marginBottom: 3 }}>Developed</div>
                        <div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{p.developmentPercent}%</div>
                        <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{GROWTH_COPY[p.growth]}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--hair)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>Scout confidence: {conf.label}</span>
                        <span style={{ flex: 1, maxWidth: 160 }} className="gc-bar">
                          <i style={{ width: `${Math.round(p.confidence * 100)}%`, background: 'var(--accent)' }} />
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>{conf.note}</div>
                    </div>
                  </div>
                );
              })()}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px 24px' }}>
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
        <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
          {currentBands.map((band) => {
            const entry = profile.currentRankings.find((r) => r.band === band)!;
            return (
              <div key={band} className="gc-panel" style={{ flex: '1 1 160px', padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <div className="t-label">{BAND_LABEL[band]}</div>
                  {band !== 'senior' && (
                    <span className="gc-badge gc-badge--band" style={{ fontSize: 9.5 }}>{band}</span>
                  )}
                </div>
                <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>
                  {entry.rank !== null ? `#${entry.rank}` : '—'}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                  {entry.totalPoints} pts
                </div>
                {entry.rank === null && (
                  <div style={{ fontSize: 10, marginTop: 4, lineHeight: 1.4, color: 'var(--ink-4)' }}>
                    {RANKING_EARNED_NOTE} {rankingBandScopeNote(band)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Peak standing */}
        <SectionLabel>Peak standing</SectionLabel>
        {profile.peakRankings.length === 0 ? (
          <div className="t-body-sm" style={{ marginBottom: 22 }}>
            No peak ranking yet.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
            {profile.peakRankings.map((p) => (
              <div
                key={p.band}
                className="gc-panel"
                style={{ flex: '1 1 160px', padding: 14, borderTop: '2px solid var(--gold)' }}
              >
                <div className="t-label" style={{ marginBottom: 6, color: 'var(--gold)' }}>
                  Peak · {BAND_LABEL[p.band]}
                </div>
                <div className="num" style={{ fontSize: 24, fontWeight: 700, color: 'var(--gold)' }}>
                  {p.peakPoints} pts
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                  Peaked Season {p.peakAsOfWeek.season}, Week {p.peakAsOfWeek.week}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Titles */}
        <SectionLabel>Titles</SectionLabel>
        {profile.titles.length === 0 ? (
          <div className="t-body-sm" style={{ marginBottom: 22 }}>
            No titles yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 22 }}>
            {profile.titles.map((title) => (
              <Link
                key={title.tournamentId}
                href={`/tournaments/${title.tournamentId}`}
                className="gc-card"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderLeft: '3px solid var(--gold)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ color: 'var(--gold)', display: 'inline-flex' }}><Icon name="trophy" size={16} /></span>
                  <span style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title.name}</span>
                  {title.ageBand && (
                    <span className="gc-badge gc-badge--band" style={{ fontSize: 9.5, flex: 'none' }}>{title.ageBand}</span>
                  )}
                </div>
                <div className="num" style={{ fontSize: 11.5, fontWeight: 600, flex: 'none', color: 'var(--ink-3)' }}>
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
                className="gc-panel"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', marginBottom: 8, borderTop: '2px solid var(--win)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--win)', display: 'inline-flex' }}><Icon name="ball" size={16} /></span>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--ink-2)' }}>Doubles peak · {BAND_LABEL[peak.band]}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700, color: 'var(--win)' }}>
                    {peak.peakPoints} pts
                  </div>
                  <div className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    S{peak.peakAsOfWeek.season} W{peak.peakAsOfWeek.week}
                  </div>
                </div>
              </div>
            ))}
            {profile.doublesTitles.map((title) => (
              <Link
                key={title.tournamentId}
                href={`/players/${title.partnerId}`}
                className="gc-card"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', marginBottom: 8, borderLeft: '3px solid var(--gold)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ color: 'var(--gold)', display: 'inline-flex' }}><Icon name="trophy" size={16} /></span>
                  <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Doubles title with <Flag code={title.partnerNationality} size={13} /> {title.partnerName}
                  </div>
                </div>
                <div className="num" style={{ fontSize: 11.5, fontWeight: 600, flex: 'none', color: 'var(--ink-3)' }}>
                  {title.tier} · S{title.weekEarned.season} W{title.weekEarned.week}
                </div>
              </Link>
            ))}
          </>
        )}

        {/* Schedule — combined frontend view over two existing, separate
            backend reads (tournament entry planner + training schedule),
            not a new backend concept. Same lookahead window as the
            tournament planner elsewhere in this app. */}
        <SectionLabel>Schedule</SectionLabel>
        {!profile.managerId && (
          <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 10 }}>
            Free agent — no manager to schedule tournaments or training for.
          </div>
        )}
        {scheduleError && (
          <div
            className="gc-notice"
            style={{ marginBottom: 12, color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)', background: 'color-mix(in srgb, var(--loss) 10%, transparent)' }}
          >
            {scheduleError}
          </div>
        )}
        {plannerWeeks === null && !scheduleError && (
          <div className="t-body-sm" style={{ marginBottom: 22 }}>Loading schedule…</div>
        )}
        {plannerWeeks && (
          <div className="gc-panel" style={{ marginBottom: 22 }}>
            <PanelHeader right={`${plannerWeeks.length} weeks`}>Planner window</PanelHeader>
            <div className="gc-panel-bd flush">
              <table className="gc-table gc-table--rows">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Tournament entry</th>
                    <th>Training focus</th>
                  </tr>
                </thead>
                <tbody>
                  {plannerWeeks.map((pw, i) => {
                    const weekKey = `${pw.week.season}-${pw.week.week}`;
                    const sw = scheduleByWeekKey.get(weekKey);
                    const busy = busyWeek === i;
                    return (
                      <tr key={weekKey} style={{ opacity: busy ? 0.6 : 1 }}>
                        <td>
                          <span className="num" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-3)' }}>
                            S{pw.week.season} W{pw.week.week}
                          </span>
                        </td>

                        {/* Tournament entry — reuses the existing registration
                            flow (EnterTournamentModal) rather than a new one. */}
                        <td>
                          {pw.entries.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {pw.entries.map((t) => (
                                <Link
                                  key={t.id}
                                  href={`/tournaments/${t.id}`}
                                  className="gc-identity-link"
                                  style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', color: t.cancelled ? 'var(--ink-3)' : 'var(--ink)' }}
                                >
                                  {t.name}
                                  {t.cancelled && (
                                    <span
                                      title={t.cancelReason ?? 'This draw was cancelled before it could start'}
                                      style={{ fontStyle: 'italic', fontWeight: 500, color: 'var(--ink-3)' }}
                                    >
                                      {' '}— Cancelled
                                    </span>
                                  )}
                                </Link>
                              ))}
                            </div>
                          ) : profile.managerId ? (
                            <Button variant="ghost" className="gc-btn--sm" onClick={() => setEnterModalWeek(i)} disabled={busy}>
                              + Enter tournament
                            </Button>
                          ) : (
                            <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>—</span>
                          )}
                        </td>

                        {/* Training focus — resolved from the training
                            schedule; editable inline via the same dropdown
                            shape the roster dashboard already uses. */}
                        <td>
                          <div style={{ position: 'relative', width: 150 }}>
                            <button
                              onClick={() => profile.managerId && setOpenFocusMenuWeek(openFocusMenuWeek === i ? null : i)}
                              disabled={!profile.managerId || busy}
                              className="gc-select"
                              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, backgroundImage: 'none', padding: '6px 10px', fontSize: 12, cursor: profile.managerId ? 'pointer' : 'not-allowed' }}
                            >
                              <span style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {trainingFocusLabel(sw?.focus ?? null, 'No focus')}
                                {sw?.isExplicit && (
                                  <span title="Explicit entry for this week" style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                                    <Icon name="check" size={10} />
                                  </span>
                                )}
                              </span>
                              <Icon name="chevron-down" size={11} />
                            </button>
                            {openFocusMenuWeek === i && (
                              <div
                                className="gc-panel"
                                style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: 170, maxHeight: 260, overflowY: 'auto', zIndex: 10, padding: 4 }}
                              >
                                {FOCUS_GROUPS.map((grp, gi) => (
                                  <div key={grp.label} style={gi > 0 ? { borderTop: '1px solid var(--hair)' } : undefined}>
                                    <div className="t-label" style={{ padding: '6px 10px 3px', fontSize: 10 }}>
                                      {grp.label}
                                    </div>
                                    {grp.options.map((opt) => (
                                      <div
                                        key={opt.label}
                                        role="button"
                                        onClick={() => handleSelectFocus(i, pw.week, opt.focus)}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 'var(--r1)', color: 'var(--ink-2)' }}
                                      >
                                        {opt.label}
                                        {focusEquals(sw?.focus ?? null, opt.focus) && (
                                          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                                            <Icon name="check" size={12} />
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
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

        {enterModalWeek !== null && profile.managerId && (
          <EnterTournamentModal
            playerId={profile.playerId}
            playerName={profile.name}
            managerId={profile.managerId}
            week={plannerWeeks?.[enterModalWeek]?.week}
            playerFit={
              player
                ? {
                    overall: overallOf(player),
                    rank: profile.currentRankings.find((r) => r.band === profile.currentEligibleBand)?.rank ?? null,
                    rankBand: profile.currentEligibleBand,
                  }
                : null
            }
            onClose={() => setEnterModalWeek(null)}
            onEntered={() => {
              setEnterModalWeek(null);
              loadSchedule();
            }}
          />
        )}

        {/* Tournament history — compact preview; the full, paginated
            history lives on its own subpage now (/players/[id]/history). */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span className="t-label" style={{ fontSize: 12.5 }}>Tournament history</span>
          {profile.tournamentHistory.length > 0 && (
            <Link href={`/players/${playerId}/history`} className="t-body-sm" style={{ fontWeight: 600, color: 'var(--accent)' }}>
              View all {profile.tournamentHistory.length} →
            </Link>
          )}
        </div>
        {profile.tournamentHistory.length === 0 ? (
          <div className="t-body-sm">No tournament entries yet.</div>
        ) : (
          <div className="gc-panel">
            <div className="gc-panel-bd flush">
              <table className="gc-table gc-table--rows">
                <thead>
                  <tr>
                    <th>Tournament</th>
                    <th>Surface</th>
                    <th>Stage</th>
                    <th className="r">Result</th>
                    <th className="r">Prize</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.tournamentHistory.slice(0, 3).map((entry) => (
                    <tr key={entry.tournamentId} className="gc-rowlink">
                      <td style={{ position: 'relative' }}>
                        <a href={`/tournaments/${entry.tournamentId}`} className="gc-rowcover" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                          {entry.name}
                        </a>
                        {entry.ageBand && (
                          <span className="gc-badge gc-badge--band" style={{ fontSize: 9.5, marginLeft: 8 }}>{entry.ageBand}</span>
                        )}
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span className="gc-dot" style={{ background: SURFACE_COLOR[entry.surface] ?? 'var(--ink-4)' }} />
                          <span className="t-mono-s" style={{ textTransform: 'uppercase' }}>{entry.surface}</span>
                        </span>
                      </td>
                      <td className="num" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                        {entry.tier} · {entry.drawSize}-draw · Season {entry.weekScheduled.season}, Week {entry.weekScheduled.week}
                      </td>
                      <td className="r" style={{ color: entry.won ? 'var(--gold)' : 'var(--ink-3)', fontWeight: 600, fontSize: 12 }}>
                        {tournamentHistoryResultLabel(entry)}
                      </td>
                      <td className="r num" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                        {entry.prizeMoney > 0 ? formatMoney(entry.prizeMoney) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageShell>
    </AppShell>
  );
}
