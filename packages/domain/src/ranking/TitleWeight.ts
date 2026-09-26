import { RankingPointsTable, StandardRankingPointsTable, TournamentTier } from '../competition/CompetitionTypes';

/**
 * Tier-weighted title figures — the display counterpart to the raw title
 * COUNT, which on its own is tier-blind: 73 titles at J30/J60/J100 and 29
 * titles including a major are not the same achievement, but a bare count
 * cannot tell them apart (observed live: a 73-title junior finished last
 * on the manager ladder while a 29-title manager with a major finished
 * second).
 *
 * The weight is deliberately NOT a new balance constant: a title's weight
 * is the champion's RANKING-POINT value for that tier, read from the same
 * `StandardRankingPointsTable` the simulator awards points from — one
 * source of truth, so the two can never drift. This is a DISPLAY/sorting
 * aid only: the manager ladder remains the competitive authority and
 * `ManagerLadderPolicy.creditFor` already weights results by their ranking
 * points, so titles are never double-counted into it.
 *
 * `pointsFor` clamps `roundsWon` to its table's last index (the champion
 * row), so a deliberately large value reads the tier's champion value with
 * no per-tier draw-size mapping needed.
 */
export function titleWeightFor(tier: TournamentTier, table: RankingPointsTable = new StandardRankingPointsTable()): number {
  return table.pointsFor(tier, Number.MAX_SAFE_INTEGER);
}

/** A player's titles summarised for display: the raw count AND the
 * tier-weighted total together, plus the per-tier breakdown the labels
 * use to say which ladder a record was actually built on. */
export interface TitleTally {
  count: number;
  weight: number;
  byTier: Partial<Record<TournamentTier, number>>;
}

/** The one summariser both the profile (a list of records) and the
 * grouped by-player read (the Scouting pool) use, so count/weight can
 * never disagree between surfaces. */
export function summarizeTitleTiers(
  tiers: readonly TournamentTier[],
  table: RankingPointsTable = new StandardRankingPointsTable(),
): TitleTally {
  const byTier: Partial<Record<TournamentTier, number>> = {};
  let weight = 0;
  for (const tier of tiers) {
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    weight += titleWeightFor(tier, table);
  }
  return { count: tiers.length, weight, byTier };
}
