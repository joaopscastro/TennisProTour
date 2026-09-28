import { FastifyInstance } from 'fastify';
import { RankingBand, RankingDiscipline } from '@tennis-manager/domain';
import { RankPositionQuery } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';

const VALID_BANDS: readonly RankingBand[] = ['senior', 'u14', 'u16', 'u18'];
const VALID_DISCIPLINES: readonly RankingDiscipline[] = ['singles', 'doubles'];

/**
 * Public standings tables (senior/u14/u16/u18) — the counterpart to
 * `/managers/leaderboard` for PLAYERS rather than managers. Closes the
 * "no dedicated junior standings page" gap: previously a manager could
 * only see a band's ranking through their own rostered players' rows on
 * the roster dashboard, never browse the full table.
 *
 * Deliberately public, no auth required (`requireManager` isn't called)
 * — matches every other read-only player-data route (`/players/:id`,
 * `/players/:id/ranking`), not the manager-scoped ones that need to
 * resolve a caller's own identity (`/managers/leaderboard`,
 * `/me/players`). There is no natural "self" row here the way the
 * manager ladder has one — a player isn't the authenticated caller.
 *
 * Reuses `RankPositionQuery.sortedRankings()` as-is (already returns
 * every ranked player in a band, sorted, ports-only, no DB import) —
 * this route is exactly the composition managerRoutes.ts's leaderboard
 * already does inline (slice + resolve names for the slice), not a new
 * Drizzle-specific read model.
 *
 * DISCIPLINE (?discipline=singles|doubles, default singles): picks
 * between the SINGLES and DOUBLES `RankPositionQuery` instances for the
 * band — both already exist in composition (the doubles ones back the
 * doubles draw formation's entry ranking). An absent parameter is
 * byte-identical to the pre-discipline route (the response body is
 * still exactly `{ band, standings }` — the discipline is request
 * context, not response payload); an unrecognized value is a 400.
 */
export function registerRankingsRoutes(app: FastifyInstance, deps: Dependencies): void {
  const queryFor = (band: RankingBand, discipline: RankingDiscipline): RankPositionQuery => {
    if (discipline === 'doubles') return deps.doublesRankByBand[band];
    if (band === 'u14') return deps.rankPositionU14;
    if (band === 'u16') return deps.rankPositionU16;
    if (band === 'u18') return deps.rankPositionU18;
    return deps.rankPosition;
  };

  app.get<{ Params: { band: string }; Querystring: { limit?: string; discipline?: string } }>(
    '/rankings/:band',
    async (request, reply) => {
      const band = request.params.band as RankingBand;
      if (!VALID_BANDS.includes(band)) {
        return reply.code(400).send({ error: `Unknown ranking band "${request.params.band}" (expected senior, u14, u16, or u18)` });
      }
      const disciplineParam = request.query.discipline;
      if (disciplineParam !== undefined && !VALID_DISCIPLINES.includes(disciplineParam as RankingDiscipline)) {
        return reply.code(400).send({ error: `Unknown discipline "${disciplineParam}" (expected singles or doubles)` });
      }
      const discipline: RankingDiscipline = (disciplineParam as RankingDiscipline | undefined) ?? 'singles';

      const parsedLimit = Number(request.query.limit);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 200) : 50;

      const sorted = await queryFor(band, discipline).sortedRankings();
      const slice = sorted.slice(0, limit);

      // Resolve name/nationality for the returned slice only (bounded by
      // `limit`), same pattern as /managers/leaderboard's name resolution
      // — never load every player in the band just to show a page of them.
      const players = new Map<string, { name: string; nationality: string }>();
      await Promise.all(
        slice.map(async (r) => {
          const player = await deps.players.findById(r.playerId);
          if (player) players.set(r.playerId, { name: player.name, nationality: player.nationality });
        }),
      );

      const standings = slice.map((r, index) => ({
        rank: index + 1,
        playerId: r.playerId,
        name: players.get(r.playerId)?.name ?? r.playerId,
        nationality: players.get(r.playerId)?.nationality ?? null,
        points: r.totalPoints,
      }));

      return { band, standings };
    },
  );
}
