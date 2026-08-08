import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  GameWeek,
  GameWorld,
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  PlayerRarityTier,
  RankingBand,
  RankingLedgerEntry,
  Skill,
  StandardAgingPolicy,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, RankingLedgerRepository, TalentPoolCandidateRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { StartDueTournamentsUseCase } from './StartDueTournamentsUseCase';

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
      (t) => t.weekScheduled.season === week.season && t.weekScheduled.week === week.week && t.entrants.some((e) => e.playerId === playerId),
    );
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
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

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }

  all(): Player[] {
    return [...this.store.values()];
  }
}

class InMemoryTalentPoolCandidateRepository implements TalentPoolCandidateRepository {
  private readonly store = new Map<TalentPoolCandidateId, TalentPoolCandidate>();

  async findById(id: TalentPoolCandidateId): Promise<TalentPoolCandidate | null> {
    return this.store.get(id) ?? null;
  }

  async findAvailable(): Promise<TalentPoolCandidate[]> {
    return [...this.store.values()].filter((c) => c.isAvailable());
  }

  async save(candidate: TalentPoolCandidate): Promise<void> {
    this.store.set(candidate.id, candidate);
  }

  async claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null> {
    const candidate = this.store.get(id);
    if (!candidate || !candidate.isAvailable()) return null;
    candidate.markClaimed(managerId);
    return candidate;
  }

