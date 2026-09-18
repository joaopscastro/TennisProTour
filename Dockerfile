# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Host-portable multi-stage build for the Tennis Manager monorepo.
#
# There is deliberately NO host-specific config here (no docker-compose.prod,
# no cloud-provider assumptions) — the deploy target isn't chosen yet. One
# image graph with named targets; any orchestrator can build and run them.
#
# Directory DEPTH IS LOAD-BEARING. Both apps/api/src/index.ts and
# apps/worker/src/index.ts load the shared repo-root `.env` via
# `resolve(__dirname, '../../../.env')`, and matchLogDirectory.ts defaults the
# replay store to `resolve(__dirname, '../../../data/match-logs')`. Every stage
# therefore preserves the `/app/apps/<name>` layout — flattening the tree
# silently breaks both (the app would read a nonexistent .env and a worker/
# API replay-dir split).
# ---------------------------------------------------------------------------

# ---- base: shared workspace root ------------------------------------------
# NODE_ENV is deliberately NOT set here: the deps/build stages need
# devDependencies (typescript, tailwind, drizzle-kit). Runtime targets set it.
FROM node:22-alpine AS base
WORKDIR /app

# ---- deps: install the whole workspace from the lockfile ------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---- build: compile the TS project references, then the Next.js bundle ----
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/web ./apps/web

# tsc project-reference order: domain -> application -> api -> worker
# (apps/worker imports the built @tennis-manager/api via dist/lib.js).
RUN npx tsc --build

# NEXT_PUBLIC_* are INLINED into the client bundle at build time — a runtime
# env var on the deployed web container can NOT change them. Values must be
# supplied here (docker build --build-arg or the orchestrator's build config).
# Never pass a dev manager id: there is no NEXT_PUBLIC_DEV_MANAGER_ID arg.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_AUTH_MODE
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE

RUN npm run build -w apps/web

# ---- migrate: one-shot release step, never an app-entrypoint side effect -
# FROM build on purpose: it needs drizzle-kit plus src/db/schema.ts and
# apps/api/drizzle/*.sql. WORKDIR apps/api so drizzle.config.ts's relative
# `out: './drizzle'` resolves. apps/api and apps/worker share ONE Postgres;
# run this once before either starts, never migrate from the API entrypoint.
FROM build AS migrate
WORKDIR /app/apps/api
# Migrations only read drizzle/ and write to Postgres, so the release step runs
# as the same non-root user as every other runtime target.
USER node
CMD ["npx","drizzle-kit","migrate"]

# ---- api runtime -----------------------------------------------------------
# Root node_modules carries the hoisted deps AND the @tennis-manager/* symlinks
# into packages/*; those package dirs must be copied alongside it or the
# symlinks dangle.
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/domain/package.json ./packages/domain/
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/application/package.json ./packages/application/
COPY --from=build /app/packages/application/dist ./packages/application/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
# The replay store is a shared filesystem the worker writes and the API serves
# (see .env.example). Create the default dir owned by the runtime user so the
# non-root process can write when no external volume is mounted over it.
RUN mkdir -p /app/data/match-logs && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node","apps/api/dist/index.js"]

# ---- worker runtime --------------------------------------------------------
# Same shape plus apps/worker — the worker imports @tennis-manager/api
# (dist/lib.js), so apps/api/dist MUST be present here too.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/domain/package.json ./packages/domain/
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/application/package.json ./packages/application/
COPY --from=build /app/packages/application/dist ./packages/application/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
RUN mkdir -p /app/data/match-logs && chown -R node:node /app/data
USER node
CMD ["node","apps/worker/dist/index.js"]

# ---- web runtime -----------------------------------------------------------
# Any PART of the standalone graph can build the other targets; build `web`
# last or alongside. The standalone bundle ships its own traced node_modules,
# so no npm install is needed here. next build does NOT copy `.next/static`
# (Nor a `public/` dir, which this app currently has none of) into the
# standalone dir — it must be copied in manually, or every JS/CSS asset 404s.
FROM base AS web
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# If apps/web/public/ is ever added, copy it to ./apps/web/public here.
USER node
EXPOSE 3001
CMD ["node","apps/web/server.js"]
