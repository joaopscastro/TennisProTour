# Junior circuit design — researched proposal

## What real junior tennis actually looks like

### Age-banded circuits, not one flat "junior" pool
<cite index="30-1">The Tennis Europe Junior Tour separates competition into distinct age bands — U12, U14, and U16 — each with its own eligibility window.</cite> <cite index="27-1">Only U14 and U16 have their own published ranking; U12 players instead earn "Starting Points" that ease their transition into the U14 ranking</cite> rather than being ranked outright — <cite index="25-1">this follows the ITF's own age-eligibility rule that 12-and-under events are unranked and unseeded entirely.</cite> Above that sits <cite index="23-1">the ITF World Tennis Tour Juniors, a U18 global circuit graded J30 through J500 by ranking points awarded</cite> — <cite index="17-1">J30 events are entry-level for players new to international competition, escalating through J60, J100, and J200 for increasingly advanced players, up to J500 for players already near the top 500 in the world.</cite>

### A real graduation bridge between bands, not an abrupt cutoff
<cite index="25-1">Players turning 15 or 16 during the year have their ITF Junior Circuit ranking from the previous week factored in at 200% weight when moving up an age band — the same mechanic applies to professional ATP/WTA rankings for players transitioning out of juniors entirely.</cite> This is a real, deliberate design choice in the actual sport: a player's earned status carries forward with a boost when they age into the next competitive tier, rather than resetting to zero.

### The same rolling-ranking shape we already built, just smaller-N
<cite index="23-1">ITF junior rankings use a best-6-results-over-52-weeks system</cite> — <cite index="20-1">confirmed directly by the ITF's own FAQ: a ranking consists of a player's best six singles results over a rolling 52-week period.</cite> This is **structurally identical** to the pro-tour ranking system already built for this project (rolling 52-week window, best-N results) — just a smaller N (6 instead of 18). The `RankingCalculationService` built for the senior tour is directly reusable here, just parameterized differently per age band, rather than needing new machinery.

### A pyramid: many small events feeding a few prestigious ones
<cite index="19-1">The tournament structure follows a pyramid — each nation/region has more lower-grade tournaments to support the player pathway, with the number of tournaments shrinking at each higher grade.</cite> <cite index="30-1">A small "Super Category" of elite U14/U16 events sits at the top, limited to one per week with larger draws (48-64) and higher sanction requirements.</cite> Real, famous examples: <cite index="28-1">the Petits As in Tarbes, France is one of six Super Category U14 events and is recognized as the world's leading indoor U14 tournament.</cite> <cite index="24-1">Its Tennis Europe Junior Masters is the U14 circuit's season-ending championship, featuring the top 8 boys and girls of the year — Kim Clijsters and Rafael Nadal both capped their best U14 seasons by winning it, and Andy Murray, Alexander Zverev, Simona Halep, and Belinda Bencic are all past medalists there.</cite>

### Real scheduling constraints, not unlimited play
<cite index="20-1">A player may enter up to three ITF Junior Circuit tournaments in a single tournament week, assigning a priority order to each entry.</cite> This creates real weekly decision-making — which three, in what priority — without needing a punitive mechanic like Rocking Rackets' form penalty.

### The exact ITF point ladder — real, sourced numbers, ready to reuse
<cite index="31-1">Since the 2023 rebrand, ITF junior grade names directly state the points awarded to the singles winner: J30, J60, J100, J200, J300, and J500 — the old Grade 5 through Grade A names respectively — with Junior Grand Slams sitting above J500 as the ceiling tier.</cite> This is a clean, already-sourced number ladder (30/60/100/200/300/500) that maps almost directly onto the shape `StandardRankingPointsTable` already uses — worth reusing these real values directly for the junior sub-tiers' point curve, rather than inventing placeholder numbers the way the senior tour's table currently does.

**Note on Tennis Europe's numbers specifically**: <cite index="32-1">the real category structure (Category 3 → Category 2 → Category 1 → Super Category, culminating in the European Championships or Junior Masters) is confirmed and worth borrowing structurally,</cite> but neither the official FAQ nor the tour-structure page publishes exact point values for these categories — only relative ordering. Rather than invent numbers for a system whose real ones aren't published, the proposal below leans on the ITF ladder (which does have real numbers) as the actual point curve, and treats the regional-pathway *idea* as the structural inspiration for the "many small events feeding a few prestigious ones" pyramid, not a source of literal numbers.

### A cheap path back to the national-team hook, dropped earlier in this build
<cite index="32-1">Tennis Europe runs age-banded team events — Winter Cups and Summer Cups — which serve as the actual qualifying pathway into ITF World Junior Tennis and the Junior Davis/Billie Jean King Cups.</cite> This is worth flagging as a future, much cheaper way to revive the national-team call-up hook that was named as a real Rocking Rackets strength in the very first research done on this project, then dropped once flags became purely cosmetic. A junior-scale, age-banded team event is a smaller build than a full senior World Team Cup — worth keeping in mind as a natural next step after the junior circuit itself exists, not something to build in the same pass.



## Finalized design — one combined junior ladder, not two parallel systems

