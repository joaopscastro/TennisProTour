# Ranking-realism proposal (P9)

Status: **BUILT — both rules are live.** The obligatory-tournament
rule's domain core (§3) shipped first; its live wiring (§4) and the
light qualification-rounds `[Q]` model (§5) are now built, tested, and
verified against real Postgres. The only deliberately deferred piece is
the FULL qualifying model (a genuinely simulated qualifying draw — §5's
second half), which stays a separate future effort. See each section's
own "Built" note for exactly what shipped and what it does differently
from the original plan (and why).

Source of the requirement: `docs/rocking-rackets-competitive-analysis.md`
§P9 ("Obligatory-tournament counting rule; qualification rounds `[Q]`")
and gap #8 ("the 'you must count the Slam even if you skip it' rule is
what forces top players into the big events").

---

## 1. The two real rules we're modelling

**A. Obligatory (mandatory) tournament counting.** On the real ATP/WTA
tour a top-ranked player is granted DIRECT ACCEPTANCE into the Grand
Slams and Masters 1000s by virtue of their ranking. Those events then
count toward their ranking *whether or not they actually play*: skipping
one you were entitled to enter records a **0 that still occupies one of
your best-N counted results**, dragging your average-of-best down. This
is precisely the mechanism that forces the top of the field into the big
events instead of cherry-picking soft draws for easy points. Without it,
a #1 could skip every Slam and defend a ranking on Challengers — which
is exactly the degenerate strategy our sim currently permits.

**B. Qualification rounds `[Q]`.** Players outside the direct-acceptance
cutoff earn a main-draw place through a separate, smaller **qualifying
draw** held before the main event; the survivors enter the main draw as
`[Q]` seeds. This is what gives the ladder's middle a path into big
events and makes the direct-acceptance cutoff meaningful in the first
place (above it = guaranteed place + obligation; below it = must qualify,
no obligation).

The two rules are complementary: (A) is the stick for the top, (B) is the
ladder for everyone else, and the SAME cutoff (`DIRECT_ACCEPTANCE_CUTOFF`)
separates the two populations.

---

## 2. What already existed before this pass

- `RankingCalculationService` already made a `'major'` result an
  always-counting, non-displaceable slot occupant (best-N with majors
  pinned). So the *counting* half of rule (A) — "a major always counts,
  and still uses up a slot" — was in place. What was missing was the
  punitive half: a way to make a **skipped** obligatory event count as a
  0 that burns a slot.
- Tournaments already carry `tier`, `weekScheduled`, and a decided final
  (title/`RankingLedgerEntry` written at completion in
  `SimulateMatchUseCase`). So "which obligatory events happened, and
  when" is already knowable from existing data.
- `RankPositionQuery` already computes every player's live senior rank
  from the ledger. So "who was eligible (top-N)" is already computable —
  no new ranking machinery is needed, only a call.

---

## 3. What this pass BUILT (real, tested)

All in `packages/domain`, framework-free, unit-tested, and behavior-
preserving for every existing call site:

1. **`isObligatoryTier(tier)` + `OBLIGATORY_TIER_SET`**
   (`competition/CompetitionTypes.ts`). Currently `{ 'major' }`; a set,
   not a literal, so a future Masters-equivalent tier joins the
   obligatory list with no calc-service change. No junior tier is ever
   obligatory.

2. **`RankingLedgerEntry.obligatory?: boolean`**
   (`ranking/RankingLedgerEntry.ts`). Optional/additive — every existing
   construction site and every persisted row is unchanged. Marks a
   MANDATORY-SKIP zero so it's distinguishable, for honest display/audit,
   from a genuine first-round major loss (which is also 0 points but
   `obligatory` absent/false). The ranking TOTAL treats both identically.

3. **`RankingCalculationService` generalized** to ask `isObligatoryTier`
   instead of hardcoding `=== 'major'`. Behaviour is identical today
   (only `'major'` is obligatory). A `points: 0, obligatory: true` major
   entry now provably burns a best-N slot — see the new
   `RankingCalculationService.test.ts` case "lets a mandatory-skip zero …
   burn a best-18 slot" (18×500 → 17×500).

