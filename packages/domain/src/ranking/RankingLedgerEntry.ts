import { GameWeek } from '../shared/ids';
import { PlayerId, TournamentId } from '../shared/ids';
import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * One dated ranking result. A player's ranking is the sum of a rolling
 * window over these entries (see RankingCalculationService), never a
 * single mutable running total — that's what makes automatic 52-week
 * expiry possible at all: a flat cumulative counter can't un-count
 * anything later, but a ledger can simply be filtered.
 */
export interface RankingLedgerEntry {
  readonly playerId: PlayerId;
  readonly tournamentId: TournamentId;
  readonly tier: TournamentTier;
  readonly points: number;
  readonly weekEarned: GameWeek;
}
