# Tennis rules & ATP structure — what we have vs. what's missing

Researched against the current 2026 ATP rulebook and tour structure.
Organized by topic: what real tennis does, what's built, and a verdict
— fix now, fix later, or deliberately simplified (and why that's okay).
Given this project's explicit "avoid the Football Manager complexity
trap" principle, not every real-world detail belongs in the sim — the
verdicts below are calibrated against that, not against maximum realism.

---

## 1. Match format (best-of-3 vs. best-of-5)

**Real tennis**: <cite index="22-1">only Grand Slam men's singles plays best-of-5 — the ATP Tour, ATP Finals, and Davis Cup all use best-of-3, and no rule change to men's Slam format has been approved despite periodic player-welfare debate.</cite> <cite index="22-1">Doubles nearly everywhere uses no-ad scoring (a single deciding point at 40-40, no advantage) and a 10-point match tiebreak instead of a full third set.</cite>

**What's built**: `StatisticalMatchSimulator.playBestOfThree()` — every match is best-of-3, always with standard advantage scoring, no exceptions.

**Verdict: fix now, it's cheap and meaningfully wrong for the "major" tier.** A "major" tournament tier exists in `TournamentTier` but every match plays identically to a "futures" match structurally. At minimum, major-tier matches should play best-of-5 for realism at the tier that most needs to feel distinct. No-ad doubles scoring isn't relevant yet since doubles doesn't exist (see §6).

---

## 2. Final-set tiebreak rules

**Real tennis**: <cite index="19-1">since 2022 all four Grand Slams use a unified 10-point tiebreak at 6-6 in the deciding set,</cite> <cite index="24-1">except Roland Garros historically required winning the final set by two games with no tiebreak at all — though even Roland Garros adopted the 10-point deciding-set tiebreak from 2022 onward, unifying all four majors.</cite> <cite index="20-1">A 10-point tiebreak requires a 2-point margin, same as a standard 7-point tiebreak just with a higher target.</cite> Regular tour (non-Slam) matches use a standard 7-point tiebreak in every set including the decider.

**What's built**: every set uses the same 7-point-equivalent tiebreak logic (`playSet()`'s tiebreak branch), no distinction between a regular set tiebreak and a deciding-set tiebreak, no surface/tier variation.

**Verdict: fix alongside §1** — if major-tier best-of-5 gets built, the deciding (5th) set should use a 10-point tiebreak at 6-6, matching every current Grand Slam. Not worth building tournament-by-tournament historical variation (e.g. old pre-2022 Wimbledon 12-12 rule) — that's chasing realism nobody in this audience needs.

---

## 3. ATP ranking system — this is the biggest real gap

**Real tennis**: <cite index="14-1">rankings are a rolling 52-week point total, not a lifetime cumulative sum</cite> — <cite index="18-1">results from the same tournament the previous year automatically drop off after 12 months, so players are simultaneously earning new points and defending old ones.</cite> <cite index="14-1">Only a player's best 18 results count</cite> (reduced from 19 for 2026), <cite index="15-1">with mandatory events — all 4 Grand Slams plus qualifying Masters 1000s — always occupying slots whether or not the player actually participates,</cite> and <cite index="14-1">skipping a mandatory event without a valid exemption puts a zero-point result in that slot rather than simply omitting it.</cite> <cite index="17-1">There's also a separate "Race" standing that resets every January and tracks year-to-date performance for Tour Finals qualification, distinct from the rolling Rankings.</cite>

**What's built**: `StandardRankingPointsTable.pointsFor()` computes points per tournament result, but nothing in `HirePlayerUseCase`/`SimulateMatchUseCase`/etc. was ever wired to accumulate them into any kind of ranking — and per the correction a few messages ago, when it *does* get wired, it needs to be a lifetime-additive or capped-best-N total, not a rolling 52-week window with automatic point expiry.

**Verdict: build this for real — close to the actual ATP mechanism, not a simplification.** This is a bigger, standalone piece of work, and deserves to be scoped properly rather than bolted onto the existing `StandardRankingPointsTable`. The core mechanism, adapted to this game's `GameWeek` model instead of real calendar dates:

