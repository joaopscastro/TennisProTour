import { FastifyInstance } from 'fastify';
import { isJuniorTier, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { AgeBand, DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';

const TOURNAMENT_TIERS = ['futures', 'challenger', 'tour', 'major', 'j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'];
import { countJuniorEntriesForWeek, JUNIOR_WEEKLY_ENTRY_CAP, matchIdForSlot } from '@tennis-manager/application';
import { TournamentRepository } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';
import { requireInternalAdmin, requireManager } from './auth';

/** Thin serialization only — no domain rules here, EXCEPT the two
 * junior-entry-cap fields, which are only ever attached by the
 * playerId-aware overload below (see GET /tournaments) — never
 * computed from anything but the real JUNIOR_WEEKLY_ENTRY_CAP constant
 * and TournamentRepository.findByPlayerAndWeek, the same source
 * RegisterEntrantUseCase itself enforces against. */
function toTournamentDto(
  tournament: Tournament,
  juniorEntryInfo?: { juniorEntryCountThisWeek: number; juniorEntryCapThisWeek: number },
) {
  return {
    id: tournament.id,
    tier: tournament.tier,
    ageBand: tournament.ageBand,
    surface: tournament.surface,
    weekScheduled: tournament.weekScheduled,
    drawSize: tournament.drawSize,
    hasStarted: tournament.hasStarted,
    entrants: tournament.entrants.map((entrant) => ({ playerId: entrant.playerId, seed: entrant.seed })),
    ...(juniorEntryInfo ?? {}),
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

/** For every junior-tier tournament in the list, how many junior
 * tournaments the given player has already entered in that
 * tournament's specific week — one countJuniorEntriesForWeek call per
 * DISTINCT (season, week) among the junior tournaments, not one per
 * tournament, since a manager's open-tournament list is typically
 * dominated by a handful of weeks. Senior tournaments never get this
 * field at all (isJuniorTier gate matches RegisterEntrantUseCase's own
 * scoping — see its doc comment on why the senior tour isn't capped). */
async function attachJuniorEntryInfo(
  tournaments: TournamentRepository,
  list: Tournament[],
  playerId: PlayerId,
): Promise<Map<string, { juniorEntryCountThisWeek: number; juniorEntryCapThisWeek: number }>> {
  const countByWeekKey = new Map<string, number>();
  const result = new Map<string, { juniorEntryCountThisWeek: number; juniorEntryCapThisWeek: number }>();
  for (const tournament of list) {
    if (!isJuniorTier(tournament.tier)) continue;
    const weekKey = `${tournament.weekScheduled.season}-${tournament.weekScheduled.week}`;
    let count = countByWeekKey.get(weekKey);
    if (count === undefined) {
      count = await countJuniorEntriesForWeek(tournaments, playerId, tournament.weekScheduled);
      countByWeekKey.set(weekKey, count);
    }
    result.set(tournament.id, { juniorEntryCountThisWeek: count, juniorEntryCapThisWeek: JUNIOR_WEEKLY_ENTRY_CAP });
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
  // Optional ?playerId= attaches juniorEntryCountThisWeek/CapThisWeek
  // to every junior-tier tournament in the response, so a caller like
  // EnterTournamentModal can disable an over-cap entry attempt up
  // front instead of only discovering it from a failed POST — the
  // count itself is real (RegisterEntrantUseCase's own source), not a
  // client-side guess.
  app.get<{ Querystring: { status?: string; playerId?: string } }>('/tournaments', async (request, reply) => {
    const playerId = request.query.playerId ? PlayerId(request.query.playerId) : null;
    if (request.query.status === 'open') {
      const list = await deps.tournaments.findOpenForRegistration();
      const juniorInfo = playerId ? await attachJuniorEntryInfo(deps.tournaments, list, playerId) : null;
      return list.map((t) => toTournamentDto(t, juniorInfo?.get(t.id)));
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
