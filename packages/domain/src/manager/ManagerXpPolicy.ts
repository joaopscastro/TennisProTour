import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Domain service seam for converting a single match result into manager
 * XP — same swappable-policy pattern as RankingPointsTable
 * (CompetitionTypes.ts) and TrainingPolicy: XP-per-result is a tunable
 * formula, not something SimulateMatchUseCase or Player should compute
 * inline. XP is a simple cumulative balance per manager (see
 * ManagerXpRepository), never a rolling/decaying ledger like rankings —
 * it's a spendable currency, not a competitive standing.
 */
export interface ManagerXpPolicy {
  /** XP a manager earns for one rostered player's deciding match result
   * (elimination loss, or the final win) at the given tournament tier. */
  xpFor(result: 'win' | 'loss', tier: TournamentTier): number;
}

/**
 * Illustrative, not balanced — same caveat as StandardTrainingPolicy's
 * BASE_GAIN table and StandardRankingPointsTable's points formula:
 * placeholder constants safe to ship for validating the architecture,
 * but worth a dedicated tuning pass before launch.
 *
 * Formula: xp = BASE_XP + (win ? WIN_BONUS : 0), scaled by a per-tier
 * multiplier — mirrors the same tier-weighting shape ranking points
 * already use (major > tour > challenger > futures), reusing that
 * established ordering rather than inventing a new one, with the
 * junior ladder as its own separate, lower scale below futures.
 */
export class StandardManagerXpPolicy implements ManagerXpPolicy {
  /** PLACEHOLDER: base XP awarded for any deciding match result,
   * regardless of outcome — participation has some value. Not tuned. */
  private static readonly BASE_XP = 10;

  /** PLACEHOLDER: extra XP on top of BASE_XP for a win specifically.
   * Not tuned. */
  private static readonly WIN_BONUS = 15;

  /** PLACEHOLDER: per-tier multiplier applied to (BASE_XP + bonus).
   * Senior tiers keep the original major > tour > challenger > futures
   * ordering. The junior ladder is its own separate, lower-XP scale
   * below futures, ascending with grade (j30 lowest, juniorMasters
   * highest) — junior and senior XP aren't meant to be on one
   * continuous curve, same "junior is its own graduated system" scope
   * decision as the ranking ladder itself
   * (docs/junior-circuit-research-and-proposal.md). Not tuned. */
  private static readonly TIER_MULTIPLIER: Record<TournamentTier, number> = {
    major: 5,
    tour: 3,
    challenger: 2,
    futures: 1.5,
    juniorMasters: 1.4,
    j500: 1.3,
    j300: 1.15,
    j200: 1,
    j100: 0.85,
    j60: 0.7,
    j30: 0.5,
  };

  xpFor(result: 'win' | 'loss', tier: TournamentTier): number {
    const raw = StandardManagerXpPolicy.BASE_XP + (result === 'win' ? StandardManagerXpPolicy.WIN_BONUS : 0);
    return Math.round(raw * StandardManagerXpPolicy.TIER_MULTIPLIER[tier]);
  }
}
