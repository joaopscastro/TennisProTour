#!/usr/bin/env node
/**
 * Balance-tuning simulation harness (CLAUDE.md's "Immediate next steps"
 * item 3 / GC-5.2 in docs/implementation-roadmap.md).
 *
 * Unlike playtest.mjs (an API rules-correctness smoke test — bot managers
 * over real HTTP, checking for unexpected 4xx/5xx), this script never
 * touches the HTTP layer or Postgres at all. It imports
 * StatisticalMatchSimulator directly — the same pure domain class
 * StatisticalMatchSimulator.test.ts unit-tests — and runs it thousands of
 * times per bucket with a REAL random source (not a scripted one), to
 * measure the actual win-rate curves `effectiveRating`'s formula produces
 * across a rating-gap matrix, a fatigue matrix, and a surface-affinity-gap
 * matrix. This is the tool GC-5.2 asks for; it establishes a baseline
 * reading, not a retuning of the ~40 PLACEHOLDER constants this touches —
 * that's separate, ongoing work this tool then enables.
 *
 * Usage:
 *   node apps/api/scripts/balance-simulation.mjs
 *   TRIALS_PER_BUCKET=10000 node apps/api/scripts/balance-simulation.mjs
 *
 * DIVISOR overrides StatisticalMatchSimulator's POINT_PROBABILITY_DIVISOR
 * for this run only (the constructor's optional second argument exists
 * specifically for this) — used to compare candidate values against real
 * data during a retuning pass without editing source between runs:
 *   DIVISOR=30 node apps/api/scripts/balance-simulation.mjs
 *   for d in 15 25 35 45 60 80; do
 *     DIVISOR=$d BALANCE_REPORT=balance-report-$d.json \
 *       node apps/api/scripts/balance-simulation.mjs
 *   done
 */
import { writeFileSync } from 'node:fs';
import domain from '@tennis-manager/domain';
import application from '@tennis-manager/application';

const {
  StatisticalMatchSimulator,
  PlayerAttributes,
  Skill,
  SurfaceAffinities,
  PlayerId,
  POINT_PROBABILITY_DIVISOR,
  Player,
  StandardTrainingPolicy,
  StandardPlayerDevelopmentPolicy,
  StandardPracticePolicy,
  StandardRankingPointsTable,
  doublesPointsFor,
  sourcedDoublesPointsFor,
  weakestTrainableAttribute,
  formModifier,
  FORM_SWEET_SPOT_MIN,
  FORM_SWEET_SPOT_MAX,
  FORM_RUSTY_THRESHOLD,
  FORM_STALE_THRESHOLD,
  fatigueCostForMatch,
  fatigueRecoveredPerDay,
  FATIGUE_RECOVERY_FRACTION,
  BASE_MATCH_FATIGUE,
  FATIGUE_PENALTY_PER_POINT,
  DoublesPairingService,
  StandardDoublesPairPolicy,
  doublesSideStrength,
  doublesPairStrength,
  orderDoublesFieldFillers,
  PairId,
  TournamentId,
} = domain;
// The weekly form decay lives in the application layer (applied by
// AdvanceWorldWeekUseCase, not the domain), so it's imported rather than
// re-hardcoded here — the same "never duplicate a production constant"
// discipline the report's meta block already uses. The daily fatigue
// recovery formula itself is the domain's (Player.recoverFatigue →
// FatiguePolicy.fatigueRecoveredPerDay, base + fatigue × fraction); the
// FLAT BASE is re-exported through the application layer for the same
// reason it always was.
const { FORM_WEEKLY_DECAY, FATIGUE_RECOVERY_PER_DAY } = application;
// Candidate overrides for this run only, same compare-candidates workflow
// as DIVISOR: the recovery FLAT BASE and FRACTION, the per-match BASE
// cost, and the weekly form decay. Unset = the production constant.
//   for b in 3 4; do for k in 0.05 0.08 0.10; do
//     FATIGUE_RECOVERY_PER_DAY=$b FATIGUE_RECOVERY_FRACTION=$k \
//       node apps/api/scripts/balance-simulation.mjs
//   done; done
const FATIGUE_RECOVERY = process.env.FATIGUE_RECOVERY_PER_DAY
  ? Number(process.env.FATIGUE_RECOVERY_PER_DAY)
  : FATIGUE_RECOVERY_PER_DAY;
const FATIGUE_FRACTION = process.env.FATIGUE_RECOVERY_FRACTION
  ? Number(process.env.FATIGUE_RECOVERY_FRACTION)
  : FATIGUE_RECOVERY_FRACTION;
const FATIGUE_BASE_COST = process.env.FATIGUE_BASE_COST
  ? Number(process.env.FATIGUE_BASE_COST)
  : BASE_MATCH_FATIGUE;
const FORM_DECAY = process.env.FORM_WEEKLY_DECAY ? Number(process.env.FORM_WEEKLY_DECAY) : FORM_WEEKLY_DECAY;

const TRIALS_PER_BUCKET = Number(process.env.TRIALS_PER_BUCKET ?? 3000);
const REPORT_PATH = process.env.BALANCE_REPORT ?? 'balance-report.json';
const DIVISOR = process.env.DIVISOR ? Number(process.env.DIVISOR) : POINT_PROBABILITY_DIVISOR;

/** Real randomness — deliberately NOT a scripted/seeded source, unlike
 * every unit test in StatisticalMatchSimulator.test.ts. The whole point
 * here is an empirical distribution over many independent matches. */
const randomSource = { next: () => Math.random() };
const simulator = new StatisticalMatchSimulator(randomSource, DIVISOR);

function flatAttributes(value, surfaceAffinities = SurfaceAffinities.initial()) {
  return new PlayerAttributes({
    technical: { serve: Skill.of(value), forehand: Skill.of(value), backhand: Skill.of(value), volley: Skill.of(value) },
    physical: { speed: Skill.of(value), stamina: Skill.of(value), strength: Skill.of(value) },
    mental: { consistency: Skill.of(value), clutch: Skill.of(value) },
    surfaceAffinities,
  });
}

function participant(id, { skill = 50, fatigue = 0, form = 0, surfaceAffinities } = {}) {
  return {
    playerId: PlayerId(id),
    fatigue,
    form,
    attributes: flatAttributes(skill, surfaceAffinities),
  };
}

function winRateA(playerA, playerB, surface, trials) {
  let winsA = 0;
  for (let i = 0; i < trials; i++) {
    const { outcome } = simulator.simulate(playerA, playerB, surface);
    if (outcome.winner === playerA.playerId) winsA++;
  }
  return winsA / trials;
}

// --- Bucket 1: rating gap -----------------------------------------------
// Both players share fatigue=0/form=0/flat SurfaceAffinities.initial() and
// play on neutral 'hard' court (all Step-4 surface × attribute weights are
// ×1.0 there), so the ONLY thing that differs is a uniform +gap applied to
// every one of A's technical/physical/mental attributes. Since
// effectiveRating weights those three groups 0.5+0.3+0.2 = 1.0, a uniform
// +gap should translate to almost exactly a +gap effective-rating edge
// (fatigue/form/surface terms cancel identically between A and B) —
// this bucket checks whether that theoretical mapping actually holds once
// point-by-point, set-by-set match structure amplifies it.
const RATING_GAPS = [0, 2, 5, 8, 10, 15, 20, 30, 40, 50];
const ratingGapResults = RATING_GAPS.map((gap) => {
  const playerA = participant('gapA', { skill: 50 + gap });
  const playerB = participant('gapB', { skill: 50 });
  const rate = winRateA(playerA, playerB, 'hard', TRIALS_PER_BUCKET);
  return { gap, winRateA: rate };
});

