import { PlayerId, ManagerId } from '../shared/ids';
import { PlayerAttributes, Surface, isPhysicalAttribute } from './PlayerAttributes';
import { PhysicalCeilings } from './PlayerGenerationPolicy';
import { PlayerDevelopmentPolicy } from './PlayerDevelopmentPolicy';
import { DomainEvent } from '../shared/DomainEvent';
import { TrainingFocus, TrainingPolicy, applyCoachBonus, applyPotentialDiminishingReturns } from './TrainingPolicy';

/**
 * A dormant graduation-carryover bonus parked on this player at an
 * age-band crossing, waiting to be consumed by their first real result
 * in the new band. Named distinctly from (rather than importing) the
 * Competition/Ranking bounded context's own
 * `GraduationCarryover.DormantCarryoverBonus` — per CLAUDE.md principle
 * #5, `domain/player` doesn't import from `domain/ranking` (a
 * different bounded context); the two types are structurally
 * identical on purpose, so the application layer (which already spans
 * both contexts, e.g. SimulateMatchUseCase) can pass a value straight
 * through without any explicit mapping. Player itself has zero opinion
 * about what a "band" means or how the bonus is computed/consumed —
 * see GraduationCarryover.ts for that; Player only stores and clears
 * this one field.
 */
export interface PlayerDormantCarryoverBonus {
  readonly targetBand: 'senior' | 'u14' | 'u16' | 'u18';
  readonly bonusPoints: number;
}

export type PlayerLifecycleStage = 'youth' | 'prime' | 'decline' | 'retired';

