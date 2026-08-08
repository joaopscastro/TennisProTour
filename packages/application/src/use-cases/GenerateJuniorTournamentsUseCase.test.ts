import { describe, expect, it } from 'vitest';
import {
  AgeBand,
  BracketGenerator,
  GameWeek,
  GameWorld,
  JuniorTournamentSchedulePolicy,
  PlayerId,
  RandomSource,
  RankingLedgerEntry,
  Tournament,
  TournamentId,
  TournamentNameGenerator,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort, RankingLedgerRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';
import { OpenTournamentUseCase } from './OpenTournamentUseCase';
import { GenerateJuniorTournamentsUseCase } from './GenerateJuniorTournamentsUseCase';
import { TournamentRepository } from '../ports/ports';

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<TournamentId, Tournament>();

  async findById(id: TournamentId): Promise<Tournament | null> {
    return this.store.get(id) ?? null;
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => !t.hasStarted);
  }

  async findStarted(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => t.hasStarted);
  }

  async findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [...this.store.values()].filter(
      (t) =>
        t.weekScheduled.season === week.season &&
        t.weekScheduled.week === week.week &&
        t.entrants.some((e) => e.playerId === playerId),
    );
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
  }
}

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

class SequentialIdGenerator implements IdGeneratorPort {
  private n = 0;
  generate(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}

function juniorEntry(playerId: string, points: number, ageBand: AgeBand, weekEarned: GameWeek = { season: 1, week: 1 }): RankingLedgerEntry {
  return { playerId: PlayerId(playerId), tournamentId: TournamentId('t'), tier: 'j100', ageBand, points, weekEarned };
}

const worldId = WorldId('main');

async function setup(week: GameWeek, schedule?: JuniorTournamentSchedulePolicy) {
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: week, lastAppliedTick: null }));
  const tournaments = new InMemoryTournamentRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const bracketGenerator = new BracketGenerator();
  const nameGenerator = new TournamentNameGenerator();
  const nameRandom: RandomSource = { next: () => 0 };
  const openRegistration = new OpenRegistrationUseCase(tournaments, nameGenerator, nameRandom);
  const openTournament = new OpenTournamentUseCase(tournaments, bracketGenerator, nameGenerator, nameRandom);
  const rankPositionU14 = new RankPositionQuery(rankingLedger, worlds, worldId, 'u14');
  const rankPositionU16 = new RankPositionQuery(rankingLedger, worlds, worldId, 'u16');
  const useCase = new GenerateJuniorTournamentsUseCase(
    worlds,
    openRegistration,
    openTournament,
    { u14: rankPositionU14, u16: rankPositionU16 },
    new SequentialIdGenerator(),
    schedule,
  );
  return { worlds, tournaments, rankingLedger, useCase };
}

