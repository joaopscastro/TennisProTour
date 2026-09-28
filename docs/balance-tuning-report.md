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

## Skill integer-rounding bug: the real cause of "zero growth," found via a second live fast-tick run

### Background

Following the roster-gap investigation above, the user asked to run an even
faster world tick (WORLD_TICK_INTERVAL_MS lowered further) for a full 5
simulated seasons, with a small tracked cohort of 5 real players (ages
14-15 at claim, spanning exceptional/strong/common rarity tiers) followed
live to see how they age from ~14 to ~19. Several real production bugs
were found and fixed along the way (documented in CLAUDE.md's "World
clock" section): a crash in the day-tick match sweep on unseeded
qualifying brackets, and a more severe world-halting stuck state in
qualifier promotion. After both were fixed, the tracked cohort ran for
over an hour of real time (~2.5+ simulated seasons).

### The misleading result

The two strongest tracked players (Noah Petrov, 87 OVR at claim; Diego
Ivanova, 82 OVR) showed **exactly zero attribute change** across the
entire run, while the three weaker players (70, 67, and 60 OVR) showed
real, if lopsided, growth. A first read of this — including from an LLM
agent tasked with monitoring it — concluded this was "aggressive built-in
catch-up mechanics" and that the gap was narrowing, contradicting this
report's own earlier roster-gap finding.

**That read was wrong, and the real cause was worse.** Checking the exact
DB values directly (not trusting the agent's self-report) showed Noah's
`strength` sat at exactly 84 for 28 consecutive weekly rollovers, on a
continuous "strength" training focus, with genuine experience accruing
the whole time (3268 XP, far more than the ~18 needed to fully fund one
training step). Something was preventing the funded, correctly-targeted
training from ever landing.

### Root cause

`Skill.add(delta)` used to be `Skill.of(this.value + delta)` — and
`Skill.of` rounded to the nearest integer on construction. Since `value`
was *already* the rounded integer from the previous call, every `add()`
started from an already-rounded base and rounded again immediately. Any
delta under 0.5 — applied repeatedly — landed on the exact same integer
every single time, with the fractional progress discarded, forever:

- **Physical training near a ceiling.** `applyPotentialDiminishingReturns`
  scales the base delta by `headroom / DIMINISHING_RETURNS_RANGE` (15).
  Once headroom drops under 7.5 points, the scaled delta drops under 0.5
  — Noah's `strength` ceiling headroom was exactly 6, delta = 1.0 × (6/15)
  = 0.4, which rounds to zero forever. This is NOT a rare edge case:
  `PlayerGenerationPolicy`'s ceiling headroom is rolled uniformly over
  [0, 45] independently per physical attribute, so roughly 1 in 6 rolls
  lands under 7.5 — meaning a meaningful fraction of every generated
  player's physical attributes are permanently untrainable from the
  moment they're generated, not eventually, not "slowed," genuinely
  stuck at zero forever.
- **Decline-stage aging.** `StandardAgingPolicy.weeklyDeclineDelta`
  returns a flat `-0.05` for the `decline` stage — always under 0.5 in
  magnitude, so it *always* rounded to zero. A player in decline never
  actually declined at all, ever, under the old behavior — a much bigger,
  connected finding than the training-ceiling case, since it's not
  conditional on headroom, it's universal.

### The fix

`Skill` now carries fractional precision internally (`raw`); `.value`
(what every other caller reads — the simulator, DTOs, `overallRating()`)
is `Math.round(raw)`, computed fresh each read rather than baked in at
construction. `add()` accumulates against `raw`, so a sustained sub-0.5
delta now genuinely accumulates across calls and eventually crosses a
whole-point boundary, instead of being discarded every time.

This only holds if the fractional part survives a save/load round-trip,
so the 9 Skill-backed `players` columns (serve, forehand, backhand,
volley, speed, stamina, strength, consistency, clutch, doubles) were
migrated from `integer` to `double precision` (migration `0043`) — the
same type `experience` already used for exactly this "must carry a
fractional remainder" reason. `DrizzlePlayerRepository.toRow` now
persists `.raw`, never the rounded `.value`. Surface affinities
(`SurfaceAffinities`, a separate class) were checked and are NOT affected
— their training delta is always ≥ 0.6 (2× the attribute base rate, never
gated by any ceiling), so it can never round to zero the way a
ceiling-diminished physical delta or the flat decline delta could.

Two existing domain tests had literally codified the old bug as expected
behavior and were rewritten to assert the correct behavior instead:
`Player.test.ts`'s ceiling-approach test (previously asserted the
attribute plateaus one point *short* of its ceiling — a rounding
artifact — now asserts it reaches the ceiling exactly, tracked against
`raw` for the monotonicity check since the *rounded* value can now
legitimately bounce as fractional progress crosses whole-point
boundaries) and `PlayerAgingService.test.ts`'s test (previously titled
"demonstrates that StandardAgingPolicy's -0.05/week delta never actually
moves an integer Skill value" — now asserts decline actually happens
after enough weeks). Domain suite 333 (unchanged count — 2 rewritten, not
added), application 205, api 79 (including a real migration round-trip
against a fresh Postgres), worker 8 — all green; full monorepo
`tsc --build --force` and `npm run typecheck -w apps/web` both clean.
Verified live: restarted the worker against the exact real-Postgres state
the bug was found in, and the fix applies going forward (existing
whole-number values round-trip unchanged; new training/decline deltas
now accumulate correctly).