4. **`ObligatoryTournamentPolicy.ts`** — the pure core:
   - `DIRECT_ACCEPTANCE_CUTOFF = 100` (PLACEHOLDER) and
     `isEligibleForDirectAcceptance(rank)`.
   - `computeObligatoryZeroEntries(input)`: given a player's current
     senior rank, the obligatory events held in the rolling window, and
     the set of tournament ids the player actually played, returns one
     `points: 0, obligatory: true, ageBand: null` ledger entry per
     eligible-but-skipped obligatory event. Pure, total, idempotent
     (re-feeding produced zeros as "played" yields none). Fully tested in
     `ObligatoryTournamentPolicy.test.ts` (eligibility boundary, played-
     event exclusion, below-cutoff/unranked → nothing, week-dating,
     idempotency).

Tests after this pass: domain 260 (was 252), application 140, api 64 —
all green.

**Was deliberately NOT built in that first pass** (it needed a migration
+ a new tick dependency + live verification, i.e. its own budgeted
pass): the persistence and injection wiring in §4. That has since been
built — see §4 — and needed exactly zero further domain changes, as
predicted. Test counts after the live-wiring pass: domain 269,
application 151, api 65, worker 8 — all green.

---

## 4. Making rule (A) LIVE — BUILT

**Built as `ApplyObligatoryTournamentZerosUseCase`**
(`packages/application/src/use-cases/`), wired into the worker's weekly
rollover branch (`apps/worker/src/jobs/handlers.ts`) as the LAST weekly
system, after `startDueTournaments` — so it always sees this rollover's
own finished tournaments. Two deliberate departures from the plan below,
both documented in the class itself:

- **A sibling use case, not a branch inside `AdvanceWorldWeekUseCase`.**
  It needs two dependencies (`TournamentRepository`, the senior
  `RankPositionQuery`) that class has no other reason to hold, and it is
  a whole-population ranking correction rather than a per-player aging
  step — the same "separate weekly use case, gated on the same rollover"
  shape `RefreshTalentPoolUseCase`/`GenerateJuniorTournamentsUseCase`
  already use.
- **No DB unique constraint was added** (step 3 below only said
  "consider" one). Idempotency is already structural without it: a
  written skip-zero IS a `ranking_ledger` row for that
  (player, tournament), so the next run sees it in the player's own
  played set and produces nothing. A unique `(player_id, tournament_id)`
  constraint was NOT added because it isn't verified safe for every
  legitimate write path, and adding an unverified constraint would be a
  worse trade than relying on a property that is already proven by test.
- `RANKING_WINDOW_WEEKS` (52) is now EXPORTED from
  `RankingCalculationService` and imported by the use case, rather than a
  second 52 being declared — the "held inside the window" filter and the
  scoring window can't drift.

**Verification actually performed** (step 4): 8 unit tests
(`ApplyObligatoryTournamentZerosUseCase.test.ts`) covering the skip-zero
write, idempotency on re-run, played-event (including R1-loss)
suppression, unranked/below-cutoff exemption at the exact cutoff
boundary, non-obligatory tiers, an undecided final, the aged-out window,
and a real best-18 total dropping by exactly one counted result; a real
Postgres round-trip test for the `obligatory` column
(`DrizzleRepositories.integration.test.ts`); and a live run against the
real dev database through the real composition — 2 held majors, 100
direct-acceptance-eligible players, 15 skip-zeros written on the first
run and 0 on an immediate second run.

The original plan, kept for the reasoning:

The pure core produces the right entries; making them affect real
rankings needs four wiring steps. Recommended injection point: the
**weekly world tick** (`AdvanceWorldWeekUseCase`), on a week rollover,
AFTER results for the concluded week are written.

1. **Persist the flag.** Add a nullable/`default false` boolean
   `obligatory` column to `ranking_ledger` (new Drizzle migration), and
   map it in `DrizzleRankingLedgerRepository` toRow/toDomain. Reads of
   pre-existing rows yield `obligatory: false`, matching the domain
   default — no backfill needed.

