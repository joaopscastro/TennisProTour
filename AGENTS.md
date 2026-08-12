# AGENTS.md — Tennis Manager RPG

This file gives any coding agent (Claude Code, Codex, Cursor, or
otherwise) the context that was built up over a planning session in
claude.ai chat, before any code was committed to this repo. Read this
in full before making architectural decisions — it captures *why*, not
just *what*, and several decisions here reverse an earlier,
less-considered version (e.g. the live-scoring approach), so don't
re-derive from first principles without checking this first.

This mirrors `CLAUDE.md` at the repo root — kept as a second file
rather than a symlink/import so tools that only look for `AGENTS.md`
(not `@`-import syntax) still get the full context. Update both files
together; don't let them drift.

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

**MAJOR UPDATE — `TalentPoolCandidate` no longer exists as a separate
aggregate; "candidates" ARE real `Player`s now, and free agents never
disappear.** This unifies two things that used to be modeled separately
and reverses the "candidates expire and vanish" behavior described in the
rest of this section (which is kept below for historical context — read
this banner first, it supersedes anything below it that says a candidate
can expire/disappear). A player who wins a tournament must never cease to
exist, so a "free agent" is now simply a `Player` with `managerId IS NULL
AND stage != 'retired'` — generated by the exact same
`PlayerGenerationPolicy`, aged by the exact same weekly tick, able to play
and win tournaments (as fillOnly entrants), and **never expired or
deleted**. Concretely:
  - The `talent_pool_candidates` table + its 3 enums were dropped
    (migration `drizzle/0022_wide_psynapse.sql`); the candidate
    aggregate/repository/adapter and the `TalentPoolCandidateId` branded
    id are all gone.
  - `RefreshTalentPoolUseCase` no longer creates candidate rows or expires
    them — the weekly refresh now generates fresh 14-16yo free-agent
    `Player`s (managerId null, fillOnly true) and there is **no expiry
    sweep at all**. `DrizzlePlayerRepository.findFreeAgents()` (ordered
    youngest-first) is what the scouting page reads.
  - "Signing" a free agent is an atomic `UPDATE players SET manager_id=…,
    fill_only=false WHERE manager_id IS NULL` + XP debit in one
    transaction (`DrizzleTalentClaimAdapter`) — race-safe exactly as the
    old candidate claim was. The class/port/route NAMES were deliberately
    kept (`ClaimTalentPoolCandidateUseCase`, `TalentClaimPort`,
    `POST /talent-pool/:playerId/claim`) — only the semantics changed; the
    claim command is now `{ playerId, managerId }`.
  - **Value-hiding hardened (RPG constraint).** The free-agent DTO
    (`talentPoolRoutes.ts` `toFreeAgentDto`) exposes only observable data
    (name, nationality, age, current attributes, OVR) — `rarity`,
    `potentialTier`, `potentialCeiling`, and `physicalCeilings` are all
    omitted server-side. The scouting page shows player CARDS (no rarity/
    potential labels anywhere) and the GC-16 "claim" celebration keys off
    observable OVR (`overall >= 78`), never hidden potential. A manager
    judges a prospect from attributes alone.
  - **Every player has a real, linkable profile — free agents included.**
    The scouting cards link to `/players/[id]` (the old `/scouting/[id]`
    report page is now just a redirect there). The profile shows, right
    under the hero: a Free-Agent "Sign this free agent" banner (owned
    players don't get it), a **Matches** strip (latest decided results +
    next pending match — no fake per-match countdown, honesty rule), the
    full **Attributes** section (visible on everyone), standings, titles,
    schedule, and a tournament-history preview linking to a dedicated
    `/players/[id]/history` subpage. Backed by
    `GET /players/:id/current-matches` (`DrizzlePlayerMatchesQuery`).
  - The scouting grid caps to the youngest 48 free agents with a "Show
    more" control (there can be hundreds; older free agents stay signable
    forever, just paginated).

Everything below this banner predates the unification and is retained for
the rarity/potential/generation design rationale, which is unchanged —
but ignore any claim below that a candidate "expires," "disappears," or
is a distinct row type from a `Player`.

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
  **Update (P5) — the profile now carries a richer, still-legible-but-
  noisy "scout's projection", the counterpart to the coarse list-tier
  above** (see `docs/rocking-rackets-competitive-analysis.md` §3). A new
  pure domain calculator, `PotentialProjectionService.projectPotential`
  (`packages/domain/src/player/`), turns the HIDDEN
  `potentialCeiling`/`physicalCeilings`/`talent` into: a headline
  projected-ceiling BAND (low–high) + midpoint, per-attribute "ghost cap"
  projections (technical → toward the overall ceiling with no hard cap;
  physical → toward that attribute's own `physicalCeilings` entry;
  mental → flagged `mature`, projection == current, no headroom), an
  RR-style `developmentPercent` (current OVR / projected mid), a coarse
  `tier` label reusing the existing `tierForPotentialCeiling`, a `growth`
  read (slow/steady/rapid) that surfaces the hidden `talent` stat
  coarsely, and a `confidence` (0..1). Three load-bearing properties,
  all unit-pinned (`PotentialProjectionService.test.ts`): (1) DERIVED,
  never stored — no new column, recomputed each read, and the raw hidden
  numbers are NEVER serialized (they appear only as arguments INTO
  `projectPotential` in `DrizzlePlayerProfileQuery`, grep-verified);
  (2) DETERMINISTIC/ungameable — the per-player fuzz is a stable
  FNV-1a hash of `playerId` (+ a per-draw salt), NOT a fresh random, so
  refetching can't re-roll a luckier read; (3) TIGHTENS toward truth —
  the band half-width and the bias both shrink to zero as the player
  ages from `PROJECTION_YOUNG_AGE_WEEKS` (14yo) to
  `PROJECTION_MATURE_AGE_WEEKS` (24yo), reusing the shared
  `ageInterpolationFactor` curve (clamped here — the only caller that
  legitimately sees out-of-range ages), so a young signing is a genuine
  gamble that resolves onto the true ceiling as they mature. All numeric
  constants (`PROJECTION_MAX_HALF_WIDTH`, `PROJECTION_BIAS_FRACTION`,
  `PROJECTION_RESOLVE_CONFIDENCE`, the maturity age, the growth
  thresholds) are explicit PLACEHOLDER balance values, flagged in code
  the same way aging/ranking/development constants are. It is exposed
  ONLY on `PlayerProfileDto.potential` (`GET /players/:id/profile`),
  NEVER on any list/pool query — potential stays a per-player
  investigation, not a sortable column, and every player (including free
  agents/fillOnly) has a fully inspectable profile. Frontend: the
  profile Attributes section renders it as ghost-cap bars (solid current
  fill + hatched translucent projected headroom, `prefers-reduced-motion`
  safe via CSS-only transitions) plus a "Scout's projection" panel
  (headline ~band, tier chip, dev%, growth read, and a confidence bar
  with copy that visibly tightens: Speculative → Narrowing → Firming up →
  Confirmed). A P5 "resolution" celebration (a new `potential` kind on
  the existing GC-16 `CelebrationMoment`) fires ONCE — deduped per player
  in `localStorage`, gated to the owning manager — when one of YOUR OWN
  prospects' read resolves to a high/elite ceiling: the bet paid off. No
  new backend concept and no new stored state; it's derived entirely from
  the profile's own projection. Verified live against real Postgres: a
  14.2yo (ceiling 67) shows a wide band 57–75 (unresolved, conf 0.02); a
  37.7yo collapses to its exact true ceiling (e.g. 86–86, resolved,
  tier elite), and the projection is byte-identical across refetches.
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

