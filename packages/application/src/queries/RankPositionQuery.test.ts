import { describe, expect, it } from 'vitest';
import { AgeBand, GameWeek, GameWorld, PlayerId, RankingLedgerEntry, TournamentId, WorldId } from '@tennis-manager/domain';
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

function entry(
  playerId: string,
  points: number,
  weekEarned: GameWeek,
  overrides: Partial<Pick<RankingLedgerEntry, 'tier' | 'ageBand' | 'tournamentId'>> = {},
): RankingLedgerEntry {
  return {
    playerId: PlayerId(playerId),
    tournamentId: overrides.tournamentId ?? TournamentId('t'),
    tier: overrides.tier ?? 'challenger',
    ageBand: overrides.ageBand ?? null,
    points,
    weekEarned,
  };
}

function juniorEntry(playerId: string, points: number, weekEarned: GameWeek, ageBand: AgeBand, tournamentId = 't') {
  return entry(playerId, points, weekEarned, { tier: 'j100', ageBand, tournamentId: TournamentId(tournamentId) });
}

describe('RankPositionQuery — senior band', () => {
  it('sorts players by their currently-computed ranking total descending', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    await ledger.append(entry('low', 10, currentWeek));
    await ledger.append(entry('high', 90, currentWeek));
    await ledger.append(entry('mid', 50, currentWeek));

    const query = new RankPositionQuery(ledger, worlds, worldId, 'senior');
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

    const query = new RankPositionQuery(ledger, worlds, worldId, 'senior');
    const result = await query.rankFor(PlayerId('never-earned-anything'));

    expect(result).toEqual({ totalPoints: 0, rank: null });
  });

  it('falls back to season 1 week 1 when the game-world clock has never been initialized', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository(); // no world saved at all
    await ledger.append(entry('p1', 42, { season: 1, week: 1 }));

    const query = new RankPositionQuery(ledger, worlds, worldId, 'senior');
    const result = await query.rankFor(PlayerId('p1'));

    expect(result).toEqual({ totalPoints: 42, rank: 1 });
  });

  it('excludes a player whose only entry has aged out of the 52-week window — NR, not ranked at 0', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    // p1's only result is 53 weeks old relative to the current week — past
    // the 52-week rolling window, so it no longer counts at all.
    const currentWeek: GameWeek = { season: 2, week: 5 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
    await ledger.append(entry('p1', 1000, { season: 1, week: 4 }));
    await ledger.append(entry('p2', 5, currentWeek));

    const query = new RankPositionQuery(ledger, worlds, worldId, 'senior');
    const sorted = await query.sortedRankings();

    // p1's only result is aged out, so their current total is 0 — that
    // means genuinely unranked (NR), excluded entirely, not sorted to
    // the bottom with an implicit score of zero.
    expect(sorted).toEqual([{ playerId: PlayerId('p2'), totalPoints: 5 }]);

    const p1Result = await query.rankFor(PlayerId('p1'));
    expect(p1Result).toEqual({ totalPoints: 0, rank: null });
  });

  it('excludes a player whose entries are all first-round losses (0 points each) — participation without ever winning is still NR', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    // Three tournaments entered, lost round 1 every time — 0 points
    // each (see StandardRankingPointsTable's roundsWon=0 fix). This
    // player has participated, but never earned a ranking result.
    await ledger.append(entry('never-won', 0, currentWeek, { tournamentId: TournamentId('t1') }));
    await ledger.append(entry('never-won', 0, currentWeek, { tournamentId: TournamentId('t2') }));
    await ledger.append(entry('never-won', 0, currentWeek, { tournamentId: TournamentId('t3') }));
    await ledger.append(entry('winner', 11, currentWeek));

    const query = new RankPositionQuery(ledger, worlds, worldId, 'senior');
    const sorted = await query.sortedRankings();

    expect(sorted).toEqual([{ playerId: PlayerId('winner'), totalPoints: 11 }]);
    expect(await query.rankFor(PlayerId('never-won'))).toEqual({ totalPoints: 0, rank: null });
  });
});

describe('RankPositionQuery — junior bands are independent of each other and of the senior tour', () => {
  it("a player's U14 and U16 rankings are computed independently even when they have results in both bands", async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    await ledger.append(juniorEntry('dual-band', 20, currentWeek, 'u14', 'u14-t1'));
    await ledger.append(juniorEntry('dual-band', 200, currentWeek, 'u16', 'u16-t1'));
    // A senior-tour result too, which must feed neither junior band.
    await ledger.append(entry('dual-band', 999, currentWeek, { tournamentId: TournamentId('senior-t1') }));

    const u14Query = new RankPositionQuery(ledger, worlds, worldId, 'u14');
    const u16Query = new RankPositionQuery(ledger, worlds, worldId, 'u16');
    const seniorQuery = new RankPositionQuery(ledger, worlds, worldId, 'senior');

    expect(await u14Query.rankFor(PlayerId('dual-band'))).toEqual({ totalPoints: 20, rank: 1 });
    expect(await u16Query.rankFor(PlayerId('dual-band'))).toEqual({ totalPoints: 200, rank: 1 });
    expect(await seniorQuery.rankFor(PlayerId('dual-band'))).toEqual({ totalPoints: 999, rank: 1 });
  });

  it('a U14 leaderboard never includes a U16-only result, and vice versa', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    await ledger.append(juniorEntry('u14-only', 50, currentWeek, 'u14'));
    await ledger.append(juniorEntry('u16-only', 60, currentWeek, 'u16'));

    const u14Query = new RankPositionQuery(ledger, worlds, worldId, 'u14');
    const u16Query = new RankPositionQuery(ledger, worlds, worldId, 'u16');

    expect(await u14Query.sortedRankings()).toEqual([{ playerId: PlayerId('u14-only'), totalPoints: 50 }]);
    expect(await u14Query.rankFor(PlayerId('u16-only'))).toEqual({ totalPoints: 0, rank: null });

    expect(await u16Query.sortedRankings()).toEqual([{ playerId: PlayerId('u16-only'), totalPoints: 60 }]);
    expect(await u16Query.rankFor(PlayerId('u14-only'))).toEqual({ totalPoints: 0, rank: null });
  });

  it('applies the real ITF best-6 rule by default for a junior band, unlike the senior tour default of 18', async () => {
    const ledger = new InMemoryRankingLedgerRepository();
    const worlds = new InMemoryGameWorldRepository();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));

    // 7 J100 results, each worth 100, 99, ... 94 — the 7th (worst, 94)
    // must be excluded under a best-6 cap.
    for (let i = 0; i < 7; i++) {
      await ledger.append(juniorEntry('junior-player', 100 - i, currentWeek, 'u14', `t${i}`));
    }

    const u14Query = new RankPositionQuery(ledger, worlds, worldId, 'u14');
    const result = await u14Query.rankFor(PlayerId('junior-player'));

    expect(result.totalPoints).toBe(100 + 99 + 98 + 97 + 96 + 95); // best 6, 94 excluded
  });
});
