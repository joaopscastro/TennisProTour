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

export class StandardRankingPointsTable implements RankingPointsTable {
  private static readonly BASE_POINTS: Record<TournamentTier, number> = {
    junior: 5,
    futures: 15,
    challenger: 40,
    tour: 100,
    major: 400,
  };

  pointsFor(tier: TournamentTier, roundsWon: number): number {
    return StandardRankingPointsTable.BASE_POINTS[tier] * Math.pow(1.6, roundsWon);
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
