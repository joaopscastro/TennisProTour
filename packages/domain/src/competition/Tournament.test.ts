import { describe, expect, it } from 'vitest';
import { PlayerId, PairId, TournamentId } from '../shared/ids';
import { BracketGenerator } from './BracketGenerator';
import { Tournament, TournamentOpenProps } from './Tournament';
import { StandardTournamentSchedulePolicy } from './TournamentSchedulePolicy';

function baseProps(overrides: Partial<TournamentOpenProps> = {}): TournamentOpenProps {
  return {
    id: TournamentId('t1'),
    name: 'Test Championship',
    tier: 'challenger',
    surface: 'hard',
    weekScheduled: { season: 1, week: 1 },
    drawSize: 16,
    ...overrides,
  };
}

describe('Tournament.roundScheduledDay', () => {
  const policy = new StandardTournamentSchedulePolicy();

  it('defaults startDay to 1 and maps a one-week round to the same week', () => {
    const t = Tournament.open(baseProps({ tier: 'challenger', drawSize: 16 }));
    expect(t.startDay).toBe(1);
    expect(t.roundScheduledDay(1, policy)).toEqual({ season: 1, week: 1, day: 1 });
    expect(t.roundScheduledDay(4, policy)).toEqual({ season: 1, week: 1, day: 4 });
  });

  it('honors a non-default startDay, rolling into the next week', () => {
    const t = Tournament.open(baseProps({ tier: 'challenger', drawSize: 16, startDay: 5 }));
    expect(t.roundScheduledDay(1, policy)).toEqual({ season: 1, week: 1, day: 5 });
    expect(t.roundScheduledDay(4, policy)).toEqual({ season: 1, week: 2, day: 1 });
  });

  it('spreads a two-week major across a fortnight', () => {
    const t = Tournament.open(baseProps({ tier: 'major', ageBand: null, drawSize: 128, startDay: 1 }));
    expect(t.roundScheduledDay(1, policy)).toEqual({ season: 1, week: 1, day: 2 });
    expect(t.roundScheduledDay(7, policy)).toEqual({ season: 1, week: 2, day: 7 });
  });

  it('rejects an invalid startDay', () => {
    expect(() => Tournament.open(baseProps({ startDay: 0 }))).toThrow(/startDay/);
    expect(() => Tournament.open(baseProps({ startDay: 8 }))).toThrow(/startDay/);
  });
});

describe('Tournament.open — ageBand invariant', () => {
  it('defaults ageBand to null for a senior tier and accepts it', () => {
    const tournament = Tournament.open(baseProps({ tier: 'tour' }));
    expect(tournament.ageBand).toBeNull();
  });

  it('rejects a senior tier that is given an ageBand', () => {
    expect(() => Tournament.open(baseProps({ tier: 'major', ageBand: 'u16' }))).toThrow(/must not have an ageBand/);
  });

  it('accepts a junior tier paired with an ageBand, and stores it', () => {
    const u14 = Tournament.open(baseProps({ tier: 'j100', ageBand: 'u14' }));
    expect(u14.ageBand).toBe('u14');

    const u16 = Tournament.open(baseProps({ tier: 'j100', ageBand: 'u16' }));
    expect(u16.ageBand).toBe('u16');
  });

  it('rejects a junior tier with no ageBand', () => {
    expect(() => Tournament.open(baseProps({ tier: 'j30' }))).toThrow(/requires an ageBand/);
  });

  it('applies the same six J-grades identically to both age bands — the tier alone does not encode age', () => {
    const u14 = Tournament.open(baseProps({ tier: 'j500', ageBand: 'u14' }));
    const u16 = Tournament.open(baseProps({ tier: 'j500', ageBand: 'u16' }));
    expect(u14.tier).toBe(u16.tier);
    expect(u14.ageBand).not.toBe(u16.ageBand);
  });
});

describe('Tournament.open — name is required and cannot be blank', () => {
  it('accepts a real non-blank name', () => {
    const tournament = Tournament.open(baseProps({ name: 'Meridian Brazil Championship' }));
    expect(tournament.name).toBe('Meridian Brazil Championship');
  });

  it('rejects an empty string name', () => {
    expect(() => Tournament.open(baseProps({ name: '' }))).toThrow(/name must not be empty/);
  });

  it('rejects a whitespace-only name', () => {
    expect(() => Tournament.open(baseProps({ name: '   ' }))).toThrow(/name must not be empty/);
  });

  it('reconstitute() enforces the same non-blank name guard', () => {
    expect(() =>
      Tournament.reconstitute({ ...baseProps({ name: '' }), entrants: [], rounds: [] }),
    ).toThrow(/name must not be empty/);
  });
});

