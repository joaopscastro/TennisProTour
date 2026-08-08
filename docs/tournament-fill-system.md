# Tournament fill system (unclaimed player pool, not a separate NPC species)

## Status: items 1-5 all built and tested

## Revision note
This replaces an earlier draft that proposed a separate persistent
"NPC" player species. That was unnecessary complexity — the existing
talent pool, generalized slightly, already does everything needed.

**Correction, found while implementing (not true when this doc was first
written):** the claim above that "unclaimed players already age via
PlayerAgingService" was NOT accurate against the actual codebase at the
time — `TalentPoolCandidate` was (and remains) deliberately NOT a
`Player`, had no age-advancing hook anywhere, and PlayerAgingService is
tightly typed against `Player` specifically (calls `Player`-only
methods), not some structurally-generic "anything with an age" shape.
The real mechanism built to make this doc's intent true is:
`TalentPoolCandidate` itself still never ages — instead, the exact
moment a candidate would go stale, it's converted into a REAL `Player`
aggregate (`Player.generateFillOnly`, `managerId: null`, `fillOnly:
true`), which THEN rides the existing, unmodified weekly-tick aging
loop (`AdvanceWorldWeekUseCase`) like any other player. See item 2
below for the mechanics.

## The problem
A tournament that doesn't attract enough real-manager registrations
before it needs to start currently has no fallback.

## Design

1. **Weekly talent-pool generation is unchanged** — same 14-16-year-old
   batch job already built.

2. **Built.** "Expiry" never deleted a `TalentPoolCandidate` row (it
   never did, even before this pass — `TalentPoolCandidate.markExpired()`
   only ever flips `status` to `'expired'`, and no adapter has a delete
   method). What WAS missing, and is now built: the moment
   `RefreshTalentPoolUseCase`'s weekly sweep expires a candidate, it
   also converts it into a real, permanent `Player`
   (`Player.generateFillOnly`, reusing the candidate's own id — same
   "this IS that player from here on" convention
   `ClaimTalentPoolCandidateUseCase` already uses for an actual claim).
   The candidate row stays forever as a historical 'expired' record;
   the new fillOnly Player is what actually keeps developing. Dropping
   out of the actively-claimable Scouting list after the existing
   2-week window is unchanged (`findAvailable()` already excluded
   'expired' rows before this pass) — the scarcity/urgency mechanic is
   untouched.

3. **Built.** `GenesisSeedFillOnlyPlayersUseCase` +
   `apps/api/src/scripts/genesisSeedFillOnlyPlayers.ts` (run via
   `npm run genesis-seed -w apps/api`, NOT wired into `npm run setup` —
   deliberately left as an explicit, separate step for now). Generates
   real `Player` aggregates directly (`Player.generateFillOnly`) across
   `GENESIS_AGE_RANGE` (14-37yo, StandardAgingPolicy's full non-retired
   span), reusing `PlayerGenerationPolicy.generate()` completely as-is.
   Default population: 300 — chosen for roughly a dozen players per
   age-year across the ~24-year span, real enough density for
   "ranking-appropriate filler" selection later (item 5) without being
   an arbitrary huge number. A real run's actual reported distribution
   (uniform by construction, verified both by a unit test asserting
   spread and live against Postgres): every one of the 24 age-years
   populated (roughly 6-18 players each), and all three non-retired
   lifecycle stages represented (youth/prime/decline, never retired —
   excluded by construction since a retired filler could never be
   entered into a tournament anyway).

4. **Built.** `weakestTrainableAttribute` (`PlayerAttributes.ts`):
   picks the single lowest technical-or-physical attribute (never
   mental, structurally). `AdvanceWorldWeekUseCase` calls it fresh
   every tick for any `player.fillOnly === true` (recomputed each week,
   not frozen at generation time — the weakest attribute can and does
   shift as training progresses) and trains that, uncoached (no manager
   exists to have a coach). A RELEASED player (`managerId: null` but
   `fillOnly: false`) is NOT affected by this branch — `fillOnly`, not
   `managerId`, is what distinguishes "auto-train toward weakest" from
   "keep whatever currentFocus a departed manager last set."

