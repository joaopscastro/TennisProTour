# Manager XP economy & coach conversion

This activates the "Manager & Progression" bounded context, stubbed
since the original domain model as "⬜ not started." Design based on
three confirmed decisions:
- XP accrues **ongoing**, from match/tournament results while a player
  is active on the roster — not from releasing/retiring players.
- Claiming a talent pool candidate now **costs XP**, priced by the
  candidate's current ability — not free-to-claim as originally built.
- Converting a player into a coach **also costs XP**, as a separate
  spend from claiming.

## 1. XP accrual

Whenever a rostered player's match result gets recorded (same event
point as ranking-ledger writes — `TournamentCompleted`/match outcome
recording), award the player's manager some XP. Keep the formula
simple and reuse existing signals rather than inventing new ones:

- Base XP per match played (participation has some value).
- A win bonus on top of the base.
- A tier multiplier (major-tier XP > futures-tier XP), matching the
  same tier-weighting logic already used for ranking points.

This is a straightforward extension of the same wiring that already
feeds `RankingLedgerEntry` writes — no new event-plumbing needed, just
an additional write alongside the existing one.

XP is a **simple cumulative balance per manager**, not a rolling/decaying
ledger like rankings — it's a spendable currency, not a competitive
standing, so there's no real-world analog requiring expiry.

## 2. Player quality score (internal, reused for pricing)

`PlayerAttributes.overallRating()` already exists (the same 0-100
average used for the roster dashboard's OVR display) — reuse this
directly as the "current ability" input to pricing, rather than
inventing a second scoring formula. Two different systems computing
two different "how good is this player" numbers would be a real,
avoidable source of confusion later.

## 3. Talent pool claim pricing

Replace the current free-claim mechanic: claiming a candidate now costs
XP, computed from the candidate's `overallRating()` via a
`TalentClaimPricingPolicy` (same swappable-policy pattern as
`AgingPolicy`/`TrainingPolicy`). Recommended shape: cost scales
**super-linearly** with ability (e.g. `cost = baseCost * (rating /
50)^exponent` with exponent > 1) so that strong players are
disproportionately expensive relative to mediocre ones — this is what
actually creates the "you need to have earned your way up to afford a
real talent" feeling, not just a flat per-point cost.

The existing race-safety requirement (atomic claim, no double-claims
under concurrent attempts) now has a second dimension to protect:
a manager without enough XP must not be able to claim at all, and the
claim + XP debit must happen atomically together — a manager's balance
check and the deduction can't be two separate steps with a race window
between them, or two near-simultaneous claims could both pass the
balance check before either deducts.

## 4. Coach conversion

A new mechanic: a manager can convert an **existing roster player**
into a coach, spending XP. This is a real, consequential decision:

- The player **leaves the roster entirely** — they stop being a
  competing player (matches the real-world "retired player becomes
  coach" framing) and their roster slot becomes free again, which is
  itself a meaningful side effect worth surfacing clearly in the UI
  later (not just "spent XP, got a coach" — also "gained a roster
  slot back").
- Conversion cost scales with the player's ability **and age** at the
  time of conversion — an older, more accomplished player should cost
  more to convert but also produce a better coach, matching the
  original framing ("the older and more skilled the player, the
  better manager it should convert for better training efficiency").
- The resulting **Coach** has a single `coachRating` derived from the
  source player's ability and age at conversion — deliberately kept as
  one generic rating rather than building specialized coach types
  (e.g. separate surface/skill-cluster coaches). That kind of
  specialization is a legitimate future idea, not something the MVP
  needs — noted here explicitly so it's a documented deferral, not a
  forgotten gap.
- A manager's coach(es) apply a **training-efficiency multiplier** to
  `TrainingPolicy`'s computed delta — e.g. `finalDelta = baseDelta *
  (1 + coachBonus)`, where `coachBonus` scales with `coachRating`.
  This is the payoff that makes the whole conversion decision matter
  gameplay-wise, not just narratively.

## 5. Open questions to resolve before/during implementation

- **How many coaches can a manager have at once? — RESOLVED.** Free
  tier is capped at 1 coach; **Manager Pro raises the cap to 2**
  (`FREE_COACH_CAP`/`PRO_COACH_CAP` in `coachCap.ts`, checked via
  `BillingPort.isProSubscriber` the same way roster-slot capacity
  already is). This is a **deliberate, disclosed exception** to the
  project's usual "money buys convenience and cosmetics, never an
  unconditional win-rate boost" guardrail (CLAUDE.md principle #1) —
  not something to dress up as pure convenience. A second coach is a
  real, if modest and slow-compounding, competitive edge: it only ever
  affects how fast a player's attributes grow via training, never a
  match outcome directly, but it IS an edge a free-tier manager cannot
  match no matter how well they play. The honest framing, both here
  and on the Manager Pro page, is "a second coach slot — a real
  training-speed edge, not just convenience," never folded in
  alongside the zero-effect-on-competitiveness perks.
- **Can a coach later be released/replaced**, or is conversion a
  permanent, one-way commitment per coach slot? — RESOLVED:
  conversion is **permanent**. There is no release/replace/undo path;
  "which player to convert" is a one-time, irreversible choice per
  coach slot, matching the real-world "retired player becomes coach"
  framing this feature is modeled on.
- **Exact pricing constants** (base cost, exponent, age-scaling factor
  for coach conversion) are inherently placeholder until real playtesting
  — flag them as such in code/tests, same discipline as the aging
  thresholds and ranking point values elsewhere in this project.

## Sequencing note

This is domain/economy work first, UI second — same reasoning as the
ranking system and the training-focus persistence work earlier in this
project. Don't brief Claude Design on the claim-cost or coach-conversion
UI until Claude Code confirms the actual pricing numbers and the coach
data shape — designing against invented placeholder numbers would very
likely need a second pass once real ones exist, the same mismatch
that's bitten this project more than once already.
