import { describe, expect, it } from 'vitest';
import { WEEKS_PER_SEASON } from '../world/GameWorld';
import { StandardJuniorTournamentSchedulePolicy } from './JuniorTournamentSchedulePolicy';
import { StandardSeniorTournamentSchedulePolicy } from './SeniorTournamentSchedulePolicy';
import { StandardTournamentSchedulePolicy, isTwoWeekTier } from './TournamentSchedulePolicy';

/**
 * Property test for THE WEEK-51 RULE (see TWO_WEEK_TIERS' doc comment in
 * TournamentSchedulePolicy.ts): a two-week tier runs 14 days, final on
 * day 14, so it must START by season week 51 to finish inside its own
 * season. A week-52 start would run into S2W1 day 7 — after the season
 * bonus pool has paid out and after the season prize reset — landing the
 * result in the wrong season (and, for juniorMasters, making it
 * mathematically unfinishable in-season, which the agent season hit).
 *
 * The two schedule policies enforce this independently, so this file
 * checks BOTH: the senior major's every-13-week phase, and the junior
 * masters week — over every week of three full seasons, not just the
 * boundary case.
 */
describe('two-week tiers are never scheduled in the season’s final week', () => {
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

  /** Every two-week-tier start in a season, as { tier, week, weeksSpanned }. */
  function twoWeekStarts(season: number): Array<{ tier: 'major' | 'juniorMasters'; week: number }> {
    const starts: Array<{ tier: 'major' | 'juniorMasters'; week: number }> = [];
    for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
      if (majorScheduled(season, week)) starts.push({ tier: 'major', week });
      if (junior.isJuniorMastersWeek({ season, week })) starts.push({ tier: 'juniorMasters', week });
    }
    return starts;
  }

  it('never schedules major or juniorMasters for week 52 — across every week of three full seasons', () => {
    for (const season of SEASONS) {
      for (const start of twoWeekStarts(season)) {
        expect(start.week).toBeLessThan(WEEKS_PER_SEASON);
      }
    }
  });

  it('every scheduled two-week event’s 14-day run genuinely finishes inside its own season', () => {
    for (const season of SEASONS) {
      for (const start of twoWeekStarts(season)) {
        // The rule, expressed against the REAL round-day map rather than
        // a restated constant: duration is 14 days = 2 calendar weeks,
        // so `week + ceil(days / 7) - 1` must stay within the season.
        const drawSize = start.tier === 'major' ? 128 : junior.juniorMastersDrawSize;
        const durationDays = dayMap.durationDays(start.tier, drawSize);
        const weeksSpanned = Math.ceil(durationDays / 7);
        expect(start.week + weeksSpanned - 1).toBeLessThanOrEqual(WEEKS_PER_SEASON);
      }
    }
  });

  it('gives every season exactly four majors, 13 weeks apart, at weeks 12/25/38/51', () => {
    for (const season of SEASONS) {
      const majorWeeks: number[] = [];
      for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
        if (majorScheduled(season, week)) majorWeeks.push(week);
      }
      expect(majorWeeks).toEqual([12, 25, 38, 51]);
    }

    // The cadence must also hold ACROSS season boundaries (51 → S2W12
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

  it('holds juniorMasters exactly once per season, on week 51', () => {
    for (const season of SEASONS) {
      const mastersWeeks: number[] = [];
      for (let week = 1; week <= WEEKS_PER_SEASON; week++) {
        if (junior.isJuniorMastersWeek({ season, week })) mastersWeeks.push(week);
      }
      expect(mastersWeeks).toEqual([51]);
    }
  });

  it('the rule it enforces is the one the round-day map implies: two-week tiers end on day 14', () => {
    for (const tier of ['major', 'juniorMasters'] as const) {
      expect(isTwoWeekTier(tier)).toBe(true);
    }
    expect(dayMap.durationDays('major', 128)).toBe(14);
    expect(dayMap.durationDays('juniorMasters', junior.juniorMastersDrawSize)).toBe(14);
  });
});
