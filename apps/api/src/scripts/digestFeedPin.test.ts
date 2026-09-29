import { describe, expect, it } from 'vitest';
import {
  qualifierSlotsFor,
  qualifyingDrawSizeFor,
  StandardPracticePolicy,
  StandardTournamentSchedulePolicy,
  Tournament,
  TournamentId,
  isTwoWeekTier,
} from '@tennis-manager/domain';
import {
  PRACTICE_REWARD,
  TWO_WEEK_TIERS,
  headlineRanking,
  practiceReward,
  tournamentConclusion,
} from '../../scripts/lib/digestFeed.mjs';

/**
 * Pins the agent-harness digest's MIRRORED facts against the real domain
 * policies, so the .mjs module (which cannot import TypeScript) can never
 * silently drift from production:
 *  - the practice-reward shape (the season-4 "practice is invisible"
 *    fix) against `StandardPracticePolicy`;
 *  - the two-week-tier set against the domain's own `isTwoWeekTier`;
 *  - the `concludesInWeek`/`finalDay` derivation against the REAL
 *    `Tournament.roundScheduledDay` schedule for every tier/draw shape
 *    the generators use.
 */
describe('digestFeed mirrors stay pinned to the domain', () => {
  it('PRACTICE_REWARD equals StandardPracticePolicy exactly', () => {
    const policy = new StandardPracticePolicy();
    expect(PRACTICE_REWARD.experiencePerSession).toBe(policy.practiceExperience());
    expect(PRACTICE_REWARD.fatiguePerSession).toBe(policy.practiceFatigue());
    expect(PRACTICE_REWARD.ladderPointsPerSession).toBe(policy.ladderPointsForSession(0));
    expect(PRACTICE_REWARD.ladderSessionsPerWeek).toBe(policy.ladderSessionsPerWeek());
    // The legible shape the digest emits: 3 × 15 = 45/week max.
    expect(practiceReward().maxLadderPointsPerWeekPerPlayer).toBe(45);
    expect(practiceReward().note).toContain('3 sessions');
  });

  it('TWO_WEEK_TIERS matches the domain isTwoWeekTier for every tier', () => {
    const tiers = [
      'futures', 'challenger', 'tour', 'major',
      'j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters',
    ] as const;
    for (const tier of tiers) {
      expect(TWO_WEEK_TIERS.includes(tier)).toBe(isTwoWeekTier(tier));
    }
  });

  it('concludesInWeek/finalDay match the REAL roundScheduledDay final for every generated shape', () => {
    const policy = new StandardTournamentSchedulePolicy();
    // The real generation shapes (see GenerateJuniorTournamentsUseCase /
    // StandardSeniorTournamentSchedulePolicy) + their qualifying config.
    const shapes: Array<{ tier: Parameters<typeof isTwoWeekTier>[0]; drawSize: 16 | 32 | 64 | 128 }> = [
      { tier: 'major', drawSize: 128 },
      { tier: 'tour', drawSize: 64 },
      { tier: 'challenger', drawSize: 32 },
      { tier: 'futures', drawSize: 32 },
      { tier: 'j30', drawSize: 32 },
      { tier: 'j500', drawSize: 64 },
      { tier: 'juniorMasters', drawSize: 32 },
    ];
    for (const { tier, drawSize } of shapes) {
      const tournament = Tournament.open({
        name: `Pin ${tier}`,
        id: TournamentId(`pin-${tier}`),
        tier,
        surface: 'hard',
        weekScheduled: { season: 1, week: 50 },
        drawSize,
        ageBand: tier.startsWith('j') || tier === 'juniorMasters' ? 'u18' : null,
        qualifyingDrawSize: qualifyingDrawSizeFor(tier, drawSize),
        qualifierSlots: qualifierSlotsFor(tier, drawSize),
      });
      const mainRounds = Math.round(Math.log2(tournament.drawSize));
      const expected = tournament.roundScheduledDay(mainRounds, policy, 'main');
      const actual = tournamentConclusion(tournament);
      expect(actual.concludesInWeek).toEqual({ season: expected.season, week: expected.week });
      expect(actual.finalDay).toBe(expected.day);
    }
  });

  it('a 128-draw qualifying major concludes S2W1 day 3 — the exact "finishes outside its labelled week" case', () => {
    const drawSize = 128 as const;
    const tournament = Tournament.open({
      name: 'Pin Major',
      id: TournamentId('pin-major-52'),
      tier: 'major',
      surface: 'hard',
      weekScheduled: { season: 1, week: 51 },
      drawSize,
      qualifyingDrawSize: qualifyingDrawSizeFor('major', drawSize),
      qualifierSlots: qualifierSlotsFor('major', drawSize),
    });
    // The season-3 live bug shape: a week-51 major's final lands three
    // days into the NEXT season — the digest now states this up front.
    expect(tournamentConclusion(tournament)).toEqual({ concludesInWeek: { season: 2, week: 1 }, finalDay: 3 });
  });

  it('headlineRanking prefers the eligibility band, falls back to the meaningful ladder, and never invents a rank', () => {
    // The REAL profile DTO shape (`currentRankings` rows use totalPoints,
    // not points).
    const emptyU14 = { band: 'u14', rank: null, totalPoints: 0 };
    const seniorRanked = { band: 'senior', rank: 3, totalPoints: 14_800 };
    // The live case: empty preferred band, real senior rank behind it.
    expect(headlineRanking([emptyU14, seniorRanked], 'u14')).toEqual(seniorRanked);
    // Normal case: the player's own band has a real rank.
    expect(headlineRanking([{ band: 'u14', rank: 1, totalPoints: 1_200 }, seniorRanked], 'u14').band).toBe('u14');
    // Nothing ranked anywhere: the preferred empty row, honestly.
    expect(headlineRanking([emptyU14, { band: 'u16', rank: null, totalPoints: 0 }], 'u16')).toEqual({
      band: 'u16',
      rank: null,
      totalPoints: 0,
    });
    // Best rank wins between two ranked ladders (tie: most points; then senior).
    expect(headlineRanking([seniorRanked, { band: 'u16', rank: 1, totalPoints: 900 }], 'u16').band).toBe('u16');
    expect(headlineRanking([{ band: 'u16', rank: 2, totalPoints: 900 }, seniorRanked], 'u18').band).toBe('u16');
  });
});
