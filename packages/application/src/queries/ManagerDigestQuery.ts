import { AgeBand, ManagerId, PlayerId, TournamentTier } from '@tennis-manager/domain';

/**
 * Notifications bounded context (STAGE 1) — the read model behind the
 * manager results digest. Deliberately a QUERY interface (like
 * RankPositionQuery) rather than an aggregate repository: it composes
 * existing tables (players/tournaments/tournament_matches/titles) into a
 * per-manager view, and the real adapter goes straight to those tables
 * with no new store.
 *
 * The shapes below are pure data (no I/O), so `buildManagerDigest` —
 * the function that window-filters and assembles them — is unit-testable
 * against literals. `load` pre-filters at the DB level for efficiency;
 * `buildManagerDigest` re-filters defensively, which is also what the
 * pure tests pin.
 */

/** A decided match's set scores, verbatim winner-first (the same
 * orientation MatchOutcome.setScores uses). */
export interface DigestSetScore {
  winnerGames: number;
  loserGames: number;
}

/** One decided, AIRED main-draw singles match for a rostered player. */
export interface DigestResult {
  matchId: string;
  tournamentId: string;
  tournamentName: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  roundNumber: number;
  drawSize: number;
  opponentName: string;
  /** From the digesting player's perspective. */
  won: boolean;
  /** Winner-first, like MatchOutcome.setScores — the renderer flips it
   * for the digesting player's perspective. */
  setScores: DigestSetScore[];
  /** `scheduled_start_at + reveal_seconds` — when the result actually
   * aired. This, NOT a row timestamp, is the only trustworthy "when did
   * this happen" value (DrizzleTournamentRepository.save deletes and
   * re-inserts match rows, so created_at/updated_at reset constantly). */
  airedAt: Date;
}

/** A title won inside the digest window. */
export interface DigestTitle {
  tournamentId: string;
  tournamentName: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  createdAt: Date;
}

/** A player's next not-yet-aired main-draw match. */
export interface DigestNextMatch {
  tournamentId: string;
  tournamentName: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  roundNumber: number;
  drawSize: number;
  opponentName: string;
  /** Null when the staggered schedule hasn't assigned a reveal start yet. */
  scheduledStartAt: Date | null;
}

/** One rostered player's raw digest facts, as the query returns them. */
export interface DigestPlayerData {
  playerId: PlayerId;
  name: string;
  /** The eligibility age used to pick this player's ranking band — the
   * use case resolves it via `juniorEligibilityForAge`. */
  seasonAgeAnchorWeeks: number;
  results: DigestResult[];
  titles: DigestTitle[];
  next: DigestNextMatch | null;
}

export interface ManagerDigestQuery {
  /** Every manager who currently rosters at least one player — the
   * enumeration the digest use case iterates. (There is no separate
   * manager-listing port in this bounded context; the query that already
   * knows about rosters is the natural owner of "who has a digest".) */
  listManagerIds(): Promise<ManagerId[]>;
  /** This manager's rostered players with their raw results/titles/next
   * (already window-bounded by the adapter for efficiency). */
  load(input: { managerId: ManagerId; since: Date; until: Date }): Promise<DigestPlayerData[]>;
}
