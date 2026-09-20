import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  GameWeek,
  ManagerId,
  MatchOutcome,
  PairId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';
import { PromoteDoublesQualifiersUseCase } from './PromoteDoublesQualifiersUseCase';

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

function attributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(40), forehand: Skill.of(40), backhand: Skill.of(40), volley: Skill.of(40) },
    physical: { speed: Skill.of(40), stamina: Skill.of(40), strength: Skill.of(40) },
    mental: { consistency: Skill.of(40), clutch: Skill.of(40) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function filler(id: string): Player {
  return Player.generateFillOnly(PlayerId(id), `Filler ${id}`, 20 * 52, 'prime', attributes(), 'BR', 70, {
    speed: 70,
    stamina: 70,
    strength: 70,
  });
}

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<string, Tournament>();

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

  async findByPlayerAndWeek(): Promise<Tournament[]> {
    return [];
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
  }
}

const WEEK: GameWeek = { season: 1, week: 1 };
const WORLD = WorldId('main');

function decide(winner: PairId, loser: PairId): MatchOutcome<PairId> {
  return { winner, loser, setScores: [{ winnerGames: 6, loserGames: 3 }] };
}

/** A tournament with a real doubles qualifying field (4 pairs, 2
 * qualifier slots, 2 rounds) and a large doubles main draw (16) so the
 * 2 qualifying survivors alone are far too sparse to seed a real match —
 * the exact "promoted, but seeding fails" state this suite tests. */
function openWithDoublesQualifying(id: TournamentId): Tournament {
  const tournament = Tournament.open({
    id,
    name: 'Doubles Qualifying Bridge Open',
    tier: 'tour',
    surface: 'hard',
    weekScheduled: WEEK,
    drawSize: 64,
    doublesDrawSize: 16,
    doublesQualifyingDrawSize: 4,
    doublesQualifierSlots: 2,
  });
  const pairs = [1, 2, 3, 4].map((i) => ({ pairId: PairId(`q${i}`), playerA: PlayerId(`q${i}a`), playerB: PlayerId(`q${i}b`) }));
  const bracketGenerator = new BracketGenerator();
  const rounds = bracketGenerator.generate(
    pairs.map((p) => ({ playerId: p.pairId, seed: null })),
    4,
  );
  tournament.startDoublesQualifyingWithBracket(pairs, rounds);
  return tournament;
}

/** Plays every remaining doubles qualifying match, lowest pairId winning
 * each one, generating each next round exactly as SimulateDoublesMatchUseCase
 * does. Stops of its own accord at the last qualifying round. */
function playOutDoublesQualifying(tournament: Tournament): void {
  const generator = new BracketGenerator();
  for (let round = 1; round <= tournament.doublesQualifyingRoundCount; round++) {
    const current = tournament.getDoublesRounds('qualifying')[round - 1];
    for (const [index, match] of current.matches.entries()) {
      if (match.outcome) continue;
      const [winner, loser] = [match.entrantA, match.entrantB].sort();
      tournament.recordDoublesMatchOutcome(round, index, decide(winner, loser), 'qualifying');
    }
    if (!tournament.isDoublesFinalRound(round, 'qualifying')) {
      tournament.addDoublesRound(
        generator.generateNextRound(
          tournament.getDoublesRounds('qualifying')[round - 1],
          tournament.doublesQualifyingPairs.map((p) => ({ playerId: p.pairId, seed: null })),
          tournament.doublesQualifyingDrawSize,
        ),
        'qualifying',
      );
    }
  }
}

describe('PromoteDoublesQualifiersUseCase', () => {
  it('records the promotions even when the resulting doubles main draw is too sparse to seed', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithDoublesQualifying(TournamentId('t-doubles-sparse'));
    playOutDoublesQualifying(tournament);
    await tournaments.save(tournament);

    const result = await new PromoteDoublesQualifiersUseCase(tournaments, new BracketGenerator()).execute({ worldId: WORLD });

    expect(result).toEqual({ mainDrawsSeeded: 0, promoted: 2 });
    const saved = (await tournaments.findById(TournamentId('t-doubles-sparse')))!;
    expect(saved.hasDoublesDrawStarted).toBe(false);
    expect(saved.doublesPairs).toHaveLength(2);
  });

  it('does not corrupt the doubles field on a subsequent tick when the too-sparse main draw was never seeded (real bug, found live)', async () => {
    // The doubles mirror of the singles fix: `promoteDoublesQualifier` has
    // no "already promoted" guard at all (unlike the singles side, which
    // at least throws) — before this fix, re-running this use case against
    // a tournament stuck in the "promoted, too sparse to seed" state would
    // silently push the SAME pair into `_doublesPairs` a second time on
    // every subsequent day tick, corrupting the field. Found live during a
    // fast-tick 5-season playtest run.
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithDoublesQualifying(TournamentId('t-doubles-sparse-repeat'));
    playOutDoublesQualifying(tournament);
    await tournaments.save(tournament);

    const useCase = new PromoteDoublesQualifiersUseCase(tournaments, new BracketGenerator());
    const first = await useCase.execute({ worldId: WORLD });
    expect(first).toEqual({ mainDrawsSeeded: 0, promoted: 2 });

    const second = await useCase.execute({ worldId: WORLD });
    expect(second).toEqual({ mainDrawsSeeded: 0, promoted: 0 });

    const saved = (await tournaments.findById(TournamentId('t-doubles-sparse-repeat')))!;
    expect(saved.doublesPairs).toHaveLength(2); // never double-promoted
  });

  it('pads a sparse promoted doubles main draw from the free-agent pool and seeds it', async () => {
    // The doubles analogue of the singles dead-end fix: 2 promoted pairs
    // on a 16-pair draw is too sparse to seed, so the main draw is topped
    // up with filler pairs rather than sitting unseeded forever.
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithDoublesQualifying(TournamentId('t-doubles-sparse-padded'));
    playOutDoublesQualifying(tournament);
    await tournaments.save(tournament);

    const players = new InMemoryPlayerRepository();
    for (let i = 1; i <= 40; i++) await players.save(filler(`dfill-${i}`));

    const useCase = new PromoteDoublesQualifiersUseCase(tournaments, new BracketGenerator(), players);
    const result = await useCase.execute({ worldId: WORLD });

    expect(result.promoted).toBe(2);
    expect(result.mainDrawsSeeded).toBe(1);
    const saved = (await tournaments.findById(TournamentId('t-doubles-sparse-padded')))!;
    expect(saved.hasDoublesDrawStarted).toBe(true);
    expect(saved.doublesPairs).toHaveLength(16);
  });
});
