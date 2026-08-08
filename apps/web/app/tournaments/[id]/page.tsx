'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  MatchOutcomeDto,
  PlayerDto,
  TournamentDto,
  WorldClockDto,
  fetchPlayersByIds,
  fetchTournament,
  fetchWorldClock,
  matchIdForSlot,
  simulateMatch,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { flagFor, formatScoreline } from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};
const MUTED = 'oklch(85% 0.008 75)';

const CARD_H = 84;
const GAP0 = 14;
const COL_W = 232;
const GUT_W = 40;
const COLLAPSED_W = 210;

// ---------------------------------------------------------------------------
// Bracket-shape math — mirrors BracketGenerator.seedSlotOrder/orderBySeed
// (packages/domain) so round 1's bye slots can be reconstructed from public
// data (entrants + drawSize) without the backend needing to expose bracket
// placement as its own concept. From round 2 onward, byes never recur (see
// BracketGenerator's doc comment), so no equivalent reconstruction is needed
// there — round r's matches[i] connects directly from round(r-1)'s
// matches[2i] and matches[2i+1].
// ---------------------------------------------------------------------------

function seedSlotOrder(drawSize: number): number[] {
  let order = [1];
  while (order.length < drawSize) {
    const n = order.length;
    const next: number[] = [];
    for (const seed of order) next.push(seed, 2 * n + 1 - seed);
    order = next;
  }
  return order;
}

interface Entrant {
  playerId: string;
  seed: number | null;
}

function orderBySeed(entrants: Entrant[]): Entrant[] {
  return [...entrants].sort((a, b) => {
    if (a.seed === null && b.seed === null) return 0;
    if (a.seed === null) return 1;
    if (b.seed === null) return -1;
    return a.seed - b.seed;
  });
}

function roundLabel(matchesInRound: number): string {
  if (matchesInRound === 1) return 'Final';
  if (matchesInRound === 2) return 'Semifinals';
  if (matchesInRound === 4) return 'Quarterfinals';
  return `Round of ${matchesInRound * 2}`;
}

interface DisplaySlot {
  entrant: Entrant | null;
  isWinner: boolean;
  isLoser: boolean;
  scoreline: string | null;
}

interface DisplayMatch {
  a: DisplaySlot;
  b: DisplaySlot;
  isBye: boolean;
  decided: boolean;
  outcome: MatchOutcomeDto | null;
  /** Real index within that round's dense matches[] array — what the
   * simulate/replay endpoints address by. Only meaningful when this
   * match actually exists server-side (not a not-yet-generated future
   * round placeholder). */
  matchIndex: number | null;
}

interface DisplayRound {
  roundNumber: number;
  label: string;
  matches: DisplayMatch[];
  generated: boolean; // false = round hasn't been created server-side yet
}

function buildDisplayRounds(t: TournamentDto): DisplayRound[] {
  const totalRounds = Math.log2(t.drawSize);
  const seeded = orderBySeed(t.entrants);
  const slots = seedSlotOrder(t.drawSize);
  const entrantForSlot = (slotSeed: number): Entrant | null => (slotSeed <= seeded.length ? seeded[slotSeed - 1] : null);

  const round1Matches = t.rounds.find((r) => r.roundNumber === 1)?.matches ?? [];

  const slotToDisplay = (entrant: Entrant | null, outcome: MatchOutcomeDto | null): DisplaySlot => {
    if (!entrant) return { entrant: null, isWinner: false, isLoser: false, scoreline: null };
    const isWinner = outcome?.winner === entrant.playerId;
    const isLoser = !!outcome && !isWinner;
    return {
      entrant,
      isWinner,
      isLoser,
      scoreline: outcome ? formatScoreline(outcome.setScores, isWinner) : null,
    };
  };

  const round1: DisplayMatch[] = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = entrantForSlot(slots[i]);
    const b = entrantForSlot(slots[i + 1]);
    if (a && b) {
      const idx = round1Matches.findIndex((m) => m.entrantA === a.playerId && m.entrantB === b.playerId);
      const outcome = idx >= 0 ? round1Matches[idx].outcome : null;
      round1.push({
        a: slotToDisplay(a, outcome),
        b: slotToDisplay(b, outcome),
        isBye: false,
        decided: !!outcome,
        outcome,
        matchIndex: idx >= 0 ? idx : null,
      });
    } else if (a || b) {
      const winner = a ?? b;
      round1.push({
        a: slotToDisplay(winner, null),
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: true,
        decided: true,
        outcome: null,
        matchIndex: null,
      });
    } else {
      round1.push({
        a: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: false,
        decided: false,
        outcome: null,
        matchIndex: null,
      });
    }
  }

  const rounds: DisplayRound[] = [{ roundNumber: 1, label: roundLabel(round1.length), matches: round1, generated: true }];

  for (let r = 2; r <= totalRounds; r++) {
    const matchCount = t.drawSize / 2 ** r;
    const serverRound = t.rounds.find((rd) => rd.roundNumber === r);
    if (serverRound) {
      const matches: DisplayMatch[] = serverRound.matches.map((m, idx) => ({
        a: slotToDisplay({ playerId: m.entrantA, seed: null }, m.outcome),
        b: slotToDisplay({ playerId: m.entrantB, seed: null }, m.outcome),
        isBye: false,
        decided: !!m.outcome,
        outcome: m.outcome,
        matchIndex: idx,
      }));
      rounds.push({ roundNumber: r, label: roundLabel(matchCount), matches, generated: true });
    } else {
      const matches: DisplayMatch[] = Array.from({ length: matchCount }, () => ({
        a: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: false,
        decided: false,
        outcome: null,
        matchIndex: null,
      }));
      rounds.push({ roundNumber: r, label: roundLabel(matchCount), matches, generated: false });
    }
  }

  return rounds;
}

