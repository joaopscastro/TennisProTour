import { isAgeEligibleForTournamentBand, isJuniorTier, PlayerId, TournamentId } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';
import { countSameBandEntriesForWeek, weeklyEntryCapForTier } from './juniorEntryCap';

export interface RegisterEntrantCommand {
  tournamentId: TournamentId;
  playerId: PlayerId;
  /** Unseeded by default — direct roster-row "Enter" actions don't
   * carry a seed the way an admin-configured draw might. */
  seed?: number | null;
}

/**
 * Registers a single player into an already-open (not-yet-started)
 * tournament — created via OpenRegistrationUseCase, not
 * OpenTournamentUseCase, which opens a tournament AND registers a
 * fixed entrant list AND starts the bracket in one call (the right
 * shape for admin-seeded draws, but it can't express "a manager
 * clicks Enter on one player, for a tournament other managers are
 * also still registering for"). Tournament.registerEntrant() already
 * enforces every invariant that matters here (draw not full, not
 * already registered, not started).
 *
 * There's still no registration-window/deadline concept (CLAUDE.md:
 * "nothing drives one asynchronously yet"), so the simplest honest
 * rule stands in for one: the draw closes and the bracket starts the
 * moment the last slot fills, right here — not on a scheduled job,
 * since nothing else currently transitions a tournament out of "open
 * for registration."
 *
 * **Age eligibility**: a player may not register for a tournament with
 * a real junior `ageBand` (`u14`/`u16`) unless their CURRENT age is
 * eligible for it — see `isAgeEligibleForTournamentBand`'s doc comment
 * for the exact one-directional rule (playing UP into an older junior
 * band is allowed, playing down or a senior entering either junior
 * band is not). This closes a previously-disclosed gap ("nothing
 * enforces a registering player's actual age against a tournament's
 * ageBand"). Deliberately scoped to junior tournaments only — a junior
 * player entering the senior tour is a normal, unrestricted case in
 * real tennis (and in this game), not a second gap to close here.
 *
 * **Weekly entry cap**: a player may not enter more than the tier's
 * weekly cap worth of same-band tournaments in one GameWeek — junior
 * tiers cap at `JUNIOR_WEEKLY_ENTRY_CAP` (the real ITF "up to three
 * tournaments a week" rule), the senior tour at
 * `SENIOR_WEEKLY_ENTRY_CAP` = 1 (a pro plays one tournament per week;
 * see weeklyEntryCapForTier / juniorEntryCap.ts). The two bands are
 * counted independently — a junior-age player on the senior tour (a
 * normal, allowed case) has their senior entries counted only against
 * the senior cap, never the junior one. The senior cap was previously
 * absent; under the day-tick clock, same-week tournaments run their
 * rounds on the same days, so entering two at once is a literal
 * scheduling impossibility, not just unrealistic.
 */
export class RegisterEntrantUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly bracketGenerator: BracketGenerator,
  ) {}

  async execute(command: RegisterEntrantCommand): Promise<void> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) {
      throw new Error(`Tournament ${command.tournamentId} not found`);
    }

    if (isJuniorTier(tournament.tier)) {
      // Tournament.validateAgeBand guarantees ageBand is non-null
      // exactly when the tier is a junior tier, so this branch is
      // always where the age check belongs too — no separate `if
      // (tournament.ageBand)` needed.
      const player = await this.players.findById(command.playerId);
      if (!player) {
        throw new Error(`Player ${command.playerId} not found`);
      }
      if (!isAgeEligibleForTournamentBand(player.ageInWeeks, tournament.ageBand)) {
        throw new Error(
          `Player ${command.playerId} (age ${(player.ageInWeeks / 52).toFixed(1)}) is not age-eligible for a ` +
            `${tournament.ageBand} tournament — a player may play up into an older junior band, but not down ` +
            `into a younger one, and a senior player may not enter a junior tournament at all`,
        );
      }
    }

    const entryCount = await countSameBandEntriesForWeek(this.tournaments, command.playerId, tournament.weekScheduled, tournament.tier);
    const cap = weeklyEntryCapForTier(tournament.tier);
    if (entryCount >= cap) {
      const band = isJuniorTier(tournament.tier) ? 'junior' : 'senior';
      throw new Error(
        `Player ${command.playerId} has already entered ${entryCount} ${band} tournaments in ` +
          `season ${tournament.weekScheduled.season} week ${tournament.weekScheduled.week} ` +
          `(cap: ${cap})`,
      );
    }

    tournament.registerEntrant({ playerId: command.playerId, seed: command.seed ?? null });

    if (tournament.entrants.length === tournament.drawSize) {
      const bracket = this.bracketGenerator.generate(tournament.entrants, tournament.drawSize);
      tournament.startWithBracket(bracket);
    }

    await this.tournaments.save(tournament);
  }
}
