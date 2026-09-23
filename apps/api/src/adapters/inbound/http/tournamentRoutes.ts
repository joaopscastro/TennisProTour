import { FastifyInstance } from 'fastify';
import { compareGameWeek, drawOf, entryTypeOf, isAgeEligibleForTournamentBand, isJuniorTier, isObligatoryTier, isUnsourcedPlaceholderTier, PlayerId, resolveEntryType, seniorTierEntryRestrictionReason, StandardPrizeMoneyTable, StandardRankingPointsTable, TournamentId, weeksBetween } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { AgeBand, BracketRound, DrawPhase, DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';

const TOURNAMENT_TIERS = ['futures', 'challenger', 'tour', 'major', 'j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'];
import { countSameBandEntriesForWeek, weeklyEntryCapForTier, matchIdForSlot } from '@tennis-manager/application';
import { TournamentRepository } from '@tennis-manager/application';
import { Dependencies, WORLD_ID } from '../../../composition';
import { requireInternalAdmin, requireManager } from './auth';

/** Single shared instance — the points table is a pure lookup of
 * domain-owned constants (no per-request state), so it's safe to build
 * once and reuse. */
const POINTS_TABLE = new StandardRankingPointsTable();
/** Same "shared, stateless lookup" reasoning as POINTS_TABLE above, for
 * on-site prize money (see StandardPrizeMoneyTable's doc comment). */
const PRIZE_MONEY_TABLE = new StandardPrizeMoneyTable();

/** The stage a player reaches by winning `matchesWon` matches in a
 * single-elimination draw of `drawSize`, then either winning it all
 * (Champion) or losing the very next round. `totalRounds` is
 * log2(drawSize). Mirrors the round-label convention the bracket screen
 * already uses (Final/Semifinals/Quarterfinals/Round of N), phrased as
 * the reached STAGE (Champion/Runner-up/Semifinalist/…) since that's how
 * real tours publish their points-per-round tables. */
function stageLabelFor(matchesWon: number, totalRounds: number, drawSize: number): string {
  if (matchesWon >= totalRounds) return 'Champion';
  const playersInRoundLost = drawSize / 2 ** matchesWon;
  if (playersInRoundLost === 2) return 'Runner-up';
  if (playersInRoundLost === 4) return 'Semifinalist';
  if (playersInRoundLost === 8) return 'Quarterfinalist';
  return `Round of ${playersInRoundLost}`;
}

interface PointsBreakdownRow {
  matchesWon: number;
  stageLabel: string;
  points: number;
}

interface PrizeMoneyBreakdownRow {
  matchesWon: number;
  stageLabel: string;
  prizeMoney: number;
}

/** The points-per-round ladder for THIS tournament, from Champion down
 * to a first-round loss — computed from the tier and the tournament's
 * ACTUAL draw size (a 16-draw only has 4 rounds, so its champion wins 4
 * matches and earns pointsFor(tier, 4), not the table's index-7 value).
 * Ordered Champion-first for display. Read straight off the domain
 * StandardRankingPointsTable so the numbers here can never drift from
 * what SimulateMatchUseCase actually awards. */
function pointsBreakdownFor(tier: TournamentTier, drawSize: number): PointsBreakdownRow[] {
  const totalRounds = Math.round(Math.log2(drawSize));
  const rows: PointsBreakdownRow[] = [];
  for (let matchesWon = totalRounds; matchesWon >= 0; matchesWon--) {
    rows.push({
      matchesWon,
      stageLabel: stageLabelFor(matchesWon, totalRounds, drawSize),
      points: POINTS_TABLE.pointsFor(tier, matchesWon),
    });
  }
  return rows;
}

/** The prize-money-per-round ladder for THIS tournament — the money
 * counterpart to pointsBreakdownFor, same "Champion-first, computed
 * from the domain table so it can never drift from what
 * SimulateMatchUseCase actually pays" shape. Unlike pointsBreakdownFor,
 * a first-round loss (matchesWon = 0) is NOT zero at a senior tier —
 * see StandardPrizeMoneyTable's doc comment on why prize money and
 * ranking points diverge here. */
function prizeMoneyBreakdownFor(tier: TournamentTier, drawSize: number): PrizeMoneyBreakdownRow[] {
  const totalRounds = Math.round(Math.log2(drawSize));
  const rows: PrizeMoneyBreakdownRow[] = [];
  for (let matchesWon = totalRounds; matchesWon >= 0; matchesWon--) {
    rows.push({
      matchesWon,
      stageLabel: stageLabelFor(matchesWon, totalRounds, drawSize),
      prizeMoney: PRIZE_MONEY_TABLE.prizeMoneyFor(tier, matchesWon),
    });
  }
  return rows;
}

/** Thin serialization only — no domain rules here, EXCEPT the
 * player-scoped fields, which are only ever attached by the
 * playerId-aware overload below (see GET /tournaments) — never
 * computed from anything but the real weekly-entry-cap constants
 * (weeklyEntryCapForTier) and isAgeEligibleForTournamentBand, the same
 * sources RegisterEntrantUseCase itself enforces against. */
export interface PlayerScopedInfo {
  weeklyEntryCountThisWeek: number;
  weeklyEntryCapThisWeek: number;
  ageEligible: boolean;
  /** Whether THIS player would enter this tournament through qualifying
   * (below the direct-acceptance cutoff) rather than a direct main-draw
   * place — the SAME resolveEntryType decision RegisterEntrantUseCase
   * makes, so the UI can preview it before a POST. Only meaningful at a
   * tier that holds qualifying (false everywhere else). */
  entryViaQualifying: boolean;
  /** Whether the qualifying field is already full — a below-cutoff
   * player is refused outright once it is. Only meaningful when
   * entryViaQualifying. */
  qualifyingFieldFull: boolean;
  /** How many `[Q]` places are already taken, and the field's total
   * capacity (0/0 at a tier with no qualifying). */
  qualifyingFieldTaken: number;
  qualifyingFieldSize: number;
  /** Whether this player's SENIOR ranking is too high to enter this
   * tournament at all (see TierEntryRestrictionPolicy: a top-200 player
   * can't enter `futures`, a top-50 player can't enter `challenger`).
   * Computed from the SAME policy RegisterEntrantUseCase enforces, so the
   * disabled row and the server refusal can never disagree. */
  rankRestricted: boolean;
  /** The plain-language reason `rankRestricted` is true (the exact
   * phrasing a rejected POST uses), or null when the player may enter. */
  rankRestrictedReason: string | null;
}
export function toTournamentDto(
  tournament: Tournament,
  playerScopedInfo?: PlayerScopedInfo,
  managerEntrants?: number,
) {
  return {
    id: tournament.id,
    name: tournament.name,
    tier: tournament.tier,
    /** 'junior' for the J-grades/juniorMasters, 'senior' otherwise —
     * the "circuit" a manager sees on the tournament profile. */
    circuit: isJuniorTier(tournament.tier) ? 'junior' : 'senior',
    ageBand: tournament.ageBand,
    surface: tournament.surface,
    hostCountry: tournament.hostCountry,
    /** Points-per-round ladder for this tournament's actual draw size,
     * Champion-first. Single source of truth = the domain points table. */
    pointsBreakdown: pointsBreakdownFor(tournament.tier, tournament.drawSize),
    /** True only for juniorMasters, whose point values are an unsourced
     * placeholder — lets the UI flag them honestly rather than present
     * them as authoritative as the real ITF/ATP-derived tiers. */
    pointsArePlaceholder: isUnsourcedPlaceholderTier(tournament.tier),
    /** Prize-money-per-round ladder for this tournament's actual draw
     * size, Champion-first — the money counterpart to pointsBreakdown.
     * Always 0 at every row for a junior tier (see
     * StandardPrizeMoneyTable's doc comment). */
    prizeMoneyBreakdown: prizeMoneyBreakdownFor(tournament.tier, tournament.drawSize),
    weekScheduled: tournament.weekScheduled,
    drawSize: tournament.drawSize,
    /** How many entrants are in the MAIN draw RIGHT NOW. `entrants` above
     * covers BOTH draws (a qualifying-tier event's below-cutoff field sits
     * in `'qualifying'`), so `entrants.length` can legitimately exceed
     * `drawSize` — e.g. a 64-draw with a 24-player qualifying field reads
     * 88 total. Anything that calls itself "entrants out of drawSize"
     * (the list row's `X/Y`, the bracket hero's "N players") must read
     * THIS, never `entrants.length`, or it contradicts the draw it
     * claims to describe. Always ≤ `drawSize` by construction. */
    mainDrawEntrants: tournament.entrants.filter((entrant) => drawOf(entrant) === 'main').length,
    /** How many entrants are owned by a real manager (`manager_id` not
     * null) — the count the tournament lists/pickers show so a manager can
     * see whether real people have already entered before deciding. Computed
     * by the caller from ONE grouped query
     * (TournamentRepository.countManagerEntrants), never per-tournament.
     * Absent when the caller didn't compute it (so the client omits the
     * line rather than printing a misleading 0). */
    ...(managerEntrants !== undefined ? { managerEntrants } : {}),
    hasStarted: tournament.hasStarted,
    /** The main draw has been seeded. Distinct from `hasStarted`, which
     * is also true while a tournament is playing its QUALIFYING draw
     * and its main draw doesn't exist yet (deferred main-draw seeding —
     * see Tournament.hasStarted). */
    hasMainDraw: tournament.hasMainDraw,
    entrants: tournament.entrants.map((entrant) => ({
      playerId: entrant.playerId,
      seed: entrant.seed,
      /** 'DA' | 'Q' | 'WC' — how this entrant got their place. The
       * draw sheet's real convention; only ever 'Q' at a tier that
       * holds qualifying (see QualifyingPolicy). */
      entryType: entryTypeOf(entrant),
      /** Which draw they're in RIGHT NOW: a 'Q' entrant sits in
       * 'qualifying' until they win through, then moves to 'main'. */
      draw: drawOf(entrant),
    })),
    /** How many of this draw's places are reserved for qualifiers, and
     * how big the qualifying field contesting them is — both read off
     * the tournament's own STORED values (not re-derived from the
     * policy), so they can't drift from the event actually being
     * played. 0 at every tier that holds no qualifying, which is what
     * lets the UI stay silent about `[Q]` there. */
    qualifierSlots: tournament.qualifierSlots,
    qualifyingDrawSize: tournament.qualifyingDrawSize,
    qualifyingRoundCount: tournament.qualifyingRoundCount,
    qualifyingComplete: tournament.isQualifyingComplete(),
    /** Wild cards (see WildCardPolicy): how many main-draw places are
     * available for this tier's tournament, and how many are already
     * taken — 0/0 at every junior tier, which is what lets the UI stay
     * silent about wild cards there, same pattern as qualifierSlots. */
    wildCardSlots: tournament.wildCardSlots,
    wildCardSlotsTaken: tournament.wildCardSlotsTaken,
    /** True when a top-ranked player is OBLIGATED to count this event
     * even if they skip it (ObligatoryTournamentPolicy) — surfaced so
     * the rule is legible to managers rather than a hidden penalty. */
    obligatory: isObligatoryTier(tournament.tier),
    ...(playerScopedInfo ?? {}),
    rounds: toRoundDtos(tournament.getRounds()),
    /** The qualifying bracket, same shape as `rounds` so the UI can
     * render it with the same component. Empty for every tournament
     * without qualifying. */
    qualifyingRounds: toRoundDtos(tournament.getQualifyingRounds()),
    /** Doubles draw (P7b). `doublesDrawSize` 0 = no doubles draw.
     * `doublesEntrants` are the solo signups (player ids, before
     * pairing); `doublesPairs` maps each bracket slot's pairId back to
     * its two players; `doublesRounds` is the pair-keyed bracket (same
     * shape as `rounds`, but entrantA/entrantB are pair ids — resolve
     * them through `doublesPairs`). */
    doublesDrawSize: tournament.doublesDrawSize,
    doublesEntrants: tournament.doublesEntrants,
    doublesPairs: tournament.doublesPairs.map((p) => ({ pairId: p.pairId, playerA: p.playerA, playerB: p.playerB, chemistry: p.chemistry ?? 0 })),
    doublesRounds: toRoundDtos(tournament.getDoublesRounds()),
    doublesComplete: tournament.isDoublesComplete(),
    /** Doubles qualifying (P8) — 0/no data when the draw is too small to
     * hold one. `doublesQualifyingPairs`/`doublesQualifyingRounds` mirror
     * the main-draw fields above. */
    doublesQualifyingDrawSize: tournament.doublesQualifyingDrawSize,
    doublesQualifierSlots: tournament.doublesQualifierSlots,
    doublesQualifyingPairs: tournament.doublesQualifyingPairs.map((p) => ({ pairId: p.pairId, playerA: p.playerA, playerB: p.playerB, chemistry: p.chemistry ?? 0 })),
    doublesQualifyingRounds: toRoundDtos(tournament.getDoublesRounds('qualifying')),
    doublesQualifyingComplete: tournament.isDoublesQualifyingComplete(),
  };
}

function toRoundDtos<S extends string>(rounds: ReadonlyArray<BracketRound<S>>) {
  return rounds.map((round) => ({
    roundNumber: round.roundNumber,
    matches: round.matches.map((match) => ({
      entrantA: match.entrantA,
      entrantB: match.entrantB,
      outcome: match.outcome
        ? {
            winner: match.outcome.winner,
            loser: match.outcome.loser,
            setScores: match.outcome.setScores,
          }
        : null,
      /** The match's scheduled reveal start (ISO) — null before it's
       * simulated. The bracket counts down to it; the reveal runs
       * `revealSeconds` from there. */
      scheduledStartAt: match.scheduledStartAt ?? null,
      /** Real-time seconds this match's reveal occupies. 0 = not
       * scheduled (a pre-feature/not-yet-simulated match). */
      revealSeconds: match.revealSeconds ?? 0,
    })),
  }));
}

/** For every tournament in the list: how many same-band tournaments the
 * given player has already entered in that tournament's specific week
 * (one countSameBandEntriesForWeek call per DISTINCT band+(season,week)
 * pair, not one per tournament, since a manager's open-tournament list
 * is typically dominated by a handful of weeks), and whether the
 * player's CURRENT age is eligible for that tournament's band at all
 * (isAgeEligibleForTournamentBand — a player who's aged out of a junior
 * band gets ageEligible: false; the senior tour always returns true,
 * matching RegisterEntrantUseCase's own one-directional age rule). Both
 * bands now carry the weekly-cap fields: the senior tour is capped at 1
 * tournament/week (SENIOR_WEEKLY_ENTRY_CAP), so an EnterTournamentModal
 * can disable a second senior entry the same week up front, exactly as
 * it already did for the junior 3/week cap. */
async function attachEntryInfo(
  tournaments: TournamentRepository,
  list: Tournament[],
  playerId: PlayerId,
  playerAgeInWeeks: number,
  playerRank: number | null,
): Promise<Map<string, PlayerScopedInfo>> {
  const countByBandWeekKey = new Map<string, number>();
  const result = new Map<string, PlayerScopedInfo>();
  for (const tournament of list) {
    const bandKey = isJuniorTier(tournament.tier) ? 'j' : 's';
    const weekKey = `${bandKey}-${tournament.weekScheduled.season}-${tournament.weekScheduled.week}`;
    let count = countByBandWeekKey.get(weekKey);
    if (count === undefined) {
      count = await countSameBandEntriesForWeek(tournaments, playerId, tournament.weekScheduled, tournament.tier);
      countByBandWeekKey.set(weekKey, count);
    }

    // Preview this player's entry route: the SAME resolveEntryType call
    // RegisterEntrantUseCase makes at POST time, so the UI can show "you'll
    // enter through qualifying" and disable a full qualifying field BEFORE
    // the player hits the server-side refusal.
    let entryViaQualifying = false;
    let qualifyingFieldFull = false;
    let qualifyingFieldTaken = 0;
    let qualifyingFieldSize = tournament.qualifyingDrawSize;
    if (tournament.hasQualifying) {
      qualifyingFieldTaken = tournament.entrants.filter((e) => entryTypeOf(e) === 'Q').length;
      const decision = resolveEntryType({
        tier: tournament.tier,
        drawSize: tournament.drawSize,
        rank: playerRank,
        qualifierSlotsTaken: qualifyingFieldTaken,
        qualifierSlots: tournament.qualifierSlots,
        qualifyingCapacity: tournament.qualifyingDrawSize,
      });
      entryViaQualifying = decision.entryType === 'Q';
      qualifyingFieldFull = decision.kind === 'qualifying-full';
    }

    result.set(tournament.id, {
      weeklyEntryCountThisWeek: count,
      weeklyEntryCapThisWeek: weeklyEntryCapForTier(tournament.tier),
      ageEligible: isAgeEligibleForTournamentBand(playerAgeInWeeks, tournament.ageBand),
      entryViaQualifying,
      qualifyingFieldFull,
      qualifyingFieldTaken,
      qualifyingFieldSize,
      // Ranking-based tier restriction — the SAME predicate/reason the
      // registration use cases enforce, so the UI can disable the row and
      // explain why before the POST rather than only after a failure.
      rankRestricted: seniorTierEntryRestrictionReason(tournament.tier, playerRank) !== null,
      rankRestrictedReason: seniorTierEntryRestrictionReason(tournament.tier, playerRank),
    });
  }
  return result;
}

/** Manager-entrant counts for a list of tournaments, from ONE grouped
 * query — see TournamentRepository.countManagerEntrants. Falls back to an
 * empty map (no counts) for a fake repository that omits the method. */
async function managerEntrantCounts(
  tournaments: TournamentRepository,
  list: Tournament[],
): Promise<Map<string, number>> {
  if (list.length === 0 || !tournaments.countManagerEntrants) return new Map();
  const counts = await tournaments.countManagerEntrants(list.map((t) => t.id));
  // The grouped query omits zero-count tournaments (a GROUP BY only returns
  // groups that have rows), so an entered-by-nobody event is simply absent
  // from it. Zero is a real, PRESENT value for every tournament whose count
  // WAS computed — the UI needs to say "No managers entered yet" exactly
  // when nobody has, which is when it matters most — so fill it in here.
  // The field stays genuinely ABSENT (never a misleading 0) only when the
  // method is unavailable at all, handled by the early return above.
  const result = new Map<string, number>();
  for (const t of list) result.set(t.id, counts.get(t.id) ?? 0);
  return result;
}

interface OpenTournamentBody {
  tournamentId: string;
  tier: TournamentTier;
  ageBand?: AgeBand | null;
  surface: Surface;
  weekScheduled: { season: number; week: number };
  drawSize: DrawSize;
  entrants: Array<{ playerId: string; seed: number | null }>;
}

interface OpenRegistrationBody {
  tournamentId: string;
  tier: TournamentTier;
  ageBand?: AgeBand | null;
  surface: Surface;
  weekScheduled: { season: number; week: number };
  drawSize: DrawSize;
}

interface SimulateParams {
  id: string;
  round: string;
  index: string;
}

export function registerTournamentRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.post<{ Body: OpenTournamentBody }>(
    '/tournaments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tournamentId', 'tier', 'surface', 'weekScheduled', 'drawSize', 'entrants'],
          properties: {
            tournamentId: { type: 'string', minLength: 1 },
            tier: { type: 'string', enum: TOURNAMENT_TIERS },
            ageBand: { type: ['string', 'null'], enum: ['u14', 'u16', 'u18', null] },
            surface: { type: 'string', enum: ['clay', 'grass', 'hard', 'indoor'] },
            weekScheduled: {
              type: 'object',
              required: ['season', 'week'],
              properties: {
                season: { type: 'integer', minimum: 0 },
                week: { type: 'integer', minimum: 0 },
              },
              additionalProperties: false,
            },
            drawSize: { type: 'integer', enum: [16, 32, 64, 128] },
            entrants: {
              type: 'array',
              minItems: 2,
              items: {
                type: 'object',
                required: ['playerId'],
                properties: {
                  playerId: { type: 'string', minLength: 1 },
                  seed: { type: ['integer', 'null'], minimum: 1 },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!(await requireInternalAdmin(request, reply))) return;
      const tournamentId = TournamentId(request.body.tournamentId);
      await deps.openTournament.execute({
        tournamentId,
        tier: request.body.tier,
        ageBand: request.body.ageBand ?? null,
        surface: request.body.surface,
        weekScheduled: request.body.weekScheduled,
        drawSize: request.body.drawSize,
        entrants: request.body.entrants.map((entrant) => ({
          playerId: PlayerId(entrant.playerId),
          seed: entrant.seed ?? null,
        })),
      });

      const tournament = await deps.tournaments.findById(tournamentId);
      return reply.code(201).send(toTournamentDto(tournament!));
    },
  );

  // Opens a tournament for registration with no entrants yet — the
  // genuine counterpart to a roster row's "Enter" action, distinct
  // from POST /tournaments above (which opens AND starts immediately
  // with a fixed entrant list). The draw auto-starts once
  // POST /tournaments/:id/entrants fills the last slot.
  app.post<{ Body: OpenRegistrationBody }>(
    '/tournaments/open-registration',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tournamentId', 'tier', 'surface', 'weekScheduled', 'drawSize'],
          properties: {
            tournamentId: { type: 'string', minLength: 1 },
            tier: { type: 'string', enum: TOURNAMENT_TIERS },
            ageBand: { type: ['string', 'null'], enum: ['u14', 'u16', 'u18', null] },
            surface: { type: 'string', enum: ['clay', 'grass', 'hard', 'indoor'] },
            weekScheduled: {
              type: 'object',
              required: ['season', 'week'],
              properties: {
                season: { type: 'integer', minimum: 0 },
                week: { type: 'integer', minimum: 0 },
              },
              additionalProperties: false,
            },
            drawSize: { type: 'integer', enum: [16, 32, 64, 128] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!(await requireInternalAdmin(request, reply))) return;
      const tournamentId = TournamentId(request.body.tournamentId);
      await deps.openRegistration.execute({
        tournamentId,
        tier: request.body.tier,
        ageBand: request.body.ageBand ?? null,
        surface: request.body.surface,
        weekScheduled: request.body.weekScheduled,
        drawSize: request.body.drawSize,
      });

      const tournament = await deps.tournaments.findById(tournamentId);
      return reply.code(201).send(toTournamentDto(tournament!));
    },
  );

  app.get<{ Params: { id: string } }>('/tournaments/:id', async (request, reply) => {
    const tournament = await deps.tournaments.findById(TournamentId(request.params.id));
    if (!tournament) {
      return reply.code(404).send({ error: `Tournament ${request.params.id} not found` });
    }
    const managerCounts = await managerEntrantCounts(deps.tournaments, [tournament]);
    return toTournamentDto(tournament, undefined, managerCounts.get(tournament.id));
  });

  // Lists tournaments by status: 'open' (still accepting entrants —
  // what a roster row's "Enter" action needs) or 'started' (bracket
  // exists — what the Tournaments nav index links to for brackets to
  // browse/watch). No unfiltered "list everything" mode on purpose:
  // every real caller so far wants one or the other, never both.
  //
  // Optional ?playerId= attaches weeklyEntryCountThisWeek/CapThisWeek
  // and ageEligible to every tournament in the response (both bands —
  // the senior tour is capped at 1/week now, junior at 3/week), so a
  // caller like EnterTournamentModal can disable an over-cap or
  // age-ineligible entry attempt up front instead of only discovering
  // it from a failed POST — both are real (RegisterEntrantUseCase's
  // own sources), never a client-side guess.
  app.get<{ Querystring: { status?: string; playerId?: string } }>('/tournaments', async (request, reply) => {
    const playerId = request.query.playerId ? PlayerId(request.query.playerId) : null;
    if (request.query.status === 'open') {
      const list = await deps.tournaments.findOpenForRegistration();
      // "Open for entries" means "still accepting entrants for a week
      // that hasn't fully passed." A tournament scheduled for a PAST
      // week should have been started by StartDueTournamentsUseCase, but
      // until that sweep runs (or if it never does — e.g. a seeded dev
      // world browsed without worker ticks), a stale hasStarted=false
      // row from weeks ago would otherwise show up here forever. Drop
      // anything scheduled before the world's current week so the list
      // only ever offers current-or-future weeks (the entry planner's
      // future-week registration depends on that too).
      const world = await deps.worlds.findById(WORLD_ID);
      const open = world ? list.filter((t) => compareGameWeek(t.weekScheduled, world.currentWeek) >= 0) : list;
      const player = playerId ? await deps.players.findById(playerId) : null;
      const rank = player ? (await deps.rankPosition.rankFor(playerId!)).rank : null;
      const entryInfo = playerId && player ? await attachEntryInfo(deps.tournaments, open, playerId, player.ageInWeeks, rank) : null;
      const managerCounts = await managerEntrantCounts(deps.tournaments, open);
      // Explicit and additive, not derived from `hasStarted` on the
      // client: this list is ALREADY filtered to genuinely-open
      // tournaments (see the filtering above), so every row here really
      // is open for registration right now — a client that's cold on the
      // API (or just wants to render a badge) shouldn't have to
      // re-derive that from `hasStarted === false` plus knowledge of
      // which endpoint it called. Deliberately NOT added inside
      // `toTournamentDto` itself, since that function also serves the
      // `status=started` list, where it would be wrong.
      return open.map((t) => ({ ...toTournamentDto(t, entryInfo?.get(t.id), managerCounts.get(t.id)), registrationOpen: true }));
    }
    if (request.query.status === 'started') {
      const list = await deps.tournaments.findStarted();
      // "Results & live brackets" should be the CURRENT week's tournaments
      // plus last week's, not the entire history of every bracket ever
      // played. The carve-outs:
      //   - a bracket scheduled LAST week is always kept — both a two-week
      //     tier (major/juniorMasters) still mid-draw, AND a one-week event
      //     that just FINISHED. Keeping only the two-week tiers made the
      //     section's own "✓ Finished" badge unreachable: every finished
      //     one-week event was dropped the moment its week passed, so all
      //     the list could ever show was "In progress". A user looking for
      //     a RESULT must be able to find a completed event;
      //   - an UNFINISHED bracket is kept a couple of weeks beyond its
      //     scheduled week — the real reason the naive "current week only"
      //     rule was wrong: a 128-draw major with a qualifying draw
      //     schedules its main final at firstDay + qualifyingRoundCount +
      //     14, i.e. into the SECOND week after its scheduled week, and
      //     that final is a live bracket a manager would expect to still
      //     see. "Finished" is read off the aggregate (last main round
      //     fully decided), not guessed from the tier.
      // Anything else older than last week is finished and hidden — one
      // week of recently-decided brackets, not the whole history.
      const world = await deps.worlds.findById(WORLD_ID);
      const started = world
        ? list.filter((t) => {
            const weeksSinceScheduled = weeksBetween(t.weekScheduled, world.currentWeek);
            if (weeksSinceScheduled === 0) return true;
            if (weeksSinceScheduled === 1) return true;
            // A genuinely unfinished bracket stays visible for up to ~3
            // weeks past its scheduled week (covers the qualifying-shifted
            // major final); an unfinished bracket older than that is
            // stuck, not underway — a small, honest set, kept visible.
            return !t.isMainDrawFinished() && weeksSinceScheduled <= 3;
          })
        : list;
      const managerCounts = await managerEntrantCounts(deps.tournaments, started);
      return started.map((t) => toTournamentDto(t, undefined, managerCounts.get(t.id)));
    }
    return reply.code(400).send({ error: "GET /tournaments requires ?status=open or ?status=started" });
  });

  app.post<{ Params: { id: string }; Body: { playerId: string; seed?: number | null } }>(
    '/tournaments/:id/entrants',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playerId'],
          properties: {
            playerId: { type: 'string', minLength: 1 },
            seed: { type: ['integer', 'null'], minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      const tournamentId = TournamentId(request.params.id);
      const player = await deps.players.findById(PlayerId(request.body.playerId));
      if (!player || player.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found in your roster' });
      // Wild cards (see WildCardPolicy) are NOT requested here — they
      // are granted automatically, by algorithm, the moment the field
      // this registration might just have completed closes (see
      // RegisterEntrantUseCase). There is no wild-card input on this
      // route at all.
      await deps.registerEntrant.execute({
        tournamentId,
        playerId: PlayerId(request.body.playerId),
        seed: request.body.seed ?? null,
      });

      const tournament = await deps.tournaments.findById(tournamentId);
      // Fire-and-forget (analytics never throws) — see AnalyticsPort.
      void deps.analytics.record({
        name: 'tournament_entered',
        managerId: manager.id,
        props: { tournamentId, tier: tournament!.tier, ageBand: tournament!.ageBand },
      });
      return reply.code(201).send(toTournamentDto(tournament!));
    },
  );

  // Registers a single player into a tournament's DOUBLES field (P7b) —
  // per-player, not per-pair; they are paired at draw-formation time.
  app.post<{ Params: { id: string }; Body: { playerId: string } }>(
    '/tournaments/:id/doubles-entrants',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playerId'],
          properties: { playerId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      const tournamentId = TournamentId(request.params.id);
      const player = await deps.players.findById(PlayerId(request.body.playerId));
      if (!player || player.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found in your roster' });
      await deps.registerDoublesEntrant.execute({
        tournamentId,
        playerId: PlayerId(request.body.playerId),
        managerId: manager.id,
      });

      const tournament = await deps.tournaments.findById(tournamentId);
      // Fire-and-forget (analytics never throws) — see AnalyticsPort.
      void deps.analytics.record({
        name: 'tournament_entered',
        managerId: manager.id,
        props: { tournamentId, tier: tournament!.tier, ageBand: tournament!.ageBand, doubles: true },
      });
      return reply.code(201).send(toTournamentDto(tournament!));
    },
  );
  // ?draw=qualifying simulates a slot in the QUALIFYING bracket instead
  // of the main draw. Optional and defaulting to 'main', so the URL and
  // every existing caller are unchanged.
  app.post<{ Params: SimulateParams; Querystring: { draw?: string } }>(
    '/tournaments/:id/matches/:round/:index/simulate',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'round', 'index'],
          properties: {
            id: { type: 'string', minLength: 1 },
            round: { type: 'string', pattern: '^[0-9]+$' },
            index: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
        querystring: {
          type: 'object',
          properties: { draw: { type: 'string', enum: ['main', 'qualifying'] } },
        },
      },
    },
    async (request, reply) => {
      // A manual match simulation is an operator/dev override, not a player
      // action — it bypasses the day-gated sweep. Admin-gated exactly like the
      // tournament open/open-registration routes above, NOT merely
      // manager-authenticated. The player-facing bracket no longer renders a
      // "Simulate" control at all.
      if (!(await requireInternalAdmin(request, reply))) return;
      const roundNumber = Number(request.params.round);
      const matchIndex = Number(request.params.index);
      const draw: DrawPhase = request.query.draw === 'qualifying' ? 'qualifying' : 'main';
      const matchId = matchIdForSlot(TournamentId(request.params.id), roundNumber, matchIndex, draw);

      const { replayUrl } = await deps.simulateMatch.execute({
        matchId,
        tournamentId: TournamentId(request.params.id),
        roundNumber,
        matchIndex,
        draw,
      });

      return { matchId, replayUrl };
    },
  );
}
