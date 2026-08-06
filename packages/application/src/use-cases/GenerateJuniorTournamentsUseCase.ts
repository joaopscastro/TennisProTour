import {
  AgeBand,
  JuniorTournamentSchedulePolicy,
  StandardJuniorTournamentSchedulePolicy,
  Surface,
  TournamentId,
  WEEKS_PER_SEASON,
  WorldId,
} from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort } from '../ports/ports';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';
import { OpenTournamentUseCase } from './OpenTournamentUseCase';
import { RankPositionQuery } from '../queries/RankPositionQuery';

export interface GenerateJuniorTournamentsCommand {
  worldId: WorldId;
}

export interface GenerateJuniorTournamentsResult {
  /** Regular (open-registration) grade tournaments opened this tick,
   * across both age bands. */
  opened: number;
  /** How many juniorMasters fields (0, 1, or 2 — one per band) were
   * actually held this tick. On a juniorMasters week, a band that
   * doesn't yet have `juniorMastersDrawSize` ranked players is
   * skipped, not filled with fabricated entrants — see execute()'s
   * doc comment. */
  mastersHeld: number;
}

const AGE_BANDS: ReadonlyArray<AgeBand> = ['u14', 'u16'];
/** Cosmetic-only rotation so a season's worth of generated tournaments
 * isn't monotonously all one surface — no gameplay weight, same
 * "illustrative, not sourced" status as the schedule policy's numbers. */
const SURFACE_ROTATION: ReadonlyArray<Surface> = ['hard', 'clay', 'grass', 'indoor'];

/**
 * The weekly junior-ladder content generator: the missing piece that
 * makes the six J-grade tiers × two age bands (see JuniorTier,
 * AgeBand) actually reachable in play, not just representable in the
 * type system. Before this use case existed, NOTHING ever created a
 * junior tournament automatically — the only way one came into being
 * was a hardcoded call in apps/api/src/scripts/seed.ts. There was no
 * flat 'junior'-tier generation logic to extend either; this is new
 * generation, not a replacement of an old mechanism.
 *
 * Run from the same worker handler as AdvanceWorldWeekUseCase/
 * RefreshTalentPoolUseCase, gated on that use case's `advanced` result
 * — same idempotency reasoning as the talent pool refresh: a tick that
 * didn't actually move the world clock forward shouldn't generate a
 * fresh batch of tournaments either (see apps/worker/src/jobs/handlers.ts).
 *
 * Two genuinely different mechanisms, per band, per tick:
 *
 * 1. **Regular grades (J30-J500)**: `schedule.weeklyOpenings()` says
 *    which tiers fire this week and how many of each; every one opens
 *    via OpenRegistrationUseCase — no entrants yet, open to any
 *    manager, exactly like every other open-registration tournament
 *    in this game. This is what "reliably and abundantly available"
 *    actually means for the six real grades.
 *
 * 2. **juniorMasters**: NOT open registration. On the one week a
 *    season it's held (`schedule.isJuniorMastersWeek`), this reads
 *    that band's LIVE current ranking (RankPositionQuery, the same
 *    query the roster dashboard and NR semantics already rely on) and
 *    invites exactly the top `juniorMastersDrawSize` ranked players as
 *    a fixed entrant list via OpenTournamentUseCase — gated by
 *    standing, never open entry, per the brief this implements. If
 *    fewer than `juniorMastersDrawSize` players in that band currently
 *    have ANY qualifying ranking (see RankPositionQuery's NR
 *    semantics), that band's Masters is skipped for the season rather
 *    than filled out with unranked or fabricated players — a
 *    juniorMasters field must be earned into, same "no ranking
 *    without a real result" principle as everything else in this
 *    ladder.
 */
export class GenerateJuniorTournamentsUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly openRegistration: OpenRegistrationUseCase,
    private readonly openTournament: OpenTournamentUseCase,
    private readonly rankPositionByBand: Record<AgeBand, RankPositionQuery>,
    private readonly idGenerator: IdGeneratorPort,
    private readonly schedule: JuniorTournamentSchedulePolicy = new StandardJuniorTournamentSchedulePolicy(),
  ) {}

  async execute(command: GenerateJuniorTournamentsCommand): Promise<GenerateJuniorTournamentsResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const currentWeek = world.currentWeek;
    // Continuously incrementing (season * 52 + week), not week alone,
    // so an every-N-week cadence doesn't reset at each season boundary.
    const absoluteWeek = currentWeek.season * WEEKS_PER_SEASON + currentWeek.week;

    let opened = 0;
    let mastersHeld = 0;
    let surfaceIndex = 0;
    const nextSurface = (): Surface => SURFACE_ROTATION[surfaceIndex++ % SURFACE_ROTATION.length];

    for (const ageBand of AGE_BANDS) {
      for (const grade of this.schedule.weeklyOpenings(absoluteWeek)) {
        for (let i = 0; i < grade.count; i++) {
          await this.openRegistration.execute({
            tournamentId: TournamentId(this.idGenerator.generate()),
            tier: grade.tier,
            ageBand,
            surface: nextSurface(),
            weekScheduled: currentWeek,
            drawSize: grade.drawSize,
          });
          opened += 1;
        }
      }

      if (this.schedule.isJuniorMastersWeek(currentWeek)) {
        const drawSize = this.schedule.juniorMastersDrawSize;
        const ranked = await this.rankPositionByBand[ageBand].sortedRankings();
        if (ranked.length >= drawSize) {
          await this.openTournament.execute({
            tournamentId: TournamentId(this.idGenerator.generate()),
            tier: 'juniorMasters',
            ageBand,
            surface: nextSurface(),
            weekScheduled: currentWeek,
            drawSize,
            entrants: ranked.slice(0, drawSize).map((r, index) => ({ playerId: r.playerId, seed: index + 1 })),
          });
          mastersHeld += 1;
        }
        // else: fewer than drawSize players currently have a real U14/
        // U16 ranking in this band — skip this season's Masters for
        // this band rather than inventing a field.
      }
    }

    return { opened, mastersHeld };
  }
}