2. **Gather the inputs per senior player, once per rollover:**
   - *Held obligatory events in the window:* query tournaments where
     `isObligatoryTier(tier)` and the final is decided and
     `weekScheduled` is within the rolling 52 weeks of `currentWeek`.
     Map each to `HeldObligatoryTournament { tournamentId, tier,
     weekHeld }` (`weekHeld` = its `weekScheduled`, or the week its
     final actually decided — pick one and document it; `weekScheduled`
     is simplest and already stored).
   - *Played set per player:* the tournament ids the player has any
     `ranking_ledger` row for (already queryable via
     `findByPlayer`). Note a subtlety: a first-round major loss writes a
     `points: 0` NON-obligatory row today, which correctly counts as
     "played" and must suppress a skip-zero for that event.
   - *Current senior rank:* `RankPositionQuery` (senior band) — the same
     instance composition already builds (`rankPosition`). Compute the
     full sorted list ONCE per rollover, not once per player.

3. **Inject, dedup, and idempotency.** For each eligible player, call
   `computeObligatoryZeroEntries` and persist any returned zeros — but
   only those not already persisted (a skip-zero for `(player,
   tournament)` must be written at most once). Because the policy is
   idempotent when the already-written zeros are included in
   `playedTournamentIds`, the clean approach is: treat an existing
   `obligatory: true` row for `(player, tournament)` as "played" for the
   purpose of the next tick's computation. That way a player who then
   ENTERS a later edition is unaffected, and a still-skipped event is
   never double-zeroed. Consider a DB unique constraint on `(player_id,
   tournament_id)` in `ranking_ledger` to make the dedup structural
   rather than convention (verify no legitimate case writes two rows for
   one player+tournament first — e.g. it must not clash with how a
   normal result is written).

4. **Verification.** Unit-test the new tick branch with in-memory fakes
   (an eligible player who skips a seeded major loses exactly one best-18
   slot's worth of points next tick; a below-cutoff player is
   untouched). Then live-verify against Postgres: seed a top-ranked
   player and a major they don't enter, run the worker tick, and confirm
   a `points: 0, obligatory: true` row appears and their computed total
   drops.