### What this means for the roster-gap finding above

This does not overturn the roster-gap investigation's conclusion — if
anything it strengthens it. The "gap never closes" finding used a clean
deterministic simulation that (correctly, as it turns out) modeled
training as smoothly continuous; it never hit this specific integer-
rounding artifact. What this bug actually explains is why a stronger
player's growth could look *artificially flatter* than even that
pessimistic simulation predicted in live play — not "catch-up
mechanics," but attributes silently unable to move at all. With the fix,
live play should now track the deterministic simulation's own curves
much more closely.

## Fatigue/form pass: the day-tick-scaling question, answered with data

> **Superseded in part by the SECOND and THIRD fatigue/form passes later
> in this document.** Everything below is the record of the *first* pass
> (recovery 5 → 3/day, no form change). Its measured tables remain
> accurate for the formulas in force at the time, but the recovery model
> changed from a fixed drain to a self-limiting one, the form stale
> boundary and penalty were softened, the recovery FRACTION and the form
> decay + sweet-spot bound were retuned again in the third pass, and the
> inactivity penalty was relaxed. Read the first pass as history; the
> later passes state what changed and why.

The docs repeatedly flag the fatigue/form constants as "the main open
balance question," specifically *"especially their scaling to our
day-tick cadence"* (`docs/rocking-rackets-competitive-analysis.md` §5).
Both are PLACEHOLDERs. The divisor retune re-checked fatigue's *win-rate*
curve but never form at all, and never asked whether real schedules can
actually *reach* the values those curves describe. This pass closes both
gaps: three new buckets in `apps/api/scripts/balance-simulation.mjs`, all
replaying the production mutators directly rather than a re-derived
recurrence, and one production constant changed.

### What was added to the tool

1. **`form`** — win rate for A as A's form varies (equal skill/fatigue,
   neutral hard court), against B fixed at form 0 (most-rusty). This is
   the one core `effectiveRating` modifier the divisor retune never
   measured.
2. **`formTrajectory`** — the steady-state form a real 52-week schedule
   reaches, replaying the production accrual (`+1` per match,
   `SimulateMatchUseCase`) and weekly decay (`FORM_WEEKLY_DECAY = 0.85`,
   `AdvanceWorldWeekUseCase`) through the real `Player.applyMatchForm` /
   `decayForm`.
3. **`fatigueTrajectory`** — the same for fatigue, replaying
   `fatigueCostForMatch` per match and `FATIGUE_RECOVERY_PER_DAY` on all
   seven days of the week through `Player.applyMatchFatigue` /
   `recoverFatigue`. `FATIGUE_RECOVERY_PER_DAY` is also an env override
   (`FATIGUE_RECOVERY_PER_DAY=3 node …`), same compare-candidates
   workflow as `DIVISOR`.

### Finding 1 — fatigue was dead on the senior tour (retuned 5 → 3/day)

The senior tour is capped at **one tournament per week**. A 32-draw
champion plays 5 matches (a 128-draw major, 7), at ~6 fatigue each for a
mid-stamina player. Recovery was **5/day × 7 days = 35/week**. So even a
player who won a 32-draw title *every single week* netted **negative**
(30 − 35) and sat at fatigue 0 forever — the fatigue mechanic, and the
whole "do I rest my player?" decision it exists to create, did nothing on
the senior tour. Only 6-7-match weeks (junior 3-entry play, or a major
title) ever accumulated.

Measured steady-state fatigue after a 52-week season (production value of
5/day):

| schedule | matches/wk | mid stamina (cost 6) | low stamina (cost 7) |
|---|---|---|---|
| idle | 0 | 0 | 0 |
| senior: R1 exit | 1 | 0 | 0 |
| senior: deep run | 3 | 0 | 0 |
| senior: 32-draw title | 5 | **0** | **0** |
| junior: 3 tournaments | 6 | 51 | 90 |
| senior: 128-draw major title | 7 | 95 | 95 |

**Retuned `FATIGUE_RECOVERY_PER_DAY` from 5 to 3.** The accumulation
threshold moves from ~5.8 to ~3.5 matches/week: an early exit or a deep
run stays free, while a sustained semifinal-or-better schedule builds
fatigue and eventually forces a rest week — the intended "which
tournaments do I enter" tension. After the retune the same table reads:

