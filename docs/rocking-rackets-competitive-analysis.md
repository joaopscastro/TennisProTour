# Rocking Rackets — Competitive Analysis & Gap Plan

This document captures a hands-on study of **Rocking Rackets** (RR,
`rockingrackets.com`) — the game Grand Circuit is explicitly positioned
against ("Rocking Rackets, rebuilt and maintained") — and turns it into a
concrete build plan for the systems we are still missing. It also proposes
our approach to the **potential/development** problem, which the RR study
brought into focus.

The study was done by reading RR's full public manual (its help system is
effectively a complete design spec) plus the public demo/stats pages. RR's
live game screens are login-gated, but the manual documents every system in
detail. Where this doc says "RR does X", it is sourced from that manual.

## 1. How Rocking Rackets actually works

**The core loop for the human player:**

1. **Hire players** (2 free / 3–4 VIP). Hiring costs *your* manager rating
   points; cost scales with player strength. You start with 150 points.
2. **Register players for tournaments** on a calendar, up to 3 weeks ahead
   (5 for VIP). Each player plays one tournament at a time.
3. Tournaments **auto-simulate** as single-elimination knockouts; you watch
   a **client-side fake-live replay** (confirmed: RR's demo match runs
   `setInterval('match.play(1,true)',450)` over an encoded point-string with
   Ace / Break Point / Set Point / Match Point / Sudden Death annotations —
   this is exactly Grand Circuit's replay architecture).
4. Results give **ranking points** to the player and to **you** (the
   manager). You climb the **manager ranking**.

That sounds thin, but RR is deep because of **three interlocking constraint
systems** that turn "which tournaments do I enter?" into the real game:

### 1a. Fatigue / Energy
- Every match tires a player, proportional to the **number of points
  played** in the match.
- Fatigue recovers **50 points/day**. Above **500** it turns red and
  **greatly reduces playing strength** (skill, service, strength, speed,
  doubles, mentality — but not endurance/talent/home-adv).
- The **Endurance** stat reduces how much fatigue a match inflicts.
- **Consequence:** you physically cannot enter every tournament. Deep runs
  in consecutive weeks wreck a player. Rest is a resource.

### 1b. Form
- Playing **too few** recent matches → skill/service penalty.
- Playing **too many** → *also* a penalty. Sweet spot is ~20–25 "form".
- Mechanics: +1 form per real (non-practice) match; −8%/week decay; <15 or
  >30 form loses 0.1 skill+service per form point and reduces XP gain; 20–25
  gives a small bonus.
- **Consequence:** punishes both under- and over-playing. You must schedule
  a *rhythm*, not a binge.

### 1c. Experience-driven player development
- Players earn **XP from matches** — and crucially, **more XP from *hard*
  matches** (XP is based on the *loser's* points won; a 6–0 6–0 win gives
  little, a 7–6 7–6 win gives a lot; winning gives 65% of what losing gives).
- Players *also* earn free weekly XP proportional to their **Talent** stat.
- You **spend that XP training** the player's trainable stats (skill,
  service, doubles, surface affinity).
- **Consequence:** this is the "raise a pupil" fantasy. Young high-talent
  players are long-term projects; you eat losses now for a stronger player
  later.

### 1d. The manager ranking — the actual competitive ladder
- Managers accumulate **all** the ranking points their players earn.
- **The manager score decays 1%/week (1.5% for VIP).** It never resets, but
  it always erodes.
- **Consequence:** this is the human player's win condition and retention
  hook. To hold or climb the public leaderboard you must **keep playing**.
  A decaying score is a far stronger "come back tomorrow" pull than a
  monotonic wallet.

