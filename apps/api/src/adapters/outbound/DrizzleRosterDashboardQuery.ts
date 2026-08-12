import { and, desc, eq, isNotNull, or } from 'drizzle-orm';
import {
  AgingPolicy,
  juniorEligibilityForAge,
  ManagerId,
  PlayerId,
  PlayerLifecycleStage,
  RankingBand,
  resolveTrainingFocusForWeek,
  TrainingFocus,
  WorldId,
  weeksUntilNextStage,
} from '@tennis-manager/domain';
import { RankPositionQuery } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { tournamentMatches } from '../../db/schema';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzleTrainingScheduleRepository } from './DrizzleTrainingScheduleRepository';
import { DrizzleGameWorldRepository } from './DrizzleGameWorldRepository';

const WEEKS_PER_SEASON = 52;

/** "Prime in ~2 seasons" / "Decline in ~4 seasons" / "Retires in 1
 * season" / "Retired" — the real StandardAgingPolicy thresholds
 * (via weeksUntilNextStage), not duplicated week constants. Always
 * computed against the BASE policy regardless of a player's Manager
 * Pro status: AcceleratedDeclinePolicy only steepens the weekly decay
 * rate, stage-transition timing itself is untouched (see its doc
 * comment) — a Pro player's stage-transition estimate is identical to
 * a free player's at the same age. */
function formatStageNote(stage: PlayerLifecycleStage, ageInWeeks: number, policy: AgingPolicy): string {
  const weeksRemaining = weeksUntilNextStage(ageInWeeks, stage, policy);
  if (weeksRemaining === null) return 'Retired';
  const seasons = Math.max(1, Math.ceil(weeksRemaining / WEEKS_PER_SEASON));
  if (stage === 'youth') return `Prime in ~${seasons} season${seasons === 1 ? '' : 's'}`;
  if (stage === 'prime') return `Decline in ~${seasons} season${seasons === 1 ? '' : 's'}`;
  return seasons <= 1 ? 'Retires in 1 season' : `Retires in ~${seasons} seasons`;
}

export interface RosterDashboardEntry {
  id: PlayerId;
  name: string;
  nationality: string;
  ageInWeeks: number;
  stage: PlayerLifecycleStage;
  /** "Prime in ~2 seasons" / "Decline in ~4 seasons" / "Retires in 1
   * season" / "Retired" — how far this player is from their next
   * lifecycle-stage transition, the signal that drives "I need to
   * scout a replacement soon." */
  stageNote: string;
  fatigue: number;
  /** Match rhythm counter (0–100). See Player.form's doc comment. Both
   * under- and over-playing sit outside the sweet-spot band and hurt in
   * the sim; the roster surfaces it so a manager can schedule a rhythm. */
  form: number;
  /** 0-100, rounded — PlayerAttributes.overallRating() averaged over
   * the nine underlying skills, same number the roster mockup showed
   * as "OVR." */
  overall: number;
  /** 1-indexed position among every player who has ever earned a
   * ranking-ledger entry IN THIS PLAYER'S rankBand, sorted by their
   * currently-computed rolling total descending. null = unranked
   * (never earned a point in that band), not rank 0 — see
   * RankPositionQuery/RankingCalculationService. */
  rank: number | null;
  /** Which of the player's three independent rankings `rank`/`points`
   * come from — derived purely from the player's CURRENT age via
   * `juniorEligibilityForAge` (not from which tournaments they've
   * actually entered), same rule `AdvanceWorldWeekUseCase` uses to
   * detect a graduation crossing. A player never has more than one
   * live rank shown at a time: once they age out of u14 their
   * dashboard rank switches to u16, then to senior, matching which
   * ladder they're actually still eligible to enter now. */
  rankBand: RankingBand;
  points: number;
  /** Tennis scoreline notation from THIS player's perspective, e.g.
   * "W 7-6, 6-2" or "L 4-6, 6-7". null = no decided match yet. */
  lastResult: string | null;
  trainingFocus: TrainingFocus | null;
  surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
}

/**
 * The read model behind the Roster Dashboard screen — one call
 * returning every field the screen actually shows per row (rank,
 * overall, fatigue, last result, training focus, nationality,
 * surfaces), rather than the frontend stitching together
 * /managers/:id/players + a ranking lookup + a match-history query
 * itself. Reuses DrizzlePlayerRepository/RankPositionQuery
 * for the parts that need real domain reconstruction (a Player
 * aggregate's overallRating(), a ranking's position), but goes
 * straight to the tournament_matches table for "last result" via a
 * plain SQL projection — that one field needs no Tournament aggregate
 * behavior at all (bracket integrity, round progression, ...), just
 * "the most recent row involving this player with a winner," so
 * reconstructing the whole aggregate to read one row would be pure
 * overhead. This is a deliberate read-side/write-side split, not an
 * inconsistency: writes to tournament state still only ever happen
 * through Tournament + DrizzleTournamentRepository.
 *
 * `trainingFocus` is resolved fresh from each player's training
 * schedule (resolveTrainingFocusForWeek, against the world's current
 * week) rather than read off the player row directly — see
 * TrainingSchedule.ts; Player itself no longer stores a focus at all.
 */
