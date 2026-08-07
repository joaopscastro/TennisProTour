import { AgeRange } from '@tennis-manager/domain';

/**
 * The age window every player-generating call site currently uses:
 * new talent is always young (14-16 years old, i.e. 14*52 to just
 * under 16*52 weeks) — representing new prospects entering the world,
 * never someone generated directly into their prime or senior years.
 * Growth past this happens entirely through PlayerAgingService's
 * weekly ticks over real in-game time, never by generating an older
 * player outright.
 *
 * This is a CALL-SITE decision, not a constraint PlayerGenerationPolicy
 * itself knows about or enforces (see AgeRange's doc comment) — both
 * RefreshTalentPoolUseCase (the weekly talent-pool batch) and
 * CreateCustomPlayerUseCase (Manager Pro's custom-player path) import
 * this same constant so the two flows can never drift onto different
 * ranges, matching the fairness constraint CreateCustomPlayerUseCase's
 * own doc comment already insists on for tier odds.
 *
 * Real, worth-knowing consequence of this exact range: 14*52 (728
 * weeks) is precisely RankingBand's U14/U16 boundary
 * (juniorEligibilityForAge), so every freshly-generated player lands
 * in the U16 junior band, never U14 — there is still no path that
 * generates a player young enough to be U14-eligible. See
 * docs/junior-circuit-research-and-proposal.md's status section.
 */
export const TALENT_POOL_AGE_RANGE: AgeRange = {
  minWeeks: 14 * 52,
  maxWeeks: 16 * 52 - 1,
};
