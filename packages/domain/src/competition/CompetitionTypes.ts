import { Surface } from '../player/PlayerAttributes';
import { PairId, PlayerId } from '../shared/ids';

export type SeniorTier = 'futures' | 'challenger' | 'tour' | 'major';

/**
 * The combined junior ladder — one continuous six-rung ITF-sourced
 * grade progression (J30 through J500, the post-2023-rebrand names
 * that state the singles champion's points directly) plus a
 * season-ending capstone above J500. Deliberately NOT split into
 * separate per-federation tiers (ITF vs. Tennis Europe) — see
 * docs/junior-circuit-research-and-proposal.md's "Finalized design"
 * section for why those were merged into one ladder. Age (`u14` vs.
 * `u16`) is intentionally NOT baked into these tier names — it lives
 * on the tournament instance instead (`Tournament.ageBand`), so the
 * same six grades work identically for both bands rather than needing
 * twelve near-duplicate tier values.
 */
export type JuniorTier = 'j30' | 'j60' | 'j100' | 'j200' | 'j300' | 'j500' | 'juniorMasters';

export type TournamentTier = SeniorTier | JuniorTier;

/** The three junior age bands this game models (U12 is deliberately out
 * of scope — see the research doc: real ITF/Tennis Europe under-12
 * play is unranked and unseeded, so there'd be no ranking-ledger
 * behavior to build for it). Lives on `Tournament`, not on
 * `TournamentTier` — see `JuniorTier`'s doc comment. Eligibility for
 * each band is NOT a function of a player's literal current age — see
 * RankingBand.juniorEligibilityForAge's doc comment for the real
 * ITF/Tennis Europe "age as of January 1" rule this game implements. */
export type AgeBand = 'u14' | 'u16' | 'u18';

export const SENIOR_TIER_VALUES: ReadonlyArray<SeniorTier> = ['futures', 'challenger', 'tour', 'major'];

export const JUNIOR_TIER_VALUES: ReadonlyArray<JuniorTier> = [
  'j30',
  'j60',
  'j100',
  'j200',
  'j300',
  'j500',
  'juniorMasters',
];

export const ALL_TOURNAMENT_TIERS: ReadonlyArray<TournamentTier> = [...SENIOR_TIER_VALUES, ...JUNIOR_TIER_VALUES];

const JUNIOR_TIER_SET: ReadonlySet<TournamentTier> = new Set<JuniorTier>(JUNIOR_TIER_VALUES);

export function isJuniorTier(tier: TournamentTier): tier is JuniorTier {
  return JUNIOR_TIER_SET.has(tier);
}

/** Single-elimination draw sizes the game supports. */
export type DrawSize = 16 | 32 | 64 | 128;

/** Ranking points awarded per tier/round — externalized as data, not
 * hardcoded into Tournament, so game-balance changes don't require
 * touching the aggregate's code (Open/Closed). */
export interface RankingPointsTable {
  pointsFor(tier: TournamentTier, roundsWon: number): number;
}