| schedule | matches/wk | steady fatigue |
|---|---|---|
| idle / R1 exit / deep run | 0-3 | 0 |
| senior: 32-draw title | 5 | 91 |
| junior: 3 tournaments | 6 | 94 |
| senior: 128-draw major title | 7 | 97 |

*Not changed*: `BASE_MATCH_FATIGUE` (8) and the sim penalty
(`fatigue × 0.15`) were left alone — moving the single recovery constant
is the minimal change that revives the mechanic, and changing accrual,
recovery, and penalty together would make the effect unattributable. 3 is
still a PLACEHOLDER validated against *simulated trajectories*, not live
play.

### Finding 2 — the form curve is sound, and the sweet spot is reachable (measured, NOT retuned)

The form modifier is a *band* function, not a gradient (rusty `<8`,
neutral `8-11`, `+2` sweet spot `12-25`, neutral `26-30`, stale `>30`), so
this is a peaked curve. Measured win rate for A vs B at form 0:

| A's form | modifier | win rate A |
|---|---|---|
| 0 | −2.4 | 50.4% |
| 8 | 0.0 | 58.3% |
| 12-25 | +2.0 | 63-64% |
| 30 | 0.0 | 57.8% |
| 40 | −3.0 | 48.5% |
| 50 | −6.0 | 37.2% |

The peak is genuinely inside the `[12,25]` sweet spot, so the band labels
are truthful; the sweet spot is a real, felt edge (~64% vs the most-rusty
anchor) without being decisive. And the trajectory bucket shows the band
is *reachable*: only a "deep run" schedule (3 matches/week) sits at form
14 (sweet spot), while winning every week (5 matches → 26) and junior
3-entry play (6 → 31) drift to neutral/stale — the intended over-playing
penalty, arriving exactly where the design says it should. **No form
constant was changed**, because the data does not say to change one.

### Disclosed, NOT fixed: form decay has a minor integer-rounding artifact

