'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { AppFrame, PageShell, Hero, Panel, Button, SectionLabel } from '../../components/ui/primitives';
import { PlayerCard } from '../../components/ui/PlayerCard';
import { AnimatedNumber, Delta } from '../../components/ui/motion';
import { CelebrationMoment, CelebrationOverlay } from '../../components/ui/Celebration';
import { useCountdown, formatCountdown } from '../../lib/useCountdown';

function overallOf(c: TalentPoolCandidateDto): number {
  const { technical, physical, mental } = c.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

export default function ScoutingPage() {
  const [managerId, setManagerId] = useState('seed-m1');
  const [managerIdInput, setManagerIdInput] = useState('seed-m1');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [candidates, setCandidates] = useState<TalentPoolCandidateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedOutId, setClaimedOutId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);
  const [shown, setShown] = useState(48);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCandidates(await fetchTalentPool());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetchWorldClock()
      .then(setWorldClock)
      .catch(() => setWorldClock(null));
  }, []);

  // The talent pool refreshes on the weekly rollover only (the
  // RefreshTalentPoolUseCase runs inside advance-world-week, gated on
  // weekRolledOver), NOT on every day tick — so this counts down to
  // nextWeekTickAt (the next day-7 -> day-1 rollover), not nextTickAt.
  const refreshRemainingMs = useCountdown(worldClock?.nextWeekTickAt ?? null);

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
    setClaimingId(candidateId);
    setError(null);
    try {
      await claimTalentPoolCandidate(candidateId, managerId);
      // Play the card's exit animation before it leaves the board, so the
      // sign never happens as a silent list mutation.
      setClaimedOutId(candidateId);
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      await new Promise((r) => setTimeout(r, reduce ? 0 : 560));
      showNotice(`Signed ${name} — welcome to the academy.`);
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
      setError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setClaimingId(null);
      setClaimedOutId(null);
    }
  }

  const xpBalance = entitlement?.xpBalance ?? 0;

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
              <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 320)', opacity: 0.85, marginTop: 5, maxWidth: 560, lineHeight: 1.5 }}>
                One shared pool. Every manager sees the same faces and races to sign them first — and free agents never vanish, they keep training and ageing in the world until someone signs them.
                {worldClock && (
                  <> Fresh young talent arrives in <span style={{ fontWeight: 700, color: 'white', fontVariantNumeric: 'tabular-nums' }}>{formatCountdown(refreshRemainingMs)}</span>.</>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, background: 'oklch(100% 0 0 / 0.1)', border: '1px solid oklch(100% 0 0 / 0.16)' }}>
                <span style={{ fontSize: 11, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'oklch(90% 0.02 320)', opacity: 0.8 }}>Your XP</span>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <AnimatedNumber value={xpBalance} mountFrom={xpBalance} style={{ fontSize: 17, fontWeight: 800, color: 'var(--gc-ball)' }} />
                  <Delta value={xpBalance} suffix="XP" side="left" />
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
          A scout can tell you what a prospect can do <strong style={{ color: 'var(--gc-ink-dim)' }}>today</strong> — never how high they&apos;ll climb. There are no rarity labels and no potential grades here: read the raw attributes yourself, weigh the risk, and sign before a rival does. Open a player&apos;s profile to study the full breakdown.
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
            <SectionLabel>{candidates.length} free agent{candidates.length === 1 ? '' : 's'} available · youngest first</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
              {candidates.slice(0, shown).map((c, idx) => {
                const busy = claimingId === c.id;
                const claimedOut = claimedOutId === c.id;
                const affordable = xpBalance >= c.claimCost;
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
                    footer={
                      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--gc-ink-faint)' }}>Sign for</div>
                          <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: affordable ? 'var(--gc-ball)' : 'var(--gc-ink-mute)' }}>
                            {c.claimCost.toLocaleString()} <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>XP</span>
                          </div>
                          {!affordable && (
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'oklch(72% 0.15 30)', marginTop: 2 }}>Need {(c.claimCost - xpBalance).toLocaleString()} more</div>
                          )}
                        </div>
                        <Button variant="primary" onClick={() => handleClaim(c.id, c.name)} disabled={claimingId !== null || !affordable} style={{ padding: '9px 18px' }}>
                          {busy ? 'Signing…' : 'Sign'}
                        </Button>
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
