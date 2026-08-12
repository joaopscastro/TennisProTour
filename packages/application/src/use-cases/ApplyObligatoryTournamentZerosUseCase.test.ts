import { describe, expect, it } from 'vitest';
import {
  bestResultsCapFor,
  DIRECT_ACCEPTANCE_CUTOFF,
  DrawSize,
  GameWeek,
  GameWorld,
  PlayerId,
  RankingCalculationService,
  RankingLedgerEntry,
  Tournament,
  TournamentId,
  TournamentTier,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { ApplyObligatoryTournamentZerosUseCase } from './ApplyObligatoryTournamentZerosUseCase';

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

const worldId = WorldId('main');
const currentWeek: GameWeek = { season: 2, week: 10 };

/** A concluded tournament, built through reconstitute() with a decided
 * FINAL round only — the aggregate's own isFinalRound formula
 * (log2(drawSize)) is what makes round 4 of a 16-draw the final, so this
 * is genuinely "the final is decided", not a stubbed flag. */
function concludedTournament(
  id: string,
  tier: TournamentTier,
  weekScheduled: GameWeek,
  drawSize: DrawSize = 16,
): Tournament {
  const finalist = PlayerId('finalist-a');
  const runnerUp = PlayerId('finalist-b');
  return Tournament.reconstitute({
    id: TournamentId(id),
    name: `Concluded ${id}`,
    tier,
    surface: 'hard',
    weekScheduled,
    drawSize,
    entrants: [
      { playerId: finalist, seed: 1 },
      { playerId: runnerUp, seed: 2 },
    ],
    rounds: [
      {
        roundNumber: Math.log2(drawSize),
        matches: [
          {
            entrantA: finalist,
            entrantB: runnerUp,
            outcome: { winner: finalist, loser: runnerUp, setScores: [{ winnerGames: 6, loserGames: 3 }] },
          },
        ],
      },
    ],
  });
}

function result(playerId: string, tournamentId: string, tier: TournamentTier, points: number, week: GameWeek = currentWeek): RankingLedgerEntry {
  return {
    playerId: PlayerId(playerId),
    tournamentId: TournamentId(tournamentId),
    tier,
    ageBand: null,
    points,
    weekEarned: week,
  };
}

async function setup() {
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
  const tournaments = new InMemoryTournamentRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const rankPosition = new RankPositionQuery(rankingLedger, worlds, worldId, 'senior');
  const useCase = new ApplyObligatoryTournamentZerosUseCase(worlds, tournaments, rankingLedger, rankPosition);
  return { worlds, tournaments, rankingLedger, rankPosition, useCase };
}

describe('ApplyObligatoryTournamentZerosUseCase', () => {
  it('records a mandatory-skip zero for a ranked player who skipped a concluded major', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));
    // Ranked on challenger points only — never entered the major.
    await rankingLedger.append(result('p1', 'ch-1', 'challenger', 125));

    const outcome = await useCase.execute({ worldId });

    expect(outcome).toEqual({ heldObligatory: 1, playersConsidered: 1, zerosWritten: 1 });
    const zeros = (await rankingLedger.findByPlayer(PlayerId('p1'))).filter((e) => e.obligatory === true);
    expect(zeros).toHaveLength(1);
    expect(zeros[0]).toMatchObject({
      tournamentId: TournamentId('major-1'),
      tier: 'major',
      ageBand: null,
      points: 0,
      weekEarned: currentWeek,
    });
  });

  it('is idempotent — a second run over unchanged data writes nothing further', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));
    await rankingLedger.append(result('p1', 'ch-1', 'challenger', 125));

    await useCase.execute({ worldId });
    const second = await useCase.execute({ worldId });

    expect(second.zerosWritten).toBe(0);
    expect(await rankingLedger.findByPlayer(PlayerId('p1'))).toHaveLength(2);
  });

  it('never zeroes a player who actually played the event — including a 0-point first-round loss', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));
    await rankingLedger.append(result('p1', 'ch-1', 'challenger', 125));
    await rankingLedger.append(result('p1', 'major-1', 'major', 0));

    const outcome = await useCase.execute({ worldId });

    expect(outcome.zerosWritten).toBe(0);
    const obligatoryRows = (await rankingLedger.findByPlayer(PlayerId('p1'))).filter((e) => e.obligatory === true);
    expect(obligatoryRows).toHaveLength(0);
  });

  it('leaves an unranked player alone entirely', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));

    const outcome = await useCase.execute({ worldId });

    expect(outcome).toEqual({ heldObligatory: 1, playersConsidered: 0, zerosWritten: 0 });
    expect(await rankingLedger.findAll()).toHaveLength(0);
  });

  it('ignores a non-obligatory tier and a major whose final has not been decided', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('tour-1', 'tour', currentWeek));
    await tournaments.save(
      Tournament.reconstitute({
        id: TournamentId('major-open'),
        name: 'Not finished yet',
        tier: 'major',
        surface: 'hard',
        weekScheduled: currentWeek,
        drawSize: 16,
        entrants: [],
        rounds: [
          {
            roundNumber: 1,
            matches: [{ entrantA: PlayerId('a'), entrantB: PlayerId('b'), outcome: null }],
          },
        ],
      }),
    );
    await rankingLedger.append(result('p1', 'ch-1', 'challenger', 125));

    const outcome = await useCase.execute({ worldId });

    expect(outcome).toEqual({ heldObligatory: 0, playersConsidered: 0, zerosWritten: 0 });
  });

  it('ignores an obligatory event that has already aged out of the rolling window', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    // 53 weeks before the current week (season 1 week 9, 52 weeks/season).
    await tournaments.save(concludedTournament('major-old', 'major', { season: 1, week: 9 }));
    await rankingLedger.append(result('p1', 'ch-1', 'challenger', 125));

    const outcome = await useCase.execute({ worldId });

    expect(outcome.heldObligatory).toBe(0);
    expect(outcome.zerosWritten).toBe(0);
  });

  it('really costs the ranking a best-N slot — the point of the whole rule', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));
    const cap = bestResultsCapFor('senior');
    for (let i = 0; i < cap; i += 1) {
      await rankingLedger.append(result('p1', `ch-${i}`, 'challenger', 125));
    }
    const calculator = new RankingCalculationService(cap);
    const before = calculator.calculateTotal(await rankingLedger.findByPlayer(PlayerId('p1')), currentWeek);
    expect(before).toBe(cap * 125);

    await useCase.execute({ worldId });

    const after = calculator.calculateTotal(await rankingLedger.findByPlayer(PlayerId('p1')), currentWeek);
    expect(after).toBe((cap - 1) * 125);
  });

  it('only obligates players inside the direct-acceptance cutoff', async () => {
    const { tournaments, rankingLedger, useCase } = await setup();
    await tournaments.save(concludedTournament('major-1', 'major', currentWeek));
    // Enough ranked players that some fall below the cutoff; points
    // descend so rank order is exactly the loop index.
    const playerCount = DIRECT_ACCEPTANCE_CUTOFF + 5;
    for (let i = 0; i < playerCount; i += 1) {
      await rankingLedger.append(result(`p${i}`, `ch-${i}`, 'challenger', playerCount - i));
    }

    const outcome = await useCase.execute({ worldId });

    expect(outcome.playersConsidered).toBe(DIRECT_ACCEPTANCE_CUTOFF);
    expect(outcome.zerosWritten).toBe(DIRECT_ACCEPTANCE_CUTOFF);
    const lowestObligated = (await rankingLedger.findByPlayer(PlayerId(`p${DIRECT_ACCEPTANCE_CUTOFF - 1}`))).filter(
      (e) => e.obligatory === true,
    );
    const firstExempt = (await rankingLedger.findByPlayer(PlayerId(`p${DIRECT_ACCEPTANCE_CUTOFF}`))).filter(
      (e) => e.obligatory === true,
    );
    expect(lowestObligated).toHaveLength(1);
    expect(firstExempt).toHaveLength(0);
  });
});
