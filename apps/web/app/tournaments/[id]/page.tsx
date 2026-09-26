'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  MatchOutcomeDto,
  PlayerDto,
  RosterDashboardEntryDto,
  TournamentDto,
  WorldClockDto,
  fetchPlayerProfile,
  fetchPlayersByIds,
  fetchRosterDashboard,
  fetchTournament,
  fetchWorldClock,
  matchIdForSlot,
  registerDoublesEntrant,
} from '../../../lib/api';
import { AppShell } from '../../../components/ui/AppShell';
import { SinglesEntryPanel } from '../../../components/SinglesEntryPanel';
import { Badge, Button, Flag, PageShell, Panel, PanelHeader } from '../../../components/ui/primitives';
import { Icon } from '../../../components/ui/Icon';
import { CelebrationMoment, CelebrationOverlay } from '../../../components/ui/Celebration';
import { surfaceMeta, SURFACE_COLOR } from '../../../lib/ui/surfaces';
import { disambiguatedNames, formatMoney, formatScoreline } from '../../../lib/format';
import { roundCollapsed, roundStatus, roundSubtitle, tournamentHeadline } from '../../../lib/bracketStatus';
import { championRevealed, matchAirState, matchAirStateForDto, matchState } from '../../../lib/matchAir';
import { useDevManagerId } from '../../../lib/managerContext';
import { useEntitlement } from '../../../lib/entitlement';

const MUTED = 'var(--ink-4)';

// ---------------------------------------------------------------------------
// Bracket geometry. These four constants ARE the layout: computeGeometry
// below turns them into absolute card positions, and they are also injected
// as CSS custom properties on the bracket container (BRACKET_VARS) so the
// `.gc-match` card's own width/height/row metrics can never drift from the
// math that positions it.
// ---------------------------------------------------------------------------
const CARD_H = 84;
const GAP0 = 14;
const COL_W = 232;
const GUT_W = 40;
const COLLAPSED_W = 210;
const MROW_H = 30;
const MFOOT_H = 26;

/** The geometry constants, published to CSS on the bracket container. */
const BRACKET_VARS = {
  ['--bracket-card-h' as string]: `${CARD_H}px`,
  ['--bracket-col-w' as string]: `${COL_W}px`,
  ['--bracket-gut-w' as string]: `${GUT_W}px`,
  ['--bracket-mrow-h' as string]: `${MROW_H}px`,
  ['--bracket-mfoot-h' as string]: `${MFOOT_H}px`,
};

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

