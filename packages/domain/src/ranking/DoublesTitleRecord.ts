import { GameWeek, PlayerId, TournamentId } from '../shared/ids';
import { AgeBand, TournamentTier } from '../competition/CompetitionTypes';

/**
 * A permanent record that a PAIR won a tournament's doubles draw (P7c) —
 * the doubles analogue of TitleRecord. Append-only, lean, references the
 * tournament by id rather than copying it (same minimal-denormalization
 * shape as TitleRecord: tier/weekEarned are cheap scalars, the name/
 * surface/draw are NOT copied). A doubles title records BOTH players of
 * the winning pair — a tournament's doubles champion is two people, not
 * one — which is why this is a separate shape from TitleRecord rather
 * than a `discipline` flag on it. `ageBand` mirrors the tournament's band
 * (null for senior, u14/u16/u18 for a junior doubles title).
 */
export interface DoublesTitleRecord {
  readonly tournamentId: TournamentId;
  readonly playerA: PlayerId;
  readonly playerB: PlayerId;
  readonly tier: TournamentTier;
  readonly ageBand: AgeBand | null;
  readonly weekEarned: GameWeek;
}
