import Stripe from 'stripe';
import { BracketGenerator } from '@tennis-manager/domain';
import { StatisticalMatchSimulator } from '@tennis-manager/domain';
import { AcceleratedDeclinePolicy, PlayerAgingService, StandardAgingPolicy } from '@tennis-manager/domain';
import { HirePlayerUseCase } from '@tennis-manager/application';
import { OpenTournamentUseCase } from '@tennis-manager/application';
import { SimulateMatchUseCase } from '@tennis-manager/application';
import { AdvanceWorldWeekUseCase, SimulateDueMatchesUseCase } from '@tennis-manager/application';
import { Db } from './db/client';
import { DrizzlePlayerRepository } from './adapters/outbound/DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './adapters/outbound/DrizzleTournamentRepository';
import { DrizzleGameWorldRepository } from './adapters/outbound/DrizzleGameWorldRepository';
import { StripeBillingAdapter, StripeBillingConfig } from './adapters/outbound/StripeBillingAdapter';
import { FilesystemMatchLogStore } from './adapters/outbound/FilesystemMatchLogStore';
import { LoggingEventPublisher } from './adapters/outbound/LoggingEventPublisher';
import { MathRandomSource } from './adapters/outbound/MathRandomSource';

export interface CompositionOptions {
  db: Db;
  matchLogDirectory: string;
  matchLogPublicBaseUrl?: string;
  logEvent: (message: string, payload: Record<string, unknown>) => void;
  /** Omitted = dev placeholders: entitlement reads work (local table),
   * but checkout/webhook calls fail loudly until real keys are set. */
  stripe?: {
    secretKey: string;
    config: StripeBillingConfig;
  };
}

/** Steeper weekly decline for Pro-managed players — the built-in cost
 * of the 4-slot roster (CLAUDE.md principle #1). Placeholder factor,
 * to be tuned with the rest of the aging curve before launch. */
export const PRO_DECLINE_MULTIPLIER = 1.5;

export interface Dependencies {
  players: DrizzlePlayerRepository;
  tournaments: DrizzleTournamentRepository;
  worlds: DrizzleGameWorldRepository;
  billing: StripeBillingAdapter;
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

  const stripeSettings = options.stripe ?? {
    secretKey: process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder',
    config: {
      proPriceId: process.env.STRIPE_PRO_PRICE_ID ?? 'price_placeholder',
      successUrl: process.env.BILLING_SUCCESS_URL ?? 'http://localhost:3000/billing/success',
      cancelUrl: process.env.BILLING_CANCEL_URL ?? 'http://localhost:3000/billing/cancel',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_placeholder',
    },
  };
  const billing = new StripeBillingAdapter(options.db, new Stripe(stripeSettings.secretKey), stripeSettings.config);

  const worlds = new DrizzleGameWorldRepository(options.db);
  const simulateMatch = new SimulateMatchUseCase(tournaments, players, matchSimulator, matchLogs, events, bracketGenerator);

  const standardAgingPolicy = new StandardAgingPolicy();
  const standardAging = new PlayerAgingService(standardAgingPolicy);
  const proAging = new PlayerAgingService(new AcceleratedDeclinePolicy(standardAgingPolicy, PRO_DECLINE_MULTIPLIER));

  return {
    players,
    tournaments,
    worlds,
    billing,
    hirePlayer: new HirePlayerUseCase(players, events, billing),
    openTournament: new OpenTournamentUseCase(tournaments, bracketGenerator),
    simulateMatch,
    advanceWorldWeek: new AdvanceWorldWeekUseCase(worlds, players, billing, standardAging, proAging, events),
    simulateDueMatches: new SimulateDueMatchesUseCase(tournaments, simulateMatch),
  };
}
