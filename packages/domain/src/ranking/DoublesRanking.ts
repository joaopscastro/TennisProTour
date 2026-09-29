import { GameWeek, PlayerId } from '../shared/ids';
import { RankingBand } from './RankingBand';
import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Doubles ranking (P7b + junior doubles) — the small amount of
 * ranking-specific rule that lives in the domain, kept separate from the
 * singles/junior RankingBand machinery because doubles is a DISCIPLINE
 * (a filter on the same ledger) layered ON TOP of the age bands (see
 * RankingLedgerEntry.discipline + ageBand): the senior doubles ranking,
 * the U14 doubles ranking and the U16 doubles ranking are three separate
 * ladders.
 */

/** The SENIOR doubles ranking's best-N cap — RR's real number (best 14
 * over a rolling 52 weeks), vs. 18 for the senior singles tour. */
export const DOUBLES_BEST_RESULTS_CAP = 14;

/** The best-N cap for a doubles ranking in a given band: 14 for senior
 * (RR), 6 for either junior band (the real ITF junior rule — juniors
 * count their best 6 singles AND best 6 doubles). Parameterized like
 * RankingBand.bestResultsCapFor, for the same "one cap-per-band
 * decision, not re-derived per caller" reason. */
export function doublesBestResultsCapFor(band: RankingBand): number {
  return band === 'senior' ? DOUBLES_BEST_RESULTS_CAP : 6;
}

/**
 * A player's ENTRY ranking for doubles — the real ATP/WTA combined-
 * ranking rule: their doubles ranking if they have one, otherwise their
 * singles ranking. This is what makes the first doubles draws work (no
 * one has a doubles ranking yet, so everyone falls back to singles) and
 * what lets doubles ranking take over as results accumulate. Pure; the
 * two totals are computed elsewhere (the ledger queries), this only
 * picks.
 */
export function doublesEntryRanking(doublesTotal: number, singlesTotal: number): number {
  return doublesTotal > 0 ? doublesTotal : singlesTotal;
}

/** How much a doubles result is worth relative to the same singles
 * result at a tier with no real published doubles table (currently just
 * the six junior grades + juniorMasters — ITF junior doubles isn't
 * covered by the ATP rulebook this project otherwise sources from).
 * PLACEHOLDER, applied to the shared StandardRankingPointsTable value at
 * award time. Senior tiers no longer use this fallback at all — see
 * `SENIOR_DOUBLES_POINTS_BY_ROUND` below. */
export const DOUBLES_POINTS_FACTOR = 0.5;

/**
 * Real, sourced senior doubles points from the 2026 PIF ATP Doubles
 * Rankings table (Chapter IX) — the SOURCE OF TRUTH, kept unscaled. The
 * game's AWARD-TIME function applies `DOUBLES_POINTS_PARITY_FACTOR` on
 * top (see `doublesPointsFor`); this raw table is still what historical
 * reconstruction (the discipline backfill) must read, because it
 * reproduces what the ledger actually recorded at the time. Same tier
 * mapping `StandardRankingPointsTable` uses (major↔Grand Slam, tour↔ATP
 * Tour Masters 1000, challenger↔ATP Tour 500, futures↔ATP Tour 250),
 * and once again the draw sizes line up exactly with a real published
 * variant with no interpolation needed: this project's
 * `doublesDrawSizeFor` derives a doubles draw as roughly half the
 * singles draw (major→64, tour→32, challenger/futures→16 pairs), which
 * matches a real Grand Slam doubles draw (64 teams), the ATP 1000
 * 32-team doubles draw, and the ATP 500/250 16-team doubles draws
 * exactly.
 *
 * Real doubles rule: "No points are awarded in the first round at any
 * event" (9.02.E) — matching this project's own "earned by winning"
 * house rule with no deviation needed here (unlike singles, where
 * Grand Slams/Masters 1000 do pay a small real first-round score that
 * this project deliberately still zeroes out).
 */
const SENIOR_DOUBLES_POINTS_BY_ROUND: Readonly<Partial<Record<TournamentTier, ReadonlyArray<number>>>> = {
  // roundsWon:  0   1   2    3    4     5
  major:        [0,  90, 180, 360, 720, 1200, 2000],
  tour:         [0,  90, 180, 360, 600, 1000],
  challenger:   [0,  90, 180, 300, 500],
  futures:      [0,  45, 90,  150, 250],
};

/**
 * The game's DELIBERATE deviation from raw ATP doubles parity (season-4
 * balance fix; PLACEHOLDER-but-measured): a senior doubles award is
 * worth half the sourced table.
 *
 * Why deviate from a sourced number, stated plainly: real ATP doubles
 * pays the same champion value as singles from a smaller draw, because
 * in real tennis a player cannot simply play BOTH every week — the
 * calendar, the entry rules and the physical cost force a choice. This
 * game's structure does not: every event carries a doubles draw, a
 * persistent pair of the manager's own players is entered at the same
 * tournament with no extra weekly-cap cost, and BOTH partners' results
 * credit the same manager ladder. Measured over the 52-week season-4
 * agent world, that made doubles earn 1.3-3.1× the singles points per
 * entry (the champion: 2,506 vs 800) and two pairs took the large
 * majority of titles — "play doubles every week" was close to strictly
 * better, not a choice. Halving the senior table brings the aggregate
 * to parity (measured: 918 vs 938 points/entry across the three
 * doubles-playing managers) while keeping the sourced round-by-round
 * SHAPE intact. The junior fallback (0.5 × the singles award) already
 * sat at this level and is deliberately NOT scaled again. Both numbers
 * and rationale live in docs/balance-tuning-report.md.
 */
