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
});