Decision: merge ITF and Tennis Europe into a single ladder rather than
modeling them as two separate systems a player tracks in parallel. The
real-world separation exists for governance reasons (different
federations), not because a player experiences them as fundamentally
different — and since only the ITF ladder has real, published numbers,
merging avoids inventing a second number table for a system whose real
numbers were never made public.

**Scope assumption, carried forward from this decision**: junior
remains its own graduated system, feeding into the existing senior
ladder (futures/challenger/tour/major) via the carryover bridge below —
not merged into one single continuous progression spanning junior and
senior tournaments. If this assumption is wrong, revisit before
implementing.

1. **Two age bands, U14 and U16**, each running its own independent
   six-rung ladder using the real, sourced ITF point values directly:
   **J30 → J60 → J100 → J200 → J300 → J500**, with a season-ending
   **Junior Masters** capstone above J500 (exact point value not
   published anywhere found — flag as an explicit placeholder, unlike
   the six real J-grade numbers).

2. **One ranking per age band**, reusing `RankingCalculationService`
   exactly as already built for the senior tour — same rolling 52-week
   window, just `bestN = 6` (the real ITF rule) instead of 18, scoped
   independently per band so a player's U14 results don't bleed into
   their U16 ranking.

3. **A weekly entry cap** (e.g. 2-3 tournaments per player per
   `GameWeek`) as the actual fix for the earlier "form" discussion —
   real scheduling tension without Rocking Rackets' punitive skill
   penalty.

4. **A graduation carryover bonus** when a player crosses from U14 into
   U16, and again from U16 into the senior ladder — a one-time starting
   bonus computed as a fraction of the player's ranking total from the
   band they're leaving, rather than a hard reset to zero. Exact
   percentage is a placeholder to tune, not a sourced real number (the
   real system's 200%-weighted transition works differently — dual
   counting during a transition window — which is more mechanism than
   this needs; a simpler one-time bonus captures the same spirit).

5. **Reliable, abundant weekly generation** across the full ladder for
   both age bands — this is the actual fix for the original pacing
   complaint, not an invented no-stakes match type.

6. **All tournament names must be fully original** — no real event
   names (nothing resembling Wimbledon Juniors, the Orange Bowl, Petits
   As, etc.), consistent with the project's existing fictional-player
   convention extended to fictional tournaments too.

## Correction — rankings must be earned, not granted (applies to both junior and senior)

A player has a ranking in a given band/tier **only if they've actually
won at least one match there** — never by mere participation, and
never by aging into eligibility alone. Two concrete consequences:

1. **This exposes a real bug already shipped in `StandardRankingPointsTable`**,
   not just a rule for the new junior work. The existing formula —
   `basePoints * 1.6^roundsWon` — returns `basePoints * 1.6^0 =
   basePoints` when `roundsWon = 0`, meaning a first-round loss
   currently earns full base ranking points. This has been true since
   the ranking system was first built and tested, and needs fixing
   regardless of the junior circuit work: `pointsFor` must return 0
   when `roundsWon = 0`, for every tier, not just the new junior ones.

2. **The graduation carryover (item 4 in the finalized design above)
   can't manufacture a standalone senior-ranking ledger entry purely
   from an age-band transition** — that would itself be an unearned
   ranking. Instead: the carryover sits dormant as a bonus multiplier
   tied to the player, and only applies to their *first real
   senior-tier ranking-ledger entry*, once they actually play and win
   a senior match. A senior ranking only ever comes into existence
   through a genuine result — the carryover just amplifies that first
   real result rather than fabricating one ahead of it.

3. **Rank-position queries must treat zero-result players as
   genuinely unranked ("NR"), not ranked-at-the-floor with a score of
   zero** — this matters for both the roster dashboard's rank display
   and any junior-band ranking view.

## What's deliberately NOT being replicated, and why

- **Two separate parallel systems (ITF + Tennis Europe)** — merged into one ladder per the decision above; real numbers only exist for one of them anyway.
- **Multiple regional confederations** (ATF, CAT, COTECC, etc.) — real-world geographic/political structure with no gameplay payoff for a game that isn't simulating international sports governance.
- **IPIN eligibility, insurance, and sanctioning bureaucracy** — irrelevant to a manager sim's actual decisions, same category as lets/faults/coaching challenges already excluded from the match-simulation side.
- **Doubles-inclusive ranking weighting** — doubles itself is already explicitly deferred; no reason to half-build its ranking implications.
- **The real 200%-weighted dual-counting transition mechanism** — a simpler one-time carryover bonus captures the same spirit without the added bookkeeping complexity.

## A related, separate observation worth flagging (not solving now)

`PlayerAgingService`'s current `youth` stage runs from birth up to age 20 — a single wide band. Real juniors transition out of pure age-banded junior competition well before that, typically starting senior Futures/Challenger-tier play around 16-18 while still juniors-eligible. This project's `youth` stage doesn't currently reflect that overlap at all. Worth a future look at whether `youth` should split or overlap with early senior-tier eligibility — but that's a separate question from the junior-circuit structure above, and shouldn't be conflated with it or solved in the same pass.

