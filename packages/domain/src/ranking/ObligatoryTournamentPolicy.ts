import { GameWeek, PlayerId, TournamentId } from '../shared/ids';
import { isObligatoryTier, TournamentTier } from '../competition/CompetitionTypes';
import { RankingLedgerEntry } from './RankingLedgerEntry';

/**
 * The rank cutoff at or above which a senior player is treated as
 * having earned DIRECT ACCEPTANCE into an obligatory event — i.e. they
 * were entitled to a main-draw place by ranking and so the "you must
 * count it even if you skip it" rule applies to them. Real tours accept
 * roughly the top ~104 directly into a 128 Slam main draw; 100 is the
 * round placeholder here.
 *
 * PLACEHOLDER, owned by the ranking-realism tuning pass (see
 * docs/ranking-realism-proposal.md), flagged the same way aging
 * thresholds and ranking point values are. Below this cutoff a player
 * is NOT bound by the obligatory rule at all: an unranked or lowly
 * player who skips a Slam owes no mandatory zero, exactly as in real
 * tennis (they'd have had to qualify, not skip a guaranteed place).
 */
export const DIRECT_ACCEPTANCE_CUTOFF = 100;

/**
 * Whether a player at the given senior rank (1-indexed; null = unranked)
 * was entitled to direct acceptance into an obligatory event, and is
 * therefore bound by the mandatory-counting rule. Pure predicate so the
 * cutoff lives in exactly one place.
 */
export function isEligibleForDirectAcceptance(rank: number | null): boolean {
  return rank !== null && rank <= DIRECT_ACCEPTANCE_CUTOFF;
}

/** One obligatory event that was held (its final decided) within the
 * rolling ranking window — the minimal shape the policy needs, so the
 * caller can build it from a Tournament, a query row, or a test fixture
 * without this pure function depending on the Tournament aggregate. */
export interface HeldObligatoryTournament {
  readonly tournamentId: TournamentId;
  readonly tier: TournamentTier;
  /** The game week the event concluded — the `weekEarned` a skip-zero
   * is dated to, so it ages out of the 52-week window on the same
   * schedule a real result from that event would. */
  readonly weekHeld: GameWeek;
}

export interface ObligatoryZeroInput {
  readonly playerId: PlayerId;
  /** The player's CURRENT senior rank (1-indexed; null = unranked). The
   * eligibility gate — only a direct-acceptance-eligible player owes any
   * mandatory zeros at all. See DIRECT_ACCEPTANCE_CUTOFF for why current
   * rank is used as the (documented, deliberate) simplification of
   * "rank at the time each event was held." */
  readonly currentSeniorRank: number | null;
  /** Every obligatory event held within the rolling window. */
  readonly heldObligatory: ReadonlyArray<HeldObligatoryTournament>;
  /** Tournament ids the player has ANY real ledger entry for (played,
   * whatever the result — including a genuine first-round loss). A
   * played event never produces a skip-zero. */
  readonly playedTournamentIds: ReadonlySet<TournamentId>;
}

/**
 * Computes the MANDATORY-SKIP zero entries a senior player owes: for
 * every obligatory event they were eligible for (direct acceptance) but
 * did not play, a `points: 0`, `obligatory: true` ledger entry that
 * `RankingCalculationService` will force into a best-N slot, pushing a
 * real positive result out and lowering the total — the punitive core
 * of the ranking-realism rule (docs/ranking-realism-proposal.md).
 *
 * Pure and total: a non-eligible player (below the cutoff, or unranked)
 * owes nothing; an eligible player owes exactly one zero per
 * unplayed-and-obligatory held event. `ageBand: null` always — the rule
 * is senior-tour only (no junior tier is obligatory, and this never
 * synthesizes a junior entry). Idempotent by construction: re-running
 * with the produced zeros' tournament ids added to `playedTournamentIds`
 * yields no further zeros, so a caller that persists them and re-derives
 * next tick never double-counts.
 */
export function computeObligatoryZeroEntries(input: ObligatoryZeroInput): RankingLedgerEntry[] {
  if (!isEligibleForDirectAcceptance(input.currentSeniorRank)) return [];

  return input.heldObligatory
    .filter((held) => isObligatoryTier(held.tier) && !input.playedTournamentIds.has(held.tournamentId))
    .map((held) => ({
      playerId: input.playerId,
      tournamentId: held.tournamentId,
      tier: held.tier,
      ageBand: null,
      points: 0,
      weekEarned: held.weekHeld,
      obligatory: true,
    }));
}
