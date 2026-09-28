/**
 * Ranking-discipline BACKFILL — the one-off (and re-runnable) data repair
 * for the CRITICAL ranking-discipline bug.
 *
 * THE BUG: `RankingLedgerEntry.discipline` existed in the domain, every
 * ranking read (`RankPositionQuery`, the peak updates, the obligatory-
 * zero rule, the season bonus pool) filtered on it, and
 * `SimulateDoublesMatchUseCase`/`SimulateMastersCupMatchUseCase` set it
 * — but `ranking_ledger` had no column and the Drizzle adapter silently
 * dropped it on append. So every doubles row was indistinguishable from
 * a singles row: doubles points were summed into the SENIOR SINGLES
 * ladder (saturating best-N slots and inflating peaks) while the doubles
 * ladder and `doubles_peak_rankings` stayed empty.
 *
 * WHAT THIS SCRIPT DOES (and does NOT do):
 *   1. Classifies every pre-existing `ranking_ledger` row whose value
 *      matches the multiset of EXPECTED DOUBLES AWARDS recomputed from
 *      the recorded brackets (`tournament_doubles_matches` +
 *      `tournament_doubles_pairs`, plus `masters_cups` jsonb for cup
 *      rows), per (tournament, player). Rows that already carry
 *      `discipline = 'doubles'` are left exactly as they are; rows that
 *      cannot be positively classified are LISTED and LEFT as singles —
 *      never guessed.
 *   2. (`--apply`) writes `discipline = 'doubles'` for those positively
 *      classified rows ONLY, in one transaction. That is the backfill's
 *      only mutation of ledger history — no row is deleted, no points
 *      value is ever rewritten.
 *   3. Recomputes BOTH `peak_rankings` (inflated by doubles rows) and
 *      `doubles_peak_rankings` (all-zero) by replaying each player's
 *      classified ledger week-by-week — the owner-approved honest
 *      correction, which visibly LOWERS some historical singles peaks.
 *      Only scopes whose recomputed value actually differs from the
 *      stored row are written, so a second `--apply` is a no-op.
 *
 * HISTORICAL AWARD REPRODUCTION (why the doubles expectations are
 * computed the way they are): `SimulateDoublesMatchUseCase` loads its
 * two sides from the SCHEDULED slots (`entrantA`/`entrantB`) but then
 * passes the TRUE winner's rounds-won to the entrantA side and the TRUE
 * loser's to the entrantB side — the awards are slot-based, not
 * outcome-based (a real, separately-disclosed bug in the live use case).
 * Every historical row was written that way, so the classifier must
 * reproduce it: entrantA's pair gets the winner's value, entrantB's pair
 * the loser's value. Newly written rows (post-column) are unaffected by
 * classification anyway.
 *
 * USAGE
 *   node dist/scripts/backfillRankingDiscipline.js            # dry run
 *   node dist/scripts/backfillRankingDiscipline.js --apply    # commit
 *
 * Both modes print the full report; the default is deliberately
 * dry-run-first. `DATABASE_URL` selects the database (same default as
 * every other script).
 */
import { Pool } from 'pg';
import { and, inArray, ne, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  AgeBand,
  bestResultsCapFor,
  BracketRound,
  doublesBestResultsCapFor,
  doublesPointsFor,
  doublesQualifyingPointsFor,
  GameWeek,
  PairId,
  PlayerId,
  qualifyingPointsFor,
  RankingBand,
  RankingCalculationService,
  RankingDiscipline,
  RANKING_WINDOW_WEEKS,
  StandardRankingPointsTable,
  TournamentId,
  TournamentTier,
  WEEKS_PER_SEASON,
} from '@tennis-manager/domain';
import {
  MASTERS_CUP_CHAMPION_POINTS,
  MASTERS_CUP_RUNNER_UP_POINTS,
  MASTERS_CUP_SEMIFINALIST_POINTS,
} from '@tennis-manager/application';
import * as schema from '../db/schema';
import { Db } from '../db/client';

// ---------------------------------------------------------------------------
// Pure classification core (unit-testable without a database)
// ---------------------------------------------------------------------------

export interface LedgerRowInput {
  id: string;
  playerId: string;
  tournamentId: string;
  points: number;
  obligatory: boolean;
}

export interface TournamentInput {
  id: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
}

export interface SinglesMatchInput {
  tournamentId: string;
  draw: 'main' | 'qualifying';
  roundNumber: number;
  winnerId: string;
  loserId: string;
}

export interface DoublesMatchInput {
  tournamentId: string;
  draw: 'main' | 'qualifying';
  roundNumber: number;
  entrantA: string;
  entrantB: string;
  winnerId: string;
  loserId: string;
}

export interface DoublesPairInput {
  tournamentId: string;
  pairId: string;
  playerA: string;
  playerB: string;
}

export interface CupInput {
  id: string;
  singlesKnockout: BracketRound<PlayerId>[];
  doublesKnockout: BracketRound<PairId>[];
  doublesEntrants: Array<{ pairId: string; playerA: string; playerB: string }>;
}

