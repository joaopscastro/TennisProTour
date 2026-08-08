import { GameWeek, PlayerId, TournamentId } from '../shared/ids';
import { AgeBand, TournamentTier } from '../competition/CompetitionTypes';

/**
 * A permanent record that a player won a specific tournament — append-
 * only (a completed tournament's result never changes) but lean, per
 * docs/data-archival-principles.md: `tournamentId` is a REFERENCE back
 * to the canonical Tournament data, not a copy of it. Display-time
 * code joins back to the tournaments table for the name/surface/draw
 * size rather than this record duplicating them (same minimal-
 * denormalization shape RankingLedgerEntry already uses for
 * tier/ageBand/weekEarned — scalars cheap enough to keep query-side
 * filtering simple, never the tournament's generated name or other
 * display-only detail).
 */
export interface TitleRecord {
  readonly tournamentId: TournamentId;
  readonly playerId: PlayerId;
  readonly tier: TournamentTier;
  readonly ageBand: AgeBand | null;
  readonly weekEarned: GameWeek;
}
