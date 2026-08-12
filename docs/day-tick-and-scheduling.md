# Day tick & tournament day-scheduling (Phase 1 foundation)

This is the design for introducing a **day** granularity to the world clock,
so that **each day plays one tournament round**, normal tournaments span up to
a week, and majors/masters span two weeks. It is the foundation Phase 1's
fatigue and form systems ride on (both recover/decay on a daily rhythm in
Rocking Rackets), so it is being built first, before p1-fatigue/p2-form.

See `docs/rocking-rackets-competitive-analysis.md` for why fatigue/form/ladder
matter. This doc is only the *time model* that makes them meaningful.

## Current model (what exists today)
- `GameWorld.currentWeek: GameWeek {season, week}` is the ONLY clock unit.
- One weekly BullMQ job (`advance-world-week`) does everything on a week
  boundary: advance clock → age players → apply training → refresh talent pool
  → generate junior tournaments → start due tournaments.
- A SEPARATE 5-minute real-time job (`simulate-due-matches`) greedily
  simulates *every* current round of *every* started tournament, back to back,
  so a whole tournament completes within minutes of starting — **not** paced
  across in-game days.
- Tournaments: `weekScheduled: GameWeek` + `drawSize`; rounds (= log₂ drawSize)
  added incrementally via `addRound()`. No day or duration concept.

## Target model
- The world clock gains a **day within the week (1..7)**. Game time advances
  **one day per tick**; a week is 7 day-ticks.
- **Weekly systems stay weekly.** Aging, training application, talent-pool
  refresh, junior generation, ranking's rolling 52-week window, and
  start/close registration all continue to key off `GameWeek` and fire on the
  **week boundary** (when day rolls 7 → 1). Nothing about the 52-week ranking
  math changes. This is the deliberate scope line: **days exist to pace
  tournaments and drive fatigue/form; they do NOT speed up aging or rankings.**
- **Tournaments are paced by day.** A tournament plays **at most one round per
  day**. Round → day mapping comes from a swappable `TournamentSchedulePolicy`
  (same pattern as AgingPolicy/TrainingPolicy):
  - **One-week tiers** (futures / challenger / tour, all junior j-grades):
    round *r* is played on **day *r*** of the tournament's start week. A
    32-draw = 5 rounds on days 1–5 (days 6–7 unused — "might not take all
    days"). Max 7 rounds fits in a week.
  - **Two-week tiers** (major, and any masters-class tier): rounds are spread
    across **14 days** with rest days, e.g. `dayOffset(r) = ceil(r * 14 /
    numRounds)`, so a 7-round major plays roughly every other day over a
    fortnight. The tournament's `weekScheduled` is its *start* week; it
    remains active into `weekScheduled + 1`.
- **Match simulation is folded into the day tick** and paced: on each day
  tick, after advancing the clock (and running week-boundary work if it's a
  new week), for every started, unfinished tournament, simulate the current
  round **iff that round's scheduled day ≤ the new current day**. Then add the
  next round (as today, via `addRound`), which becomes due on *its* scheduled
  day — a later tick. The standalone greedy 5-min sweep is retired (or made a
  safety net that also respects the due-today gate).

## Absolute-day arithmetic (domain)
Mirror the existing `weeksBetween`/`addWeeks` helpers in `world/GameWorld.ts`:
- `absoluteDay(clock) = ((clock.season * WEEKS_PER_SEASON) + (clock.week - 1)) * DAYS_PER_WEEK + clock.day`
- Add `daysBetween(a, b)` and `addDays(clock, n)`; keep `weeksBetween`/
  `addWeeks` untouched for weekly systems (a clock's `{season, week}` is still
  a valid `GameWeek` for every existing caller — the `day` is additive).
- `DAYS_PER_WEEK = 7`.

## Aggregate & schema changes
- **GameWorld**: add `day: number (1..7)` to `currentWeek` (or a parallel
  `currentDay`). `advanceWeek()` becomes `advanceDay()`: increment day; on
  7 → 1 also increment week (existing season rollover) and RETURN a flag
  `weekRolledOver` so the handler knows to run weekly work. Idempotency
  (`lastAppliedTick`) is unchanged — now keyed to a per-day tick key.
- **game_worlds table**: add `current_day smallint not null default 1`.
- **Tournament**: add a `startDay` (absolute day, or day-within-week) so the
  schedule policy can compute per-round due days; expose
  `roundScheduledDay(roundNumber)` (delegates to the policy). No change to the
  incremental `addRound` flow.
- **tournaments table**: add `start_day` (nullable until started, or default
  to day 1 of `weekScheduled`).
- **players table** (for Phase 1 fatigue/form, built next): `fatigue integer
  not null default 0`, `form integer not null default 0`, plus an `endurance`
  attribute (fatigue-accrual modifier — distinct from the existing `stamina`
  physical attribute, which is an in-match strength input; keep both).

## Worker / cadence changes
- `advance-world-week` job → `advance-world-day` (one tick = one day). The
  handler advances the day, runs weekly work only when `weekRolledOver`, then
  runs the day's due-match simulation + daily fatigue recovery.
- `WORLD_TICK_INTERVAL_MS` now means **ms-per-day** (dev override). A dev week
  is 7 × that. `WORLD_TICK_CRON` default becomes a daily cadence (e.g. daily
  03:00) instead of weekly Mondays.
- `intervalTickKey`/`isoWeekTickKey` gain a day-bucket variant so each day gets
  a distinct idempotency key (the current ISO-week key would no-op days 2–7).
- `/world/clock` exposes the current day + next-day countdown; the "next
  weekly refresh" is now `day → 7 boundary`, derived from the same anchor.

## Fatigue/form on this rhythm (Phase 1 p1/p2, built after this foundation)
- **Fatigue** accrues per match (points-played ÷ endurance) in
  `SimulateMatchUseCase`; recovers a fixed amount **per day tick**; above a
  threshold applies a strength penalty in
  `StatisticalMatchSimulator.effectiveRating`. Because a player plays ~1
  match/day in a tournament but recovers a flat amount daily, deep runs in
  back-to-back tournaments genuinely exhaust a player — the intended tension.
- **Form** +1 per real match; decays on the **week boundary**; out-of-band
  skill/serve penalty + reduced XP; in-band small bonus.

## Deliberate scope guards
- Days do NOT change aging speed, retirement age, or the 52-week ranking
  window — those stay weekly. (Prevents a balance rewrite.)
- Practice sessions (a no-form training outlet, Phase 3) will slot naturally
  into unused tournament days later — noted, not built now.
- One-week vs two-week tier classification lives in the schedule policy, not
  scattered in tournament-generation code.

## Open decision (confirm before building the clock)
Whether the above split is correct: **days pace tournaments + fatigue/form
only; aging/rankings stay weekly.** This is the recommended model (keeps the
large weekly system intact). The alternative — everything goes daily — is a
much larger balance rewrite and is NOT recommended.