export interface PlayerProps {
  id: PlayerId;
  name: string;
  /** Set once at hire time, purely a presentation concern (a flag next
   * to the player's name) — the domain attaches no gameplay meaning to
   * it. Free-text rather than an enum/ISO-code type on purpose: no
   * country reference data exists anywhere else in the domain, and
   * adding one for a display-only field would be exactly the kind of
   * scope CLAUDE.md warns against. */
  nationality: string;
  ageInWeeks: number;
  managerId: ManagerId | null;
  attributes: PlayerAttributes;
  stage: PlayerLifecycleStage;
  fatigue: number; // 0 (fresh) – 100 (exhausted)
  /** Match rhythm counter (see docs/rocking-rackets-competitive-analysis.md
   * §1b). Accrues +FORM_PER_MATCH per real match played, decays a fixed
   * fraction every weekly tick. Both under-playing (rusty) and
   * over-playing (stale) sit OUTSIDE the sweet-spot band and cost
   * effective rating in the sim — see formModifier in
   * StatisticalMatchSimulator. Unlike fatigue (a pure debuff), form is a
   * band the manager schedules a rhythm around. Clamped to [0, 100]. */
  form: number;
  // NOTE: there is deliberately no `currentFocus` field here anymore.
  // A player's standing training focus used to be one mutable field
  // Player owned directly (set via a since-removed setTrainingFocus()
  // method); it's now a per-player, per-GameWeek schedule of explicit
  // TrainingScheduleEntry rows living in its own repository, resolved
  // for a given week via resolveTrainingFocusForWeek (see
  // TrainingSchedule.ts). Player itself has zero opinion about
  // scheduling — same "Player only applies deltas it's handed, it
  // doesn't decide what those deltas should be" boundary
  // applyTraining()'s own doc comment already draws for the delta
  // SIZE; this is that same boundary applied to WHICH focus applies
  // this week.
  /** Hidden ceiling generated at creation time (see
   * PlayerGenerationPolicy.GeneratedPlayer.potentialCeiling), carried
   * unchanged from whatever talent-pool candidate or custom player
   * this Player originated from. NEVER exposed via any DTO — see
   * playerDto.ts, which deliberately does not read this field.
   * ORPHANED by applyTraining() as of the per-attribute training
   * redesign (docs/training-redesign-per-attribute.md): technical
   * attributes are never gated by any ceiling, physical attributes are
   * gated by their own physicalCeilings entry below instead, and
   * mental attributes are never trained at all — nothing reads this
   * field for training anymore. Still generated and stored (it also
   * feeds PlayerGenerationPolicy's scouting-noise calculation at
   * generation time, unrelated to training), left independent rather
   * than derived from physicalCeilings per that doc's "deliberately
   * deferred, not solved now" section — not removed, just no longer
   * load-bearing for training. */
  potentialCeiling: number;
  /** Hidden per-physical-attribute training ceilings — set once at
   * generation time (see PlayerGenerationPolicy.GeneratedPlayer.physicalCeilings),
   * carried unchanged from whatever talent-pool candidate or custom
   * player this Player originated from. NEVER exposed via any DTO —
   * see playerDto.ts, which deliberately does not read this field.
   * This IS what applyTraining() gates physical-attribute training
   * against now (see that method's doc comment) — potentialCeiling
   * above is the one that's orphaned, not this one. */
  physicalCeilings: PhysicalCeilings;
  /** Innate growth-rate stat (see
   * PlayerGenerationPolicy.GeneratedPlayer.talent) — fixed for the
   * player's whole career, drives how much free experience they accrue
   * every weekly tick (PlayerDevelopmentPolicy.weeklyTalentIncome).
   * Hidden like potentialCeiling — NEVER exposed via any DTO in P4 (the
   * profile-only scouted read on it is P5's job). */
  talent: number;
  /** Earned, spendable player-development experience (see
   * docs/rocking-rackets-competitive-analysis.md §1c and
   * PlayerDevelopmentPolicy) — accrued from playing matches (scaled by
   * how competitive they were) and weekly from `talent`, spent by
   * applyTraining to fund skill growth. Distinct from MANAGER XP
   * (ManagerXpRepository), which belongs to a manager, not a player: a
   * free agent still earns and spends its own experience. Starts at 0
   * for every newly generated/hired player — experience is earned, never
   * generated. Only ever grows via gainExperience and shrinks via
   * applyTraining's funding; never negative. */
  experience: number;
  /** null = no pending graduation-carryover bonus. Set by
   * AdvanceWorldWeekUseCase the week this player crosses a junior
   * age-band boundary; cleared by SimulateMatchUseCase the moment it's
   * consumed by this player's first real (points > 0) ranking-ledger
   * entry in the target band. See PlayerDormantCarryoverBonus's doc
   * comment above and domain/ranking/GraduationCarryover.ts for the
   * mechanism. */
  dormantCarryoverBonus: PlayerDormantCarryoverBonus | null;
  /** True only for a player generated by GenesisSeedFillOnlyPlayersUseCase
   * or converted from an expired TalentPoolCandidate (see
   * RefreshTalentPoolUseCase and docs/tournament-fill-system.md) — never
   * set by hire() (a manager's own roster is never fill-only). Always
   * paired with managerId: null, but means something more specific than
   * that alone: a RELEASED player also has managerId null yet
   * fillOnly stays false for them, since a release doesn't turn a
   * once-managed player into a fill-only NPC-like entity, it just frees
   * their slot. AdvanceWorldWeekUseCase reads this flag to decide
   * whether to auto-train toward the weakest attribute (fillOnly
   * players have no manager to set a TrainingFocus) or to leave
   * schedule-driven training untouched (every other player, including
   * a released one — see TrainingSchedule.ts). There is deliberately no path back to
   * false, and no manager-facing route ever claims a fillOnly player —
   * see docs/tournament-fill-system.md's "Open question" section for
   * why permanent fill-only status was chosen over some broader
   * reclaim mechanism. */
  fillOnly: boolean;
  /** Cumulative on-site prize money earned across this player's entire
   * career (see StandardPrizeMoneyTable/qualifyingPrizeMoneyFor/
   * doublesPrizeMoneyFor). Never decreases, never reset — the career
   * counterpart to a title. Starts at 0 for every newly hired/generated
   * player, credited only by creditPrizeMoney(). */
  careerPrizeMoney: number;
  /** Prize money earned so far in the CURRENT season only — the same
   * events that credit careerPrizeMoney also credit this, but
   * AdvanceWorldWeekUseCase zeroes it out at every season rollover (see
   * resetSeasonPrizeMoney), so it always reads "how much this player
   * has won since the season started" — the input to the season-end
   * bonus pool standings. */
  seasonPrizeMoney: number;
  /** The player's age (in weeks) as of the most recent season boundary
   * (game-week 1, "January 1" — see RankingBand.juniorEligibilityForAge's
   * doc comment for the real ITF/Tennis Europe rule this implements: a
   * junior's age category for the WHOLE year is fixed by their age on
   * January 1 of that year, not their literal current age). This is the
   * value junior age-band eligibility is actually computed against
   * EVERYWHERE (tournament registration, filler selection, standings
   * banding, roster/profile display) — never `ageInWeeks` directly for
   * that purpose. A player who turns 14 in June stays U14-eligible for
   * the rest of that season; they only become U16-eligible (or graduate
   * out of U14 for good) at the NEXT season rollover, once this anchor
   * is refreshed.
   *
   * Set to `ageInWeeks` at creation (hire()/generateFillOnly()) — a
   * freshly generated player has no real "last January 1" yet, so their
   * actual current age stands in until the next real one arrives — and
   * refreshed to the just-aged `ageInWeeks` exactly once per season, at
   * the season-rollover tick, via `anchorSeasonAge()` (called from
   * AdvanceWorldWeekUseCase, AFTER that tick's aging has already been
   * applied — so it captures the player's age as of week 1 of the new
   * season, i.e. the actual January 1 moment). Never touched by any
   * other weekly tick within a season. */
  seasonAgeAnchorWeeks: number;
}

