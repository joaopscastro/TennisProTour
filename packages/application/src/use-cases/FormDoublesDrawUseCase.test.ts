import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  DoublesPair,
  DoublesPairingService,
  GameWeek,
  GameWorld,
  ManagerId,
  PairId,
  Player,
  PlayerAttributes,
  PlayerId,
  RankingBand,
  RankingLedgerEntry,
  Skill,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import { DoublesPairRepository, GameWorldRepository, PlayerRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { FormDoublesDrawUseCase } from './FormDoublesDrawUseCase';

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<TournamentId, Tournament>();
  /** The set the repo-level commitment read returns — tests seed it. */
  readonly unfinishedCommitments = new Set<PlayerId>();

  async findById(id: TournamentId): Promise<Tournament | null> {
    return this.store.get(id) ?? null;
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => !t.hasStarted);
  }

  async findStarted(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => t.hasStarted);
  }

  async findDoublesByPlayerAndWeek(): Promise<Tournament[]> {
    return [];
  }

  async findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [...this.store.values()].filter(
      (t) => t.weekScheduled.season === week.season && t.weekScheduled.week === week.week && t.entrants.some((e) => e.playerId === playerId),
    );
  }

  async findUnfinishedCommitmentPlayerIds(): Promise<PlayerId[]> {
    return [...this.unfinishedCommitments];
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
  }
}

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async findAll(): Promise<Player[]> {
    return [...this.store.values()];
  }

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }
}

class InMemoryDoublesPairRepository implements DoublesPairRepository {
  private readonly store = new Map<PairId, DoublesPair>();

  async findById(id: PairId): Promise<DoublesPair | null> {
    return this.store.get(id) ?? null;
  }