/**
 * Real ATP ranking tables are published per round reached, not
 * computed from a formula — a semifinalist earns roughly half of the
 * champion's points, not an exponentially compounding fraction of it.
 * These tables mirror that shape.
 *
 * Indexed by roundsWon (0 = lost in the first round, up to 7 = won a
 * 128-draw tournament without dropping a round). A tier/draw
 * combination that can't reach index 7 (e.g. a 16-draw futures event)
 * simply never looks up the higher indices — the table doesn't need to
 * be draw-size-aware itself, Tournament already knows how many rounds
 * a given draw has.
 *
 * roundsWon = 0 (a first-round loss) is 0 points at every tier, full
 * stop — a ranking must be *earned* by winning at least one match, not
 * granted for mere participation (see the "Correction" section of
 * docs/junior-circuit-research-and-proposal.md). This used to be
 * wrong: the old formula was `basePoints * 1.6^roundsWon`, which at
 * roundsWon=0 collapses to `basePoints * 1.6^0 = basePoints` — a full
 * base-tier award for losing your very first match. That bug predates
 * the junior work and applied to every tier that existed before it
 * (major/tour/challenger/futures); it's fixed here for all of them,
 * not just the new junior tiers below.
 *
 * **Senior tiers (major/tour/challenger/futures) are now REAL, SOURCED
 * numbers from the official 2026 PIF ATP Rankings rulebook (Chapter
 * IX), not illustrative placeholders — this replaces the previous
 * "scaled down from real ATP/Challenger round breakdowns" approximation
 * with the actual published tables.** The mapping from our four senior
 * tiers to the real ATP tour's structure, chosen to match both by
 * champion-point VALUE (already how this table was informally aligned
 * before — tour's old 500 already matched an ATP 500 event's champion
 * points by name) and by DRAW SIZE (our generated draw sizes line up
 * exactly with a real round-count variant, so no interpolation is
 * needed anywhere in this table):
 * - `major` (128-draw, 8 rounds) → Grand Slam: 2000/1300/800/400/200/
 *   100/50/10 (W/F/SF/QF/R16/R32/R64/R128).
 * - `tour` (64-draw, 7 rounds) → ATP Tour Masters 1000, the 48/56-draw
 *   variant (the one with a real published R64 column, matching a
 *   64-draw's round count exactly): 1000/650/400/200/100/50/10.
 * - `challenger` (32-draw, 6 rounds) → ATP Tour 500, the 32-draw
 *   variant: 500/330/200/100/50/25.
 * - `futures` (32-draw, 6 rounds) → ATP Tour 250, the 32-draw variant:
 *   250/165/100/50/25/13.
 *
 * One deliberate, disclosed deviation: the real rulebook pays a small
 * first-round-loss score at Grand Slams (10) and this Masters 1000
 * variant (10) — index 0 is forced to 0 here regardless, same as every
 * other tier, preserving this project's own established "a ranking
 * must be earned by winning, never granted for participation" rule
 * (9.02.G.2's real rule for ATP 500/250/Challenger/ITF WTT — "No points
 * are awarded for a first round loss" — already matches this house rule
 * exactly with no deviation needed for those two tiers).
 *
 * The six junior tiers' champion (index 7) values are real, sourced
 * ITF numbers — since the 2023 rebrand, a junior grade's name states
 * the points its singles champion earns: J30=30, J60=60, J100=100,
 * J200=200, J300=300, J500=500 (see the research doc's "exact ITF
 * point ladder" section) — unrelated to and unchanged by the ATP
 * rulebook above (ITF juniors are a separate ranking system the ATP
 * rulebook doesn't cover). The rounds below champion for these six are
 * NOT independently sourced (the ITF doesn't publish a full per-round
 * breakdown the way ATP does) — they're scaled down from champion
 * using the same proportional shape the senior tables used to use, same
 * "illustrative, not balanced" caveat CLAUDE.md already applies to
 * this whole table.
 */
export class StandardRankingPointsTable implements RankingPointsTable {
  private static readonly POINTS_BY_ROUND: Record<TournamentTier, ReadonlyArray<number>> = {
    // roundsWon:     0    1    2    3    4    5    6     7
    major:           [0,   50,  100, 200, 400, 800, 1300, 2000],
    tour:            [0,   50,  100, 200, 400, 650, 1000],
    challenger:      [0,   50,  100, 200, 330, 500],
    futures:         [0,   25,  50,  100, 165, 250],

    // Real, sourced ITF champion values (index 7). Rounds 1-6 are an
    // illustrative proportional scale-down, not independently sourced
    // — see class doc comment above.
    j30:             [0,   1,   2,   3,   5,   11,  18,   30],
    j60:             [0,   1,   3,   5,   11,  22,  36,   60],
    j100:            [0,   2,   5,   9,   18,  36,  60,   100],
    j200:            [0,   5,   9,   18,  36,  72,  120,  200],
    j300:            [0,   7,   14,  27,  54,  108, 180,  300],
    j500:            [0,   11,  23,  45,  90,  180, 300,  500],

    // PLACEHOLDER — UNSOURCED. Unlike the six J-grades above, no real
    // published point value exists anywhere found for a Junior Masters
    // capstone (see the research doc: "exact point value not published
    // anywhere found — flag as an explicit placeholder"). 700 is an
    // arbitrary placeholder chosen only to sit above J500's real 500,
    // not a tuned or sourced number. Do not treat this row as equally
    // authoritative to the six above it.
    juniorMasters:   [0,   16,  32,  63,  126, 252, 420,  700],
  };

