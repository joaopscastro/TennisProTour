/** Presentation-only helpers shared across screens — nationality
 * flags (components/ui/Flag.tsx, the hand-authored 16×12 SVG set) and
 * tennis scoreline formatting. None of this is domain logic; it's
 * derived purely from DTOs already fetched. Stage metadata lives in
 * `lib/ui/stage.ts` and surface colours in `lib/ui/surfaces.ts` (the
 * copies that used to live here / per screen are deleted). */

/** Compact USD formatting for on-site prize money (e.g. "$1.2M",
 * "$45K", "$0") — shared by the player profile and tournament pages so
 * every money figure in the app reads consistently. */
export function formatMoney(amount: number): string {
  if (amount <= 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}

export const WEEKS_PER_SEASON = 52;

/** The one explanation shown wherever a player is unranked or on zero
 * points — a first-round loss earns no ranking points at any tier, so a
 * new player's "#NR / 0 pts" is the honest, expected starting state, not
 * a bug. Shared so the roster and the profile say the same thing
 * (matches the tournament detail page's "a ranking is earned by
 * winning" copy). */
export const RANKING_EARNED_NOTE = 'A ranking is earned by winning — a first-round loss pays no points.';

/** Which independent ladder a rank belongs to. A player can hold several
 * ranks at once (e.g. an unranked U16 player who is also Senior #3), so
 * every rank display must carry its band or two true numbers read as a
 * contradiction (see the first-time-user walkthrough finding this
 * fixes). Kept local to format.ts rather than importing RankingBand
 * from lib/api so this presentation helper has no client dependency. */
export type RankBand = 'senior' | 'u14' | 'u16' | 'u18';

export const RANK_BAND_LABEL: Record<RankBand, string> = {
  senior: 'Senior',
  u14: 'U14',
  u16: 'U16',
  u18: 'U18',
};

/** Why a rank is what it is, per ladder: each band's ranking counts ONLY
 * results from that band's own events. Winning a senior event puts
 * points on the Senior ladder, never a junior one, so a U14 player can
 * legitimately be unranked in U14 while holding a Senior rank. Shown
 * wherever a band table is empty or a player is unranked, so an
 * "empty-looking" ladder reads as by-design rather than broken. */
export function rankingBandScopeNote(band: RankBand): string {
  return band === 'senior'
    ? 'Only senior-tour results count toward the Senior ranking.'
    : `Only ${RANK_BAND_LABEL[band]} events count toward the ${RANK_BAND_LABEL[band]} ranking — senior and other-band results don't.`;
}

/** F4b: the visible intent behind junior competition — a junior result is
 * not a dead end, because junior results also build the graduation bonus a
 * player takes into the NEXT band. Describes the existing domain rule
 * (`computeGraduationCarryover`, 50% of the player's final total in the
 * band they're leaving, consumed on their first win after moving up)
 * without exposing any hidden number: `GRADUATION_CARRYOVER_FRACTION` is
 * deliberately not read here, the copy just states the rule. Returns null
 * for the senior ladder (there is no band above it). */
export function juniorCarryoverNote(band: RankBand): string | null {
  if (band === 'senior') return null;
  return (
    `Junior results build toward the next band too: half of a player's final ${RANK_BAND_LABEL[band]} total ` +
    'carries over as a one-time bonus on their first win after moving up.'
  );
}

/** How many results each ladder actually counts — the real ITF best-6
 * rule for every junior band, the ATP-derived best-18 for the senior
 * tour. Mirrors `RankingBand.bestResultsCapFor` in the domain (kept as a
 * local literal so this presentation module has no client dependency);
 * pinned against it by the balance of the two literals in
 * display-logic.spec.ts. */
export function bestResultsCountForBand(band: RankBand): number {
  return band === 'senior' ? 18 : 6;
}

/** The one explanation of the best-N cap shown where a manager looks
 * (the standings table, the player profile's junior band cards) so
 * "winning this j100 added nothing" reads as a rule, not a bug: only a
 * player's BEST N results in the rolling 52-week window count, and extra
 * results stay on record but can't add points once N better ones exist. */
export function bestResultsCountNote(band: RankBand): string {
  const cap = bestResultsCountForBand(band);
  const label = band === 'senior' ? 'Senior' : RANK_BAND_LABEL[band];
  return band === 'senior'
    ? `Only a player's best ${cap} results from the rolling 52-week window count toward the ${label} ranking — more results stay on record but can't push the total past the best ${cap}.`
    : `Only a player's best ${cap} results from the rolling 52-week window count toward the ${label} ranking — a further win stays on record, but once ${cap} better results exist it can't add points.`;
}

/** One dated result's ranking-point value, for the best-N verdict below.
 * `weekAbsolute` is `season × 52 + week`, the same continuous week
 * counter the domain's rolling-window maths uses. */
export interface BandRankingResult {
  points: number;
  weekAbsolute: number;
}

export interface BandRankingVerdict {
  /** True when adding this result to the player's other counted results
   * strictly raises their band total (i.e. it is inside the best N and
   * is not merely tied with results already counted). */
  improves: boolean;
  /** Plain-language one-liner for the result row. */
  note: string;
}

/** Absolute week (`season × 52 + week`) for a DTO's season/week pair. */
export function absoluteWeekOf(week: { season: number; week: number }): number {
  return week.season * WEEKS_PER_SEASON + week.week;
}

/** Would this result raise the player's band ranking total? The exact
 * test, not a heuristic: the player's best-N sum WITH the result vs
 * WITHOUT it, both restricted to the rolling 52-week window — the same
 * mechanism `RankingCalculationService` applies (a junior band has no
 * obligatory events, so its total is simply the best N within the
 * window). A result already inside the top N but tied with the results
 * at the cutoff changes nothing and reads "won't improve"; that is
 * deliberate, and it is exactly the measured case of a j100 title
 * adding nothing once six bigger results exist. */
export function bandResultRankingVerdict(opts: {
  band: RankBand;
  result: BandRankingResult;
  otherResults: readonly BandRankingResult[];
  currentWeekAbsolute: number;
}): BandRankingVerdict {
  const cap = bestResultsCountForBand(opts.band);
  const label = opts.band === 'senior' ? 'Senior' : RANK_BAND_LABEL[opts.band];
  const inWindow = (r: BandRankingResult): boolean => {
    const age = opts.currentWeekAbsolute - r.weekAbsolute;
    return age >= 0 && age <= WEEKS_PER_SEASON;
  };
  if (!inWindow(opts.result)) {
    return { improves: false, note: `No longer counts — outside the ${label} rolling 52-week window.` };
  }
  if (opts.result.points <= 0) {
    return { improves: false, note: "Won't add ranking points — a first-round loss pays none." };
  }
  const topSum = (results: readonly BandRankingResult[]): number =>
    [...results]
      .filter(inWindow)
      .sort((a, b) => b.points - a.points)
      .slice(0, cap)
      .reduce((sum, r) => sum + r.points, 0);
  const improves = topSum([...opts.otherResults, opts.result]) > topSum(opts.otherResults);
  return {
    improves,
    note: improves
      ? `Counts toward the ${label} ranking — now inside the best ${cap}.`
      : `Won't improve the ${label} ranking — you already have ${cap} better results.`,
  };
}

/** The subset of a profile history row the best-N verdict needs — kept
 * structural so both the profile preview and the full history page can
 * pass their DTO rows without an adapter. */
export interface BandRankingHistoryEntry {
  tournamentId: string;
  ageBand: RankBand | null;
  pointsEarned: number;
  weekScheduled: { season: number; week: number };
}

/** Per-tournament best-N verdicts for the player's CURRENT junior band,
 * keyed by tournament id. Empty for a senior player (no junior band is
 * live for them) or before the world clock is known — never guessed. */
export function juniorResultVerdicts(
  history: readonly BandRankingHistoryEntry[],
  band: RankBand | null,
  currentWeekAbsolute: number | null,
): Map<string, BandRankingVerdict> {
  const verdicts = new Map<string, BandRankingVerdict>();
  if (band === null || band === 'senior' || currentWeekAbsolute === null) return verdicts;
  const bandEntries = history.filter((entry) => entry.ageBand === band);
  if (bandEntries.length === 0) return verdicts;
  const asResult = (entry: BandRankingHistoryEntry): BandRankingResult => ({
    points: entry.pointsEarned,
    weekAbsolute: absoluteWeekOf(entry.weekScheduled),
  });
  for (const entry of bandEntries) {
    verdicts.set(
      entry.tournamentId,
      bandResultRankingVerdict({
        band,
        result: asResult(entry),
        otherResults: bandEntries.filter((other) => other.tournamentId !== entry.tournamentId).map(asResult),
        currentWeekAbsolute,
      }),
    );
  }
  return verdicts;
}

export interface SetScore {
  winnerGames: number;
  loserGames: number;
}

/** A player's display name, disambiguated against every other player it
 * will be rendered alongside. The name generator draws from a finite
 * pool, so two real, distinct players genuinely can share a full name —
 * which reads as a bug in a list (two identical "Yuki Okafor" cards) or
 * on a bracket ("Amara Yamamoto v Amara Yamamoto"). Given the list, any
 * name that appears more than once gets a short, stable id suffix so
 * every listed player is individually identifiable; unique names are
 * returned untouched. Pure and deterministic — no hidden data leaks,
 * only a public id fragment. */
export interface DisambiguableName {
  id: string;
  name: string;
}

export function disambiguatedNames(players: Iterable<DisambiguableName>): Map<string, string> {
  const all = [...players];
  const counts = new Map<string, number>();
  for (const p of all) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const p of all) {
    const duplicated = (counts.get(p.name) ?? 0) > 1;
    names.set(p.id, duplicated ? `${p.name} (${shortIdSuffix(p.id)})` : p.name);
  }
  return names;
}

