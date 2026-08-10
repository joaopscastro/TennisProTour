import { AgeBand, GameWeek, juniorEligibilityForAge, ManagerId, PlayerId, PlayerLifecycleStage, RankingBand, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { RankPositionQuery } from '@tennis-manager/application';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzlePeakRankingRepository } from './DrizzlePeakRankingRepository';
import { DrizzleTitleRepository } from './DrizzleTitleRepository';
import { DrizzlePlayerTournamentHistoryQuery, PlayerTournamentHistoryEntry } from './DrizzlePlayerTournamentHistoryQuery';

export interface PlayerProfileDto {
  playerId: PlayerId;
  /** "Avatar reference" — enough identity for the frontend to derive
   * its existing avatar treatment (flag + initials/color, see
   * lib/format.ts's flagFor/avatarColorFor) exactly like every other
   * screen already does; there is no separate avatar-image subsystem
   * in this game, and this profile endpoint isn't the place to invent
   * one. */
  name: string;
  nationality: string;
  /** Needed by the Schedule section's inline "Enter tournament"/set-
   * training-focus actions, which must authenticate as this player's
   * ACTUAL owning manager (see EnterTournamentModal/setTrainingFocus's
   * own doc comments) — never left to the dev-mode default the way an
   * unauthenticated read gets away with. null for a free agent (no
   * manager, e.g. a fillOnly player) — the Schedule section has
   * nothing to offer there anyway, since only a manager can register
   * entries or set a training focus. */
  managerId: ManagerId | null;
  ageInWeeks: number;
  stage: PlayerLifecycleStage;
  /** Which ONE band this player's CURRENT age makes "live" for them —
   * same derivation `DrizzleRosterDashboardQuery` already uses for its
   * Rank column (`juniorEligibilityForAge`). The frontend uses this to
   * decide which junior band(s) to surface in "current standing"
   * alongside senior (always shown) — never re-derives the age-band
   * boundary rule itself. */
  currentEligibleBand: RankingBand;
  currentRankings: Array<{ band: RankingBand; totalPoints: number; rank: number | null }>;
  peakRankings: Array<{ band: RankingBand; peakPoints: number; peakAsOfWeek: GameWeek }>;
  tournamentHistory: PlayerTournamentHistoryEntry[];
  titles: Array<{ tournamentId: TournamentId; name: string; tier: TournamentTier; ageBand: AgeBand | null; weekEarned: GameWeek }>;
}

/**
 * The single composed read the player profile page needs — avatar
 * identity, current (rolling) rankings, permanent peak rankings, full
 * tournament history, and the trophy list, all in ONE call rather than
 * the frontend making five separate round trips. Every piece reuses an
 * existing, already-tested source (RankPositionQuery, the two new
 * Drizzle repositories from docs/data-archival-principles.md, and
 * DrizzlePlayerTournamentHistoryQuery) — this class only assembles
 * them, it has no read logic of its own.
 */
export class DrizzlePlayerProfileQuery {
  constructor(
    private readonly players: DrizzlePlayerRepository,
    private readonly rankPositionByBand: Record<RankingBand, RankPositionQuery>,
    private readonly peakRankings: DrizzlePeakRankingRepository,
    private readonly titles: DrizzleTitleRepository,
    private readonly history: DrizzlePlayerTournamentHistoryQuery,
  ) {}

  async forPlayer(playerId: PlayerId): Promise<PlayerProfileDto | null> {
    const player = await this.players.findById(playerId);
    if (!player) return null;

    const [seniorRank, u14Rank, u16Rank, peaks, tournamentHistory, titleRecords] = await Promise.all([
      this.rankPositionByBand.senior.rankFor(playerId),
      this.rankPositionByBand.u14.rankFor(playerId),
      this.rankPositionByBand.u16.rankFor(playerId),
      this.peakRankings.findAllForPlayer(playerId),
      this.history.forPlayer(playerId),
      this.titles.findByPlayer(playerId),
    ]);

    // Titles never copy the tournament's own display name (see
    // TitleRecord's doc comment) — this player's own tournament
    // history was just fetched above and, by construction, already
    // contains every tournament they ever won, so it's reused here as
    // the join rather than firing a second lookup against `tournaments`.
    const historyByTournament = new Map(tournamentHistory.map((h) => [h.tournamentId, h]));
    const titleList = titleRecords.map((title) => ({
      tournamentId: title.tournamentId,
      name: historyByTournament.get(title.tournamentId)?.name ?? title.tournamentId,
      tier: title.tier,
      ageBand: title.ageBand,
      weekEarned: title.weekEarned,
    }));

    return {
      playerId: player.id,
      name: player.name,
      nationality: player.nationality,
      managerId: player.managerId,
      ageInWeeks: player.ageInWeeks,
      stage: player.stage,
      currentEligibleBand: juniorEligibilityForAge(player.ageInWeeks),
      currentRankings: [
        { band: 'senior', totalPoints: seniorRank.totalPoints, rank: seniorRank.rank },
        { band: 'u14', totalPoints: u14Rank.totalPoints, rank: u14Rank.rank },
        { band: 'u16', totalPoints: u16Rank.totalPoints, rank: u16Rank.rank },
      ],
      peakRankings: peaks.map((p) => ({ band: p.band, peakPoints: p.peakPoints, peakAsOfWeek: p.peakAsOfWeek })),
      tournamentHistory,
      titles: titleList,
    };
  }
}
