import { eq, inArray, or } from 'drizzle-orm';
import { AgeBand, PlayerId, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { Db } from '../../db/client';
import { players, tournamentMatches, tournaments } from '../../db/schema';

export interface PlayerMatchSummary {
  tournamentId: TournamentId;
  tournamentName: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  surface: string;
  roundNumber: number;
  drawSize: number;
  weekScheduled: { season: number; week: number };
  opponentId: string;
  opponentName: string;
  opponentNationality: string;
  /** 'win'/'loss' for a decided match; 'pending' for the player's next,
   * not-yet-simulated match. */
  result: 'win' | 'loss' | 'pending';
  /** MatchOutcome.setScores verbatim, oriented winner-first — null for a
   * pending match. */
  setScores: Array<{ winnerGames: number; loserGames: number }> | null;
}

export interface PlayerMatchesResult {
  /** Most recent DECIDED matches this player was in, newest first
   * (bounded — profile-facing, not a full history; that's the history
   * subpage's job via DrizzlePlayerTournamentHistoryQuery). */
  recent: PlayerMatchSummary[];
  /** The player's earliest not-yet-simulated match, if they're still
   * alive in a started/open tournament — else null. */
  next: PlayerMatchSummary | null;
}

const RECENT_LIMIT = 5;

/**
 * The player-profile "latest results + next match" read. Reuses the
 * existing tournament_matches/tournaments/players tables (no new store)
 * exactly like DrizzlePlayerTournamentHistoryQuery does — this is the
 * per-match sibling of that per-tournament query.
 *
 * Deliberately exposes NO per-match countdown/time: matches are swept
 * synchronously when due, with no per-match schedule to count down to
 * (see docs/CLAUDE.md's world-clock section — building a fake per-match
 * timer would misrepresent how simulation actually behaves). The "next"
 * match is honest about being the next match, not "in Xm Ys".
 */
export class DrizzlePlayerMatchesQuery {
  constructor(private readonly db: Db) {}

  async forPlayer(playerId: PlayerId): Promise<PlayerMatchesResult> {
    const rows = await this.db
      .select({
        match: tournamentMatches,
        tournament: tournaments,
      })
      .from(tournamentMatches)
      .innerJoin(tournaments, eq(tournaments.id, tournamentMatches.tournamentId))
      .where(
        or(eq(tournamentMatches.entrantA, playerId), eq(tournamentMatches.entrantB, playerId)),
      );

    if (rows.length === 0) return { recent: [], next: null };

    // Resolve opponent identities in one extra query.
    const opponentIds = new Set<string>();
    for (const { match } of rows) {
      opponentIds.add(match.entrantA === playerId ? match.entrantB : match.entrantA);
    }
    const opponentRows = await this.db
      .select({ id: players.id, name: players.name, nationality: players.nationality })
      .from(players)
      .where(inArray(players.id, [...opponentIds]));
    const opponentById = new Map(opponentRows.map((o) => [o.id, o]));

    const toSummary = (
      row: (typeof rows)[number],
      result: 'win' | 'loss' | 'pending',
    ): PlayerMatchSummary => {
      const { match, tournament } = row;
      const opponentId = match.entrantA === playerId ? match.entrantB : match.entrantA;
      const opponent = opponentById.get(opponentId);
      return {
        tournamentId: TournamentId(tournament.id),
        tournamentName: tournament.name,
        tier: tournament.tier,
        ageBand: tournament.ageBand as AgeBand | null,
        surface: tournament.surface,
        roundNumber: match.roundNumber,
        drawSize: tournament.drawSize,
        weekScheduled: { season: tournament.seasonScheduled, week: tournament.weekScheduled },
        opponentId,
        opponentName: opponent?.name ?? 'Unknown',
        opponentNationality: opponent?.nationality ?? 'XX',
        result,
        setScores: result === 'pending' ? null : match.setScores ?? [],
      };
    };

    const decided = rows
      .filter((r) => r.match.winnerId !== null)
      .sort(
        (a, b) =>
          b.tournament.seasonScheduled - a.tournament.seasonScheduled ||
          b.tournament.weekScheduled - a.tournament.weekScheduled ||
          b.match.roundNumber - a.match.roundNumber,
      );

    const recent = decided
      .slice(0, RECENT_LIMIT)
      .map((r) => toSummary(r, r.match.winnerId === playerId ? 'win' : 'loss'));

    // "Next" = the earliest-round pending match in the newest-scheduled
    // tournament the player is still alive in.
    const pending = rows
      .filter((r) => r.match.winnerId === null)
      .sort(
        (a, b) =>
          b.tournament.seasonScheduled - a.tournament.seasonScheduled ||
          b.tournament.weekScheduled - a.tournament.weekScheduled ||
          a.match.roundNumber - b.match.roundNumber,
      );
    const next = pending.length > 0 ? toSummary(pending[0], 'pending') : null;

    return { recent, next };
  }
}