/** Last 4 alphanumeric characters of an id, uppercased — a compact,
 * stable secondary identifier for a duplicated name. */
function shortIdSuffix(id: string): string {
  const compact = id.replace(/[^0-9a-zA-Z]/g, '');
  return (compact.slice(-4) || id.slice(-4)).toUpperCase();
}

/** Tennis scoreline notation from a given side's perspective, e.g.
 * "6-4, 7-6" — setScores is stored {winnerGames, loserGames} from the
 * MATCH WINNER's perspective, so this flips each pair when the given
 * side lost, same convention as DrizzleRosterDashboardQuery's
 * lastResultFor. */
export function formatScoreline(setScores: readonly SetScore[], won: boolean): string {
  return setScores.map((s) => (won ? `${s.winnerGames}-${s.loserGames}` : `${s.loserGames}-${s.winnerGames}`)).join(', ');
}

/** Singular round name for a single-match context, e.g. the match-replay
 * breadcrumb ("· Quarterfinal ·") — the bracket screen's own column
 * headers use the plural form ("Quarterfinals") and keep their own
 * local helper, since the two contexts want different grammar. */
export function matchRoundLabel(matchesInRound: number): string {
  if (matchesInRound === 1) return 'Final';
  if (matchesInRound === 2) return 'Semifinal';
  if (matchesInRound === 4) return 'Quarterfinal';
  return `Round of ${matchesInRound * 2}`;
}