function computeGeometry(counts: number[]) {
  const steps: number[] = [];
  const top0s: number[] = [];
  steps[0] = CARD_H + GAP0;
  top0s[0] = 0;
  for (let r = 1; r < counts.length; r++) {
    steps[r] = steps[r - 1] * 2;
    top0s[r] = top0s[r - 1] + steps[r - 1] / 2;
  }
  return { steps, top0s };
}

// ---------------------------------------------------------------------------

export default function TournamentBracketPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params.id;
  const [tournament, setTournament] = useState<TournamentDto | null>(null);
  const [players, setPlayers] = useState<Map<string, PlayerDto>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);

  useEffect(() => {
    fetchWorldClock()
      .then(setWorldClock)
      .catch(() => setWorldClock(null));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await fetchTournament(tournamentId);
      setTournament(t);
      const ids = new Set<string>();
      t.entrants.forEach((e) => ids.add(e.playerId));
      t.rounds.forEach((r) => r.matches.forEach((m) => (ids.add(m.entrantA), ids.add(m.entrantB))));
      setPlayers(await fetchPlayersByIds(ids));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rounds = useMemo(() => (tournament ? buildDisplayRounds(tournament) : []), [tournament]);
  const accent = tournament ? (SURFACE_COLOR[tournament.surface] ?? 'oklch(50% 0.006 75)') : MUTED;

  const counts = rounds.map((r) => r.matches.length);
  const { steps, top0s } = computeGeometry(counts);
  const totalHeight = counts.length > 0 ? (counts[0] - 1) * steps[0] + CARD_H : 0;
  const positions = rounds.map((round, ri) => round.matches.map((_, i) => top0s[ri] + i * steps[ri]));

  async function onSimulate(roundNumber: number, matchIndex: number) {
    const slot = matchIdForSlot(tournamentId, roundNumber, matchIndex);
    setBusy(slot);
    setError(null);
    try {
      await simulateMatch(tournamentId, roundNumber, matchIndex);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function playerLabel(entrant: Entrant | null): { name: string; flag: string; seedLabel: string } {
    if (!entrant) return { name: '', flag: '', seedLabel: '' };
    const p = players.get(entrant.playerId);
    return {
      name: p?.name ?? entrant.playerId,
      flag: p ? flagFor(p.nationality) : '',
      seedLabel: entrant.seed ? `(${entrant.seed})` : '',
    };
  }

  const overallStatus = useMemo(() => {
    if (!tournament) return '';
    const activeRound = rounds.find((r) => r.generated && r.matches.some((m) => !m.decided));
    if (activeRound) return `${activeRound.label} in progress`;
    const lastGenerated = [...rounds].reverse().find((r) => r.generated);
    if (!lastGenerated) return 'Awaiting entrants';
    if (lastGenerated.roundNumber === rounds.length && lastGenerated.matches.every((m) => m.decided)) {
      return 'Tournament complete';
    }
    return `${lastGenerated.label} complete`;
  }, [tournament, rounds]);

  if (error && !tournament) {
    return (
      <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
        <Sidebar active="tournaments" />
        <div className="flex-1 p-8">
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        </div>
      </div>
    );
  }
  if (!tournament) {
    return (
      <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
        <Sidebar active="tournaments" />
        <div className="flex-1 p-8 text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
          Loading bracket…
        </div>
      </div>
    );
  }

  const finalRound = rounds[rounds.length - 1];
  const champDecided = finalRound?.matches[0]?.decided ?? false;
  const champWinner = champDecided ? finalRound.matches[0].outcome?.winner ?? null : null;
  const champLabel = champWinner ? playerLabel({ playerId: champWinner, seed: null }) : null;
  const finalTop = positions[rounds.length - 1]?.[0] ?? 0;
  const finalMid = finalTop + CARD_H / 2;

  return (
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="tournaments" />

      <div className="flex-1 p-8 min-w-0">
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="flex items-center gap-[10px]">
              <div className="text-[23px] font-bold tracking-[-0.2px]">{tournament.id}</div>
              <div
                className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px] text-white"
                style={{ background: accent }}
              >
                {tournament.surface}
              </div>
              {tournament.ageBand && (
                <div
                  className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px]"
                  style={{ background: 'oklch(90% 0.1 240)', color: 'oklch(35% 0.14 240)' }}
                >
                  {tournament.ageBand}
                </div>
              )}
            </div>
            <div className="text-[13.5px] mt-[5px]" style={{ color: 'oklch(48% 0.006 75)' }}>
              Single elimination · {tournament.entrants.length} players · {overallStatus}
            </div>
            {worldClock && (
              <div className="text-[12px] mt-[3px]" style={{ color: 'oklch(58% 0.006 75)' }}>
                Scheduled Season {tournament.weekScheduled.season}, Week {tournament.weekScheduled.week} · current
                Season {worldClock.currentWeek.season}, Week {worldClock.currentWeek.week}
                {/* Deliberately no per-match/round countdown here: match
                    simulation (SimulateDueMatchesUseCase and the manual
                    simulate route) isn't actually gated by weekScheduled
                    vs. the world's currentWeek — see CLAUDE.md — so a
                    fake "starts in Nd" timer would misrepresent how the
                    system really behaves. */}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: 'oklch(48% 0.006 75)' }}>
            <div className="flex items-center gap-[6px]">
              <div className="w-[10px] h-[10px] rounded-[2px]" style={{ background: accent }} />
              Decided path
            </div>
            <div className="flex items-center gap-[6px]">
              <div className="w-[10px] h-[10px] rounded-[2px]" style={{ background: MUTED }} />
              Pending / TBD
            </div>
            <div className="flex items-center gap-[6px]" style={{ color: 'oklch(45% 0.12 240)' }}>
              Decided cards link to match replay →
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        {/* Net-line motif divider */}
        <div className="flex items-center gap-0 my-[18px] mb-[22px]">
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
          <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
        </div>

        <div className="overflow-x-auto pb-4">
          <div className="flex items-start" style={{ width: 'max-content' }}>
            {rounds.map((round, ri) => {
              const decidedCount = round.matches.filter((m) => m.decided).length;
              const allDecided = round.generated && decidedCount === round.matches.length;
              const noneDecided = decidedCount === 0;
              const statusLabel = !round.generated ? 'Upcoming' : allDecided ? 'Decided' : noneDecided ? 'Upcoming' : 'In progress';
              const statusBg = allDecided ? 'oklch(20% 0.006 75)' : noneDecided ? 'transparent' : 'oklch(90% 0.03 60)';
              const statusFg = allDecided ? 'white' : noneDecided ? 'oklch(50% 0.006 75)' : 'oklch(38% 0.08 60)';
              const subtitle = !round.generated
                ? `${round.matches.length} match${round.matches.length === 1 ? '' : 'es'} scheduled`
                : `${decidedCount} of ${round.matches.length} played`;

              const collapsed = allDecided;

              return (
                <div key={round.roundNumber} className="flex items-start">
                  {collapsed ? (
                    <div style={{ width: COLLAPSED_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <div
                            className="text-[10.5px] font-bold tracking-[0.3px] px-[7px] py-[2px] rounded-[4px]"
                            style={{ background: statusBg, color: statusFg }}
                          >
                            {statusLabel}
                          </div>
                        </div>
                        <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <div className="rounded-[8px] bg-white overflow-hidden" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
                        {round.matches.map((m, i) => {
                          const winnerLabel = m.a.isWinner ? playerLabel(m.a.entrant) : playerLabel(m.b.entrant);
                          const loserLabel = m.a.isWinner ? playerLabel(m.b.entrant) : playerLabel(m.a.entrant);
                          const text = m.isBye ? winnerLabel.name : `${winnerLabel.name} def. ${loserLabel.name}`;
                          const score = m.isBye ? 'Bye' : (m.a.isWinner ? m.a.scoreline : m.b.scoreline) ?? '';
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          const row = (
                            <div
                              className="px-[10px] py-[6px] text-[11px] flex justify-between gap-2 whitespace-nowrap overflow-hidden"
                              style={{ borderBottom: i < round.matches.length - 1 ? '1px solid oklch(95% 0.004 75)' : undefined, color: 'oklch(30% 0.006 75)' }}
                            >
                              <span className="overflow-hidden text-ellipsis">{text}</span>
                              <span className="flex-none" style={{ color: 'oklch(52% 0.006 75)' }}>
                                {score}
                              </span>
                            </div>
                          );
                          return slot ? (
                            <Link key={i} href={`/replay/${slot}`} className="block no-underline hover:bg-[oklch(98%_0.006_75)]" style={{ color: 'inherit' }}>
                              {row}
                            </Link>
                          ) : (
                            <div key={i}>{row}</div>
                          );
                        })}
                      </div>
                      <div className="text-[10.5px] mt-[6px] px-1" style={{ color: 'oklch(52% 0.006 75)' }}>
                        Collapses automatically once decided — keeps large draws from growing the page taller.
                      </div>
                    </div>
                  ) : (
                    <div style={{ width: COL_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <div
                            className="text-[10.5px] font-bold tracking-[0.3px] px-[7px] py-[2px] rounded-[4px]"
                            style={noneDecided ? { border: '1px solid oklch(85% 0.006 75)', color: statusFg } : { background: statusBg, color: statusFg }}
                          >
                            {statusLabel}
                          </div>
                        </div>
                        <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <div className="relative" style={{ height: totalHeight }}>
                        {round.matches.map((m, i) => {
                          const top = positions[ri][i];
                          const aLabel = playerLabel(m.a.entrant);
                          const bLabel = playerLabel(m.b.entrant);
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          const canSimulate = !m.isBye && m.a.entrant && m.b.entrant && !m.decided && m.matchIndex !== null;
                          const isBusy = slot !== null && busy === slot;

                          const cardInner = (
                            <>
                              {m.isBye && (
                                <div
                                  className="absolute -top-2 right-2 text-[9px] font-bold tracking-[0.4px] uppercase px-[6px] py-[1px] rounded-[3px]"
                                  style={{ background: 'oklch(96% 0.003 75)', border: '1px solid oklch(85% 0.006 75)', color: 'oklch(50% 0.006 75)' }}
                                >
                                  Bye
                                </div>
                              )}
                              <div className="flex items-center justify-between px-[10px] py-[7px] flex-1">
                                <div className="flex items-center gap-[7px] min-w-0">
                                  {m.a.entrant ? (
                                    <>
                                      <span className="flex-none">{aLabel.flag}</span>
                                      <div
                                        className="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                                        style={{
                                          fontWeight: m.a.isWinner ? 700 : 500,
                                          color: m.a.isWinner ? 'oklch(20% 0.006 75)' : m.a.isLoser ? 'oklch(60% 0.006 75)' : 'oklch(28% 0.006 75)',
                                        }}
                                      >
                                        {aLabel.name} <span style={{ color: 'oklch(55% 0.006 75)', fontWeight: 400 }}>{aLabel.seedLabel}</span>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-[13px]" style={{ color: 'oklch(65% 0.006 75)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </div>
                                  )}
                                </div>
                                {m.a.isWinner && m.a.scoreline && (
                                  <div className="text-[11px] font-semibold [font-variant-numeric:tabular-nums]" style={{ color: 'oklch(30% 0.006 75)' }}>
                                    {m.a.scoreline}
                                  </div>
                                )}
                              </div>
                              <div className="h-px mx-[10px]" style={{ background: 'oklch(93% 0.005 75)' }} />
                              <div className="flex items-center justify-between px-[10px] py-[7px] flex-1">
                                <div className="flex items-center gap-[7px] min-w-0">
                                  {m.b.entrant ? (
                                    <>
                                      <span className="flex-none">{bLabel.flag}</span>
                                      <div
                                        className="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                                        style={{
                                          fontWeight: m.b.isWinner ? 700 : 500,
                                          color: m.b.isWinner ? 'oklch(20% 0.006 75)' : m.b.isLoser ? 'oklch(60% 0.006 75)' : 'oklch(28% 0.006 75)',
                                        }}
                                      >
                                        {bLabel.name} <span style={{ color: 'oklch(55% 0.006 75)', fontWeight: 400 }}>{bLabel.seedLabel}</span>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-[13px]" style={{ color: 'oklch(65% 0.006 75)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </div>
                                  )}
                                </div>
                                {m.b.isWinner && m.b.scoreline && (
                                  <div className="text-[11px] font-semibold [font-variant-numeric:tabular-nums]" style={{ color: 'oklch(30% 0.006 75)' }}>
                                    {m.b.scoreline}
                                  </div>
                                )}
                              </div>
                              {canSimulate && (
                                <div className="px-[10px] pb-[8px]">
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      void onSimulate(round.roundNumber, m.matchIndex!);
                                    }}
                                    disabled={isBusy}
                                    className="w-full text-white border-none py-[5px] rounded-[5px] text-[10.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-60"
                                    style={{ background: 'oklch(20% 0.006 75)' }}
                                  >
                                    {isBusy ? 'Simulating…' : 'Simulate'}
                                  </button>
                                </div>
                              )}
                            </>
                          );

                          const cardStyle: React.CSSProperties = {
                            position: 'absolute',
                            top,
                            left: 0,
                            width: COL_W,
                            minHeight: CARD_H,
                            background: 'white',
                            border: '1px solid oklch(90% 0.005 75)',
                            borderTop: `3px solid ${accent}`,
                            borderRadius: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                          };

                          return slot && m.decided ? (
                            <Link
                              key={i}
                              href={`/replay/${slot}`}
                              className="block no-underline hover:opacity-95"
                              style={{ ...cardStyle, color: 'inherit', cursor: 'pointer' }}
                            >
                              {cardInner}
                            </Link>
                          ) : (
                            <div key={i} className="relative" style={cardStyle}>
                              {cardInner}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Gutter to next column */}
                  {ri < rounds.length - 1 && (
                    <div style={{ width: GUT_W, flexShrink: 0 }}>
                      <div className="h-14" />
                      <div className="relative" style={{ height: totalHeight }}>
                        {collapsed || !rounds[ri + 1].generated ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: GUT_W,
                              height: totalHeight,
                              background: accent,
                              opacity: 0.35,
                              clipPath: 'polygon(0 8%, 100% 38%, 100% 62%, 0 92%)',
                            }}
                          />
                        ) : (
                          round.matches.map((_, i) => {
                            if (i % 2 !== 0) return null;
                            const midA = positions[ri][i] + CARD_H / 2;
                            const midB = positions[ri][i + 1] + CARD_H / 2;
                            const midTarget = positions[ri + 1][i / 2] + CARD_H / 2;
                            const aDecided = round.matches[i].decided;
                            const bDecided = round.matches[i + 1]?.decided ?? false;
                            const gmid = GUT_W / 2;
                            const colA = aDecided ? accent : MUTED;
                            const colB = bDecided ? accent : MUTED;
                            const colTarget = aDecided && bDecided ? accent : MUTED;
                            return (
                              <div key={i}>
                                <div style={{ position: 'absolute', left: 0, top: midA - 1, width: gmid, height: 2, background: colA }} />
                                <div style={{ position: 'absolute', left: 0, top: midB - 1, width: gmid, height: 2, background: colB }} />
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: gmid - 1,
                                    top: Math.min(midA, midB),
                                    width: 2,
                                    height: Math.abs(midB - midA),
                                    background: colTarget,
                                  }}
                                />
                                <div style={{ position: 'absolute', left: gmid, top: midTarget - 1, width: gmid, height: 2, background: colTarget }} />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Champion */}
            {rounds.length > 0 && (
              <div className="flex items-start">
                <div style={{ width: GUT_W, flexShrink: 0 }}>
                  <div className="h-14" />
                  <div className="relative" style={{ height: totalHeight }}>
                    <div style={{ position: 'absolute', left: 0, top: finalMid - 1, width: GUT_W, height: 2, background: champDecided ? accent : MUTED }} />
                  </div>
                </div>
                <div style={{ width: COL_W, flexShrink: 0 }}>
                  <div className="h-14 flex items-start px-1">
                    <div className="text-[13px] font-bold">Champion</div>
                  </div>
                  <div className="relative" style={{ height: totalHeight }}>
                    <div
                      style={{
                        position: 'absolute',
                        top: finalTop,
                        left: 0,
                        width: COL_W,
                        minHeight: CARD_H,
                        background: 'white',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: champDecided ? `1px solid ${accent}` : '1.5px dashed oklch(85% 0.006 75)',
                      }}
                    >
                      {champDecided && champLabel ? (
                        <div className="flex items-center gap-2 p-3">
                          <span>{champLabel.flag}</span>
                          <div className="font-bold text-[14px]">{champLabel.name}</div>
                        </div>
                      ) : (
                        <div className="text-[12px] font-semibold tracking-[0.4px] uppercase" style={{ color: 'oklch(60% 0.006 75)' }}>
                          TBD
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