describe('Tournament.startWithBracket — refuses a field too sparse to produce a single real match', () => {
  const generator = new BracketGenerator();

  it('refuses a 16-draw with 8 unseeded entrants — every one lands on the bye side of its pair, zero real matches', () => {
    const tournament = Tournament.open(baseProps());
    for (let i = 1; i <= 8; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: null });
    }
    const bracket = generator.generate(tournament.entrants, 16);
    expect(bracket[0].matches).toHaveLength(0); // confirms the premise, not just the guard

    expect(() => tournament.startWithBracket(bracket)).toThrow(/too sparse a field/);
    expect(tournament.hasStarted).toBe(false); // the throw must not leave it half-started
  });

  it('accepts a 16-draw with 9 unseeded entrants — the threshold where BracketGenerator first produces a real match', () => {
    const tournament = Tournament.open(baseProps());
    for (let i = 1; i <= 9; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: null });
    }
    const bracket = generator.generate(tournament.entrants, 16);
    expect(bracket[0].matches.length).toBeGreaterThan(0);

    expect(() => tournament.startWithBracket(bracket)).not.toThrow();
    expect(tournament.hasStarted).toBe(true);
  });

  it('still refuses a literally empty bracket (no rounds at all), same as before this guard existed', () => {
    const tournament = Tournament.open(baseProps());
    tournament.registerEntrant({ playerId: PlayerId('p1'), seed: null });

    expect(() => tournament.startWithBracket([])).toThrow(/empty bracket/);
  });
});

describe('Tournament — the qualifying draw (full [Q] model)', () => {
  const generator = new BracketGenerator();
  const policy = new StandardTournamentSchedulePolicy();

  /** A 16-draw tour event: 2 reserved places contested by an 8-player
   * qualifying field over 2 rounds. */
  function withQualifying(overrides: Partial<TournamentOpenProps> = {}): Tournament {
    return Tournament.open(
      baseProps({ tier: 'tour', drawSize: 16, qualifyingDrawSize: 8, qualifierSlots: 2, ...overrides }),
    );
  }

  it('holds no qualifying by default — every pre-existing tournament is untouched', () => {
    const plain = Tournament.open(baseProps());
    expect(plain.hasQualifying).toBe(false);
    expect(plain.qualifyingDrawSize).toBe(0);
    expect(plain.qualifierSlots).toBe(0);
    expect(plain.mainDrawCapacity).toBe(plain.drawSize);
    expect(plain.qualifyingRoundCount).toBe(0);
    expect(plain.getQualifyingRounds()).toHaveLength(0);
  });

  it('reserves main-draw places that direct registration cannot take', () => {
    const tournament = withQualifying();
    expect(tournament.mainDrawCapacity).toBe(14);
    for (let i = 1; i <= 14; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`da${i}`), seed: i });
    }
    expect(() => tournament.registerEntrant({ playerId: PlayerId('da15'), seed: null })).toThrow(/draw is full/);
    // The qualifying field is a separate capacity and is still open.
    expect(() =>
      tournament.registerEntrant({ playerId: PlayerId('q1'), seed: null, draw: 'qualifying' }),
    ).not.toThrow();
  });

  it('refuses a qualifying entrant at a tournament that holds no qualifying', () => {
    const plain = Tournament.open(baseProps());
    expect(() => plain.registerEntrant({ playerId: PlayerId('q1'), seed: null, draw: 'qualifying' })).toThrow(
      /holds no qualifying/,
    );
  });

  it('rejects an inconsistent or too-shallow qualifying configuration', () => {
    expect(() => Tournament.open(baseProps({ qualifyingDrawSize: 8 }))).toThrow(/either holds no qualifying/);
    // 2 players per slot would be a single qualifying round, which
    // qualifyingWinners() cannot read safely (round-1 byes).
    expect(() => Tournament.open(baseProps({ qualifyingDrawSize: 4, qualifierSlots: 2 }))).toThrow(
      /at least two qualifying rounds/,
    );
  });

  it('plays qualifying on the opening days and shifts the main draw behind it', () => {
    const tournament = withQualifying();
    expect(tournament.qualifyingRoundCount).toBe(2);
    expect(tournament.roundScheduledDay(1, policy, 'qualifying')).toEqual({ season: 1, week: 1, day: 1 });
    expect(tournament.roundScheduledDay(2, policy, 'qualifying')).toEqual({ season: 1, week: 1, day: 2 });
    // Main round 1 would be day 1 without qualifying; it now follows the
    // two qualifying days.
    expect(tournament.roundScheduledDay(1, policy)).toEqual({ season: 1, week: 1, day: 3 });
    expect(tournament.roundScheduledDay(4, policy)).toEqual({ season: 1, week: 1, day: 6 });
  });

  it('counts as started once qualifying is seeded, even though the main draw is not made yet', () => {
    const tournament = withQualifying();
    for (let i = 1; i <= 8; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`q${i}`), seed: null, draw: 'qualifying' });
    }
    tournament.startQualifyingWithBracket(generator.generate(tournament.qualifyingEntrants, 8));

    expect(tournament.hasStarted).toBe(true);
    expect(tournament.hasMainDraw).toBe(false);
    // Registration is closed for both fields, exactly as for any started
    // tournament.
    expect(() => tournament.registerEntrant({ playerId: PlayerId('late'), seed: null })).toThrow(/already started/);
  });

  it('never counts a qualifying win towards main-draw ranking points', () => {
    const tournament = withQualifying();
    for (let i = 1; i <= 8; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`q${i}`), seed: null, draw: 'qualifying' });
    }
    tournament.startQualifyingWithBracket(generator.generate(tournament.qualifyingEntrants, 8));
    const first = tournament.getQualifyingRounds()[0];
    const winner = first.matches[0].entrantA;
    tournament.recordMatchOutcome(
      1,
      0,
      { winner, loser: first.matches[0].entrantB, setScores: [{ winnerGames: 6, loserGames: 0 }] },
      'qualifying',
    );

    // The load-bearing separation: pointsFor() is fed roundsWonBy(player)
    // — the MAIN draw — so a qualifying win must not inflate it.
    expect(tournament.roundsWonBy(winner)).toBe(0);
    expect(tournament.roundsWonBy(winner, 'qualifying')).toBe(1);
  });
});