/** A tournament-history row's round-reached/outcome label, derived
 * entirely from fields the profile endpoint already returns — reuses
 * matchRoundLabel rather than a second round-naming scheme. The round
 * a player most recently WON is `drawSize / 2**roundsWon` matches wide
 * (roundsWon=1 in a 32-draw won the Round of 32); the round they were
 * ELIMINATED in is one step further, `drawSize / 2**(roundsWon+1)`. */
export function tournamentHistoryResultLabel(entry: {
  hasStarted: boolean;
  won: boolean;
  eliminated: boolean;
  roundsWon: number;
  drawSize: number;
  /** P1-C3: a cancelled draw never played — the entry is real history
   * and must say so plainly rather than fall through to "Not yet
   * started" (which would read as still coming). */
  cancelled?: boolean;
}): string {
  if (entry.cancelled) return 'Cancelled';
  if (entry.won) return 'Champion';
  if (entry.eliminated) return `Lost — ${matchRoundLabel(entry.drawSize / 2 ** (entry.roundsWon + 1))}`;
  if (!entry.hasStarted) return 'Not yet started';
  if (entry.roundsWon === 0) return 'In progress — Round 1';
  return `In progress — through ${matchRoundLabel(entry.drawSize / 2 ** entry.roundsWon)}`;
}