/** Aggregate root for the Player & Roster bounded context.
 *
 * SRP note: Player owns identity + lifecycle transitions only. It does
 * NOT know how to age itself week-over-week (that's
 * PlayerAgingService's job, since aging curves are a policy that may
 * change independently of what a Player *is*), and it does NOT know
 * how to simulate a match (that's the Match Simulation Engine's job,
 * consuming only the immutable PlayerAttributes snapshot).
 */
export class Player {
  private readonly _domainEvents: DomainEvent[] = [];

  private constructor(private props: PlayerProps) {}

  static hire(
    id: PlayerId,
    name: string,
    ageInWeeks: number,
    attributes: PlayerAttributes,
    managerId: ManagerId,
    /** Optional so existing call sites (mostly tests that don't care
     * about nationality) don't all need updating — HirePlayerUseCase,
     * the real product entry point, always passes a real value. */
    nationality = 'XX',
    /** Same "optional trailing param, real entry points always pass a
     * real value" convention as `nationality` above — see this field's
     * doc comment on PlayerProps. Defaults to 100 (skill max), i.e. "no
     * meaningful ceiling," so every pre-existing call site that never
     * heard of potential ceilings keeps training at full, unthrottled
     * rate exactly as before this feature existed. Real entry points
     * (ClaimTalentPoolCandidateUseCase, CreateCustomPlayerUseCase)
     * always pass the real generated value. */
    potentialCeiling = 100,
    /** Same "optional trailing param, real entry points always pass a
     * real value" convention as potentialCeiling above. Defaults to
     * {100,100,100} — "no meaningful ceiling" per attribute — so every
     * pre-existing call site that never heard of per-attribute
     * ceilings is unaffected. Real entry points (ClaimTalentPoolCandidateUseCase,
     * CreateCustomPlayerUseCase) always pass the real generated value. */
    physicalCeilings: PhysicalCeilings = { speed: 100, stamina: 100, strength: 100 },
    /** Same "optional trailing param, real entry points always pass a
     * real value" convention as physicalCeilings above. Defaults to 0 —
     * "no innate growth-rate advantage," so every pre-existing call site
     * that never heard of talent is unaffected (a talent-0 player simply
     * earns no weekly talent income and develops only from match XP).
     * Real entry points (ClaimTalentPoolCandidateUseCase,
     * CreateCustomPlayerUseCase) always pass the real generated value. */
    talent = 0,
  ): Player {
    const player = new Player({
      id,
      name,
      nationality,
      ageInWeeks,
      managerId,
      attributes,
      stage: 'youth',
      fatigue: 0,
      form: 0,
      potentialCeiling,
      physicalCeilings,
      talent,
      experience: 0,
      dormantCarryoverBonus: null,
      fillOnly: false,
      careerPrizeMoney: 0,
      seasonPrizeMoney: 0,
      seasonAgeAnchorWeeks: ageInWeeks,
    });
    player._domainEvents.push({
      type: 'PlayerHired',
      occurredAt: new Date(),
      payload: { playerId: id, managerId },
    });
    return player;
  }

