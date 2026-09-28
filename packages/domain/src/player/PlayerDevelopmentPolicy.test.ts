import { describe, it, expect } from 'vitest';
import { StandardPlayerDevelopmentPolicy } from './PlayerDevelopmentPolicy';

describe('StandardPlayerDevelopmentPolicy', () => {
  const policy = new StandardPlayerDevelopmentPolicy();

  describe('matchExperience', () => {
    it('teaches more from a competitive match than a blowout', () => {
      const blowoutLoser = policy.matchExperience({ loserGames: 0, isWinner: false });
      const warLoser = policy.matchExperience({ loserGames: 12, isWinner: false });
      expect(warLoser).toBeGreaterThan(blowoutLoser);
    });

    it('still awards a floor to the loser of a 6-0 6-0 blowout', () => {
      expect(policy.matchExperience({ loserGames: 0, isWinner: false })).toBeGreaterThan(0);
    });

    it('gives the winner a fixed fraction (~65%) of the loser XP from the same match', () => {
      const loserXp = policy.matchExperience({ loserGames: 12, isWinner: false });
      const winnerXp = policy.matchExperience({ loserGames: 12, isWinner: true });
      expect(winnerXp).toBeLessThan(loserXp);
      expect(winnerXp / loserXp).toBeGreaterThan(0.6);
      expect(winnerXp / loserXp).toBeLessThan(0.7);
    });

    it('scales with the loser games, not with who won', () => {
      const easyWinnerXp = policy.matchExperience({ loserGames: 1, isWinner: true });
      const hardWinnerXp = policy.matchExperience({ loserGames: 14, isWinner: true });
      expect(hardWinnerXp).toBeGreaterThan(easyWinnerXp);
    });

    it('clamps a nonsensical negative loserGames to the floor', () => {
      expect(policy.matchExperience({ loserGames: -5, isWinner: false })).toBe(
        policy.matchExperience({ loserGames: 0, isWinner: false }),
      );
    });

    it('is byte-identical for every pre-existing caller — context absent, {}, or juniorTier: false all give the old value (Batch 4B, F4)', () => {
      const cases = [
        { loserGames: 0, isWinner: false },
        { loserGames: 12, isWinner: false },
        { loserGames: 12, isWinner: true },
        { loserGames: 7, isWinner: true },
      ] as const;
      for (const c of cases) {
        const plain = policy.matchExperience(c);
        expect(policy.matchExperience({ ...c, context: {} })).toBe(plain);
        expect(policy.matchExperience({ ...c, context: { juniorTier: false } })).toBe(plain);
        // Hand-computed default path, so this pins the ACTUAL formula, not
        // just self-consistency: floor(4) + games × 3, ×0.65 for a winner.
        const expected =
          c.isWinner ? Math.round((4 + Math.max(0, c.loserGames) * 3) * 0.65) : 4 + Math.max(0, c.loserGames) * 3;
        expect(plain).toBe(expected);
      }
    });

    it('multiplies a junior-tier match by the placeholder ×1.5, for winner and loser alike — development XP only', () => {
      // The multiplier is applied to the RAW award and rounded ONCE (so a
      // junior 2.6 winner award becomes 4, not round(3 × 1.5) = 5) — which
      // is exactly why these are hand-computed expected values rather
      // than senior × 1.5 comparisons.
      const cases = [
        { loserGames: 0, isWinner: false, senior: 4, junior: 6 },
        { loserGames: 5, isWinner: false, senior: 19, junior: 29 },
        { loserGames: 12, isWinner: false, senior: 40, junior: 60 },
        { loserGames: 0, isWinner: true, senior: 3, junior: 4 },
        { loserGames: 5, isWinner: true, senior: 12, junior: 19 },
        { loserGames: 12, isWinner: true, senior: 26, junior: 39 },
      ] as const;
      for (const c of cases) {
        expect(policy.matchExperience({ loserGames: c.loserGames, isWinner: c.isWinner })).toBe(c.senior);
        const junior = policy.matchExperience({
          loserGames: c.loserGames,
          isWinner: c.isWinner,
          context: { juniorTier: true },
        });
        expect(junior).toBe(c.junior);
        expect(junior).toBeGreaterThan(c.senior);
      }
    });
  });

  describe('weeklyTalentIncome', () => {
    it('grows with talent', () => {
      expect(policy.weeklyTalentIncome(90)).toBeGreaterThan(policy.weeklyTalentIncome(30));
    });

    it('is never negative', () => {
      expect(policy.weeklyTalentIncome(0)).toBe(0);
      expect(policy.weeklyTalentIncome(-10)).toBe(0);
    });
  });

  describe('experienceCostPerSkillPoint', () => {
    it('is a positive cost', () => {
      expect(policy.experienceCostPerSkillPoint()).toBeGreaterThan(0);
    });
  });

  describe('constructor overrides', () => {
    // Same pattern as StatisticalMatchSimulator's pointProbabilityDivisor
    // override — exists so apps/api/scripts/balance-simulation.mjs can
    // compare candidate economy values against real simulation data
    // instead of editing the private constants between runs.
    it('uses the class defaults when no override is passed', () => {
      const defaultPolicy = new StandardPlayerDevelopmentPolicy();
      expect(defaultPolicy.weeklyTalentIncome(100)).toBe(policy.weeklyTalentIncome(100));
      expect(defaultPolicy.experienceCostPerSkillPoint()).toBe(policy.experienceCostPerSkillPoint());
    });

    it('applies an overridden weekly talent rate', () => {
      const overridden = new StandardPlayerDevelopmentPolicy(1.0);
      expect(overridden.weeklyTalentIncome(50)).toBe(50);
    });

    it('applies an overridden per-skill-point cost independently of the talent-rate override', () => {
      const overridden = new StandardPlayerDevelopmentPolicy(undefined, 5);
      expect(overridden.experienceCostPerSkillPoint()).toBe(5);
      expect(overridden.weeklyTalentIncome(100)).toBe(policy.weeklyTalentIncome(100));
    });
  });
});
