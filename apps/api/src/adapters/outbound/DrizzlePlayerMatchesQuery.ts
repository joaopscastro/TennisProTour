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
  /** 'win'/'loss' for a decided AND aired match; 'pending' for the
   * player's next not-yet-aired match (whether truly un-simulated or
   * simulated-but-inside its staggered reveal window — the result is
   * hidden either way until the match airs). */
  result: 'win' | 'loss' | 'pending';
  /** MatchOutcome.setScores verbatim, oriented winner-first — null for a
   * not-yet-aired match. */
  setScores: Array<{ winnerGames: number; loserGames: number }> | null;
  /** The match's scheduled reveal start (ISO), when the staggered
   * schedule has assigned one — null for a match that hasn't been
   * simulated yet. The profile counts down to this. */
  scheduledStartAt: string | null;
  /** Real-time seconds the reveal occupies (0 when not scheduled). */
  revealSeconds: number;
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
 * Respects the staggered-match-schedule reveal window (see
 * matchSchedule.ts): a decided match whose reveal window hasn't ended is
 * NOT a "recent result" — it is the "next" match, shown with its
 * scheduledStartAt so the profile can count down ("playing in 3:45")
 * rather than spoil the result before it airs. A match is "aired" once
 * it has an outcome AND (no schedule, or its reveal window has elapsed).
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
        scheduledStartAt: match.scheduledStartAt ? match.scheduledStartAt.toISOString() : null,
        revealSeconds: match.revealSeconds ?? 0,
      };
    };

    const now = Date.now();
    const aired = (r: (typeof rows)[number]): boolean =>
      r.match.winnerId !== null &&
      (r.match.scheduledStartAt === null ||
        now >= r.match.scheduledStartAt.getTime() + (r.match.revealSeconds ?? 0) * 1000);

    const decided = rows
      .filter(aired)
      .sort(
        (a, b) =>
          b.tournament.seasonScheduled - a.tournament.seasonScheduled ||
          b.tournament.weekScheduled - a.tournament.weekScheduled ||
          b.match.roundNumber - a.match.roundNumber,
      );

    const recent = decided
      .slice(0, RECENT_LIMIT)
      .map((r) => toSummary(r, r.match.winnerId === playerId ? 'win' : 'loss'));

    // "Next" = the earliest not-yet-aired match the player is still alive
    // in. Simulated-but-not-aired matches (scheduledStartAt set) come
    // first — ordered by their reveal start — because they're closest;
    // truly pending matches (no schedule yet, their round isn't due)
    // follow.
    const notAired = rows.filter((r) => !aired(r));
    notAired.sort((a, b) => {
      const aStart = a.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bStart = b.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return (
        b.tournament.seasonScheduled - a.tournament.seasonScheduled ||
        b.tournament.weekScheduled - a.tournament.weekScheduled ||
        a.match.roundNumber - b.match.roundNumber
      );
    });
    const next = notAired.length > 0 ? toSummary(notAired[0], 'pending') : null;

    return { recent, next };
  }
}