// --- Bucket 2: fatigue -----------------------------------------------
// Equal skill (50/50), equal form, neutral surface — only A's fatigue
// varies. fatiguePenalty = fatigue * 0.15 in effectiveRating, so this
// bucket checks the actual win-rate cost of playing tired.
const FATIGUE_LEVELS = [0, 10, 20, 30, 40, 60, 80, 100];
const fatigueResults = FATIGUE_LEVELS.map((fatigue) => {
  const playerA = participant('fatA', { skill: 50, fatigue });
  const playerB = participant('fatB', { skill: 50, fatigue: 0 });
  const rate = winRateA(playerA, playerB, 'hard', TRIALS_PER_BUCKET);
  return { fatigueA: fatigue, winRateA: rate };
});

// --- Bucket 3: surface-affinity gap -----------------------------------
// Equal skill, equal fatigue/form — only A's SurfaceAffinities value for
// the played surface varies (B stays at the SurfaceAffinities.initial()
// baseline of 20). Real cap is 60 (SurfaceAffinities.MAX_PER_SURFACE), so
// the gap axis stops there. Surface picked arbitrarily (clay) — the
// mechanism is surface-agnostic, this is just measuring the passive
// affinity bonus term's weight (×0.3 in effectiveRating), not the Step-4
// per-attribute weighting.
const AFFINITY_GAPS = [0, 5, 10, 20, 30, 40, 60];
const SURFACE_FOR_AFFINITY_BUCKET = 'clay';
const affinityGapResults = AFFINITY_GAPS.map((gap) => {
  const affinityA = SurfaceAffinities.of({ clay: Math.min(60, 20 + gap), grass: 20, hard: 20, indoor: 20 });
  const affinityB = SurfaceAffinities.initial();
  const playerA = participant('affA', { skill: 50, surfaceAffinities: affinityA });
  const playerB = participant('affB', { skill: 50, surfaceAffinities: affinityB });
  const rate = winRateA(playerA, playerB, SURFACE_FOR_AFFINITY_BUCKET, TRIALS_PER_BUCKET);
  return { affinityGap: gap, winRateA: rate };
});

// --- Bucket 4: home advantage (single match-level check, not a matrix) --
// Two otherwise IDENTICAL players (equal skill, fatigue, form) — only A
// carries `homeAdvantage: true` (HOME_ADVANTAGE_BONUS, a flat +3 on the
// effective-rating scale). This bucket exists because it's the finding
// that actually drove the divisor retuning: at the original divisor of
// 15, this flat "modest, coin-flip-tilting" bonus alone produced a 91.1%
// match win rate — more decisive than most realistic skill gaps, directly
// contradicting its own doc comment's stated intent. Kept as a permanent
// bucket (not just a one-off measurement) so any future change to either
// HOME_ADVANTAGE_BONUS or POINT_PROBABILITY_DIVISOR gets re-checked
// against this same regression automatically.
const homeAdvantageResult = (() => {
  const playerA = { ...participant('homeA', { skill: 50 }), homeAdvantage: true };
  const playerB = participant('homeB', { skill: 50 });
  const rate = winRateA(playerA, playerB, 'hard', TRIALS_PER_BUCKET);
  return { winRateA: rate };
})();

// --- Bucket 5: roster-gap catch-up (P4 training economy, not raw sim) --
// A real LLM-manager playtest (docs referenced in CLAUDE.md's "Immediate
// next steps") ran 4 managers through 436 combined tournament entries
// with zero titles, and flagged a real, unanswered question: does a
// mediocre STARTING roster (roughly what a free-tier manager actually
// signs off the talent pool — llm-3/llm-5/llm-6's real rosters, ~48 OVR)
// ever become competitive against a strong starting roster (llm-4's real
// senior roster, ~80 OVR), and if so how long does it take? Unlike
// buckets 1-4 (which hold attributes FIXED and measure the sim's
// win-rate curve), this bucket runs the REAL weekly production growth
// math — StandardPlayerDevelopmentPolicy's weekly talent income + match
// XP funding StandardTrainingPolicy's per-attribute deltas through
// Player.applyTraining, exactly what AdvanceWorldWeekUseCase and
// SimulateMatchUseCase do in production — for many simulated weeks, and
// measures the resulting head-to-head win rate at realistic checkpoints.
//
// Both rosters get the SAME talent (50, the distribution's average) and
// the same weekly regimen (train the single weakest trainable attribute
// every week — weakestTrainableAttribute, the identical policy fillOnly
// players already auto-train under in production, and a reasonable stand-
// in for "a manager who trains their worst weakness every week"), so the
// only free variable is starting ability + hidden ceiling — the actual
// "roster quality" gap a real claim produces. Both rosters' physical
// ceilings use MAX_POTENTIAL_HEADROOM's real EXPECTED headroom (22.5 —
// half of PlayerGenerationPolicy's 0-45 uniform roll), NOT a
// tier-dependent headroom: rollPhysicalCeilings anchors headroom to each
// attribute's own CURRENT value and rolls it independently of rarity
// tier (a common player can roll just as big a headroom as an
// exceptional one — see that method's own doc comment on why: "scouting
// value is highest for currently-unimpressive players"). An earlier
// version of this bucket used a much smaller made-up headroom (12) for
// both rosters, which understated how much real headroom a mediocre
// claim can carry — corrected here to the real distribution's average
// rather than an invented pessimistic number.
//
// Each simulated week: (1) weekly talent income is credited
// (weeklyTalentIncome(talent)); (2) each player plays one competitive
// match — against an opponent matched to THEIR OWN current skill, a
// deliberate "you can usually find a fair fixture" assumption so match
// XP reflects genuine competitiveness rather than an arbitrary fixed
// opponent — through the REAL StatisticalMatchSimulator, and the match's
// actual games-won margin funds matchExperience (not a flat XP grant);
// (3) one funded training tick is applied to the weakest attribute. Every
// CATCHUP_CHECKPOINT_WEEKS entry, both players' current OVR and a real
// head-to-head win rate (CATCHUP_TRIALS trials, neutral hard court, equal
// fatigue/form) are recorded. Checkpoints run out to 3 full seasons (156
// weeks), not just 1, because technical attributes are UNCAPPED (no
// ceiling at all — see Player.applyTraining) and only bounded by Skill's
// own 0-100 clamp: any gap in technical ability is, in principle,
// eventually closeable over a long enough horizon even though a single
// season isn't long enough to show it.
// WEEKLY_XP_PER_TALENT / XP_PER_SKILL_POINT overrides — same
// compare-candidate-values-against-real-data workflow as DIVISOR above:
//   WEEKLY_XP_PER_TALENT=0.6 XP_PER_SKILL_POINT=10 node apps/api/scripts/balance-simulation.mjs
const WEEKLY_XP_PER_TALENT = process.env.WEEKLY_XP_PER_TALENT ? Number(process.env.WEEKLY_XP_PER_TALENT) : undefined;
const XP_PER_SKILL_POINT = process.env.XP_PER_SKILL_POINT ? Number(process.env.XP_PER_SKILL_POINT) : undefined;
// BASE_GAIN_YOUTH overrides StandardTrainingPolicy's youth per-session
// gain (default 1.0/week); the other three stages scale with it
// proportionally (same relative gaps: prime 0.6x, decline 0.3x, retired 0).
const BASE_GAIN_YOUTH = process.env.BASE_GAIN_YOUTH ? Number(process.env.BASE_GAIN_YOUTH) : 1.0;
const trainingPolicy = new StandardTrainingPolicy({
  youth: BASE_GAIN_YOUTH,
  prime: BASE_GAIN_YOUTH * 0.6,
  decline: BASE_GAIN_YOUTH * 0.3,
  retired: 0,
});
const developmentPolicy = new StandardPlayerDevelopmentPolicy(WEEKLY_XP_PER_TALENT, XP_PER_SKILL_POINT);
const AVERAGE_TALENT = 50;
const CATCHUP_CHECKPOINT_WEEKS = [13, 26, 52, 104, 156];
const CATCHUP_TRIALS = 2000;
const CATCHUP_YOUTH_AGE_WEEKS = 15 * 52; // matches TALENT_POOL_AGE_RANGE's midpoint
// PlayerGenerationPolicy.MAX_POTENTIAL_HEADROOM is 45, rolled uniformly
// [0, 45] on top of each attribute's own current value — this is the
// distribution's expected value, used deterministically here (a single
// clean reading) rather than re-rolling headroom per trial.
const EXPECTED_CEILING_HEADROOM = 22.5;

