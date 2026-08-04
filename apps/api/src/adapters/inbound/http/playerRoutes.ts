import { FastifyInstance } from 'fastify';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player, SkillCluster, Surface, TrainingFocus } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';

/** Thin serialization only — no domain rules here. */
function toPlayerDto(player: Player) {
  const { technical, physical, mental, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    nationality: player.nationality,
    managerId: player.managerId,
    ageInWeeks: player.ageInWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
    currentFocus: player.currentFocus,
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
  nationality: string;
  managerId: string;
  startingAgeInWeeks: number;
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
  app.post<{ Body: HirePlayerBody }>(
    '/players',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playerId', 'name', 'nationality', 'managerId', 'startingAgeInWeeks'],
          properties: {
            playerId: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            nationality: { type: 'string', minLength: 1 },
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
        nationality: request.body.nationality,
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

  // Records the player's standing weekly training focus — does not
  // apply any attribute delta itself (see SetTrainingFocusUseCase).
  app.put<{ Params: { id: string }; Body: TrainingFocusBody }>(
    '/players/:id/training-focus',
    { schema: { body: { type: 'object', required: ['focus'], properties: { focus: trainingFocusSchema } } } },
    async (request, reply) => {
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
  app.get<{ Params: { id: string } }>('/managers/:id/players', async (request) => {
    const roster = await deps.players.findByManager(ManagerId(request.params.id));
    return roster.map(toPlayerDto);
  });

  // The dashboard-shaped read model: rank, overall, fatigue, last
  // result, training focus, nationality, surfaces — everything the
  // Roster Dashboard screen needs in one call. See
  // DrizzleRosterDashboardQuery for why this bypasses the Player
  // aggregate (a pure read-side projection across players +
  // tournament_matches + player_rankings).
  app.get<{ Params: { id: string } }>('/managers/:id/roster-dashboard', async (request) => {
    return deps.rosterDashboard.forManager(ManagerId(request.params.id));
  });

  // Lets the frontend know whether a manager is on Manager Pro (4 roster
  // slots) or the free tier (2), without exposing any other billing
  // detail — just the one bit of entitlement state the roster screen
  // needs to render its slot indicator and upsell copy correctly.
  app.get<{ Params: { id: string } }>('/managers/:id/entitlement', async (request) => {
    const managerId = ManagerId(request.params.id);
    const isPro = await deps.billing.isProSubscriber(managerId);
    return { managerId, tier: isPro ? 'pro' : 'free' };
  });
}