5. **Built.** `StartDueTournamentsUseCase` — the "this tournament's
   registration window is over, time to start it" trigger that never
   existed before (CLAUDE.md's disclosed gap: "open tournaments never
   expire if their draw doesn't fill" — literally true; neither of the
   two existing `startWithBracket` call sites, `OpenTournamentUseCase`
   (admin-seeded fixed entrant lists) or `RegisterEntrantUseCase`
   (starts only when the LAST slot fills naturally), could ever reach
   an under-filled draw). Runs every weekly tick, right after junior
   generation, gated the same way. For every open tournament whose
   `weekScheduled` has fully PASSED (strictly — see the note below on
   why `>` and not `>=`) and which is short of `drawSize`: fills the
   remaining slots, then generates the bracket (a still-short draw
   after filling gets byes, same as any other partial field).

   **Selection**: "ranking appropriateness for the tournament's
   tier/age-band" is `isAgeEligibleForTournamentBand` — the exact same
   one-directional rule `RegisterEntrantUseCase` already enforces on
   real registrations (play up allowed, play down or senior-into-junior
   not) — not a competing numeric ranking. Among eligible candidates,
   the REAL `RankPositionQuery` for that band is genuinely queried and
   preferred first (mirrors juniorMasters' invite order); in practice
   this is always empty since an unclaimed player has by definition
   never played a ranked match, but the query is honestly reused, not
   stubbed. Everyone else fills in next — existing fillOnly Players
   before still-Scouting-visible fresh candidates (minimizes collateral
   impact on the claimable pool), broken by id for a fully deterministic
   order. Never reads `overallRating()` or any other ability number for
   ordering — that would be exactly the "separate ranking approximation"
   this design avoids.

   **Real managers' registrations are never displaced** —
   `Tournament.registerEntrant` only ever appends; fill only tops up
   remaining empty slots. A candidate already registered in another
   tournament the same `weekScheduled` (`TournamentRepository.findByPlayerAndWeek`,
   the same query `RegisterEntrantUseCase`'s junior weekly-cap already
   reads, generalized here to every tier) is skipped — tournaments are
   processed one at a time, saving each before the next, so this
   correctly sees a fill made moments earlier the same run.

   **Why `weeksBetween(weekScheduled, currentWeek) > 0`, strictly, not
   `>= 0`**: `GenerateJuniorTournamentsUseCase` opens every junior
   tournament with `weekScheduled: currentWeek` — this exact tick's
   week — and `StartDueTournamentsUseCase` runs on that SAME tick,
   right after. An inclusive `>= 0` comparison would force-start a
   junior tournament the very same tick it opens, before any manager
   ever had a chance to see or register for it — caught by a dedicated
   test before it ever shipped, not found live.

   **Deliberately untouched**: `OpenTournamentUseCase`
   (the dev seed script's deliberately-partial demo tournament and
   juniorMasters' "must be earned into, never auto-filled" invite list
   both rely on getting EXACTLY the entrant list they were given) and
   `RegisterEntrantUseCase`'s exactly-full trigger (fill can never
   engage there — by the time that branch runs, there are no unfilled
   slots left).

6. **No separate population-maintenance job needed.** Since nothing is
   deleted anymore, the pool grows and diversifies organically from the
   existing weekly generator alone — more real depth accumulates
   automatically as the world's simulated time progresses.

## Open question — answered: permanently fill-only, confirmed
Once a player has aged out of the active Scouting list, should they
remain claimable at all (via some broader search) or become
fill-only/no-longer-claimable permanently? **Answered: permanently
fill-only.** Implemented exactly that way — `Player.fillOnly` has no
setter back to `false`, no use case ever claims a fillOnly player, and
`TalentPoolCandidate.markExpired()` (pre-existing) already has no
un-expire path either. Matches the original reasoning: avoids extending
the Scouting UI to browse a years-deep historical roster.

## Known gap, disclosed rather than fixed as a side effect of this pass
Both `RefreshTalentPoolUseCase`'s expiry sweep AND
`StartDueTournamentsUseCase`'s fresh-candidate fill conversion are a
plain read-then-write (`findAvailable()`/eligibility-filter, then, per
candidate, `markExpired()` + `save()`), not a single atomic conditional
UPDATE the way `claimIfAvailable()` is. This was already a narrow,
pre-existing race in the expiry sweep alone (a claim landing inside its
execution window could get silently overwritten back to 'expired'), and
the fill-only conversion now shared by both use cases raises the stakes
slightly: if the race fires, BOTH the real claim AND a fill-only
conversion would try to save a `Player` under the same id, and
whichever write lands last wins. In practice this only matters if a
claim completes in the narrow window between the read and the write for
that exact candidate — worth a dedicated hardening pass (making expiry
a single atomic conditional UPDATE, mirroring `claimIfAvailable()`),
not something to quietly patch as a side effect of unrelated work.

## Deliberately out of scope
- No AI decision-making beyond the simple automatic training default
  and tier-appropriate fill-selection (age-band eligibility + real
  ranking preference where one exists + deterministic tie-break).
- No manager-facing UI for browsing/managing the fill-only population,
  and no UI indication on the bracket screen that some entrants are
  fillers rather than real managers' players — a real, disclosed gap,
  not an oversight: a manager currently has no way to tell a filler
  apart from a real opponent by looking at the bracket.
