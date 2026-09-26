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

/**
 * Atomic "create this manager account, and only if it is genuinely new,
 * grant its opening XP balance" operation. Deliberately a separate port
 * (the same reason TalentClaimPort/CoachConversionPort exist) rather than
 * the caller doing `ManagerAccountRepository.save()` then
 * `ManagerXpRepository.credit()` in sequence: those are two independent
 * statements, so N concurrent first-requests for one brand-new identity
 * ALL miss the `findByAuthSubject` lookup, ALL save, and ALL credit — a
 * new manager could start with several times the intended starter balance
 * (and, in the gap between the two writes, a concurrent read could even
 * observe 0). The real adapter performs both writes in ONE DB transaction,
 * gated on a conditional `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so
 * exactly one caller is the creator and therefore the only one that
 * grants.
 */
export interface ManagerAccountCreationPort {
  /**
   * Creates `account` together with its opening `starterXp` balance,
   * atomically. Returns the persisted account — which, when another
   * concurrent call won the creation race, is that WINNER's row, not
   * `account` itself — and whether THIS call is the one that created it.
   * `created` is true for at most one caller and is the only condition
   * under which the grant is applied, so a returning/existing manager is
   * never re-granted.
   */
  createWithStarterXp(
    account: ManagerAccount,
    starterXp: number,
  ): Promise<{ account: ManagerAccount; created: boolean }>;
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
   * or not a manager ever signs them, so they never "expire" or vanish.
   *
   * The optional paging/filter arguments exist for the Scouting page:
   * with a demand-sized pool (~1,600 free agents) serializing every row
   * is neither useful nor affordable. `limit`/`offset` page the
   * youngest-first list; `signableOnly` applies the SAME unfinished-
   * commitment predicate the atomic claim enforces, so a signable-only
   * page can never contain a row the server would refuse. Omitted (every
   * pre-existing caller), the full list comes back exactly as before. */
  findFreeAgents(options?: { limit?: number; offset?: number; signableOnly?: boolean }): Promise<Player[]>;
  /** Pool counts for the Scouting page's honest pagination copy: the
   * total unowned/non-retired population and how many of those are
   * signable right now (same predicate as above). One grouped count
   * query, never a full-pool read. Optional for test compatibility
   * (an in-memory fake may omit it); the Drizzle adapter — the only
   * production implementation — always provides it. */
  countFreeAgents?(): Promise<{ total: number; signable: number }>;
  /** How many free agents are signable RIGHT NOW, by the exact same
   * predicate the atomic claim enforces (no unfinished tournament
   * commitment). The acquisition-loop guard (EnsureSignablePoolUseCase)
   * reads this to keep "you can always sign someone" a hard invariant —
   * it must never be a cheaper approximation, or the guard could think
   * the pool is fine while every claim refuses. Optional for test
   * compatibility (an in-memory fake may omit it); the Drizzle adapter —
   * the only production implementation — always provides it. */
  countSignableFreeAgents?(): Promise<number>;
  /** Recovers one advanced day's fatigue from EVERY player carrying any,
   * in ONE statement — the bulk counterpart to `save(player)` in the
   * daily recovery loop (AdvanceWorldWeekUseCase.recoverDailyFatigue),
   * which otherwise reads every player and issues one single-row upsert
   * per tired player on every day tick. `amount` is the FLAT base term
   * (FATIGUE_RECOVERY_PER_DAY in production); the real recovery is the
   * self-limiting `amount + fatigue × FATIGUE_RECOVERY_FRACTION` (see
   * FatiguePolicy.fatigueRecoveredPerDay), rounded to a whole point.
   * Semantically identical to calling `Player.recoverFatigue(amount)` for
   * each player with `fatigue > 0`, then saving: the `fatigue === 0` skip
   * the loop applies is exactly the `WHERE fatigue > 0` filter, and
   * fatigue can never exceed the 100 cap the loop would clamp to. The
   * Drizzle implementation must mirror the formula's arithmetic exactly
   * (it does; the equivalence is pinned against real Postgres).
   * Optional for test compatibility (an in-memory fake may omit it); the
   * use case falls back to the per-player loop when absent. */
  recoverFatigueForAll?(amount: number): Promise<void>;
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

/**
 * Thrown by `TournamentRepository.save` when its optimistic-concurrency
 * check fails: the stored aggregate changed since this instance was
 * loaded, so applying this whole-aggregate write would silently drop
 * the other writer's change. A retryable conflict (map to HTTP 409),
 * NOT a server fault — the caller should reload the tournament and
 * re-apply its command against the fresh state.
 */
export class ConcurrentModificationError extends Error {
  constructor(readonly tournamentId: string) {
    super(`Tournament ${tournamentId} was modified by another request since it was loaded — reload and retry`);
    this.name = 'ConcurrentModificationError';
  }
}

export interface TournamentRepository {
  findById(id: TournamentId): Promise<Tournament | null>;
  findOpenForRegistration(): Promise<Tournament[]>;
  /** Tournaments whose bracket exists (started). Includes finished
   * ones — callers that only want playable matches filter via the
   * aggregate's own round/final checks. Deliberately UNBOUNDED and kept
   * for the callers that genuinely want it: the `?status=started`
   * bracket list (which needs enough history to keep an unfinished
   * draw visible, but is a per-REQUEST read, not a per-tick one), the
   * bootstrap script's diagnostic count, and the test-compat fallback
   * in the day-tick use cases whose optional `findStartedLive` a fake
   * may omit. NO production per-tick caller uses this any more — the
   * obligatory-tournament rule now reads `findStartedWithinWindow`
   * below. The day-tick match sweep must NOT use this — see
   * `findStartedLive`. */
  findStarted(): Promise<Tournament[]>;