  /** Produces a fill-only free agent: no manager (managerId: null),
   * `fillOnly: true` (see PlayerProps.fillOnly's doc comment), and no
   * standing training focus — AdvanceWorldWeekUseCase auto-computes one
   * fresh every tick for a fillOnly player instead. Unlike hire(),
   * `stage` is a required parameter rather than hardcoded 'youth': a
   * fillOnly player can be generated at any non-retired age (see
   * GenesisSeedFillOnlyPlayersUseCase's wide age range), so the caller
   * must compute the real stage for that age via an AgingPolicy rather
   * than this factory silently assuming youth the way hire() safely can
   * (every real hire()/claim call site only ever generates a
   * 14-16-year-old). Emits a distinct 'FillOnlyPlayerGenerated' event
   * rather than 'PlayerHired' — nobody hired this player, so reusing
   * that event's name/payload shape (which promises a real managerId)
   * would be misleading to any consumer. */
  static generateFillOnly(
    id: PlayerId,
    name: string,
    ageInWeeks: number,
    stage: PlayerLifecycleStage,
    attributes: PlayerAttributes,
    nationality = 'XX',
    potentialCeiling = 100,
    physicalCeilings: PhysicalCeilings = { speed: 100, stamina: 100, strength: 100 },
    talent = 0,
  ): Player {
    const player = new Player({
      id,
      name,
      nationality,
      ageInWeeks,
      managerId: null,
      attributes,
      stage,
      fatigue: 0,
      form: 0,
      potentialCeiling,
      physicalCeilings,
      talent,
      experience: 0,
      dormantCarryoverBonus: null,
      fillOnly: true,
      careerPrizeMoney: 0,
      seasonPrizeMoney: 0,
      seasonAgeAnchorWeeks: ageInWeeks,
    });
    player._domainEvents.push({
      type: 'FillOnlyPlayerGenerated',
      occurredAt: new Date(),
      payload: { playerId: id },
    });
    return player;
  }

  /** Rehydrates a persisted player (repository adapters only). Unlike
   * hire(), this is not a domain action — it emits NO events; the
   * player being loaded back is not being hired again. */
  static reconstitute(props: PlayerProps): Player {
    return new Player({ ...props });
  }

  get id() {
    return this.props.id;
  }

  get name() {
    return this.props.name;
  }

  get nationality() {
    return this.props.nationality;
  }

  get ageInWeeks() {
    return this.props.ageInWeeks;
  }

  get managerId() {
    return this.props.managerId;
  }

  get attributes() {
    return this.props.attributes;
  }

  get stage() {
    return this.props.stage;
  }

  get fatigue() {
    return this.props.fatigue;
  }

  get form() {
    return this.props.form;
  }

  /** Hidden — see PlayerProps.potentialCeiling's doc comment. Read by
   * applyTraining() and by repository adapters that need to persist
   * it; never by anything building an HTTP-facing DTO. */
  get potentialCeiling() {
    return this.props.potentialCeiling;
  }

  /** Hidden — see PlayerProps.physicalCeilings' doc comment. Never
   * read by anything building an HTTP-facing DTO. */
  get physicalCeilings() {
    return this.props.physicalCeilings;
  }

  /** Hidden — see PlayerProps.talent's doc comment. Read by
   * AdvanceWorldWeekUseCase (weekly XP income) and repository adapters;
   * never by anything building an HTTP-facing DTO in P4. */
  get talent() {
    return this.props.talent;
  }

