import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  GameWeek,
  MatchOutcome,
  PlayerId,
  Tournament,
  TournamentId,
  WorldId,
  entryTypeOf,
  qualifierSlotsFor,
  qualifyingDrawSizeFor,
} from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { PromoteQualifiersUseCase } from './PromoteQualifiersUseCase';

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

  async findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [];
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

const WEEK: GameWeek = { season: 1, week: 1 };
const WORLD = WorldId('main');

function decide(winner: PlayerId, loser: PlayerId): MatchOutcome {
  return { winner, loser, setScores: [{ winnerGames: 6, loserGames: 3 }] };
}

/**
 * A real `tour` tournament with real qualifying, sized by the real
 * policy (16-draw: 2 reserved places, an 8-player qualifying field over
 * 2 rounds), played out through the aggregate's own API — never by
 * reaching into its state.
 */
function openWithQualifying(id: TournamentId, directAcceptances: number): Tournament {
  const tournament = Tournament.open({
    id,
    name: 'Qualifying Bridge Open',
    tier: 'tour',
    surface: 'hard',
    weekScheduled: WEEK,
    drawSize: 16,
    qualifyingDrawSize: qualifyingDrawSizeFor('tour', 16),
    qualifierSlots: qualifierSlotsFor('tour', 16),
  });
  for (let i = 1; i <= directAcceptances; i++) {
    tournament.registerEntrant({ playerId: PlayerId(`da${i}`), seed: i, entryType: 'DA' });
  }
  for (let i = 1; i <= tournament.qualifyingDrawSize; i++) {
    tournament.registerEntrant({ playerId: PlayerId(`q${i}`), seed: null, draw: 'qualifying', entryType: 'Q' });
  }
  const generator = new BracketGenerator();
  tournament.startQualifyingWithBracket(generator.generate(tournament.qualifyingEntrants, tournament.qualifyingDrawSize));
  return tournament;
}

/** Plays every remaining qualifying match, lowest id winning each one,
 * generating each next qualifying round exactly as SimulateMatchUseCase
 * does. Stops of its own accord at the last qualifying round. */
function playOutQualifying(tournament: Tournament): void {
  const generator = new BracketGenerator();
  for (let round = 1; round <= tournament.qualifyingRoundCount; round++) {
    const current = tournament.getQualifyingRounds()[round - 1];
    for (const [index, match] of current.matches.entries()) {
      if (match.outcome) continue;
      const [winner, loser] = [match.entrantA, match.entrantB].sort();
      tournament.recordMatchOutcome(round, index, decide(winner, loser), 'qualifying');
    }
    if (!tournament.isFinalRound(round, 'qualifying')) {
      tournament.addRound(
        generator.generateNextRound(
          tournament.getQualifyingRounds()[round - 1],
          tournament.qualifyingEntrants,
          tournament.qualifyingDrawSize,
        ),
        'qualifying',
      );
    }
  }
}

describe('PromoteQualifiersUseCase', () => {
  it('promotes exactly the qualifying survivors into the main draw and seeds it', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithQualifying(TournamentId('t-promote'), 14);
    playOutQualifying(tournament);
    await tournaments.save(tournament);

    const useCase = new PromoteQualifiersUseCase(tournaments, new BracketGenerator());
    const result = await useCase.execute({ worldId: WORLD });

    // A 16-draw tour reserves 2 places, so exactly 2 players come
    // through an 8-player field — not one champion, not all four
    // semi-finalists.
    expect(result).toEqual({ mainDrawsSeeded: 1, promoted: 2 });

    const saved = (await tournaments.findById(TournamentId('t-promote')))!;
    expect(saved.hasMainDraw).toBe(true);
    expect(saved.mainEntrants).toHaveLength(16);
    // The promoted players keep the `[Q]` label that says how they got
    // in, and the ones who lost in qualifying are NOT in the main draw.
    const promotedIds = saved.mainEntrants.filter((e) => entryTypeOf(e) === 'Q').map((e) => e.playerId);
    expect(promotedIds).toHaveLength(2);
    expect(saved.qualifyingEntrants).toHaveLength(6);
    for (const id of promotedIds) {
      expect(saved.qualifyingEntrants.some((e) => e.playerId === id)).toBe(false);
    }
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithQualifying(TournamentId('t-idempotent'), 14);
    playOutQualifying(tournament);
    await tournaments.save(tournament);

    const useCase = new PromoteQualifiersUseCase(tournaments, new BracketGenerator());
    await useCase.execute({ worldId: WORLD });
    const second = await useCase.execute({ worldId: WORLD });

    expect(second).toEqual({ mainDrawsSeeded: 0, promoted: 0 });
    const saved = (await tournaments.findById(TournamentId('t-idempotent')))!;
    expect(saved.mainEntrants).toHaveLength(16);
  });

  it('leaves a tournament alone while its qualifying draw is still being played', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournament = openWithQualifying(TournamentId('t-mid-qualifying'), 14);
    // Only the first qualifying round is decided.
    const firstRound = tournament.getQualifyingRounds()[0];
    for (const [index, match] of firstRound.matches.entries()) {
      const [winner, loser] = [match.entrantA, match.entrantB].sort();
      tournament.recordMatchOutcome(1, index, decide(winner, loser), 'qualifying');
    }
    await tournaments.save(tournament);

    const result = await new PromoteQualifiersUseCase(tournaments, new BracketGenerator()).execute({ worldId: WORLD });

    expect(result).toEqual({ mainDrawsSeeded: 0, promoted: 0 });
    expect((await tournaments.findById(TournamentId('t-mid-qualifying')))!.hasMainDraw).toBe(false);
  });

  it('never touches a tournament that holds no qualifying', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const plain = Tournament.open({
      id: TournamentId('t-plain'),
      name: 'No Qualifying Open',
      tier: 'futures',
      surface: 'clay',
      weekScheduled: WEEK,
      drawSize: 16,
    });
    for (let i = 1; i <= 16; i++) plain.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    plain.startWithBracket(new BracketGenerator().generate(plain.entrants, 16));
    await tournaments.save(plain);

    const result = await new PromoteQualifiersUseCase(tournaments, new BracketGenerator()).execute({ worldId: WORLD });

    expect(result).toEqual({ mainDrawsSeeded: 0, promoted: 0 });
  });

  it('records the promotions even when the resulting main draw is too sparse to seed', async () => {
    const tournaments = new InMemoryTournamentRepository();
    // No direct acceptances at all: only the 2 qualifiers reach the main
    // draw, and a 16-draw with 2 entrants gives both of them a bye, so
    // there is no real round-1 match to play (see
    // Tournament.startWithBracket). The qualifying result must not be
    // thrown away because of that.
    const tournament = openWithQualifying(TournamentId('t-sparse'), 0);
    playOutQualifying(tournament);
    await tournaments.save(tournament);

    const result = await new PromoteQualifiersUseCase(tournaments, new BracketGenerator()).execute({ worldId: WORLD });

    expect(result).toEqual({ mainDrawsSeeded: 0, promoted: 2 });
    const saved = (await tournaments.findById(TournamentId('t-sparse')))!;
    expect(saved.hasMainDraw).toBe(false);
    expect(saved.mainEntrants).toHaveLength(2);
  });
});
