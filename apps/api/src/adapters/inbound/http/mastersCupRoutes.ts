import { FastifyInstance } from 'fastify';
import { MastersCup } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';

/** Thin serialization only — the group/knockout structure is passed
 * through as-is (entrant ids are already strings; the frontend resolves
 * them to names via its own player fetches). */
function toMastersCupDto(cup: MastersCup) {
  return {
    id: cup.id,
    season: cup.season,
    weekScheduled: cup.weekScheduled,
    surface: cup.surface,
    singlesEntrants: cup.singlesEntrants,
    doublesEntrants: cup.doublesEntrants,
    singlesGroups: cup.singlesGroups,
    doublesGroups: cup.doublesGroups,
    singlesKnockout: cup.singlesKnockout,
    doublesKnockout: cup.doublesKnockout,
    singlesGroupStageComplete: cup.singlesGroupStageComplete,
    doublesGroupStageComplete: cup.doublesGroupStageComplete,
    hasKnockout: cup.hasKnockout,
    singlesChampion: cup.singlesChampion,
    doublesChampion: cup.doublesChampion,
  };
}

export function registerMastersCupRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get<{ Params: { season: string } }>('/masters-cup/:season', async (request, reply) => {
    const season = Number(request.params.season);
    if (!Number.isInteger(season) || season < 1) {
      return reply.code(400).send({ error: 'season must be a positive integer' });
    }
    const cup = await deps.mastersCups.findBySeason(season);
    if (!cup) return reply.code(404).send({ error: `No Masters Cup for season ${season}` });
    return toMastersCupDto(cup);
  });
}
