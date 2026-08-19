import { Player } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { ManagerId, PlayerId, TournamentId, GameWeek, MatchId, WorldId, CoachId } from '@tennis-manager/domain';
import { MatchLog, GameWorld, GameDay, RankingLedgerEntry, Coach, DoublesPair, PairId, DoublesTitleRecord, DoublesPeakRankingEntry, MastersCup, WorldTeamCup } from '@tennis-manager/domain';
import { PeakRankingEntry, RankingBand, TitleRecord } from '@tennis-manager/domain';
import { TrainingScheduleEntry } from '@tennis-manager/domain';

export interface ManagerAccount {
  id: ManagerId;
  authSubject: string;
  displayName: string;
  publicHandle: string;
  /** 'deleted' is permanent and self-initiated (DeleteManagerAccountUseCase);
   * 'suspended' is reversible and administrative. Both block
   * re-authentication identically in EnsureManagerAccountUseCase, but are
   * kept distinct rather than merged so a deleted account is never
   * mistaken for a merely-suspended one. */
  status: 'active' | 'suspended' | 'deleted';
}

export interface ManagerAccountRepository {
  findByAuthSubject(authSubject: string): Promise<ManagerAccount | null>;
  findById(id: ManagerId): Promise<ManagerAccount | null>;
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
  /** Every unowned, non-retired player — the "talent pool" a manager
   * browses and signs from (see docs/CLAUDE.md's "hiring is pool-based
   * and scarce" note). A free agent is now a real Player with
   * managerId: null, not a separate TalentPoolCandidate aggregate: a
   * generated player lives in the world for their whole career whether
   * or not a manager ever signs them, so they never "expire" or vanish. */
  findFreeAgents(): Promise<Player[]>;
  save(player: Player): Promise<void>;
}

/** A player's per-GameWeek training-focus schedule (see
 * TrainingSchedule.ts's resolveTrainingFocusForWeek for how these
 * entries get resolved into "what applies this week") — replaces the
 * old single mutable Player.currentFocus field/setTrainingFocus()
 * method entirely; Player no longer stores or knows its own training
 * focus at all. */
export interface TrainingScheduleRepository {
  /** Every explicit entry ever set for this player, any order — the
   * caller resolves what applies to a specific week via
   * resolveTrainingFocusForWeek, this just returns the raw ledger. */
  findByPlayer(playerId: PlayerId): Promise<TrainingScheduleEntry[]>;
  /** Upsert: an entry already existing for the same (playerId,
   * effectiveFrom week) is overwritten — setting the SAME week twice
   * is "I changed my mind about this week's order," not a second,
   * separate order. */
  save(entry: TrainingScheduleEntry): Promise<void>;
}

export interface TournamentRepository {
  findById(id: TournamentId): Promise<Tournament | null>;
  findOpenForRegistration(): Promise<Tournament[]>;
  /** Tournaments whose bracket exists (started). Includes finished
   * ones — callers that only want playable matches filter via the
   * aggregate's own round/final checks. */
  findStarted(): Promise<Tournament[]>;
  /** Every tournament (open or started — a filled draw still "used" a
   * registration slot for the week) this player is registered in for
   * exactly this GameWeek, regardless of tier. What RegisterEntrantUseCase's
   * junior weekly-entry cap counts against — see its own doc comment. */
  findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]>;
  /** The DOUBLES analogue of findByPlayerAndWeek: every tournament this
   * player is entered in the DOUBLES field of for exactly this GameWeek.
   * The weekly entry cap counts a player's SINGLES and DOUBLES entries
   * together (a player can't play two tournaments' doubles on the same
   * days they're playing singles), so the cap helper reads BOTH. */
  findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]>;
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
 * The permanent high-water-mark store (docs/data-archival-principles.md)
 * — deliberately the opposite persistence shape from
 * RankingLedgerRepository above: small and MUTABLE (one row per
 * (player, band), updated in place), never append-only. A player's
 * ranking can fall as old results roll out of the 52-week window; this
 * is what remembers how high it ever climbed, independent of that.
 */