  pointsFor(tier: TournamentTier, roundsWon: number): number {
    const table = StandardRankingPointsTable.POINTS_BY_ROUND[tier];
    const index = Math.min(Math.max(roundsWon, 0), table.length - 1);
    return table[index];
  }
}

export interface PrizeMoneyTable {
  prizeMoneyFor(tier: TournamentTier, roundsWon: number): number;
}

/**
 * On-site prize money by round reached, in USD — the money counterpart
 * to `StandardRankingPointsTable` above, added following a reading of
 * the 2026 ATP Financial rules (Chapter III). One deliberate,
 * documented DIVERGENCE from the points table's shape: index 0 (a
 * first-round loss) is NOT forced to zero here. Real ATP rule 3.08.B.3
 * says "prize money shall be paid only for matches played" — a player
 * who plays and loses their first match still gets paid (real Slams
 * pay a real, meaningful check to a first-round loser) — this is a
 * genuinely different rule from ranking points' "must be earned by
 * winning" house rule, not an oversight carried over from that table.
 * So: you get PAID for playing, you only RANK by winning.
 *
 * All senior-tier values are PLACEHOLDER numbers, not sourced dollar
 * figures — the real Exhibit J purse tables referenced by the
 * rulebook weren't available to source from, so these are round
 * numbers chosen to sit in a believable order of magnitude and shape
 * (champion roughly 2x runner-up, roughly doubling per round below
 * that, consistent with how real ATP purses are structured) relative
 * to each other and to the sourced ranking-point tiers, not tuned or
 * balanced. Junior tiers (j30-juniorMasters) are all zero on purpose —
 * this is a real design choice, not a missing table: the ITF junior
 * circuit is an amateur development tour and does not pay meaningful
 * cash prize money, unlike ATP Tour/Challenger events.
 */
export class StandardPrizeMoneyTable implements PrizeMoneyTable {
  private static readonly PRIZE_MONEY_BY_ROUND: Record<TournamentTier, ReadonlyArray<number>> = {
    // roundsWon:      0      1      2      3      4       5       6        7
    major:           [15000, 25000, 45000, 80000, 150000, 300000, 600000, 1200000],
    tour:             [8000, 14000, 25000, 45000, 85000,  160000, 320000],
    challenger:       [3000,  5500, 10000, 18000, 35000,  70000],
    futures:          [1500,  2750,  5000,  9000, 17500,  35000],

    // Real ITF junior events do not pay meaningful cash prize money —
    // see class doc comment above. Zero across the board, deliberately.
    j30:              [0, 0, 0, 0, 0, 0, 0, 0],
    j60:              [0, 0, 0, 0, 0, 0, 0, 0],
    j100:             [0, 0, 0, 0, 0, 0, 0, 0],
    j200:             [0, 0, 0, 0, 0, 0, 0, 0],
    j300:             [0, 0, 0, 0, 0, 0, 0, 0],
    j500:             [0, 0, 0, 0, 0, 0, 0, 0],
    juniorMasters:    [0, 0, 0, 0, 0, 0, 0, 0],
  };

  prizeMoneyFor(tier: TournamentTier, roundsWon: number): number {
    const table = StandardPrizeMoneyTable.PRIZE_MONEY_BY_ROUND[tier];
    const index = Math.min(Math.max(roundsWon, 0), table.length - 1);
    return table[index];
  }
}

/**
 * Tiers whose champion point value is an unsourced/untuned placeholder
 * rather than a real published number — currently just
 * `juniorMasters` (see its comment in `StandardRankingPointsTable`
 * above). This is a real, checkable code-level flag rather than only a
 * comment, precisely so `juniorMasters` is never accidentally
 * presented (in a UI, a test, or elsewhere) as equally authoritative
 * to the six real ITF-sourced J-grade values.
 */
const UNSOURCED_PLACEHOLDER_TIER_SET: ReadonlySet<TournamentTier> = new Set<TournamentTier>(['juniorMasters']);