function makeCatchupPlayer(id, { skill, ceilingHeadroom }) {
  const ceilings = { speed: skill + ceilingHeadroom, stamina: skill + ceilingHeadroom, strength: skill + ceilingHeadroom };
  return Player.generateFillOnly(
    PlayerId(id),
    id,
    CATCHUP_YOUTH_AGE_WEEKS,
    'youth',
    flatAttributes(skill),
    'BR',
    skill + ceilingHeadroom,
    ceilings,
    AVERAGE_TALENT,
  );
}

function trainOneWeek(player) {
  player.gainExperience(developmentPolicy.weeklyTalentIncome(player.talent));

  const opponent = { playerId: PlayerId('sparring-partner'), fatigue: 0, form: 0, attributes: flatAttributes(player.attributes.overallRating()) };
  const self = { playerId: player.id, fatigue: player.fatigue, form: player.form, attributes: player.attributes };
  const { outcome } = simulator.simulate(self, opponent, 'hard');
  const isWinner = outcome.winner === player.id;
  const loserGames = outcome.setScores.reduce((sum, set) => sum + set.loserGames, 0);
  player.gainExperience(developmentPolicy.matchExperience({ loserGames, isWinner }));

  const focusAttribute = weakestTrainableAttribute(player.attributes);
  player.applyTraining({ kind: 'attribute', attribute: focusAttribute }, trainingPolicy, null, developmentPolicy);
}

const mediocrePlayer = makeCatchupPlayer('mediocre', { skill: 48, ceilingHeadroom: EXPECTED_CEILING_HEADROOM }); // ceiling ~70.5
const strongPlayer = makeCatchupPlayer('strong', { skill: 80, ceilingHeadroom: EXPECTED_CEILING_HEADROOM }); // ceiling ~99 (clamped)

const catchupRows = [];
const maxWeeks = Math.max(...CATCHUP_CHECKPOINT_WEEKS);
for (let week = 1; week <= maxWeeks; week++) {
  trainOneWeek(mediocrePlayer);
  trainOneWeek(strongPlayer);
  if (CATCHUP_CHECKPOINT_WEEKS.includes(week)) {
    const winRateStrong = winRateA(
      { playerId: PlayerId('strong'), fatigue: 0, form: 0, attributes: strongPlayer.attributes },
      { playerId: PlayerId('mediocre'), fatigue: 0, form: 0, attributes: mediocrePlayer.attributes },
      'hard',
      CATCHUP_TRIALS,
    );
    catchupRows.push({
      week,
      mediocreOverall: Math.round(mediocrePlayer.attributes.overallRating()),
      strongOverall: Math.round(strongPlayer.attributes.overallRating()),
      winRateStrongOverMediocre: winRateStrong,
    });
  }
}

// --- Bucket 6: form (match rhythm) -> win rate --------------------------
// Two otherwise IDENTICAL players (equal skill, fatigue 0, neutral hard
// court); only A's `form` varies, against B's fixed form 0 (the most-rusty
// anchor). formModifier is a BAND function, not monotonic — rusty below 8,
// neutral 8-11, +2 sweet spot 12-25, neutral 26-30, stale penalty above 30
// — so this is a curve with a peak, not a gradient. This is the ONE core
// effective-rating modifier the divisor retune never measured (the pass
// re-checked fatigue/home/surface, but form is applied on the same scale
// and was left unmeasured), which is exactly what docs/rocking-rackets-
// competitive-analysis.md §5 flags as the main open balance question.
const FORM_LEVELS = [0, 4, 7, 8, 11, 12, 18, 25, 26, 28, 30, 31, 40, 50];
const formResults = FORM_LEVELS.map((form) => {
  const playerA = participant('formA', { skill: 50, form });
  const playerB = participant('formB', { skill: 50, form: 0 });
  return {
    formA: form,
    modifier: formModifier(form),
    winRateA: winRateA(playerA, playerB, 'hard', TRIALS_PER_BUCKET),
  };
});
// The +2 sweet-spot bonus must actually be the curve's peak, or the band
// labels are lying about what they reward.
const peakFormRow = formResults.reduce((best, row) => (row.winRateA > best.winRateA ? row : best), formResults[0]);
const formPeakInSweetSpot = peakFormRow.formA >= FORM_SWEET_SPOT_MIN && peakFormRow.formA <= FORM_SWEET_SPOT_MAX;

// --- Bucket 7: realistic form trajectory --------------------------------
// Bucket 6 says what a given form VALUE is worth; this says which form
// values a real player actually REACHES. A form value only matters if
// production throughput can sit in the band, so this replays the real
// accrual (+1 per match, SimulateMatchUseCase) and the real weekly decay
// (FORM_WEEKLY_DECAY, AdvanceWorldWeekUseCase) exactly — via the real
// Player.applyMatchForm/decayForm, not a re-derived recurrence — for a full
// season under several realistic schedules. The last 4 samples give the
// steady state. `startForm` seeds a schedule that begins mid-rhythm then
// stops (idle trajectories always start at 0 otherwise, which hides the
// decay behaviour entirely).
const FORM_TRAJECTORY_WEEKS = 52;
const FORM_SCHEDULES = [
  { name: 'idle (never plays)', matchesPerWeek: 0 },
  { name: 'went idle from form 20', matchesPerWeek: 0, startForm: 20 },
  { name: 'senior: first-round exits', matchesPerWeek: 1 },
  { name: 'senior: mid run', matchesPerWeek: 2 },
  { name: 'senior: deep run', matchesPerWeek: 3 },
  { name: 'senior: title run', matchesPerWeek: 5 },
  { name: 'junior: 3 tournaments/week', matchesPerWeek: 6 },
  { name: 'elite: singles + doubles deep runs', matchesPerWeek: 9 },
  { name: 'extreme: both finals at a major', matchesPerWeek: 14 },
];
const formTrajectories = FORM_SCHEDULES.map(({ name, matchesPerWeek, startForm = 0 }) => {
  const player = makeCatchupPlayer(`form-${name}`, { skill: 50, ceilingHeadroom: EXPECTED_CEILING_HEADROOM });
  if (startForm > 0) player.applyMatchForm(startForm);
  const samples = [];
  for (let week = 1; week <= FORM_TRAJECTORY_WEEKS; week++) {
    for (let m = 0; m < matchesPerWeek; m++) player.applyMatchForm(1);
    player.decayForm(FORM_DECAY);
    if (week > FORM_TRAJECTORY_WEEKS - 4) samples.push(player.form);
  }
  const steadyStateForm = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const band =
    steadyStateForm < FORM_RUSTY_THRESHOLD
      ? 'rusty'
      : steadyStateForm >= FORM_SWEET_SPOT_MIN && steadyStateForm <= FORM_SWEET_SPOT_MAX
        ? 'sweet-spot'
        : steadyStateForm > FORM_STALE_THRESHOLD
          ? 'stale'
          : 'neutral';
  return { schedule: name, matchesPerWeek, steadyStateForm, band, modifier: formModifier(steadyStateForm) };
});