## World clock — persistent chrome, and an honest disclosed gap found while building it

The current `GameWeek` (season/week) plus the real timestamp of the next
scheduled weekly tick is exposed via `GET /world/clock`
(`apps/api/src/adapters/inbound/http/worldRoutes.ts`), and shown as
persistent sidebar chrome (`Sidebar.tsx`, same placement pattern as the
XP balance) with a client-side ticking countdown (`lib/useCountdown.ts`)
— no page refresh needed to stay accurate.

**Audited first, before building anything**: the worker's next-tick time
was NOT exposed anywhere prior to this — it lived entirely inside
BullMQ's repeatable job scheduler (`apps/worker/src/index.ts`'s
`upsertJobScheduler('advance-world-week', { pattern: WORLD_TICK_CRON })`),
internal to the worker's own Redis connection; `apps/api` had (and still
has) no Redis/BullMQ client at all. Rather than give `apps/api` a second
connection to Redis just to ask BullMQ "when do you next run this job,"
`/world/clock` recomputes the same answer independently, via
`cron-parser` (already a transitive `bullmq` dependency, added directly
to `apps/api`) against the same `WORLD_TICK_CRON` string. **This means
`WORLD_TICK_CRON` must be kept identical between `apps/api` and
`apps/worker`** — the same kind of disclosed cross-process env-var
coupling as `WORLD_ID` (see above): nothing enforces the two stay in
sync short of both defaulting to `'0 3 * * 1'` and a human keeping any
override consistent.

**A real pricing bug found (and fixed) while building this**: seeding
`apps/api/src/scripts/seed.ts`'s 200 free-agent talent-pool candidates
across a much wider age span (14-37yo) than `TALENT_POOL_AGE_RANGE`
(14-16yo — the real weekly refresh's only actual span) exposed that
`StandardTalentClaimPricingPolicy.priceFor` was unclamped: pricing an
out-of-range candidate against `TALENT_POOL_AGE_RANGE` extrapolated
`ageInterpolationFactor`'s blend factor past `[0, 1]`, producing actual
NEGATIVE XP claim costs for older free agents (verified live via the
Scouting page before the fix, and via `ClaimTalentPoolCandidateUseCase`,
which uses the same call — this would have under-charged a real claim,
not just displayed a wrong number). Fixed by clamping the blend factor
to `[0, 1]` inside `priceFor` itself (not the shared
`ageInterpolationFactor` helper, whose OTHER caller,
`noiseProbabilityForAge`, only ever receives an age rolled from within
its own range and is unaffected) — see
`packages/domain/src/manager/TalentClaimPricingPolicy.ts` and its test
file's new "outside the supplied ageRange" cases.

The talent pool's "next refresh" and the new world clock's "next tick"
are genuinely the same real schedule, not just presented consistently —
`RefreshTalentPoolUseCase` and `GenerateJuniorTournamentsUseCase` both
run inside the exact same `advance-world-week` handler
(`apps/worker/src/jobs/handlers.ts`), gated on the same `advanced` flag.
So the Scouting page's "Next refresh in …" line reuses the exact
`nextTickAt` the sidebar counts down to (same `useCountdown` hook, same
fetch), not a second, independently-derived countdown.

**A real, previously-undocumented gap found during this audit, disclosed
here rather than papered over with a fake UI countdown**: neither
`SimulateDueMatchesUseCase` (the 5-minute automatic match-sweep) nor the
manual `POST /tournaments/:id/matches/:round/:index/simulate` route is
actually gated by a tournament's `weekScheduled` against the world's
`currentWeek` — "due" only means "sits in the current round with no
outcome yet." In practice this rarely surfaces, because
`GenerateJuniorTournamentsUseCase` always opens tournaments at
`weekScheduled: currentWeek`, never in the future — but an
admin-/seed-opened tournament scheduled for a future week can still have
its matches simulated immediately, today. The bracket screen
(`tournaments/[id]/page.tsx`) shows a tournament's `weekScheduled`
alongside the world clock's real `currentWeek` for honest context, but
deliberately does NOT show a per-match/round "starts in Nd" countdown —
building one would misrepresent how simulation actually behaves. Fix the
underlying gate in `SimulateDueMatchesUseCase` before ever adding that
countdown.

**Update — the tick cadence itself is now configurable for dev/test,
with a real idempotency bug caught and fixed while wiring it, not just
a schedule-string change.** `WORLD_TICK_INTERVAL_MS`
(`apps/worker/src/index.ts`) fires the world tick every N ms instead of
`WORLD_TICK_CRON`'s real-week cadence when set — unset (the production
default) is byte-for-byte the same behavior as before this existed. See
README.md's "Fast local tick cadence" section for the day-to-day
version. The bug: the tick's idempotency key
(`apps/worker/src/tickKey.ts`'s `isoWeekTickKey`) is derived from the
real-world ISO calendar week, which is exactly right when one tick = one
real week, but would have silently no-op'd every firing after the first
within the same real week once ticks started firing hourly — the whole
point of the override would have been defeated, quietly, with no error.
Fixed with a second key function, `intervalTickKey`, that buckets real
time into `intervalMs`-sized slots instead of calendar weeks — used
whenever `WORLD_TICK_INTERVAL_MS` is set, `isoWeekTickKey` otherwise
(`tickKey.test.ts` pins the exact failure mode: two firings one
interval-hour apart get different interval keys but the SAME
`isoWeekTickKey`). `/world/clock`'s interval-mode countdown
(`worldRoutes.ts`) is anchored to `game_worlds.updated_at` — the real
wall-clock time of the last tick that actually advanced the world
(`DrizzleGameWorldRepository.findLastTickAt`, a plain adapter-level read
exposed directly on `Dependencies`, deliberately not added to the
`GameWorldRepository` port or the `GameWorld` aggregate itself — the
domain still never touches wall-clock time) — rather than the cron path,
since apps/api has no way to observe an `every: ms` BullMQ schedule's
real anchor directly.

**Confirmed by explicit audit, not assumed, that nothing else has a
hidden real-week coupling**: `MatchReplayPlayer.tsx`'s Premiere
live-edge cap (`computeLiveEdgeSeconds`) only ever measures real elapsed
time since a match's own `simulatedAt` (`new Date().toISOString()`,
written once at simulation time in `SimulateMatchUseCase`) — entirely
independent of tick cadence, cron or interval. `lib/useCountdown.ts`
likewise never hardcodes an interval anywhere; it just counts down to
whatever `nextTickAt` timestamp `/world/clock` returns. The one
cosmetic (non-functional) loose end: the Scouting page's static copy
("refreshed weekly") stays literally "weekly" even when
`WORLD_TICK_INTERVAL_MS` is overriding the real cadence for local
testing — left as-is deliberately, since it's dev-only UI copy, not
logic, and the countdown number itself stays numerically correct either
way.

