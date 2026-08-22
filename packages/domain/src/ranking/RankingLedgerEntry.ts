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
 * (`Tournament.ageBand`): null for a senior-tier result, `'u14'`/`'u16'`/
 * `'u18'` for a junior one. This is what lets a cross-player query scope
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
  /**
   * Which discipline this result belongs to — singles (the default,
   * every pre-P7b entry) or doubles (P7b, where BOTH players of the
   * winning pair get their own entry). Optional and defaulting to
   * undefined so every existing construction site and persisted row is
   * unchanged. A doubles ranking is computed from the same ledger,
   * filtered to `discipline === 'doubles'` (and always `ageBand ===
   * null`, since doubles is senior-only in v1).
   */
  readonly discipline?: 'singles' | 'doubles';
  /**
   * True only for a MANDATORY-SKIP zero: a `points: 0` entry recorded
   * because the player was eligible for an obligatory event
   * (`isObligatoryTier`) that week and did NOT enter it — the "0 that
   * burns a best-N slot" rule (see docs/ranking-realism-proposal.md).
   * Optional and defaulting to undefined so every existing construction
   * site (and every persisted row predating this field) is unchanged: a
   * real played result — including a genuine first-round loss at a major,
   * which also scores 0 — always leaves this absent/false. The flag
   * exists to tell those two 0-point major entries apart for honest
   * display/audit ("skipped" vs "lost R1"); the ranking TOTAL treats
   * both identically, since an obligatory tier always counts either way.
   */
  readonly obligatory?: boolean;
}
