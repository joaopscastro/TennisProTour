import { DrawSize, SeniorTier } from './CompetitionTypes';

/** One weekly batch of a single senior tier: `count` separate
 * tournaments of `tier`/`drawSize`, opened for registration (no fixed
 * entrant list) — see GenerateSeniorTournamentsUseCase. */
export interface SeniorOpening {
  readonly tier: SeniorTier;
  readonly drawSize: DrawSize;
  readonly count: number;
}

/**
 * How often, and how many at a time, each senior tier opens for
 * registration — the swappable-policy seam for tuning the senior
 * circuit's pacing, the exact analogue of JuniorTournamentSchedulePolicy
 * for the senior tour. Before this existed there was NO senior-tour
 * generation at all: senior tournaments only ever came from the dev
 * seed script's one-shot week-1..5 fixtures (or a manual
 * OpenRegistrationUseCase call), so a live world's senior tour ran dry
 * after those weeks passed — the whole reason the generated junior
 * ladder (J30..J500) had a real weekly presence while the senior tour
 * had none.
 *
 * Placeholder cadence/volume numbers — illustrative, not sourced or
 * balanced, same status as the junior schedule's and
 * StandardRankingPointsTable's constants. What IS deliberate: the senior
 * tour is denser than the junior ladder (futures/challenger fire every
 * week so there's always something to enter), the `major` tier is rare
 * (four per season, every 13 weeks — the Grand-Slam cadence) and large
 * (128-draw), and — like the junior schedule — everyNWeeks values are
 * arranged so a major week still also fires the smaller tiers, never
 * feeling arbitrary.
 *
 * The major's 13-week cadence carries a `phase: 12` offset rather than
 * firing on absolute week ≡ 0 (mod 13) — see TWO_WEEK_TIERS' week-51
 * rule in TournamentSchedulePolicy.ts. Absolute weeks ≡ 0 (mod 13) are
 * season weeks 13/26/39/52, and week 52 is forbidden for a two-week
 * tier (its final would land on S2W1 day 7, after the season bonus pool
 * and the season prize reset). `phase: 12` shifts every major one week
 * earlier — season weeks 12/25/38/51, still exactly four per 13-week-
 * spaced season, still a major every 13 weeks across season boundaries
 * (51 → 64 = S2W12). Because 52 ≡ 0 (mod 13), the phase holds for
 * EVERY season, not just the first.
 */
const SCHEDULE: ReadonlyArray<SeniorOpening & { everyNWeeks: number; phase?: number }> = [
  { tier: 'futures', drawSize: 32, count: 2, everyNWeeks: 1 },
  { tier: 'challenger', drawSize: 32, count: 2, everyNWeeks: 1 },
  { tier: 'tour', drawSize: 64, count: 1, everyNWeeks: 1 },
  { tier: 'major', drawSize: 128, count: 1, everyNWeeks: 13, phase: 12 },
];

export interface SeniorTournamentSchedulePolicy {
  /** Senior-tier tournaments to open this week, all for the senior
   * tour (ageBand null). `absoluteWeek` is a continuously incrementing
   * week counter (season * 52 + week, see world/GameWorld.weeksBetween),
   * not GameWeek.week alone, so an every-N-week cadence doesn't reset
   * at each season boundary. */
  weeklyOpenings(absoluteWeek: number): ReadonlyArray<SeniorOpening>;
}

export class StandardSeniorTournamentSchedulePolicy implements SeniorTournamentSchedulePolicy {
  weeklyOpenings(absoluteWeek: number): ReadonlyArray<SeniorOpening> {
    return SCHEDULE.filter((row) => absoluteWeek % row.everyNWeeks === (row.phase ?? 0)).map((row) => ({
      tier: row.tier,
      drawSize: row.drawSize,
      count: row.count,
    }));
  }
}
