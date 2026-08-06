# Grand Circuit Implementation Roadmap

This is the working product board for Grand Circuit, the browser-first tennis
manager RPG inspired by Rocking Rackets and rebuilt for a modern audience.

The roadmap is deliberately organized around player experiences rather than
technical layers. A task is ready only when it describes a complete,
testable user outcome.

## Product Direction

Grand Circuit should preserve Rocking Rackets' strongest qualities:

- A small, meaningful roster.
- Simple stats with useful strategic differences.
- Scheduled matches and asynchronous progression.
- Player aging, decline, scouting, and replacement.
- Ranking-based competition without destructive player-versus-player systems.

It should improve the old experience through:

- A maintained, responsive browser experience.
- Clearer information architecture and feedback.
- Replay presentation built from immutable pre-simulated logs.
- Fair monetization that never sells an unconditional win-rate advantage.
- Modern notifications and social features after the core loop is proven.

## Current Branch Snapshot

The current branch has progressed beyond the original roadmap baseline:

- Talent-pool scouting and the `/scouting` flow are implemented.
- Manager XP, coach conversion, and the disclosed second-coach Pro exception
  are implemented.
- Ranking-ledger reads and player ranking positions are implemented.
- Match replay acceptance coverage is implemented.
- Manager identity and authorization are in Review, pending real Clerk keys and
  a production-mode smoke test.

## Board Workflow

| Status | Meaning |
|---|---|
| Backlog | Identified work, not yet prioritized for implementation. |
| Ready | Scope, acceptance criteria, and dependencies are clear. |
| In progress | Currently being implemented. |
| Review | Implementation exists; tests and product acceptance remain. |
| Blocked | Cannot proceed until a dependency or decision is resolved. |
| Done | Acceptance criteria and required verification are complete. |

## Delivery Rules

- Finish the match replay acceptance criteria before starting a new major
  screen.
- Prefer vertical slices that cross domain, application, API, and web layers
  when the player experience requires all of them.
- Keep domain code framework-free and cross-context references ID-based.
- Every match-related rule must have deterministic tests before balance tuning.
- Treat scheduled simulation and client playback as separate concerns. Do not
  introduce WebSockets or SSE for replay viewing.
- Separate MVP work from retention, social, and monetization work.
- Do not call a task done because it compiles; verify its acceptance criteria.

## Epic GC-1: Match Replay

**Priority:** P0

**Goal:** Make the replay screen the distinctive, credible experience of the
game before adding more major screens.

### GC-1.1 Replay presentation requirements

**Status:** Done

**Acceptance criteria:**

- The replay screen contains no rendered use of the forbidden real-time term.
- Set 1, Set 2, and Set 3 columns are always present.
- The active set is distinguished through styling, not a status badge.
- Unplayed sets are visibly blank or marked as not played yet.
- Current point-level score is displayed during playback.
- Deuce and Advantage states have distinct visual treatment.
- Commentary is accumulated newest-first as playback advances.
- Commentary shows `Nothing notable yet - keep watching` when playback has
  started but no notable event is visible.
- Scrub marks exist for breaks, set points, tiebreaks, set wins, and match
  completion.
- Pre-play state uses `Premieres at ...` wording.
- Completion state links back to the bracket.
- Completion state links to the next round when one exists, including when the
  next match has not yet been simulated.

### GC-1.2 Replay automated coverage

**Status:** Done

**Depends on:** GC-1.1

**Acceptance criteria:**

- A component or browser test covers the pre-play state.
- A test covers normal playback and newest-first commentary.
- A test covers point score, Deuce, and Advantage rendering.
- A test covers the premiere-edge catch-up state without using the forbidden term
  in rendered output.
- A test covers scrub marks and capped seeking.
- A test covers completion navigation with and without a next round.
- Tests use a small fixed replay fixture instead of waiting for real timers.

### GC-1.3 Replay data compatibility

**Status:** Review

**Acceptance criteria:**

- New replay logs include server metadata needed for break detection.
- Older logs without that metadata still render without false break events.
- Replay log storage remains immutable after simulation.
- The API returns one normal HTTP response for the replay blob.

## Epic GC-2: Manager and Roster Core Loop

**Priority:** P0

**Goal:** Let a player manage a small roster and make meaningful weekly
decisions.

### GC-2.1 Manager identity

**Status:** Review

**Acceptance criteria:**

- A manager can be created without developer-written database rows.
- The active manager is identified consistently across web and API requests.
- A manager can return to the same roster after refreshing the browser.
- One manager cannot read or mutate another manager's roster.
- Authentication is sufficient for MVP without introducing unnecessary social
  account complexity.
- Production identity is verified through Clerk behind an `AuthPort`.
- Local development identity is explicitly disabled when production Clerk mode
  is enabled.
- Future public profiles, messages, forums, and moderation use separate
  bounded contexts keyed by internal manager identity.

### GC-2.2 Roster dashboard

**Status:** In progress

**Acceptance criteria:**

