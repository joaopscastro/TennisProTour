import { FastifyInstance } from 'fastify';
import { PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { DrawSize, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import { matchIdForSlot } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';

/** Thin serialization only — no domain rules here. */
function toTournamentDto(tournament: Tournament) {
  return {
    id: tournament.id,
    tier: tournament.tier,
    surface: tournament.surface,
    weekScheduled: tournament.weekScheduled,
    drawSize: tournament.drawSize,
    hasStarted: tournament.hasStarted,
    entrants: tournament.entrants.map((entrant) => ({ playerId: entrant.playerId, seed: entrant.seed })),
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

interface OpenTournamentBody {
  tournamentId: string;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: { season: number; week: number };
  drawSize: DrawSize;
  entrants: Array<{ playerId: string; seed: number | null }>;
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
            tier: { type: 'string', enum: ['junior', 'futures', 'challenger', 'tour', 'major'] },
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
      const tournamentId = TournamentId(request.body.tournamentId);
      await deps.openTournament.execute({
        tournamentId,
        tier: request.body.tier,
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
  app.get<{ Querystring: { status?: string } }>('/tournaments', async (request, reply) => {
    if (request.query.status === 'open') {
      return (await deps.tournaments.findOpenForRegistration()).map(toTournamentDto);
    }
    if (request.query.status === 'started') {
      return (await deps.tournaments.findStarted()).map(toTournamentDto);
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
      const tournamentId = TournamentId(request.params.id);
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
    async (request) => {
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
