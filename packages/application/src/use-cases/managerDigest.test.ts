import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { DigestPlayerData, DigestResult } from '../queries/ManagerDigestQuery';
import {
  buildManagerDigest,
  FIRST_DIGEST_LOOKBACK_MS,
  renderDigestEmail,
  RESULTS_DIGEST_KIND,
  roundLabel,
} from './managerDigest';

const since = new Date('2026-01-10T00:00:00.000Z');
const until = new Date('2026-01-11T00:00:00.000Z');
const playerId = PlayerId('p1');

function result(overrides: Partial<DigestResult> = {}): DigestResult {
  return {
    matchId: 'm1',
    tournamentId: 't1',
    tournamentName: 'Riga Open',
    tier: 'tour',
    ageBand: null,
    roundNumber: 3,
    drawSize: 16,
    opponentName: 'Bob Opponent',
    won: true,
    setScores: [{ winnerGames: 6, loserGames: 4 }],
    airedAt: new Date('2026-01-10T12:00:00.000Z'),
    ...overrides,
  };
}

function playerData(overrides: Partial<DigestPlayerData> = {}): DigestPlayerData {
  return {
    playerId,
    name: 'Alice Player',
    seasonAgeAnchorWeeks: 20 * 52,
    results: [],
    titles: [],
    next: null,
    ...overrides,
  };
}

describe('managerDigest constants', () => {
  it('exposes the stage-1 lookback and kind', () => {
    expect(FIRST_DIGEST_LOOKBACK_MS).toBe(86_400_000);
    expect(RESULTS_DIGEST_KIND).toBe('results_digest');
  });
});

describe('roundLabel', () => {
  it('names rounds relative to the final for a 16-draw', () => {
    expect(roundLabel(1, 16)).toBe('Round of 16');
    expect(roundLabel(2, 16)).toBe('Quarterfinal');
    expect(roundLabel(3, 16)).toBe('Semifinal');
    expect(roundLabel(4, 16)).toBe('Final');
  });

  it('scales to a 32-draw', () => {
    expect(roundLabel(1, 32)).toBe('Round of 32');
    expect(roundLabel(2, 32)).toBe('Round of 16');
    expect(roundLabel(5, 32)).toBe('Final');
  });
});

describe('buildManagerDigest', () => {
  it('window-filters results by airedAt on a half-open (since, until] window', () => {
    const digest = buildManagerDigest({
      managerId: ManagerId('m1'),
      since,
      until,
      ranks: new Map(),
      players: [
        playerData({
          results: [
            result({ matchId: 'before', airedAt: new Date('2026-01-09T23:59:59.000Z') }),
            result({ matchId: 'at-since', airedAt: since }),
            result({ matchId: 'inside', airedAt: new Date('2026-01-10T12:00:00.000Z') }),
            result({ matchId: 'at-until', airedAt: until }),
            result({ matchId: 'after', airedAt: new Date('2026-01-11T00:00:00.001Z') }),
          ],
        }),
      ],
    });

    expect(digest).not.toBeNull();
    const ids = digest!.players[0].results.map((r) => r.matchId).sort();
    expect(ids).toEqual(['at-until', 'inside']);
  });

  it('window-filters titles and attaches each player current rank/points', () => {
    const digest = buildManagerDigest({
      managerId: ManagerId('m1'),
      since,
      until,
      ranks: new Map([[playerId, { rank: 3, totalPoints: 250 }]]),
      players: [
        playerData({
          results: [result()],
          titles: [
            { tournamentId: 't1', tournamentName: 'Riga Open', tier: 'tour', ageBand: null, createdAt: new Date('2026-01-10T18:00:00.000Z') },
            { tournamentId: 'old', tournamentName: 'Old Cup', tier: 'futures', ageBand: null, createdAt: new Date('2026-01-01T00:00:00.000Z') },
          ],
        }),
      ],
    });

    expect(digest!.players[0].rank).toBe(3);
    expect(digest!.players[0].totalPoints).toBe(250);
    expect(digest!.players[0].titles.map((t) => t.tournamentId)).toEqual(['t1']);
  });

  it('defaults an unranked player to rank null / 0 points and keeps their up-next match', () => {
    const digest = buildManagerDigest({
      managerId: ManagerId('m1'),
      since,
      until,
      ranks: new Map(),
      players: [
        playerData({
          next: {
            tournamentId: 't2',
            tournamentName: 'Lima Challenger',
            tier: 'challenger',
            ageBand: null,
            roundNumber: 1,
            drawSize: 32,
            opponentName: 'Carol Next',
            scheduledStartAt: new Date('2026-01-12T09:00:00.000Z'),
          },
        }),
      ],
    });

    expect(digest).not.toBeNull();
    expect(digest!.players[0].rank).toBeNull();
    expect(digest!.players[0].totalPoints).toBe(0);
    expect(digest!.players[0].next!.opponentName).toBe('Carol Next');
  });

  it('returns null when there is nothing to report (empty digest)', () => {
    expect(
      buildManagerDigest({ managerId: ManagerId('m1'), since, until, ranks: new Map(), players: [] }),
    ).toBeNull();
    expect(
      buildManagerDigest({
        managerId: ManagerId('m1'),
        since,
        until,
        ranks: new Map(),
        players: [playerData()],
      }),
    ).toBeNull();
  });
});

describe('renderDigestEmail', () => {
  it('renders the subject and body facts for results, titles and up-next', () => {
    const digest = buildManagerDigest({
      managerId: ManagerId('m1'),
      since,
      until,
      ranks: new Map([[playerId, { rank: 3, totalPoints: 250 }]]),
      players: [
        playerData({
          results: [result({ won: true, opponentName: 'Bob Opponent' })],
          titles: [
            { tournamentId: 't1', tournamentName: 'Riga Open', tier: 'tour', ageBand: null, createdAt: new Date('2026-01-10T18:00:00.000Z') },
          ],
          next: {
            tournamentId: 't2',
            tournamentName: 'Lima Challenger',
            tier: 'challenger',
            ageBand: null,
            roundNumber: 1,
            drawSize: 32,
            opponentName: 'Carol Next',
            scheduledStartAt: new Date('2026-01-12T09:00:00.000Z'),
          },
        }),
      ],
    })!;

    const rendered = renderDigestEmail(digest);

    expect(rendered.subject).toContain('results digest');
    expect(rendered.text).toContain('Alice Player');
    expect(rendered.text).toContain('Rank #3 (250 pts)');
    expect(rendered.text).toContain('W 6-4 vs Bob Opponent - Semifinal - Riga Open (tour)');
    expect(rendered.text).toContain('Won Riga Open (tour)');
    expect(rendered.text).toContain('Up next: vs Carol Next - Round of 32 - Lima Challenger');
    expect(rendered.html).toContain('Alice Player');
    expect(rendered.html).toContain('Riga Open');
  });

  it('flips set scores for a loss (winner-first storage)', () => {
    const digest = buildManagerDigest({
      managerId: ManagerId('m1'),
      since,
      until,
      ranks: new Map(),
      players: [
        playerData({
          results: [result({ won: false, setScores: [{ winnerGames: 6, loserGames: 3 }] })],
        }),
      ],
    })!;

    expect(renderDigestEmail(digest).text).toContain('L 3-6 vs Bob Opponent');
  });
});
