#!/usr/bin/env node
// One-time first-clone setup: `npm install && npm run setup && npm run
// dev` should be the entire onboarding flow, nothing else. Re-running
// this later is safe (npm install and docker compose up are both
// idempotent; db:migrate only applies pending migrations; the seed
// script fails loudly on duplicate ids rather than corrupting data —
// see apps/api/src/scripts/seed.ts for that tradeoff).
const { run } = require('./lib/run');

console.log('==> Installing dependencies...');
run('npm', ['install']);

console.log('\n==> Building packages/domain and packages/application...');
run('npx', ['tsc', '--build', 'packages/domain', 'packages/application']);

console.log('\n==> Starting Postgres + Redis (docker compose up -d --wait)...');
run('docker', ['compose', 'up', '-d', '--wait']);

console.log('\n==> Applying Drizzle migrations...');
run('npm', ['run', 'db:migrate', '-w', 'apps/api']);

console.log('\n==> Seeding dev data...');
run('npm', ['run', 'seed', '-w', 'apps/api']);

console.log('\n==> Setup complete. Run `npm run dev` to start the app.');
