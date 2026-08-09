#!/usr/bin/env node
// Makes sure the isolated integration-test database exists before any
// test suite connects to it — wired as a `pretest` hook in apps/api
// and apps/worker's package.json, so `npm run test`/`npm test` always
// runs this first, automatically. Idempotent: does nothing if the
// database is already there. Deliberately never touches the real dev
// database (see apps/api/src/db/testConnection.ts, which is where
// tests actually get their connection string from — this script only
// provisions the empty database, it doesn't run migrations or seed
// anything; each test file's own beforeAll already does that).
const { Client } = require('pg');

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager_test');
const dbName = testUrl.pathname.slice(1);

if (!dbName) {
  console.error('TEST_DATABASE_URL has no database name in its path — refusing to continue.');
  process.exit(1);
}

// The 'postgres' maintenance database always exists on a stock
// Postgres instance (local docker-compose or CI's service container
// alike) — connecting to it is the only way to run CREATE DATABASE,
// since Postgres can't create a database while connected to the one
// being created.
const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';

async function main() {
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length > 0) {
      console.log(`==> Test database "${dbName}" already exists.`);
      return;
    }
    console.log(`==> Creating isolated test database "${dbName}"...`);
    // Database names can't be parameterized in CREATE DATABASE — safe
    // here because dbName comes from TEST_DATABASE_URL, a trusted
    // local/CI config value, never user input.
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
