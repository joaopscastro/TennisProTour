import { describe, expect, it } from 'vitest';
import {
  GameWeek,
  GameWorld,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  RankingLedgerEntry,
  Skill,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { JUNIOR_WEEKLY_ENTRY_CAP } from './juniorEntryCap';
import { RegisterEntrantUseCase } from './RegisterEntrantUseCase';

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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
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

function fixedAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
    physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
    mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

/** Registers a player fixture at a given age in the given repository —
 * most tests here don't care about age at all (senior tournaments have
 * no age check), but every player entering a junior-tier tournament
 * now needs a real, saved Player with a real age for the new
 * age-eligibility check to read. */
async function savePlayer(players: InMemoryPlayerRepository, id: PlayerId, ageInWeeks: number): Promise<void> {
  const player = Player.hire(id, `Player ${id}`, ageInWeeks, fixedAttributes(), ManagerId('m1'));
  player.pullDomainEvents();
  await players.save(player);
}

const U14_AGE = 10 * 52;
const U16_AGE = 15 * 52;
const SENIOR_AGE = 25 * 52;

function openJuniorTournament(id: TournamentId, weekScheduled: GameWeek = { season: 1, week: 1 }, ageBand: 'u14' | 'u16' = 'u14'): Tournament {
  return Tournament.open({ name: 'Test Tournament',
    id,
    tier: 'j100',
    ageBand,
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
  });
}

function openTournament(id: TournamentId, weekScheduled: GameWeek = { season: 1, week: 1 }): Tournament {
  return Tournament.open({ name: 'Test Tournament',
    id,
    tier: 'challenger',
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
  });
}

describe('RegisterEntrantUseCase', () => {
  it('registers a player into an already-open tournament and persists it', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const players = new InMemoryPlayerRepository();
    const tournamentId = TournamentId('t1');
    await tournaments.save(openTournament(tournamentId));

    const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
    await useCase.execute({ tournamentId, playerId: PlayerId('p1') });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.entrants).toEqual([{ playerId: PlayerId('p1'), seed: null }]);
  });

  it('throws when the tournament does not exist', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const players = new InMemoryPlayerRepository();
    const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

    await expect(useCase.execute({ tournamentId: TournamentId('ghost'), playerId: PlayerId('p1') })).rejects.toThrow(
      /not found/,
    );
  });

  it('throws when the tournament has already started (delegated to the aggregate)', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const players = new InMemoryPlayerRepository();
    const tournamentId = TournamentId('t1');
    const tournament = openTournament(tournamentId);
    for (let i = 1; i <= 16; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    }
    const [round1] = new BracketGenerator().generate(tournament.entrants, 16);
    tournament.startWithBracket([round1]);
    await tournaments.save(tournament);

    const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
    await expect(useCase.execute({ tournamentId, playerId: PlayerId('p17') })).rejects.toThrow(/already started/);
  });

  it('auto-starts the bracket the moment the last slot fills, and not before', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const players = new InMemoryPlayerRepository();
    const tournamentId = TournamentId('t1');
    await tournaments.save(openTournament(tournamentId));

    const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
    for (let i = 1; i <= 15; i++) {
      await useCase.execute({ tournamentId, playerId: PlayerId(`p${i}`), seed: i });
      expect((await tournaments.findById(tournamentId))!.hasStarted).toBe(false);
    }

    await useCase.execute({ tournamentId, playerId: PlayerId('p16'), seed: 16 });

    const started = await tournaments.findById(tournamentId);
    expect(started!.hasStarted).toBe(true);
    expect(started!.entrants).toHaveLength(16);
    expect(started!.getRounds()).toHaveLength(1);
    expect(started!.getRounds()[0].matches).toHaveLength(8);
  });

  describe('age eligibility for junior tournaments', () => {
    it('allows a player whose current age matches the tournament band exactly', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const tournamentId = TournamentId('u14-t1');
      await tournaments.save(openJuniorTournament(tournamentId, undefined, 'u14'));
      await savePlayer(players, PlayerId('p1'), U14_AGE);

      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
      await expect(useCase.execute({ tournamentId, playerId: PlayerId('p1') })).resolves.toBeUndefined();
    });

    it('allows a U14-eligible player to "play up" into a U16 draw', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const tournamentId = TournamentId('u16-t1');
      await tournaments.save(openJuniorTournament(tournamentId, undefined, 'u16'));
      await savePlayer(players, PlayerId('p1'), U14_AGE);

      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
      await expect(useCase.execute({ tournamentId, playerId: PlayerId('p1') })).resolves.toBeUndefined();
    });

    it('blocks a U16-eligible player from "playing down" into a U14 draw', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const tournamentId = TournamentId('u14-t1');
      await tournaments.save(openJuniorTournament(tournamentId, undefined, 'u14'));
      await savePlayer(players, PlayerId('p1'), U16_AGE);

      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
      await expect(useCase.execute({ tournamentId, playerId: PlayerId('p1') })).rejects.toThrow(/not age-eligible/);

      const tournament = await tournaments.findById(tournamentId);
      expect(tournament!.entrants).toHaveLength(0);
    });

    it('blocks a senior player from entering either junior band', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const u14Id = TournamentId('u14-t1');
      const u16Id = TournamentId('u16-t1');
      await tournaments.save(openJuniorTournament(u14Id, undefined, 'u14'));
      await tournaments.save(openJuniorTournament(u16Id, undefined, 'u16'));
      await savePlayer(players, PlayerId('p1'), SENIOR_AGE);

      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
      await expect(useCase.execute({ tournamentId: u14Id, playerId: PlayerId('p1') })).rejects.toThrow(/not age-eligible/);
      await expect(useCase.execute({ tournamentId: u16Id, playerId: PlayerId('p1') })).rejects.toThrow(/not age-eligible/);
    });

    it('never applies any age check to the senior tour — a senior-age player registers into a senior tournament exactly as before', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const tournamentId = TournamentId('senior-t1');
      await tournaments.save(openTournament(tournamentId));
      await savePlayer(players, PlayerId('p1'), U14_AGE); // even a junior-age player: unrestricted on the senior tour

      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());
      await expect(useCase.execute({ tournamentId, playerId: PlayerId('p1') })).resolves.toBeUndefined();
    });
  });

  describe('weekly entry cap', () => {
    it(`rejects registering a player into a ${JUNIOR_WEEKLY_ENTRY_CAP + 1}th junior tournament in the same GameWeek`, async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('junior-player');
      await savePlayer(players, player, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      // Fill up the cap first.
      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // One more, same week, must be rejected.
      const oneTooMany = TournamentId('j-over-cap');
      await tournaments.save(openJuniorTournament(oneTooMany, week));

      await expect(useCase.execute({ tournamentId: oneTooMany, playerId: player })).rejects.toThrow(
        new RegExp(`already entered ${JUNIOR_WEEKLY_ENTRY_CAP} junior tournaments`),
      );

      // The rejected registration must not have partially applied.
      const rejected = await tournaments.findById(oneTooMany);
      expect(rejected!.entrants).toHaveLength(0);
    });

    it('allows entering junior tournaments up to the cap, and allows a different player unaffected by another player’s count', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('junior-player');
      const otherPlayer = PlayerId('another-junior-player');
      await savePlayer(players, player, U14_AGE);
      await savePlayer(players, otherPlayer, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // A different tournament, different player, same week — must not
      // be blocked by `player`'s cap.
      const otherTournamentId = TournamentId('j-other-player');
      await tournaments.save(openJuniorTournament(otherTournamentId, week));
      await expect(
        useCase.execute({ tournamentId: otherTournamentId, playerId: otherPlayer }),
      ).resolves.toBeUndefined();
    });

    it('does not count a junior entry from a different GameWeek against the cap', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week1: GameWeek = { season: 1, week: 1 };
      const week2: GameWeek = { season: 1, week: 2 };
      const player = PlayerId('junior-player');
      await savePlayer(players, player, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`week1-j${i}`);
        await tournaments.save(openJuniorTournament(id, week1));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // A new week resets the cap.
      const nextWeekTournament = TournamentId('week2-j1');
      await tournaments.save(openJuniorTournament(nextWeekTournament, week2));
      await expect(
        useCase.execute({ tournamentId: nextWeekTournament, playerId: player }),
      ).resolves.toBeUndefined();
    });

    it('allows registering into a week 2 tournament AND a week 3 tournament in the same sitting, while still blocking a second entry within the SAME week once that week is at cap', async () => {
      // Specifically audits that the weekly cap is scoped PER WEEK, not
      // globally across a player's whole season — the two real,
      // distinct behaviors the cap must get right at once: entries in
      // genuinely different future weeks must never contend with each
      // other, while entries in the SAME week must still be capped.
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week2: GameWeek = { season: 1, week: 2 };
      const week3: GameWeek = { season: 1, week: 3 };
      const player = PlayerId('multi-week-player');
      await savePlayer(players, player, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      // Fill week 2 up to the cap first.
      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`week2-j${i}`);
        await tournaments.save(openJuniorTournament(id, week2));
        await expect(useCase.execute({ tournamentId: id, playerId: player })).resolves.toBeUndefined();
      }

      // A week 3 entry, in the SAME sitting, must succeed — different
      // week, unaffected by week 2 already being at cap.
      const week3Tournament = TournamentId('week3-j1');
      await tournaments.save(openJuniorTournament(week3Tournament, week3));
      await expect(
        useCase.execute({ tournamentId: week3Tournament, playerId: player }),
      ).resolves.toBeUndefined();

      // One MORE week 2 entry, beyond the cap, must still be rejected —
      // proving the cap is real per-week enforcement, not bypassed just
      // because a later week's entry was allowed through.
      const oneTooManyWeek2 = TournamentId('week2-one-too-many');
      await tournaments.save(openJuniorTournament(oneTooManyWeek2, week2));
      await expect(
        useCase.execute({ tournamentId: oneTooManyWeek2, playerId: player }),
      ).rejects.toThrow(new RegExp(`already entered ${JUNIOR_WEEKLY_ENTRY_CAP} junior tournaments`));

      // Sanity: the player really did land in both week 2 (at cap) and
      // week 3 (one entry), confirmed by reading real registrations
      // back, not just by absence of a thrown error.
      const week2Entries = await tournaments.findByPlayerAndWeek(player, week2);
      const week3Entries = await tournaments.findByPlayerAndWeek(player, week3);
      expect(week2Entries).toHaveLength(JUNIOR_WEEKLY_ENTRY_CAP);
      expect(week3Entries).toHaveLength(1);
    });

    it('allows registering into NON-ADJACENT future weeks (week 2 and week 4, skipping week 3 entirely) in the same sitting, while still blocking a second entry within the SAME week — a permanent regression check for the frontend planner bug where a missing managerId silently broke exactly this flow', async () => {
      // Deliberately non-adjacent (week 2 + week 4, not week 2 + week
      // 3) so this can never be satisfied by an off-by-one that only
      // happens to work for CONSECUTIVE weeks — e.g. a scoping bug
      // that accidentally treats "the next week" as special instead of
      // treating every week as an independent, exact (season, week)
      // key. Week 3 is asserted to stay completely empty throughout,
      // proving it was never touched by either registration.
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week2: GameWeek = { season: 1, week: 2 };
      const week3: GameWeek = { season: 1, week: 3 };
      const week4: GameWeek = { season: 1, week: 4 };
      const player = PlayerId('non-adjacent-week-player');
      await savePlayer(players, player, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      // Fill week 2 up to the cap.
      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`nonadj-week2-j${i}`);
        await tournaments.save(openJuniorTournament(id, week2));
        await expect(useCase.execute({ tournamentId: id, playerId: player })).resolves.toBeUndefined();
      }

      // A week 4 entry — two weeks ahead, past the untouched week 3 —
      // must succeed in the SAME sitting, completely unaffected by
      // week 2 already being at cap.
      const week4Tournament = TournamentId('nonadj-week4-j1');
      await tournaments.save(openJuniorTournament(week4Tournament, week4));
      await expect(
        useCase.execute({ tournamentId: week4Tournament, playerId: player }),
      ).resolves.toBeUndefined();

      // A further week 2 entry, beyond the cap, must still be rejected
      // — the cap wasn't accidentally reset or bypassed by the week 4
      // registration going through.
      const oneTooManyWeek2 = TournamentId('nonadj-week2-one-too-many');
      await tournaments.save(openJuniorTournament(oneTooManyWeek2, week2));
      await expect(
        useCase.execute({ tournamentId: oneTooManyWeek2, playerId: player }),
      ).rejects.toThrow(new RegExp(`already entered ${JUNIOR_WEEKLY_ENTRY_CAP} junior tournaments`));

      // Read every week back for real: week 2 at cap, week 3 untouched
      // (never entered, never blocked — it was simply never involved),
      // week 4 has exactly the one real entry.
      const week2Entries = await tournaments.findByPlayerAndWeek(player, week2);
      const week3Entries = await tournaments.findByPlayerAndWeek(player, week3);
      const week4Entries = await tournaments.findByPlayerAndWeek(player, week4);
      expect(week2Entries).toHaveLength(JUNIOR_WEEKLY_ENTRY_CAP);
      expect(week3Entries).toHaveLength(0);
      expect(week4Entries).toHaveLength(1);
    });

    it('caps the senior tour at one tournament per week (SENIOR_WEEKLY_ENTRY_CAP) — a second same-week senior entry is rejected', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('senior-player');
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      // First senior entry this week succeeds.
      const first = TournamentId('senior1');
      await tournaments.save(openTournament(first, week));
      await expect(useCase.execute({ tournamentId: first, playerId: player })).resolves.toBeUndefined();

      // A second senior tournament the SAME week must be rejected — a
      // player can only play one tournament per week.
      const second = TournamentId('senior2');
      await tournaments.save(openTournament(second, week));
      await expect(useCase.execute({ tournamentId: second, playerId: player })).rejects.toThrow(
        /already entered 1 senior tournaments/,
      );

      // The rejected registration must not have partially applied.
      const rejected = await tournaments.findById(second);
      expect(rejected!.entrants).toHaveLength(0);

      // A DIFFERENT week is unaffected — the cap is per-week.
      const nextWeek: GameWeek = { season: 1, week: 2 };
      const third = TournamentId('senior3');
      await tournaments.save(openTournament(third, nextWeek));
      await expect(useCase.execute({ tournamentId: third, playerId: player })).resolves.toBeUndefined();
    });

    it('does not let a senior registration count against, or be blocked by, a junior weekly count', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('mixed-player');
      await savePlayer(players, player, U14_AGE);
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // Already at the junior cap for the week — a senior-tier entry
      // the same week must still succeed.
      const seniorId = TournamentId('senior-same-week');
      await tournaments.save(openTournament(seniorId, week));
      await expect(useCase.execute({ tournamentId: seniorId, playerId: player })).resolves.toBeUndefined();
    });
  });

  describe('qualifying / direct acceptance (the light [Q] model)', () => {
    /** A real RankPositionQuery over in-memory fakes — the same query
     * the composition root injects, never a stub, so what these tests
     * exercise is the actual ranking read the rule depends on. */
    async function qualifyingSetup(rankedPoints: Array<{ playerId: string; points: number }>) {
      const tournaments = new InMemoryTournamentRepository();
      const players = new InMemoryPlayerRepository();
      const worlds = new InMemoryGameWorldRepository();
      await worlds.save(
        GameWorld.reconstitute({ id: WorldId('main'), currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }),
      );
      const ledger = new InMemoryRankingLedgerRepository();
      for (const [index, ranked] of rankedPoints.entries()) {
        await ledger.append({
          playerId: PlayerId(ranked.playerId),
          tournamentId: TournamentId(`past-${index}`),
          tier: 'challenger',
          ageBand: null,
          points: ranked.points,
          weekEarned: { season: 1, week: 1 },
        });
      }
      const rankPosition = new RankPositionQuery(ledger, worlds, WorldId('main'), 'senior');
      const useCase = new RegisterEntrantUseCase(tournaments, players, new BracketGenerator(), rankPosition);
      return { tournaments, useCase };
    }

    function openTourTournament(id: TournamentId): Tournament {
      return Tournament.open({
        name: 'Qualifying Test Open',
        id,
        tier: 'tour',
        surface: 'hard',
        weekScheduled: { season: 1, week: 1 },
        drawSize: 16,
      });
    }

    it('marks an above-cutoff registrant as a direct acceptance', async () => {
      const { tournaments, useCase } = await qualifyingSetup([{ playerId: 'top', points: 5000 }]);
      const tournamentId = TournamentId('tour-da');
      await tournaments.save(openTourTournament(tournamentId));

      await useCase.execute({ tournamentId, playerId: PlayerId('top') });

      const saved = await tournaments.findById(tournamentId);
      expect(saved!.entrants[0].entryType).toBe('DA');
    });

    it('marks an unranked registrant as a qualifier, and refuses one past the reserved slots', async () => {
      const { tournaments, useCase } = await qualifyingSetup([]);
      const tournamentId = TournamentId('tour-q');
      await tournaments.save(openTourTournament(tournamentId));

      // A 16-draw reserves 2 qualifier slots (an eighth of the draw).
      await useCase.execute({ tournamentId, playerId: PlayerId('q1') });
      await useCase.execute({ tournamentId, playerId: PlayerId('q2') });
      await expect(useCase.execute({ tournamentId, playerId: PlayerId('q3') })).rejects.toThrow(
        /outside direct acceptance/,
      );

      const saved = await tournaments.findById(tournamentId);
      expect(saved!.entrants.map((e) => e.entryType)).toEqual(['Q', 'Q']);
    });

    it('never gates a tier that holds no qualifying — the lower ladder stays freely enterable', async () => {
      const { tournaments, useCase } = await qualifyingSetup([]);
      const tournamentId = TournamentId('challenger-open');
      await tournaments.save(openTournament(tournamentId));

      await expect(useCase.execute({ tournamentId, playerId: PlayerId('nobody') })).resolves.toBeUndefined();
      const saved = await tournaments.findById(tournamentId);
      expect(saved!.entrants[0].entryType).toBeUndefined();
    });
  });
});