// --- Bucket 8: realistic fatigue trajectory -----------------------------
// Bucket 2 measured what a given fatigue VALUE is worth; this measures what
// fatigue real schedules actually produce. Fatigue has BOTH an accrual (per
// match, fatigueCostForMatch) and a recovery (per DAY tick), and as of the
// second fatigue/form pass the recovery is SELF-LIMITING:
// `FATIGUE_RECOVERY_PER_DAY + fatigue × FATIGUE_RECOVERY_FRACTION`, rounded —
// so the more tired a player is the faster they recover, and accrual and
// recovery meet at a finite equilibrium instead of the old fixed drain a
// deep schedule could always out-accrue (which pinned a 5+/week schedule at
// 100 forever). Under the senior weekly entry cap of 1 tournament, a
// champion plays at most 5-7 matches in a week; the point of this bucket is
// to show those schedules now settle at a real, finite fatigue instead of
// the ceiling. Matches are modelled as consecutive days at the start of the
// week (a real run's shape), each followed by that day's recovery — the
// real Player mutators (Player.recoverFatigue applies the domain formula),
// not a re-derived recurrence.
const FATIGUE_TRAJECTORY_WEEKS = 52;
const FATIGUE_SCHEDULES = [
  { name: 'idle', matchesPerWeek: 0 },
  { name: 'senior: R1 exit', matchesPerWeek: 1 },
  { name: 'senior: deep run', matchesPerWeek: 3 },
  { name: 'senior: 32-draw title', matchesPerWeek: 5 },
  { name: 'junior: 3 tournaments', matchesPerWeek: 6 },
  { name: 'senior: 128-draw major title', matchesPerWeek: 7 },
  // The measured agent-season elite loads: a senior at one tournament a
  // week plays singles AND doubles, so deep runs are ~9-14 matches — the
  // volume Batch 4B's second weekly `tour` event made routine.
  { name: 'elite: singles+doubles deep runs', matchesPerWeek: 9 },
  { name: 'elite: 11-match week', matchesPerWeek: 11 },
  { name: 'peak: 14-match week (both finals)', matchesPerWeek: 14 },
];
const FATIGUE_STAMINAS = [50, 20];
const fatigueTrajectories = [];
for (const { name, matchesPerWeek } of FATIGUE_SCHEDULES) {
  for (const stamina of FATIGUE_STAMINAS) {
    const player = makeCatchupPlayer(`fatigue-${name}-${stamina}`, { skill: 50, ceilingHeadroom: EXPECTED_CEILING_HEADROOM });
    const costPerMatch = fatigueCostForMatch(stamina, FATIGUE_BASE_COST);
    const samples = [];
    const peaks = [];
    for (let week = 1; week <= FATIGUE_TRAJECTORY_WEEKS; week++) {
      let weekPeak = 0;
      // A real week's matches are spread across its days (a 14-match week
      // is two per day, not one a day for 14 days) — identical to the old
      // one-per-day shape for every schedule of 7 or fewer.
      const perDay = Math.floor(matchesPerWeek / 7);
      const extra = matchesPerWeek % 7;
      for (let day = 1; day <= 7; day++) {
        const matchesToday = perDay + (day <= extra ? 1 : 0);
        for (let m = 0; m < matchesToday; m++) player.applyMatchFatigue(costPerMatch);
        // Replays the production recovery formula through the real Player
        // mutator (Player.applyMatchFatigue), with the candidate fraction
        // in place of the production one — the same override seam as the
        // flat base.
        player.applyMatchFatigue(-fatigueRecoveredPerDay(player.fatigue, FATIGUE_RECOVERY, FATIGUE_FRACTION));
        if (player.fatigue > weekPeak) weekPeak = player.fatigue;
      }
      if (week > FATIGUE_TRAJECTORY_WEEKS - 4) {
        samples.push(player.fatigue);
        peaks.push(weekPeak);
      }
    }
    const steadyStateFatigue = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    // The mid-week peak is the number a manager actually SEES while a deep
    // run is happening; the end-of-week value is where a Monday player
    // starts. Both are finite now — neither approaches 100.
    const peakFatigue = Math.round(peaks.reduce((a, b) => a + b, 0) / peaks.length);
    fatigueTrajectories.push({ schedule: name, matchesPerWeek, stamina, costPerMatch, steadyStateFatigue, peakFatigue });
  }
}

// --- Bucket 9: doubles field strength (the padding fix) -----------------
// The measured problem (docs/balance-tuning-report.md's doubles section):
// in the 52-week agent season two persistent manager pairs (combined
// strength ~125-132 on the effective-rating scale) won 29-30 tour doubles
// titles each against fields that were largely filler — the padding
// selection drew from RANKED free agents and then SHUFFLED everyone
// together, so the pool's strongest free agents were diluted into one
// weak average pair. This bucket models the real end-of-season free-agent
// pool (measured on tennis_manager_agents3: OVR median ~44, p90 ~65, max
// ~89; doubles avg ~42; composite strength median ~70) with a
// deterministic seeded source, then runs the REAL production padding path
// twice on the SAME pool:
//   BEFORE: pool-order selection + the legacy random-shuffle pairing
//   AFTER:  orderDoublesFieldFillers (cap = the manager pair) + the
//           strength-aware pairing in DoublesPairingService
// Each field is reported as average/best padded-pair strength vs the
// manager pair, the manager pair's head-to-head win rate against the best
// padded pair, and a real 16-pair bracket replay (StatisticalMatchSimulator
// + StandardDoublesPairPolicy) giving the manager pair's title probability.
const DOUBLES_FIELD_DRAW_SIZE = 16; // pairs
const DOUBLES_FIELD_POOL_SIZE = 200;
const DOUBLES_FIELD_BUILDS = 10;
const DOUBLES_FIELD_BRACKET_TRIALS = 50;
const DOUBLES_FIELD_H2H_TRIALS = 1000;

function doublesPlayer(id, ovr, doublesSkill, affinityHard = 20) {
  return {
    playerId: PlayerId(id),
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(ovr), forehand: Skill.of(ovr), backhand: Skill.of(ovr), volley: Skill.of(ovr) },
      physical: { speed: Skill.of(ovr), stamina: Skill.of(ovr), strength: Skill.of(ovr) },
      mental: { consistency: Skill.of(ovr), clutch: Skill.of(ovr) },
      doubles: Skill.of(doublesSkill),
      surfaceAffinities: SurfaceAffinities.of({ clay: affinityHard, grass: affinityHard, hard: affinityHard, indoor: affinityHard }),
    }),
  };
}

function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// The manager pair mirrors the measured m4 pair on tennis_manager_agents3
// (OVR ~84/~84, doubles ~32/~30, affinity_hard 60, chemistry 100 —
// strength ~125 on neutral hard, matching the real 124.9).
const doublesManagerA = doublesPlayer('doubles-mgr-a', 84, 31, 60);
const doublesManagerB = doublesPlayer('doubles-mgr-b', 84, 32, 60);
const DOUBLES_MANAGER_STRENGTH = doublesPairStrength(doublesManagerA.attributes, doublesManagerB.attributes, 'hard', 100);