export interface PeakRankingRepository {
  findOne(playerId: PlayerId, band: RankingBand): Promise<PeakRankingEntry | null>;
  /** Overwrites any existing row for this (player, band) — callers are
   * expected to have already checked `isNewPeak` themselves; this port
   * doesn't re-check it, so it stays a dumb, testable store rather than
   * silently swallowing the domain rule. */
  upsert(entry: PeakRankingEntry): Promise<void>;
  /** Every band a given player has ever peaked in (up to three: senior,
   * u14, u16) — what the profile page's "peak rankings" section needs
   * in one call rather than three. */
  findAllForPlayer(playerId: PlayerId): Promise<PeakRankingEntry[]>;
}

/**
 * Append-only title/trophy store (docs/data-archival-principles.md) —
 * lean by design: TitleRecord only references the winning tournament
 * (id + a few scalars), it never copies the tournament's own data.
 * One row per tournament win, ever — see the Drizzle adapter for how
 * that's enforced structurally (tournamentId as primary key), not just
 * by convention.
 */
export interface TitleRepository {
  append(title: TitleRecord): Promise<void>;
  findByPlayer(playerId: PlayerId): Promise<TitleRecord[]>;
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

/** One manager's public standing on the decaying ladder. */
export interface ManagerLadderStanding {
  managerId: ManagerId;
  /** Current decayed score. Fractional (decay produces non-integers);
   * callers round only for display. */
  score: number;
}

/**
 * The decaying manager LADDER — the public competitive standing
 * (docs/rocking-rackets-competitive-analysis.md §1d/P3), a DIFFERENT
 * store from ManagerXpRepository (the spendable, non-decaying wallet).
 * See ManagerLadderPolicy for why the two coexist rather than one
 * replacing the other. Stored as a running fractional total (the weekly
 * decay multiply produces non-integers), so this port intentionally
 * does NOT reuse the integer-balance ManagerXpRepository.
 */
export interface ManagerLadderRepository {
  /** Current decayed score, 0 if the manager has never banked any
   * (same "absence means zero" convention as ManagerXpRepository). */
  scoreFor(managerId: ManagerId): Promise<number>;

  /** Adds points to a manager's ladder score (creating the row on
   * first credit). Commutative like ManagerXpRepository.credit — two
   * racing credits both safely add; no read-then-write. A non-positive
   * amount is a no-op. */
  credit(managerId: ManagerId, amount: number): Promise<void>;

  /** Multiplies EVERY manager's score by `factor` in one set-based
   * statement (the weekly erosion). Applied once per weekly rollover,
   * not per credit — a whole-table `UPDATE ... SET score = score *
   * factor`, so its cost is independent of how many matches were
   * played that week. */
  decayAll(factor: number): Promise<void>;

  /** The public leaderboard: the top `limit` managers by score,
   * descending, excluding zero/negative scores (a manager who has
   * never earned a point isn't "ranked"). */
  topStandings(limit: number): Promise<ManagerLadderStanding[]>;

