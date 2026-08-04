import { Surface } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';

export type TournamentTier = 'junior' | 'futures' | 'challenger' | 'tour' | 'major';

/** Single-elimination draw sizes the game supports. */
export type DrawSize = 16 | 32 | 64 | 128;

/** Ranking points awarded per tier/round — externalized as data, not
 * hardcoded into Tournament, so game-balance changes don't require
 * touching the aggregate's code (Open/Closed). */
export interface RankingPointsTable {
  pointsFor(tier: TournamentTier, roundsWon: number): number;
}

/**
 * Real ATP ranking tables are published per round reached, not
 * computed from a formula — a semifinalist earns roughly half of the
 * champion's points, not an exponentially compounding fraction of it.
 * These tables mirror that shape, scaled to this game's 5 tiers:
 * champion points match real-world proportions exactly (major=2000,
 * tour=500 i.e. an ATP 500 event, challenger=125, futures=25,
 * junior=5), with the rounds below scaled down from real ATP/
 * Challenger/ITF round breakdowns rather than an arbitrary curve.
 *
 * Indexed by roundsWon (0 = lost in the first round, up to 7 = won a
 * 128-draw tournament without dropping a round). A tier/draw
 * combination that can't reach index 7 (e.g. a 16-draw futures event)
 * simply never looks up the higher indices — the table doesn't need to
 * be draw-size-aware itself, Tournament already knows how many rounds
 * a given draw has.
 */
export class StandardRankingPointsTable implements RankingPointsTable {
  private static readonly POINTS_BY_ROUND: Record<TournamentTier, ReadonlyArray<number>> = {
    // roundsWon:     0    1    2    3    4    5    6     7
    major:           [10,  45,  90,  180, 360, 720, 1200, 2000],
    tour:            [3,   11,  23,  45,  90,  180, 300,  500],
    challenger:      [1,   3,   6,   11,  23,  45,  75,   125],
    futures:         [1,   1,   2,   3,   5,   9,   15,   25],
    junior:          [0,   0,   1,   1,   2,   3,   3,    5],
  };

  pointsFor(tier: TournamentTier, roundsWon: number): number {
    const table = StandardRankingPointsTable.POINTS_BY_ROUND[tier];
    const index = Math.min(Math.max(roundsWon, 0), table.length - 1);
    return table[index];
  }
}

export interface TournamentEntrant {
  playerId: PlayerId;
  seed: number | null;
}

export type MatchOutcome = {
  winner: PlayerId;
  loser: PlayerId;
  setScores: ReadonlyArray<{ winnerGames: number; loserGames: number }>;
};

/**
 * A replay log for "fake live" playback, mirroring the pattern
 * Rocking Rackets uses: the match is fully simulated up front, and the
 * frontend fetches this log once and steps through it on a client-side
 * timer to fake a live scenario. No WebSocket, no persistent
 * connection, no server-side timing coordination — viewer count has
 * zero effect on backend cost since this is just a static blob that
 * can sit behind a CDN.
 *
 * Deliberately NOT stored inside the Tournament aggregate: Tournament
 * only needs the compact MatchOutcome to progress brackets and award
 * ranking points. The full log is comparatively heavy (one entry per
 * game/point) and belongs in cheap object storage referenced by
 * matchId, not in the aggregate's own persisted state.
 */
export interface MatchLogEntry {
  /** Seconds since match "start", used purely for client playback
   * pacing — has no bearing on anything the domain computes. */
  offsetSeconds: number;
  setNumber: number;
  gamesForA: number;
  gamesForB: number;
  wonBy: 'A' | 'B';
  /**
   * Who served this game. Alternates every game — standard tennis
   * convention — continuously across the WHOLE match, not reset per
   * set: a tiebreak counts as exactly one unit of alternation, so the
   * server sequence carries correctly into the next set (the real
   * ATP rule: whoever received first in the tiebreak serves first in
   * the next set). Player A is fixed as the match's first server;
   * nothing in this domain models a coin-toss/service-choice, so this
   * is a deliberate simplification, not an attempt at realism there.
   *
   * This is what makes real break-of-serve detection possible (a
   * notable moment is exactly `wonBy !== server`) instead of the
   * "reached deuce" stand-in used before this field existed — but
   * "break" isn't a meaningful concept for a tiebreak-decided game
   * (service rotates every 2 points within a breaker), so consumers
   * should treat this field as informational-only for tiebreak
   * entries, not feed it into break-of-serve commentary.
   */
  server: 'A' | 'B';
}

