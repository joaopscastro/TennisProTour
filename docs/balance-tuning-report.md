# Balance-tuning report

Closes CLAUDE.md's "Immediate next steps" item 3 / GC-5.2
(`docs/implementation-roadmap.md`). This doc originally recorded a
baseline reading only ("no bulk simulation sample, no statistical
validation... no recorded methodology" — the tool-building pass). It now
also records the actual retuning pass that used that tool: a real
constant changed in production, not just measured.

## Methodology

`apps/api/scripts/balance-simulation.mjs` imports
`StatisticalMatchSimulator` directly from `@tennis-manager/domain` — pure
domain logic, no HTTP, no Postgres, no `apps/api` server needed (unlike
`playtest.mjs`, an API rules-correctness smoke test over real HTTP,
unrelated to statistical balance). It runs the real simulator with a
**real random source** (`Math.random()`, not a scripted
`ScriptedRandomSource` like every unit test uses) thousands of times per
bucket, aggregating the empirical win rate.

```
node apps/api/scripts/balance-simulation.mjs
TRIALS_PER_BUCKET=10000 node apps/api/scripts/balance-simulation.mjs
```

It writes `balance-report.json` (repo root, same convention as
`playtest-report.json`) and prints a console summary.

Four buckets, each holding every variable but one constant between the
two participants so the isolated effect is unambiguous:

1. **Rating gap** (`ratingGap`) — neutral `hard` court (every Step-4
   surface × attribute weight is ×1.0 there), fatigue/form 0 for both.
   Player A's technical/physical/mental attributes are uniformly raised
   by `gap` over player B's flat 50 baseline.
2. **Fatigue** (`fatigue`) — equal skill, equal form, neutral surface;
   only A's `fatigue` (0-100) varies against B's fixed 0.
3. **Surface-affinity gap** (`surfaceAffinityGap`) — equal skill,
   equal fatigue/form; only A's `SurfaceAffinities` value for the played
   surface (clay) varies over B's baseline of 20, up to the real game cap
   of 60.
4. **Home advantage** (`homeAdvantage`) — two otherwise IDENTICAL players
   (equal skill/fatigue/form); only A carries `homeAdvantage: true`
   (`HOME_ADVANTAGE_BONUS`, a flat +3). Added during the retuning pass
   below — see why.

## The retuning pass: what changed

`StatisticalMatchSimulator`'s `pointWinProbabilityA = 1 / (1 +
Math.exp(-ratingGap / D))` had `D` hardcoded inline as `15`. It's now the
named, exported constant `POINT_PROBABILITY_DIVISOR`, retuned to **80**,
and the simulator's constructor takes an optional second argument to
override it — specifically so this script (and any future retuning pass)
can compare candidate values against real data instead of guessing:

```
DIVISOR=60 node apps/api/scripts/balance-simulation.mjs
for d in 15 25 35 45 60 80 100 130; do
  DIVISOR=$d BALANCE_REPORT=balance-report-$d.json \
    node apps/api/scripts/balance-simulation.mjs