`Player.decayForm` uses `Math.round(form × 0.85)`, which makes **1, 2, and
3 fixed points** — measured: a player who "went idle from form 20" stalls
at form **3** instead of decaying to 0. This is the same *shape* as the
`Skill` rounding bug fixed earlier, but with a far smaller blast radius:
form 3 is still inside the **rusty** band (`<8`), so the *band* is
unaffected — only the rusty penalty's magnitude differs (−1.5 instead of
−2.4). Fixing it properly means either carrying fractional form (a DB
migration, like `Skill`'s `raw`) or switching to `Math.floor`, and floor
has its own distortion the other way (1 match/week would pin at form 0
permanently). Since neither is clearly better than the current behavior
and the band is unaffected, this pass **documents it rather than swapping
one arbitrary rounding for another** — revisit only alongside a broader
reason to carry fractional player state.

### What this pass did and did not do

- **Applied**: `FATIGUE_RECOVERY_PER_DAY` 5 → 3
  (`packages/application/src/use-cases/AdvanceWorldWeekUseCase.ts`), with
  its doc comment rewritten to the measured rationale.
- **Built**: the `form`, `formTrajectory`, and `fatigueTrajectory` buckets
  (+ the `FATIGUE_RECOVERY_PER_DAY` env override) in
  `apps/api/scripts/balance-simulation.mjs`.
- **Not done**: no change to `BASE_MATCH_FATIGUE`, the fatigue sim
  penalty, or any form constant — the data did not support moving them.
  The pre-existing PLACEHOLDERs outside the fatigue/form pair (aging
  thresholds, the training-redesign deltas, `DIRECT_ACCEPTANCE_CUTOFF`,
  the prize-money tables, etc.) remain untouched and still need their own
  passes.

## Fatigue/form pass #2: from a ratchet to an equilibrium (deliberate rest-pressure shift)

> **Superseded in part by the THIRD pass (the last section of this
> document).** The self-limiting recovery model introduced here stands,
> but its FRACTION was retuned 0.05 → 0.08, `FORM_WEEKLY_DECAY` 0.85 →
> 0.75, and the sweet-spot upper bound 25 → 28 after a measured 52-week
> agent season showed the second pass's calibration was aimed at a match
> volume that no longer exists (Batch 4B doubled the weekly `tour`
> schedule). The tables below remain the correct record of the values in
> force at the time.

The first pass retuned the fixed recovery drain (5 → 3/day) to revive
fatigue on the senior tour, and explicitly aimed its new steady state at
"forcing a rest week." Live play over a full agent season then showed what
that pressure actually produced, and it was the wrong shape:

- **Fatigue was a ratchet, not a decision.** A 32-draw title run accrues
  ~30 fatigue/week against a fixed 21/week drain, so the three
  most-played juniors (6 matches/week: ~36-42 accrued vs 21 drained)
  ended the season at **fatigue 93-97** — permanently exhausted, never
  recovering between weeks, because the drain could not outrun accrual.
  Players only *appeared* rested when they played fewer matches than the
  drain, i.e. the mechanic punished success monotonically.
- **Rest was punished by a different system.** The only way to shed
  fatigue was an idle week — which triggered the manager-ladder
  **inactivity penalty (−15%)**. So the first pass created a real cost for
  overplay and then made the remedy the single worst thing a manager could
  do. Rest was not a real option; it was a trap.
- **Form's stale side contradicted "play to earn."** Form's equilibrium is
  ≈ 5.67 × matches/week (decay ×0.85/week vs +1/match) against a reward
  band of 12–25 and a stale penalty above 30 — so any schedule at or above
  ~5 matches/week drifts permanently OUT of band, and the measured 6/week
  equilibrium (31) sat in the stale zone. The most active players were
  systematically penalised, exactly inverting the intended incentive.

This pass deliberately shifts that pressure. **Stated plainly: the first
pass's "sustained play eventually forces a rest week" model is replaced.
Overplay now costs a finite, self-limiting amount, and a rest week is a
viable plan rather than a trap** — the systems no longer fight each other.

### What changed

1. **Self-limiting fatigue recovery** (`FatiguePolicy.ts`): recovery per
   advanced day is now `FATIGUE_RECOVERY_PER_DAY (3) + fatigue ×
   FATIGUE_RECOVERY_FRACTION (0.05)`, rounded to a whole point.
   `Player.recoverFatigue` applies it, and
   `DrizzlePlayerRepository.recoverFatigueForAll` mirrors the exact same
   arithmetic in one SQL statement (equivalence pinned against real
   Postgres). The more tired the player, the faster they recover — accrual
   and recovery meet at an equilibrium instead of a ceiling. All constants
   remain PLACEHOLDER.
2. **Softened form stale side** (`StatisticalMatchSimulator.ts`):
   `FORM_STALE_THRESHOLD` 30 → 40 and
   `FORM_OUT_OF_BAND_PENALTY_PER_POINT` 0.3 → 0.15. Fatigue now carries the
   overplay cost; form stays the rust/rhythm signal.
3. **Softened the inactivity penalty** (`ManagerLadderPolicy.ts`):
   0.85 → 0.95, so an idle week costs ~6% composed with the routine 1%
   decay — a real, felt consequence without making rest the wrong move at
   the exact moment the fatigue system asks for it.

### Before → after, measured (3000 trials/bucket, same tool)

**Fatigue trajectory** (`fatigueTrajectory`). Before: fixed −3/day;
after: −(3 + 5% × fatigue)/day. End-of-week and mid-week peak shown for
the after run (peak is what a manager sees during a deep run):

| schedule | matches/wk | stamina | cost/match | BEFORE steady | AFTER end-of-week | AFTER peak |
|---|---|---|---|---|---|---|
| idle | 0 | 50 / 20 | 6 / 7 | 0 | 0 | 0 |
| senior: R1 exit | 1 | 50 / 20 | 6 / 7 | 0 | 0 | 3 / 4 |
| senior: deep run | 3 | 50 / 20 | 6 / 7 | 0 | 0 | 8 / 10 |
| senior: 32-draw title | 5 | 50 / 20 | 6 / 7 | **91 / 91** | **18 / 25** | **26 / 35** |
| junior: 3 tournaments | 6 | 50 / 20 | 6 / 7 | **94 / 94** | 39 / 44 | 44 / 50 |
| senior: 128-draw major title | 7 | 50 / 20 | 6 / 7 | **97 / 97** | 44 / 63 | 44 / 63 |

The design pass's quantified predictions are reproduced: a 5-match title
run peaks at **26** (predicted ~26) and a 7-match major run settles at
**63** at low stamina (predicted ~60), versus 91-97 before. The mechanic is
now monotone in schedule depth (more matches → higher finite
equilibrium), and ordinary play (≤3 matches/week) still never accumulates.
A 60-fatigue player recovers to **24** in ~7 idle days (predicted ~26),
so a rest week genuinely works. The existing "30 fatigue ≈ 15 percentage
points of win rate" finding is unchanged for a given fatigue *value*
(before: 35.9% at fatigue 30; after: 35.3%) — players simply stop sitting
at 100.

**Form curve** (`form`). Before: stale at 30 with a −0.3/point penalty;
after: stale at 40 with −0.15/point:

| A's form | BEFORE modifier → win rate | AFTER modifier → win rate |
|---|---|---|
| 0 | −2.4 → 50.4% | −1.2 → 50.7% |
| 8 (tolerance starts) | 0.0 → 59.0% | 0.0 → 52.8% |
| 12-25 (sweet spot) | +2.0 → ~64.5% | +2.0 → ~60% |
| 30 | 0.0 → 58.7% | 0.0 → 53.8% |
| 40 | −3.0 → 48.5% | 0.0 → 51.8% |
| 50 | −6.0 → 39.3% | −1.5 → 48.2% |

**Form trajectory** (`formTrajectory`). The steady-state form *values* are
unchanged (accrual/decay untouched), but the band classification moves the
heaviest schedule out of stale:

| schedule | matches/wk | steady form | BEFORE band | AFTER band |
|---|---|---|---|---|
| idle | 0 | 0 | rusty | rusty |
| went idle from form 20 | 0 | 3 | rusty | rusty |
| senior: first-round exits | 1 | 3 | rusty | rusty |
| senior: mid run | 2 | 9 | neutral | neutral |
| senior: deep run | 3 | 14 | sweet-spot | sweet-spot |
| senior: title run | 5 | 26 | neutral | neutral |
| junior: 3 tournaments/week | 6 | 31 | **stale** | **neutral** |

### What this pass did and did not do

- **Applied**: the self-limiting recovery formula and its constants
  (`packages/domain/src/player/FatiguePolicy.ts`, applied in
  `Player.recoverFatigue` and mirrored in
  `DrizzlePlayerRepository.recoverFatigueForAll`); the form stale
  threshold/penalty softenings
  (`packages/domain/src/match-simulation/StatisticalMatchSimulator.ts`);
  and the inactivity-penalty softening
  (`packages/domain/src/manager/ManagerLadderPolicy.ts`).
- **Built**: the `fatigueTrajectory` bucket now replays the production
  self-limiting formula and reports the mid-week peak alongside the
  end-of-week value; the tool's meta carries the recovery fraction.
- **Not done**: `BASE_MATCH_FATIGUE`, the fatigue sim penalty
  (`fatigue × 0.15`), and `FORM_WEEKLY_DECAY` remain untouched — the data
  did not support moving them. The disclosed `decayForm` integer-rounding
  artifact from the first pass is also unchanged (band-neutral). Every
  constant here remains an explicit PLACEHOLDER validated against
  simulated trajectories, not live play.

## Third fatigue/form pass + doubles field strength: the 52-week agent-season signals

Source: the completed 52-week agent seasons (`agents-season-2b`,
`agents-season-3`; worlds `tennis_manager_agents` /
`tennis_manager_agents3`). Three measured signals, three decisions. Every
new/changed constant is PLACEHOLDER-flagged exactly like every other
balance constant in this codebase. The tool is the same one the previous
passes built (`apps/api/scripts/balance-simulation.mjs`), extended with
elite-load schedules, candidate env overrides, and a seeded `doublesField`
regression bucket.

### Before/after summary

| system | constant | BEFORE | AFTER |
|---|---|---|---|
| Fatigue recovery (self-limiting) | `FATIGUE_RECOVERY_FRACTION` | 0.05 | **0.08** |
| Form weekly decay | `FORM_WEEKLY_DECAY` | 0.85 | **0.75** |
| Form sweet-spot upper bound | `FORM_SWEET_SPOT_MAX` | 25 | **28** |
| (re-measured, deliberately unchanged) | `FATIGUE_RECOVERY_PER_DAY` 3, `BASE_MATCH_FATIGUE` 8, `FATIGUE_PENALTY_PER_POINT` 0.15, `FORM_STALE_THRESHOLD` 40 | | |

No fatigue/form change touches the `advance-world-day` handler order: the
same constants feed the same systems at the same points. The doubles fix
lives entirely inside the two existing form-doubles call sites
(`FormDoublesDrawUseCase` → `DoublesPairingService`).

### 1 — Fatigue was a one-way ratchet at the new elite volume (FIXED)

**The evidence, measured on `tennis_manager_agents3`.** One agent's player
averaged **9.5 matches/week** and sat at fatigue ≥80 for **38 of 52
weeks**, including **9 consecutive weeks ≥90**; another averaged 9.1/week
with 25 weeks ≥80. The only cure was a full idle week. The consequence was
visible in results: singles deep runs became fatigue coin-flips while
doubles/juniors kept working (doubles is a second match on the same days).

This is a problem the SECOND pass could not have seen: Batch 4B added a
second weekly `tour` event, so a realistic elite week is now singles +
same-event doubles = ~9-14 matches, not the ~5 the self-limiting recovery
was calibrated against. The tool's old schedules topped out at 7 — the
elite band was simply unmeasured.

**Candidate comparison** (`fatigueTrajectory`, stamina 50, end-of-week /
mid-week peak; the same table is in `balance-report*.json`):

| recovery per day | 9 matches/wk | 11 matches/wk | 14 matches/wk |
|---|---|---|---|
| 3 + 0.05×f (before) | 80 / 88 | 86 / 92 | 92 / 92 |
| 3 + 0.07×f | 55 / 63 | 77 / 87 | 90 / 90 |
| **3 + 0.08×f (chosen)** | **47 / 55** | **66 / 76** | **89 / 89** |
| 4 + 0.08×f | 34 / 42 | 53 / 63 | 82 / 82 |
| 3 + 0.10×f | 35 / 43 | 49 / 59 | 73 / 73 |

0.07 leaves an 11-match week at a 87 peak (still too close to the old
problem); 0.08 puts the whole 9-11 band inside the target 40-80 for BOTH
end-of-week and peak, with the occasional 14-match week at 89 (high but
finite, and recovered by a following lighter week). Raising the base to 4
instead (at 0.08) pushes a 9-match week BELOW 40 at end-of-week — rejected
for the same target; 0.10 undershoots the same way. Per-match cost was
left alone: the measured cause is recovery capacity at the new volume,
and moving cost too would make the effect unattributable.

**Before → after trajectories** (production tool run; stamina 50 and the
low-stamina 20 reference):

| schedule | matches/wk | BEFORE end/peak (stam 50) | AFTER end/peak | BEFORE (stam 20) | AFTER |
|---|---|---|---|---|---|
| idle | 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| senior: R1 exit | 1 | 0 / 3 | 0 / 3 | 0 / 4 | 0 / 3 |
| senior: deep run | 3 | 0 / 8 | 0 / 7 | 0 / 10 | 0 / 9 |
| senior: 32-draw title | 5 | 18 / 26 | 7 / 15 | 25 / 35 | 14 / 24 |
| junior: 3 tournaments | 6 | 39 / 44 | 21 / 26 | 44 / 50 | 26 / 32 |
| senior: 128-draw major title | 7 | 44 / 44 | 26 / 26 | 63 / 63 | 37 / 37 |
| **elite: singles+doubles deep runs** | **9** | **80 / 88** | **47 / 55** | **87 / 92** | **60 / 70** |
| **elite: 11-match week** | **11** | **86 / 92** | **66 / 76** | **89 / 92** | **79 / 89** |
| peak: 14-match week (both finals) | 14 | 92 / 92 | 89 / 89 | 92 / 92 | 89 / 89 |

**The rest/taper decision is preserved, not neutered.** The sim penalty
(`FATIGUE_PENALTY_PER_POINT = 0.15`) is deliberately unchanged; re-measured
on the same tool, a given fatigue value still costs what it always did
(30 → 34.3% win rate vs a fresh equal opponent, 60 → 21.4%, 80 → 15.7%).
What changed is that elite players now oscillate at 47-66 instead of
sitting at 86-92, so: (a) an 11-match week's ~66 recovers to ~22 in an
idle week — a real taper edge of ~7 effective-rating points; (b) the
14-match week's ~89 tail is genuinely painful but recoverable; (c)
lighter schedules (≤5) visibly recover to near zero. The mechanic is still
monotone in schedule depth (more matches → higher finite equilibrium).

**Regression coverage**: `FatiguePolicy.test.ts`'s equilibrium test now
pins 9 and 11 matches/week inside [40, 80] (via the real
`fatigueRecoveredPerDay` recurrence), 14 finite and recoverable in an idle
week, and the low-load recoveries; the tool's `fatigueTrajectory` gained
the three elite schedules permanently.

### 2 — Form was a dead lever (FIXED)

**The evidence.** The sweet spot [12,25] is reachable only at ≤~4
matches/week because the old decay's equilibrium was ≈5.67 ×
matches/week; every measured high-volume manager sat permanently out of
band (one player at 7.4 matches/week: 12 stale weeks, only 2 in-band), so
agents stopped optimising form entirely. The intent — "never playing
hurts, playing every single event hurts" — is right, but the curve was
calibrated against a match volume that no longer exists.

**Candidate comparison.** `FORM_WEEKLY_DECAY` 0.85 → 0.80 (equilibrium
4 × matches/week) leaves a 9-match week at 34 — outside the band even at
the new 28 bound. 0.75 makes the equilibrium EXACTLY 3 × matches/week
(integer-rounding-free), which puts the whole 5-9 range at 15-27 — inside
the band. `FORM_SWEET_SPOT_MAX` moved 25 → 28 so a 9-match week (27) is
in-band rather than a boundary case. `FORM_SWEET_SPOT_MIN` (12),
`FORM_STALE_THRESHOLD` (40) and `FORM_OUT_OF_BAND_PENALTY_PER_POINT`
(0.15) were all left unchanged — the data did not ask for more.

**Before → after trajectories** (`formTrajectory`; band labels as they
stand AFTER the pass — note 26 was neutral under the old [12,25] band):

| schedule | matches/wk | BEFORE steady form | AFTER steady form | AFTER band |
|---|---|---|---|---|
| idle (never plays) | 0 | 0 | 0 | rusty |
| went idle from form 20 | 0 | 3 | 2 | rusty |
| senior: first-round exits | 1 | 3 | 2 | rusty |
| senior: mid run | 2 | 9 | 5 | rusty |
| senior: deep run | 3 | 14 | 8 | neutral |
| senior: title run | 5 | 26 (neutral then) | **14** | sweet-spot |
| junior: 3 tournaments/week | 6 | 31 (neutral) | **17** | sweet-spot |
| elite: singles + doubles deep runs | 9 | 48 (stale) | **26** | sweet-spot |
| extreme: both finals at a major | 14 | 77 (stale) | **41** | stale |

So a typical competitive 5-9 match week now sits IN the sweet spot and
earns the +2 bonus; a genuinely idle player still decays to 2 (rusty, the
under-play cost); an extreme 14-match every-week player still drifts stale
— which is exactly the "every single event hurts" side, now carried mostly
by fatigue (21.4% win rate at 60) with form as the nudge it was meant to
be. The form value curve itself is unchanged (peak measured at form 18,
inside the band; ~60% win rate vs the most-rusty anchor at any in-band
value).

**Regression coverage**: a new `Player.test.ts` case replays the real
`applyMatchForm`/`decayForm` loop and pins 5-9 matches/week inside
[`FORM_SWEET_SPOT_MIN`, `FORM_SWEET_SPOT_MAX`] with the +2 modifier, idle
decay into the rusty band, and a 14-match week into the stale band. The
constant moved to `StatisticalMatchSimulator.ts` (its domain home, next to
the rest of the form curve) and `AdvanceWorldWeekUseCase` re-exports it,
so the balance tool and the application tests keep importing it from the
same place.

### 3 — Doubles was an uncontested economy: the FIELD was fixed, not the points

**The evidence, measured on `tennis_manager_agents3`.** 58 main-draw
tournaments carried a manager pair (66 manager pairs, 134 manager doubles
entries all season). Two persistent pairs won **55 of the 59 doubles
titles** (m4 30, m3 25; m2 2; 2 unowned). Doubles accounted for 45.7%
(m3) and 38.6% (m4) of their best-N senior totals.

**The real-world note that scoped the fix.** At ATP Masters 1000 level,
doubles winners genuinely receive the same ranking points as singles
winners — the points parity is SOURCED (`docs/ranking-realism-proposal.md`;
the 2026 ATP tables adopted earlier), not a bug. The defect is that the
FIELD was uncontested, making a title nearly free. **No doubles points,
prize money, chemistry, or draw-size constant was touched by this pass.**

**What the padded fields actually looked like (before).** For the 58
manager-entered draws, on the exact effective-rating scale the doubles sim
uses (`doublesSideStrength`/`doublesPairStrength`: surface-weighted
technical/physical/mental + surface affinity + 0.4 × doubles skill +
chemistry):

| metric (mean over the 58 draws) | value |
|---|---|
| winning / strongest manager pair strength | 124.0 |
| average padded-pair strength (as stored) | 75.0 |
| best padded-pair strength (as stored) | 89.0 |
| gap, manager pair → average padded pair | 49.0 |

One representative tournament (`62a1a568`, a `tour` m4 won): manager pair
113.5, best padded pair 77.1, average padded pair 59.8. The padded cohort
in that field (54 players) averaged 43.7 OVR while the free-agent pool
(2,469 players) had a median of 44.2 and a max of 88.7 — the old
ranked-first selection was not strength-aware, and then
`DoublesPairingService` SHUFFLED every padded filler together, so even the
strong free agents who did make the field were diluted into one weak
average pair. There was no pair in the draw capable of pushing the manager
pair.

**The fix (field, not points).** Two pure domain additions and one
pairing-path change:

- `doublesSideStrength(attributes, surface)` / `doublesPairStrength(...)`
  (`DoublesPairPolicy.ts`) measure a player/pair on the same
  effective-rating scale the sim consumes (fatigue/form/home excluded —
  those are per-match state). Adapter-internal only; nothing new is
  serialized, so the value-hiding discipline is untouched.
- `orderDoublesFieldFillers(candidates, cap)` orders padding candidates
  strongest-first, EXCLUDING (to the back of the queue) any candidate whose
  own strength exceeds the cap. The cap is the strength of the WEAKEST real
  manager pair in the draw. Because a pair of two at-or-below-cap players
  can never exceed the cap, "anonymous padding is never stronger than a
  manager's own pair" is a structural property of the selection, not a
  heuristic. (When no persistent pair exists yet, the fallback cap is the
  weakest entrant's own strength — deliberately conservative.)
- `DoublesPairingService` gained an optional strength-aware path: padded
  free agents are paired strongest-with-strongest in the caller's order
  (instead of shuffled into the pool), real solo entrants still pair
  randomly among themselves, and the legacy random path is byte-for-byte
  unchanged whenever `strength`/`fillerEntrants` are absent. An odd solo
  leftover consumes the strongest padded filler AT OR BELOW its own
  strength — padding never strengthens a manager past their own level.

**Before → after, real replay against `tennis_manager_agents3`** (the
stored fields vs the field the new algorithm builds for the same 58 draws
from the end-of-season pool; disclosed caveat: the replay does not
re-simulate each week's cross-tournament commitments, so the selected
cohort is an availability-optimistic estimate — the structural cap
guarantee holds regardless):

| metric | BEFORE (stored) | AFTER (new padding) |
|---|---|---|
| winning / strongest manager pair | 124.0 | 124.0 |
| average padded-pair strength | 75.0 | **112.9** |
| best padded-pair strength | 89.0 | **122.4** |
| gap, winning pair → best padded pair | 35.0 | **1.6** |
| fields with a padded pair above the WEAKEST manager pair (the cap) | — | **0 / 58** |

The best padded pair is now, on average, within ~2 rating points of the
winning manager pair (a coin-flip final instead of a walkover), while no
field in the replay contains a padded pair stronger than the weakest real
manager pair.

**Title probability, real simulator (seeded `doublesField` bucket).** A
deterministic pool fitted to the measured end-of-season strength
distribution (p0 48 / p25 64 / p50 70 / p75 80 / p90 94 / max 132) and a
manager pair matching the real m4 pair (strength 124.6), 16-pair bracket,
every match through the production simulator:

| metric | BEFORE | AFTER |
|---|---|---|
| average padded-pair strength | 83.3 | 108.7 |
| best padded-pair strength | 110.8 | 123.5 |
| manager pair win rate vs the best padded pair (head-to-head) | 84.8% | **52.1%** |
| manager pair TITLE rate (10 builds x 50 real bracket replays) | **84.8%** | **32.2%** |

Caveat, stated plainly: the bucket's BEFORE is a lenient model (random
selection from the full pool), so it understates the real before — the
stored fields averaged a best padded pair of 89, not 110.8, and the real
season's title rate for those two pairs was 55/59. The AFTER is the honest
number: with the field fixed, a top pair's title probability drops from
near-automatic to about one in three.

**Regression coverage**: `DoublesPairPolicy.test.ts` (strength scale
matches the composite pair's effective rating exactly; cap ordering
under/over-cap, inclusive boundary, determinism);
`DoublesPairingService.test.ts` (strength pairing keeps the caller order;
odd-solo partner at-or-below its strength; spare parity; legacy path
unchanged); `FormDoublesDrawUseCase.test.ts` (strength-first padding beats
pool order; and a weak manager pair's field contains NO free agent above
the cap even when strong candidates are available); the seeded
`doublesField` bucket itself is the permanent regression measurement.

### What this pass did and did not do

- **Applied**: `FATIGUE_RECOVERY_FRACTION` 0.05 → 0.08; `FORM_WEEKLY_DECAY`
  0.85 → 0.75 (moved to the domain, re-exported by the application);
  `FORM_SWEET_SPOT_MAX` 25 → 28; the doubles field-completion path
  (strength measure, cap-aware selection, strength-aware pairing).
- **Built**: elite-load schedules + candidate env overrides
  (`FATIGUE_RECOVERY_PER_DAY`, `FATIGUE_RECOVERY_FRACTION`,
  `FATIGUE_BASE_COST`, `FORM_WEEKLY_DECAY`) and the seeded `doublesField`
  bucket in `apps/api/scripts/balance-simulation.mjs`; `FATIGUE_PENALTY_PER_POINT`
  extracted to a named constant (value unchanged); the player-facing form
  copy on the roster page corrected to the real bands (it still described
  the first pass's 12-25 / >30).
- **Not done / deliberately unchanged**: `BASE_MATCH_FATIGUE` (8),
  `FATIGUE_PENALTY_PER_POINT` (0.15), `FATIGUE_RECOVERY_PER_DAY` (3),
  `FORM_SWEET_SPOT_MIN` (12), `FORM_STALE_THRESHOLD` (40),
  `FORM_OUT_OF_BAND_PENALTY_PER_POINT` (0.15) — each re-measured, none
  moved; every doubles points/prize/chemistry/draw-size constant; the
  `advance-world-day` system order.
- **Test counts**: domain 432 → **442**, application 324 → **325**, api
  **259** (unchanged), worker **18** (unchanged). Full monorepo
  `tsc --build --force` and `apps/web` typecheck clean.