  /** The obligatory-tournament rule's bounded counterpart to
   * `findStarted()`: only started tournaments whose `weekScheduled`
   * falls inside the rolling `weeks`-week window ENDING at `currentWeek`
   * — i.e. `currentWeek - weeks <= weekScheduled <= currentWeek`
   * (inclusive both ends, the same absolute-week arithmetic and window
   * `RANKING_WINDOW_WEEKS` the ranking calculator itself uses). A
   * mandatory-skip zero is dated to the event's `weekScheduled`, so an
   * event outside this window can never produce one and its reconstituted
   * aggregate is pure waste; bounding the read here is what stops this
   * weekly use case's cost growing with the number of tournaments ever
   * played (the 3-season soak: 3,706 tournaments / 4.4s unbounded vs.
   * only the in-window handful). Optional for test compatibility (an
   * in-memory fake without it falls back to `findStarted()`, whose own
   * JS-side window filter the use case still applies, so behaviour is
   * identical); the Drizzle adapter — the only production implementation
   * — always provides it and prefilters in SQL so the per-tournament
   * `load()` never runs for an out-of-window event. */
  findStartedWithinWindow?(currentWeek: GameWeek, weeks: number): Promise<Tournament[]>;

  /** The day-tick's bounded counterpart to `findStarted()`: only
   * started tournaments that can still have work to do — i.e. NOT
   * fully finished. Precisely: a tournament with at least one
   * undecided singles or doubles match, OR one whose qualifying draw is
   * complete but whose main draw has not been seeded yet (the state
   * PromoteQualifiersUseCase/PromoteDoublesQualifiersUseCase exist to
   * resolve). Fully-played-out tournaments drop out of this set for
   * good, so the sweep's cost stops growing with the number of
   * tournaments ever played (the 3-season soak's per-tick cost grew
   * 40s -> 230s precisely because the sweep reconstituted every started
   * tournament forever). Kept SEPARATE from `findStarted()` rather than
   * redefining it, so the obligatory-zero rule's own (window-bounded)
   * read stays independent. Optional for test compatibility (an in-memory fake
   * without it falls back to `findStarted()`); the Drizzle adapter —
   * the only production implementation — always provides it. */
  findStartedLive?(): Promise<Tournament[]>;

  /** Removes a never-started tournament that is either genuinely EMPTY
   * or manager-less (every entrant is a filler/free agent, so deleting it
   * releases those players from the unfinished-commitment lock) and
   * returns true only if a row was actually deleted. A soft state was
   * deliberately rejected: the schema has no tournament-status column,
   * and these are abandoned shells (no matches, titles or ranking rows —
   * the child tables cascade), so keeping them would only keep
   * accumulating useless rows. Implementations must never delete a
   * never-started draw that has a manager-owned entrant (someone
   * invested a decision in it) or a tournament with matches. Optional
   * for test compatibility; the Drizzle adapter — the only production
   * implementation — always provides it and re-checks the condition
   * inside one transaction. */
  deleteAbandonedTournament?(id: TournamentId): Promise<boolean>;
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

