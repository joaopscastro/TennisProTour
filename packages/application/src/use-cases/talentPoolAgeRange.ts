import { AgeRange } from '@tennis-manager/domain';

/**
 * The age window every player-generating call site currently uses:
 * new talent is always young (12-16 years old, i.e. 12*52 to just
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
 * **Widened from the original 14-16yo range — this is the fix, not
 * just disclosure.** The original range started EXACTLY at RankingBand's
 * U14/U16 boundary (14*52 = 728 weeks, inclusive on the U14 side per real
 * Tennis Europe "14-and-under" eligibility), so a generated player could
 * only ever land in U14 by rolling the single exact integer week 728 out
 * of a ~206-week-wide draw — roughly 1-in-206 per generation. That made
 * U14 technically reachable through the real weekly talent-pool refresh
 * (the primary way a manager discovers new signings) but not a real
 * supply: in practice the U14 ladder was fed almost entirely by
 * EnsureFillOnlyPopulationUseCase's small (10-player) fill-only safety
 * floor — anonymous bracket-padding fillers, never genuine manager-
 * discoverable prospects — which is exactly the "U14 tournaments exist
 * but the world never has real U14 players" gap this widening closes.
 * minWeeks now matches the fill-only floor's own U14 age range
 * (12-14yo, see EnsureFillOnlyPopulationUseCase's FILL_ONLY_FLOORS), so
 * roughly half of every weekly batch (624-728 of the 624-831 span) now
 * lands genuinely U14-eligible — a real, ordinary supply through the
 * normal scouting flow, not a rare fluke. See
 * docs/junior-circuit-research-and-proposal.md's status section for the
 * original 1-in-206 finding this supersedes.
 */
export const TALENT_POOL_AGE_RANGE: AgeRange = {
  minWeeks: 12 * 52,
  maxWeeks: 16 * 52 - 1,
};