  /** The caller's own 1-based position on the public ladder, or null
   * if they've never banked a point (genuinely unranked, not "last").
   * Counts managers with a strictly higher score, so ties share the
   * lower rank number. */
  rankFor(managerId: ManagerId): Promise<number | null>;
}

/**
 * Outcome of an atomic sign+charge attempt — a discriminated union
 * rather than a boolean/null, since ClaimTalentPoolCandidateUseCase
 * needs to distinguish two different, user-facing failure reasons (the
 * free agent was already signed by someone else vs. this manager
 * simply can't afford it) instead of collapsing both into one generic
 * "sign failed."
 */
export type TalentClaimOutcome =
  | { kind: 'claimed'; player: Player; xpSpent: number }
  | { kind: 'player-unavailable' }
  | { kind: 'insufficient-xp'; required: number; balance: number };

/**
 * Cross-aggregate port for the one operation in this codebase that
 * needs genuine multi-table atomicity: signing a free-agent player
 * (transferring ownership) AND debiting the manager's XP balance must
 * succeed or fail together, with no window where one has happened but
 * not the other (see docs/manager-xp-and-coaching-system.md section 3 —
 * a balance check and the deduction can't be two separate steps, or two
 * near-simultaneous signings could both pass the check before either
 * deducts). ManagerXpRepository.spendXpIfSufficient() solves this within
 * its OWN table via a single conditional UPDATE, but it can't reach
 * across to the players table — hence this separate port, deliberately
 * NOT composed from calling XP-spend then player-update in sequence from
 * application code (that would reopen exactly the race window this port
 * exists to close). The real adapter wraps a conditional XP UPDATE and a
 * conditional `UPDATE players ... WHERE manager_id IS NULL` in one
 * actual DB transaction (see DrizzleTalentClaimAdapter).
 */
export interface TalentClaimPort {
  /** xpCost is computed by the caller (via TalentClaimPricingPolicy,
   * reading the free agent's overallRating() BEFORE this call) since a
   * player's attributes barely move week-to-week — pricing off a
   * pre-fetched read stays accurate even though the actual sign+charge
   * happens atomically moments later. Succeeds only if the player is
   * still a free agent (manager_id IS NULL) at sign time. */
  claimAndCharge(playerId: PlayerId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome>;
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

/**
 * One narrow repository per aggregate, same ISP convention as every
 * other port here — the doubles partnership (P7a,
 * docs/doubles-and-special-formats-plan.md). A pair is a persistent
 * relationship between two PLAYERS, referenced by id only (the domain
 * aggregate never knows either player's manager — that's a use-case
 * concern), so this port is keyed on players, not managers. `save` is
 * an upsert; there is deliberately no delete — a dissolved pair is a
 * row whose status flips to 'dissolved' and stays, same "no delete,
 * keep history" shape as Coach.
 */
export interface DoublesPairRepository {
  findById(id: PairId): Promise<DoublesPair | null>;
  /** Every pair involving this player, any status — the profile
   * highlight (active partner) and the release cascade (dissolve
   * everything involving the released player) both read this. */
  findByPlayer(playerId: PlayerId): Promise<DoublesPair[]>;
  /** Every pair involving ANY of the given players, any status — what
   * the board's "Doubles" section reads, since it lists a manager's
   * pairs across their whole roster in one call rather than one per
   * player. */
  findByPlayers(playerIds: PlayerId[]): Promise<DoublesPair[]>;
  /** Every ACTIVE pair in the game-world — the Masters Cup's doubles
   * qualification reads this to rank the top-8 partnerships. */
  findActive(): Promise<DoublesPair[]>;
  save(pair: DoublesPair): Promise<void>;
}

/**
 * Append-only doubles title/trophy store (P7c) — the doubles analogue
 * of TitleRepository. One row per tournament's doubles champion pair;
 * `tournamentId` as the primary key makes a second doubles title row for
 * the same tournament structurally impossible (a tournament has one
 * doubles champion).
 */
export interface DoublesTitleRepository {
  append(title: DoublesTitleRecord): Promise<void>;
  /** Every doubles title EITHER player of the pair holds. */
  findByPlayer(playerId: PlayerId): Promise<DoublesTitleRecord[]>;
}

/**
 * A player's permanent high-water-mark DOUBLES ranking total in one band
 * (P7c + junior doubles) — the doubles analogue of PeakRankingRepository:
 * small and mutable (one row per (player, band), upserted), never
 * append-only.
 */
export interface DoublesPeakRankingRepository {
  findOne(playerId: PlayerId, band: RankingBand): Promise<DoublesPeakRankingEntry | null>;
  upsert(entry: DoublesPeakRankingEntry): Promise<void>;
}

/**
 * Practice sessions (P8a) — the once-per-player-per-day guard behind the
 * "Practice now" action. Deliberately NOT an aggregate repository: a
 * practice session has no behavior, it's a dated marker that a player
 * already practiced on a given game day, so two narrow predicates are
 * the whole surface.
 */
export interface PracticeSessionRepository {
  /** Whether this player has already practiced on this exact game day. */
  recordedOn(playerId: PlayerId, day: GameDay): Promise<boolean>;
  /** Records that this player practiced on this exact game day. */
  record(playerId: PlayerId, day: GameDay): Promise<void>;
}

/**
 * The Masters Cup (P8b) — one season-end capstone event per season.
 * Small surface: there is at most one cup per season, so the read is
 * "find the cup for this season" and the write is "save it whole" (the
 * aggregate owns its own group-stage/knockout state).
 */
export interface MastersCupRepository {
  findBySeason(season: number): Promise<MastersCup | null>;
  save(cup: MastersCup): Promise<void>;
}

/**
 * The World Team Cup (P8c) — one national-team event per season. Same
 * one-per-season shape as MastersCupRepository.
 */
export interface WorldTeamCupRepository {
  findBySeason(season: number): Promise<WorldTeamCup | null>;
  save(cup: WorldTeamCup): Promise<void>;
}
