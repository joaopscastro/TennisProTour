import { FastifyInstance } from 'fastify';
import { WorldTeamCup } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';

function toDto(cup: WorldTeamCup) {
  return {
    id: cup.id,
    season: cup.season,
    weekScheduled: cup.weekScheduled,
    surface: cup.surface,
    teams: cup.teams,
    groups: cup.groups,
    knockout: cup.knockout,
    hasKnockout: cup.hasKnockout,
    champion: cup.champion,
  };
}

export function registerWorldTeamCupRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get<{ Params: { season: string } }>('/world-team-cup/:season', async (request, reply) => {
    const season = Number(request.params.season);
    if (!Number.isInteger(season) || season < 1) {
      return reply.code(400).send({ error: 'season must be a positive integer' });
    }
    const cup = await deps.worldTeamCups.findBySeason(season);
    if (!cup) return reply.code(404).send({ error: `No World Team Cup for season ${season}` });
    return toDto(cup);
  });
}
