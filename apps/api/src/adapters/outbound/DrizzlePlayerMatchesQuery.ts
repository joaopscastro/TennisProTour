import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { AgeBand, PlayerId, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { Db } from '../../db/client';
import { players, tournamentDoublesMatches, tournamentDoublesPairs, tournamentMatches, tournaments } from '../../db/schema';
import { isMatchAired } from './matchAir';

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
    const aired = (r: (typeof rows)[number]): boolean => isMatchAired(r.match, now);

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

  /**
   * Batch sibling of `forPlayer`, built for the Scouting pool's "is this
   * free agent already competing?" signal: for each of the given player
   * ids, the tournament they still have a match to play in, or nothing if
   * they aren't currently alive in a draw.
   *
   * "Competing" is the SAME predicate the profile strip uses
   * (`isMatchPending`): a player is competing when they have a match whose
   * result is not yet viewable — an UNPLAYED match, OR one that has been
   * simulated but is still inside its staggered reveal window. The first
   * version tested only `winner_id IS NULL`, which produced a real false
   * negative: a free agent whose match was already decided (but not yet
   * aired) showed as a pending match on their profile while the pool
   * showed no badge, so a manager could sign a mid-event player with no
   * warning. Both singles/qualifying AND doubles are covered — doubles
   * match rows are keyed by pair id, so they need the extra pair join.
   */
  async liveTournamentByPlayer(
    playerIds: PlayerId[],
  ): Promise<Map<PlayerId, { id: string; name: string }>> {
    const live = new Map<PlayerId, { id: string; name: string }>();
    if (playerIds.length === 0) return live;
    const wanted = new Set<string>(playerIds);
    const now = Date.now();

    // Singles + qualifying. The SQL prefilter fetches a SUPERSET (un-played
    // matches, or played matches that carry a reveal schedule) and the exact
    // "has aired" test is `isMatchAired` — the same predicate the profile
    // strip uses, so a decided-but-not-yet-aired match counts as competing
    // (previously `winner_id IS NULL` missed it: a genuine false negative
    // that let a manager sign a player mid-event with no badge).
    const rows = await this.db
      .select({ match: tournamentMatches, tournament: tournaments })
      .from(tournamentMatches)
      .innerJoin(tournaments, eq(tournaments.id, tournamentMatches.tournamentId))
      .where(
        and(
          or(inArray(tournamentMatches.entrantA, playerIds), inArray(tournamentMatches.entrantB, playerIds)),
          or(isNull(tournamentMatches.winnerId), isNotNull(tournamentMatches.scheduledStartAt)),
        ),
      );

    for (const { match, tournament } of rows) {
      if (isMatchAired(match, now)) continue;
      for (const entrant of [match.entrantA, match.entrantB]) {
        const pid = PlayerId(entrant);
        if (wanted.has(pid) && !live.has(pid)) {
          live.set(pid, { id: tournament.id, name: tournament.name });
        }
      }
    }

    // Doubles. Match rows are keyed by PAIR id, not player id, so this needs
    // its own join: a player only in a doubles draw with a match still to
    // play is competing too (previously unflagged — the disclosed gap).
    const doublesRows = await this.db
      .select({ match: tournamentDoublesMatches, tournament: tournaments, pair: tournamentDoublesPairs })
      .from(tournamentDoublesPairs)
      .innerJoin(tournaments, eq(tournaments.id, tournamentDoublesPairs.tournamentId))
      .innerJoin(
        tournamentDoublesMatches,
        and(
          eq(tournamentDoublesMatches.tournamentId, tournamentDoublesPairs.tournamentId),
          or(
            eq(tournamentDoublesMatches.entrantA, tournamentDoublesPairs.pairId),
            eq(tournamentDoublesMatches.entrantB, tournamentDoublesPairs.pairId),
          ),
        ),
      )
      .where(
        or(inArray(tournamentDoublesPairs.playerA, playerIds), inArray(tournamentDoublesPairs.playerB, playerIds)),
      );

    for (const { match, tournament, pair } of doublesRows) {
      if (isMatchAired(match, now)) continue;
      for (const raw of [pair.playerA, pair.playerB]) {
        const pid = PlayerId(raw);
        if (wanted.has(pid) && !live.has(pid)) {
          live.set(pid, { id: tournament.id, name: tournament.name });
        }
      }
    }

    return live;
  }
}
