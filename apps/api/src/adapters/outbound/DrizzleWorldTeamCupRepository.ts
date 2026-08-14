import { eq } from 'drizzle-orm';
import { PairId, PlayerId, Surface, TournamentId, WorldTeamCup, WorldTeamCupGroup, WorldTeamCupTeam, WorldTeamCupTie } from '@tennis-manager/domain';
import { WorldTeamCupRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { worldTeamCups } from '../../db/schema';

type Row = typeof worldTeamCups.$inferSelect;

/** Drizzle-backed WorldTeamCupRepository (P8c) — one cup per season, the
 * whole aggregate read/written as jsonb blobs. */
export class DrizzleWorldTeamCupRepository implements WorldTeamCupRepository {
  constructor(private readonly db: Db) {}

  async findBySeason(season: number): Promise<WorldTeamCup | null> {
    const rows = await this.db.select().from(worldTeamCups).where(eq(worldTeamCups.season, season)).limit(1);
    if (rows.length === 0) return null;
    return toDomain(rows[0]);
  }

  async save(cup: WorldTeamCup): Promise<void> {
    const row = {
      id: cup.id,
      season: cup.season,
      weekScheduledSeason: cup.weekScheduled.season,
      weekScheduledWeek: cup.weekScheduled.week,
      surface: cup.surface,
      teams: cup.teams.map((t) => ({ country: t.country, players: [...t.players] })),
      groups: [...cup.groups],
      knockout: cup.knockout.map((round) => [...round]),
    };
    await this.db
      .insert(worldTeamCups)
      .values(row)
      .onConflictDoUpdate({ target: worldTeamCups.id, set: { ...row, updatedAt: new Date() } });
  }
}

function toDomain(row: Row): WorldTeamCup {
  return WorldTeamCup.reconstitute({
    id: TournamentId(row.id),
    season: row.season,
    weekScheduled: { season: row.weekScheduledSeason, week: row.weekScheduledWeek },
    surface: row.surface as Surface,
    teams: row.teams.map(
      (t): WorldTeamCupTeam => ({ country: t.country, players: t.players.map(PlayerId) as [PlayerId, PlayerId] }),
    ),
    groups: row.groups as WorldTeamCupGroup[],
    knockoutRounds: row.knockout as WorldTeamCupTie[][],
  });
}