  all(): TalentPoolCandidate[] {
    return [...this.store.values()];
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

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function generatedPlayer(overrides: Partial<GeneratedPlayer> = {}): GeneratedPlayer {
  return {
    name: 'Free Agent',
    nationality: 'BR',
    tier: 'common' as PlayerRarityTier,
    ageInWeeks: 750, // ~14.4yo, u14-eligible
    attributes: attributes(30),
    potentialCeiling: 55,
    potentialTier: 'promising',
    physicalCeilings: { speed: 55, stamina: 55, strength: 55 },
    ...overrides,
  };
}

const worldId = WorldId('main');

async function setup(currentWeek: GameWeek) {
  const tournaments = new InMemoryTournamentRepository();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
  const players = new InMemoryPlayerRepository();
  const talentPoolCandidates = new InMemoryTalentPoolCandidateRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const bracketGenerator = new BracketGenerator();
  const rankPositionByBand: Record<RankingBand, RankPositionQuery> = {
    senior: new RankPositionQuery(rankingLedger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(rankingLedger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(rankingLedger, worlds, worldId, 'u16'),
  };
  const useCase = new StartDueTournamentsUseCase(tournaments, worlds, players, talentPoolCandidates, bracketGenerator, rankPositionByBand, new StandardAgingPolicy());
  return { tournaments, worlds, players, talentPoolCandidates, rankingLedger, useCase };
}

/** A senior tournament open for registration, due this tick (scheduled
 * for week 1, currentWeek passed to setup() is always >= that). */
function openSeniorTournament(id: string, drawSize: 16 = 16): Tournament {
  return Tournament.open({ id: TournamentId(id), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize });
}

function realEntrant(tournament: Tournament, playerId: string): void {
  tournament.registerEntrant({ playerId: PlayerId(playerId), seed: null });
}

describe('StartDueTournamentsUseCase', () => {
  it('fills a tournament with too few real registrants from tier-appropriate unclaimed players (both fillOnly Players and fresh candidates), then starts it', async () => {
    const { tournaments, players, talentPoolCandidates, useCase } = await setup({ season: 1, week: 4 });

    // 8 real registrants — comfortably past the 9-entrant threshold a
    // 16-draw needs to produce a real round-1 match once 2 fillers are
    // added (see Tournament.test.ts's "startWithBracket — refuses a
    // field too sparse" suite for exactly where that threshold sits;
    // 8 real + 2 filled = 10, same shape BracketGenerator.test.ts's own
    // "gives byes to the top seeds" case already proves produces 2 real
    // matches).
    const tournament = openSeniorTournament('t1');
    for (let i = 1; i <= 8; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    // A long-term fillOnly free agent, senior-eligible (any non-junior age).
    const fillOnlyPlayer = Player.generateFillOnly(PlayerId('filler-fillonly'), 'Filler FillOnly', 25 * 52, 'prime', attributes(30));
    await players.save(fillOnlyPlayer);

    // A fresh, still-technically-claimable candidate — also eligible.
    const freshCandidate = TalentPoolCandidate.generate(TalentPoolCandidateId('filler-fresh'), generatedPlayer({ ageInWeeks: 22 * 52 }), { season: 1, week: 4 });
    await talentPoolCandidates.save(freshCandidate);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(1);
    expect(result.filled).toBe(2);

    const started = await tournaments.findById(TournamentId('t1'));
    expect(started!.hasStarted).toBe(true);
    const entrantIds = started!.entrants.map((e) => e.playerId).sort();
    const expectedIds = ['filler-fillonly', 'filler-fresh', 'real-1', 'real-2', 'real-3', 'real-4', 'real-5', 'real-6', 'real-7', 'real-8'].sort();
    expect(entrantIds).toEqual(expectedIds);

    // The fresh candidate was converted into a real, permanent fillOnly
    // Player — not deleted, not left dangling as a non-Player entrant.
    const convertedPlayer = await players.findById(PlayerId('filler-fresh'));
    expect(convertedPlayer).not.toBeNull();
    expect(convertedPlayer!.fillOnly).toBe(true);
    expect((await talentPoolCandidates.findById(TalentPoolCandidateId('filler-fresh')))!.status).toBe('expired');
  });

  it('a fully-registered tournament starts with exactly its real entrants and triggers no fill at all', async () => {
    const { tournaments, players, talentPoolCandidates, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-full');
    for (let i = 1; i <= 16; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    // Plenty of eligible fillers exist — they must be left completely
    // untouched since there's nothing to fill.
    const fillOnlyPlayer = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 25 * 52, 'prime', attributes(30));
    await players.save(fillOnlyPlayer);
    const freshCandidate = TalentPoolCandidate.generate(TalentPoolCandidateId('filler-2'), generatedPlayer({ ageInWeeks: 22 * 52 }), { season: 1, week: 4 });
    await talentPoolCandidates.save(freshCandidate);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(1);
    expect(result.filled).toBe(0);

    const started = await tournaments.findById(TournamentId('t-full'));
    expect(started!.entrants).toHaveLength(16);
    expect(started!.entrants.every((e) => e.playerId.startsWith('real-'))).toBe(true);

    // Untouched: still a real Player with fillOnly true (unchanged),
    // still available and unclaimed.
    expect((await players.findById(PlayerId('filler-1')))!.fillOnly).toBe(true);
    expect((await talentPoolCandidates.findById(TalentPoolCandidateId('filler-2')))!.status).toBe('available');
  });

  it('skips an unclaimed player already committed to another tournament the same week, picking a different eligible one instead', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    // A separate tournament, same scheduled week, ALREADY fully
    // registered (16/16, no fill needed) — one of its real entrants
    // happens to be filler-1, simulating "already committed elsewhere
    // this GameWeek" without competing with t-needs-one for slots.
    const otherTournament = openSeniorTournament('t-other');
    realEntrant(otherTournament, 'filler-1');
    for (let i = 1; i <= 15; i++) realEntrant(otherTournament, `other-${i}`);
    await tournaments.save(otherTournament);

    const tournament = openSeniorTournament('t-needs-one');
    for (let i = 1; i <= 15; i++) realEntrant(tournament, `real-${i}`); // 1 slot short
    await tournaments.save(tournament);

    const committedFiller = Player.generateFillOnly(PlayerId('filler-1'), 'Committed Filler', 25 * 52, 'prime', attributes(30));
    await players.save(committedFiller);
    const freeFiller = Player.generateFillOnly(PlayerId('filler-2'), 'Free Filler', 25 * 52, 'prime', attributes(30));
    await players.save(freeFiller);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(2); // both t-other (no fill needed) and t-needs-one start
    expect(result.filled).toBe(1); // only t-needs-one's single slot

    const filled = await tournaments.findById(TournamentId('t-needs-one'));
    const entrantIds = filled!.entrants.map((e) => e.playerId);
    expect(entrantIds).toContain('filler-2'); // the free one was used
    expect(entrantIds).not.toContain('filler-1'); // the committed one was skipped
  });

  it('excludes an age-band-ineligible unclaimed player from a junior tournament (senior filler cannot play down into u14)', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const junior = Tournament.open({
      id: TournamentId('t-u14'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    realEntrant(junior, 'real-1');
    await tournaments.save(junior);

    // Too old for u14 (a senior-age fillOnly player) — must be excluded.
    const tooOld = Player.generateFillOnly(PlayerId('filler-too-old'), 'Too Old', 25 * 52, 'prime', attributes(30));
    await players.save(tooOld);
    // Genuinely u14-eligible.
    const eligible = Player.generateFillOnly(PlayerId('filler-u14'), 'U14 Eligible', 13 * 52 + 10, 'youth', attributes(30));
    await players.save(eligible);

    await useCase.execute({ worldId });

    const filled = await tournaments.findById(TournamentId('t-u14'));
    const entrantIds = filled!.entrants.map((e) => e.playerId);
    expect(entrantIds).toContain('filler-u14');
    expect(entrantIds).not.toContain('filler-too-old');
  });

  it('leaves a tournament open (does not start it) when it stays at zero entrants — no real registrants and no eligible fillers', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-empty');
    await tournaments.save(tournament); // zero entrants, no fillers seeded at all

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    const stillOpen = await tournaments.findById(TournamentId('t-empty'));
    expect(stillOpen!.hasStarted).toBe(false);
  });

  it('leaves a tournament open, does NOT crash or start it, when fill still leaves too sparse a field to produce a single real round-1 match', async () => {
    // A real, previously-latent BracketGenerator/Tournament bug this
    // guards against: for a 16-draw, any entrant count from 1 to 8
    // lands every entrant on the bye side of its standard seed-slot
    // pairing (1v16, 8v9, 4v13, ...) — real matches only start
    // appearing at 9 entrants. Found live via the seed script's own
    // walkthrough, not just imagined — see Tournament.test.ts's
    // "startWithBracket — refuses a field too sparse" suite for the
    // exact threshold proof.
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-too-sparse');
    await tournaments.save(tournament); // zero real registrants

    // Only 5 eligible fillers exist — nowhere near the 9-entrant
    // threshold a 16-draw needs for even one real match.
    for (let i = 1; i <= 5; i++) {
      await players.save(Player.generateFillOnly(PlayerId(`filler-${i}`), `Filler ${i}`, 25 * 52, 'prime', attributes(30)));
    }

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    expect(result.filled).toBe(5); // the 5 available fillers WERE registered...
    const stillOpen = await tournaments.findById(TournamentId('t-too-sparse'));
    expect(stillOpen!.hasStarted).toBe(false); // ...but starting was correctly refused
    expect(stillOpen!.entrants).toHaveLength(5); // registrations persist for a later tick to build on
  });

  it('does not touch a tournament whose scheduled week has not arrived yet', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 2 });

    const tournament = Tournament.open({
      id: TournamentId('t-future'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 5 }, // in the future relative to currentWeek
      drawSize: 16,
    });
    realEntrant(tournament, 'real-1');
    await tournaments.save(tournament);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    expect((await tournaments.findById(TournamentId('t-future')))!.hasStarted).toBe(false);
  });

  it('does NOT start a tournament scheduled for THIS exact week — real managers must get at least one full week to register before fill/start ever considers it', async () => {
    // Mirrors exactly how GenerateJuniorTournamentsUseCase opens a
    // junior tournament with weekScheduled: currentWeek, then this use
    // case runs on that SAME tick right after — an inclusive `>= 0`
    // due-check would force-start it before any manager ever saw it.
    const { tournaments, useCase } = await setup({ season: 1, week: 3 });

    const tournament = Tournament.open({
      id: TournamentId('t-this-week'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 3 }, // exactly currentWeek
      drawSize: 16,
    });
    realEntrant(tournament, 'real-1');
    await tournaments.save(tournament);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    expect((await tournaments.findById(TournamentId('t-this-week')))!.hasStarted).toBe(false);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup({ season: 1, week: 1 });

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
