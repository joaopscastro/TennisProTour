# Tournament fill system (unclaimed player pool, not a separate NPC species)

## Status: items 1-4 built and tested; item 5 (actual tournament fill) NOT built yet

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

5. **Tournament fill, at start time**: if a tournament has unfilled
   slots when it needs to start, select unclaimed players by current
   ranking appropriateness for that tier/age-band (reusing
   `RankingCalculationService`, no separate ranking approximation).
   Real managers' registrations are never displaced. Skip any player
   already committed to another tournament this `GameWeek` (reuse the
   existing weekly-cap check).

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
`RefreshTalentPoolUseCase`'s expiry sweep is a plain read-then-write
loop (`findAvailable()` then, per candidate, `markExpired()` + `save()`),
not a single atomic conditional UPDATE the way `claimIfAvailable()` is.
This was already a narrow, pre-existing race (a claim landing inside
this loop's execution window could get silently overwritten back to
'expired'), and the fill-only conversion added by this pass raises the
stakes slightly: if that race fires, BOTH the real claim AND this
loop's fill-only conversion would try to save a `Player` under the same
id, and whichever write lands last wins. In practice this only matters
if a claim completes in the narrow window between this loop's read and
its write for that exact candidate — worth a dedicated hardening pass
(making expiry a single atomic conditional UPDATE, mirroring
`claimIfAvailable()`), not something to quietly patch as a side effect
of unrelated work.

## Deliberately out of scope (still true — item 5 not built)
- **Item 5 itself (tournament fill at start time) is NOT built.** This
  pass only built the population/persistence/development mechanics
  (items 1-4) that item 5 will eventually draw from. No tournament
  currently pulls a fillOnly player into an unfilled slot.
- No AI decision-making beyond the simple automatic training default
  and (whenever item 5 is built) tier-appropriate fill-selection.
- No manager-facing UI for browsing/managing the fill-only population.
