import { isAgeEligibleForTournamentBand, isJuniorTier, PlayerId, TournamentId } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { DrawPhase, entryTypeOf, EntryType, resolveEntryType, Tournament } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { countSameBandEntriesForWeek, weeklyEntryCapForTier } from './juniorEntryCap';
import { FormDoublesDrawUseCase } from './FormDoublesDrawUseCase';
import { applyWildCards } from './applyWildCards';

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
 *
 * **Qualifying (`[Q]`)**: at a tier that holds qualifying (see
 * QualifyingPolicy — `major`/`tour` today) a registrant inside
 * `DIRECT_ACCEPTANCE_CUTOFF` takes their guaranteed direct-acceptance
 * place, while anyone below the cutoff (or unranked) can only enter
 * through one of the event's reserved `[Q]` slots, and is refused once
 * those run out. This is the LIGHT model from
 * docs/ranking-realism-proposal.md §5: no qualifying draw is simulated,
 * the qualifier is assumed to have come through and earns ordinary
 * main-draw points. It is the deliberate mirror of the obligatory rule
 * — the same cutoff that OBLIGATES the top to show up is what makes
 * everyone else earn their place — and it is inert at every tier below
 * `tour`, which must stay freely enterable since that's the route up.
 *
 * **Wild cards (`'WC'`)**: NOT a manager action at all — see
 * WildCardPolicy/applyWildCards. The moment this registration closes
 * the qualifying (or main, at a tier with none) field — i.e. exactly
 * where the auto-start below used to go straight to bracket generation
 * — `applyWildCards` runs FIRST and automatically promotes up to the
 * tier's wild card slot count of registered qualifying entrants who
 * share the tournament's host country into the main draw, best-ranked
 * first. A manager who registers a below-cutoff local player has no
 * idea in advance whether they'll be promoted; it's discovered on the
 * draw sheet like everything else here.
 */
export class RegisterEntrantUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly bracketGenerator: BracketGenerator,
    /** The SENIOR rank query — only senior tiers hold qualifying, so
     * there's no per-band record to pass. Optional: omitted (as in the
     * many pre-qualifying unit tests) every entrant is a plain direct
     * acceptance and the `[Q]`/wild-card rules are simply inert, exactly
     * as they are at a tier that holds no qualifying at all. The
     * composition root always passes it. */
    private readonly seniorRankPosition?: RankPositionQuery,
    /** Doubles draw formation (P7b) — optional for the same test-compat
     * reason: omitted, the full-draw auto-start below seeds the singles
     * bracket but leaves the doubles draw to the weekly
     * StartDueTournamentsUseCase. The composition root always passes it. */
    private readonly formDoublesDraw?: FormDoublesDrawUseCase,
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

    const entryType = await this.resolveEntryTypeFor(tournament, command.playerId);
    // A `[Q]` registrant enters the QUALIFYING field, not the main draw
    // — the whole point of the full model: they must win their way in.
    const draw: DrawPhase | undefined = entryType === 'Q' ? 'qualifying' : undefined;
    tournament.registerEntrant({ playerId: command.playerId, seed: command.seed ?? null, entryType, draw });

    if (isFullyRegistered(tournament)) {
      // The automatic wild card algorithm runs FIRST — before either
      // bracket is seeded — pulling any eligible local qualifying
      // entrants into the main draw (see this class's doc comment and
      // applyWildCards). Must happen before startQualifyingWithBracket:
      // a wild card bypasses qualifying entirely, it can't be granted
      // once that bracket already exists.
      await applyWildCards(tournament, this.players, this.seniorRankPosition);

      // With qualifying, "the draw is full" starts the QUALIFYING
      // bracket, days before the main draw exists (deferred main-draw
      // seeding — the main draw is seeded by PromoteQualifiersUseCase
      // once qualifying has produced its winners). Without qualifying
      // this is exactly the pre-existing behaviour.
      if (tournament.hasQualifying) {
        const bracket = this.bracketGenerator.generate(tournament.qualifyingEntrants, tournament.qualifyingDrawSize);
        tournament.startQualifyingWithBracket(bracket);
      } else {
        const bracket = this.bracketGenerator.generate(tournament.mainEntrants, tournament.drawSize);
        tournament.startWithBracket(bracket);
      }
    }

    // Form the doubles draw too (P7b), if wired — the singles auto-start
    // closes registration, so whatever doubles entrants signed up during
    // the open window are paired and seeded here rather than waiting for
    // the weekly trigger.
    if (this.formDoublesDraw) {
      await this.formDoublesDraw.form(tournament);
    }

    await this.tournaments.save(tournament);
  }

  /** Direct acceptance vs. `[Q]` for this registrant — see the class doc
   * comment. Reads the player's live senior rank only when the tier
   * actually holds qualifying, so an ordinary futures/junior entry
   * costs no extra ranking read. Returns `undefined` when the rule is
   * inert (a tier without qualifying, or no rank query injected),
   * leaving the entrant's `entryType` absent exactly as before this
   * feature existed rather than stamping a redundant 'DA' on every
   * entrant in the game. */
  private async resolveEntryTypeFor(
    tournament: Tournament,
    playerId: PlayerId,
  ): Promise<EntryType | undefined> {
    if (!this.seniorRankPosition) return undefined;
    // Asks the TOURNAMENT, not the policy: whether this event holds
    // qualifying (and how big it is) was decided and stored when it
    // opened, so a later balance change to QualifyingPolicy can never
    // retroactively add or remove qualifying from an event already
    // taking registrations.
    if (!tournament.hasQualifying) return undefined;

    const { rank } = await this.seniorRankPosition.rankFor(playerId);
    const qualifierSlotsTaken = tournament.entrants.filter((entrant) => entryTypeOf(entrant) === 'Q').length;
    const decision = resolveEntryType({
      tier: tournament.tier,
      drawSize: tournament.drawSize,
      rank,
      qualifierSlotsTaken,
      qualifierSlots: tournament.qualifierSlots,
      qualifyingCapacity: tournament.qualifyingDrawSize,
    });
    if (decision.kind === 'qualifying-full') {
      throw new Error(
        `Player ${playerId} is outside direct acceptance for tournament ${tournament.id} and its ` +
          `${tournament.qualifyingDrawSize}-player qualifying field is already full ` +
          `(${decision.qualifierSlots} main-draw place(s) at stake)`,
      );
    }
    return decision.entryType;
  }
}

/** Both fields are full: every directly-accepted place taken AND, at a
 * tournament that holds one, every place in the qualifying field. Until
 * both are, the event stays open — a full qualifying field must not
 * close registration on direct acceptances, or vice versa. */
function isFullyRegistered(tournament: Tournament): boolean {
  if (tournament.mainEntrants.length < tournament.mainDrawCapacity) return false;
  if (!tournament.hasQualifying) return true;
  return tournament.qualifyingEntrants.length >= tournament.qualifyingDrawSize;
}
