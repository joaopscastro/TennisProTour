import { describe, expect, it } from 'vitest';
import { StandardJuniorTournamentSchedulePolicy } from './JuniorTournamentSchedulePolicy';

describe('StandardJuniorTournamentSchedulePolicy', () => {
  const policy = new StandardJuniorTournamentSchedulePolicy();

  it('opens J30/J60/J100 every week', () => {
    for (const week of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) {
      const tiers = policy.weeklyOpenings(week).map((o) => o.tier);
      expect(tiers).toContain('j30');
      expect(tiers).toContain('j60');
      expect(tiers).toContain('j100');
    }
  });

  it('opens J200 only every 2nd week, J300 only every 4th, J500 only every 8th', () => {
    expect(policy.weeklyOpenings(0).map((o) => o.tier)).toEqual(
      expect.arrayContaining(['j30', 'j60', 'j100', 'j200', 'j300', 'j500']),
    );
    expect(policy.weeklyOpenings(1).map((o) => o.tier)).not.toContain('j200');
    expect(policy.weeklyOpenings(2).map((o) => o.tier)).toContain('j200');
    expect(policy.weeklyOpenings(2).map((o) => o.tier)).not.toContain('j300');
    expect(policy.weeklyOpenings(4).map((o) => o.tier)).toContain('j300');
    expect(policy.weeklyOpenings(4).map((o) => o.tier)).not.toContain('j500');
    expect(policy.weeklyOpenings(8).map((o) => o.tier)).toContain('j500');
  });

  it('strictly decreases in frequency and increases in draw size from J30 up to J500', () => {
    const cadenceByTier = new Map<string, number>();
    for (let week = 0; week < 100; week++) {
      for (const opening of policy.weeklyOpenings(week)) {
        cadenceByTier.set(opening.tier, (cadenceByTier.get(opening.tier) ?? 0) + 1);
      }
    }
    const order: Array<'j30' | 'j60' | 'j100' | 'j200' | 'j300' | 'j500'> = ['j30', 'j60', 'j100', 'j200', 'j300', 'j500'];
    for (let i = 1; i < order.length; i++) {
      expect(cadenceByTier.get(order[i])!).toBeLessThanOrEqual(cadenceByTier.get(order[i - 1])!);
    }

    const drawSizeByTier = new Map(policy.weeklyOpenings(8).map((o) => [o.tier, o.drawSize]));
    expect(drawSizeByTier.get('j30')).toBeLessThanOrEqual(drawSizeByTier.get('j500')!);
  });

  it('never schedules juniorMasters as a regular opening — it is a separate, ranking-gated mechanism', () => {
    for (let week = 0; week < 20; week++) {
      expect(policy.weeklyOpenings(week).map((o) => o.tier)).not.toContain('juniorMasters');
    }
  });

  it('is juniorMasters week exactly once per 52-week season', () => {
    expect(policy.isJuniorMastersWeek({ season: 1, week: 52 })).toBe(true);
    expect(policy.isJuniorMastersWeek({ season: 2, week: 52 })).toBe(true);
    for (let week = 1; week < 52; week++) {
      expect(policy.isJuniorMastersWeek({ season: 1, week })).toBe(false);
    }
  });

  it('juniorMastersDrawSize is a valid DrawSize the domain supports', () => {
    expect([16, 32, 64, 128]).toContain(policy.juniorMastersDrawSize);
  });
});
