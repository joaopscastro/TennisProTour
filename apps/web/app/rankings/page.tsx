'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  RankingBand,
  RankingsBoardDto,
  fetchRankings,
  fetchRoster,
} from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, PageShell, Hero, Panel } from '../../components/ui/primitives';
import { AnimatedNumber } from '../../components/ui/motion';
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
    <AppFrame>
      <Sidebar active="rankings" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance} />

      <PageShell wash="radial-gradient(120% 60% at 85% -10%, oklch(50% 0.13 90 / 0.16), transparent 60%)">
        <Hero minHeight={150}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'oklch(88% 0.06 90)', opacity: 0.9 }}>The Full Table</div>
          <div style={{ fontSize: 34, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4, textShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>Player Rankings</div>
          <div style={{ fontSize: 13.5, color: 'oklch(92% 0.01 90)', opacity: 0.85, marginTop: 5, maxWidth: 620, lineHeight: 1.5 }}>
            Senior, U18, U16, and U14 are four separate ladders — each only counts results from its own events, and a player is ranked on whichever ladders their age and results qualify them for. Winning a senior event earns Senior points, not junior ones.
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

        {/* "Where am I?" — the standings answer it directly instead of
            making a manager scan 100 rows and fall back to /managers to
            conclude they are unranked. */}
        {board && myPlayerIds && !error && (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              marginTop: 14, fontSize: 12.5, borderRadius: 10, padding: '10px 14px',
              background: 'oklch(100% 0 0 / 0.03)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink-mute)',
            }}
          >
            <span style={{ lineHeight: 1.5 }}>
              {myPlayerIds.size === 0
                ? 'You have no players yet — sign a free agent in Scouting to start building a ranked roster.'
                : myStandings.length > 0
                  ? `You have ${myStandings.length} player${myStandings.length === 1 ? '' : 's'} in this top-100 table, best #${Math.min(...myStandings.map((r) => r.rank))}.`
                  : `None of your players is in the top 100 of the ${RANK_BAND_LABEL[band]} ladder yet. ${RANKING_EARNED_NOTE} ${rankingBandScopeNote(band)}`}
            </span>
            {myStandings.length > 0 && (
              <button
                onClick={() => setOnlyMine((v) => !v)}
                aria-pressed={onlyMine}
                style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 'none',
                  border: `1px solid ${onlyMine ? 'var(--gc-gold)' : 'var(--gc-line)'}`,
                  background: onlyMine ? 'oklch(70% 0.15 90 / 0.14)' : 'var(--gc-s2)',
                  color: onlyMine ? 'var(--gc-gold)' : 'var(--gc-ink-mute)',
                }}
              >
                {onlyMine ? 'Show all players' : 'Show only my players'}
              </button>
            )}
          </div>
        )}

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, borderRadius: 10, padding: '10px 14px', color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {board && board.standings.length === 0 && !error && (
          <Panel style={{ marginTop: 18, padding: '28px 20px', textAlign: 'center', color: 'var(--gc-ink-mute)', fontSize: 14 }}>
            <div>No player has earned points on the {RANK_BAND_LABEL[band]} ladder yet.</div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--gc-ink-faint)', maxWidth: 560, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
              {rankingBandScopeNote(band)} A player only appears here once they&apos;ve won a match in one of this band&apos;s own events — an empty junior table while U14-badged players have won senior matches is expected, not a bug.
            </div>
          </Panel>
        )}

        {board && onlyMine && visibleStandings.length === 0 && !error && (
          <Panel style={{ marginTop: 18, padding: '24px 20px', textAlign: 'center', color: 'var(--gc-ink-mute)', fontSize: 14 }}>
            <div>None of your players is in the top 100 of the {RANK_BAND_LABEL[band]} ladder.</div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--gc-ink-faint)', lineHeight: 1.5 }}>
              {RANKING_EARNED_NOTE} {rankingBandScopeNote(band)}
            </div>
          </Panel>
        )}

        {board && visibleStandings.length > 0 && (
          <Panel style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--gc-ink-faint)', fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '11px 16px', width: 90 }}>Rank · {RANK_BAND_LABEL[board.band]}</th>
                  <th style={{ padding: '11px 16px' }}>Player</th>
                  <th style={{ padding: '11px 16px' }}>Nationality</th>
                  <th style={{ padding: '11px 16px', textAlign: 'right' }}>Points</th>
                </tr>
              </thead>
              <tbody>
                {visibleStandings.map((row) => {
                  const mine = myPlayerIds?.has(row.playerId) ?? false;
                  return (
                  <tr
                    key={row.playerId}
                    style={{
                      borderTop: '1px solid var(--gc-line)',
                      background: mine ? 'oklch(70% 0.15 90 / 0.08)' : undefined,
                    }}
                  >
                    <td style={{ padding: '11px 16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ color: row.rank <= 3 ? MEDAL[row.rank - 1] : 'var(--gc-ink-mute)' }}>
                        {row.rank <= 3 ? '● ' : ''}#{row.rank}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px', fontWeight: 700 }}>
                      <a href={`/players/${row.playerId}`} style={{ color: 'var(--gc-ink)', textDecoration: 'none' }}>
                        {displayNames.get(row.playerId) ?? row.name}
                      </a>
                      {mine && (
                        <span
                          title="One of your rostered players"
                          style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 5, background: 'oklch(70% 0.15 90 / 0.16)', color: 'var(--gc-gold)' }}
                        >
                          Your player
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '11px 16px', color: 'var(--gc-ink-mute)' }}>{row.nationality ?? '—'}</td>
                    <td style={{ padding: '11px 16px', textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: 'var(--gc-ink-dim)' }}>
                      <AnimatedNumber value={row.points} mountFrom={row.points} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )}
      </PageShell>
    </AppFrame>
  );
}