const doublesPoolRandom = makeSeededRandom(20260928);
// Piecewise-linear inverse CDF of the measured end-of-season free-agent
// pool strength on tennis_manager_agents3 (p0 48, p25 64, p50 70, p75 80,
// p90 94, p100 132 — the real pool fattens at the top because fill-only
// players train every week for seasons). Deriving attributes to hit each
// sampled strength exactly (affinity 60, doubles 50 => flat attributes =
// strength - 38) keeps the bracket replay's effective rating equal to the
// sampled number.
const DOUBLES_POOL_STRENGTH_STOPS = [48, 64, 70, 80, 94, 132];
function sampleDoublesPoolStrength(u) {
  const stops = DOUBLES_POOL_STRENGTH_STOPS;
  const slots = stops.length - 1;
  const x = Math.min(u, 0.999999) * slots;
  const i = Math.floor(x);
  const t = x - i;
  return stops[i] + (stops[i + 1] - stops[i]) * t;
}
const doublesPool = [];
for (let i = 0; i < DOUBLES_FIELD_POOL_SIZE; i++) {
  const sampledStrength = sampleDoublesPoolStrength(doublesPoolRandom());
  doublesPool.push(doublesPlayer(`doubles-fa-${i}`, Math.max(0, sampledStrength - 38), 50, 60));
}
// The pool's own read order (production: youngest-first) — deliberately
// shuffled so it is uncorrelated with strength, modelling the measured
// reality that the old ranked-first pick produced BELOW-average fillers.
const doublesPoolOrder = (() => {
  const items = [...doublesPool];
  const random = makeSeededRandom(7);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
})();

const doublesAttributesById = new Map();
for (const p of [doublesManagerA, doublesManagerB, ...doublesPool]) doublesAttributesById.set(p.playerId, p.attributes);
const doublesStrengthById = new Map(doublesPool.map((p) => [p.playerId, doublesSideStrength(p.attributes, 'hard')]));

const doublesPairingService = new DoublesPairingService();
const doublesPairPolicy = new StandardDoublesPairPolicy();
// The doubles bucket is a REGRESSION bucket — its numbers must be
// reproducible run to run, so it uses its own deterministic source for
// the field shuffle and the match trials (unlike the probability buckets
// above, which deliberately sample the full distribution via
// Math.random).
const doublesRandom = makeSeededRandom(4242);
const doublesSimulator = new StatisticalMatchSimulator({ next: doublesRandom }, DIVISOR);

function buildDoublesField(mode, drawSize = DOUBLES_FIELD_DRAW_SIZE) {
  const fillerCount = drawSize * 2 - 2;
  let selectedIds;
  const pairingInput = {
    tournamentId: TournamentId(`doubles-field-${mode}`),
    entrants: [],
    entryRanking: new Map(),
    persistentPairs: [
      {
        playerA: doublesManagerA.playerId,
        playerB: doublesManagerB.playerId,
        pairId: PairId(`doubles-field-${mode}-manager`),
        chemistry: 100,
      },
    ],
    freeAgentFillers: [],
    drawSize,
    random: { next: doublesRandom },
  };
  if (mode === 'before') {
    // The legacy path: take the pool's own order (the measurement showed
    // the ranked-first pick landed BELOW the pool average) and let the
    // service shuffle everyone together.
    selectedIds = doublesPoolOrder.slice(0, fillerCount).map((p) => p.playerId);
  } else {
    // The new path: cap-aware strength order + strength-aware pairing.
    const ordered = orderDoublesFieldFillers(
      doublesPoolOrder.map((p) => ({ playerId: p.playerId, strength: doublesStrengthById.get(p.playerId) ?? 0 })),
      DOUBLES_MANAGER_STRENGTH,
    );
    selectedIds = ordered.slice(0, fillerCount).map((c) => c.playerId);
    pairingInput.strength = doublesStrengthById;
    pairingInput.fillerEntrants = new Set(selectedIds);
  }
  pairingInput.entrants = [doublesManagerA.playerId, doublesManagerB.playerId, ...selectedIds];
  return doublesPairingService.pair(pairingInput).pairs;
}

function doublesPairStrengthOf(pair) {
  const a = doublesAttributesById.get(pair.playerA);
  const b = doublesAttributesById.get(pair.playerB);
  return doublesPairStrength(a, b, 'hard', pair.chemistry ?? 0);
}

function doublesParticipantFor(pair) {
  const a = { playerId: pair.playerA, fatigue: 0, form: 0, attributes: doublesAttributesById.get(pair.playerA) };
  const b = { playerId: pair.playerB, fatigue: 0, form: 0, attributes: doublesAttributesById.get(pair.playerB) };
  return doublesPairPolicy.compositeParticipant(pair.pairId, a, b, pair.chemistry ?? 0);
}

/** One real 16-pair knockout: a fresh random draw each trial, every match
 * through the real simulator, winner advanced. Returns the manager pair's
 * title rate. */
function doublesManagerTitleRate(pairs, trials) {
  const managerPair = pairs.find((p) => p.persistentPairId !== undefined);
  let titles = 0;
  for (let t = 0; t < trials; t++) {
    let survivors = [...pairs];
    for (let i = survivors.length - 1; i > 0; i--) {
      const j = Math.floor(doublesRandom() * (i + 1));
      [survivors[i], survivors[j]] = [survivors[j], survivors[i]];
    }
    while (survivors.length > 1) {
      const next = [];
      for (let i = 0; i < survivors.length; i += 2) {
        const { outcome } = doublesSimulator.simulate(doublesParticipantFor(survivors[i]), doublesParticipantFor(survivors[i + 1]), 'hard');
        next.push(outcome.winner === survivors[i].pairId ? survivors[i] : survivors[i + 1]);
      }
      survivors = next;
    }
    if (survivors[0].pairId === managerPair.pairId) titles++;
  }
  return titles / trials;
}

function doublesManagerH2HWinRate(managerPair, opponentPair, trials) {
  let wins = 0;
  for (let i = 0; i < trials; i++) {
    const { outcome } = doublesSimulator.simulate(doublesParticipantFor(managerPair), doublesParticipantFor(opponentPair), 'hard');
    if (outcome.winner === managerPair.pairId) wins++;
  }
  return wins / trials;
}

const doublesFieldResults = { before: [], after: [] };
for (const mode of ['before', 'after']) {
  for (let build = 0; build < DOUBLES_FIELD_BUILDS; build++) {
    const pairs = buildDoublesField(mode);
    const managerPair = pairs.find((p) => p.persistentPairId !== undefined);
    const fillerPairs = pairs.filter((p) => p.persistentPairId === undefined);
    const fillerStrengths = fillerPairs.map(doublesPairStrengthOf);
    const bestFillerPair = fillerPairs[fillerStrengths.indexOf(Math.max(...fillerStrengths))];
    doublesFieldResults[mode].push({
      managerPairStrength: doublesPairStrengthOf(managerPair),
      averagePaddedPairStrength: fillerStrengths.reduce((a, b) => a + b, 0) / fillerStrengths.length,
      bestPaddedPairStrength: Math.max(...fillerStrengths),
      managerWinRateVsBestPaddedPair: doublesManagerH2HWinRate(managerPair, bestFillerPair, DOUBLES_FIELD_H2H_TRIALS),
      managerTitleRate: doublesManagerTitleRate(pairs, DOUBLES_FIELD_BRACKET_TRIALS),
    });
  }
}
const averageOf = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
const doublesFieldSummary = {
  before: {
    managerPairStrength: averageOf(doublesFieldResults.before, 'managerPairStrength'),
    averagePaddedPairStrength: averageOf(doublesFieldResults.before, 'averagePaddedPairStrength'),
    bestPaddedPairStrength: averageOf(doublesFieldResults.before, 'bestPaddedPairStrength'),
    managerWinRateVsBestPaddedPair: averageOf(doublesFieldResults.before, 'managerWinRateVsBestPaddedPair'),
    managerTitleRate: averageOf(doublesFieldResults.before, 'managerTitleRate'),
  },
  after: {
    managerPairStrength: averageOf(doublesFieldResults.after, 'managerPairStrength'),
    averagePaddedPairStrength: averageOf(doublesFieldResults.after, 'averagePaddedPairStrength'),
    bestPaddedPairStrength: averageOf(doublesFieldResults.after, 'bestPaddedPairStrength'),
    managerWinRateVsBestPaddedPair: averageOf(doublesFieldResults.after, 'managerWinRateVsBestPaddedPair'),
    managerTitleRate: averageOf(doublesFieldResults.after, 'managerTitleRate'),
  },
};

