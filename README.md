# Tennis Manager RPG

A free, fair (non-pay-to-win), browser-first tennis manager RPG. Start
with **`CLAUDE.md`** — it captures the architectural decisions and the
*why* behind them, not just the *what*, and should be read in full
before making any change to `packages/domain` or `packages/application`.

See `docs/` for the fuller business, game-design, and brand/marketing
plans this project is built from:
- `docs/business-plan.md`
- `docs/brand-marketing-plan.md`
- `docs/implementation-roadmap.md`
- `docs/security-and-identity.md`

## Layout

```
packages/
  domain/        # bounded contexts, framework-free (zero runtime deps)
  application/   # use cases + ports, one folder per context (zero runtime deps)
apps/
  api/           # Fastify HTTP adapters (inbound) + Drizzle/Stripe adapters (outbound)
  worker/        # BullMQ job handlers: weekly ticks, aging, match simulation batch runs
  web/           # Next.js frontend (manager dashboard + marketing page)
```

`packages/domain` and `packages/application` are wired as TypeScript
project references, so they build independently of each other and of
the apps that consume them, per the hexagonal architecture principle in
`CLAUDE.md`.

## Getting started

Requires Docker (for Postgres + Redis) and Node 22+.

```
npm install
npm run setup   # build domain/application, start docker-compose, migrate, seed dev data
npm run dev     # every time: docker-compose (waits for real readiness) + migrate + api/worker/web together
```

`npm run dev` prints api/worker/web logs together, each line prefixed
and colored by which app it's from. Once it's up:

- Web app: http://localhost:3001/ (try manager id `seed-m1`, seeded by `npm run setup`)
- API health check: http://localhost:3000/health
- Stop everything with Ctrl-C.

Postgres/Redis themselves keep running in the background afterward
(`docker compose down` to stop them, `docker compose down -v` to also
wipe their data for a clean re-seed).

Both scripts are safe to re-run — `npm run setup` again after the
first time just re-applies (idempotent) steps and re-seeds; if you've
already seeded, delete the `seed-*` rows or `docker compose down -v`
first if you want a truly fresh seed.

Everything above is plain Node + `docker compose` under the hood
(`scripts/setup.js`, `scripts/dev-prepare.js`) — no bash dependency, so
it runs the same from Git Bash/PowerShell on Windows as it does on
macOS/Linux. `DATABASE_URL` / `REDIS_URL` env vars still override the
defaults (`postgresql://tennis:tennis@localhost:5432/tennis_manager`,
`redis://localhost:6379`) if you need to point at something other than
the bundled docker-compose services (docker-compose.yml only runs
Postgres + Redis — apps/api/apps/worker/apps/web are plain Node
processes on your host, not containerized); the world tick's cadence is
set by `WORLD_TICK_INTERVAL_MS` (the compressed production clock — see
"World tick cadence" below) or, when unset, by `WORLD_TICK_CRON` (daily
03:00 UTC). There is no separate match-sweep job — match simulation is
folded into the one day tick.

### World tick cadence

The world tick — aging, training, tournament generation/fill, ranking,
match simulation, all of `AdvanceWorldWeekUseCase` — advances the game by
exactly **one game day**. Production runs on a **compressed clock**: one
game day = **2 real hours**, set with

```
WORLD_TICK_INTERVAL_MS=7200000
```

(≈30 real days per game season). `apps/worker` schedules the tick every N
milliseconds (BullMQ `every:`) on the exact same handler/use-case path —
nothing about the tick's own logic changes, only how often it runs. Unset
falls back to `WORLD_TICK_CRON` (default daily 03:00 UTC).

**Set it identically on both `apps/api` and `apps/worker`.** They share
one repo-root `.env` automatically on startup (explicit, cwd-independent —
see the top of each `src/index.ts`), regardless of launch directory, so
`npm run dev` picks it up with no extra flags. If only one process sees it,
`apps/api`'s `/world/clock` countdown silently projects the daily cron
instead and the "world stalled" threshold becomes 48h. Both processes log
the resolved cadence at boot — compare those two lines when in doubt.

**A sub-daily `WORLD_TICK_CRON` cannot substitute for this.** The day
tick's idempotency key hashes to the UTC date, so a second same-day firing
is refused as a duplicate (`tickKey.ts`); only interval mode buckets real
time finely enough to tick more than once a day.

For a one-off run without touching `.env`, the env var also works inline:

```
WORLD_TICK_INTERVAL_MS=7200000 npm run start -w apps/worker   # 2h per game day
```

- The `GET /world/clock` countdown (Sidebar, Scouting's "next refresh")
  picks this up automatically — no separate frontend config. In interval
  mode it's anchored to the real time of the last tick that actually
  advanced the world (`game_worlds.updated_at`), not a parsed cron
  expression; see `worldRoutes.ts`'s doc comment.
- The countdown re-fetches when it expires (and when the tab regains
  focus), so an open tab recovers across a tick instead of sticking at
  zero — required at a 2h/day cadence, invisible at a daily one.
- Match replay's "Premiere" live-edge cap is unaffected either way — it
  only ever measures real elapsed time since a match's own
  `simulatedAt`, independent of how fast the world itself is ticking
  (see `MatchReplayPlayer.tsx`'s `computeLiveEdgeSeconds`).

For finer-grained control (e.g. running just one app, or regenerating
migrations after editing `apps/api/src/db/schema.ts`), the individual
commands still work:

```
npm run typecheck               # strict tsc --build across every package/app
docker compose up -d            # Postgres 16 (port 5432) + Redis 7 (port 6379)
npm run db:migrate -w apps/api  # apply Drizzle migrations
npm run db:generate -w apps/api # regenerate migrations after editing the schema
npm run seed -w apps/api        # populate dev data (safe to repeat, see the script's own doc comment)
npm run start -w apps/api       # Fastify API on :3000
npm run start -w apps/worker    # BullMQ worker: weekly world tick + due-match sweep
npm run dev -w apps/web         # Next.js on :3001
npm run test:e2e -w apps/web    # Playwright browser acceptance tests
```

For Clerk configuration and the production security checklist, see
`docs/security-and-identity.md` and `.env.example`. Local development uses an
explicit development identity header; production must use `AUTH_MODE=clerk`.

## Testing

```
npm run test -w apps/api      # unit + integration, real Postgres
npm run test -w apps/worker   # includes the end-to-end smoke test, real Postgres + real Redis
npm run test -w packages/domain
npm run test -w packages/application
```

`apps/api` and `apps/worker`'s integration/e2e suites run against a
**separate, dedicated database** (`tennis_manager_test` by default, on
the same local Postgres instance the dev DB uses) — not your dev
database. Each suite's `beforeEach` truncates every table between
tests, so this isolation matters: it used to run against the same
`tennis_manager` database `npm run dev` uses, which meant running the
tests could silently wipe real seeded dev data.

A `pretest` hook (`scripts/ensure-test-db.js`) creates
`tennis_manager_test` automatically the first time you run the suite —
nothing to set up by hand. Override the target with `TEST_DATABASE_URL`
if you need to point at something else; it's read independently of
`DATABASE_URL`; a `TEST_DATABASE_URL` that resolves to `tennis_manager`
itself is refused outright rather than silently truncated (see
`apps/api/src/db/testConnection.ts`).