  /** Every player id entered in ANY tournament's SINGLES field for
   * exactly this GameWeek, in ONE query — the set form of
   * `findByPlayerAndWeek(playerId, week).length === 0`, which the draw
   * fillers used to ask once PER CANDIDATE (the fill N+1: with hundreds
   * of eligible fill-only players per fill, each fill issued hundreds of
   * single-player round trips). A caller that fills several draws for the
   * same week — StartDueTournamentsUseCase — loads this once per distinct
   * week and threads it into fillDrawSlots/FormDoublesDrawUseCase, which
   * skip the id inside the returned set exactly as they used to skip a
   * non-empty findByPlayerAndWeek result. DELIBERATELY singles-only,
   * matching the old predicate byte-for-byte (a doubles entrant was
   * never "committed" for this check). Optional for test compatibility
   * (an in-memory fake may omit it); callers fall back to the
   * per-candidate findByPlayerAndWeek check when absent. */
  findEnteredPlayerIdsForWeek?(week: GameWeek): Promise<PlayerId[]>;

  /** Every player id holding ANY unfinished tournament commitment —
   * the set form of the signing rule's `noUnfinishedCommitment`
   * predicate (see unfinishedCommitment.ts), covering singles entries,
   * doubles entries AND formed doubles pairs. The weekly fillers read it
   * so a player still alive in an earlier week's draw (a 14-day major, a
   * late-running event) can never be placed into a later week's draw:
   * the per-week `findEnteredPlayerIdsForWeek` set only sees entries
   * scheduled for the SAME week, so it could not stop a filler being
   * double-booked across weeks — one player holding two matches on the
   * same day. Optional for test compatibility (an in-memory fake may
   * omit it); the fill helpers then keep their old behavior. */
  findUnfinishedCommitmentPlayerIds?(): Promise<PlayerId[]>;