export class DrizzleRosterDashboardQuery {
  private readonly players: DrizzlePlayerRepository;
  private readonly trainingSchedule: DrizzleTrainingScheduleRepository;
  private readonly worlds: DrizzleGameWorldRepository;

  constructor(
    private readonly db: Db,
    private readonly agingPolicy: AgingPolicy,
    /** One query per independent ranking a roster row could need — a
     * player's dashboard rank comes from whichever band their CURRENT
     * age is eligible for (see `rankBand` on RosterDashboardEntry), so
     * this reads whichever one applies rather than always reading the
     * senior tour the way this query did before the junior circuit's
     * frontend surface existed. */
    private readonly rankPositionQueries: { senior: RankPositionQuery; u14: RankPositionQuery; u16: RankPositionQuery },
    private readonly worldId: WorldId,
  ) {
    this.players = new DrizzlePlayerRepository(db);
    this.trainingSchedule = new DrizzleTrainingScheduleRepository(db);
    this.worlds = new DrizzleGameWorldRepository(db);
  }

  async forManager(managerId: ManagerId): Promise<RosterDashboardEntry[]> {
    const roster = await this.players.findByManager(managerId);
    if (roster.length === 0) return [];

    // One sorted-rankings read per band for the whole roster, not one
    // per player — a manager has at most 4 players (roster cap), so
    // this stays cheap (3 queries total, not 3 * roster size) even as
    // the league-wide rankings tables grow.
    const [seniorRanked, u14Ranked, u16Ranked, world] = await Promise.all([
      this.rankPositionQueries.senior.sortedRankings(),
      this.rankPositionQueries.u14.sortedRankings(),
      this.rankPositionQueries.u16.sortedRankings(),
      this.worlds.findById(this.worldId),
    ]);
    if (!world) throw new Error(`Game world ${this.worldId} not found`);
    const byBand: Record<RankingBand, { rank: Map<PlayerId, number>; points: Map<PlayerId, number> }> = {
      senior: {
        rank: new Map(seniorRanked.map((r, i) => [r.playerId, i + 1])),
        points: new Map(seniorRanked.map((r) => [r.playerId, r.totalPoints])),
      },
      u14: {
        rank: new Map(u14Ranked.map((r, i) => [r.playerId, i + 1])),
        points: new Map(u14Ranked.map((r) => [r.playerId, r.totalPoints])),
      },
      u16: {
        rank: new Map(u16Ranked.map((r, i) => [r.playerId, i + 1])),
        points: new Map(u16Ranked.map((r) => [r.playerId, r.totalPoints])),
      },
    };

    return Promise.all(
      roster.map(async (player) => {
        const rankBand = juniorEligibilityForAge(player.ageInWeeks);
        return {
          id: player.id,
          name: player.name,
          nationality: player.nationality,
          ageInWeeks: player.ageInWeeks,
          stage: player.stage,
          stageNote: formatStageNote(player.stage, player.ageInWeeks, this.agingPolicy),
          fatigue: player.fatigue,
          form: player.form,
          overall: Math.round(player.attributes.overallRating()),
          rank: byBand[rankBand].rank.get(player.id) ?? null,
          rankBand,
          points: byBand[rankBand].points.get(player.id) ?? 0,
          trainingFocus: resolveTrainingFocusForWeek(await this.trainingSchedule.findByPlayer(player.id), world.currentWeek),
          surfaceAffinities: {
            clay: player.attributes.surfaceAffinities.get('clay'),
            grass: player.attributes.surfaceAffinities.get('grass'),
            hard: player.attributes.surfaceAffinities.get('hard'),
            indoor: player.attributes.surfaceAffinities.get('indoor'),
          },
          lastResult: await this.lastResultFor(player.id),
        };
      }),
    );
  }

  private async lastResultFor(playerId: PlayerId): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(tournamentMatches)
      .where(
        and(
          or(eq(tournamentMatches.entrantA, playerId), eq(tournamentMatches.entrantB, playerId)),
          isNotNull(tournamentMatches.winnerId),
        ),
      )
      .orderBy(desc(tournamentMatches.updatedAt))
      .limit(1);
    if (rows.length === 0) return null;

    const row = rows[0];
    const won = row.winnerId === playerId;
    const setScores = row.setScores ?? [];
    // setScores is stored {winnerGames, loserGames} per set, from the
    // MATCH WINNER's perspective — flip each pair when this player
    // lost, so the scoreline always leads with this player's own
    // games (the real tennis-notation convention: "L 4-6, 6-7" reads
    // as this player's games first).
    const sets = setScores
      .map((s) => (won ? `${s.winnerGames}-${s.loserGames}` : `${s.loserGames}-${s.winnerGames}`))
      .join(', ');
    return `${won ? 'W' : 'L'} ${sets}`;
  }
}