- **Every tournament result a player earns gets recorded as a dated ledger entry** — `{ playerId, tournamentId, tier, points, weekEarned: GameWeek }` — not summed immediately into a single running total. This is the structural piece that makes rolling expiry possible at all; a flat cumulative counter can't un-count anything later.
- **A player's current ranking total is *computed*, not stored** — as of the current `GameWeek`, filter that player's ledger to entries within the last 52 weeks, discard everything older (this *is* the automatic point-expiry mechanism, just recalculated instead of actively "dropped").
- **Best-N cap**: within that 52-week window, only the player's best 18 results count toward their total (matching the real 2026 rule) — extra results beyond the best 18 simply don't add anything, they don't need to be actively excluded from the ledger, just excluded from the sum.
- **Mandatory-tier handling**: major-tier results always count toward the total regardless of whether they'd make the best-18 cut on points alone — this mirrors Grand Slams always occupying a ranking slot. Skip the "zero-pointer penalty for skipping a mandatory event" nuance for now — that requires modeling tournament *entry* commitments and no-shows, which is a real step further in complexity than this game's current scope needs. Worth a one-line note in the doc that this specific nuance was intentionally left out, same discipline as everything else flagged in this document.
- **Rank position** (the `#4`, `#58` shown on the roster dashboard) is a cross-player query, not something any single player's aggregate can compute alone — sort all players by their computed ranking total, descending. This belongs in the application/read layer as a query, not inside `Player` or any per-player domain service.

This is legitimately closer to a new small bounded-context concern (a `RankingLedger` and a `RankingCalculationService`) than a tweak to the existing `StandardRankingPointsTable` — scope it as such rather than trying to retrofit it into the existing single-total design.

---

## 4. Tournament tier point values

**Real tennis**: <cite index="15-1">Grand Slam champions earn 2,000 points; Masters 1000 winners earn 1,000; ATP 500 winners earn 500; ATP 250 winners earn 250 — round numbers matching the tournament's name/category.</cite>

**What's built**: `StandardRankingPointsTable`'s formula is `basePoints * 1.6^roundsWon`, with base points of 5/15/40/100/400 for junior/futures/challenger/tour/major — an exponential curve, not the real tour's flatter, round-based table.

**Verdict: rescale to match real ATP proportions now, not later** — given the ranking system itself is being built for real (§3), the point *values* feeding it should match real-world ratios rather than staying an arbitrary exponential placeholder. Recommended starting values, adapted to this game's 5 tiers against real ATP tiers: **major = 2000** (matches Grand Slam exactly), **tour = 500** (matching ATP 500 level), **challenger = 125** (matching real Challenger-tour champion points), **futures = 25**, **junior = 5**. These should be *champion* points, with a realistic per-round table below them (real ATP semifinalists earn roughly half of champion points, not an exponentially compounding fraction) — replace `StandardRankingPointsTable`'s `basePoints * 1.6^roundsWon` curve with an explicit per-round points table per tier, closer to how the real tour actually publishes its point breakdowns per round reached.

---

## 5. Seeding

**Real tennis**: standard seeding places seeds so the top-ranked players can't meet until the latest possible round — 1 vs. 16 in the round of 32, etc.

**What's built**: `BracketGenerator` was specifically described (per Claude Code's own summary) as building <cite index="0-0">"the standard recursive bracket slot order (1v16, 8v9, 4v13, 5v12, ... — the exact '1 vs lowest remaining seed' pattern real tournament draws use)."</cite>

**Verdict: already correct, no action needed.** This is the one area where the build already matches real tournament convention closely — good to explicitly confirm rather than assume, given this whole audit's purpose.

---

## 6. Doubles

**Real tennis**: <cite index="22-1">doubles is a major, structurally distinct part of the tour — best-of-3 with no-ad scoring and a match tiebreak replacing the third set at nearly every event, with Wimbledon men's doubles as the sole best-of-5 holdout.</cite>

**What's built**: nothing. `TournamentEntrant` is a single `playerId`; there's no concept of a pairing anywhere in the domain model.