**Update — the world tick is now a DAY tick, not a week tick; this
supersedes every "weekly worker tick" / `advance-world-week` /
`'0 3 * * 1'` phrasing above and elsewhere in this file. The
authoritative spec is `docs/day-tick-and-scheduling.md`.** One tick now
= one in-game DAY (worker job renamed `advance-world-day`; production
cron default is now `'0 3 * * *'` — daily, not `'0 3 * * 1'` weekly).
Everything the older prose describes as "riding the same weekly worker
tick" (aging, training resolution, graduation carryover, talent-pool
refresh, junior-tournament generation, `StartDueTournamentsUseCase`, the
52-week rolling ranking window) still runs weekly — it just now fires
ONLY on the day-7→day-1 rollover (`weekRolledOver`), not on every tick.
Matches are the per-day part: `TournamentSchedulePolicy` maps bracket
round r → a day (one-week tiers play round r on day r; two-week tiers —
`major`, `juniorMasters` — spread rounds across 14 days, final on day
14), and `SimulateDueMatchesUseCase` is now day-gated — a round only
simulates once its `roundScheduledDay <= world.currentGameDay`, i.e. one
round per day, closing the "an entire tournament resolves in a single
tick" behavior. `/world/clock` now also returns `currentDay`,
`daysPerWeek`, `nextTickAt` (next DAY tick) and `nextWeekTickAt` (next
weekly rollover); the sidebar shows "Day N/7" + a "Next day" countdown,
while Scouting's talent-refresh countdown uses `nextWeekTickAt` (the
pool still only refreshes weekly). `WORLD_TICK_CRON` (and the
`apps/api`↔`apps/worker` keep-in-sync coupling described above) still
applies verbatim — only its default value changed from weekly to daily.

**Update — fatigue and form (the two per-player constraint systems that
turn "which tournaments do I enter?" into a real decision — see
`docs/rocking-rackets-competitive-analysis.md`).** Both are integer
`Player` fields (`fatigue`, `form`, DB columns, persisted through
`DrizzlePlayerRepository`), applied as `StatisticalMatchSimulator`
modifiers and surfaced on the roster card as gauges. **Fatigue**:
accrues per match, now stamina-modulated via `FatiguePolicy`
(`fatigueCostForMatch(stamina)` — a 0-stamina player pays the full
`BASE_MATCH_FATIGUE=8`, a 100-stamina player ~5 after up to 40%
resistance), and — the actual fix this session — RECOVERS
`FATIGUE_RECOVERY_PER_DAY=5` on EVERY advanced day in
`AdvanceWorldWeekUseCase` (`recoverDailyFatigue()` mid-week +
`recoverFatigue()` on rollover). Before this, recovery was never wired,
so every active player trended monotonically to a permanent 100;
verified fixed live (real spread across players: idle→0, actively
competing→70-100). The sim penalty (`fatigue*0.15` in `effectiveRating`)
is unchanged. Endurance is deliberately folded into the existing
`stamina` attribute rather than adding a new one (disclosed scope
decision — RR keeps them separate; revisit if fatigue tuning needs an
independent axis). **Form**: `applyMatchForm(1)` per match (both
players), decays `×FORM_WEEKLY_DECAY=0.85` per week on rollover only
(`decayForm`, `Math.round` to stay integer-consistent with the DB
column). `formModifier(form)` rewards a sweet-spot band
`[FORM_SWEET_SPOT_MIN=12, MAX=25]` (`+SWEET_SPOT_BONUS=2`), is neutral
in the tolerance zones just outside it, and penalizes both rusty
(`<RUSTY_THRESHOLD=8`) and stale (`>STALE_THRESHOLD=30`) players
(`OUT_OF_BAND_PENALTY_PER_POINT=0.3` per point past the band) — so both
never playing AND playing every single tournament hurt, which is the
whole point. **Every fatigue/form constant above is an explicit,
comment-flagged placeholder** — tuning them to the day-tick cadence is
the main open balance question (`docs/rocking-rackets-competitive-analysis.md`
§5), same status as the aging thresholds and ranking-point values.

**Update — the senior tour is now weekly-entry-capped too (was
uncapped), fixing a real "one player played 5 tournaments in the same
week" bug.** `SENIOR_WEEKLY_ENTRY_CAP=1` now lives alongside
`JUNIOR_WEEKLY_ENTRY_CAP=3` in `juniorEntryCap.ts`, both enforced in
`RegisterEntrantUseCase` (`weeklyEntryCapForTier` /
`countSameBandEntriesForWeek`, band-scoped so senior and junior counts
never bleed into each other). This supersedes the "scoped to junior
tiers only" / "senior tour isn't capped" phrasing in the Competition
context and older notes: a senior player may now enter at most one
senior tournament per game-week (a different week is fine). The
`EnterTournamentModal` / `GET /tournaments?status=open&playerId=` fields
were renamed `juniorEntryCount/Cap…` → `weeklyEntryCount/Cap…` to match.

## Test-database isolation — a real incident, now fixed structurally

`apps/api`'s and `apps/worker`'s integration/e2e suites (`beforeEach`
truncates every table between tests — see any `*.integration.test.ts`
or `e2e.smoke.test.ts`) used to default to `DATABASE_URL`, the exact
same connection string `npm run dev` uses. Running the suite locally
against a dev environment with real seeded data really did wipe it —
this happened for real during a session, not a hypothetical. Fixed by
decoupling entirely: every test file now resolves its connection via
`testConnectionString()` (`apps/api/src/db/testConnection.ts`), which
never reads `DATABASE_URL` at all, defaults to a separate
`tennis_manager_test` database, and throws outright if
`TEST_DATABASE_URL` is ever pointed at the known dev database name — a
structural backstop, not just a naming convention. `scripts/ensure-test-db.js`,
wired as a `pretest` hook in both packages, creates that database
automatically (idempotent) before any suite connects. See README.md's
Testing section for the day-to-day version of this.

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
1. **Player & Roster** — player entities, stats, aging, training. ✅ domain skeleton built. 🟢 **Fill-only free agents** (see `docs/tournament-fill-system.md` for the full design and status — all five items built and tested): `Player.fillOnly` marks a permanent, manager-less (`managerId: null`) player that rides the exact same weekly-tick aging loop (`AdvanceWorldWeekUseCase`) as anyone else, but auto-trains toward its own weakest attribute every tick (`weakestTrainableAttribute`, `PlayerAttributes.ts`) instead of resolving one from a training schedule (which stays permanently empty for these players — a RELEASED player, also `managerId: null` but `fillOnly: false`, is unaffected and keeps its prior schedule-resolution behavior; `fillOnly`, not `managerId`, is the distinguishing flag; see the training-schedule paragraph below for what replaced `currentFocus`). Two sources populate the fillOnly population: (1) `RefreshTalentPoolUseCase`'s weekly expiry sweep now converts every candidate it expires into a real fillOnly `Player` (same id as the candidate) rather than just marking it inert — the `TalentPoolCandidate` row itself was never deleted (no adapter has a delete method) and still isn't, it just now has real develop-over-time company; (2) `GenesisSeedFillOnlyPlayersUseCase` / `npm run genesis-seed -w apps/api`, a one-time-per-world script (NOT wired into `npm run setup`) that generates 300 players uniformly across the full 14-37yo non-retired span, solving the cold-start problem the normal 14-16yo-only weekly refresh can't (a fresh world would otherwise need years of simulated time before any senior-tier tournament had an age-appropriate filler). A fillOnly player is permanently non-claimable — no path ever flips the flag back or lets a manager claim one. **The consuming end — `StartDueTournamentsUseCase` — is also built**: the previously-disclosed "open tournaments never expire if their draw doesn't fill" gap is now closed for real. Every weekly tick, any open tournament whose `weekScheduled` has fully passed (strictly — see that class's doc comment for why an inclusive comparison would have force-started a junior tournament the same tick `GenerateJuniorTournamentsUseCase` opens it, before any manager could register) gets topped up from the unclaimed-player pool (age-band-eligible fillOnly Players and fresh Scouting candidates, the latter converted to fillOnly on selection) before its bracket seeds — real registrants are never displaced, byes fill any remainder exactly like any other partial draw. Verified live against Postgres: the dev seed script's deliberately-partial `seed-registration` tournament (4/16 real) correctly fills to 16/16 and starts. Known, disclosed gap: no bracket-screen UI distinguishes a filler entrant from a real manager's player.

