# Balance-tuning report

Closes CLAUDE.md's "Immediate next steps" item 3 / GC-5.2
(`docs/implementation-roadmap.md`): "no bulk simulation sample, no
statistical validation of surface/fatigue effects... no recorded
methodology." This doc records the methodology and a baseline reading. It
is **not** a retuning pass — the ~40 PLACEHOLDER constants scattered
through `StatisticalMatchSimulator`, `PlayerAgingService`,
`StandardRankingPointsTable`, etc. are still exactly what they were.
Building the tool and taking one honest baseline reading with it is the
scope of this pass; using that reading to actually retune constants is
separate, ongoing work this tool now enables.

## Methodology

`apps/api/scripts/balance-simulation.mjs` imports
`StatisticalMatchSimulator` directly from `@tennis-manager/domain` — pure
domain logic, no HTTP, no Postgres, no `apps/api` server needed (unlike
`playtest.mjs`, which is an API rules-correctness smoke test over real
HTTP and has nothing to do with statistical balance). It runs the real
simulator with a **real random source** (`Math.random()`, not a scripted
`ScriptedRandomSource` like every unit test uses) thousands of times per
bucket, aggregating the empirical win rate.

Run it with:

```
node apps/api/scripts/balance-simulation.mjs
TRIALS_PER_BUCKET=10000 node apps/api/scripts/balance-simulation.mjs
```

It writes `balance-report.json` (repo root, same convention as
`playtest-report.json`) and prints a console summary.

Three buckets, each holding every variable but one constant between the
two participants so the isolated effect is unambiguous:

1. **Rating gap** (`ratingGap`) — both players share fatigue 0, form 0,
   `SurfaceAffinities.initial()`, and play on neutral `hard` court (every
   Step-4 surface × attribute weight is ×1.0 there, so this bucket is
   deliberately insulated from that mechanism). Player A's technical,
   physical, and mental attributes are uniformly raised by `gap` over
   player B's flat 50 baseline. Since `effectiveRating` weights those
   three groups 0.5 + 0.3 + 0.2 = 1.0, a uniform `+gap` should map to
   almost exactly a `+gap` effective-rating edge — the point of this
   bucket is checking whether that theoretical mapping survives actual
   point-by-point, set-by-set match structure, not just a single
   `pointWinProbabilityA` calculation.
2. **Fatigue** (`fatigue`) — equal skill (50/50), equal form, neutral
   surface; only player A's `fatigue` (0-100) varies against B's fixed 0.
   `effectiveRating` charges `fatigue * 0.15`, so this measures the real
   win-rate cost of playing tired.
3. **Surface-affinity gap** (`surfaceAffinityGap`) — equal skill, equal
   fatigue/form; only player A's `SurfaceAffinities` value for the played
   surface (clay, picked arbitrarily — the mechanism itself is
   surface-agnostic) varies over B's `SurfaceAffinities.initial()`
   baseline of 20, up to the real game cap of 60
   (`SurfaceAffinities.MAX_PER_SURFACE`). This isolates the passive
   affinity bonus term (`surfaceBonus * 0.3`) from the Step-4 per-attribute
   weighting mechanism (which is about which attribute you *trained*, not
   this stat).

Each bucket's rows are checked for monotonicity (win rate should never
meaningfully reverse direction as the favored side's advantage grows) as
a basic sanity check that nothing is backwards.

## Results (3,000 trials/bucket, 2026-08-19 baseline run)

### Rating gap → win rate for A

| Gap | Win rate A |
|---|---|
| 0 | 49.3% |
| 2 | 80.7% |
| 5 | 98.6% |
| 8 | 100.0% |
| 10 | 100.0% |
| 15-50 | 100.0% |

Monotonic: yes.

### Fatigue (A) → win rate for A (B fixed at 0 fatigue, equal skill)

| Fatigue A | Win rate A |
|---|---|
| 0 | 49.1% |
| 10 | 25.4% |
| 20 | 9.5% |
| 30 | 2.0% |
| 40 | 0.5% |
| 60-100 | 0.0% |

Monotonic (non-increasing): yes.

### Surface-affinity gap (clay, A) → win rate for A (equal skill)

| Affinity gap | Win rate A |
|---|---|
| 0 | 50.4% |
| 5 | 73.6% |
| 10 | 90.9% |
| 20 | 99.5% |
| 30-60 | 100.0% |

Monotonic: yes.

## Assessment

Every curve is monotonic in the expected direction — nothing is backwards,
and the 0-gap rows all land at ~50% as they should (pure coin flip when
nothing distinguishes the two sides). That's the good news.

The real finding is that **all three curves saturate far too fast to be
credible.** A uniform rating gap of just 5 points (out of a 0-100 skill
scale) already produces a 98.6% win rate; 8+ points is a mathematical
blowout with essentially zero upset chance across 3,000 real trials. The
same is true of fatigue (30 points of fatigue — well short of the 100 max
— already leaves almost no chance of winning) and surface affinity (a
10-point affinity edge, one-sixth of the real 60-point cap, already wins
91% of the time).

This is a genuine, disclosed problem worth flagging for the eventual
retuning pass, not just a "looks fine" checkbox: real tennis has real
upsets even between meaningfully different-ranked players — a gap that
would be considered decisive still loses a non-trivial fraction of the
time. The mechanism causing this: `pointWinProbabilityA` is a sigmoid of
`ratingGap / 15` applied **per point**, and a best-of-3 match plays out
many points across multiple games and sets. Even a modest per-point edge
compounds relentlessly over dozens of independent points — the match-level
win probability is far steeper than the point-level formula alone
suggests, because the simulator was clearly tuned by eyeballing the
per-point sigmoid in isolation, not by checking what it does once
compounded across a full match (exactly the gap this tool now closes).

This doesn't mean the formula is "wrong" in shape — every curve moves the
right direction — but the **scale is off**: `effectiveRating`'s `/15`
sigmoid divisor (and by extension `fatigue * 0.15`, `surfaceBonus * 0.3`,
and every other coefficient feeding into it) is compressing far too much
real-world variance out of the match. The credibility cost is real: a
manager whose player is a few points weaker on paper will experience
their matches as effectively pre-decided, not close.

**Recommendation for the eventual retuning pass** (not done in this
pass): widen the sigmoid's divisor (or equivalently, shrink the
attribute-weight coefficients feeding into `ratingGap`) so that a skill
gap in the range real managers will actually see in practice (roughly the
first 10-20 points, since most rostered/generated players cluster well
inside a 100-point scale) produces win rates in a believable band —
something like 60-85% for a clear-but-not-overwhelming favorite, not
98-100%. The fatigue and surface-affinity coefficients should be
re-examined together with the divisor, since all three feed the same
`ratingGap` input to the same over-steep sigmoid — fixing the divisor
alone will also flatten the fatigue and surface-affinity curves back
toward something credible, without necessarily needing separate changes
to `FATIGUE`/`surfaceBonus`'s own weights.

## What this pass did and did not do

- **Built**: the simulation tool (`balance-simulation.mjs`), a baseline
  reading (`balance-report.json`, this doc), and a concrete, evidence-based
  recommendation for the retuning pass.
- **Not done**: actually changing `effectiveRating`'s coefficients. That's
  a real gameplay-feel decision (how much should skill matter vs. variance
  vs. "anyone can win on a given day") that deserves a deliberate pass of
  its own, ideally re-running this exact tool after each candidate change
  to confirm the curve actually moved into the target band — this tool is
  what makes that iteration cheap and repeatable going forward.
