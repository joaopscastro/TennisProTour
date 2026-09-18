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
  weakestTrainableAttribute,
  formModifier,
  FORM_SWEET_SPOT_MIN,
  FORM_SWEET_SPOT_MAX,
  FORM_RUSTY_THRESHOLD,
  FORM_STALE_THRESHOLD,
  fatigueCostForMatch,
} = domain;
// The weekly form decay and daily fatigue recovery live in the application
// layer (applied by AdvanceWorldWeekUseCase, not the domain), so they're
// imported rather than re-hardcoded here — the same "never duplicate a
// production constant" discipline the report's meta block already uses.
const { FORM_WEEKLY_DECAY, FATIGUE_RECOVERY_PER_DAY } = application;
// FATIGUE_RECOVERY_PER_DAY overrides the production daily recovery for this
// run only, so a retuning pass can compare candidate values against real
// trajectory data (same pattern as DIVISOR):
//   for r in 5 4 3 2; do FATIGUE_RECOVERY_PER_DAY=$r node apps/api/scripts/balance-simulation.mjs; done
const FATIGUE_RECOVERY = process.env.FATIGUE_RECOVERY_PER_DAY
  ? Number(process.env.FATIGUE_RECOVERY_PER_DAY)
  : FATIGUE_RECOVERY_PER_DAY;

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
const FORM_LEVELS = [0, 4, 7, 8, 11, 12, 18, 25, 26, 30, 31, 40, 50];
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
];
const formTrajectories = FORM_SCHEDULES.map(({ name, matchesPerWeek, startForm = 0 }) => {
  const player = makeCatchupPlayer(`form-${name}`, { skill: 50, ceilingHeadroom: EXPECTED_CEILING_HEADROOM });
  if (startForm > 0) player.applyMatchForm(startForm);
  const samples = [];
  for (let week = 1; week <= FORM_TRAJECTORY_WEEKS; week++) {
    for (let m = 0; m < matchesPerWeek; m++) player.applyMatchForm(1);
    player.decayForm(FORM_WEEKLY_DECAY);
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
// match, fatigueCostForMatch) and a recovery (per DAY tick —
// FATIGUE_RECOVERY_PER_DAY, applied on all 7 days of the week). Under the
// senior weekly entry cap of 1 tournament, a champion plays at most 5-7
// matches in a week, against 7 × recovery — so whether fatigue EVER
// accumulates depends entirely on that constant's scaling to the day-tick
// cadence. This is the exact "especially their scaling to our day-tick
// cadence" concern docs/rocking-rackets-competitive-analysis.md §5 calls
// the main open balance question. Matches are modelled as consecutive days
// at the start of the week (a real run's shape), each followed by that
// day's recovery — the real Player mutators, not a re-derived recurrence.
const FATIGUE_TRAJECTORY_WEEKS = 52;
const FATIGUE_SCHEDULES = [
  { name: 'idle', matchesPerWeek: 0 },
  { name: 'senior: R1 exit', matchesPerWeek: 1 },
  { name: 'senior: deep run', matchesPerWeek: 3 },
  { name: 'senior: 32-draw title', matchesPerWeek: 5 },
  { name: 'junior: 3 tournaments', matchesPerWeek: 6 },
  { name: 'senior: 128-draw major title', matchesPerWeek: 7 },
];
const FATIGUE_STAMINAS = [50, 20];
const fatigueTrajectories = [];
for (const { name, matchesPerWeek } of FATIGUE_SCHEDULES) {
  for (const stamina of FATIGUE_STAMINAS) {
    const player = makeCatchupPlayer(`fatigue-${name}-${stamina}`, { skill: 50, ceilingHeadroom: EXPECTED_CEILING_HEADROOM });
    const costPerMatch = fatigueCostForMatch(stamina);
    const samples = [];
    for (let week = 1; week <= FATIGUE_TRAJECTORY_WEEKS; week++) {
      for (let day = 1; day <= 7; day++) {
        if (day <= matchesPerWeek) player.applyMatchFatigue(costPerMatch);
        player.recoverFatigue(FATIGUE_RECOVERY);
      }
      if (week > FATIGUE_TRAJECTORY_WEEKS - 4) samples.push(player.fatigue);
    }
    const steadyStateFatigue = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    fatigueTrajectories.push({ schedule: name, matchesPerWeek, stamina, costPerMatch, steadyStateFatigue });
  }
}

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
    rows: formTrajectories,
  },
  fatigueTrajectory: {
    description:
      'Steady-state fatigue a real weekly schedule reaches over a 52-week season, replaying the production per-match cost (fatigueCostForMatch) and per-day recovery (FATIGUE_RECOVERY_PER_DAY, applied on all 7 days) through the real Player mutators. Rows are per schedule × stamina. A senior plays at most 5-7 matches/week (the 1/week entry cap), so this directly tests whether fatigue ever accumulates on the senior tour at all.',
    recoveryPerDay: FATIGUE_RECOVERY,
    rows: fatigueTrajectories,
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

console.log(`\nFatigue trajectory (52-week steady state, recovery ${FATIGUE_RECOVERY}/day):`);
console.log('  schedule                          matches/wk  stamina  cost/match  steady fatigue');
for (const row of fatigueTrajectories) {
  console.log(
    `  ${row.schedule.padEnd(32)}  ${String(row.matchesPerWeek).padStart(10)}  ${String(row.stamina).padStart(7)}  ${String(row.costPerMatch).padStart(10)}  ${String(row.steadyStateFatigue).padStart(14)}`,
  );
}
