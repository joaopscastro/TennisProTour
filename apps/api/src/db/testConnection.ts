const DEV_DATABASE_NAME = 'tennis_manager';

/**
 * The connection string every integration/e2e test suite must use.
 * Deliberately does NOT read `DATABASE_URL` (the app's own dev/prod
 * connection string) at all — a developer's shell exporting
 * `DATABASE_URL` for their real dev database must never be able to
 * cause a test run to touch it. `TEST_DATABASE_URL` is the only
 * override; the default points at a dedicated database on the same
 * local Postgres instance, created automatically by
 * `scripts/ensure-test-db.js` (wired as a `pretest` hook — see
 * apps/api's and apps/worker's package.json) before any test connects.
 *
 * The dev-database-name check below is a structural backstop, not
 * just a naming convention: even a misconfigured `TEST_DATABASE_URL`
 * that copy-pasted the real dev URL fails loudly here, before any
 * test's `beforeEach` gets a chance to truncate every table in it.
 */
export function testConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager_test';
  const dbName = new URL(url).pathname.slice(1);
  if (dbName === DEV_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL points at "${DEV_DATABASE_NAME}", the real dev database — refusing to run tests ` +
        'against it (integration tests truncate every table in beforeEach). Point TEST_DATABASE_URL at a ' +
        'dedicated test database instead (see README.md\'s Testing section).',
    );
  }
  return url;
}
