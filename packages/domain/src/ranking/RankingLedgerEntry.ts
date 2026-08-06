import { GameWeek } from '../shared/ids';
import { PlayerId, TournamentId } from '../shared/ids';
import { AgeBand, TournamentTier } from '../competition/CompetitionTypes';

/**
 * One dated ranking result. A player's ranking is the sum of a rolling
 * window over these entries (see RankingCalculationService), never a
 * single mutable running total — that's what makes automatic 52-week
 * expiry possible at all: a flat cumulative counter can't un-count
 * anything later, but a ledger can simply be filtered.
 *
 * `ageBand` mirrors the tournament it was earned at
 * (`Tournament.ageBand`): null for a senior-tier result, `'u14'`/`'u16'`
 * for a junior one. This is what lets a cross-player query scope
 * itself to exactly one of a player's independent rankings (senior
 * tour, U14, U16) — see `RankingBand`/`RankPositionQuery` — without
 * re-deriving the band from `tier` (which alone can't distinguish a
 * U14 J100 result from a U16 J100 result, by design; see JuniorTier's
 * doc comment).
 */
export interface RankingLedgerEntry {
  readonly playerId: PlayerId;
  readonly tournamentId: TournamentId;
  readonly tier: TournamentTier;
  readonly ageBand: AgeBand | null;
  readonly points: number;
  readonly weekEarned: GameWeek;
}
