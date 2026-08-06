import { Player } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { ManagerId, PlayerId, TournamentId, GameWeek, MatchId, WorldId, TalentPoolCandidateId, CoachId } from '@tennis-manager/domain';
import { MatchLog, GameWorld, RankingLedgerEntry, TalentPoolCandidate, Coach } from '@tennis-manager/domain';

export interface ManagerAccount {
  id: ManagerId;
  authSubject: string;
  displayName: string;
  publicHandle: string;
  status: 'active' | 'suspended';
}

export interface ManagerAccountRepository {
  findByAuthSubject(authSubject: string): Promise<ManagerAccount | null>;
  save(account: ManagerAccount): Promise<void>;
}

/** Provider-neutral verification boundary. The API adapter extracts the
 * bearer token; this port only receives a token and returns verified claims. */
export interface AuthPort {
  verifyAccessToken(accessToken: string): Promise<{ subject: string; displayName?: string } | null>;
}

/**
 * Interface Segregation in practice: one narrow repository interface
 * per aggregate, not a single "GameRepository" god-interface. A use
 * case that only needs players never has to depend on (or mock)
 * tournament persistence.
 */
export interface PlayerRepository {
  findById(id: PlayerId): Promise<Player | null>;
  findByManager(managerId: ManagerId): Promise<Player[]>;
  /** Every player in the game-world. Becomes world-scoped when
   * multi-world arrives; today there is a single implicit world. */
  findAll(): Promise<Player[]>;
  save(player: Player): Promise<void>;
}

export interface TournamentRepository {
  findById(id: TournamentId): Promise<Tournament | null>;
  findOpenForRegistration(): Promise<Tournament[]>;
  /** Tournaments whose bracket exists (started). Includes finished
   * ones — callers that only want playable matches filter via the
   * aggregate's own round/final checks. */
  findStarted(): Promise<Tournament[]>;
  save(tournament: Tournament): Promise<void>;
}

/** The domain never reads Date.now() directly — everything runs on
 * in-game weeks, and tests can inject a fixed clock. */
export interface ClockPort {
  currentWeek(): GameWeek;
}

/** One row per game-world clock (see GameWorld aggregate). Single
 * world at MVP; the port already takes ids so multi-world is additive. */
export interface GameWorldRepository {
  findById(id: WorldId): Promise<GameWorld | null>;
  save(world: GameWorld): Promise<void>;
}

/** Outbound port for anything that needs to leave the process:
 * pushing a domain event onward to email/push notification adapters.
 * Kept generic here; a real NotificationPort would likely have
 * typed methods per event, added as the Notifications context
 * matures. */
export interface EventPublisherPort {
  publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void>;
}

/**
 * Stores the "fake live" replay blob produced alongside every
 * simulated match. Deliberately NOT a repository for an aggregate —
 * a MatchLog is an immutable artifact, not a domain entity with
 * behavior, so a simple write-once/read-many port is enough. The
 * real adapter for this in production would write straight to object
 * storage (S3/R2) behind a CDN, since the blob never changes after
 * creation and viewer count should never translate into backend load.
 */
export interface MatchLogStorePort {
  save(matchId: MatchId, log: MatchLog): Promise<{ url: string }>;
}

/**
 * Billing context boundary (CLAUDE.md bounded context #5). Game logic
 * only ever asks entitlement questions and requests a checkout URL —
 * it never sees Stripe types, webhook payloads, or subscription
 * records; those live entirely inside the billing adapter. Per
 * principle #1, everything a Pro entitlement grants must carry its
 * built-in tradeoff cost wherever it's consumed (roster cap 4 comes
 * with faster stat decay — see AdvanceWorldWeekUseCase).
 */
