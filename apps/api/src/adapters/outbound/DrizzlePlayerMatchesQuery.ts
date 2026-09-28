import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { AgeBand, PlayerId, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { Db } from '../../db/client';
import { players, tournamentDoublesMatches, tournamentDoublesPairs, tournamentMatches, tournaments } from '../../db/schema';
import { isMatchAired } from './matchAir';
import { doublesMainDrawUnfinished, singlesMainDrawUnfinished } from './unfinishedCommitment';

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
  /** Most recent DECIDED AND AIRED DOUBLES matches this player was in,
   * newest first — the doubles sibling of `recent`, added because no
   * doubles recent-results read existed anywhere (a measured agent season
   * had doubles results invisible to every consumer). Same air gating
   * (`isMatchAired`), same bounded size, same summary shape; the
   * opponent fields describe the opposing PAIR (name = "A & B", id =
   * the opposing pair id) via the same pair join `liveTournamentByPlayer`
   * already uses. Additive: every existing singles field is untouched. */
  recentDoubles: PlayerMatchSummary[];
  /** The player's earliest not-yet-simulated match, if they're still
   * alive in a started/open tournament — else null. */
  next: PlayerMatchSummary | null;
  /** The player's earliest GENUINELY UNPLAYED match (no outcome yet),
   * ordered by scheduled week/round ascending — else null.
   *
   * Deliberately distinct from `next`: `next` is the profile's
   * "reveal-order" read and can therefore be a DECIDED match whose
   * reveal window hasn't elapsed yet (the staged Premiere countdown the
   * profile strip shows), while `nextPending` only ever answers "what
   * has this player still to PLAY". The agent-season digest consumed
   * `next` and so reported a long-decided, result-hidden match as the
   * "next match" for many game weeks in a compressed-time harness — see
   * DrizzlePlayerMatchesQuery's class doc comment. Additive: every
   * existing caller of this read is unaffected. */
  nextPending: PlayerMatchSummary | null;
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
 *
 * `next` is therefore the profile's reveal-order read and may be a
 * decided (result-hidden) match; `nextPending` is the same read's
 * genuinely-unplayed-only counterpart, for consumers (the agent-season
 * digest) whose question is "what does this player still have to play",
 * never "what hasn't aired". Both are computed from the same rows in one
 * pass, so they can never disagree about which unplayed match is
 * earliest.
 */
export class DrizzlePlayerMatchesQuery {
  constructor(private readonly db: Db) {}

  async forPlayer(playerId: PlayerId): Promise<PlayerMatchesResult> {
    const now = Date.now();
    // The doubles half runs independently of the singles rows — a player
    // can have doubles matches without ever appearing in a singles
    // bracket, so this must NOT sit behind the `rows.length === 0`
    // early-return below.
    const recentDoubles = await this.recentDoublesForPlayer(playerId, now);

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

    if (rows.length === 0) return { recent: [], next: null, nextPending: null, recentDoubles };

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
    // in (the port's documented contract). Simulated-but-not-aired
    // matches (scheduledStartAt set) come first — ordered by their
    // reveal start — because they're closest; truly pending matches (no
    // schedule yet, their round isn't due) follow, earliest scheduled
    // week first.
    //
    // The unscheduled tie-break sorts season/week ASCENDING. It used to
    // be DESCENDING (the `b - a` shape above, copied from `recent`'s
    // newest-first intent), so a player still alive in two future-week
    // draws got "next" = the LATER week — the opposite of the port's
    // "earliest not-yet-simulated" contract, and of the ascending
    // roundNumber tie-break within one week.
    const notAired = rows.filter((r) => !aired(r));
    notAired.sort((a, b) => {
      const aStart = a.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bStart = b.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return (
        a.tournament.seasonScheduled - b.tournament.seasonScheduled ||
        a.tournament.weekScheduled - b.tournament.weekScheduled ||
        a.match.roundNumber - b.match.roundNumber
      );
    });
    const next = notAired.length > 0 ? toSummary(notAired[0], 'pending') : null;

    // `nextPending` — the earliest UNPLAYED match only (see the port
    // interface's doc comment). Decided-but-unaired matches are excluded
    // even when their scheduled reveal start is EARLIER than the next
    // unplayed one: their result already exists and will surface in
    // `recent` once aired, whereas "next" for a digest must mean "still
    // to play". Same ascending season/week/round ordering the unscheduled
    // branch of `next` uses, so the two never disagree about which
    // unplayed match is earliest.
    const undecided = rows
      .filter((r) => r.match.winnerId === null)
      .sort(
        (a, b) =>
          a.tournament.seasonScheduled - b.tournament.seasonScheduled ||
          a.tournament.weekScheduled - b.tournament.weekScheduled ||
          a.match.roundNumber - b.match.roundNumber,
      );
    const nextPending = undecided.length > 0 ? toSummary(undecided[0], 'pending') : null;

    return { recent, next, nextPending, recentDoubles };
  }

  /**
   * The doubles sibling of the `recent` half of `forPlayer`: the
   * player's most recent decided AND AIRED doubles matches, newest first,
   * bounded by the same RECENT_LIMIT.
   *
   * Doubles match rows are keyed by PAIR id, not player id, so this needs
   * its own two joins: the player's `tournament_doubles_pairs` rows find
   * the pair ids they played under, and each match's OPPOSING entrant is
   * resolved back through `tournament_doubles_pairs` to name the opposing
   * pair (exactly the pair join `liveTournamentByPlayer` already uses).
   * Air gating is the same `isMatchAired` predicate as singles — a
   * decided-but-still-revealing doubles result is NOT reported here, so
   * the API and the replay/bracket views can never disagree.
   */
  private async recentDoublesForPlayer(playerId: PlayerId, now: number): Promise<PlayerMatchSummary[]> {
    const playerPairs = await this.db
      .select({ pair: tournamentDoublesPairs })
      .from(tournamentDoublesPairs)
      .where(or(eq(tournamentDoublesPairs.playerA, playerId), eq(tournamentDoublesPairs.playerB, playerId)));
    if (playerPairs.length === 0) return [];
    const myPairIds = new Set(playerPairs.map((r) => r.pair.pairId));

    const rows = await this.db
      .select({ match: tournamentDoublesMatches, tournament: tournaments })
      .from(tournamentDoublesMatches)
      .innerJoin(tournaments, eq(tournaments.id, tournamentDoublesMatches.tournamentId))
      .where(
        or(
          inArray(tournamentDoublesMatches.entrantA, [...myPairIds]),
          inArray(tournamentDoublesMatches.entrantB, [...myPairIds]),
        ),
      );
    if (rows.length === 0) return [];

    // Resolve the opposing pair -> its two players, in one extra read.
    const opponentPairIds = new Set<string>();
    for (const { match } of rows) {
      if (myPairIds.has(match.entrantA)) opponentPairIds.add(match.entrantB);
      if (myPairIds.has(match.entrantB)) opponentPairIds.add(match.entrantA);
    }
    const opponentPairs = opponentPairIds.size
      ? await this.db
          .select({ pair: tournamentDoublesPairs })
          .from(tournamentDoublesPairs)
          .where(inArray(tournamentDoublesPairs.pairId, [...opponentPairIds]))
      : [];
    const opponentPairById = new Map(opponentPairs.map((r) => [r.pair.pairId, r.pair]));
    const opponentPlayerIds = new Set<string>();
    for (const { pair } of opponentPairs) {
      opponentPlayerIds.add(pair.playerA);
      opponentPlayerIds.add(pair.playerB);
    }
    const opponentPlayers = opponentPlayerIds.size
      ? await this.db
          .select({ id: players.id, name: players.name, nationality: players.nationality })
          .from(players)
          .where(inArray(players.id, [...opponentPlayerIds]))
      : [];
    const playerById = new Map(opponentPlayers.map((p) => [p.id, p]));

    return rows
      .filter((r) => isMatchAired(r.match, now))
      .sort(
        (a, b) =>
          b.tournament.seasonScheduled - a.tournament.seasonScheduled ||
          b.tournament.weekScheduled - a.tournament.weekScheduled ||
          b.match.roundNumber - a.match.roundNumber,
      )
      .slice(0, RECENT_LIMIT)
      .map(({ match, tournament }) => {
        const myPairId = myPairIds.has(match.entrantA) ? match.entrantA : match.entrantB;
        const opponentPairId = myPairId === match.entrantA ? match.entrantB : match.entrantA;
        const opponentPair = opponentPairById.get(opponentPairId);
        const playerA = opponentPair ? playerById.get(opponentPair.playerA) : undefined;
        const playerB = opponentPair ? playerById.get(opponentPair.playerB) : undefined;
        return {
          tournamentId: TournamentId(tournament.id),
          tournamentName: tournament.name,
          tier: tournament.tier,
          ageBand: tournament.ageBand as AgeBand | null,
          surface: tournament.surface,
          roundNumber: match.roundNumber,
          drawSize: tournament.doublesDrawSize ?? tournament.drawSize,
          weekScheduled: { season: tournament.seasonScheduled, week: tournament.weekScheduled },
          opponentId: opponentPairId,
          opponentName: opponentPair
            ? `${playerA?.name ?? opponentPair.playerA} & ${playerB?.name ?? opponentPair.playerB}`
            : 'Unknown pair',
          opponentNationality: playerA?.nationality ?? 'XX',
          result: match.winnerId === myPairId ? 'win' : 'loss',
          setScores: match.setScores ?? [],
          scheduledStartAt: match.scheduledStartAt ? match.scheduledStartAt.toISOString() : null,
          revealSeconds: match.revealSeconds ?? 0,
        };
      });
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

  /**
   * Batch read of the SIGNING-BLOCKING commitment: for each of the given
   * player ids, the unfinished tournament they hold an entry/pair in, or
   * nothing when they are free to sign. This is the read twin of the
   * atomic claim's `noUnfinishedCommitment` predicate (see
   * unfinishedCommitment.ts — the exact same SQL fragments), so a
   * candidate the Scouting pool marks unsignable is exactly one the
   * atomic claim would refuse, even under a concurrent draw-seed.
   *
   * Deliberately distinct from `liveTournamentByPlayer`: that answers
   * "do they have a match still to air?" (match-level, for the Competing
   * badge), while this answers "are they committed to a tournament that
   * has not concluded?" (tournament-level, the signing rule). A player
   * entered in a draw that has not started is committed here but not
   * "competing" there.
   */
  async unfinishedCommitmentByPlayer(
    playerIds: PlayerId[],
  ): Promise<Map<PlayerId, { id: string; name: string }>> {
    const blocking = new Map<PlayerId, { id: string; name: string }>();
    if (playerIds.length === 0) return blocking;
    const result = await this.db.execute(sql`
      SELECT e.player_id AS player_id, t.id AS tournament_id, t.name AS tournament_name
      FROM tournament_entries e
      JOIN tournaments t ON t.id = e.tournament_id
      WHERE e.player_id IN ${playerIds} AND ${singlesMainDrawUnfinished}
      UNION ALL
      SELECT de.player_id, t.id, t.name
      FROM tournament_doubles_entrants de
      JOIN tournaments t ON t.id = de.tournament_id
      WHERE de.player_id IN ${playerIds} AND ${doublesMainDrawUnfinished}
      UNION ALL
      SELECT dp.player_a, t.id, t.name
      FROM tournament_doubles_pairs dp
      JOIN tournaments t ON t.id = dp.tournament_id
      WHERE dp.player_a IN ${playerIds} AND ${doublesMainDrawUnfinished}
      UNION ALL
      SELECT dp.player_b, t.id, t.name
      FROM tournament_doubles_pairs dp
      JOIN tournaments t ON t.id = dp.tournament_id
      WHERE dp.player_b IN ${playerIds} AND ${doublesMainDrawUnfinished}
    `);
    for (const row of result.rows as Array<{ player_id: string; tournament_id: string; tournament_name: string }>) {
      const pid = PlayerId(row.player_id);
      if (!blocking.has(pid)) blocking.set(pid, { id: row.tournament_id, name: row.tournament_name });
    }
    return blocking;
  }
}
