import { BracketGenerator, WorldId } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';
import { fillDrawSlots } from './fillDrawSlots';
import { TickProfiler } from '../profiling/tickProfile';

export interface PromoteQualifiersCommand {
  worldId: WorldId;
}

export interface PromoteQualifiersResult {
  /** Tournaments whose main draw was seeded by this run. */
  mainDrawsSeeded: number;
  /** Qualifiers actually promoted into a main draw across those
   * tournaments. */
  promoted: number;
}

/**
 * The bridge between a tournament's two brackets: once its QUALIFYING
 * draw has been played out, the survivors take the main-draw places
 * that were reserved for them, and the main bracket is seeded.
 *
 * This is the piece that makes qualifying real rather than assumed (the
 * FULL model — docs/ranking-realism-proposal.md §5). Under the previous
 * light model a below-cutoff registrant was simply *labelled* `[Q]` and
 * handed a main-draw place; now they enter a genuinely simulated
 * qualifying field, play it out over the tournament's opening days, and
 * only reach the main draw by winning. Lower-ranked players can earn
 * their way into a big event, which is what deepens the ladder.
 *
 * **Deferred main-draw seeding.** The main bracket deliberately does not
 * exist while qualifying is being played: seeding it up front would
 * require match slots with a missing player ("vs. Qualifier"), and
 * `Tournament`'s invariant that a scheduled match always has two real
 * entrants is relied on by the simulator and every caller of
 * `getScheduledMatch`. Waiting costs nothing but a friendly "the draw
 * hasn't been made yet" panel, which the tournament page already has.
 *
 * **Run once per DAY tick**, right after `SimulateDueMatchesUseCase`
 * (apps/worker/src/jobs/handlers.ts) — the day qualifying's last round
 * is decided is the day the main draw should be made, and the main
 * draw's own first round is scheduled for a later day anyway
 * (`Tournament.roundScheduledDay` shifts it past the qualifying days),
 * so nothing is ever played before it exists. A separate use case
 * rather than a branch inside the match sweep, for the same reason
 * `ApplyObligatoryTournamentZerosUseCase` is separate: it is a distinct
 * state transition of the Competition aggregate, not a per-match step.
 *
 * **Idempotent**: promotion is only ever attempted for a tournament
 * whose qualifying is complete and whose main draw does NOT exist yet
 * (`hasMainDraw`), and it ends by seeding that main draw — so a second
 * run in the same tick, or after a crash, simply finds nothing to do.
 * `Tournament.promoteQualifier` independently refuses to run once the
 * main draw is seeded, so the idempotency does not rest on this
 * class's own filter alone.
 */
export class PromoteQualifiersUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly bracketGenerator: BracketGenerator,
    /** Optional and LAST for test compatibility: without it the sparse-
     * main-draw rescue (below) is inert and the pre-existing "record the
     * promotions, leave the main draw unseeded" behaviour is unchanged.
     * The composition root always passes it, so live a qualifying event
     * can never dead-end. */
    private readonly players?: PlayerRepository,
  ) {}

  // worldId is accepted for symmetry with the other tick use cases (and
  // for the day multi-world tooling arrives); tournaments are not
  // world-scoped in the schema today, exactly as in
  // SimulateDueMatchesUseCase.
  async execute(_command: PromoteQualifiersCommand): Promise<PromoteQualifiersResult> {
    const result: PromoteQualifiersResult = { mainDrawsSeeded: 0, promoted: 0 };
    // WORLD_TICK_PROFILE=1 phase timing (no-op otherwise) — see TickProfiler.
    const profiler = new TickProfiler('promoteQualifiers');

    // The bounded live set (see TournamentRepository.findStartedLive):
    // a qualifying-complete / main-draw-unseeded tournament is included
    // by its "awaiting promotion" clause, while every finished event
    // drops out — so this daily use case stops reconstituting the whole
    // tournament history.
    const liveTournaments = this.tournaments.findStartedLive?.() ?? this.tournaments.findStarted();
    const tournamentsToScan = await liveTournaments;
    profiler.mark('liveSet', { liveTournaments: tournamentsToScan.length });
    for (const tournament of tournamentsToScan) {
      if (!tournament.hasQualifying) continue;
      if (tournament.hasMainDraw) continue;
      if (!tournament.isQualifyingComplete()) continue;

      // A tournament whose main draw came out too sparse to seed (see the
      // "sparse field" branch below) is deliberately left with its
      // winners already promoted and `hasMainDraw` still false — the
      // guard above (`!tournament.hasMainDraw`) therefore can't tell
      // "not yet promoted" apart from "promoted, but seeding failed" and
      // reprocesses this tournament every subsequent day tick. Without
      // this filter, re-promoting an already-promoted winner hits
      // Tournament.promoteQualifier's own "already in the main draw"
      // guard and throws, crashing the WHOLE advance-world-day job
      // (every other system riding the same tick — aging, talent-pool
      // refresh, ranking — never runs either) forever, once any
      // tournament ever landed in this state. Found live during a
      // fast-tick 5-season playtest: one such tournament blocked every
      // single day tick from that point on, world-wide.
      const alreadyPromoted = new Set(tournament.mainEntrants.map((e) => e.playerId));
      const winners = tournament.qualifyingWinners().filter((playerId) => !alreadyPromoted.has(playerId));
      for (const playerId of winners) {
        tournament.promoteQualifier(playerId);
        result.promoted += 1;
      }

      let bracket = this.bracketGenerator.generate(tournament.mainEntrants, tournament.drawSize);
      // Top the main draw up from the eligible fill-only pool, then
      // re-generate, whenever it is short of a full draw. Two reasons it
      // can be short, and both are fixed here rather than left to drift:
      //
      //  (1) A draw thin enough that every entrant would get a bye can't
      //      be started at all (see Tournament.startWithBracket). Unlike
      //      an open tournament — where StartDueTournamentsUseCase just
      //      leaves it open and retries a later tick with more fillers —
      //      the promotions are already recorded by this point and can't
      //      be thrown away. Without padding, a qualifying event can
      //      permanently dead-end in the "promoted, but never seedable"
      //      state (confirmed live in a 3-season soak: 3 tournaments stuck
      //      started-but-main-draw-less forever).
      //
      //  (2) A tournament that auto-started on full registration (see
      //      RegisterEntrantUseCase.isFullyRegistered) never passes
      //      through StartDueTournamentsUseCase's own fill, so any
      //      wild-card places the algorithm did NOT award would otherwise
      //      stay empty and the draw would start `wildCardSlots` short —
      //      the same structural shortfall the un-awarded-wildcard fill
      //      closes there. At this point the qualifiers are promoted, so
      //      the only correct target is a FULL draw (`drawSize`).
      if (tournament.mainEntrants.length < tournament.drawSize && this.players) {
        const needed = tournament.drawSize - tournament.mainEntrants.length;
        await fillDrawSlots({ players: this.players, tournaments: this.tournaments }, tournament, needed, 'main', (entrant) =>
          tournament.addMainDrawFiller(entrant.playerId),
        );
        bracket = this.bracketGenerator.generate(tournament.mainEntrants, tournament.drawSize);
      }
      if (bracket[0].matches.length === 0) {
        // Still too sparse even after padding (the eligible pool ran
        // out): save the promotions and leave the main draw unseeded —
        // honest about what actually happened, and a later tick retries
        // the padding as more fillers exist.
        await this.tournaments.save(tournament);
        continue;
      }

      tournament.startWithBracket(bracket);
      await this.tournaments.save(tournament);
      result.mainDrawsSeeded += 1;
    }

    return result;
  }
}
