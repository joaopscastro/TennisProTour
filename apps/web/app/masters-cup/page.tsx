'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MastersCupDto, PlayerDto, fetchMastersCup, fetchPlayersByIds, fetchWorldClock, WorldClockDto } from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { AppFrame, Hero, Panel, SectionLabel } from '../../components/ui/primitives';
import { formatScoreline } from '../../lib/format';
/** The Masters Cup (P8b) — the season-end capstone, groups → knockout for
 * both singles and doubles. Compact: group standings + knockout brackets,
 * with player/pair names resolved from the involved ids. */
export default function MastersCupPage() {
  const [clock, setClock] = useState<WorldClockDto | null>(null);
  const [cup, setCup] = useState<MastersCupDto | null>(null);
  const [players, setPlayers] = useState<Map<string, PlayerDto>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWorldClock()
      .then(async (c) => {
        setClock(c);
        try {
          const cup = await fetchMastersCup(c.currentWeek.season);
          setCup(cup);
          const ids = new Set<string>();
          cup.singlesEntrants.forEach((id) => ids.add(id));
          cup.doublesEntrants.forEach((p) => (ids.add(p.playerA), ids.add(p.playerB)));
          setPlayers(await fetchPlayersByIds(ids));
        } catch (e) {
          setCup(null);
        }
      })
      .catch(() => setClock(null));
  }, []);

  const name = (id: string) => players.get(id)?.name ?? id;
  const pairName = (pairId: string) => {
    const p = cup?.doublesEntrants.find((x) => x.pairId === pairId);
    return p ? `${name(p.playerA)} + ${name(p.playerB)}` : pairId;
  };

  return (
    <AppFrame>
      <Sidebar active="tournaments" />
      <div className="flex-1 p-8 max-w-[1000px] min-w-0" style={{ background: 'var(--gc-bg)' }}>
        <Hero surface={cup?.surface ?? null} minHeight={120}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'white', opacity: 0.85 }}>Season capstone</div>
            <div style={{ fontSize: 30, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 4 }}>Masters Cup</div>
            <div style={{ fontSize: 13, color: 'white', opacity: 0.8, marginTop: 4 }}>
              {cup ? `Season ${cup.season} · groups of four, top two advance` : clock ? `Season ${clock.currentWeek.season}` : ''}
            </div>
          </div>
        </Hero>

        {cup === null && clock && (
          <Panel style={{ padding: 28, textAlign: 'center', marginTop: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)' }}>
              No Masters Cup has been generated for season {clock.currentWeek.season} yet.
            </div>
          </Panel>
        )}

        {cup && (
          <>
            {['singles', 'doubles'].map((discipline) => {
              const groups = discipline === 'singles' ? cup.singlesGroups : cup.doublesGroups;
              const knockout = discipline === 'singles' ? cup.singlesKnockout : cup.doublesKnockout;
              const labelOf = discipline === 'singles' ? name : pairName;
              return (
                <div key={discipline} style={{ marginTop: 20 }}>
                  <SectionLabel>{discipline === 'singles' ? 'Singles' : 'Doubles'}</SectionLabel>
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
                    {groups.map((group, gi) => {
                      // Standings: wins per entrant.
                      const wins = new Map<string, number>();
                      group.entrants.forEach((e) => wins.set(e, 0));
                      group.matches.forEach((m) => { if (m.outcome) wins.set(m.outcome.winner, (wins.get(m.outcome.winner) ?? 0) + 1); });
                      const ordered = [...group.entrants].sort((a, b) => (wins.get(b) ?? 0) - (wins.get(a) ?? 0));
                      return (
                        <Panel key={gi} style={{ padding: 14 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>Group {gi + 1}</div>
                          {ordered.map((e) => (
                            <div key={e} className="flex justify-between px-[8px] py-[4px] text-[13px]" style={{ color: 'var(--gc-ink)' }}>
                              <span className="truncate">{labelOf(e)}</span>
                              <span className="flex-none text-[12px]" style={{ color: 'var(--gc-ink-mute)' }}>{wins.get(e)} W</span>
                            </div>
                          ))}
                          <div style={{ borderTop: '1px solid var(--gc-line)', margin: '8px 0', opacity: 0.6 }} />
                          {group.matches.map((m, mi) => (
                            <div key={mi} className="flex justify-between gap-2 px-[8px] py-[3px] text-[11.5px]" style={{ color: m.outcome ? 'var(--gc-ink-dim)' : 'var(--gc-ink-faint)' }}>
                              <span className="truncate">
                                {m.outcome ? `${labelOf(m.outcome.winner)} def. ${labelOf(m.outcome.loser)}` : `${labelOf(m.entrantA)} v ${labelOf(m.entrantB)}`}
                              </span>
                              <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>{m.outcome ? formatScoreline(m.outcome.setScores, true) : ''}</span>
                            </div>
                          ))}
                        </Panel>
                      );
                    })}
                  </div>
                  {knockout.length > 0 && (
                    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 12 }}>
                      {knockout.map((round) => (
                        <Panel key={round.roundNumber} style={{ padding: 14 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>
                            {round.roundNumber === 1 ? 'Semifinals' : 'Final'}
                          </div>
                          {round.matches.map((m, mi) => (
                            <div key={mi} className="flex justify-between gap-2 px-[8px] py-[4px] text-[12px]" style={{ color: m.outcome ? 'var(--gc-ink-dim)' : 'var(--gc-ink-faint)' }}>
                              <span className="truncate">
                                {m.outcome ? `${labelOf(m.outcome.winner)} def. ${labelOf(m.outcome.loser)}` : `${labelOf(m.entrantA)} v ${labelOf(m.entrantB)}`}
                              </span>
                              <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>{m.outcome ? formatScoreline(m.outcome.setScores, true) : ''}</span>
                            </div>
                          ))}
                        </Panel>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--gc-ink-faint)' }}>
              <Link href="/tournaments" style={{ color: 'var(--gc-ball)', textDecoration: 'none' }}>← Back to tournaments</Link>
            </div>
          </>
        )}
      </div>
    </AppFrame>
  );
}
