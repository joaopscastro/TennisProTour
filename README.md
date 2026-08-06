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
the bundled docker-compose services; the worker's schedules are
overridable via `WORLD_TICK_CRON` (default Mondays 03:00 UTC) and
`MATCH_SWEEP_CRON` (default every 5 minutes).

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
