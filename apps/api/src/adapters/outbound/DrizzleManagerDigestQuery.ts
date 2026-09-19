import { and, eq, gt, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { AgeBand, ManagerId, PlayerId, TournamentTier } from '@tennis-manager/domain';
import {
  DigestNextMatch,
  DigestPlayerData,
  DigestResult,
  DigestTitle,
  ManagerDigestQuery,
} from '@tennis-manager/application';
import { Db } from '../../db/client';
import { players, titles, tournamentMatches, tournaments } from '../../db/schema';

/**
 * Drizzle-backed ManagerDigestQuery (Notifications STAGE 1).
 *
 * CRITICAL: `DrizzleTournamentRepository.save` DELETEs and re-INSERTs
 * every `tournament_matches` row on each save, so `created_at`/
 * `updated_at` on a match row are reset constantly and are USELESS for
 * "when did this result happen". Every timestamp here is therefore keyed
 * EXCLUSIVELY on `scheduled_start_at`: a match airs at
 * `scheduled_start_at + coalesce(reveal_seconds, 0)` seconds — the same
 * reveal arithmetic DrizzlePlayerMatchesQuery uses. A decided match with
 * no `scheduled_start_at` simply cannot be placed in a window and is
 * excluded (it was never given a staggered reveal).
 *
 * Singles, MAIN draw, decided results only. The "next pending" match is
 * a main-draw match not yet aired (either not simulated, or simulated
 * but still inside its reveal window) — `until` is the reference instant
 * (the use case passes `now`).
 */
export class DrizzleManagerDigestQuery implements ManagerDigestQuery {
  constructor(private readonly db: Db) {}

  async listManagerIds(): Promise<ManagerId[]> {
    const rows = await this.db
      .selectDistinct({ managerId: players.managerId })
      .from(players)
      .where(isNotNull(players.managerId));
    return rows
      .map((row) => row.managerId)
      .filter((id): id is string => id !== null)
      .map((id) => ManagerId(id));
  }

  async load(input: { managerId: ManagerId; since: Date; until: Date }): Promise<DigestPlayerData[]> {
    const { managerId, since, until } = input;

    const roster = await this.db
      .select({ id: players.id, name: players.name, seasonAgeAnchorWeeks: players.seasonAgeAnchorWeeks })
      .from(players)
      .where(eq(players.managerId, managerId));
    if (roster.length === 0) return [];

    const playerIds = roster.map((row) => row.id);

    const matchRows = await this.db
      .select({ match: tournamentMatches, tournament: tournaments })
      .from(tournamentMatches)
      .innerJoin(tournaments, eq(tournaments.id, tournamentMatches.tournamentId))
      .where(
        and(
          eq(tournamentMatches.draw, 'main'),
          or(inArray(tournamentMatches.entrantA, playerIds), inArray(tournamentMatches.entrantB, playerIds)),
        ),
      );

    const involvedIds = new Set<string>();
    for (const { match } of matchRows) {
      involvedIds.add(match.entrantA);
      involvedIds.add(match.entrantB);
    }
    const nameById = new Map<string, string>();
    if (involvedIds.size > 0) {
      const nameRows = await this.db
        .select({ id: players.id, name: players.name })
        .from(players)
        .where(inArray(players.id, [...involvedIds]));
      for (const row of nameRows) nameById.set(row.id, row.name);
    }

    const titleRows = await this.db
      .select({ title: titles, tournament: tournaments })
      .from(titles)
      .innerJoin(tournaments, eq(tournaments.id, titles.tournamentId))
      .where(
        and(inArray(titles.playerId, playerIds), gt(titles.createdAt, since), lte(titles.createdAt, until)),
      );

    return roster.map((player) => {
      const ownMatches = matchRows.filter(
        (row) => row.match.entrantA === player.id || row.match.entrantB === player.id,
      );

      const airedAtOf = (match: (typeof matchRows)[number]['match']): Date | null =>
        match.scheduledStartAt
          ? new Date(match.scheduledStartAt.getTime() + (match.revealSeconds ?? 0) * 1000)
          : null;

      const results: DigestResult[] = ownMatches
        .map((row) => {
          const airedAt = airedAtOf(row.match);
          if (row.match.winnerId === null || airedAt === null) return null;
          if (airedAt.getTime() <= since.getTime() || airedAt.getTime() > until.getTime()) return null;
          const opponentId = row.match.entrantA === player.id ? row.match.entrantB : row.match.entrantA;
          return {
            matchId: `${row.match.tournamentId}:${row.match.draw}:${row.match.roundNumber}:${row.match.matchIndex}`,
            tournamentId: row.match.tournamentId,
            tournamentName: row.tournament.name,
            tier: row.tournament.tier as TournamentTier,
            ageBand: row.tournament.ageBand as AgeBand | null,
            roundNumber: row.match.roundNumber,
            drawSize: row.tournament.drawSize,
            opponentName: nameById.get(opponentId) ?? 'Unknown',
            won: row.match.winnerId === player.id,
            setScores: row.match.setScores ?? [],
            airedAt,
          };
        })
        .filter((result): result is DigestResult => result !== null)
        .sort((a, b) => b.airedAt.getTime() - a.airedAt.getTime());

      const pending = ownMatches
        .filter((row) => {
          const airedAt = airedAtOf(row.match);
          return row.match.winnerId === null || airedAt === null || airedAt.getTime() > until.getTime();
        })
        .sort((a, b) => {
          const aStart = a.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
          const bStart = b.match.scheduledStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
          if (aStart !== bStart) return aStart - bStart;
          return a.match.roundNumber - b.match.roundNumber;
        });

      const next: DigestNextMatch | null =
        pending.length === 0
          ? null
          : (() => {
              const row = pending[0];
              const opponentId = row.match.entrantA === player.id ? row.match.entrantB : row.match.entrantA;
              return {
                tournamentId: row.match.tournamentId,
                tournamentName: row.tournament.name,
                tier: row.tournament.tier as TournamentTier,
                ageBand: row.tournament.ageBand as AgeBand | null,
                roundNumber: row.match.roundNumber,
                drawSize: row.tournament.drawSize,
                opponentName: nameById.get(opponentId) ?? 'Unknown',
                scheduledStartAt: row.match.scheduledStartAt,
              };
            })();

      const playerTitles: DigestTitle[] = titleRows
        .filter((row) => row.title.playerId === player.id)
        .map((row) => ({
          tournamentId: row.title.tournamentId,
          tournamentName: row.tournament.name,
          tier: row.title.tier as TournamentTier,
          ageBand: row.title.ageBand as AgeBand | null,
          createdAt: row.title.createdAt,
        }));

      return {
        playerId: PlayerId(player.id),
        name: player.name,
        seasonAgeAnchorWeeks: player.seasonAgeAnchorWeeks,
        results,
        titles: playerTitles,
        next,
      };
    });
  }
}
