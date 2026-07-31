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

export interface MatchLog {
  entries: ReadonlyArray<MatchLogEntry>;
  totalDurationSeconds: number;
}

export interface BracketRound {
  roundNumber: number;
  matches: ReadonlyArray<{
    entrantA: PlayerId;
    entrantB: PlayerId;
    outcome: MatchOutcome | null;
  }>;
}
