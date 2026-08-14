import { WorldId } from '@tennis-manager/domain';
import { Dependencies } from '@tennis-manager/api';
import { intervalTickKey, isoDayTickKey } from '../tickKey';

/** The season week the Masters Cup (P8b) is generated on — placeholder,
 * alongside the other capstone scheduling constants. */
const MASTERS_CUP_WEEK = 40;
/** The season week the World Team Cup (P8c) is generated on — placeholder. */
const WORLD_TEAM_CUP_WEEK = 42;

/**
 * Thin BullMQ handlers — parse the job, call the use case, log the
 * result. All idempotency guards live below the handlers: the tick
 * key in GameWorld for aging, and the aggregate's decided-match
 * checks for simulation. A crashed/retried job therefore re-runs
 * safely without any BullMQ-level dedup configuration.
 */

export interface AdvanceWorldJobData {
  worldId: string;
  /** Present for manual/test runs; scheduled runs derive it from the
   * real-world ISO week at processing time. */
  tickKey?: string;
}

/**
 * `tickIntervalMs` mirrors whatever WORLD_TICK_INTERVAL_MS index.ts
 * resolved (null = default real-week cadence) — passed in explicitly
 * rather than read from process.env here, so this handler's tick-key
 * choice is a pure function of its arguments and stays unit-testable
 * without env-var side effects.
 */
export function makeAdvanceWorldHandler(deps: Dependencies, tickIntervalMs: number | null) {
  return async (data: AdvanceWorldJobData) => {
    const tickKey = data.tickKey ?? (tickIntervalMs !== null ? intervalTickKey(new Date(), tickIntervalMs) : isoDayTickKey(new Date()));
    const worldId = WorldId(data.worldId);
    const result = await deps.advanceWorldWeek.execute({ worldId, tickKey });

    // Weekly systems fire ONLY on a week rollover (day 7 -> 1). A
    // mid-week day tick still advances the clock (result.advanced) but
    // must not refresh the pool / generate junior tournaments / start
    // due tournaments — those stay weekly (see
    // docs/day-tick-and-scheduling.md and each use case's doc comment).
    if (result.advanced && result.weekRolledOver) {
      // Talent pool refresh piggybacks on the SAME weekly rollover as
      // aging, gated on `weekRolledOver` rather than carrying its own
      // idempotency key. See RefreshTalentPoolUseCase's doc comment.
      await deps.refreshTalentPool.execute({ worldId });
      // Weekly junior-tournament generation, same rollover/gate.
      await deps.generateJuniorTournaments.execute({ worldId });
      // Runs AFTER junior generation, same rollover/gate, for a
      // load-bearing reason: StartDueTournamentsUseCase's due check is
      // strictly `weeksBetween(weekScheduled, currentWeek) > 0` so a
      // junior tournament opened moments ago THIS rollover
      // (weekScheduled: currentWeek) is never force-started before any
      // manager had a chance to register — see that use case's doc.
      await deps.startDueTournaments.execute({ worldId });
      // The obligatory-tournament ranking rule (P9 —
      // docs/ranking-realism-proposal.md §4), LAST of the weekly
      // systems and deliberately so: it reads every concluded
      // obligatory event and every player's live senior rank, so it
      // must see this rollover's own tournament state, not a
      // half-updated one. Idempotent by construction (a written
      // skip-zero is itself a ledger row for that player+tournament),
      // so it carries no tick key of its own — see the use case.
      await deps.applyObligatoryTournamentZeros.execute({ worldId });

      // The Masters Cup (P8b) is generated once per season, on its
      // capstone week. Idempotent (one cup per season — the use case
      // no-ops if it already exists).
      const world = await deps.worlds.findById(worldId);
      if (world && world.currentWeek.week === MASTERS_CUP_WEEK) {
        await deps.generateMastersCup.execute({
          worldId,
          season: world.currentWeek.season,
          weekScheduled: { ...world.currentWeek },
          surface: 'hard',
        });
      }
      if (world && world.currentWeek.week === WORLD_TEAM_CUP_WEEK) {
        await deps.generateWorldTeamCup.execute({
          worldId,
          season: world.currentWeek.season,
          weekScheduled: { ...world.currentWeek },
          surface: 'clay',
        });
      }
    }

    // Match simulation is folded into EVERY day tick (not just
    // rollovers) and paced by the schedule policy: it plays only the
    // rounds whose scheduled day has arrived, one round per tournament
    // per day. See SimulateDueMatchesUseCase.
    if (result.advanced) {
      const sim = await deps.simulateDueMatches.execute({ worldId });
      // Straight after the sweep, on the SAME day tick: any tournament
      // whose qualifying draw just finished gets its main draw seeded
      // from the qualifiers who came through (deferred main-draw
      // seeding — see PromoteQualifiersUseCase). Ordered after, not
      // before, so the qualifying final decided moments ago counts;
      // nothing is played too early either way, since the main draw's
      // own first round is scheduled for a later day.
      const promoted = await deps.promoteQualifiers.execute({ worldId });
      const doublesPromoted = await deps.promoteDoublesQualifiers.execute({ worldId });
      const world = await deps.worlds.findById(worldId);
      if (world) {
        // The Masters Cup's own sweep + group→knockout advancement, on the
        // same day tick (its matches are paced day-by-day).
        await deps.simulateDueMastersCupMatches.execute({ season: world.currentWeek.season, worldId });
        await deps.advanceMastersCup.execute({ season: world.currentWeek.season });
        await deps.simulateDueWorldTeamCupRubbers.execute({ season: world.currentWeek.season, worldId });
        await deps.advanceWorldTeamCup.execute({ season: world.currentWeek.season });
      }
      return {
        ...result,
        matchesSimulated: sim.simulated.length,
        matchesFailed: sim.failed.length,
        qualifiersPromoted: promoted.promoted,
        mainDrawsSeeded: promoted.mainDrawsSeeded,
        doublesQualifiersPromoted: doublesPromoted.promoted,
        doublesMainDrawsSeeded: doublesPromoted.mainDrawsSeeded,
      };
    }
    return result;
  };
}

export function makeSimulateDueMatchesHandler(deps: Dependencies, worldId: string) {
  return async () => {
    const sim = await deps.simulateDueMatches.execute({ worldId: WorldId(worldId) });
    // Same pairing as the day tick above: this standalone sweep is the
    // other place matches get played, so it must also be able to move a
    // finished qualifying draw on to its main draw — otherwise a
    // tournament could sit qualified-but-unseeded until the next day
    // tick.
    const promoted = await deps.promoteQualifiers.execute({ worldId: WorldId(worldId) });
    const doublesPromoted = await deps.promoteDoublesQualifiers.execute({ worldId: WorldId(worldId) });
    const world = await deps.worlds.findById(WorldId(worldId));
    if (world) {
      await deps.simulateDueMastersCupMatches.execute({ season: world.currentWeek.season, worldId: WorldId(worldId) });
      await deps.advanceMastersCup.execute({ season: world.currentWeek.season });
    }
    return {
      ...sim,
      qualifiersPromoted: promoted.promoted,
      mainDrawsSeeded: promoted.mainDrawsSeeded,
      doublesQualifiersPromoted: doublesPromoted.promoted,
      doublesMainDrawsSeeded: doublesPromoted.mainDrawsSeeded,
    };
  };
}
