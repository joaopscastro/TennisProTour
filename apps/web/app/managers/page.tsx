'use client';

import { useEffect, useState } from 'react';
import {
  EntitlementDto,
  ManagerLeaderboardDto,
  fetchEntitlement,
  fetchManagerLeaderboard,
} from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, PageShell, Hero, Panel } from '../../components/ui/primitives';
import { AnimatedNumber } from '../../components/ui/motion';

const MEDAL = ['oklch(80% 0.15 90)', 'oklch(78% 0.02 250)', 'oklch(62% 0.11 55)'];

export default function ManagersPage() {
  const [managerId] = useState(process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [board, setBoard] = useState<ManagerLeaderboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEntitlement(managerId).then(setEntitlement).catch(() => setEntitlement(null));
  }, [managerId]);

  useEffect(() => {
    fetchManagerLeaderboard(100)
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const self = board?.self;
  const selfInTop = board?.standings.some((r) => r.isSelf) ?? false;

  return (
    <AppFrame>
      <Sidebar active="managers" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance} />

      <PageShell wash="radial-gradient(120% 60% at 85% -10%, oklch(50% 0.13 90 / 0.16), transparent 60%)">
        <Hero minHeight={150}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(88% 0.06 90)', opacity: 0.9 }}>The Tour Standings</div>
              <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Manager Rankings</div>
              <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 90)', opacity: 0.85, marginTop: 5, maxWidth: 580, lineHeight: 1.5 }}>
                Every ranking point your players earn banks onto your ladder — but it erodes a little each week. Stand still and you slide. This is the number that never stops moving.
              </div>
            </div>
            {self && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, padding: '10px 16px', borderRadius: 12, background: 'oklch(100% 0 0 / 0.1)', border: '1px solid oklch(100% 0 0 / 0.16)' }}>
                <span style={{ fontSize: 11, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'oklch(90% 0.02 90)', opacity: 0.8 }}>Your Position</span>
                <span style={{ fontSize: 26, fontWeight: 850, color: 'var(--gc-gold)', lineHeight: 1 }}>
                  {self.rank !== null ? `#${self.rank}` : 'NR'}
                </span>
                <span style={{ fontSize: 12, color: 'oklch(90% 0.02 90)', opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}>
                  {self.score.toLocaleString()} pts
                </span>
              </div>
            )}
          </div>
        </Hero>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, borderRadius: 10, padding: '10px 14px', color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <Panel style={{ marginTop: 18, padding: '28px 20px', textAlign: 'center', color: 'var(--gc-ink-mute)', fontSize: 14 }}>
            No manager has banked a ranking point yet. Win a match and you&apos;ll be the first name on the board.
          </Panel>
        )}

        {board && board.standings.length > 0 && (
          <Panel style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--gc-ink-faint)', fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '11px 16px', width: 70 }}>Rank</th>
                  <th style={{ padding: '11px 16px' }}>Manager</th>
                  <th style={{ padding: '11px 16px', textAlign: 'right' }}>Ladder Score</th>
                </tr>
              </thead>
              <tbody>
                {board.standings.map((row) => (
                  <tr
                    key={row.managerId}
                    style={{
                      borderTop: '1px solid var(--gc-line)',
                      background: row.isSelf ? 'oklch(70% 0.15 90 / 0.1)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '11px 16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--gc-ink-mute)' }}>
                        {row.rank <= 3 ? '● ' : ''}#{row.rank}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px', fontWeight: row.isSelf ? 800 : 600, color: row.isSelf ? 'var(--gc-gold)' : 'var(--gc-ink)' }}>
                      {row.displayName}
                      {row.isSelf && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: 'var(--gc-ball)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>You</span>}
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: 'var(--gc-ink-dim)' }}>
                      <AnimatedNumber value={row.score} mountFrom={row.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {self && self.rank !== null && !selfInTop && (
              <div style={{ borderTop: '2px solid var(--gc-line)', padding: '11px 16px', display: 'flex', justifyContent: 'space-between', background: 'oklch(70% 0.15 90 / 0.1)', fontWeight: 800 }}>
                <span style={{ color: 'var(--gc-gold)' }}>#{self.rank} · {self.displayName} <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--gc-ball)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>You</span></span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--gc-ink-dim)' }}>{self.score.toLocaleString()}</span>
              </div>
            )}
          </Panel>
        )}
      </PageShell>
    </AppFrame>
  );
}
