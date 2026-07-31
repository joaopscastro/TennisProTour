import { FastifyInstance } from 'fastify';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';

/** Thin serialization only — no domain rules here. */
function toPlayerDto(player: Player) {
  const { technical, physical, mental, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    managerId: player.managerId,
    ageInWeeks: player.ageInWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
    attributes: {
      technical: {
        serve: technical.serve.value,
        forehand: technical.forehand.value,
        backhand: technical.backhand.value,
        volley: technical.volley.value,
      },
      physical: {
        speed: physical.speed.value,
        stamina: physical.stamina.value,
        strength: physical.strength.value,
      },
      mental: {
        consistency: mental.consistency.value,
        clutch: mental.clutch.value,
      },
      surfaceAffinities: {
        clay: surfaceAffinities.get('clay'),
        grass: surfaceAffinities.get('grass'),
        hard: surfaceAffinities.get('hard'),
        indoor: surfaceAffinities.get('indoor'),
      },
    },
  };
}

interface HirePlayerBody {
  playerId: string;
  name: string;
  managerId: string;
  startingAgeInWeeks: number;
}

export function registerPlayerRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.post<{ Body: HirePlayerBody }>(
    '/players',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playerId', 'name', 'managerId', 'startingAgeInWeeks'],
          properties: {
            playerId: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            managerId: { type: 'string', minLength: 1 },
            startingAgeInWeeks: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await deps.hirePlayer.execute({
        playerId: PlayerId(request.body.playerId),
        name: request.body.name,
        managerId: ManagerId(request.body.managerId),
        startingAgeInWeeks: request.body.startingAgeInWeeks,
      });

      const player = await deps.players.findById(PlayerId(request.body.playerId));
      return reply.code(201).send(toPlayerDto(player!));
    },
  );

  app.get<{ Params: { id: string } }>('/players/:id', async (request, reply) => {
    const player = await deps.players.findById(PlayerId(request.params.id));
    if (!player) {
      return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    }
    return toPlayerDto(player);
  });

  // Roster read for the dashboard. An empty roster is a 200 with [],
  // not a 404 — a manager with no players is a normal state.
  app.get<{ Params: { id: string } }>('/managers/:id/players', async (request) => {
    const roster = await deps.players.findByManager(ManagerId(request.params.id));
    return roster.map(toPlayerDto);
  });
}
