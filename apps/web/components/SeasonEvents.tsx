'use client';

import { useEffect, useState } from 'react';
import {
  MastersCupDto,
  PlayerDto,
  WorldClockDto,
  WorldTeamCupDto,
  fetchMastersCup,
  fetchPlayersByIds,
  fetchWorldClock,
  fetchWorldTeamCup,
} from '../lib/api';
import { Panel, SectionLabel } from './ui/primitives';
import { flagFor, formatScoreline } from '../lib/format';

/**
 * The season capstones — Masters Cup (P8b) and World Team Cup (P8c) —
 * rendered together inside the Tournaments page's "Season events" view.
 * They live here, not as their own nav entries, because they are
 * tournaments: the once-a-season highlights of the senior circuit, not
 * a separate top-level area. Both fetch their current season's cup off
 * the world clock, so a season with no generated cup shows the honest
 * "not generated yet" empty state rather than a fabricated bracket.
 */
export function SeasonEvents() {
  const [clock, setClock] = useState<WorldClockDto | null>(null);
  const [masters, setMasters] = useState<MastersCupDto | null>(null);
  const [wtc, setWtc] = useState<WorldTeamCupDto | null>(null);
  const [mastersPlayers, setMastersPlayers] = useState<Map<string, PlayerDto>>(new Map());
  const [wtcPlayers, setWtcPlayers] = useState<Map<string, PlayerDto>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWorldClock()
      .then(async (c) => {
        if (cancelled) return;
        setClock(c);
        const season = c.currentWeek.season;
        const results = await Promise.allSettled([fetchMastersCup(season), fetchWorldTeamCup(season)]);
        if (cancelled) return;
        const m = results[0].status === 'fulfilled' ? results[0].value : null;
        const w = results[1].status === 'fulfilled' ? results[1].value : null;
        setMasters(m);
        setWtc(w);
        // A 404 means "not generated yet" (an expected empty state); any
        // other failure is a real error and must not masquerade as one.
        for (const r of results) {
          if (r.status !== 'rejected') continue;
          const e = r.reason as Error & { status?: number };
          if (e?.status !== 404) {
            setError(e?.message ?? 'Failed to load season events');
            break;
          }
        }
        if (m) {
          const ids = new Set<string>();
          m.singlesEntrants.forEach((id) => ids.add(id));
          m.doublesEntrants.forEach((p) => (ids.add(p.playerA), ids.add(p.playerB)));
          setMastersPlayers(await fetchPlayersByIds(ids));
        }
        if (w) {
          const ids = new Set<string>();
          w.teams.forEach((t) => t.players.forEach((id) => ids.add(id)));
          setWtcPlayers(await fetchPlayersByIds(ids));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Panel style={{ padding: 16, borderColor: 'oklch(60% 0.15 25 / 0.4)' }}>
          <div style={{ fontSize: 13, color: 'oklch(85% 0.12 25)' }}>{error}</div>
        </Panel>
      )}
      <MastersCupSection cup={masters} players={mastersPlayers} hasClock={clock != null} />
      <WorldTeamCupSection cup={wtc} players={wtcPlayers} hasClock={clock != null} />
    </div>
  );
}

function MastersCupSection({ cup, players, hasClock }: { cup: MastersCupDto | null; players: Map<string, PlayerDto>; hasClock: boolean }) {
  const name = (id: string) => players.get(id)?.name ?? id;
  const pairName = (pairId: string) => {
    const p = cup?.doublesEntrants.find((x) => x.pairId === pairId);
    return p ? `${name(p.playerA)} + ${name(p.playerB)}` : pairId;
  };

  return (
    <section>
      <SectionLabel>Masters Cup</SectionLabel>
      {cup === null && hasClock && (
        <Panel style={{ padding: 22, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)' }}>No Masters Cup has been generated for this season yet.</div>
        </Panel>
      )}
      {cup && (
        <>
          {(cup.singlesChampion || cup.doublesChampion) && (
            <Panel style={{ padding: 16, textAlign: 'center', borderColor: 'var(--gc-gold)' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--gc-ink-mute)' }}>Champions</div>
              {cup.singlesChampion && (
                <div style={{ fontSize: 19, fontWeight: 850, color: 'var(--gc-gold)', marginTop: 5 }}>
                  {name(cup.singlesChampion)} <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--gc-ink-mute)' }}>· Singles</span>
                </div>
              )}
              {cup.doublesChampion && (
                <div style={{ fontSize: 19, fontWeight: 850, color: 'var(--gc-gold)', marginTop: 2 }}>
                  {pairName(cup.doublesChampion)} <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--gc-ink-mute)' }}>· Doubles</span>
                </div>
              )}
            </Panel>
          )}
          {(['singles', 'doubles'] as const).map((discipline) => {
            const groups = discipline === 'singles' ? cup.singlesGroups : cup.doublesGroups;
            const knockout = discipline === 'singles' ? cup.singlesKnockout : cup.doublesKnockout;
            const labelOf = discipline === 'singles' ? name : pairName;
            return (
              <div key={discipline} style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-ink)', textTransform: 'capitalize', marginBottom: 8 }}>{discipline}</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
                  {groups.map((group, gi) => {
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
        </>
      )}
    </section>
  );
}

function WorldTeamCupSection({ cup, players, hasClock }: { cup: WorldTeamCupDto | null; players: Map<string, PlayerDto>; hasClock: boolean }) {
  const name = (id: string) => players.get(id)?.name ?? id;

  const rubberLabel = (r: WorldTeamCupDto['groups'][0]['ties'][0]['rubbers'][0], teamA: string, teamB: string) => {
    if (r.kind === 'singles') {
      const sideA = r.playerA ? name(r.playerA) : teamA;
      const sideB = r.playerB ? name(r.playerB) : teamB;
      return r.outcome
        ? `${r.outcome.winner === r.playerA ? sideA : sideB} def. ${r.outcome.winner === r.playerA ? sideB : sideA}`
        : `${sideA} v ${sideB}`;
    }
    return r.outcome
      ? `${r.outcome.winner === r.pairA ? teamA : teamB} def. ${r.outcome.winner === r.pairA ? teamB : teamA}`
      : `${teamA} v ${teamB}`;
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
    <section>
      <SectionLabel>World Team Cup</SectionLabel>
      {cup === null && hasClock && (
        <Panel style={{ padding: 22, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)' }}>No World Team Cup has been generated for this season yet.</div>
        </Panel>
      )}
      {cup && (
        <>
          {cup.champion && (
            <Panel style={{ padding: 16, textAlign: 'center', borderColor: 'var(--gc-gold)' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--gc-ink-mute)' }}>Champion</div>
              <div style={{ fontSize: 21, fontWeight: 850, color: 'var(--gc-gold)', marginTop: 5 }}>
                {flagFor(cup.champion)} {cup.champion}
              </div>
            </Panel>
          )}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 16 }}>
            {cup.groups.map((group, gi) => (
              <Panel key={gi} style={{ padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>Group {gi + 1}</div>
                {group.ties.map((tie) => renderTie(tie))}
              </Panel>
            ))}
          </div>
          {cup.hasKnockout && (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: 12 }}>
              {cup.knockout.map((round, ri) => (
                <Panel key={ri} style={{ padding: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>{ri === 0 ? 'Semifinals' : 'Final'}</div>
                  {round.map((tie) => renderTie(tie))}
                </Panel>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
