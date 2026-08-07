import { describe, expect, it } from 'vitest';
import { GameWeek, ManagerId, TalentPoolCandidateId } from '../shared/ids';
import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { GeneratedPlayer } from './PlayerGenerationPolicy';
import { TalentPoolCandidate, TALENT_POOL_EXPIRY_WEEKS } from './TalentPoolCandidate';

function generatedPlayer(): GeneratedPlayer {
  return {
    name: 'Marta Silva',
    nationality: 'BR',
    tier: 'common',
    ageInWeeks: 750,
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
      physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
      mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
      surfaceAffinities: SurfaceAffinities.initial(),
    }),
    potentialCeiling: 65,
    potentialTier: 'promising',
    physicalCeilings: { speed: 55, stamina: 55, strength: 55 },
  };
}

describe('TalentPoolCandidate', () => {
  it('starts available with no claiming manager when generated', () => {
    const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId('c1'), generatedPlayer(), { season: 1, week: 1 });

    expect(candidate.status).toBe('available');
    expect(candidate.isAvailable()).toBe(true);
    expect(candidate.claimedByManagerId).toBeNull();
    expect(candidate.name).toBe('Marta Silva');
    expect(candidate.ageInWeeks).toBe(750);
  });

  it('markClaimed transitions to claimed and records the manager, but refuses a second claim', () => {
    const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId('c1'), generatedPlayer(), { season: 1, week: 1 });

    candidate.markClaimed(ManagerId('m1'));

    expect(candidate.status).toBe('claimed');
    expect(candidate.claimedByManagerId).toBe(ManagerId('m1'));
    expect(candidate.isAvailable()).toBe(false);
    expect(() => candidate.markClaimed(ManagerId('m2'))).toThrow(/not available/);
  });

  it('markExpired transitions an available candidate to expired, but is a no-op once already claimed', () => {
    const available = TalentPoolCandidate.generate(TalentPoolCandidateId('c1'), generatedPlayer(), { season: 1, week: 1 });
    available.markExpired();
    expect(available.status).toBe('expired');

    const claimed = TalentPoolCandidate.generate(TalentPoolCandidateId('c2'), generatedPlayer(), { season: 1, week: 1 });
    claimed.markClaimed(ManagerId('m1'));
    claimed.markExpired();
    expect(claimed.status).toBe('claimed'); // untouched, not silently overwritten
  });

  it(`isExpiredAsOf is false at exactly ${TALENT_POOL_EXPIRY_WEEKS} weeks old and true just past it`, () => {
    const generatedAtWeek: GameWeek = { season: 1, week: 1 };
    const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId('c1'), generatedPlayer(), generatedAtWeek);

    const exactlyAtLimit: GameWeek = { season: 1, week: 1 + TALENT_POOL_EXPIRY_WEEKS };
    const justPastLimit: GameWeek = { season: 1, week: 2 + TALENT_POOL_EXPIRY_WEEKS };

    expect(candidate.isExpiredAsOf(generatedAtWeek)).toBe(false); // brand new
    expect(candidate.isExpiredAsOf(exactlyAtLimit)).toBe(false); // inclusive boundary
    expect(candidate.isExpiredAsOf(justPastLimit)).toBe(true);
  });
});