  async findByPlayer(playerId: PlayerId): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.playerA === playerId || p.playerB === playerId);
  }

  async findByPlayers(playerIds: PlayerId[]): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => playerIds.includes(p.playerA) || playerIds.includes(p.playerB));
  }

  async findActive(): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.isActive);
  }

  async save(pair: DoublesPair): Promise<void> {
    this.store.set(pair.id, pair);
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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

const physicalCeilings = { speed: 55, stamina: 55, strength: 55 } as const;

function fillOnlyPlayer(id: string, ageInWeeks = 25 * 52): Player {
  return Player.generateFillOnly(PlayerId(id), `Filler ${id}`, ageInWeeks, 'prime', attributes(30), 'BR', 55, physicalCeilings);
}

/** A deliberately STRONG free agent (80 flat attributes, 60 doubles →
 * ~110 doublesSideStrength) for the field-strength tests. */
function strongFillOnlyPlayer(id: string, ageInWeeks = 25 * 52): Player {
  const strongAttributes = new PlayerAttributes({
    technical: { serve: Skill.of(80), forehand: Skill.of(80), backhand: Skill.of(80), volley: Skill.of(80) },
    physical: { speed: Skill.of(80), stamina: Skill.of(80), strength: Skill.of(80) },
    mental: { consistency: Skill.of(80), clutch: Skill.of(80) },
    doubles: Skill.of(60),
    surfaceAffinities: SurfaceAffinities.initial(),
  });
  return Player.generateFillOnly(PlayerId(id), `Strong ${id}`, ageInWeeks, 'prime', strongAttributes, 'BR', 100, {
    speed: 100,
    stamina: 100,
    strength: 100,
  });
}

const worldId = WorldId('main');

async function setup(currentWeek: GameWeek) {
  const tournaments = new InMemoryTournamentRepository();
  const players = new InMemoryPlayerRepository();
  const pairs = new InMemoryDoublesPairRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
  const rankByBand: Record<RankingBand, RankPositionQuery> = {
    senior: new RankPositionQuery(rankingLedger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(rankingLedger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(rankingLedger, worlds, worldId, 'u16'),
    u18: new RankPositionQuery(rankingLedger, worlds, worldId, 'u18'),
  };
  const bracketGenerator = new BracketGenerator();
  const useCase = new FormDoublesDrawUseCase(
    tournaments,
    players,
    pairs,
    rankByBand,
    rankByBand,
    new DoublesPairingService(),
    bracketGenerator,
    { next: () => 0.5 },
  );
  return { tournaments, players, pairs, rankingLedger, useCase };
}

function doublesTournament(id: string, weekScheduled: GameWeek = { season: 1, week: 4 }): Tournament {
  return Tournament.open({
    name: 'Test Doubles Tournament',
    id: TournamentId(id),
    tier: 'challenger',
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
    doublesDrawSize: 8,
  });
}

describe('FormDoublesDrawUseCase', () => {
  it('forms a real bracket for a lone persistent pair by padding the field from free agents, instead of silently no-oping', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-lone-pair');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    for (let i = 1; i <= 20; i++) {
      await players.save(fillOnlyPlayer(`filler-${i}`));
    }

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-lone-pair'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    expect(formed!.doublesPairs.length).toBeGreaterThanOrEqual(2);
    const pairIncludingAB = formed!.doublesPairs.find((p) => (p.playerA === a.id && p.playerB === b.id) || (p.playerA === b.id && p.playerB === a.id));
    expect(pairIncludingAB).toBeDefined();
  });

  it('never double-books a filler already committed to another tournament the same week', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const otherSingles = Tournament.open({
      name: 'Other Singles',
      id: TournamentId('t-other-singles'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 4 },
      drawSize: 16,
    });
    otherSingles.registerEntrant({ playerId: PlayerId('filler-committed'), seed: null });
    await tournaments.save(otherSingles);

    const tournament = doublesTournament('t-needs-fill');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('filler-committed'));

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-needs-fill'));
    // With no other free agent available, the field can't be padded past
    // the 2 real entrants, so no bracket forms — but critically, the
    // committed filler must never appear in it.
    const usedIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedIds).not.toContain(PlayerId('filler-committed'));
  });

  it('never pads with a filler still alive in an earlier week draw — the repository commitment read the singles fill uses too', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-cross-week');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('busy-filler'));
    // Enough fillers that the resulting field (>4 pairs for an 8-draw)
    // produces a real round-1 match rather than an all-bye round.
    for (let i = 1; i <= 12; i++) await players.save(fillOnlyPlayer(`free-filler-${i}`));
    // A 14-day major's still-alive player: committed even though their
    // draw's week is not this one, so the same-week check cannot see it.
    tournaments.unfinishedCommitments.add(PlayerId('busy-filler'));

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const usedIds = tournament.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedIds).not.toContain(PlayerId('busy-filler'));
    expect(usedIds.some((id) => (id as string).startsWith('free-filler-'))).toBe(true);
  });

  it('pads with the STRONGEST free agents, not the pool order or their ranking (the measured field-strength fix)', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-strength-pad');
    // A strong manager pair, so the padding cap does not exclude the
    // strong candidates below (cap = their own pair strength).
    const a = strongFillOnlyPlayer('a');
    const b = strongFillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    // The pool's own read order is youngest-first: the 14 weak fillers
    // are saved FIRST, so a pool-order (or ranked-first) pick would take
    // them and leave the two genuinely strong free agents out. An 8-pair
    // draw needs 14 padded players and there are 16 candidates — so
    // exactly two are left out, and they must now be the two weakest.
    for (let i = 1; i <= 14; i++) await players.save(fillOnlyPlayer(`young-${i}`, 18 * 52));
    const strongA = strongFillOnlyPlayer('strong-a', 30 * 52);
    const strongB = strongFillOnlyPlayer('strong-b', 31 * 52);
    await players.save(strongA);
    await players.save(strongB);

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-strength-pad'));
    const usedIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedIds).toContain(strongA.id);
    expect(usedIds).toContain(strongB.id);
    const excludedYoung = Array.from({ length: 14 }, (_, i) => PlayerId(`young-${i + 1}`)).filter(
      (id) => !usedIds.includes(id),
    );
    expect(excludedYoung).toHaveLength(2);
  });

  it('never pads with a free agent stronger than the weakest real manager pair — the cap keeps padding from outmatching a manager (principle #1)', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-cap-pad');
    // A weak manager pair: strength ~36 (30 attributes + baseline affinity).
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    // Enough AT-OR-BELOW-cap fillers to complete the field (an 8-pair
    // draw needs 14 padded players), plus six far stronger candidates
    // that must never be used while under-cap supply lasts.
    for (let i = 1; i <= 14; i++) await players.save(fillOnlyPlayer(`weak-${i}`));
    for (let i = 1; i <= 6; i++) await players.save(strongFillOnlyPlayer(`strong-${i}`));

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-cap-pad'));
    const usedIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedIds).not.toContain(PlayerId('strong-1'));
    expect(usedIds).not.toContain(PlayerId('strong-6'));
    // Every padded player is one of the weak cohort: no anonymous filler
    // can sit above the manager pair's own level.
    const paddedIds = usedIds.filter((id) => id !== a.id && id !== b.id);
    expect(paddedIds).toHaveLength(14);
    for (const id of paddedIds) expect(String(id).startsWith('weak-')).toBe(true);
  });

  it('adds every padded filler to the run-wide commitment set so a later draw in the same run cannot reuse them', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-commitments');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);
    for (let i = 1; i <= 20; i++) await players.save(fillOnlyPlayer(`pad-${i}`));

    const commitments = new Set<PlayerId>();
    await useCase.form(tournament, { unfinishedCommitmentPlayerIds: commitments });

    const paddedIds = tournament.doublesPairs
      .flatMap((p) => [p.playerA, p.playerB])
      .filter((id) => id !== a.id && id !== b.id);
    expect(paddedIds.length).toBeGreaterThan(0);
    for (const id of paddedIds) expect(commitments.has(id)).toBe(true);
  });

  it('is a no-op for a tournament with no doubles draw at all', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 4 });

    const tournament = Tournament.open({
      name: 'Singles Only',
      id: TournamentId('t-singles-only'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 4 },
      drawSize: 16,
    });
    await tournaments.save(tournament);

    await useCase.form(tournament);

    expect(tournament.hasDoublesDrawStarted).toBe(false);
  });
});
