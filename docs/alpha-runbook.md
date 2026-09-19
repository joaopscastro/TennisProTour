# Alpha runbook — bring the world up and invite testers

Owner-facing, ordered checklist for the first private alpha. Work top to
bottom. Anything marked **[REQUIRED]** blocks a working alpha; anything
marked **[OPTIONAL]** can be skipped for a free alpha.

This doc deliberately does **not** duplicate the environment inventory or
the security model — it points at the canonical sources:

- `README.md` — local getting-started, tick cadence, testing.
- `docs/security-and-identity.md` — identity model + Production Checklist.
- `.env.example` — the full env inventory with per-variable notes.

---

## (a) Clerk — sign-in **[REQUIRED]**

1. Create a Clerk application (Clerk dashboard → *Create application*).
2. Copy the two keys you get:
   - **Publishable key** (`pk_…`) — used by the web app.
   - **Secret key** (`sk_…`) — used by the api only. Never ship it to the
     browser.
3. Set the web app's allowed origin(s) in Clerk to your alpha web URL.
4. Env (see `.env.example` for the authoritative notes):

   | Var | Process | When | Notes |
   |---|---|---|---|
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | web | **BUILD time** | `pk_…`. Inlined into the client bundle — a changed key needs a **rebuild**, not a restart. |
   | `CLERK_SECRET_KEY` | api | runtime | `sk_…`. Server-only. |
   | `CLERK_AUTHORIZED_PARTIES` | api | runtime | Exact browser origin(s), comma-separated. Must match the web URL, e.g. `https://alpha.example.com`. No wildcards. |
   | `AUTH_MODE` | api | runtime | Must be `clerk`. |

5. **The API fails CLOSED.** Unset/typo'd `AUTH_MODE` resolves to `clerk`,
   never to the spoofable dev adapter, and the API **throws at boot** if
   `AUTH_MODE=clerk` without `CLERK_SECRET_KEY` (and, in production,
   without `CLERK_AUTHORIZED_PARTIES`). A boot that comes up at all is
   therefore authenticated. See `docs/security-and-identity.md`.

---

## (b) Host — services **[REQUIRED]**

Run these five: **api, worker, web, Postgres, Redis**.

1. **Worker exactly once.** The worker registers the BullMQ repeatable
   scheduler. Two replicas double-register it — run a single worker
   instance (or make the scheduler a separate one-off, but *one*).
2. **api + worker must share ONE `MATCH_LOG_DIR`** *and* the same
   `MATCH_LOG_PUBLIC_BASE_URL`.
   - The worker writes replay blobs; the api serves them.
   - ⚠️ Some platforms mount volumes **per-service**. If api and worker
     each get their own volume at the same path, the replay store is
     silently split and **every auto-simulated replay 404s** (a real bug
     this project has already hit once). Mount one shared volume into
     both.
3. **Migrations are a one-shot release step, before api/worker start.**
   Run the `migrate` target first, then start api and worker. **Never**
   migrate from the API entrypoint — the API has no business holding
   migration rights, and two API replicas racing migrations is worse than
   useless. The `migrate` target is idempotent and safe to rerun.
4. Postgres and Redis are external managed services (Railway/Fly add-ons
   or your own). Both apps and `migrate` read `DATABASE_URL`; the worker
   also reads `REDIS_URL`.

---

## (c) Environment inventory

Grouped by **required vs optional** and **runtime vs build-time**. Full
notes live in `.env.example` — this is the alpha cut.

### Required

| Var | Process | Time | Value |
|---|---|---|---|
| `DATABASE_URL` | api, worker, migrate | runtime | Postgres connection string. |
| `REDIS_URL` | worker | runtime | Redis connection string. |
| `AUTH_MODE` | api | runtime | `clerk`. |
| `CLERK_SECRET_KEY` | api | runtime | `sk_…`. |
| `CLERK_AUTHORIZED_PARTIES` | api | runtime | Exact web origin(s). |
| `INTERNAL_ADMIN_TOKEN` | api | runtime | Long random string. Never expose to the web app. |
| `NEXT_PUBLIC_API_URL` | web | **BUILD time** | Public api base, e.g. `https://api.alpha.example.com`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | web | **BUILD time** | `pk_…`. |
| `NODE_ENV` | api | runtime | `production`. |

### Recommended / optional for a free alpha

| Var | Process | Time | Value / note |
|---|---|---|---|
| `MATCH_LOG_DIR` | api + worker | runtime | Absolute path to ONE shared volume (see (b)). Unset = repo-root default, single-host only. |
| `MATCH_LOG_PUBLIC_BASE_URL` | api + worker | runtime | e.g. `https://api.alpha.example.com/match-logs`. Same on both. |
| `WORLD_ID` | api + worker | runtime | Defaults to `main`. Any script on another world must set the same value. |
| `CORS_ORIGINS` | api | runtime | Exact web origin, e.g. `https://alpha.example.com`. |
| `WORLD_TICK_INTERVAL_MS` | api **and** worker | runtime | **`900000`** for the alpha cadence (one game day = 15 real minutes). Must be set **identically on both** — see (g). |

