import {
  AGE_BAND_ORDER,
  AgeBand,
  JuniorTournamentSchedulePolicy,
  PlayerId,
  StandardJuniorTournamentSchedulePolicy,
  Surface,
  TournamentId,
  WEEKS_PER_SEASON,
  WorldId,
  addWeeks,
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
   * across all three age bands. */
  opened: number;
  /** How many juniorMasters fields (0-3, one per band) were
   * actually held this tick. On a juniorMasters week, a band that
   * doesn't yet have `juniorMastersDrawSize` ranked players is
   * skipped, not filled with fabricated entrants — see execute()'s
   * doc comment. */
  mastersHeld: number;
}

/** The bands regular grades open for, youngest first — the domain's one
 * canonical play-up ordering, not a second hardcoded list (this literal
 * used to be its own copy). */
const AGE_BANDS: ReadonlyArray<AgeBand> = AGE_BAND_ORDER;
/** Oldest band first — the invitation order, the reverse of the
 * canonical play-up order. A player can be ranked in two bands at once
 * (playing up is allowed), so the invites must be awarded from the top
 * down: the highest band they qualify for takes them, and the younger
 * band's place passes to the next eligible player. */
const JUNIOR_MASTERS_BAND_ORDER: ReadonlyArray<AgeBand> = [...AGE_BAND_ORDER].reverse();
/** Cosmetic-only rotation so a season's worth of generated tournaments
 * isn't monotonously all one surface — no gameplay weight, same
 * "illustrative, not sourced" status as the schedule policy's numbers. */
const SURFACE_ROTATION: ReadonlyArray<Surface> = ['hard', 'clay', 'grass', 'indoor'];

/**
 * The weekly junior-ladder content generator: the missing piece that
 * makes the six J-grade tiers × three age bands (see JuniorTier,
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
 *
 *    **A player can hold at most ONE juniorMasters invitation per
 *    season — the highest band they qualify for.** The bands are
 *    invited OLDEST FIRST (`JUNIOR_MASTERS_BAND_ORDER`), carrying the
 *    already-invited player ids forward, so a player ranked top-16 in
 *    two bands (structurally possible: the invite is per-band
 *    independent and playing up is allowed) is entered in the older
 *    band's draw only, and the younger band's place passes to the next
 *    eligible player in ranked order. Before this, such a player was
 *    invited into BOTH concurrent draws — a real duplication bug fixed
 *    by the agent-season design pass, not a scoring change: each band's
 *    field is still exactly `juniorMastersDrawSize` strong (the place
 *    is reallocated, never dropped).
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
    // Open tournaments for NEXT week, not the current one: a manager gets
    // all of the current week to register, and the tournament then PLAYS
    // during its own labeled week (seeded at the rollover INTO that week by
    // StartDueTournamentsUseCase, whose due check is `weeksBetween >= 0`).
    const targetWeek = addWeeks(currentWeek, 1);
    // Continuously incrementing (season * 52 + week), not week alone,
    // so an every-N-week cadence doesn't reset at each season boundary.
    const absoluteWeek = targetWeek.season * WEEKS_PER_SEASON + targetWeek.week;

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
            weekScheduled: targetWeek,
            drawSize: grade.drawSize,
          });
          opened += 1;
        }
      }
    }

    if (this.schedule.isJuniorMastersWeek(targetWeek)) {
      // One invitation per player per season, awarded OLDEST BAND FIRST:
      // a player ranked top-`drawSize` in two bands takes the older
      // band's place, and the younger band's field is rebuilt from its
      // ranked list MINUS everyone already invited — so the freed place
      // goes to the next eligible player, never leaving the field short.
      const invited = new Set<PlayerId>();
      const drawSize = this.schedule.juniorMastersDrawSize;
      for (const ageBand of JUNIOR_MASTERS_BAND_ORDER) {
        const ranked = await this.rankPositionByBand[ageBand].sortedRankings();
        const eligible = ranked.filter((r) => !invited.has(r.playerId));
        if (eligible.length >= drawSize) {
          const field = eligible.slice(0, drawSize);
          await this.openTournament.execute({
            tournamentId: TournamentId(this.idGenerator.generate()),
            tier: 'juniorMasters',
            ageBand,
            surface: nextSurface(),
            weekScheduled: targetWeek,
            drawSize,
            entrants: field.map((r, index) => ({ playerId: r.playerId, seed: index + 1 })),
          });
          mastersHeld += 1;
          for (const r of field) invited.add(r.playerId);
        }
        // else: fewer than drawSize players currently have a real
        // ranking in this band after removing anyone already invited
        // elsewhere — skip this season's Masters for this band rather
        // than inventing a field.
      }
    }

    return { opened, mastersHeld };
  }
}
