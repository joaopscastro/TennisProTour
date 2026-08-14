import { FastifyInstance } from 'fastify';
import { DoublesPair, DoublesPairStatus, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { requireManager, ownershipMismatch } from './auth';

interface PlayerIdentityDto {
  playerId: PlayerId;
  name: string;
  nationality: string;
  managerId: ManagerId | null;
}

interface DoublesPairDto {
  id: PairId;
  status: DoublesPairStatus;
  chemistry: number;
  playerA: PlayerIdentityDto;
  playerB: PlayerIdentityDto;
}

function identity(player: Player | null, playerId: PlayerId): PlayerIdentityDto {
  return {
    playerId,
    name: player?.name ?? playerId,
    nationality: player?.nationality ?? 'XX',
    managerId: player?.managerId ?? null,
  };
}

async function toPairDto(deps: Dependencies, pair: DoublesPair): Promise<DoublesPairDto> {
  const [a, b] = await Promise.all([
    deps.players.findById(pair.playerA),
    deps.players.findById(pair.playerB),
  ]);
  return {
    id: pair.id,
    status: pair.status,
    chemistry: pair.chemistry,
    playerA: identity(a, pair.playerA),
    playerB: identity(b, pair.playerB),
  };
}

/**
 * Doubles partnerships (P7a, docs/doubles-and-special-formats-plan.md).
 * All three mutating routes are manager-scoped and delegate to the use
 * cases — the authorization rules (who may create/accept/dissolve) live
 * there, not here. The board read is pull-based (no Notifications
 * context yet): a manager's pairs and incoming invites are listed in one
 * call keyed on their roster.
 */
export function registerDoublesRoutes(app: FastifyInstance, deps: Dependencies): void {
  // The board read — every pair involving any of the manager's players
  // (active, pending, and the dissolved tail is omitted by the frontend
  // or here; we return all and let the client classify, since a
  // dissolved pair is still "yours, ended"). Both players' identities
  // are inlined so the client can tell "incoming invite" (I own playerB,
  // pending) from "my active pair" without extra player fetches.
  app.get<{ Params: { id: string } }>('/managers/:id/doubles-pairs', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (ownershipMismatch(request.params.id, manager)) return reply.code(404).send({ error: 'Manager not found' });

    const roster = await deps.players.findByManager(manager.id);
    const pairs = await deps.doublesPairs.findByPlayers(roster.map((p) => p.id));
    return Promise.all(pairs.map((pair) => toPairDto(deps, pair)));
  });

  app.get('/me/doubles-pairs', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const roster = await deps.players.findByManager(manager.id);
    const pairs = await deps.doublesPairs.findByPlayers(roster.map((p) => p.id));
    return Promise.all(pairs.map((pair) => toPairDto(deps, pair)));
  });

  // Forms a pair. `playerA` must be the caller's own player; `playerB`
  // either another of the caller's players (same-manager → active) or a
  // different manager's player (cross-manager → pending invite).
  app.post<{ Body: { playerA: string; playerB: string } }>(
    '/doubles-pairs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playerA', 'playerB'],
          properties: {
            playerA: { type: 'string', minLength: 1 },
            playerB: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      try {
        const pair = await deps.createDoublesPair.execute({
          playerA: PlayerId(request.body.playerA),
          playerB: PlayerId(request.body.playerB),
          managerId: manager.id,
        });
        return reply.code(201).send(await toPairDto(deps, pair));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // The invitee accepts a pending invitation (must own playerB).
  app.post<{ Params: { id: string } }>('/doubles-pairs/:id/accept', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    try {
      const pair = await deps.acceptDoublesPair.execute({ pairId: PairId(request.params.id), managerId: manager.id });
      return await toPairDto(deps, pair);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Ends a pair — either side (declining a pending invite, or breaking
  // up an active pair).
  app.post<{ Params: { id: string } }>('/doubles-pairs/:id/dissolve', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    try {
      const pair = await deps.dissolveDoublesPair.execute({ pairId: PairId(request.params.id), managerId: manager.id });
      return await toPairDto(deps, pair);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
