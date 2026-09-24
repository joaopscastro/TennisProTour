'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PlayerProfileDto, fetchPlayerProfile } from '../../../../lib/api';
import { AppShell } from '../../../../components/ui/AppShell';
import { PageShell, Flag } from '../../../../components/ui/primitives';
import { Icon } from '../../../../components/ui/Icon';
import { SURFACE_COLOR } from '../../../../lib/ui/surfaces';
import { formatMoney, tournamentHistoryResultLabel } from '../../../../lib/format';
import { useDevManagerId } from '../../../../lib/managerContext';
import { useEntitlement } from '../../../../lib/entitlement';

export default function PlayerHistoryPage() {
  const params = useParams<{ id: string }>();
  const playerId = params.id;
  const [profile, setProfile] = useState<PlayerProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const devManagerId = useDevManagerId() ?? '';
  const { entitlement } = useEntitlement(devManagerId);

  useEffect(() => {
    fetchPlayerProfile(playerId)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

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
          <div className="t-body-sm">Loading history…</div>
        </PageShell>
      </AppShell>
    );
  }

  const titledCount = profile.titles.length;
  const heroSurface = profile.tournamentHistory[0]?.surface ?? null;

  return (
    <AppShell active="roster" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        <Link href={`/players/${playerId}`} className="t-body-sm" style={{ color: 'var(--accent)', fontWeight: 600 }}>
          ← Back to profile
        </Link>

        <div style={{ marginTop: 14, marginBottom: 24 }}>
          <div
            className="gc-band"
            style={{
              ['--surf' as string]: heroSurface ? SURFACE_COLOR[heroSurface] : 'var(--hair-2)',
              minHeight: 110,
              padding: '18px 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, width: '100%' }}>
              <Flag code={profile.nationality} size={40} />
              <div style={{ paddingBottom: 2 }}>
                <div className="t-label" style={{ letterSpacing: '2px' }}>Tournament history</div>
                <div className="t-h2" style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 9 }}>
                  <Flag code={profile.nationality} size={17} /> {profile.name}
                </div>
                <div className="t-body-sm" style={{ marginTop: 6 }}>
                  {profile.tournamentHistory.length} tournament{profile.tournamentHistory.length === 1 ? '' : 's'} entered
                  {titledCount > 0 && (
                    <>
                      {' · '}
                      {titledCount} <Icon name="trophy" size={12} style={{ color: 'var(--gold)' }} />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
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
                    <th className="r">Prize money</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.tournamentHistory.map((entry) => (
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