// --- Bucket 10: practice ladder contribution (the weekly bound) ----------
// The measured season-4 problem: practice paid +15 ladder per session,
// once per player per game day, with NO weekly cap — up to 105/week/player
// for a day-and-a-half of clicks, fatigue-negative overall at the current
// recovery, and invisible in the digest. Three consecutive agent seasons
// called it "exploit-shaped, not a choice"; one agent lost ~2,300 ladder
// points to not knowing about it. The fix bounds the LADDER credit to the
// first `ladderSessionsPerWeek` sessions a player practises in a week
// (development XP and fatigue are unchanged). This row replays both rules
// through the REAL policy for 1..7 sessions/week (7 = the day-clock
// maximum).
const practicePolicy = new StandardPracticePolicy();
const PRACTICE_SESSION_COUNTS = [1, 2, 3, 4, 5, 6, 7];
const practiceLadderRows = PRACTICE_SESSION_COUNTS.map((sessionsThisWeek) => {
  let ladderBefore = 0;
  let ladderAfter = 0;
  for (let session = 0; session < sessionsThisWeek; session++) {
    // The pre-fix constant: StandardPracticePolicy.ladderPoints() (15),
    // flat and uncapped.
    ladderBefore += 15;
    ladderAfter += practicePolicy.ladderPointsForSession(session);
  }
  return {
    sessionsThisWeek,
    ladderBefore,
    ladderAfter,
    ladderGivenUp: ladderBefore - ladderAfter,
  };
});

// --- Bucket 11: singles vs doubles entry value at the same tier -----------
// The measured season-4 problem: doubles earned 1.3-3.1x the singles
// points per entry (champion: 2,506 vs 800) because a manager plays BOTH
// draws of the same event with no extra weekly-cap cost, both partners'
// awards credit the same ladder, and the cap-aware padded field is
// weaker than a singles field of individual players. The chosen fix
// scales the SOURCED senior doubles table by DOUBLES_POINTS_PARITY_FACTOR
// (0.5) — see docs/balance-tuning-report.md. This bucket measures the
// expected manager ladder points per entry under the REAL award path:
//   - singles: a real draw (32/64/128) of individually-sampled free
//     agents (the measured season-4 OVR percentiles) vs the manager's
//     84-OVR player, points awarded per match reached
//     (StandardRankingPointsTable.pointsFor);
//   - doubles: the production cap-aware padded field at the matching
//     doubles draw size (16/32/64 pairs), awarding BOTH partners'
//     doublesPointsFor per match (before = the raw sourced table,
//     after = the parity-scaled one).
// Deterministic seeded source so the rows are reproducible run to run.
const SINGLES_POOL_OVR_STOPS = [37.8, 41.5, 44.1, 48.4, 67.7, 90.6]; // measured on tennis_manager_agents4 free agents
const ENTRY_VALUE_POOL_SIZE = 300;
const ENTRY_VALUE_TRIALS = 120;
const ENTRY_VALUE_TIERS = [
  { tier: 'futures', singlesDraw: 32, doublesDraw: 16 },
  { tier: 'challenger', singlesDraw: 32, doublesDraw: 16 },
  { tier: 'tour', singlesDraw: 64, doublesDraw: 32 },
  { tier: 'major', singlesDraw: 128, doublesDraw: 64 },
];
const pointsTable = new StandardRankingPointsTable();
const entryValueRandom = makeSeededRandom(20260929);

function sampleFromStops(stops, u) {
  const slots = stops.length - 1;
  const x = Math.min(u, 0.999999) * slots;
  const i = Math.floor(x);
  const t = x - i;
  return stops[i] + (stops[i + 1] - stops[i]) * t;
}

const singlesPool = [];
for (let i = 0; i < ENTRY_VALUE_POOL_SIZE; i++) {
  singlesPool.push(doublesPlayer(`entry-singles-fa-${i}`, Math.max(0, sampleFromStops(SINGLES_POOL_OVR_STOPS, entryValueRandom())), 50, 60));
}
const entrySinglesManager = doublesPlayer('entry-singles-mgr', 84, 50, 60);
const singlesAttributesById = new Map([[entrySinglesManager.playerId, entrySinglesManager.attributes], ...singlesPool.map((p) => [p.playerId, p.attributes])]);