describe('Tournament doubles draw (P7b)', () => {
  function withDoubles(): Tournament {
    return Tournament.open(baseProps({ tier: 'challenger', drawSize: 16, doublesDrawSize: 4 }));
  }

  it('holds no doubles draw when doublesDrawSize is 0', () => {
    const t = Tournament.open(baseProps());
    expect(t.hasDoubles).toBe(false);
    expect(() => t.registerDoublesEntrant(PlayerId('p1'))).toThrow(/no doubles draw/);
  });

  it('registers solo entrants and refuses a duplicate', () => {
    const t = withDoubles();
    t.registerDoublesEntrant(PlayerId('p1'));
    t.registerDoublesEntrant(PlayerId('p2'));
    expect(t.doublesEntrants).toEqual([PlayerId('p1'), PlayerId('p2')]);
    expect(() => t.registerDoublesEntrant(PlayerId('p1'))).toThrow(/already in/);
  });

  it('seeds the doubles bracket from formed pairs, and starts the tournament', () => {
    const t = withDoubles();
    const pairs = [
      { pairId: PairId('t1-d0'), playerA: PlayerId('a'), playerB: PlayerId('b') },
      { pairId: PairId('t1-d1'), playerA: PlayerId('c'), playerB: PlayerId('d') },
      { pairId: PairId('t1-d2'), playerA: PlayerId('e'), playerB: PlayerId('f') },
      { pairId: PairId('t1-d3'), playerA: PlayerId('g'), playerB: PlayerId('h') },
    ];
    const generator = new BracketGenerator();
    const rounds = generator.generate(pairs.map((p) => ({ playerId: p.pairId, seed: null })), 4);
    t.startDoublesWithBracket(pairs, rounds);

    expect(t.hasDoublesDrawStarted).toBe(true);
    expect(t.hasStarted).toBe(true);
    expect(t.doublesPlayersFor(PairId('t1-d0'))!.playerA).toBe(PlayerId('a'));
    expect(t.getDoublesRounds()[0].matches).toHaveLength(2);
  });

  it('records a doubles outcome and awards doubles rounds won by pair', () => {
    const t = withDoubles();
    const pairs = [
      { pairId: PairId('t1-d0'), playerA: PlayerId('a'), playerB: PlayerId('b') },
      { pairId: PairId('t1-d1'), playerA: PlayerId('c'), playerB: PlayerId('d') },
      { pairId: PairId('t1-d2'), playerA: PlayerId('e'), playerB: PlayerId('f') },
      { pairId: PairId('t1-d3'), playerA: PlayerId('g'), playerB: PlayerId('h') },
    ];
    const generator = new BracketGenerator();
    t.startDoublesWithBracket(pairs, generator.generate(pairs.map((p) => ({ playerId: p.pairId, seed: null })), 4));

    const r1 = t.getDoublesRounds()[0];
    const winner = r1.matches[0].entrantA;
    const loser = r1.matches[0].entrantB;
    t.recordDoublesMatchOutcome(1, 0, { winner, loser, setScores: [{ winnerGames: 6, loserGames: 0 }] });

    expect(t.doublesRoundsWonBy(winner)).toBe(1);
    expect(t.doublesRoundsWonBy(loser)).toBe(0);
    expect(t.isDoublesComplete()).toBe(false); // 4-pair draw = 2 rounds, only 1 played
  });

  it('seeds and plays a doubles qualifying bracket, then promotes its winners (P8)', () => {
    const t = Tournament.open(
      baseProps({ tier: 'major', drawSize: 32, doublesDrawSize: 16, doublesQualifyingDrawSize: 8, doublesQualifierSlots: 2 }),
    );
    expect(t.hasDoublesQualifying).toBe(true);
    expect(t.doublesDirectAcceptanceCapacity).toBe(14); // 16 - 2

    const qpairs = [
      { pairId: PairId('t1-qd0'), playerA: PlayerId('a'), playerB: PlayerId('b') },
      { pairId: PairId('t1-qd1'), playerA: PlayerId('c'), playerB: PlayerId('d') },
      { pairId: PairId('t1-qd2'), playerA: PlayerId('e'), playerB: PlayerId('f') },
      { pairId: PairId('t1-qd3'), playerA: PlayerId('g'), playerB: PlayerId('h') },
      { pairId: PairId('t1-qd4'), playerA: PlayerId('i'), playerB: PlayerId('j') },
      { pairId: PairId('t1-qd5'), playerA: PlayerId('k'), playerB: PlayerId('l') },
      { pairId: PairId('t1-qd6'), playerA: PlayerId('m'), playerB: PlayerId('n') },
      { pairId: PairId('t1-qd7'), playerA: PlayerId('o'), playerB: PlayerId('p') },
    ];
    const generator = new BracketGenerator();
    t.startDoublesQualifyingWithBracket(
      qpairs,
      generator.generate(qpairs.map((p) => ({ playerId: p.pairId, seed: null })), 8),
    );
    expect(t.hasDoublesQualifyingDrawStarted).toBe(true);
    expect(t.hasDoublesDrawStarted).toBe(false); // deferred main-draw seeding
    expect(t.hasStarted).toBe(true);

    // Play out the 2 qualifying rounds (8 pairs → 4 → 2 winners), adding
    // round 2 the way SimulateDoublesMatchUseCase does.
    const r1 = t.getDoublesRounds('qualifying')[0];
    for (let i = 0; i < r1.matches.length; i++) {
      const m = r1.matches[i];
      t.recordDoublesMatchOutcome(1, i, { winner: m.entrantA, loser: m.entrantB, setScores: [{ winnerGames: 6, loserGames: 0 }] }, 'qualifying');
    }
    // Re-fetch the completed round (recordDoublesMatchOutcome replaces the
    // round object in place) before generating round 2 from it.
    const completedRound1 = t.getDoublesRounds('qualifying')[0];
    t.addDoublesRound(
      generator.generateNextRound(
        completedRound1,
        qpairs.map((p) => ({ playerId: p.pairId, seed: null })),
        8,
      ),
      'qualifying',
    );
    const r2 = t.getDoublesRounds('qualifying')[1];
    for (let i = 0; i < r2.matches.length; i++) {
      const m = r2.matches[i];
      t.recordDoublesMatchOutcome(2, i, { winner: m.entrantA, loser: m.entrantB, setScores: [{ winnerGames: 6, loserGames: 0 }] }, 'qualifying');
    }

    expect(t.isDoublesQualifyingComplete()).toBe(true);
    expect(t.doublesQualifyingWinners()).toHaveLength(2);

    // Promote the two winners into the main draw's reserved slots.
    for (const w of t.doublesQualifyingWinners()) t.promoteDoublesQualifier(w);
    expect(t.doublesPairs).toHaveLength(2);
    expect(t.doublesPlayersFor(PairId('t1-qd0'))!.playerA).toBe(PlayerId('a'));
  });
});
