'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorldTeamCupDto, PlayerDto, fetchPlayersByIds, fetchWorldClock, fetchWorldTeamCup, WorldClockDto } from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, Hero, Panel, SectionLabel } from '../../components/ui/primitives';
import { flagFor, formatScoreline } from '../../lib/format';

/** The World Team Cup (P8c) — Davis-Cup-style national teams. Compact:
 * each group shows the ties (2 singles + 1 doubles, first to two), then
 * the knockout. */
export default function WorldTeamCupPage() {
  const [clock, setClock] = useState<WorldClockDto | null>(null);
  const [cup, setCup] = useState<WorldTeamCupDto | null>(null);
  const [players, setPlayers] = useState<Map<string, PlayerDto>>(new Map());

  useEffect(() => {
    fetchWorldClock()
      .then(async (c) => {
        setClock(c);
        try {
          const cup = await fetchWorldTeamCup(c.currentWeek.season);
          setCup(cup);
          const ids = new Set<string>();
          cup.teams.forEach((t) => t.players.forEach((id) => ids.add(id)));
          setPlayers(await fetchPlayersByIds(ids));
        } catch {
          setCup(null);
        }
      })
      .catch(() => setClock(null));
  }, []);

  const name = (id: string) => players.get(id)?.name ?? id;

  const rubberLabel = (r: WorldTeamCupDto['groups'][0]['ties'][0]['rubbers'][0], teamA: string, teamB: string) => {
    if (r.kind === 'singles') {
      const sideA = r.playerA ? name(r.playerA) : teamA;
      const sideB = r.playerB ? name(r.playerB) : teamB;
      return r.outcome
        ? `${r.outcome.winner === r.playerA ? sideA : sideB} def. ${r.outcome.winner === r.playerA ? sideB : sideA}`
        : `${sideA} v ${sideB}`;
    }
    const sideA = teamA;
    const sideB = teamB;
    return r.outcome
      ? `${r.outcome.winner === r.pairA ? sideA : sideB} def. ${r.outcome.winner === r.pairA ? sideB : sideA}`
      : `${sideA} v ${sideB}`;
  };

  const renderTie = (tie: WorldTeamCupDto['groups'][0]['ties'][0]) => (
    <div style={{ border: '1px solid var(--gc-line)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
      <div className="flex justify-between text-[12px] font-bold" style={{ color: 'var(--gc-ink)' }}>
        <span>{flagFor(tie.teamA)} {tie.teamA}</span>
        <span style={{ color: 'var(--gc-ink-mute)' }}>{tie.winner ? `won by ${flagFor(tie.winner)} ${tie.winner}` : 'in progress'}</span>
        <span>{tie.teamB} {flagFor(tie.teamB)}</span>
      </div>
      {tie.rubbers.map((r, i) => (
        <div key={i} className="flex justify-between text-[11.5px]" style={{ color: r.outcome ? 'var(--gc-ink-dim)' : 'var(--gc-ink-faint)' }}>
          <span className="truncate">{r.kind === 'doubles' ? 'Doubles · ' : `Singles ${i + 1} · `}{rubberLabel(r, tie.teamA, tie.teamB)}</span>
          <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>{r.outcome ? formatScoreline(r.outcome.setScores, true) : ''}</span>
        </div>
      ))}
    </div>
  );

  return (
    <AppFrame>
      <Sidebar active="tournaments" />
      <div className="flex-1 p-8 max-w-[1000px] min-w-0" style={{ background: 'var(--gc-bg)' }}>
        <Hero surface={cup?.surface ?? null} minHeight={120}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'white', opacity: 0.85 }}>Nations</div>
            <div style={{ fontSize: 30, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4 }}>World Team Cup</div>
            <div style={{ fontSize: 13, color: 'white', opacity: 0.8, marginTop: 4 }}>
              {cup ? `Season ${cup.season} · ties of 2 singles + 1 doubles, first to two` : clock ? `Season ${clock.currentWeek.season}` : ''}
            </div>
          </div>
        </Hero>

        {cup === null && clock && (
          <Panel style={{ padding: 28, textAlign: 'center', marginTop: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)' }}>
              No World Team Cup has been generated for season {clock.currentWeek.season} yet.
            </div>
          </Panel>
        )}

        {cup && (
          <>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 20 }}>
              {cup.groups.map((group, gi) => (
                <Panel key={gi} style={{ padding: 14 }}>
                  <SectionLabel>Group {gi + 1}</SectionLabel>
                  {group.ties.map((tie) => renderTie(tie))}
                </Panel>
              ))}
            </div>
            {cup.hasKnockout && (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 12 }}>
                {cup.knockout.map((round, ri) => (
                  <Panel key={ri} style={{ padding: 14 }}>
                    <SectionLabel>{ri === 0 ? 'Semifinals' : 'Final'}</SectionLabel>
                    {round.map((tie) => renderTie(tie))}
                  </Panel>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--gc-ink-faint)' }}>
              <Link href="/tournaments" style={{ color: 'var(--gc-ball)', textDecoration: 'none' }}>← Back to tournaments</Link>
            </div>
          </>
        )}
      </div>
    </AppFrame>
  );
}
