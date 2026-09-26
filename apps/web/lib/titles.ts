/**
 * Pure presentation helpers for the tier-weighted title figure (D2).
 *
 * A raw title COUNT is tier-blind — 73 titles at J30/J60/J100 and 29
 * titles including a major are not the same achievement, but "73" > "29"
 * on its own. The server now sends the tier-weighted total alongside the
 * count (see the API's TitleWeight.ts: each title weighs its tier's
 * champion ranking-point value, straight from the one points table), and
 * these helpers render BOTH together, never one without the other.
 *
 * Presentation-only by design: the manager ladder remains the
 * competitive authority and is deliberately unchanged.
 */

/** The structural shape every surface receives — the API's TitleTally. */
export interface TitleTallyShape {
  count: number;
  weight: number;
  byTier: Readonly<Record<string, number | undefined>>;
}

/** Which tier is the "headline" of a title list, ordered by champion
 * weight (StandardRankingPointsTable): major 2000, tour 1000,
 * juniorMasters 700 (placeholder), challenger/j500 500, j300 300,
 * futures 250, j200 200, j100 100, j60 60, j30 30. Display-only — the
 * numeric WEIGHT (server-computed) is the authority, this just names the
 * best rung for the caption. */
const TIER_PROMINENCE_ORDER = [
  'major',
  'tour',
  'juniorMasters',
  'challenger',
  'j500',
  'j300',
  'futures',
  'j200',
  'j100',
  'j60',
  'j30',
] as const;

const TIER_LABEL: Record<string, string> = {
  major: 'Major',
  tour: 'Tour',
  juniorMasters: 'Junior Masters',
  challenger: 'Challenger',
  futures: 'Futures',
  j500: 'J500',
  j300: 'J300',
  j200: 'J200',
  j100: 'J100',
  j60: 'J60',
  j30: 'J30',
};

/** The single most noteworthy thing about a title list, or null when
 * there are none: majors first (called out by count), else the
 * highest-weight tier present. One sentence fragment, not a sentence. */
export function titleProminence(byTier: TitleTallyShape['byTier']): string | null {
  const majors = byTier['major'] ?? 0;
  if (majors > 0) return majors === 1 ? '1 Major' : `${majors} Majors`;
  for (const tier of TIER_PROMINENCE_ORDER) {
    if ((byTier[tier] ?? 0) > 0) return `best ${TIER_LABEL[tier]}`;
  }
  return null;
}

/** One always-honest line for a card or headline: the raw count AND the
 * tier-weighted points together, plus the best rung when there is a
 * meaningful one. Examples:
 *   "29 titles · 3,350 pts · 1 Major"
 *   "73 titles · 4,380 pts · best J60"
 * A player with no titles says so plainly rather than showing "0 pts". */
export function titleSummaryLabel(tally: TitleTallyShape): string {
  if (tally.count === 0) return 'No titles';
  const count = `${tally.count} ${tally.count === 1 ? 'title' : 'titles'}`;
  const weight = `${tally.weight.toLocaleString('en-US')} pts`;
  const prominence = titleProminence(tally.byTier);
  return prominence ? `${count} · ${weight} · ${prominence}` : `${count} · ${weight}`;
}
