/** Presentation-only helpers shared across screens — nationality
 * flags and tennis scoreline formatting. None of this is domain logic;
 * it's derived purely from DTOs already fetched. Stage metadata lives in
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

/** A flat flag glyph from any 2-letter nationality code.
 * STAGE 8: replace every caller with `<Flag code={...} />`
 * (components/ui/Flag.tsx, the hand-authored 16×12 SVG set) and delete
 * this emoji helper — screens still on the old look import it. */
export function flagFor(nationality: string): string {
  if (!/^[A-Za-z]{2}$/.test(nationality)) return '\u{1F3F3}\u{FE0F}';
  const base = 0x1f1e6;
  return nationality
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(base + c.charCodeAt(0) - 65))
    .join('');
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
}): string {
  if (entry.won) return 'Champion';
  if (entry.eliminated) return `Lost — ${matchRoundLabel(entry.drawSize / 2 ** (entry.roundsWon + 1))}`;
  if (!entry.hasStarted) return 'Not yet started';
  if (entry.roundsWon === 0) return 'In progress — Round 1';
  return `In progress — through ${matchRoundLabel(entry.drawSize / 2 ** entry.roundsWon)}`;
}