  /** For each of the given tournaments, how many of its SINGLES entrants
   * are owned by a real manager (`players.manager_id IS NOT NULL`) — the
   * count the tournament lists/pickers show so a manager can see whether
   * real people have already entered before deciding. One grouped query
   * over the given ids, never N+1; the SAME filter the tournament detail
   * page's entry list applies client-side. A tournament with no manager
   * entrants is simply absent from the map (read as 0). Optional for test
   * compatibility; the Drizzle adapter — the only production
   * implementation — always provides it. */
  countManagerEntrants?(tournamentIds: TournamentId[]): Promise<Map<string, number>>;
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
 * Notifications bounded context (STAGE 1) — the outbound email shape
 * that leaves the process. Deliberately data-only (subject/text/html
 * already rendered by a pure application-layer function, see
 * managerDigest.ts's renderDigestEmail), so an adapter's only job is
 * transport and the product copy stays unit-testable without I/O.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * The manager this email is for, when known. ADDITIVE/optional: the
   * transport only needs it to build a recipient-specific unsubscribe
   * link (see the Resend adapter), so a channel without one (the
   * logging adapter, every test fake) can simply ignore it. Deliberately
   * on the outbound shape rather than baked into the rendered body: the
   * application layer renders transport-neutral product copy, while the
   * unsubscribe footer is a transport concern — it needs the signing
   * secret and public base URL, both of which live in infrastructure.
   */
  managerId?: ManagerId;
}

/**
 * The transport boundary. Kept as one narrow method (an email is the
 * only channel STAGE 1 needs); push/other channels get their own typed
 * methods when they arrive, rather than a generic "send anything" blob.
 */
export interface NotificationPort {
  sendEmail(message: OutboundEmail): Promise<void>;
}

/**
 * Resolves a manager's contact address. Deliberately returns null (never
 * throws) for an unknown manager: "we have no address for this manager"
 * is an ordinary, expected outcome the digest use case skips over, not
 * an error. Keeping the "unknown" case non-throwing is what lets the
 * per-manager loop stay tolerant (see SendManagerDigestsUseCase).
 */
export interface ManagerContactPort {
  emailFor(managerId: ManagerId): Promise<string | null>;
}

/**
 * The notification delivery ledger (see the `notification_deliveries`
 * schema doc comment). The composite (managerId, kind, windowKey) key is
 * the structural "at most one send per manager per window" guard —
 * `tryClaim` is an atomic conditional insert.
 */
export interface NotificationDeliveryRepository {
  /** ATOMICALLY claims this manager+kind+window slot: inserts the
   * delivery row and returns TRUE only if THIS call created it, FALSE
   * if a row already exists (a previous/parallel send for the same
   * window). Records `coveredUntil` as the row's initial cursor. The
   * caller must only ever send after this returns true — otherwise two
   * near-simultaneous runs can both pass a read-then-write check and
   * double-send. Same race-safe claim shape as
   * PracticeSessionRepository.tryRecord. */
  tryClaim(managerId: ManagerId, kind: string, windowKey: string, coveredUntil: Date): Promise<boolean>;
  /** The cursor to resume from: the latest `coveredUntil` among this
   * manager+kind's SENT deliveries, or null if none has ever succeeded.
   * Deliberately ignores failed/sending rows, so a failed send never
   * advances the cursor and its window is re-covered on the next run. */
  previousCoveredUntil(managerId: ManagerId, kind: string): Promise<Date | null>;
  markSent(managerId: ManagerId, kind: string, windowKey: string): Promise<void>;
  markFailed(managerId: ManagerId, kind: string, windowKey: string): Promise<void>;
}

/**
 * A manager's notification preferences. ABSENCE OF A ROW MEANS OPTED IN
 * (default ON) — `isOptedOut` returns false for a manager who has never
 * touched the setting, and `setOptOut` upserts.
 */
export interface NotificationPreferenceRepository {
  isOptedOut(managerId: ManagerId): Promise<boolean>;
  setOptOut(managerId: ManagerId, optOut: boolean): Promise<void>;
}

/**
 * Stores the "fake live" replay blob produced alongside every
 * simulated match. Deliberately NOT a repository for an aggregate —
 * a MatchLog is a lightweight artifact, not a domain entity with
 * behavior. The real adapter for this in production would write
 * straight to object storage (S3/R2) behind a CDN, since viewer count
 * should never translate into backend load.
 *
 * `save` is ATOMIC-AND-OVERWRITING rather than write-once: a
 * re-simulated match's replay must reflect the currently committed
 * outcome, and the read-guard a viewer needs is "never see a partial
 * file", which the adapter's temp-file-then-rename provides (see
 * FilesystemMatchLogStore's own doc comment). `read` exists so the
 * dev HTTP route resolves blobs through the SAME path derivation the
 * writer used — the port is the one place that knows where a blob
 * lives, and the route must not re-derive it.
 */
export interface MatchLogStorePort {
  save(matchId: MatchId, log: MatchLog): Promise<{ url: string }>;
  /** Reads a previously saved blob's raw JSON text. Throws an
   * ENOENT-shaped error when the blob does not exist, so the dev
   * route can map that to a 404 (see app.ts). */
  read(matchId: MatchId): Promise<string>;
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

  /** The WINDOWED counterpart to `findAll()` — only rows whose earned
   * week falls inside the rolling `weeks`-week window ENDING at
   * `currentWeek`: `currentWeek - weeks <= seasonEarned * 52 + weekEarned
   * <= currentWeek` (inclusive both ends, the exact absolute-week
   * arithmetic `weeksBetween`/`RankingCalculationService` already use,
   * with the same `age >= 0 && age <= RANKING_WINDOW_WEEKS` semantics).
   * This is what stops `RankPositionQuery.sortedRankings()` — called
   * dozens of times per weekly rollover by StartDueTournamentsUseCase/
   * FormDoublesDrawUseCase — from re-reading and re-processing every
   * ledger row ever written; a result outside the window can never
   * contribute points, so excluding it in SQL is behaviour-identical.
   * Optional for test compatibility (an in-memory fake may omit it);
   * `RankPositionQuery` falls back to `findAll()` + its own in-memory
   * window filter when absent, so behaviour is unchanged either way. */
  findAllWithinWindow?(currentWeek: GameWeek, weeks: number): Promise<RankingLedgerEntry[]>;
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
   * u14, u16, u18) — what the profile page's "peak rankings" section needs
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