### 1e. Everything else (content depth on top of the loop)
- **Player stats** (RR's model): *trainable* — skill, service, doubles,
  preferred surface; *fixed* — strength, speed, mentality, home advantage;
  *indirect* — talent (growth rate), endurance (fatigue resistance). Stats
  are shown openly, in "tennisballs" (20 skill = 1 ball).
- **Aging:** 15 → prime 20–25 → slow decline → retire at 40 (or convert to
  trainer earlier). Affects skill/service/strength/speed/endurance.
- **Trainers (coaches):** convert a player to a trainer; their trainer skill
  is *frozen* by a formula on their skill/service/doubles at conversion time
  — so converting too early wastes them.
- **Home advantage:** a player gets a skill bonus in tournaments in their own
  country (+4 base, +1 per 10 home-adv).
- **Doubles:** a full parallel stat, ranking, and tournament track using the
  same players. 40% of the doubles stat adds to skill in doubles matches.
- **Surfaces:** clay / grass / hard / indoor; affinity trainable but capped
  at 60% per surface.
- **Tournament tiers + points:** Grand Slam (1000) / Masters (500) / Intl
  Series Gold (300) / Intl Series (225) / Challenger (100/70/55) / Futures
  (24/18/12) / Amateur (6). Draw sizes 32/64/128; seeding protects the top
  ~1/4; non-power-of-2 draws give byes; qualification rounds feed `[Q]`
  seeds.
- **Rankings:** best-N over rolling 52 weeks (singles: best 18, with
  *obligatory* counting of Grand Slams/Masters you qualified for even if you
  skip them — a 0 that still burns a slot; doubles: best 14; juniors: best
  N). Cumulative, you only lose points when a result ages out.
- **Special formats:** Masters Cup (top-8, round-robin groups → knockout),
  Olympics (4-yearly, best-of-3 no-tiebreak), World Team Cup (Davis-Cup-like
  country teams), Practice Sessions (top-100, no ranking points, still give
  the *manager* 15 pts/win and train the player without touching form).
- **Clubs (guilds):** 3 managers to found; club ranking is a weighted sum of
  member manager rankings.
- **VIP monetization:** 4 players (but 1.5% decay instead of 1%), longer
  registration window, history/graph pages, one custom player per paid chip,
  holiday manager-sitting, VIP-only worlds, no ads. **Note the fairness
  design:** the extra roster slot is *paired with faster decay* — the exact
  pattern Grand Circuit's principle #1 already copies.

## 2. Where Grand Circuit stands vs RR

### What we already do well (and better)
- **Presentation & architecture are a generational leap.** RR is a
  grey-table, ad-slotted 2010-era site. Our game-feel UI, motion system,
  celebration moments, and card language are our real differentiator — the
  sim is *not* what will win users away from RR; the *experience* is.
- **Correct core copied faithfully:** rolling 52-week best-N rankings, aging
  curve, surface affinities (we copied the 60% cap), tier ladder,
  seeding/byes, coach conversion (frozen-at-conversion rating — same idea as
  RR trainers), fake-live replay, and now the **unified persistent player
  model** (candidates are real Players who never vanish — closer to RR, where
  players exist whether hired or not).
- **Junior circuit** with its own bands/rankings — RR has juniors too; ours
  is real and tested.

### What is fundamentally missing (priority order)
| # | Gap | Status | Why it matters |
|---|-----|--------|----------------|
| 1 | **Fatigue/Energy** | ❌ none | Without it, entering every tournament is strictly optimal. The entry planner has *no tension*. This is the moment-to-moment game. |
| 2 | **Form** | ❌ none | Same: punishes under/over-playing, forces a *rhythm*. Cheap to build. |
| 3 | **Manager ranking as a decaying ladder** | ⚠️ we have a *wallet* only | Our manager XP is spend-only (`ManagerXpPolicy` explicitly "never a rolling/decaying ledger"). We have no public "am I winning vs other managers?" answer. This is the meta-loop and retention hook. |
| 4 | **Player-driven development (Talent + hard-match XP)** | ⚠️ partial | Our growth is manager-XP/schedule-driven. RR's player-XP-from-hard-matches + Talent model is more satisfying and makes young prospects meaningful. |
| 5 | **Doubles** | ❌ none | Doubles roster utility & content from the *same* players, own ranking. Big scope, high payoff. |
| 6 | **Home advantage** | ❌ none | Trivial (we already generate host countries), high flavor, ties nationality to strategy. |
| 7 | **Special formats** (Masters Cup groups, Team Cup, Practice) | ❌ none | Content depth + a no-form training outlet (Practice) that pairs perfectly with fatigue/form. |
| 8 | **Obligatory-tournament ranking rule** | ✅ built & live (P9 — see `docs/ranking-realism-proposal.md`) | The "you must count the Slam even if you skip it" rule is what forces top players into the big events. |
| 9 | **Qualification rounds `[Q]`** | ✅ light model built (a fully simulated qualifying draw is still deferred) | Lets lower-ranked players earn a main-draw spot; deepens the ladder. |

### Attribute-model reconciliation note
RR: skill / service / doubles / surface (trainable); strength / speed /
mentality / home-adv (fixed); talent / endurance (indirect).
Ours: technical (serve/forehand/backhand/volley) / physical
(speed/stamina/strength) / mental (consistency/clutch) / surface.
We do **not** need to adopt RR's exact stats — ours are richer on the
technical axis. But we are missing the *indirect* stats that drive the
constraint systems: **endurance** (→ fatigue) and **talent** (→ growth
rate). Those two should be added as first-class attributes. Our existing
`stamina` physical attribute can *feed* endurance but is not the same thing
(stamina is an in-match strength input; endurance is a fatigue-accrual
modifier) — keep them distinct to avoid double-counting.

## 3. The potential / development problem — proposal

### The problem
RR shows current stats **openly**, plus a **development percentage** on each
player's profile page (e.g. "65%") meaning *this player is at 65% of the
ability they will eventually reach*. Combined with visible current stats you
can extrapolate the ceiling (current ÷ 0.65). The only "hiding" is friction:
it's on the profile page, not the hiring list, so you must open each player
to read it.

Grand Circuit currently has the opposite problem. We generate a **hidden
`potentialCeiling`** and a coarse noisy **`PotentialTier`** (Limited/
Promising/High/Elite) — but in the recent scouting-unification work we
**removed all of it from the UI** to enforce value-hiding. So right now a
manager has **no potential signal at all**, which is *too* opaque: signing a
14-year-old is a blind coin-flip with zero read, which isn't fun either.

### Design goals
- Give managers a **real, actionable read** on upside (so scouting is a
  skill, not a coin-flip)...
- ...without **handing them the answer** (preserve the RPG gamble and the
  payoff of watching a project bloom).
- Keep it **uniform** — per CLAUDE.md there is deliberately *no* per-manager
  scouting-skill system; everyone sees the same read on the same player.
- Reuse what we already have: `potentialCeiling`, `physicalCeilings`, and —
  importantly — `noiseProbabilityForAge`, which **already** scales scouting
  noise by age (younger = noisier). We are closer to a good design than it
  looks.

### Three options considered
- **A — RR-faithful "Development %"**: derive `dev% = currentAbility /
  potentialCeiling` and show a single number on the profile. Simple, proven,
  intuitive. Con: nearly fully transparent (kills the gamble); a bare number
  is low game-feel.
- **B — "Scout's projection" ghost bars**: on the profile, each attribute
  bar shows the current fill *plus a translucent projected-ceiling
  extension* ("ghost cap"), and an overall "Projected OVR ~88 — scout's read"
  with deliberate noise. Highly visual, very RPG, shows *per-attribute*
  headroom (this player's serve is near-maxed but their movement has room).
- **C — "Confidence narrows over time"**: the projection is *wide and fuzzy*
  for young players and *sharpens* as they age and play. Signing young is a
  genuine gamble; watching them develop **resolves** the uncertainty — and
  the resolution is a natural celebration moment (we already have the infra).

### Recommendation — a hybrid of B + C (we already have most of C)
1. **Derive, don't store, a development read.** `dev% = currentOverall /
   projectedCeiling`. Projected ceiling comes from the existing hidden
   `potentialCeiling` (overall) and `physicalCeilings` (per physical attr).
   No new stored field for the ratio.
2. **Expose it only on the profile, never on the list** — this *naturally*
   reproduces RR's "open each player to scout" ritual without artificial
   friction. The scouting list stays clean (observable OVR + age only).
3. **Render it as ghost-cap bars (option B):** current fill solid, projected
   ceiling as a translucent extension per attribute, plus one headline
   "Projected ceiling ~NN (scout's read)".
4. **Make the projection age-fuzzed (option C), reusing
   `noiseProbabilityForAge`:** for a 14-year-old show a *band* ("projected
   82–90") that is wide; for a 22-year-old show a tight band or a near-exact
   cap. As the player ages/plays under a manager, the band tightens — the
   scout learns more. This keeps young signings a real bet while making
   scouting legible.
5. **Resolution = celebration.** When a young project's tightening band first
   confirms an Elite-class ceiling, or when they cross an OVR milestone that
   validates the early bet, fire a celebration moment (reuse GC-16 infra).
   This turns the *hidden* model into an emotional payoff instead of just
   withheld data.

Net effect: we keep our hidden-ceiling generation exactly as-is, add a
**derived, age-fuzzed, profile-only, per-attribute ghost-bar projection**,
and get a scouting experience that is *legible like RR* but *more of a
gamble and more of a payoff* — a genuine improvement on the inspiration
rather than a copy. Talent (growth-rate stat, §4 P4) feeds the same view:
"high talent, low current, wide-but-high projection" is the textbook
blue-chip prospect card.

## 4. Build plan (phased)

Phasing is by dependency and by "smallest change that adds real tension
first". Each phase is shippable on its own.

### Phase 1 — Constraint systems (the actual game) 🔴 highest priority
- **P1. Fatigue/Energy.** Add `endurance` attribute + a per-player `fatigue`
  counter. Accrue fatigue in `SimulateMatchUseCase` from points-played,
  reduced by endurance. Recover on the weekly tick (`AdvanceWorldWeekUseCase`
  — scale the 50/day rule to our tick cadence). Apply a strength penalty in
  `StatisticalMatchSimulator.effectiveRating` above a threshold. Surface
  fatigue on the profile + roster + entry planner (so the tension is
  *visible* before you commit).
- **P2. Form.** Add a per-player `form` counter (+1/real match, decay/week).
  Apply skill/serve penalty below/above the sweet-spot band; small bonus in
  band; reduce XP gain out of band. Show a form gauge on roster + planner.
- **P3. Manager ranking ladder.** Add a **decaying** manager-points ledger
  *alongside* the existing XP wallet (do NOT replace the wallet — RR has
  both). Credit points on player results (same event point as ranking-ledger
  writes); decay ~1%/tick. Build a public **Managers leaderboard** page. This
  is the retention meta-loop.

### Phase 2 — Development depth 🟡
- **P4. Talent + player-XP development.** Add `talent` (growth-rate) +
  player `experience`. Award match XP scaled by *opponent difficulty / loser
  points* (hard matches teach more), plus weekly talent XP. Feed XP into the
  existing per-attribute training so growth is *earned by playing*, not only
  bought with manager XP. Reconcile with the current training-schedule model.
- **P5. Potential/development view.** Implement §3's recommendation
  (derived, age-fuzzed, profile-only ghost-cap projection + resolution
  celebration). Depends on P4's `talent` for the full prospect card.

### Phase 3 — Content depth 🟢
- **P6. Home advantage.** Add `homeAdvantage` attribute (or derive from
  nationality match). Apply bonus in the sim when player nationality ==
  tournament host country (we already store host country on generated names).
- **P7. Doubles.** Parallel `doubles` stat, doubles draws in `Tournament`,
  doubles ranking band, doubles entries. Large — scope as its own doc when
  reached.
- **P8. Special formats.** Practice Sessions first (pairs with fatigue/form
  as a no-form training + manager-points outlet), then Masters Cup
  (round-robin groups), then World Team Cup.
- **P9. Ranking realism.** ✅ DONE. Obligatory-tournament counting rule (live
  on the weekly rollover) and the light qualification-rounds `[Q]` model —
  see `docs/ranking-realism-proposal.md`. Only the full, genuinely simulated
  qualifying draw remains deferred.

### Deliberately NOT copying RR
- RR's grey-table UI and per-page ad slots (our differentiator is the
  opposite).
- RR's *fully open* stats + list-hidden potential friction (we replace it
  with the profile-only ghost-bar scout read — legible but a real gamble).
- Any pay-to-win beyond the disclosed, cost-paired exceptions already in
  principle #1.

## 5. Open questions for the owner
1. **Form + fatigue tuning to our tick cadence.** RR is real-time-ish
   (50 fatigue/day, −8% form/week). Our world advances per weekly tick (with
   a fast dev override). We need to decide whether fatigue recovers
   *per-tick* or on a finer sub-tick clock, and re-derive the constants. This
   is the main balance question and should get its own tuning pass.
2. **Should the manager ladder decay be visible-tier-gated** (e.g. no decay
   below some floor so new managers aren't punished) or a flat 1%/tick like
   RR? RR uses flat; a floor may be friendlier for onboarding.
3. **Doubles** is a large surface — build it only once Phase 1 proves the
   core loop retains users, per the project's anti-over-engineering stance.