**Update — training focus is a genuine forward SCHEDULE now, not a single mutable field; `Player.currentFocus`/`setTrainingFocus()` are gone entirely.** A manager can commit a `TrainingFocus` to any current-or-future `GameWeek`, not just "right now": `TrainingScheduleEntry` (`packages/domain/src/player/TrainingSchedule.ts`) is a small, permanent per-(player, effectiveFrom-week) row, and `resolveTrainingFocusForWeek(entries, week)` — a pure function, exhaustively tested (`TrainingSchedule.test.ts`) — resolves "what applies THIS week" as the latest entry with `effectiveFrom <= week`, i.e. the standing order carried forward until a later explicit entry overrides it. This is a genuine replace, not an addition: `Player` no longer stores or knows its own focus at all (removed the field, the getter, and `setTrainingFocus()`); `AdvanceWorldWeekUseCase` now resolves each player's effective focus fresh every tick via a new `TrainingScheduleRepository` dependency, against `world.currentWeek` AFTER that tick's `advanceWeek()` call has already moved it forward — the same week aging applies to. `SetTrainingScheduleUseCase` (replaces `SetTrainingFocusUseCase`, same "renamed because the semantics genuinely changed" precedent as `TrainPlayerUseCase` before it) refuses to schedule a week before the world's current one — a structural guarantee, not just a convention, that "changing the standing order today" can never retroactively rewrite what an already-elapsed week resolved to (proven directly in `AdvanceWorldWeekUseCase.test.ts`: a week-5-future entry provably does not affect ticks 1-4, and an already-applied tick's effect is byte-identical whether or not the future entry exists yet). `training_schedule` (DB) replaces the old `players.training_focus_kind/surface/attribute` columns outright (migration `0021_dark_logan.sql` drops them) — composite PK `(player_id, effective_from_season, effective_from_week)` doubles as its own player-scoped index, same pattern `peak_rankings` already established. `PUT /players/:id/training-focus` still exists (same URL, same "no week = starting now" default for the roster dashboard's existing quick-set dropdown, zero frontend change needed there), now optionally accepting an explicit `week`; a new `GET /players/:id/training-schedule` (`PlayerTrainingScheduleQuery`, deliberately built as the training-schedule MIRROR of `PlayerEntryPlannerQuery` — same `DEFAULT_PLANNER_WEEKS` window/defaults, a separate query against a separate repository, not merged into one new backend concept) feeds the player profile page's new "Schedule" section — one combined per-week timeline (tournament entry + resolved training focus, both editable inline, the tournament side reusing `EnterTournamentModal`/`RegisterEntrantUseCase` as-is) that is a FRONTEND combination of two independent, pre-existing backend reads. Verified live end-to-end, not just via unit tests: scheduled a standing order for the current week and a different one two weeks out, ran the real worker against real Postgres, and watched a real player's attributes train under the first focus for exactly one week then switch to the second the moment (and not one tick before) the world clock actually reached that week — confirmed both via direct attribute deltas and via the Schedule view's own rendering (inline dropdown edit round-trips through a real PUT and correctly re-propagates the new standing order forward through later weeks).

**Update — player development is now EARNED, not free: a hidden Talent stat + a spendable per-player experience currency gate training growth (P4, `docs/rocking-rackets-competitive-analysis.md` §1c — RR's core "you develop by playing" loop).** Training used to apply its full delta for free every tick; now every base training delta is funded from the player's own accumulated `experience`, and a player with no experience grows not at all. Two independent income streams feed that experience, both credited directly on the Player aggregate (same "direct mutator, no event" convention as `applyMatchFatigue`/`applyMatchForm`): (1) **match XP** — awarded to BOTH participants in `SimulateMatchUseCase`, scaled by how competitive the match actually was (the MATCH loser's total games won across all sets — a 6-0 6-0 blowout teaches almost nothing, a 7-6 7-6 war teaches a lot; the winner earns a fixed fraction of the loser's share). Every player earns this, fillOnly/free agents included — they have no manager to earn manager-XP for, but still grow their own game. (2) **weekly talent income** — credited to every player each weekly rollover in `AdvanceWorldWeekUseCase` (BEFORE that same tick's training, so it can fund it), proportional to the hidden `Talent` stat. `Talent` is rolled once at generation (25-95, independent of rarity tier and age — `StandardPlayerGenerationPolicy.rollTalent`, same swappable-policy discipline as the ceilings) and fixed for the player's whole career. All of this lives behind a new swappable `PlayerDevelopmentPolicy` (`StandardPlayerDevelopmentPolicy` with PLACEHOLDER constants flagged the same way aging thresholds/ranking points are: `XP_PER_LOSER_GAME`, `MATCH_XP_FLOOR`, `WINNER_SHARE`, `WEEKLY_XP_PER_TALENT`, `XP_PER_SKILL_POINT`). `Player.applyTraining` gained an optional trailing `development` param — null (the legacy default, every pre-P4 test) applies the full delta free exactly as before; passing the policy caps the base delta at what `experience` can currently afford (`experienceCostPerSkillPoint` per point) and spends it, never driving experience negative. Ceiling/coach adjustments apply to the funded base afterward, unchanged. **Both `talent` and `experience` are deliberately HIDDEN** — threaded through `Player`/DB exactly like `potentialCeiling`/`physicalCeilings`, never serialized in any DTO or HTTP response body (grep `talent`/`experience` in any new DTO/route code — adapter-internal mapping only); the visible scouted read is P5's job. DB: `players.talent` (integer, default 50 for pre-P4 rows — migration `0027_faulty_gwen_stacy.sql`) and `players.experience` (**double precision**, default 0 — migration `0028_brainy_dracula.sql`; float, not integer, because experience legitimately carries fractional remainders — weekly income minus the fractional cost of a sub-1-point funded training step — same `doublePrecision` precedent as `dormant_carryover_bonus_points`). One disclosed characteristic worth knowing, same family as the ceiling-plateau rounding note: because `Skill.of()` rounds to an integer, a per-tick funded delta below ~0.5 skill points rounds away entirely, so a very-low-talent player who never plays matches can plateau — real development still requires either enough talent income or actually playing (match XP), which is exactly the intended "earn it by playing" pressure, not a bug. Verified live end-to-end against real Postgres (not just unit tests): ran real world ticks through the real composition and watched (a) managed players with no training schedule accrue unspent weekly talent income (+15/rollover at talent 50), (b) fillOnly players spend that same income auto-training their weakest attribute (real attribute deltas, e.g. backhand 23→25 over 3 rollovers), and (c) the fractional `experience` currency round-trip through the double-precision column correctly. Tests: domain 241 (was 233 — new `PlayerDevelopmentPolicy.test.ts` + Player XP-funding + talent-generation cases), application 137 (new talent-proportional-growth assertion in `AdvanceWorldWeekUseCase.test.ts`; the pre-existing training tests now fund the player's XP up front, since training is no longer free), api 64 / worker 8 unchanged. **Still to come, unchanged**: P5 (`p5-potential-view`) is the derived, age-fuzzed, PROFILE-ONLY ghost-cap projection that surfaces a legible-but-noisy read of this hidden potential — it depends on this Talent work and is the next roadmap step.
2. **Competition** — tournaments, brackets, rankings, match scheduling. ✅ domain skeleton built. 🟢 The junior circuit (see `docs/junior-circuit-research-and-proposal.md` for the full research/design and an honest built-vs-drifted status) is real and tested, not a skeleton: `TournamentTier` spans the six real ITF-sourced J-grades (`j30`-`j500`, `StandardRankingPointsTable`'s champion values are sourced, not guessed) plus an explicitly placeholder-flagged `juniorMasters` capstone (`isUnsourcedPlaceholderTier`), with `AgeBand` (`u14`/`u16`) living on `Tournament`/`RankingLedgerEntry` rather than baked into the tier — the same six grades work identically for both bands. Each band gets its own independent ranking (`RankPositionQuery` scoped to a `RankingBand`; `RankingCalculationService` reused with `bestResultsCap` parameterized to 6, the real ITF rule, vs. 18 for the senior tour — one service, not a duplicate). A junior weekly entry cap (`JUNIOR_WEEKLY_ENTRY_CAP` = 3, the real ITF number) is enforced in `RegisterEntrantUseCase`, scoped to junior tiers only. A graduation carryover (`GraduationCarryover.ts`) records a dormant bonus on `Player` when a weekly aging tick crosses a U14→U16 or U16→senior boundary, consumed only by that player's first real (`points > 0`) result in the new band, then cleared — it never manufactures a ranking-ledger entry by itself. `GenerateJuniorTournamentsUseCase` (riding the same weekly worker tick as aging/talent-pool refresh) keeps the ladder abundantly populated — decreasing frequency/increasing draw size from J30 up to J500, `juniorMasters` held once a season and gated by live ranking position (top 16 invited, never open registration; a band without 16 ranked players is skipped rather than faked). Fixing this junior work also fixed a real pre-existing bug: `pointsFor(tier, roundsWon=0)` used to return full base points for a first-round loss at every tier, senior included — a ranking must be earned by an actual win, never granted for participation or for merely aging into eligibility, and `RankPositionQuery` now excludes a zero-qualifying-result player from the ranked list entirely (genuinely "NR") instead of floor-ranking them at zero, for the senior query too. **Known, disclosed gap, not silently left out**: open tournaments never expire if their draw doesn't fill.

**Update — the "no tournament ever gets a display name" gap above is now resolved, structurally, not just usually true.** Every tournament (junior and senior, all 11 `TournamentTier` values) gets a fully original, generated display name via `TournamentNameGenerator` (`packages/domain/src/competition/TournamentNameGenerator.ts`) — flavored by tier prestige (four bands: entry/mid/upper/elite, spanning futures→major and j30→juniorMasters), surface, and a real host country. Real country names are used deliberately (mentioning a real country was never the trademark concern — copying a real EVENT name is), but the four real Grand Slam host countries (Australia, France, the United Kingdom, the United States) are excluded from the country pool entirely, and tier-suffix words never include "Masters"/"Grand Prix" or other high-trademark-adjacency terms even at the 'elite' band — this is the structural half of "no resemblance to any real ATP/WTA/ITF tournament name." `TournamentNameGenerator.test.ts` checks the other half directly: hundreds of generated names, across every tier/surface combination, asserted to never contain any fragment of a curated list of real tournament names (Wimbledon, Roland Garros, Indian Wells, Davis Cup, etc.) or the excluded countries/words. **The guarantee that no tournament can ever be created without a real name is structural, not conventional**: `name` is a required field on `Tournament`/`TournamentOpenProps` (a compile-time guarantee) with a runtime non-empty check in `Tournament.open()`/`reconstitute()` closing the "caller passes `''`" loophole TypeScript alone can't stop; and — the real enforcement mechanism — neither `OpenTournamentUseCase` nor `OpenRegistrationUseCase`'s command accepts a `name` field from its caller at all. Both generate one internally via `TournamentNameGenerator` before ever calling `Tournament.open()`. Since these two use cases are the ONLY places a `Tournament` is ever constructed anywhere in the codebase (confirmed by grepping every `Tournament.open(` call site), no admin route, seed script, or future caller can ever hand-type or omit a name. Verified live, not just by unit test: a full `npm run seed` against a freshly-migrated Postgres produced real names for all 22 seeded tournaments across every senior tier and every junior grade/age-band (e.g. "Brazil International Championship" for a major, "Netherlands Hardcourt Trophy" for a futures, "Argentina Classic" for a j30/u14), confirmed both by direct SQL query and by hitting the live `GET /tournaments` endpoint. The frontend (`/tournaments`, the bracket detail page, the replay screen, and `EnterTournamentModal`) now displays `tournament.name`, not the raw `tournament.id`/UUID it used to show. Pre-existing rows seeded before this feature existed were backfilled with an honestly-labeled `'Legacy Tournament <id>'` placeholder (migration `0019_sticky_zuras.sql`) rather than silently faked — every row created from this point forward always has a real generated name. **Update — real frontend surface now exists for the parts that matter most day-to-day, AND the age-vs-band gap this section used to flag is now fixed, not just disclosed**: the age-band badge (U14/U16, no badge = senior) shows on every tournament row/header and on a roster-dashboard player's Rank column (scoped to whichever band `juniorEligibilityForAge` says that player's current age qualifies for — `DrizzleRosterDashboardQuery` reads all three `RankPositionQuery` instances now, not just the senior one). `RegisterEntrantUseCase` now enforces `isAgeEligibleForTournamentBand` (`RankingBand.ts`) for any junior-tier registration: a player may "play up" into an older junior band (a real, deliberately-allowed case — see that function's doc comment) but may not play down into a younger one, and a senior player may not enter either junior band at all — this is deliberately ONE-DIRECTIONAL, matching real tennis: a junior player entering the SENIOR tour remains completely unrestricted (many top players turn pro before 18; see the "Under-18 players in senior tournaments" clarification below if that's ever in doubt again), that was never the gap. `EnterTournamentModal` disables both an over-cap AND an age-ineligible junior entry attempt up front (not just after a failed POST), via a `GET /tournaments?status=open&playerId=` extension that attaches `juniorEntryCountThisWeek`/`juniorEntryCapThisWeek` (`countJuniorEntriesForWeek` in `juniorEntryCap.ts`, shared with `RegisterEntrantUseCase` so the two never drift) and `ageEligible` (same `isAgeEligibleForTournamentBand` the use case itself calls). What's still genuinely missing: no dedicated junior standings/leaderboard page (a manager can only see a band's ranking through their own rostered players' rows, never browse the full U14/U16 tables).

**Update — permanent peak-ranking and title/trophy tracking, plus a composed player-profile read, per `docs/data-archival-principles.md`.** Before touching any new table, that doc's index audit was actually run, not assumed: `ranking_ledger.player_id` and `tournament_entries.player_id` — the real "recent/full entries for one player" access pattern (`AdvanceWorldWeekUseCase`'s weekly graduation-carryover check, and the new tournament-history query below) — had NO index at all, a genuine full-table-scan gap, now fixed (`idx_ranking_ledger_player_id`, `idx_tournament_entries_player_id`; confirmed live via `EXPLAIN`, not just added and assumed correct). A permanent, mutable `peak_rankings` table (one row per player per ranking band — senior/u14/u16 — upserted, never append-only) now tracks each player's all-time-high rolling total independent of `RankingCalculationService`'s current (and sometimes falling, as old results age out of the 52-week window) total; it's refreshed from the exact same `SimulateMatchUseCase` call sites that already write `ranking_ledger`, and only ever moves up (`PeakRanking.isNewPeak`). A lean, append-only `titles` table (primary keyed on `tournament_id` itself — structurally impossible to record two winners for the same tournament) records a real title the moment a tournament's actual final is decided, referencing the tournament by id rather than copying its data (no duplicated name/surface/draw size). `DrizzlePlayerTournamentHistoryQuery` reuses the existing `tournament_entries`/`tournaments`/`tournament_matches` tables for a player's full history (no new duplicate store), and `GET /players/:id/profile` (`DrizzlePlayerProfileQuery`) composes all of it — current rankings, peak rankings, tournament history, and the title list — into one response instead of the frontend making several round trips. No frontend page consumes this yet; the endpoint and its data are real and tested (unit-level peak/title behavior in `SimulateMatchUseCase.test.ts`, real-Postgres upsert/row-count-bounded behavior in `DrizzleRepositories.integration.test.ts`), verified live end-to-end against a real simulated tournament (a real champion's profile showed rank #1, a real peak, real tournament history including the still-open entry they hadn't played yet, and exactly one title referencing the tournament they actually won).

**Under-18 players in senior tournaments — deliberately unrestricted, verified, not a gap.** A junior-age player registering for the SENIOR tour (`futures`/`challenger`/`tour`/`major`, `ageBand: null`) has never been blocked and should never be: real tennis has no such floor (teenagers turning pro before 18 is normal), and `isAgeEligibleForTournamentBand` returns `true` unconditionally for `null` (verified directly against `RegisterEntrantUseCase` with a real 15-year-old `Player` and a real senior tournament — succeeded with zero errors, both before and after the age-eligibility fix above). Don't reintroduce a senior-tour age floor without a specific reason — it would contradict this deliberate design decision, not just add a missing check.

**Update — home advantage (P6, first item of Phase 3 in `docs/rocking-rackets-competitive-analysis.md`).** A tournament now carries a real, structured `hostCountry` (nullable) — a player whose `nationality` matches it gets a modest, flagged sim bonus (`HOME_ADVANTAGE_BONUS`, a PLACEHOLDER +3 on the same effective-rating scale as the form bonus — enough to tilt a coin-flip and give nationality genuine strategic weight when choosing tournaments, never enough to override a real skill gap) in every match played there. **Derived, not a new player attribute**: the roadmap allowed either, and DERIVE was chosen — there is no new Player field, no `homeAdvantage` column; the bonus is resolved fresh at simulation time. `hostCountry` was NOT structured before this: `TournamentNameGenerator` already picked a host country but only ever embedded it in the display-name STRING (and only in 3 of its 5 templates), so P6 made the generator return `GeneratedTournamentName { name, hostCountry }` — the country is now ALWAYS surfaced structurally even when the display name doesn't visibly include it (a tournament in Spain can be named "Cobalt Clay Open" and still be `hostCountry: 'Spain'`). The generator's `HOST_COUNTRIES` pool still deliberately excludes the four real Grand Slam host countries, so `hostCountry` inherits that exclusion for free. **The sim stays a pure function of match-relevant inputs**: `StatisticalMatchSimulator` never sees nationality or host country directly — `MatchParticipant` gained an optional `homeAdvantage?: boolean` (absent/false for every existing caller and test, so nothing broke), and `SimulateMatchUseCase.loadParticipant` is the ONE place that resolves it (`hostCountry != null && hostCountry === player.nationality`), since it's the only layer holding both the players AND the tournament. `hostCountry` is OPTIONAL/nullable on `TournamentOpenProps` (pre-P6 rows, and the ~59 `Tournament.open`/`reconstitute` call sites in tests, all keep working; when null nobody is ever "home" and the rule is simply inert), persisted via a nullable `tournaments.host_country` column (migration `0029_fluffy_luckman`) mapped in `DrizzleTournamentRepository` toRow/toDomain. Surfaced on `TournamentDto.hostCountry` (GET `/tournaments`, GET `/tournaments/:id`) and shown as a "🏠 <country>" badge on the tournament list rows and bracket hero — the mechanic is legible to managers, not hidden (an unseeable advantage would violate the honesty rule). Tests: a `StatisticalMatchSimulator` unit test proving a home participant wins the exact coin-flip point stream an identical away participant loses, and three `SimulateMatchUseCase` tests proving the use case flags only the matching-nationality entrant (and no one when the host country matches no one, or when there is no host country). Domain 252, application 140, api 64, worker 8 — all green. Verified live against real Postgres: a tournament opened through the real `OpenRegistrationUseCase` round-tripped its generated host country ("Solstice Canada Invitational" → `Canada`) through the `host_country` column. Still open in Phase 3: P7 doubles (large, deliberately deferred as its own effort), P8 special formats, P9 ranking realism.

**Update — the tournament detail page is now a real "profile", not a useless blank draw before the tournament's week.** Previously `apps/web/app/tournaments/[id]/page.tsx` rendered a full placeholder bracket (every slot TBD) even before the draw existed — dead space. Now every tournament page (before AND during play) leads with two panels: (1) **Tournament details** — circuit (senior vs. junior + age band), level (tier), surface, draw size, host country, scheduled week, and a full **ranking-points-by-result ladder** (Champion → first-round loss), and (2) an **entry list** of registered players. Before the draw is seeded (`!tournament.hasStarted`), a friendly "The draw hasn't been made yet — seeding happens when the tournament starts (S_ W_)" panel REPLACES the blank bracket; once started, the same two panels sit above the live bracket so the profile info stays available throughout. **Points are computed backend-side from the single source of truth**, never hardcoded in React: `toTournamentDto` (`tournamentRoutes.ts`) now exposes `circuit`, `pointsBreakdown` (Champion-first `{ matchesWon, stageLabel, points }[]`), and `pointsArePlaceholder`. `pointsBreakdownFor(tier, drawSize)` reads straight off the domain `StandardRankingPointsTable.pointsFor` and scales to the tournament's ACTUAL draw size — a 16-draw's champion wins 4 matches → `pointsFor(tier, 4)`, not the table's index-7 value — so the displayed ladder can never drift from what `SimulateMatchUseCase` actually awards. A first-round loss correctly shows "No points" (a ranking is earned by winning, per the pre-existing `roundsWon=0 → 0` fix). `pointsArePlaceholder` (true only for `juniorMasters`, whose points are an unsourced placeholder) lets the UI flag those honestly. **The entry list is deliberately HUMAN-managed players only** (`players.get(e.playerId)?.managerId != null`): fill-only/free-agent players that pad a draw at start time are never "entries" a manager chose, so they never appear — matching the original request. Every entrant links to that player's full profile (`/players/:id`), free agents included. No new endpoint — the page already fetches player DTOs via `fetchPlayersByIds`, and `managerId` was already on `PlayerDto`. Additive DTO fields only (GET `/tournaments*` routes have no Fastify response schema, so nothing is stripped); api tests stayed green (64). Verified live end-to-end against real Postgres + a running dev server (Playwright screenshots): a not-started j30/U14 tournament shows the details panel, points ladder (Champion 5 → Round of 16 "No points"), a 1-player entry list, and the "draw not made yet" panel; a started senior `tour` tournament shows the same profile (Champion 90 → …) with a 10-player seeded entry list ABOVE the live decided bracket. Points scale correctly across every seeded tier/draw (futures 16-draw champion=5, major 128-draw champion=2000, etc.).

**Update — ranking-realism P9, part 1 of 2: the obligatory-tournament rule's domain core (real + tested; live wiring + qualification rounds deliberately deferred, fully designed in `docs/ranking-realism-proposal.md`).** The real-tennis rule "a top player must count a Grand Slam/Masters they were entitled to enter even if they skip it — a 0 that still burns a best-N slot" now has its entire domain core built and unit-tested, though it is NOT yet wired into the live ranking path (that needs a migration + a new weekly-tick dependency + live verification, scoped as its own pass in the proposal doc's §4). What shipped: (1) `isObligatoryTier(tier)`/`OBLIGATORY_TIER_SET` in `CompetitionTypes` — currently just `{'major'}`, a set (not a literal) so a Masters-equivalent tier can join later with no calc-service change; no junior tier is ever obligatory. (2) An optional, additive `obligatory?: boolean` on `RankingLedgerEntry` — every existing construction site and persisted row is unchanged; it marks a MANDATORY-SKIP zero so it's auditably distinguishable from a genuine first-round major loss (both 0 points, but the skip is `obligatory: true`); the ranking TOTAL treats them identically. (3) `RankingCalculationService` generalized to ask `isObligatoryTier` instead of hardcoding `=== 'major'` — byte-identical behavior today (only `'major'` is obligatory), but a `points: 0, obligatory: true` major entry now provably burns a best-18 slot (new test: 18×500 → 17×500). (4) `ObligatoryTournamentPolicy.ts` — a pure, total, idempotent domain service: `DIRECT_ACCEPTANCE_CUTOFF = 100` (PLACEHOLDER) + `isEligibleForDirectAcceptance(rank)` + `computeObligatoryZeroEntries(input)`, which returns one `points: 0, obligatory: true, ageBand: null` entry per eligible-but-skipped obligatory event held in the rolling window (a below-cutoff/unranked player owes nothing; a played event — any result — never yields a zero; each zero is dated to the event's week so it ages out on the real schedule). Fully unit-tested (`ObligatoryTournamentPolicy.test.ts`: eligibility boundary, played-event exclusion, below-cutoff/unranked → none, week-dating, idempotency). Domain 260 (was 252), application 140, api 64 — all green; the additive ledger field needed no DB migration or adapter change precisely because the live injection is deferred. `docs/ranking-realism-proposal.md` designs the remaining live wiring (§4: persist the flag, gather held-obligatory + played-set + current-rank per player on the weekly tick, inject with structural dedup/idempotency, the disclosed current-rank-vs-rank-at-time simplification) and the qualification-rounds `[Q]` feature (§5: a light "reserve `[Q]` main-draw slots for below-cutoff registrants" model first, a full separate simulated qualifying draw only if that proves too thin) — the two are complementary sides of the same `DIRECT_ACCEPTANCE_CUTOFF` and should be built in one pass so the cutoff has both consequences at once.