  /** Multiplies ONLY the listed managers' scores by `factor` — the
   * targeted counterpart to `decayAll`, for the extra inactivity
   * penalty (see `ManagerLadderPolicy.inactivityPenaltyFactor`), which
   * must hit just the managers who registered nobody that week, not
   * the whole table. Empty `managerIds` is a no-op (no query at all). */
  decayManagers(managerIds: ManagerId[], factor: number): Promise<void>;

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
  /** The player is still a free agent, but is committed to a tournament
   * that has not concluded — the deliberate rule that a signing must
   * always be clean (never inherit an in-progress draw). A distinct
   * outcome so the use case can say so plainly instead of reporting a
   * generic "no longer available". See unfinishedCommitment.ts in the
   * api package for the predicate. */
  | { kind: 'player-committed' }
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

/** Outcome of an atomic player-to-coach conversion. */
export type CoachConversionOutcome =
  | { kind: 'converted'; coach: Coach; xpSpent: number }
  | { kind: 'player-unavailable' }
  | { kind: 'insufficient-xp'; required: number; balance: number };

/**
 * Cross-aggregate port for the second operation that needs genuine
 * multi-table atomicity (the sibling of TalentClaimPort): converting a
 * rostered player into a coach spends XP, releases the player from the
 * roster, dissolves their doubles pairs, and creates the Coach — all of
 * which must succeed or fail together. Composing them from separate
 * application-layer writes reopens exactly the window this port closes
 * (XP charged but no coach, or a coach with the player still rostered).
 * The real adapter wraps the whole sequence in one DB transaction (see
 * DrizzleCoachConversionAdapter). */
export interface CoachConversionPort {
  convertAndCharge(input: {
    playerId: PlayerId;
    managerId: ManagerId;
    /** Pre-generated by the caller so the adapter is a pure writer. */
    coachId: CoachId;
    xpCost: number;
    coachRating: number;
    sourcePlayerName: string;
  }): Promise<CoachConversionOutcome>;
}

/**
 * Atomic guard for the weekly entry cap (juniorEntryCap.ts). "At most N
 * tournaments per player per week" can't be enforced by a DB constraint
 * or a single conditional UPDATE, because the count spans two tables
 * (tournament_entries + tournament_doubles_entrants, deduped by
 * tournament) across DIFFERENT tournaments. The check-then-write that
 * used to live in RegisterEntrantUseCase therefore let two concurrent
 * registrations for the same player (into different tournaments) both
 * pass — "at most 1 per week" could still land 2. The real adapter
 * serializes per (player, season, week, band) with a Postgres advisory
 * lock, recounts inside the lock, and records a claim only when still
 * under the cap, so the second concurrent writer sees the first even
 * before the first's tournament save has committed.
 */
export interface WeeklyEntryGuardPort {
  /** Returns true (recording a claim) when adding `tournamentId` keeps
   * the player at or under `cap` for the week; false when the cap would
   * be exceeded. The tournament being added is EXCLUDED from the count,
   * so a retry of the same registration is never blocked by its own
   * earlier claim. */
  tryClaimEntry(claim: {
    playerId: PlayerId;
    week: GameWeek;
    isJunior: boolean;
    tournamentId: TournamentId;
    cap: number;
  }): Promise<boolean>;
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
  /** ATOMICALLY claims this game day's practice slot: inserts the
   * (player, day) marker and returns TRUE only if THIS call created it,
   * FALSE if the player already practiced that day or a concurrent
   * request won the race. The caller must award the reward only when this
   * returns true, and only AFTER calling it — otherwise two concurrent
   * "practice" requests can both pass a read-then-write check and
   * double-award XP/fatigue/ladder. This is the once-per-day guard's
   * race-safe form; `record`/`recordedOn` remain for non-racing reads. */
  tryRecord(playerId: PlayerId, day: GameDay): Promise<boolean>;
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

/**
 * Best-effort product analytics (Phase 1 — "make it enterable"). One narrow
 * port, deliberately not part of any aggregate's repository: an event is
 * fire-and-forget telemetry, not domain state, so there is no aggregate,
 * invariant, or read side here — only a write.
 *
 * The real adapter MUST never throw: a failed analytics write must never
 * break the request that produced it. Callers fire-and-forget it.
 *
 * `props` is restricted by convention to ids and enums. NEVER pass IP,
 * user-agent, referrer, email/name, or any free text (see the
 * analytics_events schema doc comment on the API side).
 */
export interface AnalyticsEvent {
  name: string;
  /** Omitted/null = deliberately unattributed (e.g. replay opens). */
  managerId?: ManagerId | null;
  /** Optional exactly-once-per-period guard (e.g. app_open per manager per
   * day); a unique conflict is ignored. Omitted = always insert. */
  dedupeKey?: string;
  props?: Record<string, unknown>;
}

export interface AnalyticsPort {
  record(event: AnalyticsEvent): Promise<void>;
}
