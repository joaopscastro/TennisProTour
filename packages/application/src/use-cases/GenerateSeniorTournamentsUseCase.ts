import { GameWeek, SeniorTournamentSchedulePolicy, StandardSeniorTournamentSchedulePolicy, Surface, TournamentId, WEEKS_PER_SEASON, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort, TournamentRepository } from '../ports/ports';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';

export interface GenerateSeniorTournamentsCommand {
  worldId: WorldId;
  /** The season/week to generate the slate for. Omitted, the world's
   * CURRENT week is used (the worker path); supplied, exactly that week
   * is generated regardless of the world clock (the backfill path —
   * apps/api/src/scripts/backfillSeniorSeason.ts fills the rest of the
   * season with it). */
  week?: GameWeek;
}

export interface GenerateSeniorTournamentsResult {
  /** Senior tournaments actually opened this run — 0 when every tier in
   * the week's slate was already present (idempotent re-fire). */
  opened: number;
}

/** Cosmetic-only rotation so a season's worth of generated tournaments
 * isn't monotonously all one surface — no gameplay weight, same
 * "illustrative, not sourced" status as the schedule policy's numbers. */
const SURFACE_ROTATION: ReadonlyArray<Surface> = ['hard', 'clay', 'grass', 'indoor'];

/**
 * The weekly SENIOR-tour content generator — the senior analogue of
 * GenerateJuniorTournamentsUseCase, and the fix for a real structural
 * gap: before this existed, NOTHING ever created a senior tournament
 * automatically. The junior ladder had a weekly generator; the senior
 * tour only ever got tournaments from the dev seed script's one-shot
 * week-1..5 fixtures (or a manual OpenRegistrationUseCase call), so a
 * live world ran completely dry of senior fixtures after those weeks
 * passed — every player old enough for the senior tour had nothing to
 * enter, and the "/tournaments page shows stale week-1/2/3 fixtures"
 * reports were a symptom of that emptiness, not of those fixtures.
 *
 * Every tier opens via OpenRegistrationUseCase — no entrants yet, open
 * to any manager, exactly like the junior grades. Unlike the junior
 * schedule there is NO ranked-gated capstone in this weekly slate: the
 * `major` tier (2-week, holds qualifying — see QualifyingPolicy) is just
 * a rare, large open-registration event, four per season on the
 * every-13-week cadence the schedule policy owns.
 *
 * Run from the same worker handler as the other weekly systems
 * (apps/worker/src/jobs/handlers.ts), gated on the tick's
 * `weekRolledOver` — same reasoning as GenerateJuniorTournamentsUseCase:
 * a tick that didn't roll the week over shouldn't mint a fresh slate.
 *
 * Idempotency: opening is skipped for any (week, tier) that already has
 * an open senior tournament — cheap and sufficient, because both this
 * use case's own re-fires and the season-backfill script always create
 * the FULL count for a tier, so "at least one exists" means "the slate
 * is already satisfied" and nothing is ever double-minted.
 */
export class GenerateSeniorTournamentsUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly tournaments: TournamentRepository,
    private readonly openRegistration: OpenRegistrationUseCase,
    private readonly idGenerator: IdGeneratorPort,
    private readonly schedule: SeniorTournamentSchedulePolicy = new StandardSeniorTournamentSchedulePolicy(),
  ) {}

  async execute(command: GenerateSeniorTournamentsCommand): Promise<GenerateSeniorTournamentsResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const week = command.week ?? world.currentWeek;
    // Continuously incrementing (season * 52 + week), not week alone,
    // so an every-N-week cadence doesn't reset at each season boundary
    // (same absolute-week arithmetic as the junior generator).
    const absoluteWeek = week.season * WEEKS_PER_SEASON + week.week;

    // Idempotency guard: which senior tiers already have an open
    // tournament this week (see the class doc comment). Only ever
    // checks the open set — a senior tournament can't have started the
    // same week it was generated, so a re-fire / backfill collision is
    // always caught while the slate is still open.
    const alreadyOpen = await this.tournaments.findOpenForRegistration();
    const openTiersThisWeek = new Set(
      alreadyOpen
        .filter(
          (t) =>
            t.ageBand === null &&
            t.weekScheduled.season === week.season &&
            t.weekScheduled.week === week.week,
        )
        .map((t) => t.tier),
    );

    let opened = 0;
    let surfaceIndex = 0;
    const nextSurface = (): Surface => SURFACE_ROTATION[surfaceIndex++ % SURFACE_ROTATION.length];

    for (const opening of this.schedule.weeklyOpenings(absoluteWeek)) {
      if (openTiersThisWeek.has(opening.tier)) continue;
      for (let i = 0; i < opening.count; i++) {
        await this.openRegistration.execute({
          tournamentId: TournamentId(this.idGenerator.generate()),
          tier: opening.tier,
          surface: nextSurface(),
          weekScheduled: week,
          drawSize: opening.drawSize,
        });
        opened += 1;
      }
    }

    return { opened };
  }
}
