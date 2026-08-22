'use client';

import { useEffect, useState } from 'react';
import {
  EntitlementDto,
  RankingBand,
  RankingsBoardDto,
  fetchEntitlement,
  fetchRankings,
} from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, PageShell, Hero, Panel } from '../../components/ui/primitives';
import { AnimatedNumber } from '../../components/ui/motion';

const MEDAL = ['oklch(80% 0.15 90)', 'oklch(78% 0.02 250)', 'oklch(62% 0.11 55)'];

const BANDS: Array<{ key: RankingBand; label: string }> = [
  { key: 'senior', label: 'Senior' },
  { key: 'u18', label: 'U18' },
  { key: 'u16', label: 'U16' },
  { key: 'u14', label: 'U14' },
];

export default function RankingsPage() {
  const [managerId] = useState(process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [band, setBand] = useState<RankingBand>('senior');
  const [board, setBoard] = useState<RankingsBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEntitlement(managerId).then(setEntitlement).catch(() => setEntitlement(null));
  }, [managerId]);

  useEffect(() => {
    setBoard(null);
    setError(null);
    fetchRankings(band, 100)
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [band]);

  return (
    <AppFrame>
      <Sidebar active="rankings" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance} />

      <PageShell wash="radial-gradient(120% 60% at 85% -10%, oklch(50% 0.13 90 / 0.16), transparent 60%)">
        <Hero minHeight={150}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(88% 0.06 90)', opacity: 0.9 }}>The Full Table</div>
          <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Player Rankings</div>
          <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 90)', opacity: 0.85, marginTop: 5, maxWidth: 580, lineHeight: 1.5 }}>
            Senior, U16, and U14 are separate ladders — a player is only ranked in the bands their age and results qualify them for.
          </div>
        </Hero>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          {BANDS.map((b) => (
            <button
              key={b.key}
              onClick={() => setBand(b.key)}
              style={{
                padding: '8px 16px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: '0.3px',
                cursor: 'pointer',
                border: `1px solid ${band === b.key ? 'var(--gc-gold)' : 'var(--gc-line)'}`,
                background: band === b.key ? 'oklch(70% 0.15 90 / 0.14)' : 'var(--gc-s2)',
                color: band === b.key ? 'var(--gc-gold)' : 'var(--gc-ink-mute)',
              }}
            >
              {b.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, borderRadius: 10, padding: '10px 14px', color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <Panel style={{ marginTop: 18, padding: '28px 20px', textAlign: 'center', color: 'var(--gc-ink-mute)', fontSize: 14 }}>
            No player has a qualifying result in this band yet.
          </Panel>
        )}

        {board && board.standings.length > 0 && (
          <Panel style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--gc-ink-faint)', fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '11px 16px', width: 70 }}>Rank</th>
                  <th style={{ padding: '11px 16px' }}>Player</th>
                  <th style={{ padding: '11px 16px' }}>Nationality</th>
                  <th style={{ padding: '11px 16px', textAlign: 'right' }}>Points</th>
                </tr>
              </thead>
              <tbody>
                {board.standings.map((row) => (
                  <tr key={row.playerId} style={{ borderTop: '1px solid var(--gc-line)' }}>
                    <td style={{ padding: '11px 16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--gc-ink-mute)' }}>
                        {row.rank <= 3 ? '● ' : ''}#{row.rank}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px', fontWeight: 700 }}>
                      <a href={`/players/${row.playerId}`} style={{ color: 'var(--gc-ink)', textDecoration: 'none' }}>
                        {row.name}
                      </a>
                    </td>
                    <td style={{ padding: '11px 16px', color: 'var(--gc-ink-mute)' }}>{row.nationality ?? '—'}</td>
                    <td style={{ padding: '11px 16px', textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: 'var(--gc-ink-dim)' }}>
                      <AnimatedNumber value={row.points} mountFrom={row.points} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </PageShell>
    </AppFrame>
  );
}
