import { FastifyInstance } from 'fastify';
import { Player, PlayerId, TalentClaimPricingPolicy } from '@tennis-manager/domain';
import { TALENT_POOL_AGE_RANGE } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';
import { toPlayerDto } from './playerDto';
import { requireManager } from './auth';

/**
 * Thin serialization only — no domain rules here — EXCEPT for one
 * deliberate omission that is now enforced server-side, not just in the
 * UI: neither the hidden `potentialCeiling`/`physicalCeilings` NOR the
 * coarse rarity `tier`/`potentialTier` reads are ever serialized here.
 * This is an RPG — a manager judges a free agent from its OBSERVABLE
 * current attributes/OVR (exposed precisely below), never from a
 * value-grade the game hands them. If you're extending this DTO, do not
 * add any rarity/potential/ceiling field — that would defeat the entire
 * scouting mechanic (see PlayerGenerationPolicy's doc comments).
 */
function toFreeAgentDto(
  player: Player,
  talentClaimPricingPolicy: TalentClaimPricingPolicy,
  currentTournament: { id: string; name: string } | null,
  titleCount: number,
  blockingCommitment: { id: string; name: string } | null,
) {
  const { technical, physical, mental, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    nationality: player.nationality,
    ageInWeeks: player.ageInWeeks,
    // The exact XP cost ClaimTalentPoolCandidateUseCase would charge if
    // this manager clicked Sign right now — computed from the same
    // TalentClaimPricingPolicy instance, the same overallRating()/
    // ageInWeeks inputs, and the same TALENT_POOL_AGE_RANGE the use
    // case itself reads, not a second guess.
    claimCost: talentClaimPricingPolicy.priceFor(player.attributes.overallRating(), player.ageInWeeks, TALENT_POOL_AGE_RANGE),
    // Observable career signals, so an established free agent reads as
    // established BEFORE signing rather than as a surprise afterwards
    // (the pool deliberately spans raw teenagers to match-hardened
    // veterans). Both are public on PlayerDto/profile already, so
    // exposing them here leaks no hidden potential/ceiling data.
    careerPrizeMoney: player.careerPrizeMoney,
    titleCount,
    // The tournament this free agent still has a match to play in, if
    // any — an informational "Competing" badge. null when they aren't
    // currently competing. See DrizzlePlayerMatchesQuery's
    // liveTournamentByPlayer.
    currentTournament,
    // The deliberate signing rule: a free agent committed to a tournament
    // that has not concluded can't be signed. `blockingCommitment` names
    // that tournament (null when signable) and `signingBlocked` is the
    // boolean the client acts on. Both come from the SAME predicate the
    // atomic claim enforces (see unfinishedCommitment.ts), so the
    // disabled-Sign state can never disagree with the server's refusal.
    signingBlocked: blockingCommitment !== null,
    blockingCommitment,
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

/** Default page size for the Scouting pool. Large enough that a bare
 * `GET /talent-pool` (no query) still feels like the old whole-pool read
 * for a small world, small enough that a demand-sized pool (~1,600 free
 * agents) is never serialized in one response. */
export const DEFAULT_TALENT_POOL_LIMIT = 64;
/** Upper bound on an explicit `limit` — a client can page, but never ask
 * the server to serialize the entire pool. */
export const MAX_TALENT_POOL_LIMIT = 256;

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * The talent pool: hiring is no longer instant/on-demand. As of the
 * candidate/player unification (see docs/CLAUDE.md), a free agent is a
 * real Player with no manager (managerId: null) that lives in the world
 * for its whole career whether or not anyone ever signs it — it never
 * expires or vanishes. A manager browses the current free agents and
 * signs a specific one (transferring ownership), which costs XP.
 *
 * PAGINATED (the pool is demand-sized to ~1,600 after P1-A1, so the old
 * unpaginated read was both a response-size and a DB-read problem):
 * `?limit=&offset=&signableOnly=` reads one page, `signableOnly=true`
 * applies the SAME unfinished-commitment predicate the atomic claim
 * enforces (server-side, via the repository's SQL filter), and the
 * response carries:
 *   - `candidates` — the page;
 *   - `total` — how many rows match the current filter (drives "Show
 *     more" and the filtered count);
 *   - `poolTotal` / `availableTotal` — the filter-independent totals, so
 *     the UI can say "N available of M free agents" without the client
 *     ever holding more than one page.
 */
export function registerTalentPoolRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get<{ Querystring: { limit?: string; offset?: string; signableOnly?: string } }>('/talent-pool', async (request) => {
    const limit = intParam(request.query.limit, DEFAULT_TALENT_POOL_LIMIT, 1, MAX_TALENT_POOL_LIMIT);
    const offset = intParam(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const signableOnly =
      request.query.signableOnly === 'true' || request.query.signableOnly === '1';

    const [counts, freeAgents] = await Promise.all([
      deps.players.countFreeAgents ? deps.players.countFreeAgents() : Promise.resolve(null),
      deps.players.findFreeAgents({ limit, offset, signableOnly }),
    ]);
    const playerIds = freeAgents.map((player) => player.id);
    // Three batch reads for the PAGE (not one per free agent): who
    // is currently competing, who is blocked from signing by an
    // unfinished tournament commitment, and how many titles each has won.
    const [liveTournaments, commitments, titleCounts] = await Promise.all([
      deps.playerMatches.liveTournamentByPlayer(playerIds),
      deps.playerMatches.unfinishedCommitmentByPlayer(playerIds),
      deps.titles.countByPlayers(playerIds),
    ]);
    const candidates = freeAgents.map((player) =>
      toFreeAgentDto(
        player,
        deps.talentClaimPricingPolicy,
        liveTournaments.get(player.id) ?? null,
        titleCounts.get(player.id) ?? 0,
        commitments.get(player.id) ?? null,
      ),
    );
    return {
      candidates,
      total: counts ? (signableOnly ? counts.signable : counts.total) : candidates.length,
      poolTotal: counts?.total ?? candidates.length,
      availableTotal: counts?.signable ?? (signableOnly ? candidates.length : candidates.filter((c) => !c.signingBlocked).length),
      limit,
      offset,
    };
  });

  app.post<{ Params: { id: string }; Body: { managerId: string } }>(
    '/talent-pool/:id/claim',
    {
      schema: {
        body: {
          type: 'object',
          required: ['managerId'],
          properties: { managerId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      const player = await deps.claimTalentPoolCandidate.execute({
        playerId: PlayerId(request.params.id),
        managerId: manager.id,
      });
      // Fire-and-forget (analytics never throws) — see AnalyticsPort.
      void deps.analytics.record({
        name: 'player_signed',
        managerId: manager.id,
        props: { playerId: player.id, method: 'pool' },
      });
      return reply.code(201).send(toPlayerDto(player));
    },
  );
}