export interface BillingPort {
  isProSubscriber(managerId: ManagerId): Promise<boolean>;
  /** Starts a Manager Pro subscription checkout; the returned URL is
   * where the manager's browser gets redirected to pay. Entitlement
   * flips only when the provider's webhook confirms completion —
   * never optimistically at session creation. */
  createProCheckoutSession(managerId: ManagerId): Promise<{ url: string }>;
  /** Current custom-player-creation credit balance — earned one at a
   * time on each confirmed Stripe subscription *renewal* (not the
   * initial signup, and not an invented in-game clock — see the
   * billing webhook's handling of invoice.paid/subscription_cycle),
   * spent one at a time by CreateCustomPlayerUseCase. 0 for a manager
   * who has never earned any, same "absence means zero" convention as
   * every other entitlement read here. */
  customPlayerCreditBalance(managerId: ManagerId): Promise<number>;
  /** Atomically spends one credit if the balance is currently > 0 — a
   * single conditional UPDATE, not a separate read-then-write, so two
   * concurrent custom-player creations can never both spend the same
   * last credit. Returns whether it succeeded. */
  consumeCustomPlayerCredit(managerId: ManagerId): Promise<boolean>;
}

/**
 * A generated player sitting unowned in the talent pool. One narrow
 * repository per aggregate (ISP), same as every other repository port
 * here — findAvailable()/save() cover ordinary reads/writes (browsing
 * the pool, expiring old candidates on the weekly sweep), while
 * claimIfAvailable() is a SEPARATE method specifically because it must
 * be one atomic, DB-level conditional operation, not composed from
 * findById() + save(): two managers racing to claim the same candidate
 * must never both succeed, and a read-then-write composed from this
 * port's other methods could never guarantee that (see
 * DrizzleTalentPoolCandidateRepository for the actual conditional
 * UPDATE this compiles down to).
 */
export interface TalentPoolCandidateRepository {
  findById(id: TalentPoolCandidateId): Promise<TalentPoolCandidate | null>;
  /** Every candidate still sitting unclaimed and unexpired — what the
   * pool browse screen shows, and what the weekly expiry sweep reads
   * to find candidates to age out. */
  findAvailable(): Promise<TalentPoolCandidate[]>;
  save(candidate: TalentPoolCandidate): Promise<void>;
  /** Atomically claims a candidate for a manager: succeeds (returns
   * the now-claimed candidate) only if it was still 'available' at
   * claim time, via a single conditional UPDATE ... WHERE
   * status = 'available' RETURNING *. Returns null if the candidate
   * doesn't exist, or was already claimed/expired by the time this
   * ran — the caller (ClaimTalentPoolCandidateUseCase) treats null as
   * "no longer available," not an error to retry. */
  claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null>;
}

/** Generates opaque unique ids for aggregates the application layer
 * creates (not the domain — domain/ stays framework-free, and even
 * Node's crypto module is infrastructure). Kept as a one-method port
 * rather than importing node:crypto directly into a use case, so
 * tests can inject predictable ids instead of asserting against
 * whatever a real UUID happens to be. */
export interface IdGeneratorPort {
  generate(): string;
}

/**
 * Append-only store for RankingLedgerEntry rows — the real ATP-style
 * ranking mechanism's source of truth (see RankingCalculationService).
 * Deliberately write-only from this port's perspective plus a
 * per-player read: nothing ever updates or deletes a ledger entry,
 * since expiry/capping is computed at read time, not applied to the
 * stored rows themselves.
 */
export interface RankingLedgerRepository {
  append(entry: RankingLedgerEntry): Promise<void>;
  findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]>;
  /** Every ledger entry ever recorded, across every player — the input
   * a cross-player rank-position query needs (see RankingCalculationService
   * usage in the read layer). Not scoped/paginated: this game's scale
   * (a single game-world's players) keeps the full table small enough
   * to read in one call, same assumption RosterDashboardQuery already
   * makes about tournament_matches. */
  findAll(): Promise<RankingLedgerEntry[]>;
}

/**
 * A manager's cumulative XP balance (Manager & Progression bounded
 * context). Deliberately a simple stored balance, not an append-only
 * ledger like RankingLedgerRepository above — XP is a spendable
 * currency with no expiry/rolling-window concept, so there's nothing
 * for a ledger's replay-at-read-time model to buy here that a plain
 * running total doesn't already give more simply.
 */