**Update — ranking-realism P9 is now COMPLETE (part 2 of 2): both the obligatory-tournament rule's LIVE wiring and the light qualification-rounds `[Q]` model are built, tested, and live-verified. This supersedes the "NOT yet wired into the live ranking path" / "deliberately deferred" phrasing in the part-1 note above; `docs/ranking-realism-proposal.md` is updated to match and remains the authoritative spec.** (1) **Rule (A) live**: `ApplyObligatoryTournamentZerosUseCase` (application) runs once per WEEKLY rollover from the worker handler, LAST of the weekly systems (after `startDueTournaments`, so it sees this rollover's own concluded events). It gathers exactly what the pure core asks for — obligatory-tier tournaments with a DECIDED final inside the rolling window (dated to `weekScheduled`, the documented choice), each eligible player's played-tournament set, and every player's live senior rank from the existing `rankPosition` query computed ONCE per run — and appends whatever `computeObligatoryZeroEntries` returns. Deliberately a SEPARATE use case rather than another branch in `AdvanceWorldWeekUseCase` (it needs `TournamentRepository` + a rank query that class has no other reason to hold, and it's a whole-population ranking correction, not a per-player aging step — same shape as `RefreshTalentPoolUseCase`). **Idempotency is structural, not a flag**: a written skip-zero IS a `ranking_ledger` row for that (player, tournament), so the next run sees it in the played set and writes nothing; the proposal's optional `(player_id, tournament_id)` UNIQUE constraint was deliberately NOT added (not verified safe for every existing write path — an unverified constraint is a worse trade than a property already proven by test). `ranking_ledger.obligatory` is a real NOT NULL DEFAULT false column now (migration `0030_short_randall.sql`), mapped in `DrizzleRankingLedgerRepository` both ways; pre-existing rows read back as `false`, matching the domain default, so no backfill was needed. `RANKING_WINDOW_WEEKS` (52) is now EXPORTED from `RankingCalculationService` and imported by the use case rather than re-declared, so the "held in window" filter can't drift from the scoring window. **Verified live against the real dev Postgres through the real composition, not just unit-tested**: run 1 found 2 held majors, considered 100 direct-acceptance-eligible players and wrote 15 mandatory-skip zeros; an immediate second run wrote 0. Disclosed simplification (flagged in code AND the doc): eligibility uses each player's CURRENT senior rank, not their rank when each event was held — revisit only if tanking-then-climbing is actually exploited. (2) **Light `[Q]` model**: `QualifyingPolicy.ts` (domain/ranking) owns `hasQualifying`, `qualifierSlotsFor` and `resolveEntryType`; `TournamentEntrant` gained an optional `entryType` (`'DA' | 'Q' | 'WC'`) read through `entryTypeOf`, persisted via `tournament_entries.entry_type` (same migration). `RegisterEntrantUseCase` applies it: at a qualifying tier an above-cutoff registrant takes their guaranteed DA place, a below-cutoff/unranked one takes a reserved `[Q]` slot, and is REFUSED (not silently upgraded to DA) once those are full — the same `DIRECT_ACCEPTANCE_CUTOFF`/`isEligibleForDirectAcceptance` predicate as rule (A), so the cutoff's two consequences can't drift apart. Deliberate decisions: qualifying tiers are `{major, tour}`, intentionally NOT the same set as the obligatory `{major}` (a real ATP 500 runs qualifying without being mandatory); slots are DERIVED (`QUALIFIER_SLOT_FRACTION` = 1/8 of the draw, i.e. a Slam's real 16-of-128) so `Tournament` gained no new field; the rank query is an OPTIONAL constructor arg, absent in the pre-existing unit tests, where the rule is simply inert; `entryType` is left ABSENT (not stamped `'DA'`) wherever the rule is inert, though the NOT NULL DEFAULT `'da'` column means a persisted entrant always reads back explicit — a real, disclosed round-trip detail pinned by `persistedEntrants` in the integration test. `'WC'` exists as a value but nothing awards one. Surfaced honestly in the UI: `TournamentDto` gained `entryType`/`qualifierSlots`/`obligatory`, and the tournament page shows a `[Q]` tag beside a qualifier, a "Qualifiers: N [Q] slots" fact, and a plain-language note that a mandatory event counts even when skipped. **Known, accepted gap**: fill-only players padding a draw are never classified as qualifiers (they're not an earned entry, and the entry list already excludes them), so `[Q]` only ever appears on a real manager's registration. Tests: domain 269 (was 252 — new `QualifyingPolicy.test.ts`), application 151 (was 140 — new `ApplyObligatoryTournamentZerosUseCase.test.ts` + `[Q]` registration cases), api 65, worker 8 — all green, plus both typechecks. Still open in P9: only the FULL qualifying model (a genuinely simulated qualifying draw), deliberately still deferred.
3. **Match Simulation Engine** — deterministic sim, pure domain logic, no I/O. ✅ domain skeleton built.
4. **Manager & Progression** — manager XP, staff, scouting. 🟢 domain/economy AND a real UI surface now: scouting (the talent pool — see "Player acquisition" above), manager XP accrual, and a first staff mechanic (coach conversion) are all real, and so is the frontend for all three. **Update — the "UI for XP/coaching is not built yet" gap this line used to flag is closed**: the sidebar shows a manager's XP balance persistently (`EntitlementDto.xpBalance`, riding the existing entitlement fetch every screen already calls, not a new endpoint); the Scouting page shows each candidate's real claim cost (`TalentClaimPricingPolicy.priceFor`) and disables (never hides) a candidate the manager can't afford, with a "Need N more XP" line; and a roster row's "More" menu has a real "Convert to coach" action opening `CoachConversionModal`, which fetches a preview (`GET /players/:id/coach-conversion-preview`) computed from the exact same `CoachConversionPolicy` instance `ConvertPlayerToCoachUseCase` itself uses — the manager sees the real XP cost and resulting coachRating for that specific player, and a plain-stated coach-cap message if they're already at 1 (free) / 2 (Pro), before an explicit confirm step commits the (permanent) conversion via `POST /players/:id/convert-to-coach`. Manager XP is a simple cumulative balance (`ManagerXpRepository`/`ManagerXpPolicy`), credited on every rostered player's deciding match result (same event point as ranking-ledger writes) and spent on two things: claiming a talent-pool candidate (`TalentClaimPricingPolicy`, atomically claimed+charged via `TalentClaimPort`/a real DB transaction — see `DrizzleTalentClaimAdapter`; **blended pricing, not a flat ability-based formula** — at the youngest age a candidate could have been generated at, price is flat (BASE_COST regardless of rating, since a 14-year-old's current ability barely predicts what they'll become); as generated age increases toward the oldest the range allows, the original super-linear `overallRating()`-based formula progressively takes over, reaching it fully at the oldest age. The blend factor reuses `ageInterpolationFactor` — the exact same age-position formula `PlayerGenerationPolicy.noiseProbabilityForAge` already used for scouting's potential-range uncertainty, extracted to `PlayerGenerationPolicy.ts` and shared rather than reimplemented) and converting a rostered player into a `Coach` (`CoachConversionPolicy`, cost/rating scale with ability+age, permanent, capped at 1/manager free tier / 2/manager Manager Pro — see `ConvertPlayerToCoachUseCase` and `coachCap.ts`; this 2nd-coach cap is a deliberate, disclosed exception to principle #1 above, not an oversight). A manager's coach applies a training-efficiency multiplier in `TrainingPolicy.applyCoachBonus`. All pricing/rating/XP constants are explicit placeholders, flagged in code comments the same way aging thresholds and ranking point values are. `maxRosterSizeFor` (roster-cap policy) lives in `packages/application/src/use-cases/rosterCap.ts`, shared by `ClaimTalentPoolCandidateUseCase` and `CreateCustomPlayerUseCase`.

**Update — the decaying public MANAGER LADDER is now built (the RR-inspired retention meta-loop, see `docs/rocking-rackets-competitive-analysis.md` §1d/P3), and it is deliberately a SEPARATE store from the XP wallet, not a rename of it.** The XP wallet (`ManagerXpRepository`) stays exactly what it was: monotonic, spendable, private. The ladder (`ManagerLadderRepository` port / `manager_ladder` table / `DrizzleManagerLadderRepository`) is the opposite on every axis — it is banked, never spent, public, and it DECAYS. Both are credited at the exact same event (a rostered player's deciding match result, alongside the `ranking_ledger` write in `SimulateMatchUseCase.awardRankingPoints`); the ladder banks `ManagerLadderPolicy.creditFor(points)` (currently identity — a 0-point first-round loss banks 0, so the ladder only grows on real earned points, mirroring the ranking ledger exactly and never rewarding mere participation). Erosion is applied ONCE per weekly rollover (never per day tick — see `AdvanceWorldWeekUseCase`, gated on the same `weekRolledOver` path as aging/training) as a single whole-table `UPDATE ... SET score = score * factor`, cost independent of how many matches were played; `StandardManagerLadderPolicy.weeklyDecayFactor()` is a flat 0.99 for everyone (the VIP-faster-decay tier split from RR's 1%/1.5% design is deferred to the Billing context, and — like all economy constants here — 0.99 is an explicit PLACEHOLDER). Score is stored as `doublePrecision` (decay produces fractionals; callers round only for display). The public leaderboard is `GET /managers/leaderboard?limit=` (`managerRoutes.ts`) — `topStandings` enriched with manager display names (`ManagerAccountRepository.findById`, added for this), plus the caller's own `rankFor`/`scoreFor` so the page can show "you are #N" (or an honest "NR" when they've never banked a point, genuinely unranked rather than floor-ranked at last). The frontend `/managers` page (new "Managers" sidebar nav item) renders it as a real standings table with medal-tinted top 3, a "Your Position" hero chip, and the caller's own row highlighted (and appended below the cut if they're outside the returned slice). Verified live end-to-end against real Postgres, not just unit-tested: simulated a full 16-draw challenger tournament, watched managers' ladder scores credit (champion's manager led at 29), then ran real weekly-rollover worker ticks and watched every score erode by exactly ×0.99 per rollover — with clean ×0.99 (never double-decay) confirming the tick idempotency key holds even with multiple worker instances racing. Decay fires ONLY on rollover, never mid-week (pinned by `AdvanceWorldWeekUseCase.test.ts`).
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