**Verdict: deliberately out of scope, and correctly so.** This would roughly double the surface area of `Tournament`, `BracketGenerator`, and the simulator (pairing logic, doubles-specific scoring rules, doubles rankings). Rocking Rackets did support doubles, so it's a legitimate future differentiator — but it's a strong candidate for "later phase," not something the current MVP needs to feel complete.

---

## 7. Retirements and walkovers (mid-match, not career)

**Real tennis**: a player can retire mid-match due to injury (the match ends immediately, opponent advances), or a walkover occurs when a player doesn't start a scheduled match at all.

**What's built**: nothing — every simulated match runs to a full, clean conclusion. Note this is a *different* concept from `Player`'s career-lifecycle `stage: 'retired'`, which already exists and is unrelated.

**Verdict: worth adding eventually, low priority.** This is actually a cheap, high-narrative-value addition once fatigue is a real mechanic — a high-fatigue player having an elevated retirement chance mid-match would create exactly the kind of emergent story (per the Football Manager "unpredictability as story generator" principle from the marketing plan) this game wants. Not urgent for the current screen set, but worth a `BracketGenerator`/simulator follow-up later.

---

## 8. Wildcards and qualifying rounds

**Real tennis**: a meaningful fraction of any draw comes from qualifying tournaments or wildcard entries, not direct ranking-based acceptance.

**What's built**: `TournamentEntrant` has a `seed: number | null` but no concept of *how* an entrant got into the draw (direct entry, wildcard, qualifier).

**Verdict: skip for now.** This is exactly the kind of "systems for their own sake" complexity the plan has repeatedly flagged as a trap — it adds a whole qualifying-tournament sub-system for a narrative flourish (announcer-style "the wildcard run") that doesn't change core gameplay. Genuinely low priority, if ever.

---

## 9. Server tracking / break of serve

**Already flagged and prompted in the previous turn** — `MatchLog` has no server field, which is why break-of-serve commentary had to be faked as "reached deuce." This is the most urgent item on this whole list since it's actively degrading the match replay screen's core "feels live" goal right now. See the prompt already sent.

---

## 10. Things correctly and deliberately NOT modeled — worth stating explicitly so nobody "fixes" them later

- **Lets, faults/double faults, foot faults** — these are physical-play details invisible to a stat-driven simulation; modeling them would add granularity with no gameplay payoff.
- **Coaching timeouts, medical timeouts, on-court challenges/Hawk-Eye** — broadcast-spectacle details, not competitive mechanics; irrelevant to a manager sim's actual decisions.
- **Shot clock, service let rules** — same category as above.
- **Detailed calendar/surface-season structure** (e.g. real tour's clay season → grass season → US hardcourt swing rhythm) — a nice-to-have for later "flavor," not something the MVP loop needs.

These aren't gaps — they're correct omissions, and it's worth this document saying so explicitly, so a future audit doesn't mistake "not built" for "forgotten."

---

## Summary — priority order for what's actually worth doing

1. **Server field / break-of-serve** (already in flight, most urgent — actively affecting a live screen).
2. **Best-of-5 + 10-point deciding-set tiebreak for major-tier matches only** — cheap, meaningfully differentiates the "major" tier from lower tiers, which currently play identically.
3. **Real ATP-style rolling ranking system** — this is the largest single item on this list: a `RankingLedger` recording every tournament result with the `GameWeek` it was earned, a 52-week rolling window computed (not stored) per player, a best-18-results cap, mandatory-tier (major) results always counting, and a cross-player rank-position query. Pair with rescaled, realistic per-tier point values (§4) rather than the current exponential placeholder curve. This deserves its own scoped Claude Code prompt sequence — domain design first (the ledger + calculation service), then the read-side rank query, then wiring tournament completion to actually append ledger entries — rather than one large prompt.
4. Everything else on this list (doubles, retirements/walkovers, wildcards/qualifying) — legitimate future-phase ideas, not current blockers. Worth revisiting after Phase 0 validation tells you whether the core loop is even fun, not before.
