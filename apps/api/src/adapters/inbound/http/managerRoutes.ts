import { FastifyInstance } from 'fastify';
import { Dependencies } from '../../../composition';
import { requireManager } from './auth';

/**
 * The public manager LADDER leaderboard (see
 * docs/rocking-rackets-competitive-analysis.md §1d/P3) — the decaying,
 * competitive standing that is the retention meta-loop, distinct from
 * the spendable XP wallet. The list is public (any authenticated
 * manager can browse it); a caller's own rank/score is attached
 * separately so the page can highlight "you are #N" even when they're
 * below the returned top slice.
 */
export function registerManagerRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get<{ Querystring: { limit?: string } }>('/managers/leaderboard', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;

    const parsedLimit = Number(request.query.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 200) : 100;

    const standings = await deps.managerLadder.topStandings(limit);

    // Resolve display names for the returned slice only (bounded by
    // `limit`), so the leaderboard shows manager names rather than raw
    // ids. Missing accounts (seed-only ids) fall back to the id.
    const names = new Map<string, string>();
    await Promise.all(
      standings.map(async (s) => {
        const account = await deps.managers.findById(s.managerId);
        if (account) names.set(s.managerId, account.displayName);
      }),
    );

    const rows = standings.map((s, index) => ({
      rank: index + 1,
      managerId: s.managerId,
      displayName: names.get(s.managerId) ?? s.managerId,
      score: Math.round(s.score),
      isSelf: s.managerId === manager.id,
    }));

    const selfScore = await deps.managerLadder.scoreFor(manager.id);
    const selfRank = await deps.managerLadder.rankFor(manager.id);

    return {
      standings: rows,
      self: {
        managerId: manager.id,
        displayName: manager.displayName,
        score: Math.round(selfScore),
        rank: selfRank,
      },
    };
  });
}