/**
 * A completed game is a break of serve exactly when its winner isn't
 * who served it — the real definition, now that MatchLogEntry.server
 * exists, replacing the "reached deuce" stand-in the replay
 * commentary previously used in its place. Deliberately doesn't
 * exclude tiebreaks itself (a tiebreak's `server` is still a
 * well-defined value, just not one "break" is a meaningful concept
 * for, since service rotates every 2 points within a breaker) — that
 * judgment call belongs to whoever is deciding what counts as
 * notable commentary, not to this factual predicate. Callers that
 * care can detect a tiebreak-decided entry from its score alone: this
 * simulator only ever reaches a tiebreak at 6-6, so a final score of
 * 7-6 (or 6-7) uniquely identifies one.
 */
export function isBreakOfServe(entry: Pick<MatchLogEntry, 'wonBy' | 'server'>): boolean {
  return entry.wonBy !== entry.server;
}

/** A standard game's score reads '0'/'15'/'30'/'40', then 'Ad' once
 * deuce (40-40) is broken by one point without the required 2-point
 * margin. A tiebreak instead counts literally (0, 1, 2, ... 7, ...),
 * so this also accepts a plain numeric string for that case — there's
 * no shared vocabulary between the two scoring systems in real tennis
 * either. */
export type PointScoreLabel = '0' | '15' | '30' | '40' | 'Ad' | `${number}`;

/**
 * One point within one game — the detail MatchLogEntry deliberately
 * doesn't carry (see its own doc comment: it's the game-level rollup
 * used for the bracket/scrub-bar tick marks). pointScoreA/pointScoreB
 * are the score *before* this point is decided (the stakes the point
 * was played for), which is always a valid, in-progress tennis score;
 * wonBy says who won it. A reader doesn't need a separate "Game" sentinel
 * to know a game just ended — that's exactly when the next MatchLogEntry
 * appears at the same offsetSeconds.
 */
export interface MatchPointEntry {
  offsetSeconds: number;
  setNumber: number;
  /** 1-indexed within the set; a tiebreak is conventionally the set's
   * 13th game (played after 12 games split 6-6). */
  gameNumber: number;
  pointScoreA: PointScoreLabel;
  pointScoreB: PointScoreLabel;
  wonBy: 'A' | 'B';
}

export interface MatchLog {
  /** Game-completion rollup — unchanged shape, still what the
   * bracket/scrub-bar tick marks and the game-by-game commentary
   * line consume. */
  entries: ReadonlyArray<MatchLogEntry>;
  /** Point-by-point detail alongside the rollup above, not merged
   * into it — existing consumers of `entries` are unaffected by this
   * addition. */
  points: ReadonlyArray<MatchPointEntry>;
  totalDurationSeconds: number;
  /**
   * ISO 8601 timestamp of the real moment this match was actually
   * simulated — the anchor the "wall-clock-synced Premiere" playback
   * model (docs/ui-direction.md) is built on. Every viewer who opens
   * the same match sees it capped to the same real-time position
   * (`min((Date.now() - simulatedAt) / 1000, totalDurationSeconds)`
   * in-game seconds, since pacing is calibrated so one in-game second
   * of simulated match time approximates one real second of an actual
   * broadcast), never a free on-demand replay from zero. Deliberately
   * NOT produced by StatisticalMatchSimulator itself — the simulator
   * stays pure/deterministic given a RandomSource, no real Date.now()
   * dependency; this is stamped by the application layer at the
   * moment the log is handed to MatchLogStorePort (see
   * SimulateMatchUseCase), the same real-world-timestamp pattern
   * already used for domain events' `occurredAt`.
   */
  simulatedAt: string;
}

export interface BracketRound {
  roundNumber: number;
  matches: ReadonlyArray<{
    entrantA: PlayerId;
    entrantB: PlayerId;
    outcome: MatchOutcome | null;
  }>;
}