### Never

- `NEXT_PUBLIC_DEV_MANAGER_ID` — **do not build this into the web
  bundle.** It prefills a fake manager id in local dev only; in production
  identity comes from Clerk.

### Not needed for a free alpha

- **Stripe:** not required. Billing/Manager Pro simply stays unconfigured;
  entitlement reads work against the local table and checkout isn't
  offered. (`STRIPE_*` are optional in `.env.example`.)
- **Notifications:** default `off` — the digest scheduler isn't even
  registered and no email is sent. Leave `NOTIFICATION_EMAIL_MODE` unset
  for the alpha.
- `NEXT_PUBLIC_AUTH_MODE` is informational only (the real switch is the
  publishable key). See `.env.example`.

**Build-time reminder:** every `NEXT_PUBLIC_*` value is inlined into the
web bundle. Changing `NEXT_PUBLIC_API_URL` or the Clerk publishable key
requires a **web rebuild and redeploy** — restarting the container does
nothing.

---

## (d) Bootstrap the world

Run these in order, **with the worker STOPPED** (the bootstrap force-starts
due tournaments; a concurrent tick can race it):

1. **Migrate** (one-shot):
   ```
   npm run db:migrate -w apps/api          # local
   # or the `migrate` Docker target in a containerized deploy
   ```
2. **Bootstrap** the world (fills free agents, opens the current-week
   slate and the season calendar, seeds a watchable demo draw):
   ```
   npm run bootstrap -w apps/api
   ```
   It prints a summary (fillers generated, free agents, demo draw
   opened/seeded, tournaments opened per phase). Safe to rerun — it's
   idempotent (a second run generates 0 new fillers and opens 0 new
   tournaments).
3. **Start api and worker** (and the web app), then leave the worker
   running so the world advances.

---

## (e) Smoke checks

Confirm the world is actually alive and playable:

1. `GET /health` and `GET /world/clock` show a **fresh `lastTickAt`** with
   **`stale: false`**. (`/health` includes the same world heartbeat, so
   external uptime monitoring can alert on a stalled tick without the UI.)
   `stale` goes true once the gap since the last advancing tick exceeds
   twice the expected cadence.
2. **Sign up** through the web app. A brand-new manager is created with
   **`xpBalance: 500`** (starter XP) — enough to sign one or two free
   agents.
3. `GET /talent-pool` is **non-empty** (free agents to sign).
4. `GET /tournaments?status=open` shows **current-week rows with
   `registrationOpen: true`**.
5. Watch the worker advance the world: at `WORLD_TICK_INTERVAL_MS=900000`
   the `GET /world/clock` `nextTickAt` should move forward roughly every
   **~15 minutes**, and `lastTickAt` should keep refreshing. If it stalls,
   check the worker logs and that the cadence is set on **both** processes.

---

## (f) Invite the first testers

- Send them the **web URL**.
- Ask them to do exactly this in session one:
  1. **Sign a free agent** from the scouting page.
  2. **Enter a current-week tournament** from the roster's Enter flow.
  3. **Watch a replay** (open a decided match and follow the fake-live
     playback).
  4. **Report confusion** — where they didn't understand what to do next
     matters more than polish right now.
- Point them at the video-game bootstrap demo draw (a seeded futures
  draw) so there is always one live, watchable match early in the session.

---

## (g) Halt the world

- **Preferred: scale the worker to 0.** The world freezes without touching
  game code; start the worker again to resume. Idempotency keys mean no
  tick is ever applied twice.
- Unsetting `WORLD_TICK_INTERVAL_MS` also stops/retimes ticks, but it must
  be changed on **both** `apps/api` and `apps/worker` at the same time —
  otherwise `/world/clock` projects the daily cron while the worker still
  runs the fast cadence, and the clock silently lies. Scale-to-0 is
  cleaner.
- **Do not migrate down.** Migrations are forward-only release steps; a
  rollback is a fresh environment, not a down-migration.

---

## Honest note: the alpha cadence makes big first rounds a blur

The reveal window for a round is derived from the real day length
(`revealWindowSecondsFor` — the matches in a round divide the day evenly,
capped at `MATCH_REVEAL_CAP_SECONDS`). At `WORLD_TICK_INTERVAL_MS=900000`
one game day is 900s, so:

- a **16-draw** first round (8 matches) → **~112s** per match,
- a **32-draw** first round (16 matches) → **~56s** per match,
- a **128-draw** first round (64 matches) → **~14s** per match — a blur,
  essentially a highlight-flash.

This is exactly why the bootstrap seeds a **16-draw demo futures** for the
same-day watchable match, and why the current-week slate skews toward
smaller draws. Deep rounds (semifinals, finals) get the cap and are
comfortable to follow. If testers want to *watch* rather than *skim*,
point them at small draws and later rounds. The cadence is a placeholder
value for the alpha, not a tuned constant.
