# Ranking-realism proposal (P9)

Status: **partially built.** The obligatory-tournament rule's domain
core ships in this pass (real, tested code — see §3). The live wiring of
that rule (§4) and qualification rounds `[Q]` (§5) are designed here but
NOT yet built. This doc is the plan the next session builds from, in the
same spirit as `docs/junior-circuit-research-and-proposal.md`.

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

**Deliberately NOT built this pass** (needs a migration + a new
tick dependency + live verification, i.e. its own budgeted pass): the
persistence and injection wiring in §4. The domain core is ready to wire
with zero further domain changes.

---

## 4. Remaining work to make rule (A) LIVE

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

## 5. Qualification rounds `[Q]` — design (not yet built)

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
- `[Q]` slot count per tier/draw size — unset; part of the light-model
  build.
- The current-rank-vs-rank-at-time simplification (§4) — revisit only if
  exploited.
