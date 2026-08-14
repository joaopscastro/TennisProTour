import { GameWeek, isJuniorTier, PlayerId, TournamentTier } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

/**
 * Real ITF rule, not a placeholder guess: "a player may enter up to
 * three ITF Junior Circuit tournaments in a single tournament week,
 * assigning a priority order to each entry" — see
 * docs/junior-circuit-research-and-proposal.md's "Real scheduling
 * constraints" section. 3, not 2, is the number to reuse here for the
 * same reason StandardRankingPointsTable reuses the real ITF point
 * ladder instead of inventing one: when a real, sourced number exists,
 * use it rather than a guess.
 *
 * This game doesn't model entry *priority* (the real rule's "assigning
 * a priority order to each entry" — what happens when two of a
 * player's three chosen tournaments schedule a clash) — just the flat
 * weekly ceiling, which is what actually creates the "which three"
 * decision tension the design doc calls out. Priority ordering is a
 * real, understood extension, not implemented here; revisit only if a
 * scheduling-conflict scenario actually needs it.
 */
export const JUNIOR_WEEKLY_ENTRY_CAP = 3;

/**
 * Senior tour: one tournament per week. Real professional players play
 * a single tournament in any given week — a season is a sequence of
 * one-per-week events, not several simultaneous ones. This used to be
 * deliberately UNCAPPED (a player could enter arbitrarily many senior
 * tournaments the same week), which was merely unrealistic under the
 * old weekly-only clock. Under the day-tick clock it became a real
 * scheduling impossibility: same-week tournaments run their rounds on
 * the same days (see TournamentSchedulePolicy), so a player entered in
 * two at once would have to play two round-1 matches on the same day.
 * Capping at 1 is the senior analogue of the junior 3/week rule and the
 * precondition that makes fatigue/schedule decisions meaningful at all.
 */
export const SENIOR_WEEKLY_ENTRY_CAP = 1;

/** The weekly entry cap that applies to a tournament of the given tier:
 * JUNIOR_WEEKLY_ENTRY_CAP for junior tiers, SENIOR_WEEKLY_ENTRY_CAP for
 * the senior tour. */
export function weeklyEntryCapForTier(tier: TournamentTier): number {
  return isJuniorTier(tier) ? JUNIOR_WEEKLY_ENTRY_CAP : SENIOR_WEEKLY_ENTRY_CAP;
}

/** How many tournaments IN THE SAME RANKING BAND as `tier` (junior vs
 * senior) a player is already entered in for a given GameWeek — the
 * exact count RegisterEntrantUseCase compares against the tier's cap,
 * factored out so a read-only caller (a tournament-list route deciding
 * whether to let a manager even attempt an entry) can show the same
 * real number up front instead of only learning it from a failed
 * registration attempt. The two bands are counted independently: a
 * junior-age player entering the senior tour (allowed) has that senior
 * entry counted only against the senior cap, never the junior one, and
 * vice-versa.
 *
 * Counts SINGLES and DOUBLES entries together (deduplicated by
 * tournament): the cap is "how many tournaments a player plays this
 * week", and a player entered in a tournament's singles AND doubles is
 * still in ONE tournament — while a player entered in the doubles of
 * two different tournaments has genuinely committed to two, exactly the
 * scheduling impossibility the cap exists to prevent (doubles rounds
 * run on the same days as singles). */
export async function countSameBandEntriesForWeek(
  tournaments: TournamentRepository,
  playerId: PlayerId,
  week: GameWeek,
  tier: TournamentTier,
): Promise<number> {
  const [singles, doubles] = await Promise.all([
    tournaments.findByPlayerAndWeek(playerId, week),
    tournaments.findDoublesByPlayerAndWeek(playerId, week),
  ]);
  const wantJunior = isJuniorTier(tier);
  const tournamentIds = new Set<string>();
  for (const t of [...singles, ...doubles]) {
    if (isJuniorTier(t.tier) === wantJunior) tournamentIds.add(t.id);
  }
  return tournamentIds.size;
}
