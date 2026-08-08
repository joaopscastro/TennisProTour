import Stripe from 'stripe';
import { BracketGenerator } from '@tennis-manager/domain';
import { StatisticalMatchSimulator } from '@tennis-manager/domain';
import { AcceleratedDeclinePolicy, PlayerAgingService, StandardAgingPolicy } from '@tennis-manager/domain';
import { StandardRankingPointsTable } from '@tennis-manager/domain';
import { StandardPlayerGenerationPolicy } from '@tennis-manager/domain';
import { WorldId } from '@tennis-manager/domain';
import { StandardTrainingPolicy } from '@tennis-manager/domain';
import { StandardManagerXpPolicy } from '@tennis-manager/domain';
import { StandardTalentClaimPricingPolicy, TalentClaimPricingPolicy } from '@tennis-manager/domain';
import { StandardCoachConversionPolicy, CoachConversionPolicy } from '@tennis-manager/domain';
import { ClaimTalentPoolCandidateUseCase } from '@tennis-manager/application';
import { ConvertPlayerToCoachUseCase } from '@tennis-manager/application';
import { CreateCustomPlayerUseCase } from '@tennis-manager/application';
import { RefreshTalentPoolUseCase } from '@tennis-manager/application';
import { GenesisSeedFillOnlyPlayersUseCase } from '@tennis-manager/application';
import { OpenTournamentUseCase } from '@tennis-manager/application';
import { OpenRegistrationUseCase } from '@tennis-manager/application';
import { SimulateMatchUseCase } from '@tennis-manager/application';
import { AdvanceWorldWeekUseCase, SimulateDueMatchesUseCase } from '@tennis-manager/application';
import { GenerateJuniorTournamentsUseCase } from '@tennis-manager/application';
import { SetTrainingFocusUseCase } from '@tennis-manager/application';
import { ReleasePlayerUseCase } from '@tennis-manager/application';
import { RegisterEntrantUseCase } from '@tennis-manager/application';
import { RankPositionQuery } from '@tennis-manager/application';
import { Db } from './db/client';
import { DrizzlePlayerRepository } from './adapters/outbound/DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './adapters/outbound/DrizzleTournamentRepository';
import { DrizzleGameWorldRepository } from './adapters/outbound/DrizzleGameWorldRepository';
import { DrizzleRankingLedgerRepository } from './adapters/outbound/DrizzleRankingLedgerRepository';
import { DrizzleTalentPoolCandidateRepository } from './adapters/outbound/DrizzleTalentPoolCandidateRepository';
import { DrizzleManagerXpRepository } from './adapters/outbound/DrizzleManagerXpRepository';
import { DrizzleTalentClaimAdapter } from './adapters/outbound/DrizzleTalentClaimAdapter';
import { DrizzleCoachRepository } from './adapters/outbound/DrizzleCoachRepository';
import { DrizzleRosterDashboardQuery } from './adapters/outbound/DrizzleRosterDashboardQuery';
import { StripeBillingAdapter, StripeBillingConfig } from './adapters/outbound/StripeBillingAdapter';
import { FilesystemMatchLogStore } from './adapters/outbound/FilesystemMatchLogStore';
import { LoggingEventPublisher } from './adapters/outbound/LoggingEventPublisher';
import { MathRandomSource } from './adapters/outbound/MathRandomSource';
import { CryptoIdGenerator } from './adapters/outbound/CryptoIdGenerator';
import { ClerkAuthAdapter, DevelopmentAuthAdapter } from './adapters/outbound/ClerkAuthAdapter';
import { DrizzleManagerAccountRepository } from './adapters/outbound/DrizzleManagerAccountRepository';
import { EnsureManagerAccountUseCase } from '@tennis-manager/application';

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

/** Single implicit game-world at MVP — same env var and 'main' default
 * apps/worker uses to create/advance the one GameWorld row, so ranking
 * reads and the weekly tick agree on which world's clock they're
 * reading. Becomes per-request/per-manager once multi-world arrives.
 * Exported so worldRoutes.ts can read the same world's currentWeek
 * without re-deriving its own (possibly diverging) WorldId. */
export const WORLD_ID = WorldId(process.env.WORLD_ID ?? 'main');

