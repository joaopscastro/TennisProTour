import { FastifyInstance } from 'fastify';
import { PlayerId } from '@tennis-manager/domain';
import { Surface, TrainableAttribute, TrainingFocus } from '@tennis-manager/domain';
import { maxCoachCountFor } from '@tennis-manager/application';
import { Dependencies, WORLD_ID } from '../../../composition';
import { toPlayerDto } from './playerDto';
import { toTournamentDto } from './tournamentRoutes';
import { requireManager, ownershipMismatch } from './auth';

interface CreateCustomPlayerBody {
  managerId: string;
  name: string;
  nationality: string;
}

interface TrainingFocusBody {
  /** null clears the standing focus. */
  focus: { kind: 'surface'; surface: Surface } | { kind: 'attribute'; attribute: TrainableAttribute } | null;
  /** Omitted = "starting right now" (the world's current week) — the
   * roster dashboard's quick "Set focus" action never sends this.
   * An explicit week is what the player profile's Schedule view (Step
   * 2) uses to commit a focus change for a specific future week. */
  week?: { season: number; week: number };
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
      required: ['kind', 'attribute'],
      properties: {
        kind: { const: 'attribute' },
        // Mental attributes ('consistency'/'clutch') deliberately absent
        // — not just at the TypeScript level (TrainableAttribute), but
        // here too, so a request that tries to target one is rejected
        // by schema validation before it ever reaches the use case.
        attribute: { type: 'string', enum: ['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength'] },
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

  // The single composed read the profile page needs: avatar identity,
  // current + peak rankings across all three bands, full tournament
  // history, and the trophy list — one request, not five. See
  // DrizzlePlayerProfileQuery's own doc comment.
  app.get<{ Params: { id: string } }>('/players/:id/profile', async (request, reply) => {
    const profile = await deps.playerProfile.forPlayer(PlayerId(request.params.id));
    if (!profile) {
      return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    }
    return profile;
  });

  // The profile page's "latest results + next match" strip — decided
  // matches (newest first) plus the player's next not-yet-simulated
  // match, if any. Public like /profile (any player, incl. free agents).
  // Deliberately carries NO per-match countdown (see
  // DrizzlePlayerMatchesQuery's doc comment).
  app.get<{ Params: { id: string } }>('/players/:id/current-matches', async (request) => {
    return deps.playerMatches.forPlayer(PlayerId(request.params.id));
  });

  // Records one explicit training-schedule entry — does not apply any
  // attribute delta itself (see SetTrainingScheduleUseCase). `week`
  // omitted means "starting right now"; an explicit week schedules a
  // future standing-order change without touching earlier weeks (see
  // TrainingSchedule.ts's resolveTrainingFocusForWeek).
  app.put<{ Params: { id: string }; Body: TrainingFocusBody }>(
    '/players/:id/training-focus',
    {
      schema: {
        body: {
          type: 'object',
          required: ['focus'],
          properties: {
            focus: trainingFocusSchema,
            week: {
              type: 'object',
              required: ['season', 'week'],
              properties: { season: { type: 'integer', minimum: 1 }, week: { type: 'integer', minimum: 1, maximum: 52 } },
              additionalProperties: false,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const existing = await deps.players.findById(PlayerId(request.params.id));
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      if (!existing || existing.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found' });
      const entry = await deps.setTrainingSchedule.execute({
        playerId: PlayerId(request.params.id),
        focus: (request.body.focus as TrainingFocus | null) ?? null,
        effectiveFrom: request.body.week,
      });
      return entry;
    },
  );

  // The training-schedule mirror of the entry-planner route below —
  // same window (weeksAhead defaults to DEFAULT_PLANNER_WEEKS), each
  // week's resolved effective focus plus whether that week has its
  // own explicit entry (see PlayerTrainingScheduleQuery).
  app.get<{ Params: { id: string }; Querystring: { weeks?: string } }>('/players/:id/training-schedule', async (request, reply) => {
    const player = await deps.players.findById(PlayerId(request.params.id));
    if (!player) {
      return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    }
    let weeksAhead: number | undefined;
    if (request.query.weeks !== undefined) {
      weeksAhead = Number(request.query.weeks);
      if (!Number.isInteger(weeksAhead) || weeksAhead < 1 || weeksAhead > 52) {
        return reply.code(400).send({ error: '?weeks must be an integer between 1 and 52' });
      }
    }
    return deps.trainingScheduleQuery.forPlayer(WORLD_ID, player.id, weeksAhead);
  });

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

  // Read-only preview for the "convert to coach" confirmation step —
  // computed from the exact same CoachConversionPolicy instance
  // ConvertPlayerToCoachUseCase itself uses (see composition.ts), so
  // the number a manager confirms against is never a second,
  // possibly-drifted estimate. Doesn't spend XP or touch the roster;
  // only the POST below does that.
  app.get<{ Params: { id: string } }>('/players/:id/coach-conversion-preview', async (request, reply) => {
    const player = await deps.players.findById(PlayerId(request.params.id));
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (!player || player.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found' });

    const overallRating = player.attributes.overallRating();
    const ageInWeeks = player.ageInWeeks;
    const [existingCoaches, maxCoaches, xpBalance] = await Promise.all([
      deps.coaches.findByManager(manager.id),
      maxCoachCountFor(manager.id, deps.billing),
      deps.managerXp.balanceFor(manager.id),
    ]);

    return {
      xpCost: deps.coachConversionPolicy.conversionCostFor(overallRating, ageInWeeks),
      coachRating: deps.coachConversionPolicy.coachRatingFor(overallRating, ageInWeeks),
      xpBalance,
      coachCount: existingCoaches.length,
      coachCap: maxCoaches,
      atCap: existingCoaches.length >= maxCoaches,
    };
  });

  // Executes the conversion — permanent, see ConvertPlayerToCoachUseCase's
  // doc comment. The frontend is expected to have shown the preview
  // above and required an explicit confirmation before ever calling
  // this (docs/ui-direction.md's "consequential action" convention,
  // same as Release).
  app.post<{ Params: { id: string } }>('/players/:id/convert-to-coach', async (request, reply) => {
    const existing = await deps.players.findById(PlayerId(request.params.id));
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (!existing || existing.managerId !== manager.id) return reply.code(404).send({ error: 'Player not found' });
    try {
      const coach = await deps.convertPlayerToCoach.execute({ playerId: PlayerId(request.params.id), managerId: manager.id });
      return reply.code(201).send({ id: coach.id, coachRating: coach.coachRating, sourcePlayerName: coach.sourcePlayerName });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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

  // The multi-week planner read: this player's tournament entries (or
  // explicit lack thereof) across the next several upcoming GameWeeks,
  // in ONE response — what a frontend planner UI needs to show several
  // weeks at a glance without firing one request per week. ?weeks=
  // overrides the default span (DEFAULT_PLANNER_WEEKS); a caller can't
  // ask for zero or a negative span, or an unbounded one.
  app.get<{ Params: { id: string }; Querystring: { weeks?: string } }>('/players/:id/entry-planner', async (request, reply) => {
    const player = await deps.players.findById(PlayerId(request.params.id));
    if (!player) {
      return reply.code(404).send({ error: `Player ${request.params.id} not found` });
    }
    let weeksAhead: number | undefined;
    if (request.query.weeks !== undefined) {
      weeksAhead = Number(request.query.weeks);
      if (!Number.isInteger(weeksAhead) || weeksAhead < 1 || weeksAhead > 52) {
        return reply.code(400).send({ error: '?weeks must be an integer between 1 and 52' });
      }
    }
    const planner = await deps.entryPlanner.forPlayer(WORLD_ID, player.id, weeksAhead);
    return planner.map(({ week, entries }) => ({
      week,
      entries: entries.map((t) => toTournamentDto(t)),
    }));
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
  // custom player" credit count correctly. xpBalance rides along here
  // (not a separate endpoint) since every screen that needs it already
  // calls fetchEntitlement — the sidebar's persistent XP display reuses
  // this one call rather than adding a second fetch everywhere.
  app.get<{ Params: { id: string } }>('/managers/:id/entitlement', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    if (ownershipMismatch(request.params.id, manager)) return reply.code(404).send({ error: 'Manager not found' });
    const managerId = manager.id;
    const [isPro, customPlayerCredits, xpBalance] = await Promise.all([
      deps.billing.isProSubscriber(managerId),
      deps.billing.customPlayerCreditBalance(managerId),
      deps.managerXp.balanceFor(managerId),
    ]);
    return { managerId, tier: isPro ? 'pro' : 'free', customPlayerCredits, xpBalance };
  });

  app.get('/me/entitlement', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const [isPro, customPlayerCredits, xpBalance] = await Promise.all([
      deps.billing.isProSubscriber(manager.id),
      deps.billing.customPlayerCreditBalance(manager.id),
      deps.managerXp.balanceFor(manager.id),
    ]);
    return { managerId: manager.id, tier: isPro ? 'pro' : 'free', customPlayerCredits, xpBalance };
  });
}
