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

  it('applies single-attribute training by delegating the delta to the injected policy, leaving every other attribute untouched', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'speed' };

    player.applyTraining(focus, new FixedTrainingPolicy(4));

    expect(player.attributes.physical.speed.value).toBe(34); // 30 starting + 4
    expect(player.attributes.physical.stamina.value).toBe(30); // untouched — NOT a whole-cluster bump
    expect(player.attributes.physical.strength.value).toBe(30); // untouched
    expect(player.attributes.technical.serve.value).toBe(30); // untouched
  });

  it('gates physical-attribute training by that attribute\'s OWN hidden ceiling: full delta far below it, tapering as it approaches', () => {
    // Starting speed is 30; a speed ceiling of 40 means only 10 points
    // of headroom, inside the 15-point taper range from the start.
    // stamina/strength ceilings are irrelevant here — each attribute
    // gates on its own entry only, not a shared number.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, {
      speed: 40,
      stamina: 100,
      strength: 100,
    });
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'speed' };

    player.applyTraining(focus, new FixedTrainingPolicy(3));

    // headroom 10/15 of the taper range -> factor 10/15, delta = 3 * 10/15 = 2.
    expect(player.attributes.physical.speed.value).toBe(32); // 30 + 2, not 30 + 3
  });

  it('lets physical-attribute training taper all the way to zero once the attribute reaches its own ceiling', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, {
      speed: 30,
      stamina: 100,
      strength: 100,
    });
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'speed' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.physical.speed.value).toBe(30); // already AT the ceiling — no growth at all
  });

  it('NEVER gates technical-attribute training by any ceiling — not physicalCeilings (doesn\'t apply), not the orphaned potentialCeiling either', () => {
    // Both potentialCeiling AND every physicalCeilings entry set far
    // below the starting value — if technical training read either of
    // them, this would taper hard or stop outright. It must train at
    // the full, ungated delta regardless.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 5, {
      speed: 5,
      stamina: 5,
      strength: 5,
    });
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'serve' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.technical.serve.value).toBe(35); // full, ungated delta: 30 + 5
  });

  it('does NOT gate surface-affinity training by any ceiling either, even with a very low potentialCeiling', () => {
    // A ceiling of 25 sits below the starting surface affinity (20) by
    // only 5 — if surface training were gated the same way physical
    // training is, this would taper hard. It should train at full rate
    // regardless, since no ceiling ever governs surface affinity.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 25);
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    player.applyTraining(focus, new FixedTrainingPolicy(5));

    expect(player.attributes.surfaceAffinities.get('clay')).toBe(25); // full, ungated delta: 20 + 5
  });

  it('boosts surface training when a coachRating is passed, defaulting to no boost when omitted', () => {
    const noCoach = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    noCoach.applyTraining({ kind: 'surface', surface: 'clay' }, new FixedTrainingPolicy(5));
    expect(noCoach.attributes.surfaceAffinities.get('clay')).toBe(25); // 20 + 5, no boost

    const withCoach = Player.hire(PlayerId('p2'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    withCoach.applyTraining({ kind: 'surface', surface: 'clay' }, new FixedTrainingPolicy(5), 80);
    expect(withCoach.attributes.surfaceAffinities.get('clay')).toBeGreaterThan(25); // boosted above the uncoached result
  });

  it('boosts physical-attribute training when a coachRating is passed, applied AFTER the per-attribute ceiling taper', () => {
    const withCoach = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, {
      speed: 40,
      stamina: 100,
      strength: 100,
    });
    // Same setup as the ceiling taper test above (headroom 10, taper
    // range 15 -> factor 10/15, tapered delta = 3 * 10/15 = 2), now
    // with a coach boosting that already-tapered 2 further upward.
    withCoach.applyTraining({ kind: 'attribute', attribute: 'speed' }, new FixedTrainingPolicy(3), 100);
    expect(withCoach.attributes.physical.speed.value).toBeGreaterThan(32); // > the uncoached 30 + 2
  });

  it('a coach never revives a delta the ceiling has tapered all the way to zero', () => {
    const atCeiling = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, {
      speed: 30,
      stamina: 100,
      strength: 100,
    });
    atCeiling.applyTraining({ kind: 'attribute', attribute: 'speed' }, new FixedTrainingPolicy(5), 100);
    expect(atCeiling.attributes.physical.speed.value).toBe(30); // still zero growth — a coach boosts a delta, doesn't create one
  });

  it('a technical attribute keeps growing with repeated training sessions and no ceiling ever kicks in, until the Skill scale itself caps at 100', () => {
    // No physicalCeilings passed (technical ignores them anyway) and no
    // potentialCeiling passed either (also ignored) — full-rate,
    // constant-delta growth every single session, all the way up to
    // Skill's own 0-100 representational bound.
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'forehand' };
    const policy = new FixedTrainingPolicy(4);

    let previous = player.attributes.technical.forehand.value; // 30
    let sawAnyTaper = false;
    for (let i = 0; i < 20; i++) {
      player.applyTraining(focus, policy);
      const current = player.attributes.technical.forehand.value;
      const delta = current - previous;
      // Only once Skill's own 0-100 clamp starts truncating the raw
      // +4 near the very top can the observed delta legitimately drop
      // below 4 — that's Skill's representational bound, not a
      // training-ceiling taper. Below 96 (100 - 4), every session must
      // land exactly +4, never a smaller "approaching a ceiling" delta.
      if (previous < 96) {
        expect(delta).toBe(4);
      } else if (delta < 4) {
        sawAnyTaper = true; // tracked, not asserted false — see below
      }
      previous = current;
    }
    expect(player.attributes.technical.forehand.value).toBe(100); // reached the Skill scale's own max
    // Reaching exactly 100 via repeated +4 steps from 30 is itself proof
    // no ceiling mechanic silently intervened earlier (30 + 4*17 = 98,
    // +4 = 102 clamped to 100 by Skill.of alone) — sawAnyTaper existing
    // only documents that the LAST step or two necessarily clips at the
    // scale's own bound, which is expected and not a ceiling taper.
    expect(sawAnyTaper).toBe(true);
  });

  it('a physical attribute\'s training gains shrink monotonically as it approaches its hidden ceiling, and the value never exceeds it', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, {
      speed: 45,
      stamina: 100,
      strength: 100,
    });
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'speed' };
    const policy = new FixedTrainingPolicy(4);

    let previousValue = player.attributes.physical.speed.value; // 30
    let previousDelta = Infinity;
    for (let i = 0; i < 30; i++) {
      player.applyTraining(focus, policy);
      const currentValue = player.attributes.physical.speed.value;
      const delta = currentValue - previousValue;
      expect(delta).toBeLessThanOrEqual(previousDelta); // never a BIGGER jump than the previous session
      expect(currentValue).toBeLessThanOrEqual(45); // NEVER exceeds the ceiling, ever, at any step
      previousValue = currentValue;
      previousDelta = delta;
    }
    // Converges to a stable plateau at (or, here, one point under — see
    // below) the ceiling, growth fully stopped, not still climbing.
    expect(previousDelta).toBe(0);
    // Real, honest consequence of Skill values being integers: the
    // continuous decay curve's fractional remainder near the very top
    // (here, a steady-state delta of 45*... ~0.27/session once only 1
    // point of headroom remains) rounds DOWN forever once it's under
    // 0.5, so this specific (start=30, ceiling=45, baseDelta=4)
    // combination plateaus at 44, one point shy of the ceiling, rather
    // than landing exactly on it — verified by direct simulation, not
    // guessed. Still "smoothly approaches zero, never overshoots," per
    // the requirement — it just doesn't always land on an exact
    // integer boundary, the same way any discretized asymptotic curve
    // wouldn't. The invariant that actually matters (never exceeds,
    // monotonically slows, ends at zero growth) held every iteration
    // above regardless.
    expect(player.attributes.physical.speed.value).toBe(44);
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
