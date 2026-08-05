import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '../shared/ids';
import { Player } from './Player';
import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { TrainingFocus, TrainingPolicy } from './TrainingPolicy';

/** Fixed, deterministic stand-in for StandardTrainingPolicy — Player's
 * own tests only need to verify it delegates and applies correctly,
 * not exercise real balance numbers (that's TrainingPolicy.test.ts). */
class FixedTrainingPolicy implements TrainingPolicy {
  constructor(private readonly delta: number) {}

  computeDelta(): number {
    return this.delta;
  }
}

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

describe('Player', () => {
  it('hires a player in the youth stage with no fatigue and emits PlayerHired', () => {
    const managerId = ManagerId('m1');
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), managerId);

    expect(player.stage).toBe('youth');
    expect(player.fatigue).toBe(0);
    expect(player.managerId).toBe(managerId);
    expect(player.isRetired()).toBe(false);

    const events = player.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PlayerHired',
      payload: { playerId: player.id, managerId },
    });
    expect(events[0].occurredAt).toBeInstanceOf(Date);
  });

  it('pullDomainEvents drains events so a second call returns nothing', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.pullDomainEvents();
    expect(player.pullDomainEvents()).toHaveLength(0);
  });

  it('clamps match fatigue to [0, 100]', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.applyMatchFatigue(150);
    expect(player.fatigue).toBe(100);

    player.recoverFatigue(1000);
    expect(player.fatigue).toBe(0);
  });

  it('applies surface training by delegating the delta to the injected policy', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.surfaceAffinities.get('clay')).toBe(25); // 20 starting + 5
    expect(player.attributes.surfaceAffinities.get('grass')).toBe(20); // untouched
  });

  it('applies skill-cluster training by delegating the delta to the injected policy', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const focus: TrainingFocus = { kind: 'skill', cluster: 'physical' };

    player.applyTraining(focus, new FixedTrainingPolicy(4));

    expect(player.attributes.physical.speed.value).toBe(34); // 30 starting + 4
    expect(player.attributes.technical.serve.value).toBe(30); // untouched
  });

  it('gates skill-cluster training by the hidden potentialCeiling: full delta far below it, tapering as the cluster average approaches it', () => {
    // Starting cluster average is 30; ceiling 40 means only 10 points
    // of headroom, inside the 15-point taper range from the start.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 40);
    const focus: TrainingFocus = { kind: 'skill', cluster: 'technical' };

    player.applyTraining(focus, new FixedTrainingPolicy(3));

    // headroom 10/15 of the taper range -> factor 10/15, delta = 3 * 10/15 = 2.
    expect(player.attributes.technical.serve.value).toBe(32); // 30 + 2, not 30 + 3
  });

  it('lets skill-cluster training taper all the way to zero once the cluster average reaches its ceiling', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 30);
    const focus: TrainingFocus = { kind: 'skill', cluster: 'mental' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.mental.clutch.value).toBe(30); // already AT the ceiling — no growth at all
  });

  it('does NOT gate surface-affinity training by potentialCeiling, even with a very low ceiling', () => {
    // A ceiling of 25 sits below the starting surface affinity (20) by
    // only 5 — if surface training were gated the same way skill
    // training is, this would taper hard. It should train at full rate
    // regardless, since potentialCeiling only governs skill clusters.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 25);
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.surfaceAffinities.get('clay')).toBe(25); // full, ungated delta: 20 + 5
  });

  it('defaults potentialCeiling to 100 (no meaningful ceiling) when not explicitly provided, so pre-existing call sites train at full rate', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    expect(player.potentialCeiling).toBe(100);
  });

  it('throws when training a retired player', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52, startingAttributes(), ManagerId('m1'));
    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());

    expect(() => player.applyTraining({ kind: 'surface', surface: 'clay' }, new FixedTrainingPolicy(5))).toThrow();
  });

  it('advanceWeek updates age, stage, and attributes', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 100, startingAttributes(), ManagerId('m1'));
    const nextAttributes = startingAttributes();

    player.advanceWeek(101, 'youth', nextAttributes);

    expect(player.ageInWeeks).toBe(101);
    expect(player.stage).toBe('youth');
    expect(player.attributes).toBe(nextAttributes);
  });

  it('emits PlayerRetired exactly on the transition into retired, not on every advance while already retired', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52 - 1, startingAttributes(), ManagerId('m1'));

    player.advanceWeek(38 * 52, 'retired', startingAttributes());
    player.pullDomainEvents(); // drain PlayerHired + PlayerRetired from this call

    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());
    const eventsAfterSecondAdvance = player.pullDomainEvents();

    expect(eventsAfterSecondAdvance).toHaveLength(0);
  });

  it('releaseFromManager sets managerId to null', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.releaseFromManager();

    expect(player.managerId).toBeNull();
  });

  it('hires with no standing training focus and an optional nationality', () => {
    const withNationality = Player.hire(
      PlayerId('p1'),
      'João Silva',
      18 * 52,
      startingAttributes(),
      ManagerId('m1'),
      'BR',
    );
    const withoutNationality = Player.hire(PlayerId('p2'), 'Jane Doe', 18 * 52, startingAttributes(), ManagerId('m1'));

    expect(withNationality.nationality).toBe('BR');
    expect(withNationality.currentFocus).toBeNull();
    expect(withoutNationality.nationality).toBe('XX');
  });

  it('setTrainingFocus records the standing focus without applying any attribute delta', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const focus: TrainingFocus = { kind: 'surface', surface: 'grass' };

    player.setTrainingFocus(focus);

    expect(player.currentFocus).toEqual(focus);
    expect(player.attributes.surfaceAffinities.get('grass')).toBe(20); // unchanged

    player.setTrainingFocus(null);
    expect(player.currentFocus).toBeNull();
  });

  it('throws when setting a training focus on a retired player', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52, startingAttributes(), ManagerId('m1'));
    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());

    expect(() => player.setTrainingFocus({ kind: 'surface', surface: 'clay' })).toThrow(
      /Cannot set training focus for retired player/,
    );
  });
});
