# Tennis Manager RPG — Business & Software Plan

## 1. Rocking Rackets: what it got right and wrong

**What it got right**
- **Instant time-to-fun.** <cite index="1-1">Players could start a match less than 5 minutes after registering</cite> — no onboarding friction.
- **Simple, legible core loop.** <cite index="23-1">You hire players with manager rating points, sign them up for tournaments, and earn more rating points by winning</cite>. <cite index="23-1">Player stats (surface affinity, strength, speed, mentality) are simple enough to understand at a glance but deep enough to build strategy around</cite>.
- **Scarcity by design.** <cite index="23-1">You could only manage two players at once early on</cite> — this forces meaningful choices instead of "collect everything," which is a good RPG-econ instinct.
- **Long-term progression + decay.** <cite index="2-1">Players age and decline, so managers always have to scout new talent</cite> — this is what kept people playing for years despite abandonment; it built a scouting/economy meta-game around a sport that normally has no "collection" layer.
- **Social/competitive layers beyond 1v1.** <cite index="2-1">National team call-ups, singles and doubles, live match scoring</cite> gave players reasons to interact with each other, not just the AI.

**Correction — it does have monetization, and it's a genuinely good model.** Rocking Rackets has a VIP tier: 4 roster slots instead of 2 (offset by a steeper weekly point-decay penalty as a built-in tradeoff), longer tournament registration windows, extra stats/history/ranking-graph pages, a vacation-delegate feature (another VIP manages your roster while you're away), VIP-only low-cap worlds, custom player creation tied to paid tokens, and no banners. Almost none of this is a raw power buy — the one perk that touches competitiveness is balanced by a real cost (faster decay), not unlocked for free. That's a smarter fairness mechanism than a flat unlock, and worth copying directly (see updated monetization section below).

**What it likely still got wrong (and why it stalled despite decent monetization)**
- **Stale presentation** — it's <cite index="25-1">explicitly text-based</cite>, no mobile app, dated web UI. A sound monetization model doesn't save a product that looks abandoned to new visitors in 2026.
- **No modern retention loop** — no push notifications, no async mobile check-ins; the economy design is solid but the packaging never evolved.
- **Governance risk in similar games** — the closest comparable, Online Tennis Manager, shows what happens when a browser manager game *does* try to monetize badly: <cite index="17-1">a 2-year veteran player reported that competing at the top essentially requires spending real money</cite>. That's the trap to avoid — aggressive pay-to-win is what kills trust in this genre.
- **No mobile-first live-engagement loop** — everything is browser/session based, no push notifications, no async "check in twice a day" design that mobile RPGs use to build habit.

**The opening this leaves you:** a game with the same instant, legible core loop and long-term meta-progression, rebuilt with modern engagement mechanics (push notifications, mobile-first), a fair (not pay-to-win) monetization model, and enough polish to not look abandoned — aimed first at Rocking Rackets' own orphaned community.

---

## 2. Game design

### Core loop (per session, ~2–5 min)
1. Check overnight/async results (matches simulate on a schedule, not live-click).
2. Adjust training focus for each player (surface, physical stat, mental stat).
3. Enter/schedule tournaments for the week.
4. Scout/hire new talent as current players age.
5. Optional: PvP duel challenge to a rival manager.

### RPG progression layers
- **Player stats**: technical (serve, forehand, backhand, volley), physical (speed, stamina, strength), mental (clutch/mentality, consistency), and surface affinities (clay/grass/hard/indoor) — directly inspired by Rocking Rackets' model but with more granularity for build diversity.
- **Aging curve**: youth → prime → decline, same as Rocking Rackets, but with configurable game-speed servers (like the original) so casual and hardcore players both have a home.
- **Manager progression**: separate meta-layer — manager XP/reputation unlocks scouting regions, extra roster slots, staff hires (coach, physio, scout) that passively boost training efficiency. This is your main *non-p2w* monetization surface (see below).
- **Circuit structure**: juniors → futures → challengers → tour → majors, mirroring real tennis so it teaches the sport as it did before.

