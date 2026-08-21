/**
 * Domain service seam for player development economics — the "raise a
 * pupil" loop (docs/rocking-rackets-competitive-analysis.md §1c). Same
 * swappable-policy pattern as TrainingPolicy, ManagerXpPolicy and
 * RankingPointsTable: how much a match teaches, how much a talented
 * player learns for free each week, and how much accumulated experience
 * one point of training costs are all tunable game-balance formulas —
 * not something SimulateMatchUseCase, AdvanceWorldWeekUseCase or Player
 * should compute inline.
 *
 * Two distinct currencies, deliberately NOT merged: this player-level
 * `experience` is earned by that specific player playing and spent on
 * that player's own training (see Player.experience / Player.applyTraining).
 * It is unrelated to MANAGER XP (ManagerXpPolicy / ManagerXpRepository),
 * which a manager spends on claims and coach conversions — the same
 * "player accolade vs. manager currency" split ranking points already
 * draw. A free agent / fillOnly player has no manager to earn manager XP
 * for, but still earns and spends its OWN experience to develop (that's
 * what makes an unsigned prospect a moving target, not a frozen one).
 */
export interface PlayerDevelopmentPolicy {
  /** Experience both participants earn from one completed match, keyed
   * on how competitive it was. Per RR (§1c): XP scales with the MATCH
   * LOSER's games won across the whole match — a 6-0 6-0 blowout teaches
   * almost nothing, a 7-6 7-6 war teaches a lot — and the winner earns a
   * fixed fraction (WINNER_SHARE) of what the loser earns from the same
   * match. `loserGames` is the match loser's total games won across all
   * sets, never a per-set figure. */
  matchExperience(input: { loserGames: number; isWinner: boolean }): number;

  /** Free experience a player accrues every weekly tick purely from
   * their `talent` stat — the "young high-talent players are long-term
   * projects" half of §1c. Higher talent = faster passive growth,
   * independent of match results. */
  weeklyTalentIncome(talent: number): number;

  /** How much accumulated experience one skill-point of training costs.
   * Player.applyTraining spends this per point of base training delta it
   * actually funds — so a player with no experience cannot train at all,
   * and a player's growth rate is ultimately bounded by how much they
   * play (match XP) plus their talent (weekly income). */
  experienceCostPerSkillPoint(): number;
}

/**
 * Illustrative, not balanced — same caveat as StandardTrainingPolicy's
 * BASE_GAIN, StandardManagerXpPolicy's constants and
 * StandardRankingPointsTable's points formula: placeholder numbers safe
 * for validating the architecture and the development loop's SHAPE, but
 * owned by the same fatigue/form/development tuning pass
 * (docs/rocking-rackets-competitive-analysis.md §5) before launch.
 */
export class StandardPlayerDevelopmentPolicy implements PlayerDevelopmentPolicy {
  /** PLACEHOLDER: experience per game the match loser won. A best-of-3
   * loss where the loser scraped ~10-12 games (two tight sets) yields
   * ~30-36 XP to the loser; a 6-0 6-0 loss yields the floor below. */
  private static readonly XP_PER_LOSER_GAME = 3;

  /** PLACEHOLDER: a small floor so even a total blowout teaches
   * something (both players still competed) — otherwise a 6-0 6-0 loser
   * earns literally zero and can never develop out of a losing streak. */
  private static readonly MATCH_XP_FLOOR = 4;

  /** PLACEHOLDER: the winner earns this fraction of what the loser earns
   * from the same match — RR's exact "winning gives 65% of what losing
   * gives" rule (§1c). Winning a hard match still teaches a lot; winning
   * an easy one teaches little, same as it does for the loser. */
  private static readonly WINNER_SHARE = 0.65;

  /** PLACEHOLDER: weekly free experience per talent point. A talent-50
   * player passively earns ~15 XP/week; a talent-90 prospect ~27/week —
   * enough that a high-talent youth develops noticeably faster even
   * before accounting for match XP. */
  private static readonly WEEKLY_XP_PER_TALENT = 0.3;

  /** PLACEHOLDER: experience cost of one training skill-point. With a
   * StandardTrainingPolicy youth base of 1.0/week, a fully-funded youth
   * training week costs ~18 XP — roughly one week of talent-60 income,
   * or the XP from one competitive match, so "growth is earned by
   * playing" is a real constraint, not a formality. */
  private static readonly XP_PER_SKILL_POINT = 18;

  /** Optional constructor overrides — same pattern as
   * StatisticalMatchSimulator's `pointProbabilityDivisor` override, which
   * exists specifically so `apps/api/scripts/balance-simulation.mjs` can
   * compare candidate values against real simulation data instead of
   * guessing at a retuning pass, rather than editing the private static
   * constants directly between runs. Absent = the class constants above,
   * unchanged for every existing caller. */
  constructor(
    private readonly weeklyXpPerTalentOverride: number = StandardPlayerDevelopmentPolicy.WEEKLY_XP_PER_TALENT,
    private readonly xpPerSkillPointOverride: number = StandardPlayerDevelopmentPolicy.XP_PER_SKILL_POINT,
  ) {}

  matchExperience(input: { loserGames: number; isWinner: boolean }): number {
    const loserGames = Math.max(0, input.loserGames);
    const loserXp = StandardPlayerDevelopmentPolicy.MATCH_XP_FLOOR + loserGames * StandardPlayerDevelopmentPolicy.XP_PER_LOSER_GAME;
    const raw = input.isWinner ? loserXp * StandardPlayerDevelopmentPolicy.WINNER_SHARE : loserXp;
    return Math.round(raw);
  }

  weeklyTalentIncome(talent: number): number {
    return Math.round(Math.max(0, talent) * this.weeklyXpPerTalentOverride);
  }

  experienceCostPerSkillPoint(): number {
    return this.xpPerSkillPointOverride;
  }
}
