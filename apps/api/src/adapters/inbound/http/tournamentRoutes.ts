import { FastifyInstance } from 'fastify';
import { entryTypeOf, isAgeEligibleForTournamentBand, isJuniorTier, isObligatoryTier, isUnsourcedPlaceholderTier, PlayerId, qualifierSlotsFor, StandardRankingPointsTable, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { AgeBand, DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';

const TOURNAMENT_TIERS = ['futures', 'challenger', 'tour', 'major', 'j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'];
import { countSameBandEntriesForWeek, weeklyEntryCapForTier, matchIdForSlot } from '@tennis-manager/application';
import { TournamentRepository } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';
import { requireInternalAdmin, requireManager } from './auth';

/** Single shared instance — the points table is a pure lookup of
 * domain-owned constants (no per-request state), so it's safe to build
 * once and reuse. */
const POINTS_TABLE = new StandardRankingPointsTable();

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


/** Thin serialization only — no domain rules here, EXCEPT the
 * player-scoped fields, which are only ever attached by the
 * playerId-aware overload below (see GET /tournaments) — never
 * computed from anything but the real weekly-entry-cap constants
 * (weeklyEntryCapForTier) and isAgeEligibleForTournamentBand, the same
 * sources RegisterEntrantUseCase itself enforces against. */
export function toTournamentDto(
  tournament: Tournament,
  playerScopedInfo?: { weeklyEntryCountThisWeek: number; weeklyEntryCapThisWeek: number; ageEligible: boolean },
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
    weekScheduled: tournament.weekScheduled,
    drawSize: tournament.drawSize,
    hasStarted: tournament.hasStarted,
    entrants: tournament.entrants.map((entrant) => ({
      playerId: entrant.playerId,
      seed: entrant.seed,
      /** 'DA' | 'Q' | 'WC' — how this entrant got their place. The
       * draw sheet's real convention; only ever 'Q' at a tier that
       * holds qualifying (see QualifyingPolicy). */
      entryType: entryTypeOf(entrant),
    })),
    /** How many of this draw's places are reserved for qualifiers — 0
     * at every tier that holds no qualifying, which is what lets the UI
     * stay silent about `[Q]` there instead of showing an empty rule. */
    qualifierSlots: qualifierSlotsFor(tournament.tier, tournament.drawSize),
    /** True when a top-ranked player is OBLIGATED to count this event
     * even if they skip it (ObligatoryTournamentPolicy) — surfaced so
     * the rule is legible to managers rather than a hidden penalty. */
    obligatory: isObligatoryTier(tournament.tier),
    ...(playerScopedInfo ?? {}),
    rounds: tournament.getRounds().map((round) => ({
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
      })),
    })),
  };
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
): Promise<Map<string, { weeklyEntryCountThisWeek: number; weeklyEntryCapThisWeek: number; ageEligible: boolean }>> {
  const countByBandWeekKey = new Map<string, number>();
  const result = new Map<string, { weeklyEntryCountThisWeek: number; weeklyEntryCapThisWeek: number; ageEligible: boolean }>();
  for (const tournament of list) {
    const bandKey = isJuniorTier(tournament.tier) ? 'j' : 's';
    const weekKey = `${bandKey}-${tournament.weekScheduled.season}-${tournament.weekScheduled.week}`;
    let count = countByBandWeekKey.get(weekKey);
    if (count === undefined) {
      count = await countSameBandEntriesForWeek(tournaments, playerId, tournament.weekScheduled, tournament.tier);
      countByBandWeekKey.set(weekKey, count);
    }
    result.set(tournament.id, {
      weeklyEntryCountThisWeek: count,
      weeklyEntryCapThisWeek: weeklyEntryCapForTier(tournament.tier),
      ageEligible: isAgeEligibleForTournamentBand(playerAgeInWeeks, tournament.ageBand),
    });
  }
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
            ageBand: { type: ['string', 'null'], enum: ['u14', 'u16', null] },
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
            ageBand: { type: ['string', 'null'], enum: ['u14', 'u16', null] },
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
    return toTournamentDto(tournament);
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
      const player = playerId ? await deps.players.findById(playerId) : null;
      const entryInfo = playerId && player ? await attachEntryInfo(deps.tournaments, list, playerId, player.ageInWeeks) : null;
      return list.map((t) => toTournamentDto(t, entryInfo?.get(t.id)));
    }
    if (request.query.status === 'started') {
      return (await deps.tournaments.findStarted()).map((t) => toTournamentDto(t));
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
      await deps.registerEntrant.execute({
        tournamentId,
        playerId: PlayerId(request.body.playerId),
        seed: request.body.seed ?? null,
      });

      const tournament = await deps.tournaments.findById(tournamentId);
      return reply.code(201).send(toTournamentDto(tournament!));
    },
  );

  app.post<{ Params: SimulateParams }>(
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
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      const roundNumber = Number(request.params.round);
      const matchIndex = Number(request.params.index);
      const matchId = matchIdForSlot(TournamentId(request.params.id), roundNumber, matchIndex);

      const { replayUrl } = await deps.simulateMatch.execute({
        matchId,
        tournamentId: TournamentId(request.params.id),
        roundNumber,
        matchIndex,
      });

      return { matchId, replayUrl };
    },
  );
}