export function isUnsourcedPlaceholderTier(tier: TournamentTier): boolean {
  return UNSOURCED_PLACEHOLDER_TIER_SET.has(tier);
}

/**
 * "Obligatory" (mandatory) tiers — the real-tennis rule that a top
 * player's ranking MUST count these events even if they skip them: a
 * skipped obligatory tournament you were entitled to enter counts as a
 * 0 that still burns one of your best-N slots, which is precisely what
 * forces the top of the field into the big events instead of cherry-
 * picking soft draws (see docs/ranking-realism-proposal.md).
 *
 * Currently just `'major'` (our Grand Slam equivalent). A set, not a
 * single literal, so the game's "Masters"-equivalent tier can join the
 * obligatory list later without touching RankingCalculationService —
 * the calc service asks `isObligatoryTier`, never a hardcoded literal.
 * No junior tier is obligatory (the ITF junior circuit has no mandatory-
 * event rule), so this is always empty of junior tiers by construction.
 */
const OBLIGATORY_TIER_SET: ReadonlySet<TournamentTier> = new Set<TournamentTier>(['major']);

export function isObligatoryTier(tier: TournamentTier): boolean {
  return OBLIGATORY_TIER_SET.has(tier);
}

/**
 * How an entrant got their main-draw place — the real tennis
 * convention a draw sheet prints next to a name (see
 * docs/ranking-realism-proposal.md §5's light `[Q]` model):
 *
 * - `'DA'` — direct acceptance, earned by ranking (or simply the
 *   default for every tier that has no qualifying at all).
 * - `'Q'` — came through qualifying: a registrant outside
 *   `DIRECT_ACCEPTANCE_CUTOFF` who took one of the event's reserved
 *   qualifier slots. No qualifying matches are simulated in the light
 *   model — the qualifier is *assumed* to have come through, and earns
 *   ordinary main-draw points for whatever they then do.
 * - `'WC'` — wildcard. Modelled as a value here (a draw sheet has no
 *   third state) but nothing in the game awards one yet; no code path
 *   produces it, deliberately, rather than inventing a wildcard
 *   mechanic this pass didn't scope.
 */
export type EntryType = 'DA' | 'Q' | 'WC';

/**
 * Which of a tournament's two brackets something belongs to (an
 * entrant, a match, a round). A tournament that holds no qualifying
 * has only a `'main'` draw and this is inert — every existing entrant,
 * match and call site means `'main'`, which is why it's optional/
 * defaulted everywhere rather than required.
 *
 * The FULL qualifying model (docs/ranking-realism-proposal.md §5) —
 * qualifying is genuinely played: a real, smaller bracket simulated
 * over the days BEFORE the main draw, whose winners are promoted into
 * the main draw's reserved `[Q]` slots. That replaces the light
 * model's "the qualifier is *assumed* to have come through".
 */
export type DrawPhase = 'main' | 'qualifying';

export interface TournamentEntrant {
  playerId: PlayerId;
  seed: number | null;
  /** Which bracket this entrant is in. Optional/additive: absent means
   * `'main'` (see `drawOf`), so every pre-qualifying entrant, persisted
   * row and test call site is unchanged. A qualifier who WINS through
   * is moved to `'main'` on promotion while keeping `entryType: 'Q'` —
   * so "came through qualifying" survives as a permanent, visible fact
   * about how they got their place, while "which draw are they in now"
   * stays a single unambiguous answer (one entrant row per player, as
   * the DB's own (tournament_id, player_id) primary key requires). */
  draw?: DrawPhase;
  /** Optional/additive: absent means direct acceptance (`'DA'`), so
   * every pre-qualifying entrant, persisted row, and test call site is
   * unchanged. Read through `entryTypeOf` rather than defaulted at each
   * call site. */
  entryType?: EntryType;
}

/** The one place the "absent means direct acceptance" default lives. */
export function entryTypeOf(entrant: Pick<TournamentEntrant, 'entryType'>): EntryType {
  return entrant.entryType ?? 'DA';
}

/** The one place the "absent means the main draw" default lives. */
export function drawOf(entrant: Pick<TournamentEntrant, 'draw'>): DrawPhase {
  return entrant.draw ?? 'main';
}