### Engagement mechanics (the gap vs. old browser games)
- **Push/email digest**: "Your player João Silva won round 1 of Roland Garros Challenger" — async engagement without requiring live presence.
- **Guilds / academies**: groups of managers pool scouting reports, compete in academy leaderboards — gives Discord-style social stickiness cheaply.
- **Weekly marquee event**: one scheduled marquee match per week per league — fully pre-simulated the moment it's due, then presented as a "fake live" replay (see Software architecture) to create an "appointment" moment without any real-time backend cost.
- **Seasons with resets**: soft-reset leaderboards seasonally (common SaaS-game retention lever) so new players aren't permanently behind veterans.
- **National team storyline**: keep this — it's a good identity/pride hook, especially valuable for your FC Porto/Portugal-flavored audience if you ever theme a launch around it.

### Monetization — Stripe, non-p2w focused (refined from Rocking Rackets' VIP model)
| Tier | Price model | What it unlocks |
|---|---|---|
| Free | — | Full core loop, 2–3 player roster, standard training speed |
| Manager Pro | Stripe subscription (monthly) | Extended roster (e.g. 4 slots instead of 2) **with a built-in tradeoff cost** (faster stat/point decay), longer tournament registration windows, extra stats/ranking-history pages, vacation-delegate feature, no ads |
| Season Pass | Stripe one-time per season | Cosmetic kits, name customization, exclusive tournament badges, access to lower-cap "Pro-only" worlds |
| Boosts | Stripe one-time (capped/rate-limited) | Cosmetic-only or pure convenience (e.g., re-roll a scouting report) — **never an unconditional stat buff** |

Two guardrails, refined:
1. **Money buys convenience and cosmetics, never an unconditional win-rate boost.**
2. **Where a paid perk does touch competitiveness (like extra roster slots), pair it with a real, built-in cost** — this is the mechanism Rocking Rackets actually uses (steeper point decay for VIPs with 4 players) and it's a better fairness model than a flat unlock: it rewards *skillful use* of the extra capacity rather than just having paid for it.

---

## 3. Design inspiration from adjacent genres

### Football Manager — take the psychology, skip the depth trap
**What to take:**
- **Permanence & consequence**: <cite index="28-1">decisions have lasting consequences, and every match should feel like a step forward</cite> — you already have this via aging/decline, keep leaning on it.
- **Imperfect information as a feature, not a bug**: <cite index="35-1">seasoned Football Manager players pride themselves on knowing how to read the data, and a scout's own poor judgement can make a wonderkid rating unreliable</cite> — worth copying directly: make scouting reports probabilistic/fuzzy (a scout's reported rating has error bars based on scout skill), so scouting becomes a skill rather than a lookup table.
- **Variable engagement depth**: <cite index="30-1">Football Manager lets you decide how immersive you want to be — some players just pick a club and play at high speed, others obsess over every detail</cite>. Build an explicit "fast-forward vs. manual" toggle from day one so casual and hardcore players coexist in the same product.
- **Unpredictability as story generator**: <cite index="34-1">since you can't personally control match outcomes, long-term saves generate constant narratives — aging stars, breakout youngsters, tactical shifts</cite> — this is organic, free marketing (players screenshot and share their own stories) and costs you nothing but good variance tuning in the sim.

