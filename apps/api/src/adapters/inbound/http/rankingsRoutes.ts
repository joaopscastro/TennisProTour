import { FastifyInstance } from 'fastify';
import { RankingBand } from '@tennis-manager/domain';
import { RankPositionQuery } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';

const VALID_BANDS: readonly RankingBand[] = ['senior', 'u14', 'u16', 'u18'];

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
 */
export function registerRankingsRoutes(app: FastifyInstance, deps: Dependencies): void {
  const queryFor = (band: RankingBand): RankPositionQuery => {
    if (band === 'u14') return deps.rankPositionU14;
    if (band === 'u16') return deps.rankPositionU16;
    if (band === 'u18') return deps.rankPositionU18;
    return deps.rankPosition;
  };

  app.get<{ Params: { band: string }; Querystring: { limit?: string } }>(
    '/rankings/:band',
    async (request, reply) => {
      const band = request.params.band as RankingBand;
      if (!VALID_BANDS.includes(band)) {
        return reply.code(400).send({ error: `Unknown ranking band "${request.params.band}" (expected senior, u14, u16, or u18)` });
      }

      const parsedLimit = Number(request.query.limit);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 200) : 50;

      const sorted = await queryFor(band).sortedRankings();
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
