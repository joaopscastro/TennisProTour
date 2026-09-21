'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EntitlementDto,
  TalentPoolCandidateDto,
  WorldClockDto,
  claimTalentPoolCandidate,
  fetchEntitlement,
  fetchTalentPool,
  fetchWorldClock,
} from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, PageShell, Hero, Panel, Button, SectionLabel, StatBar } from '../../components/ui/primitives';
import { PlayerCard } from '../../components/ui/PlayerCard';
import { AnimatedNumber, Delta } from '../../components/ui/motion';
import { CelebrationMoment, CelebrationOverlay } from '../../components/ui/Celebration';
import { useCountdown, formatCountdown } from '../../lib/useCountdown';
import { useDevManagerId } from '../../lib/managerContext';
import { xpAffordability } from '../../lib/xp';
import { formatMoney } from '../../lib/format';

function overallOf(c: TalentPoolCandidateDto): number {
  const { technical, physical, mental } = c.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

/** How the free-agent grid is ordered. "Youngest" is the long-standing
 * default (see the "youngest first" copy) — the other two are the
 * comparison axes a scout actually weighs a prospect on. Sorted
 * client-side over data the DTO already carries; no new query. */
type ScoutSort = 'youngest' | 'overall' | 'cost';

/** A compact per-attribute snapshot so two prospects can be compared
 * without opening each profile. Deliberately only CURRENT attributes —
 * hidden potential/ceilings stay profile-only by design (see
 * talentPoolRoutes' DTO note); nothing here can leak a ceiling. */
function AttributeSnapshot({ attributes }: { attributes: TalentPoolCandidateDto['attributes'] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 18px' }}>
      {Object.entries(attributes.technical).map(([name, value]) => (
        <StatBar key={`t-${name}`} label={name} value={value} />
      ))}
      {Object.entries(attributes.physical).map(([name, value]) => (
        <StatBar key={`p-${name}`} label={name} value={value} />
      ))}
      {Object.entries(attributes.mental).map(([name, value]) => (
        <StatBar key={`m-${name}`} label={name} value={value} />
      ))}
    </div>
  );
}

export default function ScoutingPage() {
  const devManagerId = useDevManagerId();
  const [managerId, setManagerId] = useState(devManagerId ?? '');
  const [managerIdInput, setManagerIdInput] = useState(devManagerId ?? '');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [candidates, setCandidates] = useState<TalentPoolCandidateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedOutId, setClaimedOutId] = useState<string | null>(null);
  // In-page confirm step for signing a mid-event free agent. `window.confirm`
  // (the previous approach) is a native dialog the browser — and any
  // automated visitor — auto-dismisses, so "Sign" silently did nothing.
  const [confirmClaimId, setConfirmClaimId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);
  const [shown, setShown] = useState(48);
  const [sortBy, setSortBy] = useState<ScoutSort>('youngest');

  const load = useCallback(async () => {
    setError(null);
    try {
      setCandidates(await fetchTalentPool());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadClock = useCallback(() => {
    fetchWorldClock()
      .then(setWorldClock)
      .catch(() => setWorldClock(null));
  }, []);

  // Re-read the clock AND the pool when the weekly rollover arrives or the
  // tab regains focus. At the compressed 2h/day production cadence, a
  // fetch-once countdown would hit zero and stick in any tab left open —
  // and with the rollover having passed, the pool itself has changed.
  const refreshClockAndPool = useCallback(() => {
    loadClock();
    void load();
  }, [loadClock, load]);

  useEffect(() => {
    refreshClockAndPool();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshClockAndPool(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshClockAndPool]);

  // The talent pool refreshes on the weekly rollover only (the
  // RefreshTalentPoolUseCase runs inside advance-world-week, gated on
  // weekRolledOver), NOT on every day tick — so this counts down to
  // nextWeekTickAt (the next day-7 -> day-1 rollover), not nextTickAt.
  const refreshRemainingMs = useCountdown(worldClock?.nextWeekTickAt ?? null, refreshClockAndPool);

  useEffect(() => {
    fetchEntitlement(managerId)
      .then(setEntitlement)
      .catch(() => setEntitlement(null));
  }, [managerId]);

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  async function handleClaim(candidateId: string, name: string) {
    const claimed = candidates?.find((c) => c.id === candidateId) ?? null;
    // Disclose at the point of signing: this free agent has a match still
    // to play, so signing adopts them into that event mid-draw. Stated
    // plainly BEFORE committing, via an explicit in-page confirm step (see
    // confirmClaimId) — not a native window.confirm, which auto-dismisses.
    if (claimed?.currentTournament && confirmClaimId !== candidateId) {
      setConfirmClaimId(candidateId);
      return;
    }
    setConfirmClaimId(null);
    setClaimingId(candidateId);
    setError(null);
    try {
      await claimTalentPoolCandidate(candidateId, managerId);
      // Play the card's exit animation before it leaves the board, so the
      // sign never happens as a silent list mutation.
      setClaimedOutId(candidateId);
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      await new Promise((r) => setTimeout(r, reduce ? 0 : 560));
      showNotice(
        claimed?.currentTournament
          ? `Signed ${name} — they'll join you mid-tournament at ${claimed.currentTournament.name}.`
          : `Signed ${name} — welcome to the academy.`,
      );
      await load();
      await fetchEntitlement(managerId).then(setEntitlement).catch(() => {});
      // A signing is a real event, not a silent list row — fire a claim
      // celebration (GC-16), scaled off the OBSERVABLE current OVR only
      // (potential is hidden in this RPG and must never leak, even here).
      if (claimed) {
        setCelebrations([
          {
            kind: 'claim',
            playerId: claimed.id,
            playerName: claimed.name,
            nationality: claimed.nationality,
            overall: overallOf(claimed),
          },
        ]);
      }
    } catch (e) {
      // A lost claim race is a real, expected outcome (another manager signed
      // them first — atomic claimAndCharge refuses the loser with a 409), not a
      // silent no-op. Say so plainly AND refresh the pool so the stale card
      // disappears with an explanation, instead of leaving the agent to guess
      // why nothing happened. Every other failure surfaces the server's own
      // message rather than swallowing it.
      const status = (e as { status?: number }).status;
      const serverMessage = e instanceof Error ? e.message : String(e);
      const message =
        status === 409
          ? `Another manager signed ${name} first — they're no longer available. The pool has been refreshed.`
          : `Couldn't sign ${name}: ${serverMessage}`;
      setError(message);
      showNotice(message);
      await load();
    } finally {
      setClaimingId(null);
      setClaimedOutId(null);
    }
  }

  // `null` (not 0!) until the entitlement has loaded — see lib/xp.ts.
  // `?? 0` here was the false-"0 XP" race: it showed an empty balance and
  // disabled every Sign button until a reload won the fetch.
  const xpBalance = entitlement?.xpBalance ?? null;

  // "Youngest" stays the default (and the backend already returns the
  // pool youngest-first), so this only re-orders when the scout picks
  // another axis. Ties fall back to age so the order is stable.
  const sortedCandidates = useMemo(() => {
    if (!candidates) return [];
    const copy = [...candidates];
    if (sortBy === 'overall') copy.sort((a, b) => overallOf(b) - overallOf(a) || a.ageInWeeks - b.ageInWeeks);
    else if (sortBy === 'cost') copy.sort((a, b) => a.claimCost - b.claimCost || a.ageInWeeks - b.ageInWeeks);
    else copy.sort((a, b) => a.ageInWeeks - b.ageInWeeks);
    return copy;
  }, [candidates, sortBy]);

  return (
    <AppFrame>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}
      <Sidebar active="scouting" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance} />

      <PageShell wash="radial-gradient(120% 60% at 85% -10%, oklch(45% 0.13 320 / 0.14), transparent 60%)">
        <Hero minHeight={140}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(88% 0.05 320)', opacity: 0.9 }}>The Talent Pool</div>
              <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Scouting</div>
              <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 320)', opacity: 0.85, marginTop: 5, maxWidth: 620, lineHeight: 1.5 }}>
                One shared pool of <strong style={{ color: 'white' }}>free agents</strong> — from raw teenagers to established, match-hardened players of every age. They keep training and competing while unsigned, so some are mid-tournament right now. Every manager sees the same faces and races to sign them first.
                {worldClock && (
                  <> Fresh young talent arrives in <span style={{ fontWeight: 700, color: 'white', fontVariantNumeric: 'tabular-nums' }}>{formatCountdown(refreshRemainingMs)}</span>.</>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, background: 'oklch(100% 0 0 / 0.1)', border: '1px solid oklch(100% 0 0 / 0.16)' }}>
                <span style={{ fontSize: 11, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'oklch(90% 0.02 320)', opacity: 0.8 }}>Your XP</span>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  {xpBalance === null ? (
                    <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--gc-ink-mute)' }}>—</span>
                  ) : (
                    <>
                      <AnimatedNumber value={xpBalance} mountFrom={xpBalance} style={{ fontSize: 17, fontWeight: 800, color: 'var(--gc-ball)' }} />
                      <Delta value={xpBalance} suffix="XP" side="left" />
                    </>
                  )}
                </span>
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

        <div style={{ marginTop: 16, fontSize: 12.5, lineHeight: 1.5, color: 'var(--gc-ink-mute)', borderRadius: 10, padding: '11px 15px', background: 'oklch(100% 0 0 / 0.03)', border: '1px solid var(--gc-line)' }}>
          A scout can tell you what a free agent can do <strong style={{ color: 'var(--gc-ink-dim)' }}>today</strong> — never how high they&apos;ll climb. There are no rarity labels and no potential grades here: read the raw attributes yourself, weigh the risk, and sign before a rival does. Free agents range from raw teenagers to established players with titles and career earnings — a career record on the card is exactly that, not a scouting grade. Anyone marked <strong style={{ color: 'var(--gc-ink-dim)' }}>Competing</strong> is mid-tournament and will join you there. Open a player&apos;s profile to study the full breakdown.
        </div>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, borderRadius: 10, padding: '10px 14px', color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {candidates === null && !error && (
          <div style={{ marginTop: 24, fontSize: 13.5, color: 'var(--gc-ink-mute)' }}>Loading talent pool…</div>
        )}

        {candidates?.length === 0 && (
          <Panel grain style={{ marginTop: 20, padding: '60px 40px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>No free agents right now</div>
            <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)' }}>Fresh young talent arrives at the next weekly refresh.</div>
          </Panel>
        )}

        {candidates && candidates.length > 0 && (
          <>
            <SectionLabel
              right={
                <select
                  className="gc-select"
                  value={sortBy}
                  onChange={(e) => {
                    setSortBy(e.target.value as ScoutSort);
                    // Jump back to the top of the newly-ordered list so
                    // the sorted head is actually visible, not buried
                    // behind however far "Show more" had already gone.
                    setShown(48);
                  }}
                  style={{ padding: '7px 28px 7px 10px', fontSize: 12 }}
                >
                  <option value="youngest">Sort: Youngest</option>
                  <option value="overall">Sort: Overall rating</option>
                  <option value="cost">Sort: Cheapest to sign</option>
                </select>
              }
            >
              {candidates.length} free agent{candidates.length === 1 ? '' : 's'} available
            </SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
              {sortedCandidates.slice(0, shown).map((c, idx) => {
                const busy = claimingId === c.id;
                const claimedOut = claimedOutId === c.id;
                // One source for the XP shown and the gating: unknown (not
                // yet fetched) is its own state, never an assumed 0.
                const affordability = xpAffordability(xpBalance, c.claimCost);
                const affordable = affordability.state === 'affordable';
                return (
                  <PlayerCard
                    key={c.id}
                    id={c.id}
                    name={c.name}
                    nationality={c.nationality}
                    avatarSize={72}
                    ovr={overallOf(c)}
                    subtitle={`${Math.floor(c.ageInWeeks / 52)} yrs old`}
                    hover
                    href={`/players/${c.id}`}
                    className={`gc-rise${claimedOut ? ' gc-claimed-out' : ''}`}
                    style={{ opacity: busy && !claimedOut ? 0.55 : 1, animationDelay: claimedOut ? '0ms' : `${idx * 40}ms` }}
                    stats={<AttributeSnapshot attributes={c.attributes} />}
                    badges={
                      c.currentTournament || c.titleCount > 0 || c.careerPrizeMoney > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {c.currentTournament && (
                            <span
                              className="gc-badge"
                              title={`Currently competing in ${c.currentTournament.name} — signing adopts them into that event mid-tournament.`}
                              style={{ background: 'oklch(48% 0.16 45 / 0.32)', color: 'oklch(85% 0.14 55)' }}
                            >
                              ● Competing · {c.currentTournament.name}
                            </span>
                          )}
                          {c.titleCount > 0 && (
                            <span className="gc-badge" style={{ background: 'oklch(48% 0.13 85 / 0.28)', color: 'oklch(88% 0.12 85)' }}>
                              🏆 {c.titleCount} {c.titleCount === 1 ? 'title' : 'titles'}
                            </span>
                          )}
                          {c.careerPrizeMoney > 0 && (
                            <span
                              className="gc-badge"
                              title="Career prize money earned on tour"
                              style={{ background: 'oklch(45% 0.05 250 / 0.3)', color: 'oklch(85% 0.05 250)' }}
                            >
                              {formatMoney(c.careerPrizeMoney)} career
                            </span>
                          )}
                        </div>
                      ) : undefined
                    }
                    footer={
                      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--gc-ink-faint)' }}>Sign for</div>
                          <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: affordable ? 'var(--gc-ball)' : 'var(--gc-ink-mute)' }}>
                            {c.claimCost.toLocaleString()} <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>XP</span>
                          </div>
                          {affordability.state === 'short' && (
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'oklch(72% 0.15 30)', marginTop: 2 }}>Need {affordability.remaining.toLocaleString()} more</div>
                          )}
                        </div>
                        {confirmClaimId === c.id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                            <div style={{ fontSize: 10.5, lineHeight: 1.35, color: 'var(--gc-ink-mute)', textAlign: 'right', maxWidth: 170 }}>
                              Adopts them into {c.currentTournament?.name ?? 'their event'} mid-tournament.
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <Button variant="primary" onClick={() => handleClaim(c.id, c.name)} disabled={claimingId !== null || !affordable} style={{ padding: '8px 12px' }}>
                                {busy ? 'Signing…' : 'Sign anyway'}
                              </Button>
                              <Button variant="ghost" onClick={() => setConfirmClaimId(null)} style={{ padding: '8px 12px' }}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button variant="primary" onClick={() => handleClaim(c.id, c.name)} disabled={claimingId !== null || !affordable} style={{ padding: '9px 18px' }}>
                            {busy ? 'Signing…' : 'Sign'}
                          </Button>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>
            {shown < candidates.length && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
                <Button variant="ghost" onClick={() => setShown((n) => n + 48)} style={{ padding: '10px 22px' }}>
                  Show more ({candidates.length - shown} older free agents)
                </Button>
              </div>
            )}
          </>
        )}
      </PageShell>

      {notice && (
        <div className="gc-panel gc-pop" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 40, fontSize: 13, fontWeight: 650, padding: '13px 18px', borderColor: 'var(--gc-ball-d)' }}>
          {notice}
        </div>
      )}
    </AppFrame>
  );
}