export const DOUBLES_POINTS_PARITY_FACTOR = 0.5;

/** The raw, UNScaled doubles award for a tier/round — the sourced senior
 * table where one exists, the junior singles-derived placeholder
 * (`DOUBLES_POINTS_FACTOR`) otherwise. Used by award-time code through
 * `doublesPointsFor`, and directly by the ranking-discipline backfill,
 * which must reproduce the values history actually wrote. */
export function sourcedDoublesPointsFor(tier: TournamentTier, roundsWon: number, singlesPoints: number): number {
  const table = SENIOR_DOUBLES_POINTS_BY_ROUND[tier];
  if (table) return table[Math.min(Math.max(roundsWon, 0), table.length - 1)];
  return Math.round(singlesPoints * DOUBLES_POINTS_FACTOR);
}

/** Doubles ranking points for a tier/round, AS AWARDED by this game: the
 * sourced senior table scaled by `DOUBLES_POINTS_PARITY_FACTOR`, or the
 * junior placeholder fallback (already at the same 0.5 level, unscaled
 * again). `singlesPoints` is the tier/round's already-computed singles
 * award — only consumed by the fallback path, so a caller with a senior
 * tier never needs to have computed it just to throw it away, but every
 * existing call site already has it in scope either way. */
export function doublesPointsFor(tier: TournamentTier, roundsWon: number, singlesPoints: number): number {
  const table = SENIOR_DOUBLES_POINTS_BY_ROUND[tier];
  if (table) return Math.round(sourcedDoublesPointsFor(tier, roundsWon, singlesPoints) * DOUBLES_POINTS_PARITY_FACTOR);
  return sourcedDoublesPointsFor(tier, roundsWon, singlesPoints);
}

/** The flat-factor scaling alone, for a fixed/capstone-style payout
 * that has no real "round reached" of its own to look up (e.g. the
 * Masters Cup's flat semifinalist/runner-up/champion awards) — the ATP
 * rulebook's per-round doubles table doesn't apply to an event shaped
 * like that, so this deliberately does NOT route through
 * `doublesPointsFor`'s real senior table. */
export function scaleDoublesPoints(singlesPoints: number): number {
  return Math.round(singlesPoints * DOUBLES_POINTS_FACTOR);
}

/**
 * Senior doubles prize money by round — the money counterpart to
 * SENIOR_DOUBLES_POINTS_BY_ROUND, same PLACEHOLDER-dollar-figure caveat
 * as StandardPrizeMoneyTable, and the value CREDITED TO EACH PLAYER of
 * the pair (mirrors doublesPointsFor: both partners get their own
 * award, not a team total split between them). Unlike the points
 * table, index 0 is deliberately non-zero — same "paid to play, ranked
 * to win" divergence documented on StandardPrizeMoneyTable: a doubles
 * team that plays and loses its first match still played a real match.
 * No junior fallback table exists — junior doubles prize money is
 * always 0 (see StandardPrizeMoneyTable's junior-tier doc comment; the
 * same "ITF juniors don't pay meaningful cash prizes" reasoning applies
 * to junior doubles too).
 */
const SENIOR_DOUBLES_PRIZE_MONEY_BY_ROUND: Readonly<Partial<Record<TournamentTier, ReadonlyArray<number>>>> = {
  // roundsWon:  0     1     2      3      4      5       6
  major:        [3000, 5500, 10000, 20000, 40000, 80000, 150000],
  tour:         [1500, 3000, 5500,  10000, 20000, 40000],
  challenger:   [700,  1300, 2500,  4500,  9000],
  futures:      [400,  750,  1400,  2500,  5000],
};

/** Doubles prize money for a tier/round — the money counterpart to
 * doublesPointsFor. Junior tiers (no table entry) always return 0. */
export function doublesPrizeMoneyFor(tier: TournamentTier, roundsWon: number): number {
  const table = SENIOR_DOUBLES_PRIZE_MONEY_BY_ROUND[tier];
  if (!table) return 0;
  return table[Math.min(Math.max(roundsWon, 0), table.length - 1)];
}

/**
 * A player's permanent high-water-mark DOUBLES ranking total in one band
 * (P7c + junior doubles) — the doubles analogue of PeakRankingEntry.
 * One row per (player, band), updated in place, never append-only.
 * `peakAsOfWeek` is display context only.
 */
export interface DoublesPeakRankingEntry {
  readonly playerId: PlayerId;
  readonly band: RankingBand;
  readonly peakPoints: number;
  readonly peakAsOfWeek: GameWeek;
}

/** The doubles-peak analogue of PeakRanking.isNewPeak: a peak only ever
 * moves up. `currentPeak === null` = first ever doubles result. */
export function isNewDoublesPeak(freshTotal: number, currentPeak: DoublesPeakRankingEntry | null): boolean {
  return currentPeak === null || freshTotal > currentPeak.peakPoints;
}
