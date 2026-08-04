import { Player } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { ManagerId, PlayerId, TournamentId, GameWeek, MatchId, WorldId } from '@tennis-manager/domain';
import { MatchLog, GameWorld, RankingLedgerEntry } from '@tennis-manager/domain';

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
