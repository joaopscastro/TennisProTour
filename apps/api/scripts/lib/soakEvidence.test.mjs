import { describe, expect, it } from 'vitest';
import { cohortDeltas } from './soakEvidence.mjs';

/**
 * Regression coverage for the evidence-harness bug where `cohortDeltas`
 * took `weekly[0]` as the "first" snapshot. A player claimed after week
 * 0 has `rows: []` in that first snapshot, so every such player reported
 * `present: false` and the `experience-rising-skills-flat` anomaly —
 * the exact signature of the Skill integer-rounding bug — could never
 * fire. It passed vacuously in every soak until this test existed.
 */

const SKILLS = {
  serve: 50,
  forehand: 50,
  backhand: 50,
  volley: 50,
  speed: 50,
  stamina: 50,
  strength: 50,
  consistency: 50,
  clutch: 50,
  doubles: 50,
};

/** One snapshot row in the shape `snapshotTracked` returns. */
function row(id, { name = id, experience = 0, stage = 'prime', skills = {} } = {}) {
  return { id, name, stage, experience, ...SKILLS, ...skills };
}

describe('cohortDeltas', () => {
  it('measures a player claimed after week 0 from their first present week, and fires the flat-skills flag', () => {
    const weekly = [
      [], // week 0 — empty: nothing tracked was claimed yet
      [row('a', { name: 'Rising A', experience: 0 })],
      [row('a', { name: 'Rising A', experience: 2.5 })],
      [row('a', { name: 'Rising A', experience: 5 })],
    ];

    const [delta] = cohortDeltas(weekly, ['a']);

    expect(delta.present).not.toBe(false);
    expect(delta.experienceDelta).toBe(5); // 5 - 0, from the FIRST PRESENT week (week 1)
    expect(delta.skillsMoved).toBe(0);
    expect(delta.experienceRisingSkillsFlat).toBe(true);
  });

  it('measures a player present only from week 2 from week 2, not from zero', () => {
    const weekly = [
      [],
      [], // absent in week 1 too
      [row('a', { experience: 10 })],
      [row('a', { experience: 25 })],
    ];

    const [delta] = cohortDeltas(weekly, ['a']);

    expect(delta.present).not.toBe(false);
    // 25 - 10, the delta across the snapshots the player actually appears in.
    expect(delta.experienceDelta).toBe(15);
  });

  it('reports present:false for an id with a single appearance (no measurable window)', () => {
    const weekly = [
      [],
      [row('a', { experience: 0 }), row('b', { experience: 7 })],
      [row('a', { experience: 3 })],
    ];

    const deltas = cohortDeltas(weekly, ['a', 'b', 'never-seen']);
    const byId = new Map(deltas.map((d) => [d.id, d]));

    expect(byId.get('a').present).not.toBe(false);
    expect(byId.get('a').experienceDelta).toBe(3);
    expect(byId.get('b')).toEqual({ id: 'b', present: false });
    expect(byId.get('never-seen')).toEqual({ id: 'never-seen', present: false });
  });

  it('still measures a player present from week 0 (week 0 containing them remains their first snapshot)', () => {
    const weekly = [
      [row('a', { experience: 1 })],
      [row('a', { experience: 9 })],
    ];

    const [delta] = cohortDeltas(weekly, ['a']);

    expect(delta.present).not.toBe(false);
    expect(delta.experienceDelta).toBe(8);
  });

  it('returns [] for no snapshots at all', () => {
    expect(cohortDeltas([], ['a'])).toEqual([]);
  });
});
