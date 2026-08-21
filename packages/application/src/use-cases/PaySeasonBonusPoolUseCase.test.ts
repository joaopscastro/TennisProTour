import { describe, expect, it } from 'vitest';
import { PlayerId, RankingLedgerEntry, StandardSeasonBonusPoolPolicy, TournamentId, WorldId } from '@tennis-manager/domain';
import { RankingLedgerRepository } from '../ports/ports';
import { InMemoryPlayerRepository, makePlayer } from './doublesTestHelpers';
import { PaySeasonBonusPoolUseCase } from './PaySeasonBonusPoolUseCase';

class InMemoryRankingLedgerRepository implements RankingLedgerRepository {
  private readonly entries: RankingLedgerEntry[] = [];
  async append(entry: RankingLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }
  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }
  async findAll(): Promise<RankingLedgerEntry[]> {
    return [...this.entries];
  }
}

const worldId = WorldId('main');

function entry(playerId: PlayerId, points: number, season: number, overrides: Partial<RankingLedgerEntry> = {}): RankingLedgerEntry {
  return {
    playerId,
    tournamentId: TournamentId('t1'),
    tier: 'tour',
    ageBand: null,
    points,
    weekEarned: { season, week: 10 },
    ...overrides,
  };
}

async function setup() {
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const players = new InMemoryPlayerRepository();
  const useCase = new PaySeasonBonusPoolUseCase(rankingLedger, players, new StandardSeasonBonusPoolPolicy());
  return { rankingLedger, players, useCase };
}

describe('PaySeasonBonusPoolUseCase', () => {
  it('pays the top finisher by season points more than the runner-up, and credits both career and season prize money', async () => {
    const { rankingLedger, players, useCase } = await setup();
    await players.save(makePlayer(PlayerId('p1'), null));
    await players.save(makePlayer(PlayerId('p2'), null));
    await rankingLedger.append(entry(PlayerId('p1'), 2000, 1));
    await rankingLedger.append(entry(PlayerId('p2'), 500, 1));

    const result = await useCase.execute({ worldId, season: 1 });

    expect(result).toEqual({ season: 1, playersConsidered: 2, payoutsWritten: 2, totalPaid: expect.any(Number) });
    const p1 = await players.findById(PlayerId('p1'));
    const p2 = await players.findById(PlayerId('p2'));
    expect(p1!.careerPrizeMoney).toBeGreaterThan(p2!.careerPrizeMoney);
    expect(p1!.seasonPrizeMoney).toBe(p1!.careerPrizeMoney);
    expect(p2!.careerPrizeMoney).toBeGreaterThan(0);
  });

  it('sums MULTIPLE results within the season into one standing per player', async () => {
    const { rankingLedger, players, useCase } = await setup();
    await players.save(makePlayer(PlayerId('p1'), null));
    await rankingLedger.append(entry(PlayerId('p1'), 300, 1, { tournamentId: TournamentId('t1') }));
    await rankingLedger.append(entry(PlayerId('p1'), 500, 1, { tournamentId: TournamentId('t2') }));

    await useCase.execute({ worldId, season: 1 });

    const p1 = await players.findById(PlayerId('p1'));
    expect(p1!.careerPrizeMoney).toBeGreaterThan(0);
  });

  it('ignores results from a DIFFERENT season', async () => {
    const { rankingLedger, players, useCase } = await setup();
    await players.save(makePlayer(PlayerId('p1'), null));
    await rankingLedger.append(entry(PlayerId('p1'), 2000, 2)); // season 2, not the one we're paying out

    const result = await useCase.execute({ worldId, season: 1 });

    expect(result.playersConsidered).toBe(0);
    const p1 = await players.findById(PlayerId('p1'));
    expect(p1!.careerPrizeMoney).toBe(0);
  });

  it('ignores JUNIOR-band results — the pool is senior-tour only', async () => {
    const { rankingLedger, players, useCase } = await setup();
    await players.save(makePlayer(PlayerId('p1'), null));
    await rankingLedger.append(entry(PlayerId('p1'), 2000, 1, { ageBand: 'u16' }));

    const result = await useCase.execute({ worldId, season: 1 });

    expect(result.playersConsidered).toBe(0);
  });

  it('ignores DOUBLES results — standings are singles only', async () => {
    const { rankingLedger, players, useCase } = await setup();
    await players.save(makePlayer(PlayerId('p1'), null));
    await rankingLedger.append(entry(PlayerId('p1'), 2000, 1, { discipline: 'doubles' }));

    const result = await useCase.execute({ worldId, season: 1 });

    expect(result.playersConsidered).toBe(0);
  });

  it('skips a payout for a player who no longer exists (defensive, should not throw)', async () => {
    const { rankingLedger, useCase } = await setup();
    await rankingLedger.append(entry(PlayerId('ghost'), 2000, 1));

    const result = await useCase.execute({ worldId, season: 1 });

    expect(result.playersConsidered).toBe(1);
    expect(result.payoutsWritten).toBe(0);
    expect(result.totalPaid).toBe(0);
  });
});