/**
 * The result of a single match. Generic over the slot id `S` so the
 * SAME type describes a singles match (`S = PlayerId`, the default —
 * unchanged for every existing caller) and a doubles match (`S =
 * PairId`, whose two "sides" are pairs rather than players). Doubles
 * matches are structurally identical: one winner, one loser, set
 * scores — only what identifies a side differs.
 */
export type MatchOutcome<S extends string = PlayerId> = {
  winner: S;
  loser: S;
  setScores: ReadonlyArray<{ winnerGames: number; loserGames: number }>;
};

/**
 * A replay log for "fake live" playback, mirroring the pattern
 * Rocking Rackets uses: the match is fully simulated up front, and the
 * frontend fetches this log once and steps through it on a client-side
 * timer to fake a live scenario. No WebSocket, no persistent
 * connection, no server-side timing coordination — viewer count has
 * zero effect on backend cost since this is just a static blob that
 * can sit behind a CDN.
 *
 * Deliberately NOT stored inside the Tournament aggregate: Tournament
 * only needs the compact MatchOutcome to progress brackets and award
 * ranking points. The full log is comparatively heavy (one entry per
 * game/point) and belongs in cheap object storage referenced by
 * matchId, not in the aggregate's own persisted state.
 */
export interface MatchLogEntry {
  /** Seconds since match "start", used purely for client playback
   * pacing — has no bearing on anything the domain computes. */
  offsetSeconds: number;
  setNumber: number;
  gamesForA: number;
  gamesForB: number;
  wonBy: 'A' | 'B';
  /**
   * Who served this game. Alternates every game — standard tennis
   * convention — continuously across the WHOLE match, not reset per
   * set: a tiebreak counts as exactly one unit of alternation, so the
   * server sequence carries correctly into the next set (the real
   * ATP rule: whoever received first in the tiebreak serves first in
   * the next set). Player A is fixed as the match's first server;
   * nothing in this domain models a coin-toss/service-choice, so this
   * is a deliberate simplification, not an attempt at realism there.
   *
   * This is what makes real break-of-serve detection possible (a
   * notable moment is exactly `wonBy !== server`) instead of the
   * "reached deuce" stand-in used before this field existed — but
   * "break" isn't a meaningful concept for a tiebreak-decided game
   * (service rotates every 2 points within a breaker), so consumers
   * should treat this field as informational-only for tiebreak
   * entries, not feed it into break-of-serve commentary.
   */
  server: 'A' | 'B';
}

/**
 * A completed game is a break of serve exactly when its winner isn't
 * who served it — the real definition, now that MatchLogEntry.server
 * exists, replacing the "reached deuce" stand-in the replay
 * commentary previously used in its place. Deliberately doesn't
 * exclude tiebreaks itself (a tiebreak's `server` is still a
 * well-defined value, just not one "break" is a meaningful concept
 * for, since service rotates every 2 points within a breaker) — that
 * judgment call belongs to whoever is deciding what counts as
 * notable commentary, not to this factual predicate. Callers that
 * care can detect a tiebreak-decided entry from its score alone: this
 * simulator only ever reaches a tiebreak at 6-6, so a final score of
 * 7-6 (or 6-7) uniquely identifies one.
 */
export function isBreakOfServe(entry: Pick<MatchLogEntry, 'wonBy' | 'server'>): boolean {
  return entry.wonBy !== entry.server;
}

/** A standard game's score reads '0'/'15'/'30'/'40', then 'Ad' once
 * deuce (40-40) is broken by one point without the required 2-point
 * margin. A tiebreak instead counts literally (0, 1, 2, ... 7, ...),
 * so this also accepts a plain numeric string for that case — there's
 * no shared vocabulary between the two scoring systems in real tennis
 * either. */
export type PointScoreLabel = '0' | '15' | '30' | '40' | 'Ad' | `${number}`;

/**
 * One point within one game — the detail MatchLogEntry deliberately
 * doesn't carry (see its own doc comment: it's the game-level rollup
 * used for the bracket/scrub-bar tick marks). pointScoreA/pointScoreB
 * are the score *before* this point is decided (the stakes the point
 * was played for), which is always a valid, in-progress tennis score;
 * wonBy says who won it. A reader doesn't need a separate "Game" sentinel
 * to know a game just ended — that's exactly when the next MatchLogEntry
 * appears at the same offsetSeconds.
 */