describe('GenerateJuniorTournamentsUseCase', () => {
  it('opens the real StandardJuniorTournamentSchedulePolicy grades for BOTH age bands on a typical (non-special) week', async () => {
    // season*52 + week = 1*52 + 1 = 53 -> odd, not divisible by 2/4/8, not week 52.
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });

    const result = await useCase.execute({ worldId });

    const open = await tournaments.findOpenForRegistration();
    const byTierAndBand = new Map<string, number>();
    for (const t of open) {
      const key = `${t.tier}/${t.ageBand}`;
      byTierAndBand.set(key, (byTierAndBand.get(key) ?? 0) + 1);
    }

    expect(byTierAndBand.get('j30/u14')).toBe(3);
    expect(byTierAndBand.get('j60/u14')).toBe(2);
    expect(byTierAndBand.get('j100/u14')).toBe(1);
    expect(byTierAndBand.get('j30/u16')).toBe(3);
    expect(byTierAndBand.get('j60/u16')).toBe(2);
    expect(byTierAndBand.get('j100/u16')).toBe(1);
    // Not a J200/J300/J500 week.
    expect(byTierAndBand.has('j200/u14')).toBe(false);
    expect(byTierAndBand.has('j300/u14')).toBe(false);
    expect(byTierAndBand.has('j500/u14')).toBe(false);

    expect(result.opened).toBe(12); // 6 per band x 2 bands
    expect(result.mastersHeld).toBe(0);
    expect(open).toHaveLength(12);
  });

  it('every generated regular-grade tournament is real open registration (no entrants, not started, junior tier + matching ageBand)', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });
    await useCase.execute({ worldId });

    for (const t of await tournaments.findOpenForRegistration()) {
      expect(t.hasStarted).toBe(false);
      expect(t.entrants).toHaveLength(0);
      expect(['u14', 'u16']).toContain(t.ageBand);
    }
  });

  it('adds J200 on its every-2-week cadence, on top of the weekly J30/J60/J100', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 2 }); // 1*52+2 = 54, divisible by 2
    await useCase.execute({ worldId });

    const open = await tournaments.findOpenForRegistration();
    const tiers = open.filter((t) => t.ageBand === 'u14').map((t) => t.tier);
    expect(tiers).toContain('j200');
    expect(tiers).not.toContain('j300');
    expect(tiers).not.toContain('j500');
  });

  it('never holds juniorMasters on a non-week-52', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 51 });
    const result = await useCase.execute({ worldId });

    expect(result.mastersHeld).toBe(0);
    const open = await tournaments.findOpenForRegistration();
    expect(open.some((t) => t.tier === 'juniorMasters')).toBe(false);
  });

  it("on week 52, holds juniorMasters ONLY for a band with at least juniorMastersDrawSize (16) ranked players — skips the other band rather than fabricating a field", async () => {
    const { tournaments, rankingLedger, useCase } = await setup({ season: 1, week: 52 });

    // U14: 16 distinct players each with a real, positive-points result.
    for (let i = 1; i <= 16; i++) {
      await rankingLedger.append(juniorEntry(`u14-p${i}`, 100 - i, 'u14'));
    }
    // U16: only 10 ranked players — not enough for a 16-player field.
    for (let i = 1; i <= 10; i++) {
      await rankingLedger.append(juniorEntry(`u16-p${i}`, 50 - i, 'u16'));
    }

    const result = await useCase.execute({ worldId });

    expect(result.mastersHeld).toBe(1); // only U14's

    const started = await tournaments.findStarted();
    const masters = started.filter((t) => t.tier === 'juniorMasters');
    expect(masters).toHaveLength(1);
    expect(masters[0].ageBand).toBe('u14');
    expect(masters[0].hasStarted).toBe(true); // fixed-entrant tournaments start immediately
    expect(masters[0].entrants).toHaveLength(16);

    const openU16 = (await tournaments.findOpenForRegistration()).filter((t) => t.tier === 'juniorMasters');
    expect(openU16).toHaveLength(0);
  });

  it("juniorMasters entrants are exactly that band's top-ranked players, seeded 1..N by rank", async () => {
    const { tournaments, rankingLedger, useCase } = await setup({ season: 1, week: 52 });

    // 20 U14 candidates, ranked p1 (highest) down to p20 (lowest) —
    // only the top 16 should be invited.
    for (let i = 1; i <= 20; i++) {
      await rankingLedger.append(juniorEntry(`p${i}`, 200 - i, 'u14'));
    }

    await useCase.execute({ worldId });

    const masters = (await tournaments.findStarted()).find((t) => t.tier === 'juniorMasters' && t.ageBand === 'u14')!;
    const entrantIds = masters.entrants.map((e) => e.playerId).sort();
    const expectedTop16 = Array.from({ length: 16 }, (_, i) => PlayerId(`p${i + 1}`)).sort();
    expect(entrantIds).toEqual(expectedTop16);

    // Seeded 1 (best) through 16 (worst of the invited field).
    const bySeed = [...masters.entrants].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
    expect(bySeed[0].playerId).toBe(PlayerId('p1')); // highest-ranked
    expect(bySeed[15].playerId).toBe(PlayerId('p16')); // 16th-ranked
  });

  it("does not manufacture a ranking or a player to fill juniorMasters — a band with zero ranked players is simply skipped", async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 52 }); // no ledger entries at all
    const result = await useCase.execute({ worldId });

    expect(result.mastersHeld).toBe(0);
    expect((await tournaments.findStarted()).filter((t) => t.tier === 'juniorMasters')).toHaveLength(0);
  });
});
