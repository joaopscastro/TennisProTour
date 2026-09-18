import { sql } from 'drizzle-orm';
import { GameWeek, PlayerId, TournamentId } from '@tennis-manager/domain';
import { WeeklyEntryGuardPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { weeklyEntryClaims } from '../../db/schema';

interface Claim {
  playerId: PlayerId;
  week: GameWeek;
  isJunior: boolean;
  tournamentId: TournamentId;
  cap: number;
}

/**
 * See WeeklyEntryGuardPort's doc comment for why this needs to exist.
 * The whole claim/recount runs inside one transaction while holding a
 * Postgres advisory lock keyed to (player, season, week, band) — the
 * lock is transaction-scoped (pg_advisory_xact_lock), so it releases
 * automatically on commit/rollback and can never be leaked by a crash.
 * Under that lock the count is a UNION of the player's real entries
 * (singles + doubles, deduped by tournament) and any in-flight claims,
 * EXCLUDING the tournament being registered — so a retry of the same
 * registration, and a concurrent duplicate double-click on the same
 * tournament, both still pass, while a genuinely different second
 * tournament is refused. Junior vs senior is read off the tournament's
 * own `age_band IS NOT NULL` (Tournament enforces junior ⟺ ageBand
 * non-null), matching countSameBandEntriesForWeek's isJuniorTier split.
 */
export class DrizzleWeeklyEntryGuardAdapter implements WeeklyEntryGuardPort {
  constructor(private readonly db: Db) {}

  async tryClaimEntry(claim: Claim): Promise<boolean> {
    const lockKey = `${claim.playerId}:${claim.week.season}:${claim.week.week}:${claim.isJunior ? 'j' : 's'}`;
    const { playerId, week, isJunior, tournamentId, cap } = claim;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const counted = await tx.execute(sql`
        SELECT count(*)::int AS c FROM (
          SELECT te.tournament_id
            FROM tournament_entries te
            JOIN tournaments t ON t.id = te.tournament_id
           WHERE te.player_id = ${playerId}
             AND te.tournament_id <> ${tournamentId}
             AND t.season_scheduled = ${week.season}
             AND t.week_scheduled = ${week.week}
             AND (t.age_band IS NOT NULL) = ${isJunior}
          UNION
          SELECT td.tournament_id
            FROM tournament_doubles_entrants td
            JOIN tournaments t ON t.id = td.tournament_id
           WHERE td.player_id = ${playerId}
             AND td.tournament_id <> ${tournamentId}
             AND t.season_scheduled = ${week.season}
             AND t.week_scheduled = ${week.week}
             AND (t.age_band IS NOT NULL) = ${isJunior}
          UNION
          SELECT tournament_id FROM weekly_entry_claims
           WHERE player_id = ${playerId}
             AND tournament_id <> ${tournamentId}
             AND season = ${week.season}
             AND week = ${week.week}
             AND is_junior = ${isJunior}
        ) x
      `);
      const others = Number((counted.rows[0] as { c: number }).c);
      if (others >= cap) return false;

      await tx
        .insert(weeklyEntryClaims)
        .values({
          playerId,
          season: week.season,
          week: week.week,
          isJunior,
          tournamentId,
        })
        .onConflictDoNothing();

      return true;
    });
  }
}