  /** Earned player-development experience — see PlayerProps.experience.
   * Read by repository adapters and by tests; the visible surface for it
   * is P5's job, not a P4 DTO field. */
  get experience() {
    return this.props.experience;
  }

  get dormantCarryoverBonus() {
    return this.props.dormantCarryoverBonus;
  }

  get fillOnly(): boolean {
    return this.props.fillOnly;
  }

  get careerPrizeMoney(): number {
    return this.props.careerPrizeMoney;
  }

  get seasonPrizeMoney(): number {
    return this.props.seasonPrizeMoney;
  }

  /** See PlayerProps.seasonAgeAnchorWeeks' doc comment — this, never
   * `ageInWeeks`, is what junior age-band eligibility is computed
   * against. */
  get seasonAgeAnchorWeeks(): number {
    return this.props.seasonAgeAnchorWeeks;
  }

  isRetired(): boolean {
    return this.props.stage === 'retired';
  }

  /** Applies a single training session for one focus (surface, or a
   * single technical/physical attribute — see TrainingFocus; mental is
   * never a valid focus at all). The BASE delta is computed by the
   * injected policy, never by Player: this method's job is only to
   * apply whatever delta it's given, not to decide how much a session
   * is worth in a vacuum. What Player DOES own is the further
   * adjustments intrinsic to this specific player/manager rather than
   * a swappable policy concern:
   *  - for a PHYSICAL attribute only, scaling the base delta down as
   *    that specific attribute's own hidden ceiling
   *    (physicalCeilings[attribute]) approaches (see
   *    applyPotentialDiminishingReturns) — a ceiling is a property of
   *    the player's own attribute, not of the training policy.
   *    Technical-attribute training is NEVER run through a ceiling at
   *    all (see docs/training-redesign-per-attribute.md: open-ended,
   *    bounded only by training investment and decline-stage decay),
   *    and neither is surface-affinity training — see
   *    applyPotentialDiminishingReturns' own doc comment.
   *  - scaling the (already ceiling-adjusted, for physical attributes)
   *    delta UP by the manager's coach, if any (see applyCoachBonus) —
   *    a coach's benefit is general training efficiency, unrelated to
   *    any specific attribute's own ceiling, so unlike the ceiling
   *    adjustment this DOES apply to surface, technical, AND physical
   *    training alike.
   *
   * `coachRating` defaults to null (no coach) so every pre-existing
   * call site that never heard of coaches keeps training exactly as
   * before this feature existed — same "optional trailing param, real
   * entry points pass a real value" convention as hire()'s
   * nationality/potentialCeiling params. The real caller
   * (AdvanceWorldWeekUseCase) looks up the manager's coach and passes
   * its coachRating through.
   *
   * `development` (P4 — docs/rocking-rackets-competitive-analysis.md
   * §1c) is the SAME optional-trailing-param convention: when null (the
   * legacy default, and what every pre-P4 test/call site passes), the
   * full base delta is applied for free, exactly as before — training
   * costs nothing. When a PlayerDevelopmentPolicy is passed (the real
   * caller, AdvanceWorldWeekUseCase), training is instead FUNDED by this
   * player's earned `experience`: the base delta is capped at what the
   * player can currently afford (experienceCostPerSkillPoint per point),
   * and that experience is spent. A player with no experience grows not
   * at all — growth is earned by playing (match XP) and by talent
   * (weekly income), never free. The funding gates the BASE delta;
   * ceiling diminishing-returns and coach bonus then apply to whatever
   * was funded, unchanged. */
  applyTraining(
    focus: TrainingFocus,
    policy: TrainingPolicy,
    coachRating: number | null = null,
    development: PlayerDevelopmentPolicy | null = null,
  ): void {
    if (this.isRetired()) {
      throw new Error(`Cannot train retired player ${this.props.id}`);
    }
    const baseDelta = this.fundBaseDelta(policy.computeDelta(focus, this.props.stage), development);
    if (baseDelta <= 0) return;
    if (focus.kind === 'surface') {
      const delta = applyCoachBonus(baseDelta, coachRating);
      const updatedAttributes = this.props.attributes.trainedOnSurface(focus.surface, delta);
      this.props = { ...this.props, attributes: updatedAttributes };
      return;
    }
    const { attribute } = focus;
    const ceilingAdjusted = isPhysicalAttribute(attribute)
      ? applyPotentialDiminishingReturns(baseDelta, this.props.attributes.attributeValue(attribute), this.props.physicalCeilings[attribute])
      : baseDelta; // technical: no ceiling, ever
    const delta = applyCoachBonus(ceilingAdjusted, coachRating);
    const updatedAttributes = this.props.attributes.trainedOnAttribute(attribute, delta);
    this.props = { ...this.props, attributes: updatedAttributes };
  }

