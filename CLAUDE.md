# CLAUDE.md — Tennis Manager RPG

This file gives Claude Code the context that was built up over a planning
session in claude.ai chat, before any code was committed to this repo.
Read this in full before making architectural decisions — it captures
*why*, not just *what*, and several decisions here reverse an earlier,
less-considered version (e.g. the live-scoring approach), so don't
re-derive from first principles without checking this first.

See also: `docs/business-plan.md` (or wherever `tennis-manager-rpg-plan.md`
gets placed in this repo) for the full business/market rationale. This
file is the technical/architectural distillation of that document.

## Project one-liner
A free, fair (non-pay-to-win), browser-first tennis manager RPG —
positioned as "Rocking Rackets, rebuilt and maintained" — targeting the
orphaned community of Rocking Rackets and Online Tennis Manager, two
long-unmaintained browser games with active but underserved players.

## Non-negotiable design principles

1. **Money buys convenience and cosmetics, never an unconditional
   win-rate boost.** Where a paid perk does touch competitiveness (e.g.
   extra roster slots), it must be paired with a real, built-in cost
   (e.g. faster stat/point decay) — never a flat unlock. This is
   modeled directly on Rocking Rackets' own VIP system, which is
   genuinely well-designed on this front.
   - **One explicit, narrow, disclosed exception: Manager Pro's second
     coach slot.** Free tier is capped at 1 coach; Pro raises the cap
     to 2 (`FREE_COACH_CAP`/`PRO_COACH_CAP` in
     `packages/application/src/use-cases/coachCap.ts`). Be precise
     about what this is: a second coach IS a real competitive edge —
     it applies a training-speed multiplier
     (`TrainingPolicy.applyCoachBonus`) that a free-tier manager
     cannot match no matter how well they play — not merely a
     "convenience" being mislabeled. It carries no offsetting cost the
     way the extra-roster-slot perk does (that one is paired with
     faster stat/point decay; this one isn't paired with anything).
     This was a deliberate decision, made and disclosed honestly here
     and on the Manager Pro page (never folded in among the
     zero-effect-on-competitiveness perks, never described as "pure
     convenience"), not a silent violation of this principle
     discovered later. Everything else about coaching stays fair:
     conversion cost and the resulting `coachRating` are priced by the
     same formula (`CoachConversionPolicy`) for every manager
     regardless of tier, and talent-pool claim pricing
     (`TalentClaimPricingPolicy`) is likewise identical for everyone —
     the exception is scoped to *this one cap*, not the coaching
     system's economics in general. See
     `docs/manager-xp-and-coaching-system.md` section 5 for the full
     reasoning.
2. **Avoid the Football Manager complexity trap.** No 3D/graphical
   match engine, no deep tactical instruction trees, no board-politics
   or press-conference sub-games, no attempt to model real players or a
   real-world database. Text/stat-based results (closer to 1992's
   original Championship Manager) are enough — that's *why* the genre
   is addictive in the first place, not despite it.
3. **Avoid the Tribal Wars destructive-PvP trap.** Competition should
   feel like Rocking Rackets' point-decay ranking system (you fall in
   rank, you don't get wiped out) — not elimination-style conquest.
   Also avoid Tribal Wars' sprawling building/unit tech-tree; the
   existing stat model (technical/physical/mental + surface affinity)
   is the right scope, don't expand it without a specific reason.
4. **No real-time infrastructure for match viewing. This is the most
   important scalability decision made so far — do not reintroduce
   WebSockets/SSE for live scoring without revisiting this document
   first.** Matches are fully simulated synchronously the moment
   they're due (triggered by a scheduled job, never by a live viewer
   request), producing an immutable replay log (game-by-game score
   deltas + relative timestamps). The frontend fetches that log once
   via a normal HTTP GET and fakes the live experience client-side on a
   timer — exactly Rocking Rackets' own "pre-simulated, frontend fakes
   live" pattern. This makes viewer count irrelevant to backend cost,
   which is the single biggest lever for supporting many concurrent
   game-worlds cheaply.
5. **Hexagonal architecture / ports & adapters, strictly.** `domain/`
   has zero framework or infrastructure imports, ever. Application
   layer depends only on ports (interfaces); adapters implement them.
   Different bounded contexts only ever reference each other by ID
   (`PlayerId`, `TournamentId`, etc.), never by importing another
   context's aggregate directly.
6. **SOLID discipline, actively enforced, not just aspired to:**
   - Repository interfaces are split per aggregate (`PlayerRepository`,
     `TournamentRepository`), not one shared god-interface (ISP).
   - Domain services (like `PlayerAgingService`) exist separately from
     entities specifically when the logic is a swappable *policy*
     (different aging curves for fast vs. slow game-worlds), not
     because "services" are a default pattern to reach for (SRP + OCP).
   - `MatchSimulator` is an interface a concrete class implements, so a
     future, more elaborate simulator can replace
     `StatisticalMatchSimulator` without touching any caller (OCP +
     DIP).
   - **Never reach into an aggregate's private state via an `as unknown
     as {...}` cast from outside the aggregate.** This happened twice
     during the initial domain-model build and was caught both times —
     add a proper public accessor method on the aggregate instead
     (e.g. `Tournament.getScheduledMatch()`).

## Player acquisition: the talent pool (hiring is scarce, not on-demand)

**This reverses an earlier, simpler version of this document/build,
same as the live-scoring approach did — don't re-derive "just let a
manager hire whoever they type in" from first principles.** Hiring
used to be instant and on-demand: a manager typed a name/nationality
and got a player immediately, with fixed baseline attributes. That's
gone. As of the talent-pool feature, acquiring a player works like
this:

- **A shared talent pool, not a hire button.** `PlayerGenerationPolicy`
  (a swappable policy, same pattern as `AgingPolicy`/`TrainingPolicy`)
  generates full players — name, nationality, age, and a complete
  `PlayerAttributes` snapshot — from a rarity-skewed distribution: most
  generated players are mediocre, a small share are strong, and a
  genuinely rare share are exceptional. A weekly worker job
  (`RefreshTalentPoolUseCase`, riding the same tick as aging) tops the
  pool up with a fresh batch and expires any candidate that's sat
  unclaimed for more than ~2 weeks. **Audited, not assumed**: this
  really does run on the weekly world-tick cadence it's scoped for —
  `apps/worker/src/index.ts` registers a real BullMQ repeatable
  scheduler against `advance-world-week`, whose handler
  (`makeAdvanceWorldHandler`) calls `RefreshTalentPoolUseCase.execute()`
  (and `GenerateJuniorTournamentsUseCase.execute()`) gated on the same
  tick actually having advanced the world clock. Unlike junior
  tournament generation (which had to be built from nothing in an
  earlier pass), this wiring was already correct — confirmed by reading
  the real scheduler + handler + composition wiring end to end, not by
  assuming a doc comment was still true.
- **Every generated player's age comes from `PlayerGenerationPolicy`
  itself now, not a fixed constant.** `generate(random, ageRange)`
  takes an `AgeRange` (`{ minWeeks, maxWeeks }`) as a real parameter —
  the generator has no opinion on what range is "correct," the same
  swappable-policy discipline as `AgingPolicy`/`TrainingPolicy`.
  `TALENT_POOL_AGE_RANGE` (`packages/application/src/use-cases/talentPoolAgeRange.ts`)
  is the one CALL-SITE decision both `RefreshTalentPoolUseCase` and
  `CreateCustomPlayerUseCase` import and pass: 14-16 years old,
  representing new young talent entering the world — growth past this
  happens entirely through `PlayerAgingService`'s weekly ticks over
  real in-game time, never by generating someone directly older.
  There's still no manager-chosen age anywhere (unchanged fairness
  constraint). Scouting's noise is now age-scaled too, not flat:
  `noiseProbabilityForAge` linearly interpolates the off-by-one
  probability from ~20% per direction at the youngest age a range can
  produce down to ~10% at the oldest — scouting a 14-year-old's
  eventual ceiling is genuinely harder than a 16-year-old's, real years
  of development still separate them from their peak. **14 years =
  exactly 14×52 = 728 weeks, which is precisely `RankingBand`'s
  U14/U16 boundary (`juniorEligibilityForAge`) — this WAS a real bug,
  now fixed, not just a worth-knowing consequence to live with.** The
  boundary check used strict `<` (`ageInWeeks < U14_MAX_AGE_WEEKS`),
  so an exactly-14.000-year-old player fell through to U16 — meaning no
  generated player could EVER land in U14, only U16 or older, no matter
  how the age range was tuned. Real Tennis Europe eligibility is
  inclusive ("14-and-under"), so the check is now `<=` on both
  boundaries (both `U14_MAX_AGE_WEEKS` and `U16_MAX_AGE_WEEKS`) — the
  fix is to the boundary check, not the age range, which was already
  correctly scoped. A real player claimed at exactly
  `TALENT_POOL_AGE_RANGE.minWeeks` is now genuinely U14-eligible
  (`RankingBand.test.ts` pins this exact case). Practically, though,
  U14 is now **reachable, not abundant**: only that single exact
  integer week out of the range's ~103-week spread qualifies (~1 in
  206 generations), so real U14 supply in the weekly batch stays rare
  by construction — a deliberate range decision to revisit later if
  U14 depth ever matters, not something this fix changed. This closes
  the gap the junior-circuit work disclosed (see
  `docs/junior-circuit-research-and-proposal.md`): a real player can
  now genuinely reach BOTH the U14 and U16 ladders through the real
  acquisition flow (proven end-to-end by
  `apps/api/src/scripts/seedJuniorCircuitWalkthrough.ts`, which claims
  every player through the real `ClaimTalentPoolCandidateUseCase` — no
  `Player.hire()` shortcut, including a player deliberately claimed at
  the exact boundary age to prove U14 reachability, not just U16).
- **Population math, sanity-checked, not just trusted constants.**
  `TALENT_POOL_BATCH_SIZE` = 5/week, `TALENT_POOL_EXPIRY_WEEKS` = 2 —
  a candidate generated in week *W* is still visible during the
  refreshes at *W*, *W+1*, and *W+2* (three refresh cycles, since
  expiry triggers only once `weeksBetween > 2`), THEN gets swept at
  *W+3*'s refresh. So the steady-state visible pool (upper bound, zero
  claims) is batch × **3**, not batch × 2 — 5 × 3 = **~15 candidates**
  visible at once. Tier odds are the existing, unchanged
  `StandardPlayerGenerationPolicy` skew (3% exceptional / 17% strong /
  80% common — real Common/Uncommon/Rare-style scarcity, not relabeled
  here). At batch size 5, expected exceptional-tier candidates per week
  = 5 × 0.03 = **0.15/week** (~0.65/month at ~4.33 weeks/month); the
  chance of at least one appearing in a given week is
  1 − 0.97⁵ ≈ **14%** — about 1 week in 7. That preserves genuine
  scarcity: frequent enough the pool never feels barren (strong-tier
  candidates land ~0.85/week, most weeks have several worthwhile
  common-tier options), but an exceptional prospect appearing stays a
  real, race-worthy event rather than routine background noise. Given
  roster caps are tiny (2 free / 4 Pro — see `rosterCap.ts`) and
  players are never automatically removed, a 15-deep pool is already
  generous relative to real demand, so this pass keeps the batch size
  at 5 rather than changing it — the math validates the existing
  constant instead of replacing it with a different unvalidated one.
- **Every manager sees the same pool and races for it.**
  `TalentPoolCandidate` rows are visible to all managers until claimed
  or expired. Claiming is genuinely race-safe: two managers hitting
  "claim" on the same candidate within milliseconds of each other
  cannot both succeed — `TalentPoolCandidateRepository.claimIfAvailable()`
  is a single atomic conditional `UPDATE ... WHERE status = 'available'`,
  not a read-then-write, so Postgres itself (not application-level
  locking) guarantees exactly one winner. This is proven by a real
  integration test that fires concurrent claims at actual Postgres, not
  just an in-memory fake.
- **Scouting is a real page (`/scouting`, fulfilling the sidebar item
  that used to say "SOON"), and it has a real hidden/observable split —
  read this before touching `PlayerGenerationPolicy` again.** Every
  generated player also gets a `potentialCeiling`: a hidden number
  (skill-scale, anchored to the rarity tier's own band so a player's
  ceiling is never below what they can already do, with genuinely
  independent headroom on top) capping how far training can grow their
  skill clusters — see `TrainingPolicy.applyPotentialDiminishingReturns`
  and `Player.applyTraining`, which taper a training session's delta
  linearly to zero as a skill cluster's current average nears the
  ceiling. Surface affinity is deliberately NOT gated by this at all
  (same "surface is an unrelated axis from rarity" simplification the
  generation policy already makes). The API/scouting screen expose
  current attributes/OVR **precisely** (they're observable — a manager
  scouting a candidate can just look), but potential is exposed ONLY as
  a coarse `PotentialTier` (Limited/Promising/High/Elite), computed
  from the hidden ceiling with intentional noise (~70% exact, ~15%
  each direction off-by-one, baked in once at generation time so it's
  stable per-candidate, not recomputed per-request) — the real ceiling
  number is never serialized anywhere; grep `potentialCeiling` in any
  new DTO/route code and it should only ever appear in adapter-internal
  mapping functions, never in a response body. **There is deliberately
  no per-manager scouting-skill/accuracy system** — every manager sees
  the exact same noisy tier on the exact same candidate, full stop.
  This is a conscious scope decision, not a placeholder for "add
  scouting skill later": a differentiated-accuracy system (better
  scouts see truer potential) is a legitimate, understood idea that was
  deliberately left out to keep this feature's surface area matched to
  what it needed to prove, the same "avoid systems for their own sake"
  discipline `docs/tennis-rules-gap-analysis.md` applied elsewhere in
  this codebase — revisit only with a real reason, not by default.
- **Manager Pro can bypass the pool, never beat it on stats.**
  `CreateCustomPlayerUseCase` lets a Pro manager name their own player
  instead of waiting for a matching candidate — but it calls the exact
  same `PlayerGenerationPolicy` every pool candidate uses. Paying only
  buys skipping the queue, never better odds or better stats — this is
  principle #1 applied directly to this feature, and it's worth
  restating here because it's an easy line to blur by accident: if a
  future change gives custom players their own rarity curve "since
  they paid," that is the pay-to-win pattern this project exists to
  avoid. One custom-player credit is earned per confirmed Stripe
  subscription **renewal** (not the initial signup, and not an
  invented in-game clock — real `invoice.paid` webhook events with
  `billing_reason: subscription_cycle`), spent one at a time.
- **Mental attributes generate already mature; physical attributes each
  get their own hidden training ceiling — the generation-time slice of
  the per-attribute training redesign (see
  `docs/training-redesign-per-attribute.md` for the full three-
  philosophy design: technical open-ended, physical capped per-
  attribute, mental untrainable).** `PlayerGenerationPolicy.generate()`
  now rolls consistency/clutch via a SEPARATE `rollMatureSkill()` path
  (55-90, independent of both rarity tier and age — see
  `MENTAL_MATURE_MIN`/`MAX`'s doc comment for why that specific range:
  it brackets where a "strong veteran" mental stat already landed
  under the old flat-band system after a full career of training,
  since mental attributes will never train at all under the new
  design and starting them at a youth-tier low would leave every
  player mentally underdeveloped forever with no way to fix it).
  Physical attributes (speed/stamina/strength) each get an independent
  `physicalCeilings.{speed,stamina,strength}` — three separate rolls,
  not one number reused across all three — each anchored to that
  specific attribute's own already-rolled current value (never below
  what the player can already do at that attribute), with its own
  headroom on top, same scale as the existing overall
  `potentialCeiling`. Threaded through `TalentPoolCandidate`/`Player`/
  the DB exactly like `potentialCeiling` already was, and held to the
  same non-exposure discipline (grep `physicalCeilings` in any new
  DTO/route code — it should only ever appear in adapter-internal
  mapping functions). **Update — the per-attribute training piece this
  disclosure used to flag as missing is now built** (see
  `docs/training-redesign-per-attribute.md`'s status note):
  `TrainingFocus` is single-attribute selection
  (`{kind:'attribute',attribute:TrainableAttribute}`), and
  `TrainableAttribute = TechnicalAttribute | PhysicalAttribute`
  structurally excludes mental — not a runtime check, a real
  compile-time impossibility (`TrainingPolicy.test.ts`'s
  `@ts-expect-error` cases fail `tsc --noEmit --strict` if this ever
  regresses). `Player.applyTraining()` now reads the correct value per
  branch: technical attributes apply the training delta with no
  ceiling at all (decay during decline is the only thing that ever
  reduces them); physical attributes gate via
  `TrainingPolicy.applyPotentialDiminishingReturns` against that
  attribute's own `physicalCeilings.{speed,stamina,strength}` entry —
  the SAME smooth-taper formula already used for the scouting
  `potentialCeiling` gating, reused as-is rather than a second
  slightly-different plateau curve. (The coach-rating/conversion-cost
  cap in `CoachConversionPolicy` looks similar but is a different,
  hard `Math.min` clamp — not a smooth taper, not what got reused
  here.) One disclosed side effect worth knowing: because `Skill.of()`
  always rounds to an integer, iterative training toward a ceiling can
  plateau one point short of the exact ceiling value rather than
  reaching it exactly — a real characteristic of integer-rounded
  values meeting a continuous decay curve, not a bug (see
  `Player.test.ts`'s physical-training test for the worked example).
  **Still not done**, unchanged from before: the surface × attribute
  weighting table from the same doc isn't wired into
  `StatisticalMatchSimulator` or anywhere else — training which
  attribute you improve doesn't yet interact with which surface you
  play on.
- **Where this lives, and why it's pragmatic, not dogmatic:** the
  talent pool is really the first real slice of bounded context #4
  (Manager & Progression)'s "scouting" idea below — but
  `PlayerGenerationPolicy`/`TalentPoolCandidate` live in
  `domain/player/`, not a separate context folder, because they're
  fundamentally about generating *Player*-shaped things, and the
  surface area is small enough that a dedicated bounded context would
  be premature (contrast with ranking, which got its own `domain/ranking/`
  folder because it was large enough to justify one). Revisit this
  placement if scouting grows real scope beyond "generate + claim."
- **One more pre-existing, unrelated bug, found while re-verifying this
  pass — now actually fixed, not just disclosed:**
  1. **Fixed.** Claiming a talent-pool candidate costs XP
     (`TalentClaimPricingPolicy`), but `apps/api/src/scripts/seed.ts`
     (the actual dev seed script) and `apps/worker/src/e2e.smoke.test.ts`
     both used to claim candidates without ever crediting the claiming
     manager's XP balance first, so both failed with "insufficient XP
     to claim this candidate" — this is the exact error a fresh
     `npm run setup` hit for anyone actually trying to run the project
     locally, not just a theoretical gap. Introduced when XP-gated
     claiming shipped after both were written; neither was updated at
     the time. Both now credit each manager (`deps.managerXp.credit(...)`,
     100_000 XP — deliberately far above any real claim cost, not a
     tuned number) before their first claim, same pattern
     `api.integration.test.ts`'s `hirePlayer()` helper and
     `billing.integration.test.ts` already used correctly. Verified by
     actually running `npm run seed` against a live, freshly-truncated
     database (not just reading the diff) and the worker's e2e smoke
     test, both green.
  2. `composition.ts` builds `rankPosition`/`rankPositionU14`/
     `rankPositionU16` once, at startup, against a single module-level
     `WorldId` (`WORLD_ID` env var, default `'main'`) — not
     parameterized per call. This is correct for how this game actually
     runs today (one live world at a time), but any script or tool that
     operates on a *different* world id (e.g.
     `seedJuniorCircuitWalkthrough.ts`'s dedicated `junior-walkthrough`
     world) must set the same `WORLD_ID` env var, or its ranking reads
     silently use the wrong world's clock for the rolling-window
     calculation (`RankingCalculationService.calculateTotal` filters by
     `weeksBetween(entry.weekEarned, currentWeek)`, and `currentWeek`
     would come from an unrelated world). Found while building that
     walkthrough script; not a bug in the single-world game as it
     actually ships, but a real footgun for any multi-world tooling.

## Committed stack (with rationale — see full plan doc for the "why not X" reasoning)

| Layer | Choice |
|---|---|
| Domain/application | Plain TypeScript, framework-agnostic |
| API framework | Fastify (not NestJS — its DI container tends to fight hexagonal boundaries) |
| ORM / DB | Drizzle + PostgreSQL (not Prisma — less codegen magic, cleaner repository adapters) |
| Scheduled jobs | BullMQ + Redis |
| "Live" match viewing | No WebSockets/SSE — pre-simulate + replay log + client-side fake-live playback (see principle #4) |
| Replay log storage | Object storage (S3/R2) behind a CDN, or Postgres JSON column at small scale |
| Billing | Stripe, behind a `BillingPort` interface |
| Frontend | Next.js/React — chosen for DX as a solid React default, not because the logged-in dashboard needs SSR (it's really an SPA behind auth; SSR mainly benefits the public marketing page) |
| Notifications | Email (Postmark/Resend) + push (OneSignal), triggered by domain events |
| Hosting | One provider for everything at MVP (Railway or Fly.io) — do not split Next.js onto Vercel and the API/worker onto a second platform yet; that's a two-platform ops burden with no benefit at this scale |

## Monorepo layout
```
tennis-manager/
  packages/
    domain/        # bounded contexts, framework-free
    application/   # use cases + ports, one folder per context
  apps/
    api/           # Fastify HTTP adapters (inbound) + Drizzle/Stripe adapters (outbound)
    worker/        # BullMQ job handlers: weekly ticks, aging, match simulation batch runs
    web/           # Next.js frontend (manager dashboard + marketing page)
```

## Bounded contexts
1. **Player & Roster** — player entities, stats, aging, training. ✅ domain skeleton built.
2. **Competition** — tournaments, brackets, rankings, match scheduling. ✅ domain skeleton built. 🟢 The junior circuit (see `docs/junior-circuit-research-and-proposal.md` for the full research/design and an honest built-vs-drifted status) is real and tested, not a skeleton: `TournamentTier` spans the six real ITF-sourced J-grades (`j30`-`j500`, `StandardRankingPointsTable`'s champion values are sourced, not guessed) plus an explicitly placeholder-flagged `juniorMasters` capstone (`isUnsourcedPlaceholderTier`), with `AgeBand` (`u14`/`u16`) living on `Tournament`/`RankingLedgerEntry` rather than baked into the tier — the same six grades work identically for both bands. Each band gets its own independent ranking (`RankPositionQuery` scoped to a `RankingBand`; `RankingCalculationService` reused with `bestResultsCap` parameterized to 6, the real ITF rule, vs. 18 for the senior tour — one service, not a duplicate). A junior weekly entry cap (`JUNIOR_WEEKLY_ENTRY_CAP` = 3, the real ITF number) is enforced in `RegisterEntrantUseCase`, scoped to junior tiers only. A graduation carryover (`GraduationCarryover.ts`) records a dormant bonus on `Player` when a weekly aging tick crosses a U14→U16 or U16→senior boundary, consumed only by that player's first real (`points > 0`) result in the new band, then cleared — it never manufactures a ranking-ledger entry by itself. `GenerateJuniorTournamentsUseCase` (riding the same weekly worker tick as aging/talent-pool refresh) keeps the ladder abundantly populated — decreasing frequency/increasing draw size from J30 up to J500, `juniorMasters` held once a season and gated by live ranking position (top 16 invited, never open registration; a band without 16 ranked players is skipped rather than faked). Fixing this junior work also fixed a real pre-existing bug: `pointsFor(tier, roundsWon=0)` used to return full base points for a first-round loss at every tier, senior included — a ranking must be earned by an actual win, never granted for participation or for merely aging into eligibility, and `RankPositionQuery` now excludes a zero-qualifying-result player from the ranked list entirely (genuinely "NR") instead of floor-ranking them at zero, for the senior query too. **Known, disclosed gaps, not silently left out**: no tournament ever gets a display name (junior or senior — there's no `name` column at all, so the original design's "tournament names must be original" constraint has nothing to attach to yet); open tournaments never expire if their draw doesn't fill. **Update — real frontend surface now exists for the parts that matter most day-to-day, AND the age-vs-band gap this section used to flag is now fixed, not just disclosed**: the age-band badge (U14/U16, no badge = senior) shows on every tournament row/header and on a roster-dashboard player's Rank column (scoped to whichever band `juniorEligibilityForAge` says that player's current age qualifies for — `DrizzleRosterDashboardQuery` reads all three `RankPositionQuery` instances now, not just the senior one). `RegisterEntrantUseCase` now enforces `isAgeEligibleForTournamentBand` (`RankingBand.ts`) for any junior-tier registration: a player may "play up" into an older junior band (a real, deliberately-allowed case — see that function's doc comment) but may not play down into a younger one, and a senior player may not enter either junior band at all — this is deliberately ONE-DIRECTIONAL, matching real tennis: a junior player entering the SENIOR tour remains completely unrestricted (many top players turn pro before 18; see the "Under-18 players in senior tournaments" clarification below if that's ever in doubt again), that was never the gap. `EnterTournamentModal` disables both an over-cap AND an age-ineligible junior entry attempt up front (not just after a failed POST), via a `GET /tournaments?status=open&playerId=` extension that attaches `juniorEntryCountThisWeek`/`juniorEntryCapThisWeek` (`countJuniorEntriesForWeek` in `juniorEntryCap.ts`, shared with `RegisterEntrantUseCase` so the two never drift) and `ageEligible` (same `isAgeEligibleForTournamentBand` the use case itself calls). What's still genuinely missing: no dedicated junior standings/leaderboard page (a manager can only see a band's ranking through their own rostered players' rows, never browse the full U14/U16 tables).

**Under-18 players in senior tournaments — deliberately unrestricted, verified, not a gap.** A junior-age player registering for the SENIOR tour (`futures`/`challenger`/`tour`/`major`, `ageBand: null`) has never been blocked and should never be: real tennis has no such floor (teenagers turning pro before 18 is normal), and `isAgeEligibleForTournamentBand` returns `true` unconditionally for `null` (verified directly against `RegisterEntrantUseCase` with a real 15-year-old `Player` and a real senior tournament — succeeded with zero errors, both before and after the age-eligibility fix above). Don't reintroduce a senior-tour age floor without a specific reason — it would contradict this deliberate design decision, not just add a missing check.
3. **Match Simulation Engine** — deterministic sim, pure domain logic, no I/O. ✅ domain skeleton built.
4. **Manager & Progression** — manager XP, staff, scouting. 🟢 domain/economy AND a real UI surface now: scouting (the talent pool — see "Player acquisition" above), manager XP accrual, and a first staff mechanic (coach conversion) are all real, and so is the frontend for all three. **Update — the "UI for XP/coaching is not built yet" gap this line used to flag is closed**: the sidebar shows a manager's XP balance persistently (`EntitlementDto.xpBalance`, riding the existing entitlement fetch every screen already calls, not a new endpoint); the Scouting page shows each candidate's real claim cost (`TalentClaimPricingPolicy.priceFor`) and disables (never hides) a candidate the manager can't afford, with a "Need N more XP" line; and a roster row's "More" menu has a real "Convert to coach" action opening `CoachConversionModal`, which fetches a preview (`GET /players/:id/coach-conversion-preview`) computed from the exact same `CoachConversionPolicy` instance `ConvertPlayerToCoachUseCase` itself uses — the manager sees the real XP cost and resulting coachRating for that specific player, and a plain-stated coach-cap message if they're already at 1 (free) / 2 (Pro), before an explicit confirm step commits the (permanent) conversion via `POST /players/:id/convert-to-coach`. Manager XP is a simple cumulative balance (`ManagerXpRepository`/`ManagerXpPolicy`), credited on every rostered player's deciding match result (same event point as ranking-ledger writes) and spent on two things: claiming a talent-pool candidate (`TalentClaimPricingPolicy`, atomically claimed+charged via `TalentClaimPort`/a real DB transaction — see `DrizzleTalentClaimAdapter`; **blended pricing, not a flat ability-based formula** — at the youngest age a candidate could have been generated at, price is flat (BASE_COST regardless of rating, since a 14-year-old's current ability barely predicts what they'll become); as generated age increases toward the oldest the range allows, the original super-linear `overallRating()`-based formula progressively takes over, reaching it fully at the oldest age. The blend factor reuses `ageInterpolationFactor` — the exact same age-position formula `PlayerGenerationPolicy.noiseProbabilityForAge` already used for scouting's potential-range uncertainty, extracted to `PlayerGenerationPolicy.ts` and shared rather than reimplemented) and converting a rostered player into a `Coach` (`CoachConversionPolicy`, cost/rating scale with ability+age, permanent, capped at 1/manager free tier / 2/manager Manager Pro — see `ConvertPlayerToCoachUseCase` and `coachCap.ts`; this 2nd-coach cap is a deliberate, disclosed exception to principle #1 above, not an oversight). A manager's coach applies a training-efficiency multiplier in `TrainingPolicy.applyCoachBonus`. All pricing/rating/XP constants are explicit placeholders, flagged in code comments the same way aging thresholds and ranking point values are. `maxRosterSizeFor` (roster-cap policy) lives in `packages/application/src/use-cases/rosterCap.ts`, shared by `ClaimTalentPoolCandidateUseCase` and `CreateCustomPlayerUseCase`.
5. **Billing** — Stripe subscriptions/one-offs, entitlements. ⬜ not started (`BillingPort` referenced but not yet defined).
6. **Notifications** — push/email digest, decoupled via events. ⬜ not started.
7. **Social** — guilds/academies, chat, leaderboards. ⬜ not started.

## What's already built (in `domain-model/` at repo root, or wherever it's placed)
- `domain/shared/ids.ts` — branded ID types (`PlayerId`, `TournamentId`, etc.), `GameWeek` value object.
- `domain/shared/DomainEvent.ts` — marker interface for domain events.
- `domain/player/PlayerAttributes.ts` — `Skill`, `SurfaceAffinities`, `PlayerAttributes` value objects.
- `domain/player/Player.ts` — `Player` aggregate root.
- `domain/player/PlayerAgingService.ts` — policy-driven weekly aging/decline domain service.
- `domain/competition/CompetitionTypes.ts` — `TournamentTier`, `MatchOutcome`, `MatchLog`/`MatchLogEntry` (the fake-live replay data), `BracketRound`.
- `domain/competition/Tournament.ts` — `Tournament` aggregate root, bracket integrity.
- `domain/match-simulation/MatchSimulator.ts` — `MatchSimulator` port, `RandomSource` port, `SimulatedMatch` type.
- `domain/match-simulation/StatisticalMatchSimulator.ts` — concrete deterministic implementation; emits both `MatchOutcome` and `MatchLog`.
- `application/ports/ports.ts` — `PlayerRepository`, `TournamentRepository`, `ClockPort`, `EventPublisherPort`, `MatchLogStorePort`.
- `application/use-cases/HirePlayerUseCase.ts`, `SimulateMatchUseCase.ts`.

All of the above passes `npx tsc --noEmit --strict --target ES2020 --module commonjs` with zero errors. Re-run this check after any change to `domain/` or `application/`.

## Known placeholders that need real tuning (not architectural — safe to leave for now, but don't ship without revisiting)
- `PlayerAgingService`'s stage thresholds (prime/decline/retirement ages) are illustrative, not balanced.
- `StandardRankingPointsTable`'s points formula is illustrative, not balanced.
- ~~`StatisticalMatchSimulator`'s scoring loop treats each simulated "point" as directly incrementing a game count, skipping real game-by-game/deuce structure.~~ **Fixed**: every game (and tiebreak) is now played out as a real point-by-point sequence — 0/15/30/40, deuce, advantage, sudden-death tiebreak scoring — with unit tests asserting the point-score sequence at every step, not just the final winner (see `StatisticalMatchSimulator.test.ts`). `MatchLog` gained a `points` array (`MatchPointEntry[]`) alongside the existing game-completion `entries` rollup, which is unchanged and still what the bracket/scrub-bar tick marks consume. What's still a placeholder, not yet fixed: the underlying point-win-probability formula (`effectiveRating`'s attribute weights, the `/15` sigmoid divisor) is illustrative, not balanced — it's the credibility core of the whole game and still worth a dedicated tuning pass before launch, players will forgive UI roughness far more than a sim that "feels rigged."

## Immediate next steps (in rough order)
1. `BracketGenerator` domain service (single-elimination seeding) for the Competition context.
2. Monorepo scaffolding per the layout above.
3. Postgres/Drizzle adapters implementing `PlayerRepository` and `TournamentRepository`.
4. Define `BillingPort` and a `StripeAdapter` implementing it.
5. Unit tests for `StatisticalMatchSimulator` with a fixed `RandomSource` stub, before any balance tuning.
6. Object-storage adapter implementing `MatchLogStorePort`.

## Context on the person building this
Software engineer, hexagonal/clean architecture background, comfortable
with agentic MCP pipelines. This is a side venture explored alongside an
existing FC Porto media platform (Mercado Azul) and freelance work — the
explicit goal stated at the start of this project was to **avoid
over-engineering and unnecessary complexity**, which is why principles
#2, #3, and #4 above exist: each one is a deliberate reaction against a
genuinely tempting but wrong level of scope (Football Manager's depth,
Tribal Wars' systems sprawl, real-time infrastructure).
