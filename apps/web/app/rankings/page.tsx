'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  RankingBand,
  RankingsBoardDto,
  fetchRankings,
  fetchRoster,
} from '../../lib/api';
import { AppShell } from '../../components/ui/AppShell';
import { PageShell } from '../../components/ui/primitives';
import { Tabs } from '../../components/ui/Tabs';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { RANKING_EARNED_NOTE, RANK_BAND_LABEL, disambiguatedNames, rankingBandScopeNote } from '../../lib/format';
import { MEDAL } from '../../lib/ui/medals';

const BANDS: Array<{ key: RankingBand; label: string }> = [
  { key: 'senior', label: 'Senior' },
  { key: 'u18', label: 'U18' },
  { key: 'u16', label: 'U16' },
  { key: 'u14', label: 'U14' },
];

export default function RankingsPage() {
  const devManagerId = useDevManagerId();
  const [managerId] = useState(devManagerId ?? '');
  const { entitlement } = useEntitlement(managerId);
  const [band, setBand] = useState<RankingBand>('senior');
  const [board, setBoard] = useState<RankingsBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The caller's own roster ids, so the standings can answer "where am I?"
  // instead of leaving a manager to scan 100 foreign rows. null until
  // loaded (unknown ≠ empty); the roster read is the caller-scoped one the
  // rest of the app already uses — no new backend concept.
  const [myPlayerIds, setMyPlayerIds] = useState<Set<string> | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  useEffect(() => {
    fetchRoster(managerId)
      .then((roster) => setMyPlayerIds(new Set(roster.map((p) => p.id))))
      .catch(() => setMyPlayerIds(new Set()));
  }, [managerId]);

  useEffect(() => {
    setBoard(null);
    setError(null);
    fetchRankings(band, 100)
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [band]);

  // Two distinct players can share a full name (finite generator pool);
  // disambiguate the names this table renders.
  const displayNames = useMemo(
    () => disambiguatedNames((board?.standings ?? []).map((r) => ({ id: r.playerId, name: r.name }))),
    [board],
  );
  const myStandings = useMemo(
    () => (board && myPlayerIds ? board.standings.filter((r) => myPlayerIds.has(r.playerId)) : []),
    [board, myPlayerIds],
  );
  const visibleStandings = useMemo(
    () => (board ? (onlyMine ? myStandings : board.standings) : []),
    [board, onlyMine, myStandings],
  );

  return (
    <AppShell active="rankings" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        {/* Page header — flat, no hero band/wash (Direction A). */}
        <div>
          <div className="t-label">The Full Table</div>
          <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Player Rankings</h1>
          <div className="t-body-sm" style={{ marginTop: 4 }}>
            Senior, U18, U16, and U14 are four separate ladders — each only counts results from its own events, and a player is ranked on whichever ladders their age and results qualify them for. Winning a senior event earns Senior points, not junior ones.
          </div>
        </div>

        <Tabs
          items={BANDS.map((b) => ({ id: b.key, label: b.label }))}
          active={band}
          onSelect={(id) => setBand(id as RankingBand)}
          className="mt-2 mb-4"
        />

        {/* "Where am I?" — the standings answer it directly instead of
            making a manager scan 100 rows and fall back to /managers to
            conclude they are unranked. */}
        {board && myPlayerIds && !error && (
          <div className="gc-subbar" style={{ marginBottom: 18 }}>
            <span style={{ lineHeight: 1.5, fontSize: 12.5, color: 'var(--ink-2)', flex: '1 1 320px' }}>
              {myPlayerIds.size === 0
                ? 'You have no players yet — sign a free agent in Scouting to start building a ranked roster.'
                : myStandings.length > 0
                  ? `You have ${myStandings.length} player${myStandings.length === 1 ? '' : 's'} in this top-100 table, best #${Math.min(...myStandings.map((r) => r.rank))}.`
                  : `None of your players is in the top 100 of the ${RANK_BAND_LABEL[band]} ladder yet. ${RANKING_EARNED_NOTE} ${rankingBandScopeNote(band)}`}
            </span>
            {myStandings.length > 0 && (
              <button
                className="gc-chip"
                data-active={onlyMine}
                aria-pressed={onlyMine}
                onClick={() => setOnlyMine((v) => !v)}
                style={{ flex: 'none' }}
              >
                {onlyMine ? 'Show all players' : 'Show only my players'}
              </button>
            )}
          </div>
        )}

        {error && (
          <div
            className="gc-notice"
            style={{
              marginBottom: 18,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <div className="gc-panel" style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
            <div>No player has earned points on the {RANK_BAND_LABEL[band]} ladder yet.</div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-4)', maxWidth: 560, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
              {rankingBandScopeNote(band)} A player only appears here once they&apos;ve won a match in one of this band&apos;s own events — an empty junior table while U14-badged players have won senior matches is expected, not a bug.
            </div>
          </div>
        )}

        {board && onlyMine && visibleStandings.length === 0 && !error && (
          <div className="gc-panel" style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
            <div>None of your players is in the top 100 of the {RANK_BAND_LABEL[band]} ladder.</div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-4)', lineHeight: 1.5 }}>
              {RANKING_EARNED_NOTE} {rankingBandScopeNote(band)}
            </div>
          </div>
        )}

        {board && visibleStandings.length > 0 && (
          <div className="gc-panel">
            <div className="gc-panel-bd flush">
              <table className="gc-table">
                <thead>
                  <tr>
                    <th className="r" style={{ width: 100 }}>Rank · {RANK_BAND_LABEL[board.band]}</th>
                    <th>Player</th>
                    <th>Nationality</th>
                    <th className="r">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStandings.map((row) => {
                    const mine = myPlayerIds?.has(row.playerId) ?? false;
                    return (
                      <tr key={row.playerId} className={mine ? 'is-selected' : undefined}>
                        <td className="r">
                          <span className="num" style={{ fontWeight: 600, color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--ink-2)' }}>
                            {row.rank <= 3 && (
                              <span className="gc-dot" style={{ background: MEDAL[row.rank - 1], marginRight: 6 }} />
                            )}
                            #{row.rank}
                          </span>
                        </td>
                        <td>
                          <a
                            href={`/players/${row.playerId}`}
                            className="gc-identity-link"
                            style={{ fontWeight: 600, color: 'var(--ink)' }}
                          >
                            {displayNames.get(row.playerId) ?? row.name}
                          </a>
                          {mine && (
                            <span
                              className="gc-badge"
                              title="One of your rostered players"
                              style={{ marginLeft: 8, color: 'var(--gold)', borderColor: 'color-mix(in srgb, var(--gold) 40%, transparent)' }}
                            >
                              Your player
                            </span>
                          )}
                        </td>
                        <td style={{ color: 'var(--ink-2)' }}>{row.nationality ?? '—'}</td>
                        <td className="r num" style={{ fontWeight: 600 }}>{row.points.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageShell>
    </AppShell>
  );
}
