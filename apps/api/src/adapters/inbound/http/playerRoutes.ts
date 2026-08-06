import { FastifyInstance } from 'fastify';
import { PlayerId } from '@tennis-manager/domain';
import { SkillCluster, Surface, TrainingFocus } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { toPlayerDto } from './playerDto';
import { requireManager, ownershipMismatch } from './auth';

interface CreateCustomPlayerBody {
  managerId: string;
  name: string;
  nationality: string;
}

interface TrainingFocusBody {
  /** null clears the standing focus. */
  focus: { kind: 'surface'; surface: Surface } | { kind: 'skill'; cluster: SkillCluster } | null;
}

const trainingFocusSchema = {
  type: ['object', 'null'],
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'surface'],
      properties: {
        kind: { const: 'surface' },
        surface: { type: 'string', enum: ['clay', 'grass', 'hard', 'indoor'] },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'cluster'],
      properties: {
        kind: { const: 'skill' },
        cluster: { type: 'string', enum: ['technical', 'physical', 'mental'] },
      },
      additionalProperties: false,
    },
  ],
} as const;

export function registerPlayerRoutes(app: FastifyInstance, deps: Dependencies): void {
  // Pro-only, credit-gated: bypasses the talent pool entirely (choose
  // your own name/nationality instead of claiming a generated
  // candidate) but NOT the same generation policy — see
  // CreateCustomPlayerUseCase's doc comment on why that's a hard
  // fairness constraint, not a simplification. The id is minted here
  // (never client-supplied) via the same IdGeneratorPort the talent
  // pool's own candidates use.
  app.post<{ Body: CreateCustomPlayerBody }>(
    '/players/custom',
    {
      schema: {
        body: {
          type: 'object',
          required: ['managerId', 'name', 'nationality'],
          properties: {
            managerId: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            nationality: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      const player = await deps.createCustomPlayer.execute({
        playerId: PlayerId(deps.idGenerator.generate()),
        managerId: manager.id,
        name: request.body.name,
        nationality: request.body.nationality,
      });
      return reply.code(201).send(toPlayerDto(player));
    },
  );

  app.get<{ Params: { id: string } }>('/players/:id', async (request, reply) => {
    const player = await deps.players.findById(PlayerId(request.params.id));
    if (!player) {
      return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    }
    return toPlayerDto(player);
  });

  // Records the player's standing weekly training focus — does not
  // apply any attribute delta itself (see SetTrainingFocusUseCase).
  app.put<{ Params: { id: string }; Body: TrainingFocusBody }>(
    '/players/:id/training-focus',
    { schema: { body: { type: 'object', required: ['focus'], properties: { focus: trainingFocusSchema } } } },
    async (request, reply) => {
      const existing = await deps.players.findById(PlayerId(request.params.id));
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      if (!existing || existing.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found' });
      await deps.setTrainingFocus.execute({
        playerId: PlayerId(request.params.id),
        focus: (request.body.focus as TrainingFocus | null) ?? null,
      });
      const player = await deps.players.findById(PlayerId(request.params.id));
      if (!player) return reply.code(404).send({ error: `Player ${request.params.id} not found` });
      return toPlayerDto(player);
    },
  );

  // Releases a player from their manager (frees the roster slot).
  // Deliberately a drill-in action, not a one-click roster-row button
    // — see docs/ui-direction.md.
  app.post<{ Params: { id: string } }>('/players/:id/release', async (request, reply) => {
    const existing = await deps.players.findById(PlayerId(request.params.id));
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (!existing || existing.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found' });
    await deps.releasePlayer.execute({ playerId: PlayerId(request.params.id) });
    const player = await deps.players.findById(PlayerId(request.params.id));
    if (!player) return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    return toPlayerDto(player);
  });

  // A player's rank is their 1-indexed position among every player
  // who has ever earned a ranking-ledger entry, sorted by their
  // currently-computed rolling total descending — null means unranked
  // (never earned a point), not rank 0. See RankPositionQuery.
  app.get<{ Params: { id: string } }>('/players/:id/ranking', async (request) => {
    const playerId = PlayerId(request.params.id);
    const { totalPoints, rank } = await deps.rankPosition.rankFor(playerId);
    return { playerId, totalPoints, rank };
  });

  // Roster read for the dashboard. An empty roster is a 200 with [],
  // not a 404 — a manager with no players is a normal state.
  app.get<{ Params: { id: string } }>('/managers/:id/players', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (ownershipMismatch(request.params.id, manager)) return reply.code(404).send({ error: 'Manager not found' });
    const roster = await deps.players.findByManager(manager.id);
    return roster.map(toPlayerDto);
  });

  app.get('/me/players', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const roster = await deps.players.findByManager(manager.id);
    return roster.map(toPlayerDto);
  });

  // The dashboard-shaped read model: rank, overall, fatigue, last
  // result, training focus, nationality, surfaces — everything the
  // Roster Dashboard screen needs in one call. See
  // DrizzleRosterDashboardQuery for why this bypasses the Player
  // aggregate (a pure read-side projection across players +
  // tournament_matches + player_rankings).
  app.get<{ Params: { id: string } }>('/managers/:id/roster-dashboard', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (ownershipMismatch(request.params.id, manager)) return reply.code(404).send({ error: 'Manager not found' });
    return deps.rosterDashboard.forManager(manager.id);
  });

  app.get('/me/roster-dashboard', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    return deps.rosterDashboard.forManager(manager.id);
  });

  // Lets the frontend know whether a manager is on Manager Pro (4 roster
  // slots) or the free tier (2), without exposing any other billing
  // detail — just the bits of entitlement state the roster screen
  // needs to render its slot indicator, upsell copy, and "Create
  // custom player" credit count correctly.
  app.get<{ Params: { id: string } }>('/managers/:id/entitlement', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (ownershipMismatch(request.params.id, manager)) return reply.code(404).send({ error: 'Manager not found' });
    const managerId = manager.id;
    const [isPro, customPlayerCredits] = await Promise.all([
      deps.billing.isProSubscriber(managerId),
      deps.billing.customPlayerCreditBalance(managerId),
    ]);
    return { managerId, tier: isPro ? 'pro' : 'free', customPlayerCredits };
  });

  app.get('/me/entitlement', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const [isPro, customPlayerCredits] = await Promise.all([
      deps.billing.isProSubscriber(manager.id),
      deps.billing.customPlayerCreditBalance(manager.id),
    ]);
    return { managerId: manager.id, tier: isPro ? 'pro' : 'free', customPlayerCredits };
  });
}