function tierLabel(tier: string): string {
  if (/^j\d+$/.test(tier)) return tier.toUpperCase();
  if (tier === 'juniorMasters') return 'Junior Masters';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** One result line inside a compact results list (qualifying, doubles,
 * doubles qualifying, collapsed bracket rounds) — the ONE row renderer for
 * all four panels. The "what does this row say / is it a link" decision
 * stays with the caller (each caller keeps its own air-state predicate);
 * this component only draws the row. An aired row is a replay link; a row
 * that has not aired is never a link (see lib/matchAir). */
function MatchResultRow({
  text,
  score,
  aired,
  href = null,
  suffix,
}: {
  text: string;
  score: string;
  aired: boolean;
  href?: string | null;
  suffix?: React.ReactNode;
}) {
  return (
    <tr className={href ? 'gc-rowlink' : undefined}>
      <td className="gc-flushcell" colSpan={2} style={{ color: aired ? 'var(--ink-2)' : 'var(--ink-4)' }}>
        {href ? (
          <a className="gc-rowlink-inner" href={href}>
            <span className="gc-result-text">
              {text}
              {suffix}
            </span>
            <span className="gc-result-score">{score}</span>
          </a>
        ) : (
          <div className="gc-rowlink-inner">
            <span className="gc-result-text">
              {text}
              {suffix}
            </span>
            <span className="gc-result-score">{score}</span>
          </div>
        )}
      </td>
    </tr>
  );
}

/** A compact result list (one table per round) built from MatchResultRow. */
function ResultList({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--hair)' }}>
      <table className="gc-table gc-table--dense gc-table--fixed">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Tournament "profile" details — circuit, level, the points and prize
 * ladders, and the logistical facts. Rendered both before the draw is
 * made (in place of the useless blank bracket) and alongside it during
 * play, so the profile is always available. Pure presentation. */
function TournamentDetailsPanel({ tournament }: { tournament: TournamentDto }) {
  const th = surfaceMeta(tournament.surface);
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Circuit', value: tournament.circuit === 'junior' ? `Junior${tournament.ageBand ? ` · ${tournament.ageBand.toUpperCase()}` : ''}` : 'Senior tour' },
    { label: 'Level', value: tierLabel(tournament.tier) },
    { label: 'Surface', value: <span style={{ textTransform: 'capitalize' }}>{tournament.surface}</span> },
    { label: 'Draw', value: `${tournament.drawSize} players` },
    { label: 'Host', value: tournament.hostCountry ? (
      <>
        <Icon name="house" size={12} title="Host country — a player of this nationality has home advantage here" style={{ verticalAlign: 'text-bottom' }} />
        {' '}{tournament.hostCountry}
      </>
    ) : '—' },
    { label: 'Scheduled', value: `S${tournament.weekScheduled.season} W${tournament.weekScheduled.week}` },
  ];
  if (tournament.qualifierSlots > 0) {
    facts.push({ label: 'Qualifiers', value: `${tournament.qualifierSlots} [Q] slots` });
    facts.push({
      label: 'Qualifying draw',
      value: `${tournament.qualifyingDrawSize} players · ${tournament.qualifyingRoundCount} rounds`,
    });
  }
  return (
    <Panel style={{ overflow: 'hidden' }}>
      <PanelHeader right={`${tournament.drawSize} draw`}>Tournament details</PanelHeader>
      <div style={{ padding: 16 }}>
        <dl className="gc-dl">
          {facts.map((f) => (
            <FragmentRow key={f.label} label={f.label} value={f.value} />
          ))}
        </dl>

        <div className="t-label" style={{ margin: '16px 0 6px' }}>
          Ranking points by result
        </div>
        <div className="rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--hair)' }}>
          <table className="gc-table gc-table--dense gc-table--static">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="r">Points</th>
              </tr>
            </thead>
            <tbody>
              {tournament.pointsBreakdown.map((row) => {
                const isChampion = row.stageLabel === 'Champion';
                const zero = row.points === 0;
                return (
                  <tr key={row.matchesWon} style={isChampion ? { background: 'var(--bg-3)' } : undefined}>
                    <td style={{ color: zero ? 'var(--ink-4)' : 'var(--ink-2)', fontWeight: isChampion ? 700 : undefined }}>
                      {isChampion && <Icon name="star" size={11} style={{ color: 'var(--accent)' }} />}
                      {isChampion ? ' ' : ''}{row.stageLabel}
                    </td>
                    <td className="r num" style={{ fontWeight: 600, color: zero ? 'var(--ink-4)' : 'var(--ink)' }}>
                      {zero ? 'No points' : `${row.points.toLocaleString()} pts`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="gc-tbl-note" style={{ padding: '8px 0 0' }}>
          A ranking is earned by winning — a first-round loss pays no points.
        </div>
        {/* Prose-as-UI: the rule one-liner stays visible above; the longer
            scoring/entry explanation lives here, directly under the table it
            explains, openable without a hover. */}
        <details className="gc-details" style={{ marginTop: 8 }}>
          <summary>Scoring &amp; entry rules</summary>
          <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.6 }}>
            Points scale to this tournament&apos;s {tournament.drawSize}-player draw.
            {tournament.pointsArePlaceholder && ' Note: this tier\u2019s point values are a provisional placeholder, not a sourced figure.'}
            {tournament.obligatory
              ? ' This is a mandatory event: a top-100 player counts it toward their ranking even if they skip it \u2014 a skipped edition records a zero that still uses one of their counted results.'
              : ''}
            {tournament.qualifierSlots > 0
              ? ` Players outside the top 100 aren\u2019t accepted directly here \u2014 they enter the ${tournament.qualifyingDrawSize}-player qualifying draw and must win ${tournament.qualifyingRoundCount} rounds to claim one of the ${tournament.qualifierSlots} reserved main-draw places. Qualifying wins pay only a small amount of points; the real prize is the main-draw place.`
              : ''}
          </div>
        </details>

        <div className="t-label" style={{ margin: '16px 0 6px' }}>
          Prize money by result
        </div>
        <div className="rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--hair)' }}>
          <table className="gc-table gc-table--dense gc-table--static">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="r">Prize</th>
              </tr>
            </thead>
            <tbody>
              {tournament.prizeMoneyBreakdown.map((row) => {
                const isChampion = row.stageLabel === 'Champion';
                const zero = row.prizeMoney === 0;
                return (
                  <tr key={row.matchesWon} style={isChampion ? { background: 'var(--bg-3)' } : undefined}>
                    <td style={{ color: zero ? 'var(--ink-4)' : 'var(--ink-2)', fontWeight: isChampion ? 700 : undefined }}>
                      {isChampion && <Icon name="star" size={11} style={{ color: 'var(--accent)' }} />}
                      {isChampion ? ' ' : ''}{row.stageLabel}
                    </td>
                    <td className="r num" style={{ fontWeight: 600, color: zero ? 'var(--ink-4)' : 'var(--ink)' }}>
                      {zero ? 'No prize money' : formatMoney(row.prizeMoney)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="gc-tbl-note" style={{ padding: '8px 0 0' }}>
          {tournament.circuit === 'junior'
            ? 'Junior events are an amateur development circuit and do not pay cash prize money.'
            : "Unlike ranking points, a first-round loss still pays real prize money \u2014 you're paid to play, ranked to win."}
        </div>
      </div>
    </Panel>
  );
}

/** One `<dt>/<dd>` pair (a fragment, so the `.gc-dl` grid spans both). */
function FragmentRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** The registered-entrant list — deliberately HUMAN-managed players
 * only (managerId != null). Fill-only/free-agent players that pad a
 * draw at start time are never real "entries" a manager chose, so they
 * never appear here. Rendered before and during the tournament. */
function EntryList({
  tournament,
  players,
  draw = 'main',
}: {
  tournament: TournamentDto;
  players: Map<string, PlayerDto>;
  /** Which field to list. 'qualifying' lists the players still trying to
   * win their way in; 'main' lists the main draw (including any
   * qualifier who already came through, still tagged [Q]). */
  draw?: 'main' | 'qualifying';
}) {
  const humanEntrants = tournament.entrants
    .filter((e) => e.draw === draw)
    .map((e) => ({ entrant: e, player: players.get(e.playerId) }))
    .filter((x): x is { entrant: TournamentDto['entrants'][number]; player: PlayerDto } => !!x.player && x.player.managerId != null)
    .sort((a, b) => {
      if (a.entrant.seed === null && b.entrant.seed === null) return a.player.name.localeCompare(b.player.name);
      if (a.entrant.seed === null) return 1;
      if (b.entrant.seed === null) return -1;
      return a.entrant.seed - b.entrant.seed;
    });

  return (
    <Panel style={{ overflow: 'hidden' }}>
      <PanelHeader right={`${humanEntrants.length} entered by manager${humanEntrants.length === 1 ? '' : 's'}`}>
        {draw === 'qualifying' ? 'Qualifying entry list' : 'Entry list'}
      </PanelHeader>
      <div style={{ padding: 16 }}>
        <div className="t-body-sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {draw === 'qualifying'
            ? `Players competing for ${tournament.qualifierSlots} main-draw place(s). This list is separate from the draw's fill.`
            : "Players entered by managers. This is a separate figure from the draw's fill below — once a tournament starts, its bracket is padded to full with unmanaged free agents."}
          {tournament.hasStarted && ' Those fillers are badged “Free agent” in the bracket.'}
        </div>
        {humanEntrants.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--ink-4)', padding: '14px 4px', lineHeight: 1.5 }}>
            {tournament.hasStarted
              ? 'No managers have entered a player yet — this draw is padded with unmanaged free agents, which is why the header still shows a full draw.'
              : 'No managers have entered a player yet.'}
          </div>
        ) : (
          <div className="rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--hair)' }}>
            <table className="gc-table gc-table--dense gc-table--static gc-table--fixed">
              <thead>
                <tr>
                  <th className="r" style={{ width: 52 }}>Seed</th>
                  <th>Player</th>
                  <th style={{ width: 72 }}>Entry</th>
                  <th className="r" style={{ width: 64 }}>Open</th>
                </tr>
              </thead>
              <tbody>
                {humanEntrants.map(({ entrant, player }) => (
                  <tr key={entrant.playerId} className="gc-rowlink">
                    <td className="r num" style={{ width: 52, color: 'var(--ink-3)' }}>
                      {entrant.seed ? `#${entrant.seed}` : '—'}
                    </td>
                    <td>
                      {/* Plain `<a>` for immediate navigation (the dead-click
                          fix); the anchor covers the whole row. */}
                      <a className="gc-pcell gc-rowcover" href={`/players/${encodeURIComponent(entrant.playerId)}`}>
                        <Flag code={player.nationality} title={player.nationality} />
                        <span className="nm">{player.name}</span>
                      </a>
                    </td>
                    <td>
                      {entrant.entryType === 'Q' && (
                        <Badge className="gc-badge--q" title="Qualifier — came through qualifying rather than being accepted directly by ranking">[Q]</Badge>
                      )}
                      {entrant.entryType === 'WC' && (
                        <Badge className="gc-badge--wc" title="Wild card — awarded a main-draw place independent of ranking">[WC]</Badge>
                      )}
                      {entrant.entryType === 'DA' && <Badge className="gc-badge--da">DA</Badge>}
                    </td>
                    <td className="r" style={{ color: 'var(--ink-4)' }}>View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}


/** The qualifying draw, as a compact results grid rather than a second
 * graphical bracket: a qualifying event is a preliminary, and its only
 * outcome that matters to the main draw is WHO came through. Rows link
 * to the replay exactly like a decided main-draw match does, so nothing
 * about it is less inspectable — it just isn't given the same visual
 * weight as the tournament proper. */
function QualifyingPanel({
  tournament,
  players,
  tournamentId,
  now,
}: {
  tournament: TournamentDto;
  players: Map<string, PlayerDto>;
  tournamentId: string;
  /** The page's ticking wall clock, so a decided-but-not-yet-aired
   * qualifying match never shows its score before its premiere (the exact
   * leak this panel had — it read `match.outcome` directly while the
   * replay page correctly said "Premieres at …"). */
  now: number;
}) {
  // Disambiguated against every player in this tournament, so two entrants
  // who share a full name still read as two distinct people (see
  // disambiguatedNames). Cheap: one pass over the tournament's players.
  const names = disambiguatedNames(players.values());
  const nameOf = (playerId: string) => names.get(playerId) ?? players.get(playerId)?.name ?? playerId;
  const qualifiers = new Set(
    tournament.entrants.filter((e) => e.draw === 'main' && e.entryType === 'Q').map((e) => e.playerId),
  );

  return (
    <Panel style={{ overflow: 'hidden', marginBottom: 24 }}>
      <PanelHeader
        right={
          <span style={{ color: tournament.qualifyingComplete ? 'var(--win)' : 'var(--warn)' }}>
            {tournament.qualifyingComplete ? 'Complete' : 'In progress'}
          </span>
        }
      >
        Qualifying
      </PanelHeader>
      <div style={{ padding: 16 }}>
        <div className="t-body-sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {tournament.qualifyingDrawSize} players, {tournament.qualifyingRoundCount} rounds, for{' '}
          {tournament.qualifierSlots} main-draw place(s). Played on the tournament's opening days, before the main draw is
          made.
        </div>
        <div className="gc-qgrid">
          {tournament.qualifyingRounds.map((round) => {
            const isFinalQualifyingRound = round.roundNumber === tournament.qualifyingRoundCount;
            return (
              <div key={round.roundNumber}>
                <div className="t-label" style={{ marginBottom: 6 }}>
                  {isFinalQualifyingRound ? 'Final qualifying round' : `Qualifying round ${round.roundNumber}`}
                </div>
                <ResultList>
                  {round.matches.map((match, i) => {
                    // One shared air predicate for every draw (lib/matchAir) —
                    // the score is only shown once the match has actually aired;
                    // until then the row reads "v" (or a countdown) exactly like
                    // the main bracket, so the bracket and the replay page can
                    // never disagree about whether this match has premiered.
                    const airState = matchAirStateForDto(match, now);
                    const aired = airState === 'aired' && match.outcome != null;
                    const winner = aired ? match.outcome!.winner : null;
                    const loser = aired ? match.outcome!.loser : null;
                    const text = aired
                      ? `${nameOf(winner!)} def. ${nameOf(loser!)}`
                      : `${nameOf(match.entrantA)} v ${nameOf(match.entrantB)}`;
                    const score = aired
                      ? formatScoreline(match.outcome!.setScores, true)
                      : !match.outcome
                        ? 'Pending'
                        : airState === 'live'
                          ? 'Live now'
                          : `Starts in ${formatCountdown(new Date(match.scheduledStartAt!).getTime() - now)}`;
                    const cameThrough = aired && winner !== null && qualifiers.has(winner);
                    return (
                      <MatchResultRow
                        key={i}
                        text={text}
                        score={score}
                        aired={aired}
                        href={aired ? `/replay/${matchIdForSlot(tournamentId, round.roundNumber, i, 'qualifying')}` : null}
                        suffix={cameThrough && (
                          <span
                            title="Came through qualifying \u2014 promoted into the main draw"
                            style={{ marginLeft: 6, fontWeight: 800, color: 'var(--ink-3)' }}
                          >
                            [Q]
                          </span>
                        )}
                      />
                    );
                  })}
                </ResultList>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
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
  /** The match's scheduled reveal start (ISO) — null before it's
   * simulated. Drives the "starts in X" countdown and the live/decided
   * transition (see matchRevealSeconds on the tournament). */
  scheduledStartAt: string | null;
  /** Real-time seconds this match's reveal occupies (0 = not scheduled). */
  revealSeconds: number;
}

interface DisplayRound {
  roundNumber: number;
  label: string;
  matches: DisplayMatch[];
  generated: boolean; // false = round hasn't been created server-side yet
}

function buildDisplayRounds(t: TournamentDto): DisplayRound[] {
  const totalRounds = Math.log2(t.drawSize);
  // Main-draw entrants ONLY: a qualifying loser stays in the 'qualifying'
  // draw forever and must never appear in the main bracket's seed order.
  // A non-qualifying tournament has every entrant in 'main', so this
  // filter is a no-op there.
  const seeded = orderBySeed(t.entrants.filter((e) => e.draw === 'main'));
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
        scheduledStartAt: idx >= 0 ? round1Matches[idx].scheduledStartAt : null,
        revealSeconds: idx >= 0 ? round1Matches[idx].revealSeconds : 0,
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
        scheduledStartAt: null,
        revealSeconds: 0,
      });
    } else {
      round1.push({
        a: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: false,
        decided: false,
        outcome: null,
        matchIndex: null,
        scheduledStartAt: null,
        revealSeconds: 0,
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
        scheduledStartAt: m.scheduledStartAt,
        revealSeconds: m.revealSeconds,
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
        scheduledStartAt: null,
        revealSeconds: 0,
      }));
      rounds.push({ roundNumber: r, label: roundLabel(matchCount), matches, generated: false });
    }
  }

  return rounds;
}

// The air-state predicate lives in lib/matchAir.ts now, shared with the
// replay page so the two views can never disagree about "has this match
// aired" (see that file's doc comment).

/** "3:27"-style countdown to a future instant; never negative. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);
  const firedTitleRef = useRef(false);

  // Ticking wall-clock for the staggered-schedule countdowns ("starts in
  // X:XX" → "live" → decided). One cheap 1s interval; only matters while a
  // match is upcoming or live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Doubles solo entry (P7b) — pick one of my players to sign up into
  // this tournament's doubles field (paired at draw formation).
  const devManagerId = useDevManagerId() ?? '';
  // Persistent chrome consistency: every screen with a manager context shows
  // the XP balance. This page has one (it registers players), so read the
  // same shared entitlement source the rest of the app uses.
  const { entitlement } = useEntitlement(devManagerId);
  const [doublesRoster, setDoublesRoster] = useState<RosterDashboardEntryDto[] | null>(null);
  const [doublesPick, setDoublesPick] = useState<string | null>(null);
  const [doublesBusy, setDoublesBusy] = useState(false);
  const [doublesNotice, setDoublesNotice] = useState<string | null>(null);
  const [doublesError, setDoublesError] = useState<string | null>(null);

  const openDoublesEntry = useCallback(async () => {
    setDoublesError(null);
    if (doublesRoster === null) {
      try {
        setDoublesRoster(await fetchRosterDashboard(devManagerId));
      } catch (e) {
        setDoublesError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [devManagerId, doublesRoster]);

  async function submitDoublesEntry() {
    if (!doublesPick) return;
    setDoublesBusy(true);
    setDoublesError(null);
    try {
      await registerDoublesEntrant(tournamentId, doublesPick, devManagerId);
      setDoublesPick(null);
      setDoublesNotice('Player signed up for doubles.');
      await load();
    } catch (e) {
      setDoublesError(e instanceof Error ? e.message : String(e));
    } finally {
      setDoublesBusy(false);
    }
  }

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
      t.qualifyingRounds.forEach((r) => r.matches.forEach((m) => (ids.add(m.entrantA), ids.add(m.entrantB))));
      setPlayers(await fetchPlayersByIds(ids));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rounds = useMemo(() => (tournament ? buildDisplayRounds(tournament) : []), [tournament]);
  // The ONE disambiguation map for every name this page renders (main
  // bracket, qualifying, doubles) — duplicate full names in the same draw
  // are the "Amara Yamamoto v Amara Yamamoto" ambiguity, fixed by a short
  // stable suffix on the colliding names only.
  const displayNames = useMemo(() => disambiguatedNames(players.values()), [players]);
  const accent = tournament ? (SURFACE_COLOR[tournament.surface] ?? MUTED) : MUTED;

  const counts = rounds.map((r) => r.matches.length);
  const { steps, top0s } = computeGeometry(counts);
  const totalHeight = counts.length > 0 ? (counts[0] - 1) * steps[0] + CARD_H : 0;
  const positions = rounds.map((round, ri) => round.matches.map((_, i) => top0s[ri] + i * steps[ri]));

  // The champion is revealed ONLY once the final has AIRED — the one
  // `matchState` predicate (lib/matchAir) every view reads, never a bespoke
  // "is it decided" test. This single value drives the hero copy, the
  // champion banner AND the title celebration below, so a decided-but-still-
  // revealing final can never crown anyone (the exact bug: a "lifts the
  // trophy" hero and a "FIRST TITLE" popup while the final read "Live now").
  const finalRoundGate = rounds[rounds.length - 1];
  const finalMatchGate = finalRoundGate?.matches[0] ?? null;
  const champDecided = !!finalMatchGate && championRevealed(finalMatchGate, now);

  // Title-win celebration (GC-16): fires ONLY once the final has aired (the
  // same gate as the banner). Re-fetches the tournament fresh, then reads the
  // champion's profile to tell a maiden title from a repeat one
  // (titles.length === 1). fire-once guarded so a reload never re-fires it.
  const detectTitle = useCallback(async () => {
    if (firedTitleRef.current) return;
    try {
      const t = await fetchTournament(tournamentId);
      const dr = buildDisplayRounds(t);
      const fr = dr[dr.length - 1];
      const fm = fr?.matches[0];
      // Aired, not merely decided — the final must be viewable before the
      // title is celebrated.
      if (!fm || matchState(fm, Date.now()) !== 'aired') return;
      const winner = fm.outcome?.winner;
      if (!winner) return;
      firedTitleRef.current = true;
      const [prof, pl] = await Promise.all([
        fetchPlayerProfile(winner).catch(() => null),
        fetchPlayersByIds(new Set([winner])).catch(() => new Map<string, PlayerDto>()),
      ]);
      const name = prof?.name ?? pl.get(winner)?.name ?? winner;
      const nationality = prof?.nationality ?? pl.get(winner)?.nationality ?? '';
      setCelebrations([
        {
          kind: 'title',
          firstCareer: (prof?.titles.length ?? 0) <= 1,
          playerId: winner,
          playerName: name,
          nationality,
          tournamentName: t.name,
          surface: t.surface,
        },
      ]);
    } catch {
      /* celebration is best-effort chrome; never block the bracket on it */
    }
  }, [tournamentId]);

  // The title celebration used to be triggered by the manual "Simulate"
  // button. That control is an operator/dev override and was removed from the
  // player-facing bracket (its route is now admin-gated), so the celebration
  // now reacts to the loaded tournament instead — and specifically to the
  // final having AIRED (`champDecided`), so it can fire the moment the reveal
  // completes rather than only at load.
  useEffect(() => {
    if (champDecided) void detectTitle();
  }, [champDecided, detectTitle]);

  function playerLabel(entrant: Entrant | null): { name: string; flag: React.ReactNode; seedLabel: string; fillOnly: boolean } {
    if (!entrant) return { name: '', flag: null, seedLabel: '', fillOnly: false };
    const p = players.get(entrant.playerId);
    return {
      name: displayNames.get(entrant.playerId) ?? p?.name ?? entrant.playerId,
      flag: p ? <Flag code={p.nationality} title={p.nationality} /> : null,
      seedLabel: entrant.seed ? `(${entrant.seed})` : '',
      fillOnly: p?.fillOnly ?? false,
    };
  }

  const overallStatus = useMemo(() => {
    if (!tournament) return '';
    if (tournament.cancelled) return 'Cancelled — the draw was never made';
    if (!tournament.hasStarted) return 'Registration open — draw not yet made';
    // Derived from the same per-round status (and so the same `matchState`
    // predicate) the round badges use — the hero can no longer claim the
    // final is "in progress" while the final's own badge reads "Upcoming".
    return tournamentHeadline(rounds, rounds.length, now);
  }, [tournament, rounds, now]);

  if (error && !tournament) {
    return (
      <AppShell active="tournaments" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
        <PageShell>
          <div className="gc-notice" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
            {error}
          </div>
        </PageShell>
      </AppShell>
    );
  }
  if (!tournament) {
    return (
      <AppShell active="tournaments" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
        <PageShell>
          <div className="t-body-sm">Loading bracket…</div>
        </PageShell>
      </AppShell>
    );
  }

  // `champDecided` is computed above (before the celebration effect) from the
  // same `matchState` predicate — the champion is only revealed once the final
  // has AIRED, never while it is merely decided/still revealing.
  const champWinner = champDecided ? finalMatchGate?.outcome?.winner ?? null : null;
  const champLabel = champWinner ? playerLabel({ playerId: champWinner, seed: null }) : null;
  const finalTop = positions[rounds.length - 1]?.[0] ?? 0;
  const finalMid = finalTop + CARD_H / 2;

  const th = surfaceMeta(tournament.surface);
  // Main-draw entrants alone under-counts a qualifying-tier event: its
  // below-cutoff field sits in the 'qualifying' draw, so the hero used to
  // read "0 players" while the qualifying entry list showed one. Count both
  // fields and label which is which, consistent with the list rows' use of
  // mainDrawEntrants/drawSize.
  const qualifyingEntrants = tournament.entrants.filter((e) => e.draw === 'qualifying').length;
  // Manager-entered vs free-agent-filled main-draw places. The hero's "N/N"
  // is the draw's FILL (which includes unmanaged fillers); the entry list
  // counts manager entries only — naming both stops the two reading as a
  // contradiction ("0 managers entered" next to "64/64 full").
  const unmanagedMainEntrants = tournament.entrants.filter(
    (e) => e.draw === 'main' && players.get(e.playerId)?.managerId == null,
  ).length;
  const managerMainEntrants = tournament.mainDrawEntrants - unmanagedMainEntrants;
  const championCopy = champDecided && champLabel
    ? `${champLabel.name} lifts the trophy.`
    : overallStatus;
  // The compact hero chip, derived from the SAME `overallStatus` string
  // (itself the one `roundStatus`/`matchState` predicate the round badges
  // read) — never a second notion of "under way".
  const statusChip = !tournament.hasStarted
    ? tournament.cancelled
      ? 'CANCELLED'
      : 'REGISTRATION OPEN'
    : overallStatus === 'Tournament complete' || overallStatus.endsWith(' complete')
      ? 'COMPLETE'
      : overallStatus === 'Results airing'
        ? 'RESULTS AIRING'
        : overallStatus === 'Awaiting entrants'
          ? 'AWAITING ENTRANTS'
          : overallStatus.endsWith(' upcoming')
            ? overallStatus.toUpperCase()
            : overallStatus.endsWith(' in progress')
              ? 'LIVE'
              : overallStatus.toUpperCase();

  return (
    <AppShell active="tournaments" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}

      <PageShell>
        {/* Hero band — flat, 2px surface-coloured top rule (Direction A). */}
        <div className="gc-band" style={{ ['--surf' as string]: th.color }}>
          <div style={{ minWidth: 260 }}>
            <h1 className="t-h2" style={{ margin: 0 }}>{tournament.name}</h1>
            <div className="t-label" style={{ marginTop: 6 }}>
              {tierLabel(tournament.tier)} · {tournament.surface} · {tournament.drawSize} draw
              {tournament.ageBand ? ` · ${tournament.ageBand.toUpperCase()}` : ''}
            </div>
            <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.5 }}>{championCopy}</div>
            <div className="t-body-sm" style={{ marginTop: 2, fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.5 }}>
              Single elimination · {tournament.mainDrawEntrants}/{tournament.drawSize} main-draw places filled
              {unmanagedMainEntrants > 0 ? ` (${managerMainEntrants} by managers, ${unmanagedMainEntrants} free-agent fillers)` : ''}
              {qualifyingEntrants > 0 ? ` · ${qualifyingEntrants} in qualifying` : ''}
            </div>
            {worldClock && (
              <div className="t-body-sm" style={{ marginTop: 2, fontSize: 11, color: 'var(--ink-4)' }}>
                Scheduled S{tournament.weekScheduled.season} W{tournament.weekScheduled.week} · now S{worldClock.currentWeek.season} W{worldClock.currentWeek.week}
              </div>
            )}
          </div>
          <div className="gc-band-meta">
            <div className="gc-topbar-kv">
              <span className="k">Status</span>
              <span className="v">
                <Badge
                  style={statusChip === 'LIVE'
                    ? { color: 'var(--live)', borderColor: 'color-mix(in srgb, var(--live) 50%, transparent)' }
                    : statusChip === 'COMPLETE'
                      ? { color: 'var(--win)', borderColor: 'color-mix(in srgb, var(--win) 45%, transparent)' }
                      : undefined}
                >
                  {statusChip === 'LIVE' && <span className="gc-live-dot" style={{ width: 6, height: 6 }} />}
                  {statusChip}
                </Badge>
              </span>
            </div>
            <div className="gc-topbar-kv">
              <span className="k">Draw</span>
              <span className="v num">
                {tournament.mainDrawEntrants}/{tournament.drawSize} main · {managerMainEntrants} by managers
              </span>
            </div>
            <div className="gc-topbar-kv">
              <span className="k">Host</span>
              <span className="v">
                {tournament.hostCountry ? (
                  <>
                    <Icon name="house" size={12} title="Host country — a player of this nationality has home advantage here" style={{ verticalAlign: 'text-bottom' }} />
                    {' '}{tournament.hostCountry}
                  </>
                ) : '—'}
              </span>
            </div>
          </div>
        </div>

        {tournament.cancelled && (
          <div className="gc-notice mt-3" style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' }}>
            <strong>Cancelled:</strong>{' '}
            {tournament.cancelReason ?? 'This draw was cancelled before it could start.'} The tournament never
            played; every entry is kept in the players&apos; history and those players are free to enter other
            events.
          </div>
        )}

        {error && (
          <div className="gc-notice mt-3" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
            {error}
          </div>
        )}

        <div className="mt-6" />

        {/* Singles entry — the tournament page's own entry control, the
            counterpart to the doubles one below. Previously an open
            tournament's page offered ONLY doubles, so entering a player in
            singles meant leaving for the Planner tab. */}
        {!tournament.hasStarted && !tournament.cancelled && (
          <div className="mb-6">
            <SinglesEntryPanel tournamentId={tournamentId} managerId={devManagerId} onEntered={() => void load()} />
          </div>
        )}

        {/* Tournament profile — details + entry list(s). Always available,
            both before the draw is made and while the tournament plays. */}
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)' }}>
          <TournamentDetailsPanel tournament={tournament} />
          <EntryList tournament={tournament} players={players} />
          {tournament.qualifierSlots > 0 && (
            <EntryList tournament={tournament} players={players} draw="qualifying" />
          )}
        </div>

        {/* The qualifying draw itself, once it exists — the compact
            results list of who is winning their way through. Rendered
            above the main bracket (or in place of it, while qualifying
            is still being played and the main draw doesn't exist yet). */}
        {tournament.qualifierSlots > 0 && tournament.hasStarted && (
          <QualifyingPanel tournament={tournament} players={players} tournamentId={tournamentId} now={now} />
        )}

        {/* The doubles draw (P7b) — players sign up solo, are paired at
            draw formation, and the top pairs by combined ranking play.
            Compact, like the qualifying panel: the pair list + the
            pair-keyed bracket. */}
        {tournament.doublesDrawSize > 0 && (
          <Panel style={{ overflow: 'hidden', marginBottom: 24 }}>
            <PanelHeader
              right={
                tournament.doublesComplete
                  ? 'Complete'
                  : tournament.doublesPairs.length > 0
                    ? `${tournament.doublesPairs.length} pairs`
                    : `${tournament.doublesEntrants.length} entrants`
              }
            >
              Doubles
            </PanelHeader>
            <div style={{ padding: 16 }}>
              <div className="t-body-sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
                {tournament.doublesDrawSize}-pair draw. Players sign up solo and are paired when the tournament starts — the
                top pairs by combined ranking make the cut.
              </div>
              {!tournament.hasStarted && (
                <div className="flex items-center gap-[10px] flex-wrap" style={{ marginBottom: 10 }}>
                  <Button variant="primary" onClick={openDoublesEntry}>
                    {doublesRoster === null ? 'Enter a player in doubles' : 'Choose a player'}
                  </Button>
                  {doublesRoster !== null && (
                    <>
                      <select className="gc-select" value={doublesPick ?? ''} onChange={(e) => setDoublesPick(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                        <option value="">Select player…</option>
                        {(doublesRoster ?? []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <Button onClick={submitDoublesEntry} disabled={!doublesPick || doublesBusy}>
                        {doublesBusy ? 'Signing up…' : 'Sign up'}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {doublesError && <div className="text-[12px] mb-[8px]" style={{ color: 'var(--loss)' }}>{doublesError}</div>}
              {doublesNotice && <div className="text-[12px] mb-[8px]" style={{ color: 'var(--win)' }}>{doublesNotice}</div>}
              {tournament.doublesPairs.length === 0 ? (
                <div className="text-[13px]" style={{ color: 'var(--ink-4)', padding: '10px 4px' }}>
                  {tournament.doublesEntrants.length > 0
                    ? `${tournament.doublesEntrants.length} player${tournament.doublesEntrants.length === 1 ? '' : 's'} signed up — the draw is paired when the tournament starts.`
                    : 'No players have signed up for doubles yet.'}
                </div>
              ) : (
                <div className="flex flex-col gap-[6px]">
                  {tournament.doublesPairs.map((p) => {
                    const a = displayNames.get(p.playerA) ?? players.get(p.playerA)?.name ?? p.playerA;
                    const b = displayNames.get(p.playerB) ?? players.get(p.playerB)?.name ?? p.playerB;
                    const ca = players.get(p.playerA);
                    const cb = players.get(p.playerB);
                    return (
                      <div key={p.pairId} className="flex items-center gap-[7px] px-[12px] py-[7px] rounded-[6px] text-[13px]" style={{ border: '1px solid var(--hair)', color: 'var(--ink)' }}>
                        {ca && <span className="flex-none"><Flag code={ca.nationality} title={ca.nationality} /></span>} <span className="font-semibold">{a}</span>
                        <span style={{ color: 'var(--ink-3)' }}>+</span>
                        {cb && <span className="flex-none"><Flag code={cb.nationality} title={cb.nationality} /></span>} <span className="font-semibold">{b}</span>
                        {p.chemistry > 0 && (
                          <Badge className="gc-badge--win" title="Pair chemistry (built by playing together)">
                            <span className="ml-auto">chem {p.chemistry}</span>
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {tournament.doublesRounds.length > 0 && (
                <div className="gc-qgrid" style={{ marginTop: 12 }}>
                  {tournament.doublesRounds.map((round) => {
                    const pairName = (pairId: string) => {
                      const p = tournament.doublesPairs.find((pp) => pp.pairId === pairId);
                      if (!p) return pairId;
                      return `${displayNames.get(p.playerA) ?? players.get(p.playerA)?.name ?? p.playerA} + ${displayNames.get(p.playerB) ?? players.get(p.playerB)?.name ?? p.playerB}`;
                    };
                    return (
                      <div key={round.roundNumber}>
                        <div className="t-label" style={{ marginBottom: 6 }}>
                          {round.roundNumber === tournament.doublesRounds.length ? 'Doubles final' : `Doubles round ${round.roundNumber}`}
                        </div>
                        <ResultList>
                          {round.matches.map((match, i) => {
                            // Same shared air predicate as every other draw — a
                            // doubles result is hidden until its premiere (and the
                            // qualifying-pair names are not needed to render "v").
                            const airState = matchAirStateForDto(match, now);
                            const aired = airState === 'aired' && match.outcome != null;
                            const winner = aired ? match.outcome!.winner : null;
                            const text = aired
                              ? `${pairName(winner!)} def. ${pairName(match.outcome!.loser)}`
                              : `${pairName(match.entrantA)} v ${pairName(match.entrantB)}`;
                            const score = aired
                              ? formatScoreline(match.outcome!.setScores, true)
                              : !match.outcome
                                ? 'Pending'
                                : airState === 'live'
                                  ? 'Live now'
                                  : `Starts in ${formatCountdown(new Date(match.scheduledStartAt!).getTime() - now)}`;
                            return <MatchResultRow key={i} text={text} score={score} aired={aired} />;
                          })}
                        </ResultList>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Doubles qualifying (P8) — the small bracket played on the
                  opening days for the reserved main-draw places. */}
              {tournament.doublesQualifyingDrawSize > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="t-label" style={{ marginBottom: 8 }}>
                    Doubles qualifying · {tournament.doublesQualifierSlots} main-draw place(s) at stake
                    {tournament.doublesQualifyingComplete ? ' · complete' : ''}
                  </div>
                  {tournament.doublesQualifyingPairs.length === 0 ? (
                    <div className="text-[12.5px]" style={{ color: 'var(--ink-4)', padding: '6px 2px' }}>
                      Qualifying pairs are formed when the tournament starts.
                    </div>
                  ) : (
                    <div className="gc-qgrid">
                      {tournament.doublesQualifyingRounds.map((round) => {
                        const pairName = (pairId: string) => {
                          const p = tournament.doublesQualifyingPairs.find((pp) => pp.pairId === pairId);
                          if (!p) return pairId;
                          return `${displayNames.get(p.playerA) ?? players.get(p.playerA)?.name ?? p.playerA} + ${displayNames.get(p.playerB) ?? players.get(p.playerB)?.name ?? p.playerB}`;
                        };
                        return (
                          <div key={round.roundNumber}>
                            <div className="t-label" style={{ marginBottom: 5, color: 'var(--ink-4)' }}>
                              Q{round.roundNumber}
                            </div>
                            <ResultList>
                              {round.matches.map((match, i) => {
                                const airState = matchAirStateForDto(match, now);
                                const aired = airState === 'aired' && match.outcome != null;
                                const winner = aired ? match.outcome!.winner : null;
                                const text = aired
                                  ? `${pairName(winner!)} def. ${pairName(match.outcome!.loser)}`
                                  : `${pairName(match.entrantA)} v ${pairName(match.entrantB)}`;
                                const score = aired
                                  ? formatScoreline(match.outcome!.setScores, true)
                                  : !match.outcome
                                    ? 'Pending'
                                    : airState === 'live'
                                      ? 'Live now'
                                      : `Starts in ${formatCountdown(new Date(match.scheduledStartAt!).getTime() - now)}`;
                                return <MatchResultRow key={i} text={text} score={score} aired={aired} />;
                              })}
                            </ResultList>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>
        )}

        {!tournament.hasStarted ? (
          tournament.cancelled ? (
            <Panel style={{ padding: 28, textAlign: 'center' }}>
              <Icon name="ball" size={22} style={{ color: 'var(--ink-3)' }} />
              <div className="text-[15px] font-bold" style={{ color: 'var(--ink)', marginTop: 6 }}>This draw was cancelled</div>
              <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.5 }}>
                {tournament.cancelReason ?? 'It could not be filled before its deadline.'} No matches were played,
                so there is no bracket. Entries remain in each player&apos;s tournament history.
              </div>
            </Panel>
          ) : (
          <Panel style={{ padding: 28, textAlign: 'center' }}>
            <Icon name="ball" size={22} style={{ color: 'var(--ink-3)' }} />
            <div className="text-[15px] font-bold" style={{ color: 'var(--ink)', marginTop: 6 }}>The draw hasn&apos;t been made yet</div>
            <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.5 }}>
              Seeding happens when the tournament starts
              {` — S${tournament.weekScheduled.season} W${tournament.weekScheduled.week}`}
              {worldClock ? ` (now S${worldClock.currentWeek.season} W${worldClock.currentWeek.week})` : ''}.
              Until then, managers can keep entering players above.
            </div>
          </Panel>
          )
        ) : !tournament.hasMainDraw ? (
          <Panel style={{ padding: 28, textAlign: 'center' }}>
            <Icon name="ball" size={22} style={{ color: 'var(--ink-3)' }} />
            <div className="text-[15px] font-bold" style={{ color: 'var(--ink)', marginTop: 6 }}>Qualifying in progress</div>
            <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.5 }}>
              {tournament.qualifyingRoundCount} rounds of qualifying decide who claims the{' '}
              {tournament.qualifierSlots} reserved main-draw place(s). The main draw is made once qualifying is
              complete.
            </div>
          </Panel>
        ) : (
        <Panel style={{ overflow: 'hidden' }}>
          <PanelHeader right={`${rounds[0]?.label ?? ''} → ${rounds[rounds.length - 1]?.label ?? ''} · ${tournament.drawSize} draw`}>
            Bracket
          </PanelHeader>
          <div className="overflow-x-auto" style={{ padding: 16 }}>
            <div className="gc-bracket" style={BRACKET_VARS as React.CSSProperties}>
            {rounds.map((round, ri) => {
              const airs = round.matches.map((m) => ({ decided: m.decided, airState: matchAirState(m, now) }));
              const decidedCount = airs.filter((a) => a.decided).length;
              const noneDecided = decidedCount === 0;
              // Round status + collapse live in a pure, tested helper
              // (lib/bracketStatus.ts) — see its doc comment for the real
              // bug: an un-played generated round used to read as "Decided"
              // (and collapse into fake results linking to unwritten replays)
              // because an undecided match counts as "aired".
              const statusLabel = roundStatus(round.generated, airs);
              const collapsed = roundCollapsed(round.generated, airs);
              const statusBg = statusLabel === 'Decided' ? 'var(--accent)' : noneDecided ? 'transparent' : 'color-mix(in srgb, var(--warn) 25%, transparent)';
              const statusFg = statusLabel === 'Decided' ? 'var(--accent-ink)' : noneDecided ? 'var(--ink-3)' : 'var(--warn)';
              // Derived from the SAME per-match air states the cards below
              // use — never from a separately-counted "decided" total, which
              // used to read "8 of 8 played" while cards still said "starts in".
              const subtitle = roundSubtitle(round.generated, airs);

              return (
                <div key={round.roundNumber} className="flex items-start">
                  {collapsed ? (
                    <div style={{ width: COLLAPSED_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <Badge style={noneDecided ? { border: '1px solid var(--hair)', color: statusFg } : { background: statusBg, color: statusFg, borderColor: 'transparent' }}>
                            {statusLabel}
                          </Badge>
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <ResultList>
                        {round.matches.map((m, i) => {
                          // A bye has no outcome, so neither side is flagged
                          // `isWinner`; the advancing entrant sits on side `a`
                          // by construction (see the round-1 bye case). Resolve
                          // the winner as: the flagged winner, or (for a bye) the
                          // side that actually holds an entrant.
                          const winnerIsA = m.a.isWinner || (m.isBye && m.a.entrant != null);
                          const winnerLabel = winnerIsA ? playerLabel(m.a.entrant) : playerLabel(m.b.entrant);
                          const loserLabel = winnerIsA ? playerLabel(m.b.entrant) : playerLabel(m.a.entrant);
                          const text = m.isBye ? winnerLabel.name : `${winnerLabel.name} def. ${loserLabel.name}`;
                          const score = m.isBye ? 'Bye' : (m.a.isWinner ? m.a.scoreline : m.b.scoreline) ?? '';
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          // A plain `<a>`, deliberately NOT next/link:
                          // next's App Router intercepts the click and does
                          // not update the URL until the destination's RSC
                          // payload resolves, so a cold route left a decided
                          // card looking like a dead click. A native anchor
                          // changes the URL the instant it is activated, so a
                          // decided card always behaves like the link it is
                          // (real, focusable, keyboard-navigable).
                          // Only an AIRED match is a replay link — a decided
                          // but not-yet-aired match still shows a countdown
                          // ("Starts in …") and must not be clickable, matching
                          // the bracket legend.
                          return (
                            <MatchResultRow
                              key={i}
                              text={text}
                              score={score}
                              aired
                              href={slot && airs[i].airState === 'aired' ? `/replay/${slot}` : null}
                            />
                          );
                        })}
                      </ResultList>
                      <div className="text-[10.5px] mt-[6px] px-1" style={{ color: 'var(--ink-4)' }}>
                        Collapses automatically once every match has aired — keeps large draws from growing the page taller.
                      </div>
                    </div>
                  ) : (
                    <div style={{ width: COL_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <Badge style={noneDecided ? { border: '1px solid var(--hair)', color: statusFg } : { background: statusBg, color: statusFg, borderColor: 'transparent' }}>
                            {statusLabel}
                          </Badge>
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <div className="relative" style={{ height: totalHeight }}>
                        {round.matches.map((m, i) => {
                          const top = positions[ri][i];
                          const aLabel = playerLabel(m.a.entrant);
                          const bLabel = playerLabel(m.b.entrant);
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          // Staggered-schedule state: a decided match is still
                          // "upcoming" (countdown) or "live" (airing) until its
                          // reveal window has passed; only then is the result shown.
                          const airState = matchAirState(m, now);
                          const revealed = airState === 'aired';
                          // The outcome in plain text for assistive readers — a
                          // decided card's winner is marked visually (a "Winner"
                          // badge), but colour/weight alone must never be the only
                          // signal, so the link carries the result as a label.
                          const cardAriaLabel =
                            revealed && m.outcome
                              ? `${aLabel.name} def. ${bLabel.name}, ${formatScoreline(m.outcome.setScores, true)}`
                              : undefined;
                          const winnerName = m.a.isWinner ? aLabel.name : bLabel.name;

                          const cardInner = (
                            <>
                              {m.isBye && (
                                <div
                                  style={{ position: 'absolute', top: -8, right: 8, zIndex: 1 }}
                                >
                                  <Badge>Bye</Badge>
                                </div>
                              )}
                              <div className={`gc-mrow${m.a.isWinner && revealed ? ' is-win' : ''}`}>
                                {m.a.entrant ? (
                                  <>
                                    <span className="flex-none">{aLabel.flag}</span>
                                    <span className="gc-mrow-name">
                                      <span
                                        className="name"
                                        style={{
                                          fontWeight: m.a.isWinner && revealed ? 600 : 400,
                                          color: m.a.isWinner && revealed ? 'var(--ink)' : m.a.isLoser && revealed ? 'var(--ink-4)' : 'var(--ink-2)',
                                        }}
                                      >
                                        {aLabel.name}
                                      </span>
                                      {aLabel.seedLabel && <span className="gc-mrow-seed">{aLabel.seedLabel}</span>}
                                      {m.a.isWinner && revealed && (
                                        <Badge className="gc-badge--win" title="Winner of this match">Winner</Badge>
                                      )}
                                      {aLabel.fillOnly && (
                                        <Badge title="An unmanaged free agent padding the draw to a full bracket — not a manager's rostered player">
                                          Free agent
                                        </Badge>
                                      )}
                                    </span>
                                  </>
                                ) : (
                                  <span className="gc-mrow-name">
                                    <span className="name" style={{ color: 'var(--ink-4)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </span>
                                  </span>
                                )}
                                {m.a.isWinner && revealed && m.a.scoreline && (
                                  <span className="gc-mrow-sets">{m.a.scoreline}</span>
                                )}
                              </div>
                              <div className={`gc-mrow${m.b.isWinner && revealed ? ' is-win' : ''}`}>
                                {m.b.entrant ? (
                                  <>
                                    <span className="flex-none">{bLabel.flag}</span>
                                    <span className="gc-mrow-name">
                                      <span
                                        className="name"
                                        style={{
                                          fontWeight: m.b.isWinner && revealed ? 600 : 400,
                                          color: m.b.isWinner && revealed ? 'var(--ink)' : m.b.isLoser && revealed ? 'var(--ink-4)' : 'var(--ink-2)',
                                        }}
                                      >
                                        {bLabel.name}
                                      </span>
                                      {bLabel.seedLabel && <span className="gc-mrow-seed">{bLabel.seedLabel}</span>}
                                      {m.b.isWinner && revealed && (
                                        <Badge className="gc-badge--win" title="Winner of this match">Winner</Badge>
                                      )}
                                      {bLabel.fillOnly && (
                                        <Badge title="An unmanaged free agent padding the draw to a full bracket — not a manager's rostered player">
                                          Free agent
                                        </Badge>
                                      )}
                                    </span>
                                  </>
                                ) : (
                                  <span className="gc-mrow-name">
                                    <span className="name" style={{ color: 'var(--ink-4)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </span>
                                  </span>
                                )}
                                {m.b.isWinner && revealed && m.b.scoreline && (
                                  <span className="gc-mrow-sets">{m.b.scoreline}</span>
                                )}
                              </div>
                              {/* Footer — 1:1 with the old card's states:
                                   aired → W chip + replay link text; decided
                                   but not yet aired → LIVE / STARTS IN; a
                                   bye → BYE; otherwise PENDING (a real
                                   scheduled match) or TBD (future round). */}
                              <div className={`gc-mfoot${airState === 'live' ? ' is-live' : ''}`}>
                                {m.isBye ? (
                                  <span>BYE</span>
                                ) : revealed && m.outcome ? (
                                  <>
                                    <span className="flex items-center gap-[5px] min-w-0">
                                      <span className="gc-wchip gc-wchip--w">W</span>
                                      <span className="truncate">{winnerName}</span>
                                    </span>
                                    <span className="flex-none">Watch replay »</span>
                                  </>
                                ) : m.decided ? (
                                  airState === 'live' ? (
                                    <span className="flex items-center gap-[6px]">
                                      <span className="gc-live-dot" /> LIVE
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-[6px]">
                                      <Icon name="stopwatch" size={11} />
                                      <span>STARTS IN {formatCountdown(new Date(m.scheduledStartAt!).getTime() - now)}</span>
                                    </span>
                                  )
                                ) : (
                                  <span>{m.matchIndex !== null ? 'PENDING' : 'TBD'}</span>
                                )}
                              </div>
                            </>
                          );

                          const cardStyle: React.CSSProperties = {
                            position: 'absolute',
                            top,
                            left: 0,
                          };

                          // Plain `<a>` for the same reason as the collapsed
                          // rows above — the click must navigate immediately.
                          // And ONLY an aired match is a link: a decided match
                          // still counting down ("Starts in 9:52") must not be
                          // clickable (the exact reported bug).
                          return slot && revealed ? (
                            <a
                              key={i}
                              href={`/replay/${slot}`}
                              aria-label={cardAriaLabel}
                              className="gc-match is-decided"
                              style={{ ...cardStyle, ['--surf' as string]: accent, color: 'inherit', cursor: 'pointer' }}
                            >
                              {cardInner}
                            </a>
                          ) : (
                            <div
                              key={i}
                              className={`gc-match${airState === 'live' ? ' is-live' : ''}`}
                              style={{ ...cardStyle, ['--surf' as string]: airState === 'live' ? 'var(--live)' : accent }}
                            >
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
                        {!(collapsed || !rounds[ri + 1].generated) && (
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
                        background: champDecided ? 'var(--bg-3)' : 'var(--bg-2)',
                        borderRadius: 'var(--r2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: champDecided ? '1px solid var(--hair)' : '1px dashed var(--hair-2)',
                        borderTop: `2px solid ${champDecided ? 'var(--accent)' : 'var(--hair-2)'}`,
                      }}
                    >
                      {champDecided && champLabel ? (
                        <div className="flex flex-col items-center gap-1 p-3 text-center">
                          <div className="t-label inline-flex items-center gap-[5px]" style={{ color: 'var(--accent)' }}>
                            <Icon name="star" size={11} /> Champion
                          </div>
                          <div className="flex items-center gap-2">
                            <span>{champLabel.flag}</span>
                            <div className="font-bold text-[15px]" style={{ color: 'var(--ink)' }}>{champLabel.name}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[12px] font-semibold tracking-[0.4px] uppercase" style={{ color: 'var(--ink-4)' }}>
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
          {/* Bracket legend — the same four keys the colours/badges encode. */}
          <div className="gc-tbl-note flex items-center gap-[16px] flex-wrap" style={{ borderTop: '1px solid var(--hair)' }}>
            <span className="flex items-center gap-[6px]">
              <span style={{ width: 10, height: 10, borderRadius: 2, background: accent, display: 'inline-block' }} /> Decided path
            </span>
            <span className="flex items-center gap-[6px]">
              <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--ink-4)', display: 'inline-block' }} /> Pending / TBD
            </span>
            <span className="flex items-center gap-[6px]">
              <Badge>Free agent</Badge> = unmanaged draw filler
            </span>
            <span>Aired results link to the replay →</span>
          </div>
        </Panel>
        )}
      </PageShell>
    </AppShell>
  );
}