export interface BackfillInput {
  ledger: LedgerRowInput[];
  tournaments: TournamentInput[];
  singlesMatches: SinglesMatchInput[];
  doublesMatches: DoublesMatchInput[];
  doublesPairs: DoublesPairInput[];
  cups: CupInput[];
}

export interface UnresolvedRow {
  ledgerId: string;
  playerId: string;
  tournamentId: string;
  points: number;
  reason: string;
}

export interface ClassificationResult {
  doublesRowIds: string[];
  report: {
    total: number;
    /** Rows that stay (or already are) singles: total − doubles. */
    keptSingles: number;
    setDoubles: number;
    /** Ambiguous multiset assignments resolved deterministically
     * (candidates differed only in ways that leave the discipline
     * totals identical). */
    tieBroken: number;
    /**
     * Rows left as singles that COULD NOT be verified against a
     * recomputed singles award — their tournament's match rows are
     * missing from the DB (e.g. rows whose singles bracket was never
     * persisted). They are never doubles candidates (their value isn't
     * in the recomputed doubles bracket either), so leaving them as
     * singles is the safe default, but the count is reported so the
     * gap is visible rather than silently absorbed into "kept singles".
     */
    singlesWithoutExpectedRecord: number;
    /** Genuinely undecidable rows: leftovers whose value matches the
     * doubles expectation but whose assignment can't be determined from
     * the recorded brackets. Listed exhaustively and LEFT as singles. */
    unresolved: UnresolvedRow[];
    /** Expected doubles award rows recomputed from the brackets. */
    expectedDoublesRows: number;
    /** Expected singles awards with no matching ledger row (e.g. a cup
     * insert that failed on the pre-fix FK) — informational. */
    missingExpectedSingles: number;
    missingExpectedDoubles: number;
    cupRowsExamined: number;
    cupDoublesRows: number;
  };
}

/** The key a (tournament, player)'s rows and expected awards share. */
function groupKey(tournamentId: string, playerId: string): string {
  return `${tournamentId}|${playerId}`;
}