export interface ManagerXpRepository {
  /** Current balance, 0 if the manager has never earned any (same
   * "absence means zero" convention as BillingPort's credit balance). */
  balanceFor(managerId: ManagerId): Promise<number>;
  /** Adds XP to a manager's balance, creating the balance row if this
   * is their first-ever XP event. Not itself required to be atomic
   * against concurrent credits the way spendXpIfSufficient is against
   * concurrent spends — two credits racing can both safely add (a
   * conditional UPDATE ... SET balance = balance + x is commutative),
   * unlike a spend which must check-and-deduct as one step. */
  credit(managerId: ManagerId, amount: number): Promise<void>;
  /** Atomically checks-and-deducts in one DB-level conditional UPDATE
   * (same "conditional UPDATE, not read-then-write" pattern as
   * TalentPoolCandidateRepository.claimIfAvailable and
   * BillingPort.consumeCustomPlayerCredit) — succeeds only if the
   * balance was already >= amount, so two near-simultaneous spends can
   * never both pass a balance check before either deducts. Returns
   * whether the spend succeeded. */
  spendXpIfSufficient(managerId: ManagerId, amount: number): Promise<boolean>;
}

/**
 * Outcome of an atomic claim+charge attempt — a discriminated union
 * rather than a boolean/null, since ClaimTalentPoolCandidateUseCase
 * needs to distinguish two different, user-facing failure reasons (the
 * candidate was already claimed by someone else vs. this manager
 * simply can't afford it) instead of collapsing both into one generic
 * "claim failed."
 */
export type TalentClaimOutcome =
  | { kind: 'claimed'; candidate: TalentPoolCandidate; xpSpent: number }
  | { kind: 'candidate-unavailable' }
  | { kind: 'insufficient-xp'; required: number; balance: number };

/**
 * Cross-aggregate port for the one operation in this codebase that
 * needs genuine multi-table atomicity: claiming a talent-pool candidate
 * AND debiting the manager's XP balance must succeed or fail together,
 * with no window where one has happened but not the other (see
 * docs/manager-xp-and-coaching-system.md section 3 — a balance check
 * and the deduction can't be two separate steps, or two near-
 * simultaneous claims could both pass the check before either
 * deducts). TalentPoolCandidateRepository.claimIfAvailable() and
 * ManagerXpRepository.spendXpIfSufficient() each solve this within
 * their OWN table via a single conditional UPDATE, but neither can
 * reach across to the other's table — hence this separate port,
 * deliberately NOT composed from calling both of those in sequence
 * from application code (that would reopen exactly the race window
 * this port exists to close). The real adapter wraps both conditional
 * UPDATEs in one actual DB transaction (see DrizzleTalentClaimAdapter).
 */
export interface TalentClaimPort {
  /** xpCost is computed by the caller (via TalentClaimPricingPolicy,
   * reading the candidate's overallRating() BEFORE this call) since a
   * candidate's attributes are immutable post-generation — only
   * status/claimedBy ever change, so pricing off a pre-fetched read is
   * safe even though the actual claim+charge happens atomically later. */
  claimAndCharge(candidateId: TalentPoolCandidateId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome>;
}

/**
 * One narrow repository per aggregate, same ISP convention as every
 * other port here. findByManager returns at most one Coach today
 * (COACH_CAP_PER_MANAGER = 1, see ConvertPlayerToCoachUseCase) —
 * returning an array rather than a single nullable Coach anyway, since
 * "how many coaches can a manager have" is exactly the kind of cap
 * ConvertPlayerToCoachUseCase's own doc comment flags as an open
 * monetization question, not something this port should bake in as a
 * permanent 1:1 assumption.
 */
export interface CoachRepository {
  findByManager(managerId: ManagerId): Promise<Coach[]>;
  save(coach: Coach): Promise<void>;
}