- The dashboard shows roster slots used out of the current allowance.
- Player name, flag, rank, overall, age, stage, fatigue, points, and last result
  are visible.
- Technical, physical, mental, and surface information remains legible without
  opening a separate detail screen.
- Fatigue is shown as a meter with a readable state label.
- Stage includes a transition estimate where applicable.
- Empty roster state includes an explanation and a hire action.
- Sort options include fatigue and lifecycle stage/age.

### GC-2.3 Hire and release players

**Status:** In progress

**Acceptance criteria:**

- A manager can hire a valid player through the web UI.
- Invalid age, name, manager, and duplicate player IDs are rejected.
- The free roster cap is enforced by the application use case.
- A manager can release a player after an explicit confirmation step.
- Roster changes persist after refresh.

### GC-2.4 Training focus

**Status:** In progress

**Acceptance criteria:**

- A player has at most one training focus.
- Focus can target one surface or one skill cluster.
- The selected focus survives a page refresh.
- Invalid focus combinations are rejected by the application layer.
- Training effects are applied by a world tick, not immediately by the UI.

## Epic GC-3: Competition and Circuit

**Priority:** P0

**Goal:** Make the tennis circuit the main source of decisions, progress, and
emergent stories.

### GC-3.1 Tournament discovery and registration

**Status:** In progress

**Acceptance criteria:**

- Managers can browse open tournaments by tier, surface, week, and draw size.
- A manager can register an eligible roster player.
- Registration rejects retired players, duplicate entrants, invalid draws, and
  closed registration windows.
- The UI clearly shows why an ineligible player cannot enter.
- Registration persists and appears in the tournament entrant list.

### GC-3.2 Bracket and byes

**Status:** Review

**Acceptance criteria:**

- Supported draw sizes are 16, 32, 64, and 128.
- Seeds are placed deterministically according to the bracket policy.
- Byes are shown as `BYE` and `No opponent`, never as fake matches.
- Round status shows Upcoming, In progress, or Decided.
- Partial rounds show how many matches have been played.
- Completed rounds collapse without making the full bracket unreadable.
- Decided match cards link to their replay.

### GC-3.3 Match progression and ranking points

**Status:** In progress

**Acceptance criteria:**

- A due match can be simulated exactly once.
- The compact outcome advances the bracket and cannot be altered by replay
  viewing.
- The winner and loser receive the correct ranking consequences.
- Ranking points are visible in the roster and ranking read models.
- A completed tournament cannot be advanced twice.

## Epic GC-4: World Time and Async Simulation

**Priority:** P0

**Goal:** Make the game world progress while managers are away, preserving the
async character of Rocking Rackets.

### GC-4.1 Weekly world tick

**Status:** In progress

**Acceptance criteria:**

- A world has an explicit season and week.
- A weekly tick is idempotent for the same world/week.
- Player aging and training are applied once per tick.
- Due tournament matches are discovered and simulated by scheduled jobs.
- Tick failures are visible in logs and can be retried safely.

### GC-4.2 Worker reliability

**Status:** In progress

**Acceptance criteria:**

- BullMQ jobs have stable deduplication keys.
- Retried jobs do not duplicate outcomes, ranking entries, or domain events.
- Redis and Postgres connection failures produce actionable errors.
- Worker schedules are configurable for local development and deployment.
- A smoke test exercises a full tick against real Postgres and Redis.

### GC-4.3 Setup and development reset

**Status:** Review

**Acceptance criteria:**

- `npm run setup` can be run twice without hitting the roster-cap error.
- Existing seed rows are detected or the seed operation is explicitly reset.
- A documented clean reset wipes only local development data.
- `npm run dev` never re-seeds production-like data.
- Dependencies and generated build directories are writable by the development
  user.
- The README setup instructions match actual behavior.

## Epic GC-5: Simulation Credibility

**Priority:** P0

**Goal:** Ensure match outcomes feel fair, explainable, and statistically
credible before player retention testing.

### GC-5.1 Deterministic simulator contract

**Status:** Review

**Acceptance criteria:**

- A fixed random source produces a reproducible outcome and replay log.
- Every point follows valid tennis scoring rules.
- Deuce and Advantage transitions are tested.
- Tiebreak scoring is tested, including sudden-death resolution rules.
- Server alternation and break detection are tested.
- Replay timestamps are monotonic and end at total duration.

### GC-5.2 Balance and statistical tuning

**Status:** Backlog

**Depends on:** GC-5.1

**Acceptance criteria:**

- Attribute weights and surface bonuses are documented.
- A large simulation sample is used to compare rating differences with win
  rates.
- Surface specialists receive meaningful but not dominant advantages.
- Fatigue affects outcomes without making matches deterministic.
- Aging thresholds and decline rates are validated against intended session and
  season lengths.
- Results and methodology are recorded so future tuning is reproducible.

## Epic GC-6: Manager Progression and Scouting

**Priority:** P1

**Goal:** Add the RPG layer that gives managers progress beyond the current
roster.

