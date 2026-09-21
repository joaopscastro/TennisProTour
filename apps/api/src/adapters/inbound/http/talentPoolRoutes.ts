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

/**
 * The talent pool: hiring is no longer instant/on-demand. As of the
 * candidate/player unification (see docs/CLAUDE.md), a free agent is a
 * real Player with no manager (managerId: null) that lives in the world
 * for its whole career whether or not anyone ever signs it — it never
 * expires or vanishes. A manager browses the current free agents and
 * signs a specific one (transferring ownership), which costs XP.
 */
export function registerTalentPoolRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/talent-pool', async () => {
    const freeAgents = await deps.players.findFreeAgents();
    const playerIds = freeAgents.map((player) => player.id);
    // Three batch reads for the whole pool (not one per free agent): who
    // is currently competing, who is blocked from signing by an
    // unfinished tournament commitment, and how many titles each has won.
    const [liveTournaments, commitments, titleCounts] = await Promise.all([
      deps.playerMatches.liveTournamentByPlayer(playerIds),
      deps.playerMatches.unfinishedCommitmentByPlayer(playerIds),
      deps.titles.countByPlayers(playerIds),
    ]);
    return freeAgents.map((player) =>
      toFreeAgentDto(
        player,
        deps.talentClaimPricingPolicy,
        liveTournaments.get(player.id) ?? null,
        titleCounts.get(player.id) ?? 0,
        commitments.get(player.id) ?? null,
      ),
    );
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