function addExpected(map: Map<string, number[]>, tournamentId: string, playerId: string, value: number): void {
  const key = groupKey(tournamentId, playerId);
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Expected SINGLES awards per (tournament, player): elimination pays
 * the rounds-won value, and the main-draw final winner pays the
 * champion value. One row per player per tournament in practice. */
export function buildExpectedSinglesAwards(
  tournaments: TournamentInput[],
  matches: SinglesMatchInput[],
): Map<string, number[]> {
  const pointsTable = new StandardRankingPointsTable();
  const tierById = new Map(tournaments.map((t) => [t.id, t.tier]));
  const expected = new Map<string, number[]>();
  const byDraw = new Map<string, SinglesMatchInput[]>();
  for (const match of matches) {
    const key = `${match.tournamentId}|${match.draw}`;
    const list = byDraw.get(key);
    if (list) list.push(match);
    else byDraw.set(key, [match]);
  }
  for (const [key, drawMatches] of byDraw) {
    const [tournamentId, draw] = key.split('|');
    const tier = tierById.get(tournamentId);
    if (!tier) continue;
    const wins = new Map<string, number>();
    const finalRound = Math.max(...drawMatches.map((m) => m.roundNumber));
    for (const match of [...drawMatches].sort((a, b) => a.roundNumber - b.roundNumber)) {
      const winnerWins = (wins.get(match.winnerId) ?? 0) + 1;
      const loserWins = wins.get(match.loserId) ?? 0;
      wins.set(match.winnerId, winnerWins);
      const loserValue =
        draw === 'qualifying' ? qualifyingPointsFor(tier, loserWins) : pointsTable.pointsFor(tier, loserWins);
      addExpected(expected, tournamentId, match.loserId, loserValue);
      if (draw === 'main' && match.roundNumber === finalRound) {
        addExpected(expected, tournamentId, match.winnerId, pointsTable.pointsFor(tier, winnerWins));
      }
    }
  }
  return expected;
}

/** Expected DOUBLES awards per (tournament, player), reproducing the
 * historical slot-based assignment exactly: entrantA's pair receives the
 * true winner's value, entrantB's pair the true loser's — see this
 * file's header. Doubles writes one row per match for all four players,
 * not one per tournament. */
export function buildExpectedDoublesAwards(
  tournaments: TournamentInput[],
  matches: DoublesMatchInput[],
  pairs: DoublesPairInput[],
): Map<string, number[]> {
  const pointsTable = new StandardRankingPointsTable();
  const tierById = new Map(tournaments.map((t) => [t.id, t.tier]));
  const pairPlayers = new Map<string, [string, string]>();
  for (const pair of pairs) pairPlayers.set(groupKey(pair.tournamentId, pair.pairId), [pair.playerA, pair.playerB]);

  const expected = new Map<string, number[]>();
  const byDraw = new Map<string, DoublesMatchInput[]>();
  for (const match of matches) {
    const key = `${match.tournamentId}|${match.draw}`;
    const list = byDraw.get(key);
    if (list) list.push(match);
    else byDraw.set(key, [match]);
  }
  for (const [key, drawMatches] of byDraw) {
    const [tournamentId, drawRaw] = key.split('|');
    const draw = drawRaw as 'main' | 'qualifying';
    const tier = tierById.get(tournamentId);
    if (!tier) continue;
    const wins = new Map<string, number>();
    for (const match of [...drawMatches].sort((a, b) => a.roundNumber - b.roundNumber)) {
      const stats = doublesMatchAwardValues(tier, draw, match, wins, pointsTable);
      const entrantAPlayers = pairPlayers.get(groupKey(tournamentId, match.entrantA));
      const entrantBPlayers = pairPlayers.get(groupKey(tournamentId, match.entrantB));
      if (!entrantAPlayers || !entrantBPlayers) continue;
      for (const playerId of entrantAPlayers) addExpected(expected, tournamentId, playerId, stats.winnerValue);
      for (const playerId of entrantBPlayers) addExpected(expected, tournamentId, playerId, stats.loserValue);
    }
  }
  return expected;
}

/** The pair's cumulative award values for one match. Mutates `wins`
 * (the running per-pair rounds-won map the use case's
 * `doublesRoundsWonBy` equivalent keeps). */
function doublesMatchAwardValues(
  tier: TournamentTier,
  draw: 'main' | 'qualifying',
  match: DoublesMatchInput,
  wins: Map<string, number>,
  pointsTable: StandardRankingPointsTable,
): { winnerValue: number; loserValue: number } {
  const winnerWins = (wins.get(match.winnerId) ?? 0) + 1;
  const loserWins = wins.get(match.loserId) ?? 0;
  wins.set(match.winnerId, winnerWins);
  const value = (roundsWon: number) =>
    draw === 'qualifying'
      ? doublesQualifyingPointsFor(roundsWon)
      : doublesPointsFor(tier, roundsWon, pointsTable.pointsFor(tier, roundsWon));
  return { winnerValue: value(winnerWins), loserValue: value(loserWins) };
}

/** Expected awards for a Masters Cup's knockout (group matches pay
 * nothing). The cup awards by OUTCOME (winnerIds/loserIds), not by
 * slot — `SimulateMastersCupMatchUseCase` predates/avoids the doubles
 * slot mix-up — so entrantA/entrantB are irrelevant here. */
export function buildExpectedCupAwards(cups: CupInput[]): { singles: Map<string, number[]>; doubles: Map<string, number[]> } {
  const singles = new Map<string, number[]>();
  const doubles = new Map<string, number[]>();
  const scaled = (points: number) => Math.round(points * 0.5);

  for (const cup of cups) {
    for (const round of cup.singlesKnockout) {
      const isFinal = round.roundNumber === Math.max(...cup.singlesKnockout.map((r) => r.roundNumber));
      for (const match of round.matches) {
        if (!match.outcome) continue;
        const loserPoints = round.roundNumber === 1 ? MASTERS_CUP_SEMIFINALIST_POINTS : MASTERS_CUP_RUNNER_UP_POINTS;
        addExpected(singles, cup.id, match.outcome.loser, loserPoints);
        if (isFinal) addExpected(singles, cup.id, match.outcome.winner, MASTERS_CUP_CHAMPION_POINTS);
      }
    }
    const pairPlayers = new Map(cup.doublesEntrants.map((p) => [p.pairId, [p.playerA, p.playerB] as const]));
    for (const round of cup.doublesKnockout) {
      const isFinal = round.roundNumber === Math.max(...cup.doublesKnockout.map((r) => r.roundNumber));
      for (const match of round.matches) {
        if (!match.outcome) continue;
        const loserPoints = round.roundNumber === 1 ? MASTERS_CUP_SEMIFINALIST_POINTS : MASTERS_CUP_RUNNER_UP_POINTS;
        for (const player of pairPlayers.get(match.outcome.loser) ?? []) {
          addExpected(doubles, cup.id, player, scaled(loserPoints));
        }
        if (isFinal) {
          for (const player of pairPlayers.get(match.outcome.winner) ?? []) {
            addExpected(doubles, cup.id, player, scaled(MASTERS_CUP_CHAMPION_POINTS));
          }
        }
      }
    }
  }
  return { singles, doubles };
}

/** Does `actual` contain exactly the values in `expected` (as a
 * multiset)? */
function multisetEquals(actual: number[], expected: number[]): boolean {
  if (actual.length !== expected.length) return false;
  return uncoveredExpected(actual, expected).length === 0;
}

/** Expected values NOT covered by `actual` — empty means `actual` is a
 * superset (as a multiset) of `expected`. */
function uncoveredExpected(actual: number[], expected: number[]): number[] {
  const remaining = [...expected];
  for (const value of actual) {
    const index = remaining.indexOf(value);
    if (index !== -1) remaining.splice(index, 1);
  }
  return remaining;
}

interface GroupOutcome {
  doublesRowIds: string[];
  tieBroken: number;
  unresolved: UnresolvedRow[];
  singlesWithoutExpectedRecord: number;
  missingExpectedSingles: number;
  missingExpectedDoubles: number;
}

/** Classify one (tournament, player)'s rows against the expected award
 * multisets. Obligatory (skip-zero) rows are always singles by
 * construction and never participate in the matching. */
export function classifyGroup(
  tournamentId: string,
  playerId: string,
  rows: LedgerRowInput[],
  expectedSingles: number[],
  expectedDoubles: number[],
): GroupOutcome {
  const outcome: GroupOutcome = {
    doublesRowIds: [],
    tieBroken: 0,
    unresolved: [],
    singlesWithoutExpectedRecord: 0,
    missingExpectedSingles: 0,
    missingExpectedDoubles: 0,
  };
  const pool = rows.filter((row) => !row.obligatory);
  if (pool.length === 0) return outcome;
  void tournamentId;
  void playerId;

  // EXACT whole-group assignment: if deleting exactly one row leaves the
  // doubles multiset, that row is the singles result (whose value may
  // exceed the recomputed expectation — a graduation carryover) and
  // every other row is a certain doubles award.
  const candidates = pool.filter((row) => {
    const remaining = pool.filter((other) => other !== row).map((other) => other.points);
    return multisetEquals(remaining, expectedDoubles);
  });
  if (candidates.length > 0) {
    const singlesRow = pickSinglesCandidate(candidates, expectedSingles);
    if (candidates.length > 1) outcome.tieBroken += 1;
    if (expectedSingles.length === 0) {
      // The singles bracket isn't on file, so the singles award can't be
      // recomputed — but the OTHER rows exactly cover the doubles
      // expectation, so this row cannot be doubles. Left as singles,
      // counted as unverified rather than passed off as confirmed.
      outcome.singlesWithoutExpectedRecord += 1;
    } else {
      outcome.missingExpectedSingles += Math.max(0, expectedSingles.length - 1);
    }
    for (const row of pool) if (row !== singlesRow) outcome.doublesRowIds.push(row.id);
    return outcome;
  }

  if (multisetEquals(pool.map((row) => row.points), expectedDoubles)) {
    // All rows are the doubles awards; an expected singles row is simply
    // absent (e.g. a failed insert) — counted, never invented.
    outcome.missingExpectedSingles += expectedSingles.length;
    for (const row of pool) outcome.doublesRowIds.push(row.id);
    return outcome;
  }

  return classifyPartially(pool, expectedSingles, expectedDoubles, outcome);
}

/** The no-exact-assignment fallback: greedily cover as much of the
 * doubles expectation as possible, explain leftovers against the singles
 * expectation (exactly, or >= it — graduation carryover), and only
 * report a leftover as `unresolved` when its value matches the doubles
 * expectation and its assignment genuinely can't be decided. Leftovers
 * that can't be doubles relative to the recorded brackets are left as
 * (unverified) singles. */
function classifyPartially(
  pool: LedgerRowInput[],
  expectedSingles: number[],
  expectedDoubles: number[],
  outcome: GroupOutcome,
): GroupOutcome {
  const remainingDoubles = [...expectedDoubles];
  const matched = new Set<LedgerRowInput>();
  for (const row of pool) {
    const index = remainingDoubles.indexOf(row.points);
    if (index !== -1) {
      remainingDoubles.splice(index, 1);
      matched.add(row);
    }
  }
  outcome.missingExpectedDoubles += remainingDoubles.length;
  outcome.doublesRowIds.push(...[...matched].map((row) => row.id));

  const singlesRemaining = [...expectedSingles];
  const unexplained: LedgerRowInput[] = [];
  for (const row of pool.filter((r) => !matched.has(r))) {
    const exact = singlesRemaining.indexOf(row.points);
    if (exact !== -1) {
      singlesRemaining.splice(exact, 1);
      continue;
    }
    unexplained.push(row);
  }
  consumeCarryoverSingles(unexplained, singlesRemaining);

  for (const row of unexplained) {
    if (expectedDoubles.includes(row.points)) {
      outcome.unresolved.push(toUnresolved(row, 'doubles-value-not-decidable'));
    } else {
      outcome.singlesWithoutExpectedRecord += 1;
    }
  }
  outcome.missingExpectedSingles += singlesRemaining.length;
  return outcome;
}

/** A graduation-carryover singles row exceeds its table expectation
 * (never equals anything the doubles bracket could explain unless that
 * value is separately matched). Consume at most one such row per
 * remaining singles expectation. */
function consumeCarryoverSingles(unexplained: LedgerRowInput[], singlesRemaining: number[]): void {
  while (singlesRemaining.length > 0) {
    const index = unexplained.findIndex((row) => row.points >= singlesRemaining[0]);
    if (index === -1) return;
    unexplained.splice(index, 1);
    singlesRemaining.shift();
  }
}

function pickSinglesCandidate(candidates: LedgerRowInput[], expectedSingles: number[]): LedgerRowInput {
  if (expectedSingles.length > 0) {
    const satisfying = candidates.find((row) => row.points >= expectedSingles[0]);
    if (satisfying) return satisfying;
  }
  return candidates[0];
}

function toUnresolved(row: LedgerRowInput, reason: string): UnresolvedRow {
  return { ledgerId: row.id, playerId: row.playerId, tournamentId: row.tournamentId, points: row.points, reason };
}

/** Full classification over the whole ledger. */
export function classifyLedgerDiscipline(input: BackfillInput): ClassificationResult {
  const tournamentIds = new Set(input.tournaments.map((t) => t.id));
  const cupIds = new Set(input.cups.map((c) => c.id));
  const expectedSingles = buildExpectedSinglesAwards(input.tournaments, input.singlesMatches);
  const expectedDoubles = buildExpectedDoublesAwards(input.tournaments, input.doublesMatches, input.doublesPairs);
  const cupAwards = buildExpectedCupAwards(input.cups);
  for (const [key, values] of cupAwards.singles) expectedSingles.set(key, [...(expectedSingles.get(key) ?? []), ...values]);
  for (const [key, values] of cupAwards.doubles) expectedDoubles.set(key, [...(expectedDoubles.get(key) ?? []), ...values]);

  const groups = new Map<string, LedgerRowInput[]>();
  for (const row of input.ledger) {
    const key = groupKey(row.tournamentId, row.playerId);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const result: ClassificationResult = {
    doublesRowIds: [],
    report: {
      total: input.ledger.length,
      keptSingles: 0,
      setDoubles: 0,
      tieBroken: 0,
      singlesWithoutExpectedRecord: 0,
      unresolved: [],
      expectedDoublesRows: [...expectedDoubles.values()].reduce((sum, values) => sum + values.length, 0),
      missingExpectedSingles: 0,
      missingExpectedDoubles: 0,
      cupRowsExamined: input.ledger.filter((row) => cupIds.has(row.tournamentId)).length,
      cupDoublesRows: 0,
    },
  };

  for (const [key, rows] of groups) {
    const [tournamentId, playerId] = key.split('|');
    if (!tournamentIds.has(tournamentId) && !cupIds.has(tournamentId)) {
      for (const row of rows) {
        result.report.unresolved.push(toUnresolved(row, 'unknown-event-id'));
      }
      continue;
    }
    const outcome = classifyGroup(
      tournamentId,
      playerId,
      rows,
      expectedSingles.get(key) ?? [],
      expectedDoubles.get(key) ?? [],
    );
    result.doublesRowIds.push(...outcome.doublesRowIds);
    result.report.tieBroken += outcome.tieBroken;
    result.report.singlesWithoutExpectedRecord += outcome.singlesWithoutExpectedRecord;
    result.report.unresolved.push(...outcome.unresolved);
    result.report.missingExpectedSingles += outcome.missingExpectedSingles;
    result.report.missingExpectedDoubles += outcome.missingExpectedDoubles;
    if (cupIds.has(tournamentId)) {
      result.report.cupDoublesRows += outcome.doublesRowIds.length;
    }
  }

  result.report.setDoubles = result.doublesRowIds.length;
  result.report.keptSingles = result.report.total - result.report.setDoubles;
  return result;
}

// ---------------------------------------------------------------------------
// Peak recompute (pure)
// ---------------------------------------------------------------------------

export interface PeakInputEntry {
  id: string;
  playerId: PlayerId;
  tournamentId: TournamentId;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  band: RankingBand;
  discipline: RankingDiscipline;
  points: number;
  weekEarned: GameWeek;
}

export interface PeakRecord {
  playerId: string;
  band: RankingBand;
  discipline: RankingDiscipline;
  peakPoints: number;
  peakAsOfWeek: GameWeek;
}

function absoluteWeek(week: GameWeek): number {
  return week.season * WEEKS_PER_SEASON + week.week;
}

/**
 * Replays each player's ledger week-by-week and returns the highest
 * rolling-window total ever reached per (player, band, discipline) —
 * the same total the old incremental `updatePeakIfExceeded` was trying
 * to track, recomputed from the now-correctly-classified ledger. Turns
 * with no results can only LOWER a rolling total (expiry), so checking
 * only the weeks that actually have an entry is exact.
 */
export function recomputePeaks(entries: PeakInputEntry[], windowWeeks: number): PeakRecord[] {
  const scopes = new Map<string, PeakInputEntry[]>();
  for (const entry of entries) {
    const key = `${entry.playerId}|${entry.band}|${entry.discipline}`;
    const list = scopes.get(key);
    if (list) list.push(entry);
    else scopes.set(key, [entry]);
  }

  const records: PeakRecord[] = [];
  for (const [key, scopeEntries] of scopes) {
    const [playerId, band, discipline] = key.split('|') as [string, RankingBand, RankingDiscipline];
    const sorted = [...scopeEntries].sort(
      (a, b) => absoluteWeek(a.weekEarned) - absoluteWeek(b.weekEarned),
    );
    const calculator = new RankingCalculationService(
      discipline === 'doubles' ? doublesBestResultsCapFor(band) : bestResultsCapFor(band),
    );
    let best = Number.NEGATIVE_INFINITY;
    let bestWeek: GameWeek = sorted[0].weekEarned;
    for (const entry of sorted) {
      const at = absoluteWeek(entry.weekEarned);
      const window = sorted.filter((candidate) => {
        const candidateAt = absoluteWeek(candidate.weekEarned);
        return candidateAt <= at && candidateAt >= at - windowWeeks;
      });
      const total = calculator.calculateTotal(window, entry.weekEarned, discipline);
      if (total > best) {
        best = total;
        bestWeek = entry.weekEarned;
      }
    }
    records.push({ playerId, band, discipline, peakPoints: best, peakAsOfWeek: bestWeek });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Database I/O
// ---------------------------------------------------------------------------

interface StoredPeakRow {
  playerId: string;
  band: RankingBand;
  peakPoints: number;
}

export interface PeakDiff {
  create: number;
  raise: number;
  lower: number;
  unchanged: number;
  remove: number;
}

export interface BackfillReport {
  database: string;
  apply: boolean;
  classification: ClassificationResult['report'];
  /** Ledger rows actually updated by `--apply` (0 on a re-run). */
  rowsUpdated: number;
  peakDiff: PeakDiff;
  doublesPeakDiff: PeakDiff;
}

function scopeKey(playerId: string, band: RankingBand): string {
  return `${playerId}|${band}`;
}

/** Diff recomputed records against stored rows, counting what would
 * change. Used identically by dry-run and apply, so the report is the
 * same in both modes. */
export function diffPeaks(records: PeakRecord[], stored: StoredPeakRow[]): PeakDiff {
  const byScope = new Map(records.map((record) => [scopeKey(record.playerId, record.band), record]));
  const storedScopes = new Set(stored.map((row) => scopeKey(row.playerId, row.band)));
  const diff: PeakDiff = { create: 0, raise: 0, lower: 0, unchanged: 0, remove: 0 };
  for (const record of records) {
    const existing = stored.find((row) => row.playerId === record.playerId && row.band === record.band);
    if (!existing) diff.create += 1;
    else if (record.peakPoints > existing.peakPoints) diff.raise += 1;
    else if (record.peakPoints < existing.peakPoints) diff.lower += 1;
    else diff.unchanged += 1;
  }
  for (const storedScope of storedScopes) if (!byScope.has(storedScope)) diff.remove += 1;
  return diff;
}

async function loadBackfillInput(db: Db): Promise<BackfillInput> {
  const [tournamentRows, ledgerRows, singlesRows, doublesRows, pairRows, cupRows] = await Promise.all([
    db.select({ id: schema.tournaments.id, tier: schema.tournaments.tier, ageBand: schema.tournaments.ageBand }).from(schema.tournaments),
    db
      .select({
        id: schema.rankingLedger.id,
        playerId: schema.rankingLedger.playerId,
        tournamentId: schema.rankingLedger.tournamentId,
        points: schema.rankingLedger.points,
        obligatory: schema.rankingLedger.obligatory,
      })
      .from(schema.rankingLedger),
    db
      .select({
        tournamentId: schema.tournamentMatches.tournamentId,
        draw: schema.tournamentMatches.draw,
        roundNumber: schema.tournamentMatches.roundNumber,
        winnerId: schema.tournamentMatches.winnerId,
        loserId: schema.tournamentMatches.loserId,
      })
      .from(schema.tournamentMatches),
    db
      .select({
        tournamentId: schema.tournamentDoublesMatches.tournamentId,
        draw: schema.tournamentDoublesMatches.draw,
        roundNumber: schema.tournamentDoublesMatches.roundNumber,
        entrantA: schema.tournamentDoublesMatches.entrantA,
        entrantB: schema.tournamentDoublesMatches.entrantB,
        winnerId: schema.tournamentDoublesMatches.winnerId,
        loserId: schema.tournamentDoublesMatches.loserId,
      })
      .from(schema.tournamentDoublesMatches),
    db
      .select({
        tournamentId: schema.tournamentDoublesPairs.tournamentId,
        pairId: schema.tournamentDoublesPairs.pairId,
        playerA: schema.tournamentDoublesPairs.playerA,
        playerB: schema.tournamentDoublesPairs.playerB,
      })
      .from(schema.tournamentDoublesPairs),
    db
      .select({
        id: schema.mastersCups.id,
        singlesKnockout: schema.mastersCups.singlesKnockout,
        doublesKnockout: schema.mastersCups.doublesKnockout,
        doublesEntrants: schema.mastersCups.doublesEntrants,
      })
      .from(schema.mastersCups),
  ]);

  return {
    ledger: ledgerRows,
    tournaments: tournamentRows,
    singlesMatches: singlesRows.filter(
      (row): row is SinglesMatchInput => row.winnerId !== null && row.loserId !== null,
    ),
    doublesMatches: doublesRows.filter(
      (row): row is DoublesMatchInput =>
        row.winnerId !== null && row.loserId !== null && row.entrantA !== null && row.entrantB !== null,
    ),
    doublesPairs: pairRows,
    cups: cupRows,
  };
}

function toPeakInputEntries(
  rows: Array<{
    id: string;
    playerId: string;
    tournamentId: string;
    tier: TournamentTier;
    ageBand: AgeBand | null;
    points: number;
    discipline: RankingDiscipline;
    seasonEarned: number;
    weekEarned: number;
  }>,
  doublesRowIds: Set<string>,
): PeakInputEntry[] {
  return rows.map((row) => ({
    id: row.id,
    playerId: PlayerId(row.playerId),
    tournamentId: TournamentId(row.tournamentId),
    tier: row.tier,
    ageBand: row.ageBand,
    band: (row.ageBand ?? 'senior') as RankingBand,
    discipline: doublesRowIds.has(row.id) ? 'doubles' : row.discipline,
    points: row.points,
    weekEarned: { season: row.seasonEarned, week: row.weekEarned },
  }));
}

async function loadStoredPeaks(db: Db): Promise<{ singles: StoredPeakRow[]; doubles: StoredPeakRow[] }> {
  const [singles, doubles] = await Promise.all([
    db
      .select({ playerId: schema.peakRankings.playerId, band: schema.peakRankings.band, peakPoints: schema.peakRankings.peakPoints })
      .from(schema.peakRankings),
    db
      .select({
        playerId: schema.doublesPeakRankings.playerId,
        band: schema.doublesPeakRankings.band,
        peakPoints: schema.doublesPeakRankings.peakPoints,
      })
      .from(schema.doublesPeakRankings),
  ]);
  return { singles, doubles };
}

// `RANKING_WINDOW_WEEKS` is imported from the domain (the same constant
// the calculator scores with) rather than re-declared here.

/**
 * Runs the whole pass. Dry-run (default): load, classify, recompute
 * peaks, print the report, write nothing. `--apply`: one transaction —
 * chunked discipline UPDATEs restricted to positively-classified
 * doubles rows (`AND discipline <> 'doubles'`, so a re-run updates 0
 * rows), then peak rows that actually differ are upserted/deleted.
 */
export async function runBackfill(
  db: Db,
  database: string,
  apply: boolean,
  log: (line: string) => void,
): Promise<BackfillReport> {
  const input = await loadBackfillInput(db);
  const classification = classifyLedgerDiscipline(input);
  const storedPeaks = await loadStoredPeaks(db);
  const doublesIdSet = new Set(classification.doublesRowIds);

  const fullRows = await db
    .select({
      id: schema.rankingLedger.id,
      playerId: schema.rankingLedger.playerId,
      tournamentId: schema.rankingLedger.tournamentId,
      tier: schema.rankingLedger.tier,
      ageBand: schema.rankingLedger.ageBand,
      points: schema.rankingLedger.points,
      discipline: schema.rankingLedger.discipline,
      seasonEarned: schema.rankingLedger.seasonEarned,
      weekEarned: schema.rankingLedger.weekEarned,
    })
    .from(schema.rankingLedger);
  const simulatedRecords = recomputePeaks(toPeakInputEntries(fullRows, doublesIdSet), RANKING_WINDOW_WEEKS);

  const diffOf = (discipline: RankingDiscipline, stored: StoredPeakRow[]) =>
    diffPeaks(simulatedRecords.filter((record) => record.discipline === discipline), stored);
  let peakDiff = diffOf('singles', storedPeaks.singles);
  let doublesPeakDiff = diffOf('doubles', storedPeaks.doubles);
  let rowsUpdated = 0;

  if (apply) {
    const outcome = await applyBackfill(db, classification, simulatedRecords, storedPeaks);
    rowsUpdated = outcome.rowsUpdated;
    peakDiff = outcome.peakDiff;
    doublesPeakDiff = outcome.doublesPeakDiff;
  }

  log(`=== Ranking discipline backfill (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  log(`Database: ${database}`);
  log(`Ledger rows examined: ${classification.report.total}`);
  log(`  kept singles: ${classification.report.keptSingles}`);
  log(`  classified doubles: ${classification.report.setDoubles}`);
  log(`  expected doubles rows (recomputed): ${classification.report.expectedDoublesRows}`);
  log(`  tie-broken assignments: ${classification.report.tieBroken}`);
  log(`  unresolved rows: ${classification.report.unresolved.length}`);
  log(`  singles kept without a recomputable record (missing match rows): ${classification.report.singlesWithoutExpectedRecord}`);
  log(`  missing expected singles rows: ${classification.report.missingExpectedSingles}`);
  log(`  missing expected doubles rows: ${classification.report.missingExpectedDoubles}`);
  log(`  cup-keyed rows examined: ${classification.report.cupRowsExamined} (of which doubles: ${classification.report.cupDoublesRows})`);
  for (const row of classification.report.unresolved) {
    log(`    UNRESOLVED ${row.ledgerId} player=${row.playerId} event=${row.tournamentId} points=${row.points} reason=${row.reason}`);
  }
  log('Peak recompute (owner-approved honest correction):');
  log(`  peak_rankings: create ${peakDiff.create}, raise ${peakDiff.raise}, lower ${peakDiff.lower}, unchanged ${peakDiff.unchanged}, remove ${peakDiff.remove}`);
  log(`  doubles_peak_rankings: create ${doublesPeakDiff.create}, raise ${doublesPeakDiff.raise}, lower ${doublesPeakDiff.lower}, unchanged ${doublesPeakDiff.unchanged}, remove ${doublesPeakDiff.remove}`);
  if (apply) {
    log(`Ledger rows updated: ${rowsUpdated} (0 on a re-run — the update is idempotent)`);
  } else {
    log('No changes written (dry run). Re-run with --apply to commit in one transaction.');
  }

  return { database, apply, classification: classification.report, rowsUpdated, peakDiff, doublesPeakDiff };
}

async function applyBackfill(
  db: Db,
  classification: ClassificationResult,
  simulatedRecords: PeakRecord[],
  storedPeaks: { singles: StoredPeakRow[]; doubles: StoredPeakRow[] },
): Promise<{ rowsUpdated: number; peakDiff: PeakDiff; doublesPeakDiff: PeakDiff }> {
  let rowsUpdated = 0;
  let peakDiff: PeakDiff = { create: 0, raise: 0, lower: 0, unchanged: 0, remove: 0 };
  let doublesPeakDiff: PeakDiff = { create: 0, raise: 0, lower: 0, unchanged: 0, remove: 0 };

  await db.transaction(async (tx) => {
    for (let i = 0; i < classification.doublesRowIds.length; i += 500) {
      const chunk = classification.doublesRowIds.slice(i, i + 500);
      const result = await tx
        .update(schema.rankingLedger)
        .set({ discipline: 'doubles' })
        .where(and(inArray(schema.rankingLedger.id, chunk), ne(schema.rankingLedger.discipline, 'doubles')));
      rowsUpdated += result.rowCount ?? 0;
    }

    const singlesRecords = simulatedRecords.filter((record) => record.discipline === 'singles');
    const doublesRecords = simulatedRecords.filter((record) => record.discipline === 'doubles');
    peakDiff = diffPeaks(singlesRecords, storedPeaks.singles);
    doublesPeakDiff = diffPeaks(doublesRecords, storedPeaks.doubles);
    await writePeakChanges(tx, singlesRecords, storedPeaks.singles, schema.peakRankings);
    await writePeakChanges(tx, doublesRecords, storedPeaks.doubles, schema.doublesPeakRankings);
  });

  return { rowsUpdated, peakDiff, doublesPeakDiff };
}

/** Upsert only the records whose value differs from the stored row, and
 * delete stored rows whose scope no longer has any ledger entries
 * (only possible because reclassification moved every row out of it). */
async function writePeakChanges(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  records: PeakRecord[],
  stored: StoredPeakRow[],
  table: typeof schema.peakRankings | typeof schema.doublesPeakRankings,
): Promise<void> {
  for (const record of records) {
    const existing = stored.find((row) => row.playerId === record.playerId && row.band === record.band);
    if (existing && existing.peakPoints === record.peakPoints) continue;
    await tx
      .insert(table)
      .values({
        playerId: record.playerId,
        band: record.band,
        peakPoints: record.peakPoints,
        peakAsOfSeason: record.peakAsOfWeek.season,
        peakAsOfWeek: record.peakAsOfWeek.week,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [table.playerId, table.band],
        set: {
          peakPoints: record.peakPoints,
          peakAsOfSeason: record.peakAsOfWeek.season,
          peakAsOfWeek: record.peakAsOfWeek.week,
          updatedAt: new Date(),
        },
      });
  }
  const recordScopes = new Set(records.map((record) => scopeKey(record.playerId, record.band)));
  for (const row of stored) {
    if (recordScopes.has(scopeKey(row.playerId, row.band))) continue;
    await tx.delete(table).where(and(eq(table.playerId, row.playerId), eq(table.band, row.band)));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  const database = new URL(connectionString).pathname.slice(1);
  try {
    await runBackfill(db, database, apply, (line) => console.log(line));
  } finally {
    await pool.end();
  }
  // Dry run and apply both exit 0: a dry-run reporting unresolved rows is
  // a completed report, not a failure. The rows are printed for triage.
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