export interface Dependencies {
  managers: DrizzleManagerAccountRepository;
  auth: ClerkAuthAdapter | DevelopmentAuthAdapter;
  ensureManagerAccount: EnsureManagerAccountUseCase;
  authMode: 'clerk' | 'development';
  players: DrizzlePlayerRepository;
  tournaments: DrizzleTournamentRepository;
  worlds: DrizzleGameWorldRepository;
  rankingLedger: DrizzleRankingLedgerRepository;
  /** The senior tour's rank-position query (band: 'senior') — what the
   * roster dashboard's rank column reads today. The two junior bands
   * (rankPositionU14/rankPositionU16) are wired below for the same
   * reason coach conversion shipped with no HTTP route yet (see
   * CLAUDE.md's Manager & Progression status): the domain/query layer
   * is real and tested ahead of any UI consuming it. */
  rankPosition: RankPositionQuery;
  rankPositionU14: RankPositionQuery;
  rankPositionU16: RankPositionQuery;
  talentPoolCandidates: DrizzleTalentPoolCandidateRepository;
  managerXp: DrizzleManagerXpRepository;
  coaches: DrizzleCoachRepository;
  /** Exposed on Dependencies (not just built inline in buildDependencies)
   * so routes can compute the exact same real numbers a use case would
   * — e.g. a talent-pool claim's XP cost or a coach conversion's
   * preview cost/rating — without duplicating the formula or
   * instantiating a second, possibly-drifted policy instance. */
  talentClaimPricingPolicy: TalentClaimPricingPolicy;
  coachConversionPolicy: CoachConversionPolicy;
  rosterDashboard: DrizzleRosterDashboardQuery;
  billing: StripeBillingAdapter;
  idGenerator: CryptoIdGenerator;
  claimTalentPoolCandidate: ClaimTalentPoolCandidateUseCase;
  createCustomPlayer: CreateCustomPlayerUseCase;
  refreshTalentPool: RefreshTalentPoolUseCase;
  /** One-time-per-world genesis seed (docs/tournament-fill-system.md) —
   * called from apps/api/src/scripts/genesisSeedFillOnlyPlayers.ts, not
   * from any recurring worker tick. Wired here anyway, same "real,
   * tested use case ahead of any UI/route consuming it" precedent as
   * ConvertPlayerToCoachUseCase originally shipped with (see CLAUDE.md's
   * Manager & Progression status history). */
  genesisSeedFillOnlyPlayers: GenesisSeedFillOnlyPlayersUseCase;
  openTournament: OpenTournamentUseCase;
  openRegistration: OpenRegistrationUseCase;
  registerEntrant: RegisterEntrantUseCase;
  simulateMatch: SimulateMatchUseCase;
  advanceWorldWeek: AdvanceWorldWeekUseCase;
  /** Weekly junior-ladder content generation — see its own doc comment
   * for why this exists at all: before it, nothing ever created a
   * junior tournament automatically. Run from the same worker handler
   * as advanceWorldWeek, gated on that use case's `advanced` result. */
  generateJuniorTournaments: GenerateJuniorTournamentsUseCase;
  simulateDueMatches: SimulateDueMatchesUseCase;
  setTrainingFocus: SetTrainingFocusUseCase;
  releasePlayer: ReleasePlayerUseCase;
  convertPlayerToCoach: ConvertPlayerToCoachUseCase;
}

/**
 * The composition root: the one place that knows concrete adapter
 * classes and wires them into use cases via plain constructor
 * injection. No DI container on purpose (see CLAUDE.md's reasoning
 * against NestJS) — the dependency graph is small enough to read top
 * to bottom, and the compiler checks it.
 */
