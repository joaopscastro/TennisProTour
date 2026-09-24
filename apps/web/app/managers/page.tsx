'use client';

import { useEffect, useState } from 'react';
import {
  ManagerLeaderboardDto,
  fetchManagerLeaderboard,
} from '../../lib/api';
import { AppShell } from '../../components/ui/AppShell';
import { PageShell } from '../../components/ui/primitives';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { MEDAL } from '../../lib/ui/medals';

export default function ManagersPage() {
  const devManagerId = useDevManagerId();
  const [managerId] = useState(devManagerId ?? '');
  const { entitlement } = useEntitlement(managerId);
  const [board, setBoard] = useState<ManagerLeaderboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchManagerLeaderboard(100)
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const self = board?.self;
  const selfInTop = board?.standings.some((r) => r.isSelf) ?? false;

  return (
    <AppShell active="managers" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        {/* Page header — flat (Direction A), with the caller's own standing
            as the one summary figure beside it. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div className="t-label">The Tour Standings</div>
            <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Manager Rankings</h1>
            <div className="t-body-sm" style={{ marginTop: 4, maxWidth: 580 }}>
              Every ranking point your players earn banks onto your ladder — but it erodes a little each week. Stand still and you slide. This is the number that never stops moving.
            </div>
          </div>
          {self && (
            <div className="gc-subbar" style={{ flex: 'none', gap: 16, padding: '10px 16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                <span className="t-label" style={{ margin: 0 }}>Your Position</span>
                <span className="num" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1, color: 'var(--gold)' }}>
                  {self.rank !== null ? `#${self.rank}` : 'NR'}
                </span>
                <span className="num" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                  {self.score.toLocaleString()} pts
                </span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div
            className="gc-notice"
            style={{
              marginTop: 18,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <div className="gc-panel" style={{ marginTop: 18, padding: '28px 20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
            No manager has banked a ranking point yet. Win a match and you&apos;ll be the first name on the board.
          </div>
        )}

        {board && board.standings.length > 0 && (
          <div className="gc-panel" style={{ marginTop: 18 }}>
            <div className="gc-panel-bd flush">
              <table className="gc-table">
                <thead>
                  <tr>
                    <th className="r" style={{ width: 70 }}>Rank</th>
                    <th>Manager</th>
                    <th className="r">Ladder Score</th>
                  </tr>
                </thead>
                <tbody>
                  {board.standings.map((row) => (
                    <tr key={row.managerId} className={row.isSelf ? 'is-selected' : undefined}>
                      <td className="r">
                        <span className="num" style={{ fontWeight: 600, color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--ink-2)' }}>
                          {row.rank <= 3 && (
                            <span className="gc-dot" style={{ background: MEDAL[row.rank - 1], marginRight: 6 }} />
                          )}
                          #{row.rank}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: row.isSelf ? 600 : 400, color: row.isSelf ? 'var(--gold)' : 'var(--ink)' }}>
                          {row.displayName}
                        </span>
                        {row.isSelf && (
                          <span className="gc-badge" style={{ marginLeft: 8, color: 'var(--accent)' }}>You</span>
                        )}
                      </td>
                      <td className="r num" style={{ fontWeight: 600 }}>{row.score.toLocaleString()}</td>
                    </tr>
                  ))}

                  {/* Outside the returned slice: the caller's own row is
                      appended below the cut, not hidden. */}
                  {self && self.rank !== null && !selfInTop && (
                    <tr className="is-selected" style={{ borderTop: '2px solid var(--hair-2)' }}>
                      <td className="r">
                        <span className="num" style={{ fontWeight: 600, color: 'var(--gold)' }}>#{self.rank}</span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--gold)' }}>{self.displayName}</span>
                        <span className="gc-badge" style={{ marginLeft: 8, color: 'var(--accent)' }}>You</span>
                      </td>
                      <td className="r num" style={{ fontWeight: 600 }}>{self.score.toLocaleString()}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageShell>
    </AppShell>
  );
}
