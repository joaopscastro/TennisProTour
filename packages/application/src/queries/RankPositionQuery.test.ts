import { describe, expect, it } from 'vitest';
import { GameWeek, GameWorld, PlayerId, RankingLedgerEntry, TournamentId, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, RankingLedgerRepository } from '../ports/ports';
import { RankPositionQuery } from './RankPositionQuery';

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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

const worldId = WorldId('main');

function entry(playerId: string, points: number, weekEarned: GameWeek): RankingLedgerEntry {
  return { playerId: PlayerId(playerId), tournamentId: TournamentId('t'), tier: 'challenger', points, weekEarned };
}

describe('RankPositionQuery', () => {
  it('sorts players by their currently-computed ranking total descending', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    await ledger.append(entry('low', 10, currentWeek));
    await ledger.append(entry('high', 90, currentWeek));
    await ledger.append(entry('mid', 50, currentWeek));

    const query = new RankPositionQuery(ledger, worlds, worldId);
    const sorted = await query.sortedRankings();

    expect(sorted).toEqual([
      { playerId: PlayerId('high'), totalPoints: 90 },
      { playerId: PlayerId('mid'), totalPoints: 50 },
      { playerId: PlayerId('low'), totalPoints: 10 },
    ]);
  });

  it("rankFor returns null rank and 0 points for a player with no ledger entries at all", async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    await ledger.append(entry('someone-else', 100, { season: 1, week: 1 }));

    const query = new RankPositionQuery(ledger, worlds, worldId);
    const result = await query.rankFor(PlayerId('never-earned-anything'));

    expect(result).toEqual({ totalPoints: 0, rank: null });
  });

  it('falls back to season 1 week 1 when the game-world clock has never been initialized', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository(); // no world saved at all
    await ledger.append(entry('p1', 42, { season: 1, week: 1 }));

    const query = new RankPositionQuery(ledger, worlds, worldId);
    const result = await query.rankFor(PlayerId('p1'));

    expect(result).toEqual({ totalPoints: 42, rank: 1 });
  });

  it('recomputes totals against the current week rather than trusting a stored value — an aged-out entry drops a player to the back', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    // p1's only result is 53 weeks old relative to the current week — past
    // the 52-week rolling window, so it no longer counts at all.
    const currentWeek: GameWeek = { season: 2, week: 5 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
    await ledger.append(entry('p1', 1000, { season: 1, week: 4 }));
    await ledger.append(entry('p2', 5, currentWeek));

    const query = new RankPositionQuery(ledger, worlds, worldId);
    const sorted = await query.sortedRankings();

    // p2's fresh 5 points beat p1's aged-out 1000 — p1 still appears
    // (they have a ledger entry, so they're "ranked," just at 0)
    // rather than being computed as though they'd never played.
    expect(sorted).toEqual([
      { playerId: PlayerId('p2'), totalPoints: 5 },
      { playerId: PlayerId('p1'), totalPoints: 0 },
    ]);
  });
});
