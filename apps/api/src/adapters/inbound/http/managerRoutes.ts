import { FastifyInstance } from 'fastify';
import { MANAGER_COSMETICS, CosmeticItem, ownedBadgeFor } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { requireManager } from './auth';

/** The public badge shape shown next to a manager's name on the
 * leaderboard — deliberately just the presentation bits (never the
 * price, the owned set, or anything else about the wallet). */
function badgeDto(item: CosmeticItem | null): { itemId: string; glyph: string; name: string } | null {
  return item ? { itemId: item.id, glyph: item.glyph, name: item.name } : null;
}

/**
 * The public manager LADDER leaderboard (see
 * docs/rocking-rackets-competitive-analysis.md §1d/P3) — the decaying,
 * competitive standing that is the retention meta-loop, distinct from
 * the spendable XP wallet. The list is public (any authenticated
 * manager can browse it); a caller's own rank/score is attached
 * separately so the page can highlight "you are #N" even when they're
 * below the returned top slice.
 *
 * Each row also carries the manager's owned cosmetic BADGE (Batch 4B,
 * F2) — one query for the whole returned slice, via
 * ManagerCosmeticPort.ownedByManagers. Cosmetics are cosmetic only: a
 * badge changes nothing but the glyph next to a name.
 *
 * The `/managers/cosmetics` routes are the manager's own surface for the
 * XP sink: the catalog with PLACEHOLDER prices, the owned set, and the
 * purchase action. Buying is atomic (wallet debit + unlock in one DB
 * transaction, see DrizzleManagerCosmeticAdapter) and a re-buy is
 * refused.
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

    // One batched cosmetics read for the returned slice PLUS the caller
    // (who may be below the cut), so every rendered name gets its badge
    // without an N+1.
    const ownedByManager = await deps.managerCosmetics.ownedByManagers([
      ...standings.map((s) => s.managerId),
      manager.id,
    ]);

    const rows = standings.map((s, index) => ({
      rank: index + 1,
      managerId: s.managerId,
      displayName: names.get(s.managerId) ?? s.managerId,
      score: Math.round(s.score),
      isSelf: s.managerId === manager.id,
      badge: badgeDto(ownedBadgeFor(ownedByManager.get(s.managerId) ?? [])),
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
        badge: badgeDto(ownedBadgeFor(ownedByManager.get(manager.id) ?? [])),
      },
    };
  });

  // The manager's own cosmetics surface: the full catalog (with real
  // prices), the owned item ids, and the badge currently shown on the
  // leaderboard. No query parameter — this is always the caller.
  app.get('/managers/cosmetics', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const owned = await deps.managerCosmetics.ownedFor(manager.id);
    return {
      catalog: MANAGER_COSMETICS,
      owned,
      badge: badgeDto(ownedBadgeFor(owned)),
      xpBalance: await deps.managerXp.balanceFor(manager.id),
    };
  });

  app.post<{ Body: { itemId: string } }>(
    '/managers/cosmetics/purchase',
    {
      schema: {
        body: {
          type: 'object',
          required: ['itemId'],
          properties: { itemId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;

      const result = await deps.purchaseManagerCosmetic.execute({
        managerId: manager.id,
        itemId: request.body.itemId,
      });
      const owned = await deps.managerCosmetics.ownedFor(manager.id);
      return {
        itemId: result.itemId,
        xpSpent: result.xpSpent,
        xpBalance: await deps.managerXp.balanceFor(manager.id),
        owned,
      };
    },
  );
}
