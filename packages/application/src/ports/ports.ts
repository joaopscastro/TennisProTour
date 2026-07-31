import { Player } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { ManagerId, PlayerId, TournamentId, GameWeek, MatchId } from '@tennis-manager/domain';
import { MatchLog } from '@tennis-manager/domain';

/**
 * Interface Segregation in practice: one narrow repository interface
 * per aggregate, not a single "GameRepository" god-interface. A use
 * case that only needs players never has to depend on (or mock)
 * tournament persistence.
 */
export interface PlayerRepository {
  findById(id: PlayerId): Promise<Player | null>;
  findByManager(managerId: ManagerId): Promise<Player[]>;
  save(player: Player): Promise<void>;
}

export interface TournamentRepository {
  findById(id: TournamentId): Promise<Tournament | null>;
  findOpenForRegistration(): Promise<Tournament[]>;
  save(tournament: Tournament): Promise<void>;
}

/** The domain never reads Date.now() directly — everything runs on
 * in-game weeks, and tests can inject a fixed clock. */
export interface ClockPort {
  currentWeek(): GameWeek;
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
