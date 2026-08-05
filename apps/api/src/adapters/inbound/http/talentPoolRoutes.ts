import { FastifyInstance } from 'fastify';
import { ManagerId, TalentPoolCandidateId } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { toPlayerDto } from './playerDto';

/**
 * Thin serialization only — no domain rules here — EXCEPT for one
 * deliberate omission: `candidate.potentialCeiling` is never read
 * here. Current attributes/OVR are exposed fairly precisely (real
 * numbers, not fuzzed) because those are meant to be "observable" —
 * what a manager can actually see about a player right now. Potential
 * is different: only the coarse, already-noisy `potentialTier` goes
 * out, never the real hidden ceiling behind it. If you're extending
 * this DTO, do not add a ceiling/potential number field here — that
 * would defeat the entire scouting mechanic (see
 * PlayerGenerationPolicy.GeneratedPlayer.potentialTier's doc comment).
 */
function toTalentPoolCandidateDto(candidate: import('@tennis-manager/domain').TalentPoolCandidate) {
  const { technical, physical, mental, surfaceAffinities } = candidate.attributes;
  return {
    id: candidate.id,
    name: candidate.name,
    nationality: candidate.nationality,
    tier: candidate.tier,
    potentialTier: candidate.potentialTier,
    generatedAtWeek: candidate.generatedAtWeek,
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
 * The talent pool: hiring is no longer instant/on-demand
 * ("Hire player" -> immediate custom player). A manager browses
 * whoever the weekly refresh (RefreshTalentPoolUseCase) generated and
 * claims a specific still-available one — see docs/CLAUDE.md's
 * "hiring is pool-based and scarce" note for why this replaced the
 * earlier direct-hire flow.
 */
export function registerTalentPoolRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/talent-pool', async () => {
    const available = await deps.talentPoolCandidates.findAvailable();
    return available.map(toTalentPoolCandidateDto);
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
      const player = await deps.claimTalentPoolCandidate.execute({
        candidateId: TalentPoolCandidateId(request.params.id),
        managerId: ManagerId(request.body.managerId),
      });
      return reply.code(201).send(toPlayerDto(player));
    },
  );
}