## Status

**Implementation of items 1-5 (finalized design) and the ranking-correction section is complete, built across five passes.** This section was rewritten after the fact to report honestly what shipped versus what drifted or was deferred — see each item below rather than trusting the plan alone.

**Built as designed:**

- **Item 1 (combined ladder, two bands)** — `TournamentTier` now includes `j30`/`j60`/`j100`/`j200`/`j300`/`j500`/`juniorMasters` (`JuniorTier`), with `AgeBand` (`'u14'|'u16'`) living on `Tournament`/`RankingLedgerEntry`, not baked into the tier name, exactly as scoped. U12 stayed out of scope, matching the research above.
- **Item 2 (per-band ranking, bestN=6)** — `RankingCalculationService` takes `bestResultsCap` as a constructor parameter (18 default for the senior tour, 6 for either junior band via `RankingBand.bestResultsCapFor`); `RankPositionQuery` is scoped to exactly one `RankingBand` (`'senior'|'u14'|'u16'`) so a player's bands never mix. This is a genuine parameterization of the existing service, not a parallel implementation.
- **Item 3 (weekly entry cap)** — 3 tournaments/week, the real ITF number (not a guess — the research above explicitly sourced "up to three"), enforced in `RegisterEntrantUseCase`, scoped to junior tiers only (no senior-tour cap exists or was added).
- **Item 4 (graduation carryover)** — `AdvanceWorldWeekUseCase` detects a U14→U16 or U16→senior crossing during the weekly tick and records a dormant bonus (`GRADUATION_CARRYOVER_FRACTION`, an explicit unsourced placeholder) on the `Player`; `SimulateMatchUseCase` consumes it only on the player's first real (points > 0) result in the new band, then clears it. Never writes a ranking-ledger entry by itself.
- **Item 5 (abundant weekly generation)** — `GenerateJuniorTournamentsUseCase` + `StandardJuniorTournamentSchedulePolicy`, run from the same worker tick as aging: J30/J60/J100 open every week, J200 every 2 weeks, J300 every 4, J500 every 8 (decreasing frequency, increasing draw size), identically for both bands. A typical week opens 12 junior tournaments across both bands combined, verified against live Postgres. JuniorMasters fires once a season, gated by live ranking position (top 16 invited, never open registration) — a band without 16 ranked players is skipped for the season rather than faked.
- **Ranking-correction items 1-3** — `pointsFor(tier, 0)` returns 0 across every tier (senior included, not just junior — this was a real pre-existing bug, now fixed with a regression-guard test); the graduation carryover never manufactures a standalone ledger entry (see item 4 above); `RankPositionQuery` excludes zero-qualifying-result players from the ranked list entirely (genuinely NR), rather than floor-ranking them at zero — also fixed for the senior query, not just the junior ones.

**Item 6 (original tournament names) — NOT built. This is real drift, not a scope cut.** There is no tournament-naming system anywhere in this codebase, for any tier, junior or senior — the `tournaments` table has no `name` column, and no code anywhere generates or stores a display name for a tournament. The "must be fully original" constraint was flagged during item-1's implementation as having nothing to attach to yet, and was never revisited. If tournament names are added later (junior or senior), the constraint in item 6 still applies and should be enforced then.

**Gaps found during implementation, not anticipated by this proposal — disclosed here, not fixed:**

- **No player-age eligibility enforcement at registration.** `Tournament.ageBand` governs which ranking band a result counts toward, but `RegisterEntrantUseCase` never checks a registering player's actual age against it — nothing currently stops a senior player from registering into a U14 draw, or vice versa. A real gap, found while writing this status update, not previously disclosed.
- **Open tournaments never expire if their draw doesn't fill** — pre-existing behavior, not junior-specific, but it interacts with abundant generation: with no player activity, unfilled tournaments accumulate rather than cycling out (was disclosed when item 5 shipped).
- **The real ITF "priority order" among a week's entries is not modeled** — the weekly cap is a flat ceiling with no way to rank which of several clashing tournaments a manager prefers; disclosed in code (`juniorEntryCap.ts`) as a deliberate simplification when item 3 shipped, restated here for completeness.
- **No HTTP routes or frontend surface for any of this yet** — junior rankings, the weekly-cap rejection, carryover status, and generated junior tournaments are all real and tested at the domain/application layer, reachable today only through the same generic `/tournaments` and registration endpoints senior tournaments use (no tier filtering, no dedicated junior UI). Consistent with this project's established "domain ships ahead of UI" pattern (see CLAUDE.md's Manager & Progression section for the same pattern with coaching), not a new kind of gap.

**Deliberately still not built, exactly as originally scoped (not drift):** the national-team call-up hook / Winter-Summer Cups, and the `PlayerAgingService` youth-stage overlap with early senior eligibility — both explicitly flagged above as separate, future work, never promised for this pass.

See `docs/junior-circuit-implementation-prompts.md` for the sequenced Claude Code build plan, if it exists — it was referenced by the original version of this document but was never found in this repository during implementation (same gap as this file itself, which also didn't exist here until this status update created it from the context it was originally supplied in).
