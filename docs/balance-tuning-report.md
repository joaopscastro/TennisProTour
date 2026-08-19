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
