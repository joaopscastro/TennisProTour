/** Presentation-only helpers shared across screens — nationality
 * flags, player initials/avatar tint, and tennis scoreline
 * formatting. None of this is domain logic; it's derived purely from
 * DTOs already fetched, same reasoning as RosterDashboardEntry's
 * "don't add avatar color to the backend" decision. */

const AVATAR_COLORS = [
  'oklch(58% 0.14 45)',
  'oklch(55% 0.13 240)',
  'oklch(48% 0.05 300)',
  'oklch(52% 0.12 142)',
  'oklch(62% 0.13 75)',
  'oklch(55% 0.16 25)',
];

export function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

/** A flat flag glyph from any 2-letter nationality code — see
 * page.tsx's original note: real hired players can carry any
 * nationality string, not the mockup's fixed curated per-country
 * flat-CSS-swatch set, so this derives a real flag glyph generically
 * instead of hand-maintaining a palette. */
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

export interface SetScore {
  winnerGames: number;
  loserGames: number;
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
