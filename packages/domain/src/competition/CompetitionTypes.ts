import { Surface } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';

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

/** The two junior age bands this game models (U12 is deliberately out
 * of scope — see the research doc: real ITF/Tennis Europe under-12
 * play is unranked and unseeded, so there'd be no ranking-ledger
 * behavior to build for it). Lives on `Tournament`, not on
 * `TournamentTier` — see `JuniorTier`'s doc comment. */
export type AgeBand = 'u14' | 'u16';

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
 * Senior tiers (major=2000, tour=500 i.e. an ATP 500 event,
 * challenger=125, futures=25 at champion) are unchanged from before
 * other than the index-0 fix above; the rounds below champion are
 * scaled down from real ATP/Challenger round breakdowns rather than an
 * arbitrary curve.
 *
 * The six junior tiers' champion (index 7) values are real, sourced
 * ITF numbers — since the 2023 rebrand, a junior grade's name states
 * the points its singles champion earns: J30=30, J60=60, J100=100,
 * J200=200, J300=300, J500=500 (see the research doc's "exact ITF
 * point ladder" section). The rounds below champion for these six are
 * NOT independently sourced (the ITF doesn't publish a full per-round
 * breakdown the way ATP does) — they're scaled down from champion
 * using the same proportional shape as the senior tables above, same
 * "illustrative, not balanced" caveat CLAUDE.md already applies to
 * this whole table.
 */
export class StandardRankingPointsTable implements RankingPointsTable {
  private static readonly POINTS_BY_ROUND: Record<TournamentTier, ReadonlyArray<number>> = {
    // roundsWon:     0    1    2    3    4    5    6     7
    major:           [0,   45,  90,  180, 360, 720, 1200, 2000],
    tour:            [0,   11,  23,  45,  90,  180, 300,  500],
    challenger:      [0,   3,   6,   11,  23,  45,  75,   125],
    futures:         [0,   1,   2,   3,   5,   9,   15,   25],

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

export interface TournamentEntrant {
  playerId: PlayerId;
  seed: number | null;
}

export type MatchOutcome = {
  winner: PlayerId;
  loser: PlayerId;
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

export interface BracketRound {
  roundNumber: number;
  matches: ReadonlyArray<{
    entrantA: PlayerId;
    entrantB: PlayerId;
    outcome: MatchOutcome | null;
  }>;
}