done
```

### Before (D=15, the original baseline reading)

| Rating gap | Win rate A | Fatigue A | Win rate A | Affinity gap | Win rate A |
|---|---|---|---|---|---|
| 0 | 49.3% | 0 | 49.1% | 0 | 50.4% |
| 2 | 80.7% | 10 | 25.4% | 5 | 73.6% |
| 5 | 98.6% | 20 | 9.5% | 10 | 90.9% |
| 8 | 100.0% | 30 | 2.0% | 20 | 99.5% |
| 10-50 | 100.0% | 40-100 | 0.5%-0.0% | 30-60 | 100.0% |

**Home advantage, measured for the first time during this pass**: two
IDENTICAL players, only A gets the flat +3 `HOME_ADVANTAGE_BONUS` (whose
own doc comment describes it as "modest... enough to tilt a coin-flip,
never enough to override a genuine skill gap") — **91.1% match win rate
for A**. This was the single most striking finding of the whole pass: a
bonus explicitly designed to be minor was, in practice, more decisive
than almost any realistic skill gap in the game. That contradiction —
not just the saturating curves — is what made this an actual bug in the
tuning, not merely "needs polish."

### Why: the root cause

`pointWinProbabilityA` is a sigmoid applied **per point**, and a best-of-3
match plays out dozens of independent points across multiple games and
sets. Even a small per-point edge compounds relentlessly — the
per-point formula was clearly tuned by eyeballing a single point in
isolation (a home player winning 55% of individual points sounds
reasonable), never by checking what that edge does once compounded across
a full match. `D=15` made this compounding especially punishing: a
uniform 5-point rating gap (out of 100) turned a 55/45 point split into a
98.6% match blowout.

### Choosing the new value

Eight candidate divisors (15, 25, 35, 45, 60, 80, 100, 130) were run
through all four buckets. Selected criteria: a modest rating gap (~5
points) should be a clear-but-winnable favorite (roughly high 50s/60s, not
90%+); a real gap (10-20 points) should be a strong favorite without being
a lock (roughly 70s-90s%); the home-advantage bonus should land closer to
its own stated intent (a real, felt edge, not a de facto sure thing).
**D=80** was the best fit across all four buckets simultaneously — no
single-bucket value worked in isolation, since every additive term in
`effectiveRating` (fatigue penalty, surfaceBonus, HOME_ADVANTAGE_BONUS,
the form modifier, CHEMISTRY_BONUS_PER_POINT) shares this one divisor.

### After (D=80, the retuned production value — 8,000 trials/bucket)

| Rating gap | Win rate A | Fatigue A | Win rate A | Affinity gap | Win rate A |
|---|---|---|---|---|---|
| 0 | 49.8% | 0 | 50.3% | 0 | 50.0% |
| 2 | 57.1% | 10 | 45.0% | 5 | 54.7% |
| 5 | 66.3% | 20 | 39.9% | 10 | 59.1% |
| 8 | 75.0% | 30 | 35.5% | 20 | 70.6% |
| 10 | 79.8% | 40 | 29.3% | 30 | 77.8% |
| 15 | 90.5% | 60 | 22.5% | 40 | 83.6% |
| 20 | 95.1% | 80 | 15.3% | 60 | 84.4% |
| 30-50 | 99.1%-100.0% | 100 | 10.5% | — | — |

**Home advantage, after retuning: 59.5%** — a real, felt edge (a home
player is clearly favored) without being anywhere close to decisive,
finally matching the bonus's own stated design intent instead of
contradicting it.

Every curve stayed monotonic in the correct direction (checked
automatically by the script, with a small tolerance for sampling noise).
Fatigue in particular went from "a near-death sentence past 30 points" to
"a real, gradual cost that still leaves a meaningful chance to win even at
high fatigue" — closer to how fatigue should feel in a management sim
where a manager is making a real risk/reward call about resting a player.

### What this pass did and did not do

- **Built and applied**: `POINT_PROBABILITY_DIVISOR` extracted to a named
  constant, retuned from 15 to 80 in production
  (`StatisticalMatchSimulator.ts`), a permanent `homeAdvantage` regression
  bucket added to the simulation script, the one dependent unit test
  (`StatisticalMatchSimulator.test.ts`'s home-advantage coin-flip
  demonstration) updated to the new sigmoid threshold, full domain/
  application/api/worker suites re-verified green (328/197/75/8).
- **Not done**: retuning the other ~35+ PLACEHOLDER constants this pass
  didn't touch (aging thresholds, `StandardRankingPointsTable`'s point
  values, the training-redesign deltas, `DIRECT_ACCEPTANCE_CUTOFF`, etc.)
  — those don't feed `pointWinProbabilityA`'s sigmoid and are unrelated to
  this specific fix. `POINT_PROBABILITY_DIVISOR` is still explicitly
  flagged PLACEHOLDER: 80 is an informed value from real simulation data,
  not a final balanced one — revisit with this same tool (the divisor
  override exists specifically for this) if a future pass wants to move
  it further.

## Roster-gap catch-up (CLAUDE.md's "Immediate next steps" item 11 /
## GC-5.2's remaining open question)

### The question

A real 8-agent LLM-manager playtest (52+ game-weeks, see the session's
production-readiness assessment) produced 436 combined tournament entries
across four managers and zero titles. That's a real signal, but not yet a
diagnosis — it could mean starting-roster quality is a permanent
handicap, training is too slow to matter, or it's just normal variance at
these sample sizes. This section investigates it the same way the
divisor retune did: build the measurement using the REAL production
growth math, don't guess.

### The tool: a new "roster-gap catch-up" bucket

`apps/api/scripts/balance-simulation.mjs` gained a fifth bucket that,
unlike the first four (which hold attributes fixed and read off the raw
sim's win-rate curve), runs the actual weekly production economy —
`StandardPlayerDevelopmentPolicy`'s weekly talent income + match XP,
funding `StandardTrainingPolicy`'s per-attribute deltas through the real
`Player.applyTraining` — for up to 156 simulated weeks (3 seasons), and
measures the resulting head-to-head win rate at checkpoints. Two
players: a "mediocre" start (48 OVR, matching the real rosters several
playtest agents actually signed) and a "strong" start (80 OVR, matching
the playtest's best-performing agent's real roster), same talent (50),
each training its own single weakest trainable attribute every week —
the same policy fillOnly players already auto-train under in production,
and a reasonable stand-in for "a manager who trains their worst weakness
every week."

**A real mistake, caught and corrected before the final reading**: the
bucket's first draft gave both rosters a made-up, small physical-ceiling
headroom (12 points) modeled on nothing in particular. Reading
`PlayerGenerationPolicy.rollPhysicalCeilings` (and its own doc comment)
showed the REAL headroom is `MAX_POTENTIAL_HEADROOM` (45), rolled
uniformly and — this is the important part — **independently of rarity
tier**: "a 'common' player can still roll a big headroom... scouting
value is highest for currently-unimpressive players." A mediocre-tier
claim can carry just as much headroom as an exceptional one; the made-up
12-point figure understated the mediocre roster's real upside and would
have made the finding below look more pessimistic than the actual game
economy supports. Fixed to use the distribution's expected value (22.5)
for both rosters before drawing any conclusion from the results.

Also added, for this and future tuning passes, the same
compare-candidates-against-real-data instrumentation the divisor already
has: optional constructor overrides on `StandardPlayerDevelopmentPolicy`
(`weeklyXpPerTalentOverride`, `xpPerSkillPointOverride`) and
`StandardTrainingPolicy` (a full `BASE_GAIN` record override), all
defaulting to the unchanged production constants for every existing
caller.

### The finding

At every constant combination tried — the baseline (`WEEKLY_XP_PER_TALENT
0.3`, `XP_PER_SKILL_POINT 18`, youth `BASE_GAIN 1.0`), a much more
generous XP economy (rate 1.5, cost 3), and an aggressive 3x-5x training
rate — the **relative gap never meaningfully closes**. The strong roster
keeps a ≥99% match win rate over the mediocre one from week 13 all the
way out to week 156 (3 full seasons), even though both rosters' OVR do
visibly grow over that time (baseline: mediocre 48→61, strong 80→93 by
week 156; aggressive settings: mediocre 48→66, strong 80→96).

The reason is structural, not a tuning-value problem: every one of the
three constants this pass tried scales training speed for **both**
rosters equally. A faster economy makes the mediocre roster grow faster
in absolute terms, but it makes the strong roster grow faster by almost
exactly the same amount at the same time (same policy, same weekly
regimen, similar available headroom) — so the ABSOLUTE gap between them
stays roughly constant no matter how the dial is turned, and a ~30+ point
rating gap is already a near-lock under bucket 1's own curve (a 30-point
gap alone wins 99%+ of matches at the retuned divisor). No combination of
`WEEKLY_XP_PER_TALENT`, `XP_PER_SKILL_POINT`, or training's `BASE_GAIN`
can fix a problem that isn't actually about training SPEED.

### What this pass did and did not do

- **Built**: the roster-gap catch-up bucket (real production growth math,
  not raw sim), the headroom-modeling correction described above, and the
  constructor-override instrumentation on both development-economy
  policies for future tuning passes — all additive, all defaulting to
  unchanged production behavior. Domain suite stayed at 329 (unchanged —
  the override defaults are byte-identical to the pre-existing private
  constants), full monorepo `tsc --build --force` clean.
- **Explicitly NOT done, because the data doesn't support it**: retuning
  `WEEKLY_XP_PER_TALENT`, `XP_PER_SKILL_POINT`, or `StandardTrainingPolicy`'s
  `BASE_GAIN` away from their existing values. Every candidate tried
  failed to close the relative gap for the structural reason above —
  changing any of them would not have fixed the playtest's underlying
  concern, so this pass validates the existing constants rather than
  replacing them with an equally-unproven different guess. Same
  discipline the divisor retune followed in the other direction: change a
  constant only when the data says to, and here it says not to.
- **The real, disclosed implication**: a "436 entries, zero titles" result
  most likely does not reflect a training-speed problem at all. It's more
  consistent with either (a) tournament-tier mismatch — a manager
  repeatedly entering draws well above their roster's realistic
  competitive level, rather than the tier their roster quality actually
  fits — or (b) the acquisition/scouting loop being the intended lever
  for a mediocre roster's competitiveness (claiming a better prospect
  with manager XP), not training an existing weak roster into a strong
  one, matching the rarity/scarcity premise the talent pool is built on
  (CLAUDE.md's "Player acquisition" section). Neither of those is a
  balance-constant fix, and neither was in this pass's scope — flagged
  here as the more promising next investigation if the underlying
  concern (do free-tier managers have a real path to competitiveness)
  gets picked up again.
