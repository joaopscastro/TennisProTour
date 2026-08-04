import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '../shared/ids';
import { Player, PlayerLifecycleStage } from './Player';
import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { AcceleratedDeclinePolicy, AgingPolicy, PlayerAgingService, StandardAgingPolicy, weeksUntilNextStage } from './PlayerAgingService';

describe('AcceleratedDeclinePolicy', () => {
  const base: AgingPolicy = {
    weeklyDeclineDelta: (stage) => (stage === 'decline' ? -2 : 0),
    stageForAge: (ageInWeeks) => (ageInWeeks >= 100 ? 'decline' : 'prime'),
    retirementAgeInWeeks: () => 200,
  };

  it('multiplies the decline delta but leaves stage thresholds untouched', () => {
    const accelerated = new AcceleratedDeclinePolicy(base, 1.5);

    expect(accelerated.weeklyDeclineDelta('decline')).toBe(-3);
    expect(accelerated.weeklyDeclineDelta('prime')).toBe(0);
    expect(accelerated.stageForAge(99)).toBe('prime');
    expect(accelerated.stageForAge(100)).toBe('decline');
    expect(accelerated.retirementAgeInWeeks()).toBe(200);
  });

  it('refuses a multiplier below 1 (the tradeoff must be a cost, never a buff)', () => {
    expect(() => new AcceleratedDeclinePolicy(base, 0.5)).toThrow();
  });
});

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: {
      serve: Skill.of(30),
      forehand: Skill.of(30),
      backhand: Skill.of(30),
      volley: Skill.of(30),
    },
    physical: {
      speed: Skill.of(30),
      stamina: Skill.of(30),
      strength: Skill.of(30),
    },
    mental: {
      consistency: Skill.of(30),
      clutch: Skill.of(30),
    },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function playerAged(ageInWeeks: number): Player {
  return Player.hire(PlayerId('p1'), 'João Silva', ageInWeeks, startingAttributes(), ManagerId('m1'));
}

describe('StandardAgingPolicy', () => {
  const policy = new StandardAgingPolicy();

  it('places ages below 20 years in youth', () => {
    expect(policy.stageForAge(20 * 52 - 1)).toBe('youth');
  });

  it('places ages from 20 up to (not including) 30 years in prime', () => {
    expect(policy.stageForAge(20 * 52)).toBe('prime');
    expect(policy.stageForAge(30 * 52 - 1)).toBe('prime');
  });

  it('places ages from 30 up to (not including) 38 years in decline', () => {
    expect(policy.stageForAge(30 * 52)).toBe('decline');
    expect(policy.stageForAge(38 * 52 - 1)).toBe('decline');
  });

  it('retires players at 38 years', () => {
    expect(policy.stageForAge(38 * 52)).toBe('retired');
    expect(policy.retirementAgeInWeeks()).toBe(38 * 52);
  });

  it('only declines attributes in the decline stage, not retired', () => {
    expect(policy.weeklyDeclineDelta('youth')).toBe(0);
    expect(policy.weeklyDeclineDelta('prime')).toBe(0);
    expect(policy.weeklyDeclineDelta('decline')).toBeLessThan(0);
    expect(policy.weeklyDeclineDelta('retired')).toBe(0);
  });
});

describe('PlayerAgingService', () => {
  it('advances age by exactly one week and updates stage via the policy', () => {
    const service = new PlayerAgingService(new StandardAgingPolicy());
    const player = playerAged(20 * 52 - 1);

    service.advance(player);

    expect(player.ageInWeeks).toBe(20 * 52);
    expect(player.stage).toBe('prime');
  });

  it('applies whatever decline delta the injected policy returns (OCP: no PlayerAgingService change needed for a different curve)', () => {
    const bigDeclinePolicy: AgingPolicy = {
      weeklyDeclineDelta: (stage) => (stage === 'decline' ? -5 : 0),
      stageForAge: () => 'decline' as PlayerLifecycleStage,
      retirementAgeInWeeks: () => Number.MAX_SAFE_INTEGER,
    };
    const service = new PlayerAgingService(bigDeclinePolicy);
    const player = playerAged(0);

    service.advance(player);

    expect(player.stage).toBe('decline');
    expect(player.attributes.technical.serve.value).toBe(25);
    expect(player.attributes.physical.speed.value).toBe(25);
    expect(player.attributes.mental.clutch.value).toBe(25);
  });

  it('does not decline attributes once retired', () => {
    const alwaysRetiredPolicy: AgingPolicy = {
      weeklyDeclineDelta: (stage) => (stage === 'decline' ? -5 : 0),
      stageForAge: () => 'retired' as PlayerLifecycleStage,
      retirementAgeInWeeks: () => 0,
    };
    const service = new PlayerAgingService(alwaysRetiredPolicy);
    const player = playerAged(0);
    const before = player.attributes.technical.serve.value;

    service.advance(player);

    expect(player.stage).toBe('retired');
    expect(player.attributes.technical.serve.value).toBe(before);
  });

  /**
   * This documents a real finding, not a workaround: StandardAgingPolicy's
   * actual -0.05/week decline delta is invisible forever against Skill's
   * Math.round-based clamping, because Skill.add() rounds from its own
   * already-rounded current value on every call (30 + -0.05 = 29.95, which
   * always rounds back to 30, no matter how many weeks pass). Verified
   * empirically before writing this test. Flagging rather than silently
   * "fixing" it, since StandardAgingPolicy was supplied verbatim.
   */
  it('demonstrates that StandardAgingPolicy\'s -0.05/week delta never actually moves an integer Skill value', () => {
    const service = new PlayerAgingService(new StandardAgingPolicy());
    const player = playerAged(30 * 52 - 1); // about to enter 'decline'
    const before = player.attributes.technical.serve.value;

    for (let week = 0; week < 50; week++) {
      service.advance(player);
    }

    expect(player.stage).toBe('decline');
    expect(player.attributes.technical.serve.value).toBe(before);
  });
});

describe('weeksUntilNextStage', () => {
  const policy = new StandardAgingPolicy();

  it('returns null for a retired player — there is no next stage', () => {
    expect(weeksUntilNextStage(38 * 52, 'retired', policy)).toBeNull();
  });

  it('returns exact weeks remaining to prime, decline, and retirement respectively', () => {
    expect(weeksUntilNextStage(20 * 52 - 10, 'youth', policy)).toBe(10);
    expect(weeksUntilNextStage(30 * 52 - 3, 'prime', policy)).toBe(3);
    expect(weeksUntilNextStage(38 * 52 - 1, 'decline', policy)).toBe(1);
  });

  it('returns 0 exactly on the threshold week (already transitioning)', () => {
    expect(weeksUntilNextStage(20 * 52, 'youth', policy)).toBe(0);
  });

  it('works against any AgingPolicy, not just StandardAgingPolicy (e.g. AcceleratedDeclinePolicy, which leaves thresholds untouched)', () => {
    const proPolicy = new AcceleratedDeclinePolicy(policy, 1.5);
    // Thresholds are untouched by the decline multiplier, so this must
    // match the base policy exactly.
    expect(weeksUntilNextStage(20 * 52 - 10, 'youth', proPolicy)).toBe(10);
  });
});
