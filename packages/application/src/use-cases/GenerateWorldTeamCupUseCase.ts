import { GameWeek, PlayerId, Surface, TournamentId, WorldId, WorldTeamCup, WorldTeamCupTeam } from '@tennis-manager/domain';
import { IdGeneratorPort, PlayerRepository, WorldTeamCupRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';

export interface GenerateWorldTeamCupCommand {
  worldId: WorldId;
  season: number;
  weekScheduled: GameWeek;
  surface: Surface;
}

const TEAM_COUNT = 8;
const PLAYERS_PER_TEAM = 2;

/**
 * Generates the season-end World Team Cup (P8c) — a Davis-Cup-style
 * national team event. Selects the top `TEAM_COUNT` countries by their
 * combined top-player ranking, and each country's team is its top
 * `PLAYERS_PER_TEAM` ranked players. Idempotent (one cup per season).
 */
export class GenerateWorldTeamCupUseCase {
  constructor(
    private readonly cups: WorldTeamCupRepository,
    private readonly players: PlayerRepository,
    private readonly singlesRank: RankPositionQuery,
    private readonly idGenerator: IdGeneratorPort,
  ) {}

  async execute(command: GenerateWorldTeamCupCommand): Promise<WorldTeamCup | null> {
    const existing = await this.cups.findBySeason(command.season);
    if (existing) return existing;

    const ranked = await this.singlesRank.sortedRankings();

    // Group players by country and rank each country by its top player's
    // ranking position (index in the sorted list). A country with no
    // ranked players isn't eligible.
    const byCountry = new Map<string, PlayerId[]>();
    for (const r of ranked) {
      const player = await this.players.findById(r.playerId);
      if (!player) continue;
      const list = byCountry.get(player.nationality) ?? [];
      list.push(player.id);
      byCountry.set(player.nationality, list);
    }

    const teams: WorldTeamCupTeam[] = [...byCountry.entries()]
      .filter(([, ids]) => ids.length >= PLAYERS_PER_TEAM)
      .sort((a, b) => {
        const rankOf = (ids: PlayerId[]) => {
          const idx = ids.map((id) => ranked.findIndex((r) => r.playerId === id)).filter((i) => i >= 0);
          return idx.length > 0 ? Math.min(...idx) : Number.MAX_SAFE_INTEGER;
        };
        return rankOf(a[1]) - rankOf(b[1]);
      })
      .slice(0, TEAM_COUNT)
      .map(([country, ids]) => ({
        country,
        players: [ids[0], ids[1]] as [PlayerId, PlayerId],
      }));

    if (teams.length < TEAM_COUNT) return null;

    const cup = WorldTeamCup.open({
      id: TournamentId(this.idGenerator.generate()),
      season: command.season,
      weekScheduled: command.weekScheduled,
      surface: command.surface,
      teams,
    });
    await this.cups.save(cup);
    return cup;
  }
}
