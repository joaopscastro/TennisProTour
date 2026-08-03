#!/usr/bin/env node
// Everything `npm run dev` needs before it starts api/worker/web:
// Postgres and Redis up and actually accepting connections (not just
// "container started" — `--wait` blocks on the docker-compose.yml
// healthchecks, which run pg_isready / redis-cli ping for real), then
// migrations applied. Idempotent: safe to run against containers that
// are already up and a database that's already migrated.
const { run } = require('./lib/run');

console.log('==> Starting Postgres + Redis (docker compose up -d --wait)...');
run('docker', ['compose', 'up', '-d', '--wait']);

console.log('\n==> Applying Drizzle migrations...');
run('npm', ['run', 'db:migrate', '-w', 'apps/api']);

console.log('\n==> Postgres/Redis are up and migrations are applied.');
