/**
 * Test-facing type declarations for the pure agent-harness digest helper
 * (`digestFeed.mjs`), so the TypeScript integration suite can import the
 * EXACT production mappers the runner uses (rather than reimplementing
 * them). Deliberately narrow: only the exports the integration tests
 * import are declared. The .mjs module itself stays plain JS because the
 * runner (`agentSeason.mjs`) is executed directly by node, outside the
 * TypeScript build.
 */

export interface CompactedWeek {
  season: number;
  week: number;
}

export interface CompactedDoublesTitle {
  tournamentId: string;
  tier: string;
  partnerId: string;
  partnerName: string;
  partnerNationality: string;
  weekEarned: CompactedWeek;
}

export interface CompactedResult {
  tournamentId: string;
  tournamentName: string;
  tier: string;
  roundNumber: number;
  result: 'win' | 'loss' | 'pending';
  setScores: Array<{ winnerGames: number; loserGames: number }> | null;
  weekScheduled: CompactedWeek;
  discipline: 'singles' | 'doubles';
}

export function compactSinglesTitles(
  profile: unknown,
  options?: { currentSeason?: number; limit?: number },
): Array<{
  tournamentId: string;
  name: string;
  tier: string;
  ageBand: string | null;
  weekEarned: CompactedWeek;
}>;

export function compactDoublesTitles(
  profile: unknown,
  options?: { currentSeason?: number; limit?: number },
): CompactedDoublesTitle[];

export interface CompactedSeasonTitles {
  season: number;
  singles: number;
  doubles: number;
}

export function compactTitlesBySeason(profile: unknown): CompactedSeasonTitles[];

export const MAX_TITLES_DETAIL: number;

export function headlineRanking(
  rankings: unknown,
  preferredBand: string,
): { band: string; rank: number | null; totalPoints?: number; points?: number };

export const TWO_WEEK_TIERS: string[];

export function tournamentConclusion(t: {
  tier: string;
  drawSize?: number;
  totalRounds?: number;
  qualifyingRoundCount?: number;
  startDay?: number;
  weekScheduled?: CompactedWeek | null;
}): { concludesInWeek: CompactedWeek | null; finalDay: number | null };

export interface PracticeReward {
  experiencePerSession: number;
  fatiguePerSession: number;
  ladderPointsPerSession: number;
  ladderSessionsPerWeek: number;
  maxLadderPointsPerWeekPerPlayer: number;
  note: string;
}

export const PRACTICE_REWARD: {
  experiencePerSession: number;
  fatiguePerSession: number;
  ladderPointsPerSession: number;
  ladderSessionsPerWeek: number;
};

export function practiceReward(): PracticeReward;

export function compactLastResults(matches: unknown, limitPerDiscipline?: number): CompactedResult[];

export interface CompactedShop {
  /** The manager's live XP balance, or null when the response carries no
   * number (unknown, never an invented 0). */
  xpBalance: number | null;
  owned: string[];
  items: Array<{
    itemId: string;
    kind: string;
    name: string;
    description: string;
    price: number;
    glyph: string;
    owned: boolean;
    affordable: boolean | null;
  }>;
}

export function compactShop(shopBody: unknown): CompactedShop;
