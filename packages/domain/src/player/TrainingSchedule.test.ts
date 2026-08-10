import { describe, expect, it } from 'vitest';
import { GameWeek, PlayerId } from '../shared/ids';
import { TrainingFocus } from './TrainingPolicy';
import { resolveTrainingFocusForWeek, TrainingScheduleEntry } from './TrainingSchedule';

const PLAYER = PlayerId('p1');
const week = (season: number, w: number): GameWeek => ({ season, week: w });
const entry = (effectiveFrom: GameWeek, focus: TrainingFocus | null): TrainingScheduleEntry => ({
  playerId: PLAYER,
  effectiveFrom,
  focus,
});

const CLAY: TrainingFocus = { kind: 'surface', surface: 'clay' };
const SERVE: TrainingFocus = { kind: 'attribute', attribute: 'serve' };
const GRASS: TrainingFocus = { kind: 'surface', surface: 'grass' };

describe('resolveTrainingFocusForWeek', () => {
  it('returns null when there are no entries at all', () => {
    expect(resolveTrainingFocusForWeek([], week(1, 1))).toBeNull();
  });

  it('returns null for a week before any entry has taken effect yet', () => {
    const entries = [entry(week(1, 5), CLAY)];
    expect(resolveTrainingFocusForWeek(entries, week(1, 1))).toBeNull();
    expect(resolveTrainingFocusForWeek(entries, week(1, 4))).toBeNull();
  });

  it('a single entry applies from its effective week onward, indefinitely', () => {
    const entries = [entry(week(1, 3), SERVE)];
    expect(resolveTrainingFocusForWeek(entries, week(1, 3))).toEqual(SERVE);
    expect(resolveTrainingFocusForWeek(entries, week(1, 10))).toEqual(SERVE);
    expect(resolveTrainingFocusForWeek(entries, week(4, 20))).toEqual(SERVE);
  });

  it('setting a focus for week 5 only does not affect weeks 1-4', () => {
    // A standing order already in place from week 1, plus a NEW entry
    // that only takes effect at week 5.
    const entries = [entry(week(1, 1), CLAY), entry(week(1, 5), SERVE)];

    expect(resolveTrainingFocusForWeek(entries, week(1, 1))).toEqual(CLAY);
    expect(resolveTrainingFocusForWeek(entries, week(1, 2))).toEqual(CLAY);
    expect(resolveTrainingFocusForWeek(entries, week(1, 3))).toEqual(CLAY);
    expect(resolveTrainingFocusForWeek(entries, week(1, 4))).toEqual(CLAY);
    // Week 5 onward picks up the new order.
    expect(resolveTrainingFocusForWeek(entries, week(1, 5))).toEqual(SERVE);
    expect(resolveTrainingFocusForWeek(entries, week(1, 6))).toEqual(SERVE);
  });

  it('a week with no explicit entry of its own correctly uses the most recently explicitly-set standing order', () => {
    // Explicit entries only at weeks 1, 4, and 9 — every week in
    // between has no row of its own and must carry forward the
    // nearest earlier one.
    const entries = [entry(week(1, 1), CLAY), entry(week(1, 4), SERVE), entry(week(1, 9), GRASS)];

    expect(resolveTrainingFocusForWeek(entries, week(1, 2))).toEqual(CLAY); // carries week 1's order
    expect(resolveTrainingFocusForWeek(entries, week(1, 3))).toEqual(CLAY); // still week 1's order
    expect(resolveTrainingFocusForWeek(entries, week(1, 4))).toEqual(SERVE); // week 4's own entry
    expect(resolveTrainingFocusForWeek(entries, week(1, 7))).toEqual(SERVE); // carries week 4's order
    expect(resolveTrainingFocusForWeek(entries, week(1, 8))).toEqual(SERVE); // still week 4's order
    expect(resolveTrainingFocusForWeek(entries, week(1, 9))).toEqual(GRASS); // week 9's own entry
    expect(resolveTrainingFocusForWeek(entries, week(1, 20))).toEqual(GRASS); // carries week 9's order indefinitely
  });

  it('an explicit null entry is a real standing order ("stop training"), distinct from no entry at all', () => {
    const entries = [entry(week(1, 1), CLAY), entry(week(1, 5), null)];

    expect(resolveTrainingFocusForWeek(entries, week(1, 3))).toEqual(CLAY);
    // From week 5 on, the explicit "no training" order is in effect —
    // not "no entry found yet" (which would also return null, but for
    // a different reason: this null is a real decision, not an absence).
    expect(resolveTrainingFocusForWeek(entries, week(1, 5))).toBeNull();
    expect(resolveTrainingFocusForWeek(entries, week(1, 6))).toBeNull();
  });

  it('changing the standing order today does not retroactively change what already applied in past weeks', () => {
    // A manager set week 1's order to CLAY, and weeks 1-4 have already
    // elapsed under that order. Today (week 5) they change the
    // standing order going forward to SERVE.
    const beforeChange = [entry(week(1, 1), CLAY)];
    const afterChange = [entry(week(1, 1), CLAY), entry(week(1, 5), SERVE)];

    // What resolves for the already-elapsed weeks 1-4 is identical
    // whether or not the week-5 change has been made yet — adding a
    // future-effective entry can never rewrite an earlier week's
    // resolution.
    for (const w of [1, 2, 3, 4]) {
      expect(resolveTrainingFocusForWeek(beforeChange, week(1, w))).toEqual(
        resolveTrainingFocusForWeek(afterChange, week(1, w)),
      );
      expect(resolveTrainingFocusForWeek(afterChange, week(1, w))).toEqual(CLAY);
    }
    // Only week 5 onward actually sees the new order.
    expect(resolveTrainingFocusForWeek(afterChange, week(1, 5))).toEqual(SERVE);
  });

  it('picks the most recent applicable entry regardless of array order (not just "last in the list")', () => {
    // Deliberately out of chronological order.
    const entries = [entry(week(1, 9), GRASS), entry(week(1, 1), CLAY), entry(week(1, 4), SERVE)];
    expect(resolveTrainingFocusForWeek(entries, week(1, 6))).toEqual(SERVE);
  });

  it('a later season correctly outranks an earlier season regardless of the raw week number', () => {
    // Season 2 week 1 is chronologically after season 1 week 52.
    const entries = [entry(week(1, 52), CLAY), entry(week(2, 1), SERVE)];
    expect(resolveTrainingFocusForWeek(entries, week(2, 1))).toEqual(SERVE);
    expect(resolveTrainingFocusForWeek(entries, week(1, 52))).toEqual(CLAY);
  });
});
