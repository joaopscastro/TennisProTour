# Tennis Manager RPG

A free, fair (non-pay-to-win), browser-first tennis manager RPG. Start
with **`CLAUDE.md`** — it captures the architectural decisions and the
*why* behind them, not just the *what*, and should be read in full
before making any change to `packages/domain` or `packages/application`.

See `docs/` for the fuller business, game-design, and brand/marketing
plans this project is built from:
- `docs/business-plan.md`
- `docs/brand-marketing-plan.md`

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

```
npm install
npm run typecheck   # strict tsc --build across every package/app
```

## Database & queues (development)

```
docker compose up -d                  # Postgres 16 (port 5432) + Redis 7 (port 6379)
npm run db:migrate -w apps/api        # apply Drizzle migrations
npm run db:generate -w apps/api       # regenerate migrations after editing apps/api/src/db/schema.ts
npm run start -w apps/api             # Fastify API on :3000
npm run start -w apps/worker          # BullMQ worker: weekly world tick + due-match sweep
```

Set `DATABASE_URL` / `REDIS_URL` to override the defaults
(`postgresql://tennis:tennis@localhost:5432/tennis_manager`,
`redis://localhost:6379`). The worker's schedules are overridable via
`WORLD_TICK_CRON` (default Mondays 03:00 UTC) and `MATCH_SWEEP_CRON`
(default every 5 minutes).