  /** Caps a base training delta at what this player's earned experience
   * can pay for and spends that experience, when a development policy is
   * in effect; returns the base delta untouched (and spends nothing)
   * when it isn't — see applyTraining's doc comment for the two modes.
   * Only ever a debit of experience, never a credit; never drives
   * experience negative. */
  private fundBaseDelta(baseDelta: number, development: PlayerDevelopmentPolicy | null): number {
    if (development === null || baseDelta <= 0) return baseDelta;
    const costPerPoint = development.experienceCostPerSkillPoint();
    if (costPerPoint <= 0) return baseDelta; // defensive: a free policy funds fully
    const affordablePoints = this.props.experience / costPerPoint;
    const fundedBase = Math.min(baseDelta, affordablePoints);
    if (fundedBase <= 0) return 0;
    this.props = { ...this.props, experience: Math.max(0, this.props.experience - fundedBase * costPerPoint) };
    return fundedBase;
  }

  /** Credits earned player-development experience — called by
   * SimulateMatchUseCase (match XP for both participants) and
   * AdvanceWorldWeekUseCase (weekly talent income). Same "direct Player
   * mutator, no policy indirection" shape as applyMatchFatigue/
   * applyMatchForm; the amount is computed by PlayerDevelopmentPolicy at
   * the call site, Player just banks it. Negative or zero amounts are
   * ignored (experience is only ever earned here; it is spent only via
   * applyTraining's funding). */
  gainExperience(amount: number): void {
    if (amount <= 0) return;
    this.props = { ...this.props, experience: this.props.experience + amount };
  }

  applyMatchFatigue(fatigueDelta: number): void {
    this.props = {
      ...this.props,
      fatigue: Math.max(0, Math.min(100, this.props.fatigue + fatigueDelta)),
    };
  }

  recoverFatigue(amount: number): void {
    this.applyMatchFatigue(-amount);
  }

  /** Adds to this player's form counter after a real match — called by
   * SimulateMatchUseCase for both participants, same "direct Player
   * mutator, no policy indirection" shape as applyMatchFatigue. Clamped
   * to [0, 100]. See PlayerProps.form's doc comment. */
  applyMatchForm(formDelta: number): void {
    this.props = {
      ...this.props,
      form: Math.max(0, Math.min(100, this.props.form + formDelta)),
    };
  }

  /** Decays form toward zero by a multiplicative factor (e.g. 0.85 =
   * lose 15%) — called once per weekly tick by AdvanceWorldWeekUseCase.
   * A player who stops competing drifts out of the sweet spot into
   * "rusty" over a few idle weeks; this is what makes under-playing a
   * real cost, not just over-playing. */
  decayForm(factor: number): void {
    this.props = {
      ...this.props,
      form: Math.max(0, Math.min(100, Math.round(this.props.form * factor))),
    };
  }