**Edge cases to honour (all already handled by the pure core, just
restating for the wiring):**
- Junior bands are never obligated (no junior tier is obligatory).
- An unranked or below-cutoff player owes nothing.
- A played event (any result, including R1 loss) never yields a zero.
- Skip-zeros age out of the 52-week window on the same schedule as a
  real result from that event (they're dated to `weekHeld`).

**Deliberate simplification to disclose in code + docs:** eligibility
uses the player's CURRENT senior rank, not their rank at the instant each
event was held. Real tours snapshot the ranking at the entry deadline.
Current-rank is close enough for this game's cadence and avoids storing a
per-week rank history; revisit only if it proves exploitable (e.g. a
player tanks to below the cutoff, skips a Slam, then climbs back). If
that becomes a problem, the fix is a lightweight per-(player, week) rank
snapshot the tick already has in hand when it computes rankings.

---

## 5. Qualification rounds `[Q]` — LIGHT MODEL BUILT

**Built** as `packages/domain/src/ranking/QualifyingPolicy.ts`
(`hasQualifying`, `qualifierSlotsFor`, `resolveEntryType`) +
`EntryType`/`entryTypeOf` on `TournamentEntrant`
(`CompetitionTypes.ts`), applied in `RegisterEntrantUseCase`, persisted
via `tournament_entries.entry_type` (migration
`0030_short_randall.sql`), and surfaced on `TournamentDto`
(`entryType`, `qualifierSlots`, `obligatory`) and the tournament page (a
`[Q]` tag next to a qualifier's name, a "Qualifiers: N [Q] slots" fact,
and an honest note on a mandatory event's points panel).

Decisions made while building it, differing from the sketch below:
- **Qualifying tiers are `{major, tour}`, deliberately NOT the same set
  as the obligatory tiers** (`{major}`). An event can run qualifying
  without being mandatory to enter — real ATP 500s do exactly that — so
  these are two separate PLACEHOLDER sets, not one shared flag.
- **Slots are derived, not stored**: `qualifierSlotsFor` = an eighth of
  the draw (a real Slam's 16-of-128), so `Tournament` gained no
  `qualifierSlots` field and no migration for one.
- **A below-cutoff registrant is REFUSED once the reserved slots are
  full**, rather than silently downgraded to a direct acceptance —
  otherwise the cutoff would hand them exactly the place it exists to
  withhold.
- `entryType` is optional/additive and left ABSENT wherever the rule is
  inert (any tier without qualifying), so no entrant in the game gets a
  redundant `'DA'` stamped on them; `entryTypeOf` owns the default. One
  disclosed round-trip detail: the DB column is `NOT NULL DEFAULT 'da'`,
  so a persisted entrant always reads back with an explicit `'DA'` (see
  `persistedEntrants` in the integration test).
- `'WC'` (wildcard) exists as a value — a draw sheet has no third state
  — but nothing awards one; no code path produces it.
- Fill-only players added by `StartDueTournamentsUseCase` are NOT
  classified as qualifiers: they're bracket padding, not an entry anyone
  earned, and the entry list already excludes them. This means `[Q]`
  only ever appears on a real manager's registration — a known, accepted
  consequence of the light model.

The original design, kept for the reasoning:

Larger than rule (A); scoped here so it can be picked up cleanly. Two
possible depths — recommend starting with the LIGHT model.

**Light model (recommended first):** no separate playable qualifying
bracket. When an obligatory/large tournament opens, its main draw
reserves a fixed number of `[Q]` slots; those slots are filled by the
best-ranked *below-the-cutoff* registrants (or fill-only players) at
draw time, seeded as `[Q]` (unseeded, placed like the lowest seeds).
This delivers the visible `[Q]` label and the "cutoff separates direct
acceptance from qualifiers" fiction with almost no new machinery:
- `Tournament` gains a `qualifierSlots` count (or derive from draw size
  and a policy). Entrant seeding marks `[Q]` entrants.
- `TournamentEntrant`/DTO gains an `entryType: 'DA' | 'Q' | 'WC'`
  (direct-acceptance / qualifier / wildcard) for display; the bracket
  and entry-list UI render `[Q]` next to the name (a real tennis
  convention we already honour elsewhere).
- No qualifying matches are simulated — the qualifier is *assumed* to
  have come through. Points: qualifiers earn normal main-draw points for
  their results; a dedicated `[Q]`-reached points row is not needed.

**Full model (later, only if the light one proves too thin):** a real
separate qualifying draw (e.g. 32→4) simulated before the main draw,
whose 4 winners become the `[Q]` main-draw entrants, with its own small
points for reaching qualifying rounds. This is a genuine second bracket
on the `Tournament` aggregate (`qualifyingRounds` alongside `rounds`),
new `BracketGenerator` support, and extra simulation load per event —
comparable in size to a phase item on its own, hence deferred.

**Interaction with rule (A):** `[Q]` and obligation are two sides of the
cutoff — a player above `DIRECT_ACCEPTANCE_CUTOFF` gets a DA place and
the skip obligation; a player below it must take a `[Q]` slot and owes no
obligation. Build the light `[Q]` model and rule (A)'s live wiring in the
same pass so the cutoff has both of its consequences at once.

---

## 6. Placeholders / tuning owned by the ranking-realism balance pass

- `DIRECT_ACCEPTANCE_CUTOFF = 100` — round placeholder; real tours accept
  ~104 directly into a 128 Slam.
- Which tiers are obligatory — currently only `'major'`. Adding the
  game's Masters-equivalent (likely `'tour'`) is a one-line change to
  `OBLIGATORY_TIER_SET`, but is a balance decision, not made yet.
- `[Q]` slot count per tier/draw size — now `QUALIFIER_SLOT_FRACTION`
  (1/8 of the draw) and `QUALIFYING_TIER_SET` (`{major, tour}`) in
  `QualifyingPolicy.ts`; both explicit placeholders.
- The current-rank-vs-rank-at-time simplification (§4) — revisit only if
  exploited.