function shuffle(list) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(entryValueRandom() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** One real singles entry: a fresh unseeded 32/64/128 draw, every match
 * through the real simulator. Returns the manager's expected ladder
 * points (sum of StandardRankingPointsTable per match reached) and
 * matches played. */
function playSinglesEntry(tier, drawSize) {
  const field = shuffle([
    { playerId: entrySinglesManager.playerId, fatigue: 0, form: 0, attributes: entrySinglesManager.attributes },
    ...shuffle(singlesPool)
      .slice(0, drawSize - 1)
      .map((p) => ({ playerId: p.playerId, fatigue: 0, form: 0, attributes: p.attributes })),
  ]);
  let roundsWon = 0;
  let points = 0;
  let matches = 0;
  let survivors = field;
  while (survivors.length > 1) {
    const next = [];
    for (let i = 0; i < survivors.length; i += 2) {
      const a = survivors[i];
      const b = survivors[i + 1];
      const { outcome } = simulator.simulate(a, b, 'hard');
      const winner = outcome.winner === a.playerId ? a : b;
      const loser = outcome.winner === a.playerId ? b : a;
      next.push(winner);
      if (winner.playerId === entrySinglesManager.playerId) {
        matches++;
        roundsWon++;
        points += pointsTable.pointsFor(tier, roundsWon);
      }
      if (loser.playerId === entrySinglesManager.playerId) matches++;
    }
    survivors = next;
  }
  return { points, matches };
}

/** One real doubles entry via the production padding path, awarding BOTH
 * partners' points per match reached — raw (before) and parity-scaled
 * (after) from the SAME match outcomes. */
function playDoublesEntry(tier, drawSize) {
  const pairs = buildDoublesField('after', drawSize);
  const managerPair = pairs.find((p) => p.persistentPairId !== undefined);
  let roundsWon = 0;
  let raw = 0;
  let awarded = 0;
  let matches = 0;
  let survivors = shuffle(pairs);
  while (survivors.length > 1) {
    const next = [];
    for (let i = 0; i < survivors.length; i += 2) {
      const a = survivors[i];
      const b = survivors[i + 1];
      const { outcome } = doublesSimulator.simulate(doublesParticipantFor(a), doublesParticipantFor(b), 'hard');
      const winner = outcome.winner === a.pairId ? a : b;
      const loser = outcome.winner === a.pairId ? b : a;
      next.push(winner);
      if (winner.pairId === managerPair.pairId) {
        matches++;
        roundsWon++;
        // Both partners are the manager's players, so BOTH awards credit
        // the same ladder (the measured double-credit structure).
        raw += sourcedDoublesPointsFor(tier, roundsWon, 0) * 2;
        awarded += doublesPointsFor(tier, roundsWon, 0) * 2;
      }
      if (loser.pairId === managerPair.pairId) matches++;
    }
    survivors = next;
  }
  return { raw, awarded, matches };
}

const entryValueRows = ENTRY_VALUE_TIERS.map(({ tier, singlesDraw, doublesDraw }) => {
  let singlesPoints = 0;
  let singlesMatches = 0;
  let doublesRaw = 0;
  let doublesAwarded = 0;
  let doublesMatches = 0;
  for (let trial = 0; trial < ENTRY_VALUE_TRIALS; trial++) {
    const singlesEntry = playSinglesEntry(tier, singlesDraw);
    singlesPoints += singlesEntry.points;
    singlesMatches += singlesEntry.matches;
    const doublesEntry = playDoublesEntry(tier, doublesDraw);
    doublesRaw += doublesEntry.raw;
    doublesAwarded += doublesEntry.awarded;
    doublesMatches += doublesEntry.matches;
  }
  const singlesPerEntry = singlesPoints / ENTRY_VALUE_TRIALS;
  const doublesPerEntryBefore = doublesRaw / ENTRY_VALUE_TRIALS;
  const doublesPerEntryAfter = doublesAwarded / ENTRY_VALUE_TRIALS;
  return {
    tier,
    singlesDraw,
    doublesDraw,
    singlesPerMatch: singlesMatches > 0 ? singlesPoints / singlesMatches : 0,
    singlesPerEntry,
    doublesPerMatchBefore: doublesMatches > 0 ? doublesRaw / doublesMatches : 0,
    doublesPerMatchAfter: doublesMatches > 0 ? doublesAwarded / doublesMatches : 0,
    doublesPerEntryBefore,
    doublesPerEntryAfter,
    doublesShareBefore: singlesPerEntry + doublesPerEntryBefore > 0 ? doublesPerEntryBefore / (singlesPerEntry + doublesPerEntryBefore) : 0,
    doublesShareAfter: singlesPerEntry + doublesPerEntryAfter > 0 ? doublesPerEntryAfter / (singlesPerEntry + doublesPerEntryAfter) : 0,
    ratioBefore: singlesPerEntry > 0 ? doublesPerEntryBefore / singlesPerEntry : 0,
    ratioAfter: singlesPerEntry > 0 ? doublesPerEntryAfter / singlesPerEntry : 0,
  };
});

function isMonotonicNonDecreasing(rows, key) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winRateA < rows[i - 1].winRateA - 0.02) return false; // small tolerance for sampling noise
  }
  return true;
}
const report = {
  meta: {
    runAt: new Date().toISOString(),
    trialsPerBucket: TRIALS_PER_BUCKET,
    pointProbabilityDivisor: DIVISOR,
    // The class defaults (0.3, 18) when no override env var is set —
    // read back via a probe call rather than duplicating the constants
    // here, so this can never drift from what the policy actually used.
    weeklyXpPerTalent: developmentPolicy.weeklyTalentIncome(100) / 100,
    xpPerSkillPoint: developmentPolicy.experienceCostPerSkillPoint(),
    baseGainYouth: BASE_GAIN_YOUTH,
    fatigueRecoveryPerDay: FATIGUE_RECOVERY,
    fatigueRecoveryFraction: FATIGUE_FRACTION,
    fatigueBaseCost: FATIGUE_BASE_COST,
    fatiguePenaltyPerPoint: FATIGUE_PENALTY_PER_POINT,
    formWeeklyDecay: FORM_DECAY,
    formSweetSpot: { min: FORM_SWEET_SPOT_MIN, max: FORM_SWEET_SPOT_MAX },
  },
  ratingGap: {
    description: 'Win rate for A as a uniform skill-attribute gap over B widens, on neutral hard court.',
    rows: ratingGapResults,
    monotonic: isMonotonicNonDecreasing(ratingGapResults),
  },
  fatigue: {
    description: "Win rate for A (equal skill to B) as A's fatigue rises from 0 to 100.",
    rows: fatigueResults,
    // Fatigue should HURT A, so win rate should be non-INCREASING here.
    monotonicNonIncreasing: fatigueResults.every((row, i) => i === 0 || row.winRateA <= fatigueResults[i - 1].winRateA + 0.02),
  },
  surfaceAffinityGap: {
    description: `Win rate for A (equal skill to B) as A's SurfaceAffinities value for ${SURFACE_FOR_AFFINITY_BUCKET} widens over B's baseline of 20.`,
    rows: affinityGapResults,
    monotonic: isMonotonicNonDecreasing(affinityGapResults),
  },
  homeAdvantage: {
    description: 'Match win rate for A (equal skill to B in every other respect) with HOME_ADVANTAGE_BONUS applied — a regression check for the finding that drove the POINT_PROBABILITY_DIVISOR retuning.',
    winRateA: homeAdvantageResult.winRateA,
  },
  rosterGapCatchup: {
    description:
      'Real weekly production growth math (StandardPlayerDevelopmentPolicy + StandardTrainingPolicy via Player.applyTraining), not raw sim: a mediocre-start roster (48 OVR, physical ceilings ~70.5) vs. a strong-start roster (80 OVR, physical ceilings ~99), same talent (50) and same expected ceiling headroom (22.5, PlayerGenerationPolicy\'s real distribution average — headroom is rolled independently of rarity tier), training its weakest attribute every week. Rows are the strong roster\'s match win rate over the mediocre one at each checkpoint, out to 3 seasons.',
    startingOverall: { mediocre: Math.round(48), strong: Math.round(80) },
    rows: catchupRows,
  },
  form: {
    description: "Win rate for A (equal skill to B, both fatigue 0, neutral hard court) as A's form varies, against B's fixed form 0 (most-rusty). formModifier is a band function, so this is a peaked curve, not a gradient — the peak should sit inside the [12,25] sweet spot.",
    rows: formResults,
    peakForm: peakFormRow.formA,
    peakWinRateA: peakFormRow.winRateA,
    peakInSweetSpot: formPeakInSweetSpot,
  },
  formTrajectory: {
    description:
      'Steady-state form a real schedule reaches over a 52-week season, replaying the production accrual (+1/match, SimulateMatchUseCase) and weekly decay (FORM_WEEKLY_DECAY, AdvanceWorldWeekUseCase) through the real Player mutators. Shows whether the sweet spot is reachable at all, and whether an idle player truly decays back to neutral.',
    decay: FORM_DECAY,
    rows: formTrajectories,
  },
  fatigueTrajectory: {
    description:
      'Steady-state fatigue a real weekly schedule reaches over a 52-week season, replaying the production per-match cost (fatigueCostForMatch) and the production SELF-LIMITING per-day recovery (fatigueRecoveredPerDay: base + fatigue × fraction, applied on all 7 days) through the real Player mutators. Rows are per schedule × stamina and carry both the end-of-week value and the mid-week PEAK (the number a manager sees during a deep run). A senior plays at most 5-7 matches/week (the 1/week entry cap); this shows those schedules now settle at a finite equilibrium instead of climbing to the 100 ceiling forever.',
    recoveryPerDay: FATIGUE_RECOVERY,
    recoveryFraction: FATIGUE_FRACTION,
    rows: fatigueTrajectories,
  },
  doublesField: {
    description:
      'Real production padding path run twice on a deterministic pool modelled on the measured end-of-season free-agent distribution (tennis_manager_agents3): BEFORE = pool-order selection + legacy random-shuffle pairing; AFTER = orderDoublesFieldFillers (cap = the manager pair strength) + the strength-aware pairing. managerPairStrength is the padding cap; every padded pair in AFTER is at or below it by construction. managerWinRateVsBestPaddedPair is a real-simulator head-to-head against the field\'s best padded pair; managerTitleRate is a real 16-pair bracket replay (fresh random draw each trial, every match through StatisticalMatchSimulator + StandardDoublesPairPolicy).',
    managerPairStrength: DOUBLES_MANAGER_STRENGTH,
    builds: DOUBLES_FIELD_BUILDS,
    bracketTrials: DOUBLES_FIELD_BRACKET_TRIALS,
    h2hTrials: DOUBLES_FIELD_H2H_TRIALS,
    before: doublesFieldSummary.before,
    after: doublesFieldSummary.after,
  },
  practiceLadder: {
    description:
      'Ladder points a player banks for practising 1..7 times in one game week, BEFORE (flat 15/session, uncapped — up to 105/week) vs AFTER the weekly bound (StandardPracticePolicy: the first ladderSessionsPerWeek=3 sessions pay 15, later sessions that week bank 0). Development XP and fatigue are unchanged in both — practice keeps its training role; only the ladder pump is bounded.',
    rows: practiceLadderRows,
    maxLadderPerWeekBefore: practiceLadderRows[practiceLadderRows.length - 1].ladderBefore,
    maxLadderPerWeekAfter: practiceLadderRows[practiceLadderRows.length - 1].ladderAfter,
  },
  entryValue: {
    description:
      'Expected manager ladder points per tournament entry at each senior tier under the REAL award path, singles vs doubles. Singles: a real unseeded 32/64/128 draw of individually sampled free agents (measured season-4 OVR percentiles 37.8/41.5/44.1/48.4/67.7/90.6) vs an 84-OVR manager player, awarding StandardRankingPointsTable.pointsFor per match reached. Doubles: the production cap-aware padded field (16/32/64 pairs) via buildDoublesField("after"), awarding BOTH partners\' doubles points per match reached — BEFORE = the raw sourced ATP doubles table, AFTER = the table scaled by DOUBLES_POINTS_PARITY_FACTOR (0.5). ratio* = doubles per entry / singles per entry; doublesShare* = the share of a "singles + same-event doubles" week that comes from the doubles half.',
    managerSinglesOverall: 84,
    trials: ENTRY_VALUE_TRIALS,
    rows: entryValueRows,
  },
};

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

