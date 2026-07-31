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

## Database (development)

```
docker compose up -d                  # local Postgres 16 (tennis/tennis, db tennis_manager, port 5432)
npm run db:migrate -w apps/api        # apply Drizzle migrations
npm run db:generate -w apps/api       # regenerate migrations after editing apps/api/src/db/schema.ts
```

Set `DATABASE_URL` to override the default connection string
(`postgresql://tennis:tennis@localhost:5432/tennis_manager`).
