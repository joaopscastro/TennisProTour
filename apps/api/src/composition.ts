import { ManagerId } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { StatisticalMatchSimulator } from '@tennis-manager/domain';
import { PlayerAgingService, StandardAgingPolicy } from '@tennis-manager/domain';
import { HirePlayerUseCase } from '@tennis-manager/application';
import { OpenTournamentUseCase } from '@tennis-manager/application';
import { SimulateMatchUseCase } from '@tennis-manager/application';
import { AdvanceWorldWeekUseCase, SimulateDueMatchesUseCase } from '@tennis-manager/application';
import { Db } from './db/client';
import { DrizzlePlayerRepository } from './adapters/outbound/DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './adapters/outbound/DrizzleTournamentRepository';
import { DrizzleGameWorldRepository } from './adapters/outbound/DrizzleGameWorldRepository';
import { FilesystemMatchLogStore } from './adapters/outbound/FilesystemMatchLogStore';
import { LoggingEventPublisher } from './adapters/outbound/LoggingEventPublisher';
import { MathRandomSource } from './adapters/outbound/MathRandomSource';

export interface CompositionOptions {
  db: Db;
  matchLogDirectory: string;
  matchLogPublicBaseUrl?: string;
  logEvent: (message: string, payload: Record<string, unknown>) => void;
}

export interface Dependencies {
  players: DrizzlePlayerRepository;
  tournaments: DrizzleTournamentRepository;
  worlds: DrizzleGameWorldRepository;
  hirePlayer: HirePlayerUseCase;
  openTournament: OpenTournamentUseCase;
  simulateMatch: SimulateMatchUseCase;
  advanceWorldWeek: AdvanceWorldWeekUseCase;
  simulateDueMatches: SimulateDueMatchesUseCase;
}

/**
 * The composition root: the one place that knows concrete adapter
 * classes and wires them into use cases via plain constructor
 * injection. No DI container on purpose (see CLAUDE.md's reasoning
 * against NestJS) — the dependency graph is small enough to read top
 * to bottom, and the compiler checks it.
 */
export function buildDependencies(options: CompositionOptions): Dependencies {
  const players = new DrizzlePlayerRepository(options.db);
  const tournaments = new DrizzleTournamentRepository(options.db);
  const matchLogs = new FilesystemMatchLogStore({
    directory: options.matchLogDirectory,
    publicBaseUrl: options.matchLogPublicBaseUrl,
  });
  const events = new LoggingEventPublisher(options.logEvent);
  const bracketGenerator = new BracketGenerator();
  const matchSimulator = new StatisticalMatchSimulator(new MathRandomSource());

  // Free-tier roster cap; becomes a Billing/Manager & Progression
  // entitlement lookup once those contexts exist (the use case already
  // takes it as a function for exactly that reason).
  const maxRosterSizeFor = async (_managerId: ManagerId): Promise<number> => 3;

  const worlds = new DrizzleGameWorldRepository(options.db);
  const simulateMatch = new SimulateMatchUseCase(tournaments, players, matchSimulator, matchLogs, events, bracketGenerator);

  return {
    players,
    tournaments,
    worlds,
    hirePlayer: new HirePlayerUseCase(players, events, maxRosterSizeFor),
    openTournament: new OpenTournamentUseCase(tournaments, bracketGenerator),
    simulateMatch,
    advanceWorldWeek: new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new PlayerAgingService(new StandardAgingPolicy()),
      events,
    ),
    simulateDueMatches: new SimulateDueMatchesUseCase(tournaments, simulateMatch),
  };
}
