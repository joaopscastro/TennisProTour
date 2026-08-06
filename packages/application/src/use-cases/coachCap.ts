import { ManagerId } from '@tennis-manager/domain';
import { BillingPort } from '../ports/ports';

/** Free-tier coach cap. */
export const FREE_COACH_CAP = 1;
/**
 * Manager Pro coach cap. UNLIKE the roster-slot Pro perk
 * (rosterCap.ts's PRO_ROSTER_CAP, which pairs its extra capacity with
 * a built-in cost — faster stat decay), this second coach slot is a
 * DELIBERATE, DISCLOSED exception to CLAUDE.md principle #1's usual
 * "money never buys an unconditional win-rate boost" guardrail. A
 * second coach IS a real, if modest and slow-compounding (see
 * TrainingPolicy.applyCoachBonus — it only ever affects the RATE
 * skills grow at, never a match outcome directly), competitive edge:
 * there is no offsetting cost attached to it the way the roster slot's
 * decay penalty offsets that perk. This was a conscious choice, not an
 * oversight — see docs/manager-xp-and-coaching-system.md section 5 and
 * CLAUDE.md's principle #1 for the full disclosure. It must be stated
 * honestly on the Manager Pro page, not folded in as "pure
 * convenience" alongside the zero-effect-on-competitiveness perks.
 */
export const PRO_COACH_CAP = 2;

/** Shared by ConvertPlayerToCoachUseCase — kept in one place, same
 * pattern as rosterCap.ts's maxRosterSizeFor, so the cap logic can't
 * drift between call sites. */
export async function maxCoachCountFor(managerId: ManagerId, billing: BillingPort): Promise<number> {
  return (await billing.isProSubscriber(managerId)) ? PRO_COACH_CAP : FREE_COACH_CAP;
}
