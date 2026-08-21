import Stripe from 'stripe';
import { BracketGenerator } from '@tennis-manager/domain';
import { TournamentNameGenerator } from '@tennis-manager/domain';
import { StatisticalMatchSimulator } from '@tennis-manager/domain';
import { AcceleratedDeclinePolicy, PlayerAgingService, StandardAgingPolicy } from '@tennis-manager/domain';
import { StandardRankingPointsTable } from '@tennis-manager/domain';
import { StandardPlayerGenerationPolicy } from '@tennis-manager/domain';
import { WorldId } from '@tennis-manager/domain';
import { StandardTrainingPolicy } from '@tennis-manager/domain';
import { StandardTournamentSchedulePolicy } from '@tennis-manager/domain';
import { StandardManagerXpPolicy } from '@tennis-manager/domain';
import { StandardManagerLadderPolicy } from '@tennis-manager/domain';
import { StandardPlayerDevelopmentPolicy } from '@tennis-manager/domain';
import { StandardTalentClaimPricingPolicy, TalentClaimPricingPolicy } from '@tennis-manager/domain';
import { StandardCoachConversionPolicy, CoachConversionPolicy } from '@tennis-manager/domain';
import { DoublesPairingService, StandardDoublesPairPolicy, doublesBestResultsCapFor, RankingCalculationService, StandardPracticePolicy } from '@tennis-manager/domain';
import { RankingBand } from '@tennis-manager/domain';
import { ClaimTalentPoolCandidateUseCase } from '@tennis-manager/application';
import { ConvertPlayerToCoachUseCase } from '@tennis-manager/application';
import { CreateCustomPlayerUseCase } from '@tennis-manager/application';
import { RefreshTalentPoolUseCase } from '@tennis-manager/application';
import { GenesisSeedFillOnlyPlayersUseCase, EnsureFillOnlyPopulationUseCase } from '@tennis-manager/application';
import { OpenTournamentUseCase } from '@tennis-manager/application';
import { OpenRegistrationUseCase } from '@tennis-manager/application';
import { SimulateMatchUseCase } from '@tennis-manager/application';
import { AdvanceWorldWeekUseCase, PromoteQualifiersUseCase, SimulateDueMatchesUseCase } from '@tennis-manager/application';
import { CreateDoublesPairUseCase, AcceptDoublesPairUseCase, DissolveDoublesPairUseCase } from '@tennis-manager/application';
import { RegisterDoublesEntrantUseCase, FormDoublesDrawUseCase, SimulateDoublesMatchUseCase, PromoteDoublesQualifiersUseCase, RunPracticeSessionUseCase, GenerateMastersCupUseCase, AdvanceMastersCupUseCase, SimulateMastersCupMatchUseCase, SimulateDueMastersCupMatchesUseCase, GenerateWorldTeamCupUseCase, AdvanceWorldTeamCupUseCase, SimulateWorldTeamCupRubberUseCase, SimulateDueWorldTeamCupRubbersUseCase } from '@tennis-manager/application';
import { GenerateJuniorTournamentsUseCase, GenerateSeniorTournamentsUseCase } from '@tennis-manager/application';
import { ApplyObligatoryTournamentZerosUseCase } from '@tennis-manager/application';
import { StartDueTournamentsUseCase } from '@tennis-manager/application';
import { SetTrainingScheduleUseCase } from '@tennis-manager/application';
import { ReleasePlayerUseCase } from '@tennis-manager/application';
import { DeleteManagerAccountUseCase } from '@tennis-manager/application';
import { RegisterEntrantUseCase } from '@tennis-manager/application';
import { RankPositionQuery } from '@tennis-manager/application';
import { PlayerEntryPlannerQuery } from '@tennis-manager/application';
import { PlayerTrainingScheduleQuery } from '@tennis-manager/application';
import { Db } from './db/client';
import { DrizzlePlayerRepository } from './adapters/outbound/DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './adapters/outbound/DrizzleTournamentRepository';
import { DrizzleGameWorldRepository } from './adapters/outbound/DrizzleGameWorldRepository';
import { DrizzleRankingLedgerRepository } from './adapters/outbound/DrizzleRankingLedgerRepository';
import { DrizzlePeakRankingRepository } from './adapters/outbound/DrizzlePeakRankingRepository';
import { DrizzleTitleRepository } from './adapters/outbound/DrizzleTitleRepository';
import { DrizzlePlayerTournamentHistoryQuery } from './adapters/outbound/DrizzlePlayerTournamentHistoryQuery';
import { DrizzlePlayerProfileQuery } from './adapters/outbound/DrizzlePlayerProfileQuery';
import { DrizzlePlayerMatchesQuery } from './adapters/outbound/DrizzlePlayerMatchesQuery';
import { DrizzleTalentClaimAdapter } from './adapters/outbound/DrizzleTalentClaimAdapter';
import { DrizzleManagerXpRepository } from './adapters/outbound/DrizzleManagerXpRepository';
import { DrizzleManagerLadderRepository } from './adapters/outbound/DrizzleManagerLadderRepository';
import { DrizzleCoachRepository } from './adapters/outbound/DrizzleCoachRepository';
import { DrizzleDoublesPairRepository } from './adapters/outbound/DrizzleDoublesPairRepository';
import { DrizzleDoublesTitleRepository } from './adapters/outbound/DrizzleDoublesTitleRepository';
import { DrizzleDoublesPeakRankingRepository } from './adapters/outbound/DrizzleDoublesPeakRankingRepository';
import { DrizzlePracticeSessionRepository } from './adapters/outbound/DrizzlePracticeSessionRepository';
import { DrizzleMastersCupRepository } from './adapters/outbound/DrizzleMastersCupRepository';
import { DrizzleWorldTeamCupRepository } from './adapters/outbound/DrizzleWorldTeamCupRepository';
import { DrizzleRosterDashboardQuery } from './adapters/outbound/DrizzleRosterDashboardQuery';
import { DrizzleTrainingScheduleRepository } from './adapters/outbound/DrizzleTrainingScheduleRepository';
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
  /** Permanent high-water-mark store (docs/data-archival-principles.md)
   * — separate from rankingLedger's rolling/falling total. */
  peakRankings: DrizzlePeakRankingRepository;
  /** Append-only title/trophy store, same doc. */
  titles: DrizzleTitleRepository;
  /** The single composed read behind the player profile page — see
   * DrizzlePlayerProfileQuery's own doc comment. */
  playerProfile: DrizzlePlayerProfileQuery;
  /** The player-profile "latest results + next match" read — see
   * DrizzlePlayerMatchesQuery's own doc comment. */
  playerMatches: DrizzlePlayerMatchesQuery;
  /** The senior tour's rank-position query (band: 'senior') — what the
   * roster dashboard's rank column reads today. The two junior bands
   * (rankPositionU14/rankPositionU16) are wired below for the same
   * reason coach conversion shipped with no HTTP route yet (see
   * CLAUDE.md's Manager & Progression status): the domain/query layer
   * is real and tested ahead of any UI consuming it. */
  rankPosition: RankPositionQuery;
  rankPositionU14: RankPositionQuery;
  rankPositionU16: RankPositionQuery;
  /** The multi-week entry planner read — given a player, their
   * tournament entries (or lack thereof) across the next several
   * upcoming GameWeeks in one response. See PlayerEntryPlannerQuery's
   * own doc comment for why it reuses findByPlayerAndWeek rather than
   * a bulk query. */
  entryPlanner: PlayerEntryPlannerQuery;
  /** A player's per-GameWeek training-focus schedule (see
   * TrainingSchedule.ts) — separate repository from `players` itself,
   * queried directly by routes that need the raw schedule (the
   * training-schedule read below) as well as by AdvanceWorldWeekUseCase
   * each tick. */
  trainingSchedule: DrizzleTrainingScheduleRepository;
  /** The training-schedule mirror of `entryPlanner` above — same
   * window, same per-week shape, a separate query against a separate
   * repository (see PlayerTrainingScheduleQuery's own doc comment on
   * why this isn't merged into one new backend concept). */
  trainingScheduleQuery: PlayerTrainingScheduleQuery;
  managerXp: DrizzleManagerXpRepository;
  managerLadder: DrizzleManagerLadderRepository;
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
  /** The recurring safe guard that tops up the fill-only population to a
   * per-band floor every weekly rollover — the production guarantee that a
   * tournament's empty draw always has age-appropriate fillers (see
   * EnsureFillOnlyPopulationUseCase). */
  ensureFillOnlyPopulation: EnsureFillOnlyPopulationUseCase;
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
  /** The weekly SENIOR-tour content generator — the senior analogue of
   * generateJuniorTournaments. Before it existed nothing ever created a
   * senior tournament automatically (only the dev seed's one-shot
   * fixtures), so the senior tour ran dry after those weeks passed.
   * Run from the same worker handler, gated the same way. */
  generateSeniorTournaments: GenerateSeniorTournamentsUseCase;
  /** The "this tournament's registration window is over, start it"
   * trigger docs/tournament-fill-system.md item 5 needed — fills any
   * under-registered but due tournament from the unclaimed-player pool
   * before seeding its bracket. Run from the same weekly worker tick as
   * advanceWorldWeek/generateJuniorTournaments, gated the same way. */
  startDueTournaments: StartDueTournamentsUseCase;
  /** The obligatory-tournament ranking rule, live (P9 —
   * docs/ranking-realism-proposal.md §4): records the mandatory-skip
   * zeros a direct-acceptance-eligible player owes for every obligatory
   * event they skipped. Run once per weekly rollover from the same
   * worker handler as the siblings above, AFTER startDueTournaments. */
  applyObligatoryTournamentZeros: ApplyObligatoryTournamentZerosUseCase;
  promoteQualifiers: PromoteQualifiersUseCase;
  simulateDueMatches: SimulateDueMatchesUseCase;
  setTrainingSchedule: SetTrainingScheduleUseCase;
  releasePlayer: ReleasePlayerUseCase;
  deleteManagerAccount: DeleteManagerAccountUseCase;
  convertPlayerToCoach: ConvertPlayerToCoachUseCase;
  /** Doubles partnerships (P7a — see
   * docs/doubles-and-special-formats-plan.md). The repository is
   * exposed directly so routes/queries (the board read, the profile
   * highlight) can read pairs without going through a use case; the
   * three mutating use cases are the only writers. */
  doublesPairs: DrizzleDoublesPairRepository;
  createDoublesPair: CreateDoublesPairUseCase;
  acceptDoublesPair: AcceptDoublesPairUseCase;
  dissolveDoublesPair: DissolveDoublesPairUseCase;
  /** Doubles competition (P7b): solo entry, draw formation (pairing +
   * cutoff), and simulation. `rankPositionDoubles` is the doubles
   * ranking (discipline-filtered, best-14) the formation step reads to
   * compute each entrant's combined ranking. */
  rankPositionDoubles: RankPositionQuery;
  registerDoublesEntrant: RegisterDoublesEntrantUseCase;
  formDoublesDraw: FormDoublesDrawUseCase;
  simulateDoublesMatch: SimulateDoublesMatchUseCase;
  promoteDoublesQualifiers: PromoteDoublesQualifiersUseCase;
  /** Practice sessions (P8a) — the no-form training outlet. */
  runPracticeSession: RunPracticeSessionUseCase;
  /** Masters Cup (P8b) — the season-end capstone. */
  mastersCups: DrizzleMastersCupRepository;
  generateMastersCup: GenerateMastersCupUseCase;
  advanceMastersCup: AdvanceMastersCupUseCase;
  simulateMastersCupMatch: SimulateMastersCupMatchUseCase;
  simulateDueMastersCupMatches: SimulateDueMastersCupMatchesUseCase;
  /** World Team Cup (P8c) — the Davis-Cup-style national team event. */
  worldTeamCups: DrizzleWorldTeamCupRepository;
  generateWorldTeamCup: GenerateWorldTeamCupUseCase;
  advanceWorldTeamCup: AdvanceWorldTeamCupUseCase;
  simulateWorldTeamCupRubber: SimulateWorldTeamCupRubberUseCase;
  simulateDueWorldTeamCupRubbers: SimulateDueWorldTeamCupRubbersUseCase;
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
  const tournamentSchedulePolicy = new StandardTournamentSchedulePolicy();
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
  const peakRankings = new DrizzlePeakRankingRepository(options.db);
  const titles = new DrizzleTitleRepository(options.db);
  const rankPosition = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'senior');
  const rankPositionU14 = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'u14');
  const rankPositionU16 = new RankPositionQuery(rankingLedger, worlds, WORLD_ID, 'u16');
  // Doubles ranking (P7b + junior doubles): the SAME ledger filtered to
  // `discipline: 'doubles'` AND one age band — best-14 senior, best-6
  // either junior band (doublesBestResultsCapFor, the real ITF junior
  // doubles rule).
  const doublesRankingFor = (band: RankingBand) =>
    new RankPositionQuery(rankingLedger, worlds, WORLD_ID, band, new RankingCalculationService(doublesBestResultsCapFor(band)), 'doubles');
  const rankPositionDoubles = doublesRankingFor('senior');
  const rankPositionDoublesU14 = doublesRankingFor('u14');
  const rankPositionDoublesU16 = doublesRankingFor('u16');
  const doublesRankByBand: Record<RankingBand, RankPositionQuery> = {
    senior: rankPositionDoubles,
    u14: rankPositionDoublesU14,
    u16: rankPositionDoublesU16,
  };
  const managerXp = new DrizzleManagerXpRepository(options.db);
  const managerXpPolicy = new StandardManagerXpPolicy();
  const managerLadder = new DrizzleManagerLadderRepository(options.db);
  const managerLadderPolicy = new StandardManagerLadderPolicy();
  const developmentPolicy = new StandardPlayerDevelopmentPolicy();
  const talentClaim = new DrizzleTalentClaimAdapter(options.db);
  const talentClaimPricingPolicy = new StandardTalentClaimPricingPolicy();
  const coaches = new DrizzleCoachRepository(options.db);
  const doublesPairs = new DrizzleDoublesPairRepository(options.db);
  const doublesTitles = new DrizzleDoublesTitleRepository(options.db);
  const doublesPeakRankings = new DrizzleDoublesPeakRankingRepository(options.db);
  const practices = new DrizzlePracticeSessionRepository(options.db);
  const mastersCups = new DrizzleMastersCupRepository(options.db);
  const worldTeamCups = new DrizzleWorldTeamCupRepository(options.db);
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
  const trainingSchedule = new DrizzleTrainingScheduleRepository(options.db);
  const trainingScheduleQuery = new PlayerTrainingScheduleQuery(trainingSchedule, worlds);
  const rosterDashboard = new DrizzleRosterDashboardQuery(
    options.db,
    new StandardAgingPolicy(),
    {
      senior: rankPosition,
      u14: rankPositionU14,
      u16: rankPositionU16,
    },
    WORLD_ID,
  );
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
    managerLadderPolicy,
    managerLadder,
    peakRankings,
    titles,
    worlds,
    WORLD_ID,
    developmentPolicy,
  );

  // Doubles simulation (P7b): shares the simulator, the replay store, and
  // the ranking/XP/ladder writes, but collapses each two-player side into
  // a composite participant and writes `discipline: 'doubles'` results.
  const doublesPairPolicy = new StandardDoublesPairPolicy();
  const simulateDoublesMatch = new SimulateDoublesMatchUseCase(
    tournaments,
    players,
    matchSimulator,
    doublesPairPolicy,
    matchLogs,
    events,
    bracketGenerator,
    rankingPointsTable,
    rankingLedger,
    managerXpPolicy,
    managerXp,
    managerLadderPolicy,
    managerLadder,
    worlds,
    WORLD_ID,
    developmentPolicy,
    doublesPairs,
    doublesTitles,
    doublesPeakRankings,
  );

  // Doubles draw formation (P7b + junior doubles): pair the solo
  // entrants + cutoff by combined entry ranking (doubles-else-singles,
  // in the tournament's OWN band), seed the bracket.
  const doublesPairingService = new DoublesPairingService();
  const rankPositionByBand: Record<RankingBand, RankPositionQuery> = {
    senior: rankPosition,
    u14: rankPositionU14,
    u16: rankPositionU16,
  };
  const formDoublesDraw = new FormDoublesDrawUseCase(
    tournaments,
    players,
    doublesPairs,
    rankPositionByBand,
    doublesRankByBand,
    doublesPairingService,
    bracketGenerator,
    new MathRandomSource(),
  );
  const registerDoublesEntrant = new RegisterDoublesEntrantUseCase(tournaments, players);

  // Masters Cup (P8b): the season-end capstone, generated on a season-end
  // rollover, simulated match-by-match, and advanced from groups to
  // knockout once both group stages finish.
  const generateMastersCup = new GenerateMastersCupUseCase(mastersCups, rankPosition, rankPositionDoubles, doublesPairs, idGenerator);
  const advanceMastersCup = new AdvanceMastersCupUseCase(mastersCups);
  const simulateMastersCupMatch = new SimulateMastersCupMatchUseCase(
    mastersCups,
    players,
    matchSimulator,
    doublesPairPolicy,
    matchLogs,
    events,
    rankingLedger,
    managerXpPolicy,
    managerXp,
    managerLadder,
    titles,
    doublesTitles,
    peakRankings,
    doublesPeakRankings,
    worlds,
    WORLD_ID,
  );
  const simulateDueMastersCupMatches = new SimulateDueMastersCupMatchesUseCase(mastersCups, worlds, WORLD_ID, simulateMastersCupMatch);

  // World Team Cup (P8c): the Davis-Cup-style national team event.
  const generateWorldTeamCup = new GenerateWorldTeamCupUseCase(worldTeamCups, players, rankPosition, idGenerator);
  const advanceWorldTeamCup = new AdvanceWorldTeamCupUseCase(worldTeamCups);
  const simulateWorldTeamCupRubber = new SimulateWorldTeamCupRubberUseCase(
    worldTeamCups,
    players,
    matchSimulator,
    doublesPairPolicy,
    matchLogs,
    worlds,
    WORLD_ID,
  );
  const simulateDueWorldTeamCupRubbers = new SimulateDueWorldTeamCupRubbersUseCase(worldTeamCups, worlds, WORLD_ID, simulateWorldTeamCupRubber);

  const standardAgingPolicy = new StandardAgingPolicy();
  const standardAging = new PlayerAgingService(standardAgingPolicy);
  const proAging = new PlayerAgingService(new AcceleratedDeclinePolicy(standardAgingPolicy, PRO_DECLINE_MULTIPLIER));
  const trainingPolicy = new StandardTrainingPolicy();

  const tournamentNameGenerator = new TournamentNameGenerator();
  const openTournament = new OpenTournamentUseCase(tournaments, bracketGenerator, tournamentNameGenerator, generationRandom);
  const openRegistration = new OpenRegistrationUseCase(tournaments, tournamentNameGenerator, generationRandom);
  const generateJuniorTournaments = new GenerateJuniorTournamentsUseCase(worlds, openRegistration, openTournament, {
    u14: rankPositionU14,
    u16: rankPositionU16,
  }, idGenerator);
  const generateSeniorTournaments = new GenerateSeniorTournamentsUseCase(worlds, tournaments, openRegistration, idGenerator);
  const entryPlanner = new PlayerEntryPlannerQuery(tournaments, worlds);
  const tournamentHistory = new DrizzlePlayerTournamentHistoryQuery(options.db);
  const playerProfile = new DrizzlePlayerProfileQuery(players, rankPositionByBand, peakRankings, titles, tournamentHistory, doublesPairs, doublesTitles, doublesPeakRankings);
  const playerMatches = new DrizzlePlayerMatchesQuery(options.db);
  const releasePlayer = new ReleasePlayerUseCase(players, doublesPairs);

  return {
    managers,
    auth,
    ensureManagerAccount,
    authMode,
    players,
    tournaments,
    worlds,
    rankingLedger,
    peakRankings,
    titles,
    playerProfile,
    playerMatches,
    rankPosition,
    rankPositionU14,
    rankPositionU16,
    entryPlanner,
    trainingSchedule,
    trainingScheduleQuery,
    managerXp,
    managerLadder,
    coaches,
    talentClaimPricingPolicy,
    coachConversionPolicy,
    rosterDashboard,
    billing,
    idGenerator,
    claimTalentPoolCandidate: new ClaimTalentPoolCandidateUseCase(
      players,
      events,
      billing,
      talentClaim,
      talentClaimPricingPolicy,
    ),
    createCustomPlayer: new CreateCustomPlayerUseCase(players, events, billing, generationPolicy, generationRandom),
    refreshTalentPool: new RefreshTalentPoolUseCase(
      worlds,
      generationPolicy,
      generationRandom,
      idGenerator,
      players,
      events,
      standardAgingPolicy,
    ),
    genesisSeedFillOnlyPlayers: new GenesisSeedFillOnlyPlayersUseCase(worlds, players, events, generationPolicy, generationRandom, idGenerator, standardAgingPolicy),
    ensureFillOnlyPopulation: new EnsureFillOnlyPopulationUseCase(worlds, players, events, generationPolicy, generationRandom, idGenerator, standardAgingPolicy),
    openTournament,
    openRegistration,
    registerEntrant: new RegisterEntrantUseCase(tournaments, players, bracketGenerator, rankPosition, formDoublesDraw),
    simulateMatch,
    advanceWorldWeek: new AdvanceWorldWeekUseCase(worlds, players, billing, standardAging, proAging, events, trainingPolicy, coaches, rankingLedger, trainingSchedule, managerLadder, managerLadderPolicy, developmentPolicy, tournaments),
    generateJuniorTournaments,
    generateSeniorTournaments,
    startDueTournaments: new StartDueTournamentsUseCase(
      tournaments,
      worlds,
      players,
      bracketGenerator,
      rankPositionByBand,
      formDoublesDraw,
    ),
    applyObligatoryTournamentZeros: new ApplyObligatoryTournamentZerosUseCase(
      worlds,
      tournaments,
      rankingLedger,
      rankPosition,
    ),
    simulateDueMatches: new SimulateDueMatchesUseCase(tournaments, simulateMatch, worlds, tournamentSchedulePolicy, simulateDoublesMatch),
    promoteQualifiers: new PromoteQualifiersUseCase(tournaments, bracketGenerator),
    setTrainingSchedule: new SetTrainingScheduleUseCase(players, trainingSchedule, worlds, WORLD_ID),
    releasePlayer,
    deleteManagerAccount: new DeleteManagerAccountUseCase(managers, players, releasePlayer),
    convertPlayerToCoach: new ConvertPlayerToCoachUseCase(
      players,
      coaches,
      managerXp,
      coachConversionPolicy,
      idGenerator,
      events,
      billing,
      doublesPairs,
    ),
    doublesPairs,
    createDoublesPair: new CreateDoublesPairUseCase(players, doublesPairs, idGenerator),
    acceptDoublesPair: new AcceptDoublesPairUseCase(doublesPairs, players),
    dissolveDoublesPair: new DissolveDoublesPairUseCase(doublesPairs, players),
    rankPositionDoubles,
    registerDoublesEntrant,
    formDoublesDraw,
    simulateDoublesMatch,
    promoteDoublesQualifiers: new PromoteDoublesQualifiersUseCase(tournaments, bracketGenerator),
    runPracticeSession: new RunPracticeSessionUseCase(players, worlds, WORLD_ID, practices, managerLadder, new StandardPracticePolicy()),
    mastersCups,
    generateMastersCup,
    advanceMastersCup,
    simulateMastersCupMatch,
    simulateDueMastersCupMatches,
    worldTeamCups,
    generateWorldTeamCup,
    advanceWorldTeamCup,
    simulateWorldTeamCupRubber,
    simulateDueWorldTeamCupRubbers,
  };
}