### GC-6.1 Manager XP and reputation

**Status:** Backlog

**Acceptance criteria:**

- Managers earn XP from defined competitive and management actions.
- Reputation has a visible level and progression explanation.
- Progression never directly grants an unconditional match win-rate boost.
- Rewards are deterministic and covered by application tests.

### GC-6.2 Scouting

**Status:** Backlog

**Acceptance criteria:**

- Managers can discover procedurally generated prospects.
- Reports include uncertainty based on scout quality.
- A report is not an exact hidden-stat dump unless explicitly unlocked by a
  fair game rule.
- Prospects can be hired through the normal roster-cap rules.

### GC-6.3 Staff

**Status:** Backlog

**Acceptance criteria:**

- Coach, physio, and scout roles have distinct, documented effects.
- Staff effects are convenience/progression oriented and not direct paid power.
- Staff changes are visible and persist across ticks.

## Epic GC-7: Fair Monetization

**Priority:** P1, after core-loop validation

**Goal:** Validate willingness to pay without compromising trust or competitive
fairness.

### GC-7.1 Manager Pro entitlement

**Status:** In progress

**Acceptance criteria:**

- Free managers can play the complete core loop.
- Pro increases roster capacity only with the documented faster-decay tradeoff.
- Entitlement state is read through a billing port, not directly from Stripe in
  game logic.
- Checkout and webhook handling are idempotent.
- Pro and free win rates can be compared in analytics.

### GC-7.2 Cosmetics and convenience

**Status:** Backlog

**Acceptance criteria:**

- Cosmetic purchases do not alter match simulation inputs.
- Convenience features are clearly labeled as having no competitive effect.
- No offer uses pressure tactics or misleading scarcity.
- Pricing and tradeoffs are explained before purchase.

## Epic GC-8: Retention and Social

**Priority:** P2, after MVP retention evidence

**Goal:** Give managers reasons to return and interact without creating systems
sprawl.

### GC-8.1 Notifications

**Status:** Backlog

**Acceptance criteria:**

- Match and tournament events can trigger email or push notifications through a
  port.
- Duplicate events do not send duplicate notifications.
- Managers can control notification preferences.
- Notifications contain useful results without requiring a real-time session.

### GC-8.2 Academies and leaderboards

**Status:** Backlog

**Acceptance criteria:**

- Managers can join or create an academy.
- Academy standings are based on documented ranking rules.
- Leaderboards reset or season correctly without deleting historical records.
- Social features do not introduce destructive roster or account loss.

## Epic GC-9: Validation and Launch Readiness

**Priority:** P0 for beta, P1 for public launch

**Goal:** Prove that the game is fun and operable before expanding scope.

### GC-9.1 Closed beta onboarding

**Status:** Backlog

**Acceptance criteria:**

- A new player can register, receive a manager, hire a player, and enter a
  tournament without developer database intervention.
- Onboarding explains the core loop in under five minutes.
- Empty, loading, error, and success states exist for the primary flow.
- Beta users can report a problem from the game.

### GC-9.2 Observability and operations

**Status:** Backlog

**Acceptance criteria:**

- API, worker, and database failures are logged with correlation context.
- Scheduled job failures are discoverable without reading raw server logs.
- Database backups and restore procedures are documented.
- Match logs are retained and recoverable independently of tournament rows.
- A deployment can be rolled back without corrupting game-world state.

### GC-9.3 Phase 0 validation

**Status:** Backlog

**Acceptance criteria:**

- A landing page communicates browser-first, active maintenance, and fair
  monetization clearly.
- A waitlist captures early interest from Rocking Rackets and Online Tennis
  Manager communities.
- Outreach measures signups by source.
- The MVP is not expanded based only on assumptions; beta retention informs the
  next roadmap revision.

## Recommended Execution Order

1. GC-1.2: Add automated replay coverage.
2. GC-4.3: Make local setup and seed behavior reliable.
3. GC-2.1: Add real manager identity.
4. GC-2.2, GC-2.3, GC-2.4: Complete the roster decision loop.
5. GC-3.1, GC-3.2, GC-3.3: Complete tournament participation and progression.
6. GC-4.1, GC-4.2: Make scheduled world progression reliable.
7. GC-5.1, GC-5.2: Lock simulator behavior and tune balance.
8. GC-9.1, GC-9.3: Run a closed validation beta.
9. GC-6: Add manager progression and scouting based on beta feedback.
10. GC-7: Validate fair monetization after the core loop demonstrates retention.
11. GC-8 and GC-9.2: Add social retention and production operations.

## Definition Of Done

A task is complete only when:

- Its acceptance criteria are met.
- Domain/application rules have automated tests where applicable.
- API behavior is covered by integration tests where applicable.
- The UI has loading, empty, error, and success states where applicable.
- No design principle in `CLAUDE.md` or `docs/ui-direction.md` is violated.
- The relevant documentation is updated.
- The feature works against the local Docker/Postgres/Redis stack.