export function buildDependencies(options: CompositionOptions): Dependencies {
  const authMode = process.env.AUTH_MODE ?? (process.env.NODE_ENV === 'production' ? 'clerk' : 'development');
  if (authMode !== 'clerk' && authMode !== 'development') throw new Error('AUTH_MODE must be clerk or development');
  if (authMode === 'clerk' && !process.env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is required when AUTH_MODE=clerk');
  if (authMode === 'clerk' && process.env.NODE_ENV === 'production' && !process.env.CLERK_AUTHORIZED_PARTIES) {
    throw new Error('CLERK_AUTHORIZED_PARTIES is required in production');
  }

  const managers = new DrizzleManagerAccountRepository(options.db);
  const auth = authMode === 'clerk'
    ? new ClerkAuthAdapter(process.env.CLERK_SECRET_KEY!, (process.env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((value) => value.trim()).filter(Boolean))
    : new DevelopmentAuthAdapter();
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
  const rankingLedger = new DrizzleRankingLedgerRepository(options.db);
  const rankPosition = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'senior');
  const rankPositionU14 = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'u14');
  const rankPositionU16 = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'u16');
  const talentPoolCandidates = new DrizzleTalentPoolCandidateRepository(options.db);
  const managerXp = new DrizzleManagerXpRepository(options.db);
  const managerXpPolicy = new StandardManagerXpPolicy();
  const talentClaim = new DrizzleTalentClaimAdapter(options.db);
  const talentClaimPricingPolicy = new StandardTalentClaimPricingPolicy();
  const coaches = new DrizzleCoachRepository(options.db);
  const coachConversionPolicy = new StandardCoachConversionPolicy();
  const idGenerator = new CryptoIdGenerator();
  const ensureManagerAccount = new EnsureManagerAccountUseCase(managers, idGenerator);
  // A separate RandomSource instance from the match simulator's — both
  // just wrap Math.random() statelessly, so sharing wouldn't be wrong,
  // but keeping them distinct avoids implying any ordering coupling
  // between match simulation and player generation.
  const generationPolicy = new StandardPlayerGenerationPolicy();
  const generationRandom = new MathRandomSource();
  // A fresh StandardAgingPolicy instance, independent of the one wired
  // into standardAging below — it's stateless, and the roster
  // dashboard's stage-transition estimate is always against the BASE
  // policy regardless of Pro status anyway (see formatStageNote's doc
  // comment), so there's no reason to share the aging services' instance.
  const rosterDashboard = new DrizzleRosterDashboardQuery(options.db, new StandardAgingPolicy(), {
    senior: rankPosition,
    u14: rankPositionU14,
    u16: rankPositionU16,
  });
  const rankingPointsTable = new StandardRankingPointsTable();
  const simulateMatch = new SimulateMatchUseCase(
    tournaments,
    players,
    matchSimulator,
    matchLogs,
    events,
    bracketGenerator,
    rankingPointsTable,
    rankingLedger,
    managerXpPolicy,
    managerXp,
  );

  const standardAgingPolicy = new StandardAgingPolicy();
  const standardAging = new PlayerAgingService(standardAgingPolicy);
  const proAging = new PlayerAgingService(new AcceleratedDeclinePolicy(standardAgingPolicy, PRO_DECLINE_MULTIPLIER));
  const trainingPolicy = new StandardTrainingPolicy();

  const openTournament = new OpenTournamentUseCase(tournaments, bracketGenerator);
  const openRegistration = new OpenRegistrationUseCase(tournaments);
  const generateJuniorTournaments = new GenerateJuniorTournamentsUseCase(worlds, openRegistration, openTournament, {
    u14: rankPositionU14,
    u16: rankPositionU16,
  }, idGenerator);

  return {
    managers,
    auth,
    ensureManagerAccount,
    authMode,
    players,
    tournaments,
    worlds,
    rankingLedger,
    rankPosition,
    rankPositionU14,
    rankPositionU16,
    talentPoolCandidates,
    managerXp,
    coaches,
    talentClaimPricingPolicy,
    coachConversionPolicy,
    rosterDashboard,
    billing,
    idGenerator,
    claimTalentPoolCandidate: new ClaimTalentPoolCandidateUseCase(
      talentPoolCandidates,
      players,
      events,
      billing,
      talentClaim,
      talentClaimPricingPolicy,
    ),
    createCustomPlayer: new CreateCustomPlayerUseCase(players, events, billing, generationPolicy, generationRandom),
    refreshTalentPool: new RefreshTalentPoolUseCase(
      talentPoolCandidates,
      worlds,
      generationPolicy,
      generationRandom,
      idGenerator,
      players,
      events,
      standardAgingPolicy,
    ),
    genesisSeedFillOnlyPlayers: new GenesisSeedFillOnlyPlayersUseCase(worlds, players, events, generationPolicy, generationRandom, idGenerator, standardAgingPolicy),
    openTournament,
    openRegistration,
    registerEntrant: new RegisterEntrantUseCase(tournaments, players, bracketGenerator),
    simulateMatch,
    advanceWorldWeek: new AdvanceWorldWeekUseCase(worlds, players, billing, standardAging, proAging, events, trainingPolicy, coaches, rankingLedger),
    generateJuniorTournaments,
    simulateDueMatches: new SimulateDueMatchesUseCase(tournaments, simulateMatch),
    setTrainingFocus: new SetTrainingFocusUseCase(players),
    releasePlayer: new ReleasePlayerUseCase(players),
    convertPlayerToCoach: new ConvertPlayerToCoachUseCase(
      players,
      coaches,
      managerXp,
      coachConversionPolicy,
      idGenerator,
      events,
      billing,
    ),
  };
}
