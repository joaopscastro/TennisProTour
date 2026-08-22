import { AgeBand, GameWeek, juniorEligibilityForAge, ManagerId, PlayerId, PlayerLifecycleStage, PotentialProjection, projectPotential, RankingBand, TournamentId, TournamentTier, DoublesPairStatus } from '@tennis-manager/domain';
import { RankPositionQuery } from '@tennis-manager/application';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzlePeakRankingRepository } from './DrizzlePeakRankingRepository';
import { DrizzleTitleRepository } from './DrizzleTitleRepository';
import { DrizzlePlayerTournamentHistoryQuery, PlayerTournamentHistoryEntry } from './DrizzlePlayerTournamentHistoryQuery';
import { DrizzleDoublesPairRepository } from './DrizzleDoublesPairRepository';
import { DrizzleDoublesTitleRepository } from './DrizzleDoublesTitleRepository';
import { DrizzleDoublesPeakRankingRepository } from './DrizzleDoublesPeakRankingRepository';

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
  /** Cumulative on-site prize money earned across this player's whole
   * career — see Player.careerPrizeMoney. */
  careerPrizeMoney: number;
  /** Prize money earned so far in the current season only — see
   * Player.seasonPrizeMoney. */
  seasonPrizeMoney: number;
  currentRankings: Array<{ band: RankingBand; totalPoints: number; rank: number | null }>;
  peakRankings: Array<{ band: RankingBand; peakPoints: number; peakAsOfWeek: GameWeek }>;
  tournamentHistory: PlayerTournamentHistoryEntry[];
  titles: Array<{ tournamentId: TournamentId; name: string; tier: TournamentTier; ageBand: AgeBand | null; weekEarned: GameWeek }>;
  /** The profile-only "scout's projection" of this player's upside (P5,
   * docs/rocking-rackets-competitive-analysis.md §3). This is a DERIVED,
   * age-fuzzed read computed server-side from the HIDDEN
   * potentialCeiling/physicalCeilings/talent via projectPotential — the
   * raw hidden numbers are NEVER placed on this DTO (grep them in this
   * file: they only ever appear as arguments into projectPotential,
   * never in the returned object). It appears ONLY here on the profile,
   * never on any list/pool query, so potential stays a per-player
   * investigation, not a sortable column. */
  potential: PotentialProjection;
  /** The player's doubles partner (P7a,
   * docs/doubles-and-special-formats-plan.md) — the OTHER member of the
   * player's non-dissolved pair, with its status, or null when the
   * player isn't in a pair at all. Always derived from a live
   * `doubles_pairs` read, never stored on the player row. An ACTIVE pair
   * is what the profile hero highlights; a PENDING invite shows as
   * pending (the manager-facing affordances are on the board, not here
   * — this is the read everyone sees). */
  doublesPartner: {
    pairId: string;
    status: DoublesPairStatus;
    playerId: PlayerId;
    name: string;
    nationality: string;
    chemistry: number;
  } | null;
  /** The player's permanent high-water-mark DOUBLES ranking totals (P7c +
   * junior doubles) — one per band they've ever earned a doubles point
   * in, same shape as `peakRankings`. */
  doublesPeaks: Array<{ band: RankingBand; peakPoints: number; peakAsOfWeek: GameWeek }>;
  /** The player's doubles titles (P7c) — each shows the PARTNER (the
   * other member of the winning pair), which is the interesting half of
   * a doubles trophy; the tournament is referenced by id + tier only
   * (its generated name is not joined here — doubles titles aren't part
   * of the singles tournament history). */
  doublesTitles: Array<{
    tournamentId: TournamentId;
    tier: TournamentTier;
    partnerId: PlayerId;
    partnerName: string;
    partnerNationality: string;
    weekEarned: GameWeek;
  }>;
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
    private readonly pairs: DrizzleDoublesPairRepository,
    private readonly doublesTitles: DrizzleDoublesTitleRepository,
    private readonly doublesPeakRankings: DrizzleDoublesPeakRankingRepository,
  ) {}

  async forPlayer(playerId: PlayerId): Promise<PlayerProfileDto | null> {
    const player = await this.players.findById(playerId);
    if (!player) return null;

    const [
      seniorRank,
      u14Rank,
      u16Rank,
      u18Rank,
      peaks,
      tournamentHistory,
      titleRecords,
      pairs,
      doublesTitleRecords,
      doublesPeakSenior,
      doublesPeakU14,
      doublesPeakU16,
      doublesPeakU18,
    ] = await Promise.all([
      this.rankPositionByBand.senior.rankFor(playerId),
      this.rankPositionByBand.u14.rankFor(playerId),
      this.rankPositionByBand.u16.rankFor(playerId),
      this.rankPositionByBand.u18.rankFor(playerId),
      this.peakRankings.findAllForPlayer(playerId),
      this.history.forPlayer(playerId),
      this.titles.findByPlayer(playerId),
      this.pairs.findByPlayer(playerId),
      this.doublesTitles.findByPlayer(playerId),
      this.doublesPeakRankings.findOne(playerId, 'senior'),
      this.doublesPeakRankings.findOne(playerId, 'u14'),
      this.doublesPeakRankings.findOne(playerId, 'u16'),
      this.doublesPeakRankings.findOne(playerId, 'u18'),
    ]);

    // The player's non-dissolved pair (at most one by the use-case
    // invariant), and the partner's identity — the profile-highlight
    // read the P7a plan calls for.
    const pair = pairs.find((p) => !p.isDissolved);
    let doublesPartner: PlayerProfileDto['doublesPartner'] = null;
    if (pair) {
      const partnerId = pair.partnerOf(playerId)!;
      const partner = await this.players.findById(partnerId);
      doublesPartner = {
        pairId: pair.id,
        status: pair.status,
        playerId: partnerId,
        name: partner?.name ?? partnerId,
        nationality: partner?.nationality ?? 'XX',
        chemistry: pair.chemistry,
      };
    }

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

    // Doubles titles (P7c): the interesting half of a doubles trophy is
    // the PARTNER, so each entry resolves the other member of the pair.
    const doublesTitleList = await Promise.all(
      doublesTitleRecords.map(async (title) => {
        const partnerId = title.playerA === playerId ? title.playerB : title.playerA;
        const partner = await this.players.findById(partnerId);
        return {
          tournamentId: title.tournamentId,
          tier: title.tier,
          partnerId,
          partnerName: partner?.name ?? partnerId,
          partnerNationality: partner?.nationality ?? 'XX',
          weekEarned: title.weekEarned,
        };
      }),
    );

    return {
      playerId: player.id,
      name: player.name,
      nationality: player.nationality,
      managerId: player.managerId,
      ageInWeeks: player.ageInWeeks,
      stage: player.stage,
      currentEligibleBand: juniorEligibilityForAge(player.seasonAgeAnchorWeeks),
      careerPrizeMoney: player.careerPrizeMoney,
      seasonPrizeMoney: player.seasonPrizeMoney,
      currentRankings: [
        { band: 'senior', totalPoints: seniorRank.totalPoints, rank: seniorRank.rank },
        { band: 'u14', totalPoints: u14Rank.totalPoints, rank: u14Rank.rank },
        { band: 'u16', totalPoints: u16Rank.totalPoints, rank: u16Rank.rank },
        { band: 'u18', totalPoints: u18Rank.totalPoints, rank: u18Rank.rank },
      ],
      peakRankings: peaks.map((p) => ({ band: p.band, peakPoints: p.peakPoints, peakAsOfWeek: p.peakAsOfWeek })),
      tournamentHistory,
      titles: titleList,
      potential: projectPotential({
        playerId: player.id,
        ageInWeeks: player.ageInWeeks,
        attributes: player.attributes,
        potentialCeiling: player.potentialCeiling,
        physicalCeilings: player.physicalCeilings,
        talent: player.talent,
      }),
      doublesPartner,
      doublesPeaks: [doublesPeakSenior, doublesPeakU14, doublesPeakU16, doublesPeakU18]
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ band: p.band, peakPoints: p.peakPoints, peakAsOfWeek: p.peakAsOfWeek })),
      doublesTitles: doublesTitleList,
    };
  }
}
