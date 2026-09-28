import { describe, expect, it } from 'vitest';
import { addDays, WEEKS_PER_SEASON } from '../world/GameWorld';
import { qualifyingRoundCountFor } from '../ranking/QualifyingPolicy';
import { StandardJuniorTournamentSchedulePolicy } from './JuniorTournamentSchedulePolicy';
import { StandardSeniorTournamentSchedulePolicy } from './SeniorTournamentSchedulePolicy';
import { StandardTournamentSchedulePolicy, isTwoWeekTier } from './TournamentSchedulePolicy';

/**
 * Property test for THE DEADLINE RULE (see TWO_WEEK_TIERS' doc comment in
 * TournamentSchedulePolicy.ts): a two-week event must start early enough
 * that its FINAL ROUND lands by the season's last day (S1W52 d7). The
 * real span is `qualifyingRoundCount + durationDays`, not just the
 * 14-day main draw:
 *
 *   - `major` holds 3 qualifying days (128-player field, 16 places) →
 *     17-day span → latest start week 50 (final S1W52 d3).
 *   - `juniorMasters` holds no qualifying → 14-day span → latest start
 *     week 51 (final S1W52 d7).
 *
 * The old version of this test checked `week + ceil(durationDays / 7) - 1`
 * — i.e. it ignored the qualifying shift, passed with a phase-12 major
 * at week 51, and the 52-week agent season's fourth major was left
 * unplayed (its final was scheduled for S2W1 d3). This version checks
 * the REAL round-day map through `roundScheduledDay`'s own arithmetic.
 */
describe('two-week tiers never finish outside their own season (qualifying-aware)', () => {
  const senior = new StandardSeniorTournamentSchedulePolicy();
  const junior = new StandardJuniorTournamentSchedulePolicy();
  const dayMap = new StandardTournamentSchedulePolicy();
  const SEASONS = [1, 2, 3];

  /** Is a senior `major` opened for this season/week? (The use cases
   * generate for an absolute week = season * WEEKS_PER_SEASON + week,
   * the same arithmetic the policy itself is fed.) */
  function majorScheduled(season: number, week: number): boolean {
    return senior
      .weeklyOpenings(season * WEEKS_PER_SEASON + week)
      .some((opening) => opening.tier === 'major');
  }

  /** Every two-week-tier start in a season, as { tier, week }. */
  function twoWeekStarts(season: number): Array<{ tier: 'major' | 'juniorMasters'; week: number }> {
    const starts: Array<{ tier: 'major' | 'juniorMasters'; week: number }> = [];
    for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
      if (majorScheduled(season, week)) starts.push({ tier: 'major', week });
      if (junior.isJuniorMastersWeek({ season, week })) starts.push({ tier: 'juniorMasters', week });
    }
    return starts;
  }

  /** The absolute GameDay the tier's final round actually plays on, from
   * the tournament's start day (day 1 of its scheduled week), using the
   * real policy round-day map AND the real qualifying shift — exactly
   * what Tournament.roundScheduledDay computes for the last round. */
  function finalDay(tier: 'major' | 'juniorMasters', season: number, week: number) {
    const drawSize = tier === 'major' ? 128 : junior.juniorMastersDrawSize;
    const qualifyingDays = qualifyingRoundCountFor(tier, drawSize);
    const offset = dayMap.roundDay(tier, drawSize, Math.log2(drawSize));
    return addDays({ season, week, day: 1 }, qualifyingDays + offset - 1);
  }

  it('gives every season exactly four majors, 13 weeks apart, at weeks 11/24/37/50', () => {
    for (const season of SEASONS) {
      const majorWeeks: number[] = [];
      for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
        if (majorScheduled(season, week)) majorWeeks.push(week);
      }
      expect(majorWeeks).toEqual([11, 24, 37, 50]);
    }

    // The cadence must also hold ACROSS season boundaries (50 → S2W11
    // is still 13 absolute weeks, never a gap or a double).
    const majorAbsoluteWeeks: number[] = [];
    for (const season of SEASONS) {
      for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
        if (majorScheduled(season, week)) {
          majorAbsoluteWeeks.push(season * WEEKS_PER_SEASON + week);
        }
      }
    }
    expect(majorAbsoluteWeeks).toHaveLength(3 * 4);
    for (let i = 1; i < majorAbsoluteWeeks.length; i++) {
      expect(majorAbsoluteWeeks[i] - majorAbsoluteWeeks[i - 1]).toBe(13);
    }
  });

  it('every scheduled two-week event’s REAL span (qualifying included) finishes inside its own season', () => {
    for (const season of SEASONS) {
      for (const start of twoWeekStarts(season)) {
        const final = finalDay(start.tier, season, start.week);
        // The final must land in the SAME season, on or before its last
        // day — the exact property the old phase-12 week-51 major failed
        // (it ended S2W1 d3).
        expect(final.season).toBe(season);
        expect(final.week).toBeLessThanOrEqual(WEEKS_PER_SEASON);
      }
    }
  });

  it('a week-51 major would provably end in the next season — which is why majors may never start there', () => {
    // The rule's rationale, pinned: the qualifying shift is exactly what
    // makes week 51 unsafe for a qualifying two-week tier (and exactly
    // what the earlier week-51 rule missed). A week-51 major's final is
    // S2W1 d3; a week-51 juniorMasters (no qualifying) is still W52 d7.
    expect(finalDay('major', 1, 51)).toEqual({ season: 2, week: 1, day: 3 });
    expect(finalDay('juniorMasters', 1, 51)).toEqual({ season: 1, week: 52, day: 7 });
    // And the last legal major start, week 50, lands in-season.
    expect(finalDay('major', 1, 50)).toEqual({ season: 1, week: 52, day: 3 });
  });

  it('never schedules major or juniorMasters for week 52 — across every week of three full seasons', () => {
    for (const season of SEASONS) {
      for (const start of twoWeekStarts(season)) {
        expect(start.week).toBeLessThan(WEEKS_PER_SEASON);
      }
    }
  });

  it('holds juniorMasters exactly once per season, on week 51', () => {
    for (const season of SEASONS) {
      const mastersWeeks: number[] = [];
      for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
        if (junior.isJuniorMastersWeek({ season, week })) mastersWeeks.push(week);
      }
      expect(mastersWeeks).toEqual([51]);
    }
  });

  it('the rule it enforces is the one the round-day map implies: two-week main draws end on day 14', () => {
    for (const tier of ['major', 'juniorMasters'] as const) {
      expect(isTwoWeekTier(tier)).toBe(true);
    }
    expect(dayMap.durationDays('major', 128)).toBe(14);
    expect(dayMap.durationDays('juniorMasters', junior.juniorMastersDrawSize)).toBe(14);
  });
});
