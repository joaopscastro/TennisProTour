import { PlayerId, TournamentId, isAgeEligibleForTournamentBand, isJuniorTier } from '@tennis-manager/domain';
import { ManagerId } from '@tennis-manager/domain';
import {
  isInsideSoftCapCutoff,
  seasonSoftCapRefusalReason,
  seniorTierEntryRestrictionReason,
  tierUsesSeniorRank,
} from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository, WeeklyEntryGuardPort } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { countSameBandEntriesForWeek, weeklyEntryCapForTier } from './juniorEntryCap';
import { seasonTierEntryCountFor } from './seasonEntryCap';
import { retryOnConflict } from './retryOnConflict';

export interface RegisterDoublesEntrantCommand {
  tournamentId: TournamentId;
  playerId: PlayerId;
  managerId: ManagerId;
}

/**
 * Registers a single player into a tournament's doubles field (P7b) —
 * the per-player "enter doubles" action. There is NO pair required
 * here: a manager enters one of their own players, and that player is
 * paired up at draw-formation time (FormDoublesDrawUseCase), either
 * with their persistent partner if both entered, a random other entrant,
 * or a free-agent filler. This is the same "load, delegate to the
 * aggregate, persist" shape as RegisterEntrantUseCase.
 *
 * **Junior doubles (P8)**: for a junior-tier tournament the SAME
 * one-directional age-eligibility rule singles already enforces applies
 * here (play up allowed, play down / senior-into-junior not) — so a
 * senior player can't enter a u14 doubles draw, exactly as they can't
 * enter the u14 singles draw.
 *
 * **Weekly entry cap**: the SAME cap as singles, counting singles and
 * doubles together (see countSameBandEntriesForWeek) — a doubles entry
 * is a real weekly tournament commitment, not a free extra. This closes
 * the gap where a senior player at the singles cap-1 could enter
 * unlimited doubles fields the same week (whose rounds run the same
 * days).
 *
 * **Ranking-based tier restrictions**: the SAME rules singles enforces
 * (see TierEntryRestrictionPolicy) apply to doubles — a top-ranked
 * player can't farm a lower tier's doubles draw either, and a doubles
 * entry can never be the loophole around a refused singles entry. That
 * means the futures hard bar AND the challenger per-season soft cap are
 * both re-checked here, against the same live senior rank read (and the
 * same countTierEntriesForSeason count), so a top-50 player who has
 * used their three challenger slots cannot spend a fourth through the
 * doubles field.
 */
export class RegisterDoublesEntrantUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    /** Atomic weekly-cap guard (see WeeklyEntryGuardPort) — optional for
     * test compatibility, always passed by the composition root. */
    private readonly weeklyEntryGuard?: WeeklyEntryGuardPort,
    /** The SENIOR rank query, read for the ranking-based tier restriction
     * (see TierEntryRestrictionPolicy) — the SAME rule RegisterEntrantUseCase
     * enforces, so a doubles entry can't be used to sidestep it. Optional
     * for the same test-compat reason: omitted, the rule is inert, exactly
     * as it is in the pre-existing doubles unit tests. */
    private readonly seniorRankPosition?: RankPositionQuery,
  ) {}

  async execute(command: RegisterDoublesEntrantCommand): Promise<void> {
    // Same bounded optimistic retry as RegisterEntrantUseCase (see
    // retryOnConflict): a lost race against a concurrent writer for the
    // SAME tournament reloads the fresh state and re-applies this
    // single-player delta, instead of silently losing the doubles entry.
    // Every rule re-evaluates against the winner's committed state, and
    // the weekly-cap claim is idempotent for this same tournament.
    return retryOnConflict(async () => {
      const tournament = await this.tournaments.findById(command.tournamentId);
      if (!tournament) {
        throw new Error(`Tournament ${command.tournamentId} not found`);
      }
      const player = await this.players.findById(command.playerId);
      if (!player) {
        throw new Error(`Player ${command.playerId} not found`);
      }
      if (player.managerId !== command.managerId) {
        throw new Error(`Player ${command.playerId} is not on manager ${command.managerId}'s roster`);
      }
      // A retired player is never enterable — retirement is a roster fact
      // (managerId is retained), not a deletion, so a stale UI could still
      // offer one without this guard.
      if (player.isRetired()) {
        throw new Error(`Player ${command.playerId} has retired and cannot enter tournaments`);
      }

      if (isJuniorTier(tournament.tier) && !isAgeEligibleForTournamentBand(player.seasonAgeAnchorWeeks, tournament.ageBand)) {
        throw new Error(
          `Player ${command.playerId} (age ${(player.ageInWeeks / 52).toFixed(1)}) is not age-eligible for the ` +
            `${tournament.ageBand} doubles draw`,
        );
      }

      // Ranking-based tier restrictions (see TierEntryRestrictionPolicy):
      // the SAME hard bar AND per-season soft cap singles enforces, so a
      // doubles entry can never be the loophole around a refused singles
      // entry.
      if (this.seniorRankPosition && tierUsesSeniorRank(tournament.tier)) {
        const { rank } = await this.seniorRankPosition.rankFor(command.playerId);
        const hardReason = seniorTierEntryRestrictionReason(tournament.tier, rank);
        if (hardReason) {
          throw new Error(`Player ${command.playerId} is ${hardReason}`);
        }
        if (isInsideSoftCapCutoff(tournament.tier, rank)) {
          const used = await seasonTierEntryCountFor(this.tournaments, tournament, command.playerId);
          const capReason = seasonSoftCapRefusalReason(tournament.tier, rank, used);
          if (capReason) {
            throw new Error(`Player ${command.playerId} is ${capReason}`);
          }
        }
      }

      // The tournament being registered is EXCLUDED from its own count
      // (see countSameBandEntriesForWeek): this is exactly the case the
      // pre-check used to get wrong — a senior holding a SINGLES entry in
      // this event and now entering its DOUBLES field is still in one
      // tournament, and must not be refused at the cap of 1. The atomic
      // guard below already excluded it; the pre-check now agrees.
      const entryCount = await countSameBandEntriesForWeek(
        this.tournaments,
        command.playerId,
        tournament.weekScheduled,
        tournament.tier,
        tournament.id,
      );
      const cap = weeklyEntryCapForTier(tournament.tier);
      if (entryCount >= cap) {
        const band = isJuniorTier(tournament.tier) ? 'junior' : 'senior';
        throw new Error(
          `Player ${command.playerId} has already entered ${entryCount} ${band} tournaments in ` +
            `season ${tournament.weekScheduled.season} week ${tournament.weekScheduled.week} ` +
            `(cap: ${cap})`,
        );
      }

      // Atomic guard against the check-then-write race above (see
      // WeeklyEntryGuardPort) — shares its claims with the singles path,
      // so a singles registration and a doubles registration racing for
      // the same player can't both slip through. Idempotent for THIS
      // tournament (it excludes the tournament from its own count and
      // inserts onConflictDoNothing), so the retry wrapper can replay it.
      if (this.weeklyEntryGuard) {
        const claimed = await this.weeklyEntryGuard.tryClaimEntry({
          playerId: command.playerId,
          week: tournament.weekScheduled,
          isJunior: isJuniorTier(tournament.tier),
          tournamentId: tournament.id,
          cap,
        });
        if (!claimed) {
          const band = isJuniorTier(tournament.tier) ? 'junior' : 'senior';
          throw new Error(
            `Player ${command.playerId} has reached the weekly limit of ${cap} ${band} tournament(s) in ` +
              `season ${tournament.weekScheduled.season} week ${tournament.weekScheduled.week} ` +
              `(a concurrent entry was registered first)`,
          );
        }
      }

      // The aggregate enforces "holds a doubles draw", "not started", and
      // "not already entered".
      tournament.registerDoublesEntrant(command.playerId);

      await this.tournaments.save(tournament);
    });
  }
}