export interface MatchPointEntry {
  offsetSeconds: number;
  setNumber: number;
  /** 1-indexed within the set; a tiebreak is conventionally the set's
   * 13th game (played after 12 games split 6-6). */
  gameNumber: number;
  pointScoreA: PointScoreLabel;
  pointScoreB: PointScoreLabel;
  wonBy: 'A' | 'B';
}

export interface MatchLog {
  /** Game-completion rollup — unchanged shape, still what the
   * bracket/scrub-bar tick marks and the game-by-game commentary
   * line consume. */
  entries: ReadonlyArray<MatchLogEntry>;
  /** Point-by-point detail alongside the rollup above, not merged
   * into it — existing consumers of `entries` are unaffected by this
   * addition. */
  points: ReadonlyArray<MatchPointEntry>;
  totalDurationSeconds: number;
  /**
   * ISO 8601 timestamp of the real moment this match was actually
   * simulated — the anchor the "wall-clock-synced Premiere" playback
   * model (docs/ui-direction.md) is built on. Every viewer who opens
   * the same match sees it capped to the same real-time position
   * (`min((Date.now() - simulatedAt) / 1000, totalDurationSeconds)`
   * in-game seconds, since pacing is calibrated so one in-game second
   * of simulated match time approximates one real second of an actual
   * broadcast), never a free on-demand replay from zero. Deliberately
   * NOT produced by StatisticalMatchSimulator itself — the simulator
   * stays pure/deterministic given a RandomSource, no real Date.now()
   * dependency; this is stamped by the application layer at the
   * moment the log is handed to MatchLogStorePort (see
   * SimulateMatchUseCase), the same real-world-timestamp pattern
   * already used for domain events' `occurredAt`.
   */
  simulatedAt: string;
}

export interface BracketRound<S extends string = PlayerId> {
  roundNumber: number;
  matches: ReadonlyArray<{
    entrantA: S;
    entrantB: S;
    outcome: MatchOutcome<S> | null;
    /** ISO 8601 timestamp of the match's SCHEDULED reveal start — the
     * wall-clock moment the "fake live" replay begins airing (the
     * staggered-schedule feature: a round's matches air one after another
     * across the day rather than all at once). Optional/absent = not yet
     * scheduled (a match that hasn't been simulated yet, or a pre-feature
     * persisted row/tests), in which case consumers treat it as
     * "already fully aired". Stamped by the application layer at
     * simulation time (like MatchLog.simulatedAt) — the domain never
     * computes wall-clock time, it just passes this opaque timestamp
     * through the aggregate for persistence and read-back. */
    scheduledStartAt?: string;
    /** Real-time seconds this match's fake-live reveal occupies (the
     * staggered-schedule feature) — the round's reveal window, equal to
     * the stagger between matches. Absent = not yet scheduled. */
    revealSeconds?: number;
  }>;
}

/**
 * A doubles pair as formed for a specific tournament (P7b) — the unit
 * the doubles bracket's slots identify. Distinct from the persistent
 * `DoublesPair` partnership aggregate (P7a): that one is a
 * manager-managed relationship that outlives any one tournament, while
 * this is the tournament's OWN pairing of two entered players (which
 * may be a persistent pair, or a random pairing of solo entrants, or a
 * free-agent filler). `pairId` is local to the tournament's draw.
 */
export interface TournamentDoublesPair {
  pairId: PairId;
  playerA: PlayerId;
  playerB: PlayerId;
  /** Pair chemistry carried into this tournament's draw (P7c) — the
   * persistent partnership's own chemistry when the two entrants ARE a
   * `DoublesPair`, else 0 (a random solo pairing has none). Optional/
   * additive: absent = 0 (every pre-P7c construction site and test).
   * Fed to the sim as a small bonus. */
  chemistry?: number;
  /** The persistent partnership's id, when these two entrants are a
   * `DoublesPair` (P7a) — what SimulateDoublesMatchUseCase uses to grow
   * that pair's chemistry after the match. Absent for a random pairing. */
  persistentPairId?: PairId;
}