  /** Small, automatic surface-affinity growth from having actually
   * played a match on this surface — called by SimulateMatchUseCase
   * for both participants after every match, alongside
   * applyMatchFatigue (same "direct Player mutator, no policy/ceiling
   * indirection" shape, since like fatigue this is a fixed per-match
   * side effect, not a weekly manager decision the way TrainingFocus
   * itself is). This is the replacement for surface affinity's only
   * previous growth path (the manual TrainingFocus='surface' weekly
   * choice via applyTraining) — the per-attribute training redesign
   * (docs/training-redesign-per-attribute.md) removed surface as a
   * cluster-training axis on the assumption automatic match-play
   * growth would take over, but that replacement was never actually
   * built until now; without this, surface affinity was frozen at its
   * initial value for any manager who never happened to pick that
   * exact weekly focus. Deliberately no retirement guard, unlike
   * applyTraining — matches applyMatchFatigue's own precedent, since a
   * completed match is a fact that already happened, not a request
   * that can be rejected. */
  applyMatchSurfaceGrowth(surface: Surface, gain: number): void {
    this.props = {
      ...this.props,
      attributes: this.props.attributes.trainedOnSurface(surface, gain),
    };
  }

  /** Advances lifecycle stage and age. Called by PlayerAgingService,
   * never invoked directly by application code, so aging rules stay
   * centralized in one place. */
  advanceWeek(newAgeInWeeks: number, newStage: PlayerLifecycleStage, updatedAttributes: PlayerAttributes): void {
    const wasRetired = this.isRetired();
    this.props = {
      ...this.props,
      ageInWeeks: newAgeInWeeks,
      stage: newStage,
      attributes: updatedAttributes,
    };
    if (!wasRetired && newStage === 'retired') {
      this._domainEvents.push({
        type: 'PlayerRetired',
        occurredAt: new Date(),
        payload: { playerId: this.props.id },
      });
    }
  }

  releaseFromManager(): void {
    this.props = { ...this.props, managerId: null };
  }

  /** Refreshes `seasonAgeAnchorWeeks` to this player's just-aged current
   * `ageInWeeks` — called by AdvanceWorldWeekUseCase exactly once per
   * season, at the season-rollover tick, AFTER that tick's aging has
   * already been applied (so it captures the player's age as of week 1
   * of the new season). Never called on an ordinary weekly rollover
   * within a season — see PlayerProps.seasonAgeAnchorWeeks' doc comment
   * for why the anchor must stay frozen the rest of the year. */
  anchorSeasonAge(): void {
    this.props = { ...this.props, seasonAgeAnchorWeeks: this.props.ageInWeeks };
  }

  /** Records a fresh dormant graduation-carryover bonus (called by
   * AdvanceWorldWeekUseCase at a band crossing) or clears one after
   * it's been consumed (called by SimulateMatchUseCase) — same setter
   * either way, since "record a new one" and "clear the old one"
   * aren't different operations from Player's point of view, just
   * different values. Silently overwrites any bonus already sitting
   * here: see PlayerDormantCarryoverBonus's doc comment on why an
   * unconsumed bonus becoming moot at the next crossing is correct,
   * not a bug. */
  setDormantCarryoverBonus(bonus: PlayerDormantCarryoverBonus | null): void {
    this.props = { ...this.props, dormantCarryoverBonus: bonus };
  }

  /** Credits on-site prize money earned from a match or tournament
   * result — called by SimulateMatchUseCase/SimulateDoublesMatchUseCase/
   * SimulateMastersCupMatchUseCase, same "direct Player mutator, no
   * policy indirection" shape as applyMatchFatigue/gainExperience. Adds
   * to BOTH the career total (never reset) and the season total (reset
   * every season by resetSeasonPrizeMoney). Negative or zero amounts
   * are ignored — prize money is only ever earned here. */
  creditPrizeMoney(amount: number): void {
    if (amount <= 0) return;
    this.props = {
      ...this.props,
      careerPrizeMoney: this.props.careerPrizeMoney + amount,
      seasonPrizeMoney: this.props.seasonPrizeMoney + amount,
    };
  }

  /** Zeroes out this player's season prize money at a season rollover
   * (called by AdvanceWorldWeekUseCase) — careerPrizeMoney is
   * untouched, only the season counter resets so it can start
   * accumulating the new season's earnings from zero. */
  resetSeasonPrizeMoney(): void {
    if (this.props.seasonPrizeMoney === 0) return;
    this.props = { ...this.props, seasonPrizeMoney: 0 };
  }

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }
}