**What to deliberately leave out (the complexity trap you're right to worry about):**
- No 3D/graphical match engine or deep tactical instruction system — <cite index="28-1">Football Manager's match engine and its dense, click-everywhere interface</cite> represents a decade-plus of engineering investment. A text/stat-based result (like Rocking Rackets, like the original 1992 Championship Manager) is enough — <cite index="29-1">that original game was completely text-based and visually minimal, yet the core loop was instantly addictive, and it's literally where the genre-wide obsession started</cite>.
- No board-politics/press-conference/sponsorship sub-games. Interesting for a mature product, pure scope-creep at MVP stage.
- No attempt to model real players/real database — <cite index="34-1">Football Manager's scale relies on roughly 1300 scouts feeding a comprehensive real-world database</cite>, which is both a huge content pipeline and a licensing headache. Procedurally generated players sidesteps both problems entirely.

### Tribal Wars / Tribos — take the persistent-world economy, skip the destructive PvP
**What to take:**
- **True async persistence**: <cite index="39-1">the world keeps threatening your position any time of day whether you're logged in or not</cite> — reinforces the "matches resolve on schedule, not live-click" design already planned; this is the mechanic that makes a browser game feel alive between sessions.
- **Tribes as a real coordination tool, not just a chat room**: <cite index="38-1">tribes get a dedicated forum, protection against solo attacks, and a shared attack planner where members mark targets visible to the whole group for synchronized play</cite> — translate this into a shared "scouting board" or shared training-program templates for your academies, giving groups an actual functional reason to stay engaged with each other, not just a badge.
- **World lifecycle (open → fills up → closes)**: <cite index="41-1">a server closes to new players once its "rim" fills, and after that any player who's wiped out is simply out for that world</cite> — this maps well onto your season/world model: fresh cohorts start clean instead of diluting into a stale, veteran-dominated world forever.
- **Premium = convenience, validated at scale**: <cite index="41-1">Tribal Wars' premium account gives a larger map and custom alliance colors</cite> — a real-world precedent, at genuine scale, for the "pay for clarity/QoL, not power" model you're already committed to.

**What to deliberately leave out:**
- Avoid destructive, elimination-style PvP. <cite index="41-1">Tribal Wars' core conquest mechanic involves attacking a village repeatedly to strip its loyalty until it can be taken over outright</cite> — that "wipe out and you're gone" tone fits a war game, not a sports-manager audience; Rocking Rackets' friendlier "point decay" competition (you fall in rank, you don't get destroyed) is the better tonal fit here.
- Avoid the sprawling building/unit tech-tree. <cite index="42-1">Tribal Wars has 15+ building types and up to nine offensive/defensive unit types</cite> — that's systems complexity in service of a war-economy simulation you don't need; your existing stat model (technical/physical/mental + surface affinity) is already the right scope.

### Synthesis
The right target is roughly: **the core simplicity of 1992's original Championship Manager (text results, stats, addictive permanence) + Tribal Wars' async persistent-world and fair-premium precedent + Football Manager's imperfect-information scouting and variable-depth engagement — without Football Manager's decade-deep tactical/financial systems or Tribal Wars' destructive PvP.** That combination keeps the build scope close to what you already scoped for MVP while borrowing genuinely proven retention mechanics from both genres.

## 4. Software architecture (hexagonal / ports & adapters)

Given your existing hexagonal architecture preference and Mercado Azul pipeline experience, this maps well onto the same pattern discipline.

### Bounded contexts (each its own hexagon)
1. **Player & Roster** — player entities, stats, aging, training.
2. **Competition** — tournaments, brackets, rankings, match scheduling.
3. **Match Simulation Engine** — deterministic sim given two player states + surface → result. Pure domain logic, no I/O, fully unit-testable.
4. **Manager & Progression** — manager XP, staff, scouting.
5. **Billing** — Stripe subscriptions/one-offs, entitlements. Isolated so game logic never talks to Stripe directly.
6. **Notifications** — push/email digest, decoupled via events.
7. **Social** — guilds/academies, chat, leaderboards.

### Hexagonal layout (per context)
```
context/
  domain/            # entities, value objects, domain services — zero framework deps
  application/        # use cases / ports (interfaces): e.g. SimulateMatch, HirePlayer
  adapters/
    inbound/          # REST controllers, cron/scheduler triggers
    outbound/         # Postgres repo impl, Stripe client impl, notification impl, object-storage (match log) impl
```
Key SOLID discipline: application layer depends only on **ports** (interfaces); adapters implement them. Match Simulation Engine, for instance, has zero knowledge of Postgres or Stripe — it's pure functions over domain objects, which also makes it trivially reusable if you ever want a single-player mode or a Claude-in-artifact preview simulator.

### Committed stack (with rationale, not just options)

| Layer | Choice | Why this, not the alternative |
|---|---|---|
| Domain/application | Plain TypeScript, framework-agnostic | Zero framework deps in `domain/` — this is what makes ports/adapters real rather than decorative |
| API framework | **Fastify** | Lighter than NestJS; NestJS's DI container tends to encourage coupling controllers straight to services, fighting the hexagonal boundary rather than reinforcing it |
| ORM / DB access | **Drizzle** + PostgreSQL | Lighter and less codegen-magic than Prisma; maps cleanly onto hand-written repository adapter classes instead of nudging the ORM client itself into acting as the repository |
| Scheduled jobs (match ticks, aging, weekly resets) | **BullMQ + Redis** | Matches "tick" on a schedule rather than needing constant live connections — cheap and horizontally scalable per game-world |
| "Live" match viewing | **No WebSockets, no SSE, no persistent connections.** Matches are fully simulated synchronously the moment they're due, producing an immutable replay log (point/game-by-game + relative timestamps). Frontend fetches it once via HTTP GET and fakes the live experience client-side on a timer — exactly Rocking Rackets' own approach. | Viewer count becomes irrelevant to backend cost; the same static blob serves 5 or 50,000 viewers identically. This is the single biggest lever for cheaply supporting many concurrent game-worlds |
| Replay log storage | Object storage (S3/Cloudflare R2) behind a CDN, or Postgres JSON column at very small scale | Immutable-once-written blobs are the cheapest possible thing to serve at unlimited read volume |
| Billing | Stripe Billing (subscriptions) + Stripe Checkout (one-offs), behind a `BillingPort` interface | Swappable/addable payment provider later without touching game logic |
| Frontend | **Next.js/React** | Good default React setup with solid DX; used for developer experience and a natural home for a stateless public marketing page, *not* because the logged-in manager dashboard needs SSR — that part is really just an SPA behind auth |
| Notifications | Email (Postmark/Resend) + push (OneSignal), triggered by domain events (`MatchCompleted`, `TournamentRoundAdvanced`) | Fully decoupled from game rules via the `EventPublisherPort` |
| Hosting | **One provider for everything at MVP stage** — Railway or Fly.io running the Next.js app, API, and worker together | Splitting Next.js onto Vercel and the API/worker onto a second platform is a two-platform ops burden with no real benefit at solo/small-team scale; can always peel the stateless marketing page off to Vercel later |

### Monorepo layout
A handful of workspace packages, not a microservices sprawl — deliberately matching "avoid too much complexity":
```
tennis-manager/
  packages/
    domain/              # the three (eventually seven) bounded contexts, framework-free
    application/         # use cases + ports, one folder per context
  apps/
    api/                 # Fastify HTTP adapters (inbound) + Drizzle/Stripe adapters (outbound)
    worker/               # BullMQ job handlers: weekly ticks, aging, match simulation batch runs
    web/                  # Next.js frontend (manager dashboard + marketing page)
```

### Testing discipline
- Domain and application layers: pure unit tests, no mocking of infrastructure needed given hexagonal isolation.
- Adapters: integration tests against a real Postgres/Stripe test-mode instance.
- Match Simulation Engine deserves the heaviest test investment — it's the credibility core of the whole game; players will forgive UI roughness far more than they'll forgive a sim that "feels rigged."

---

## 5. Business plan

### Target market & go-to-market
- **Primary wedge**: Rocking Rackets' and Online Tennis Manager's existing orphaned/dissatisfied communities — direct outreach via the forums where they still discuss the game (e.g., mens tennis forums threads), Discord communities, and reddit tennis/sim-game subreddits. Low CAC because the demand already exists and is actively unmet.
- **Secondary**: broader football/sports-manager-game audience (Football Manager, Sorare-adjacent fantasy sports fans) who'd try a tennis equivalent if positioned as "the Football Manager of tennis, but free and fair."

### Phased roadmap
| Phase | Scope | Goal |
|---|---|---|
| 0 — Validation | Landing page + waitlist, post in existing communities, gauge interest before writing game code | Confirm demand, build an initial email list |
| 1 — MVP (3–4 months, solo/small team) | Single game world, core loop (hire/train/tournament/age), no live scoring, no billing yet, web only | Prove the sim is fun and retention holds for a few weeks |
| 2 — Monetization | Stripe integration, Manager Pro tier, cosmetics | Validate willingness to pay before scaling infra |
| 3 — Social & retention | Guilds, weekly live event, push notifications | Increase stickiness, justify server growth |
| 4 — Scale | Multiple game worlds/speeds (mirroring Rocking Rackets' server model), mobile PWA | Support larger concurrent player base |

### Cost structure (early stage)
- Infra: minimal at MVP scale (a few $/month on Fly.io/Railway + Postgres + Redis).
- Stripe: standard processing fees, no fixed cost.
- Biggest cost is your own time — this is a multi-month side-project commitment even at MVP scope, closer to Mercado Azul's pipeline complexity than webpitch-pt's outreach scripts.

### Risks
- **Retention is the real risk, not tech.** Manager games live or die on whether the sim *feels* fair and interesting over months — invest disproportionately in the Match Simulation Engine's tuning before polishing UI.
- **Community migration isn't guaranteed** — Rocking Rackets' players may be loyal out of inertia, not because they're actively looking for a replacement. Validate in Phase 0 before building.
- **Solo-maintainer bus factor** — same lesson as any of your other pipelines: keep the architecture clean enough that you (or a future hire) can extend it without a rewrite.

---

## Current status (as of this planning session)

**Done:**
- Business plan, monetization model, and go-to-market strategy (this document).
- Firm stack decisions with rationale (see Committed stack above).
- Domain model skeleton for three bounded contexts — **Player & Roster**, **Competition**, **Match Simulation Engine** — written in TypeScript, following hexagonal architecture (zero framework deps in `domain/`) and SOLID discipline throughout (see `domain-model/README.md` for a full breakdown of the design decisions). This includes:
  - `Player` aggregate root, `PlayerAttributes`/`Skill`/`SurfaceAffinities` value objects, `PlayerAgingService` as a swappable-policy domain service.
  - `Tournament` aggregate root with bracket integrity enforcement.
  - `StatisticalMatchSimulator` — a deterministic, injectable-RNG match simulator that produces both a compact `MatchOutcome` (for bracket/ranking logic) and a full `MatchLog` (for client-side fake-live playback, no WebSockets involved).
  - `HirePlayerUseCase` and `SimulateMatchUseCase` application services, plus the `PlayerRepository`/`TournamentRepository`/`MatchLogStorePort`/`BillingPort`-shaped port interfaces they depend on.
  - The whole skeleton passes `tsc --strict` with zero errors.

**Deliberately not started yet:**
- `BracketGenerator` (single-elimination seeding domain service).
- Any adapters: Postgres/Drizzle repositories, Stripe billing adapter, object-storage adapter for match logs, Fastify HTTP controllers, BullMQ job handlers.
- Manager & Progression, Billing, Notifications, and Social bounded contexts (only stubbed as a concept via `maxRosterSizeFor` in `HirePlayerUseCase`).
- Monorepo scaffolding itself (package.json workspaces, tsconfig references, etc.) — only the folder shape has been decided, not built.

**Known placeholder values that need real tuning before this is production-real:**
- Aging stage thresholds in `PlayerAgingService` (prime at 20, decline at 30, retirement at 38 years — illustrative, not balanced).
- Ranking points formula in `StandardRankingPointsTable`.
- `StatisticalMatchSimulator`'s scoring loop treats each simulated "point" as directly incrementing a game count rather than modeling real game-by-game/deuce structure — good enough to validate the architecture, but the actual scoring logic is the single piece most worth a dedicated tuning/testing pass, since it's the credibility core of the whole game.

## Next steps
1. Phase 0 validation post + landing page (I can help draft this).
2. `BracketGenerator` domain service for the Competition context.
3. Monorepo scaffolding (`packages/domain`, `apps/api`, `apps/worker`, `apps/web`) with Fastify + Drizzle + BullMQ wired up per the committed stack.
4. Postgres/Drizzle adapters implementing `PlayerRepository` and `TournamentRepository`.
5. `StripeAdapter` implementing a `BillingPort` (not yet defined) for real subscription/entitlement checks.
6. Unit tests for `StatisticalMatchSimulator` with a fixed `RandomSource` stub, to lock in expected behavior before any balance tuning begins.