console.log(`Balance simulation complete (${TRIALS_PER_BUCKET} trials/bucket, divisor=${DIVISOR}). Report: ${REPORT_PATH}\n`);
console.log('Rating gap -> win rate for A:');
for (const row of ratingGapResults) console.log(`  gap ${String(row.gap).padStart(3)} -> ${(row.winRateA * 100).toFixed(1)}%`);
console.log(`  monotonic: ${report.ratingGap.monotonic}`);

console.log('\nFatigue (A) -> win rate for A:');
for (const row of fatigueResults) console.log(`  fatigue ${String(row.fatigueA).padStart(3)} -> ${(row.winRateA * 100).toFixed(1)}%`);
console.log(`  monotonic (non-increasing): ${report.fatigue.monotonicNonIncreasing}`);

console.log(`\nSurface affinity gap (${SURFACE_FOR_AFFINITY_BUCKET}, A) -> win rate for A:`);
for (const row of affinityGapResults) console.log(`  gap ${String(row.affinityGap).padStart(2)} -> ${(row.winRateA * 100).toFixed(1)}%`);
console.log(`  monotonic: ${report.surfaceAffinityGap.monotonic}`);

console.log(`\nHome advantage (equal skill, A has HOME_ADVANTAGE_BONUS) -> match win rate for A:`);
console.log(`  ${(homeAdvantageResult.winRateA * 100).toFixed(1)}%`);

console.log('\nRoster-gap catch-up (mediocre 48 OVR/ceiling~70.5 vs. strong 80 OVR/ceiling~99, weakest-attribute training weekly):');
console.log('  week  mediocre OVR  strong OVR  strong win rate over mediocre');
for (const row of catchupRows) {
  console.log(
    `  ${String(row.week).padStart(4)}  ${String(row.mediocreOverall).padStart(12)}  ${String(row.strongOverall).padStart(10)}  ${(row.winRateStrongOverMediocre * 100).toFixed(1)}%`,
  );
}

console.log('\nForm (A) -> win rate for A (B fixed at form 0):');
for (const row of formResults) {
  console.log(`  form ${String(row.formA).padStart(3)} (modifier ${row.modifier >= 0 ? '+' : ''}${row.modifier.toFixed(1)}) -> ${(row.winRateA * 100).toFixed(1)}%`);
}
console.log(`  peak at form ${peakFormRow.formA} (${(peakFormRow.winRateA * 100).toFixed(1)}%), inside the sweet spot: ${formPeakInSweetSpot}`);

console.log('\nForm trajectory (52-week steady state by schedule):');
console.log('  schedule                          matches/wk  steady form  band');
for (const row of formTrajectories) {
  console.log(
    `  ${row.schedule.padEnd(32)}  ${String(row.matchesPerWeek).padStart(10)}  ${String(row.steadyStateForm).padStart(11)}  ${row.band}`,
  );
}

console.log(`\nFatigue trajectory (52-week steady state, recovery ${FATIGUE_RECOVERY}/day + ${FATIGUE_FRACTION}×fatigue — self-limiting):`);
console.log('  schedule                          matches/wk  stamina  cost/match  end-of-week  peak');
for (const row of fatigueTrajectories) {
  console.log(
    `  ${row.schedule.padEnd(32)}  ${String(row.matchesPerWeek).padStart(10)}  ${String(row.stamina).padStart(7)}  ${String(row.costPerMatch).padStart(10)}  ${String(row.steadyStateFatigue).padStart(11)}  ${String(row.peakFatigue).padStart(4)}`,
  );
}

console.log(`\nDoubles field strength (manager pair ${DOUBLES_MANAGER_STRENGTH.toFixed(1)} on the effective-rating scale; ${DOUBLES_FIELD_DRAW_SIZE}-pair draw, ${DOUBLES_FIELD_BUILDS} builds × ${DOUBLES_FIELD_BRACKET_TRIALS} bracket replays):`);
console.log('  mode    avg padded pair  best padded pair  manager H2H vs best  manager title rate');
for (const mode of ['before', 'after']) {
  const s = doublesFieldSummary[mode];
  console.log(
    `  ${mode.padEnd(6)}  ${s.averagePaddedPairStrength.toFixed(1).padStart(15)}  ${s.bestPaddedPairStrength.toFixed(1).padStart(16)}  ${(s.managerWinRateVsBestPaddedPair * 100).toFixed(1).padStart(19)}%  ${(s.managerTitleRate * 100).toFixed(1).padStart(17)}%`,
  );
}

console.log(`\nPractice ladder contribution per player per week (bounded to ${practicePolicy.ladderSessionsPerWeek()} paid sessions):`);
console.log('  sessions  before  after  given up');
for (const row of practiceLadderRows) {
  console.log(
    `  ${String(row.sessionsThisWeek).padStart(8)}  ${String(row.ladderBefore).padStart(6)}  ${String(row.ladderAfter).padStart(5)}  ${String(row.ladderGivenUp).padStart(8)}`,
  );
}

console.log(`\nSingles vs doubles entry value (expected manager ladder points per entry; ${ENTRY_VALUE_TRIALS} seeded draws each):`);
console.log('  tier        draw(S/D)   singles/entry  doubles/entry before  after  ratio before  after');
for (const row of entryValueRows) {
  console.log(
    `  ${row.tier.padEnd(10)}  ${String(`${row.singlesDraw}/${row.doublesDraw}`).padStart(9)}  ${row.singlesPerEntry.toFixed(0).padStart(13)}  ${row.doublesPerEntryBefore.toFixed(0).padStart(20)}  ${row.doublesPerEntryAfter.toFixed(0).padStart(5)}  ${row.ratioBefore.toFixed(2).padStart(12)}  ${row.ratioAfter.toFixed(2).padStart(5)}`,
  );
}
