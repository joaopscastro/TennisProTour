import { describe, expect, it } from 'vitest';
import { composeDatabaseUrl, resolveCreateWorldOptions } from './createWorld';

/**
 * A4 — the `create-world` ops script's pure half: connection-string
 * composition (credentials/host preserved, database name replaced) and
 * argument resolution (defaults, overrides, refusals). The DB-create,
 * migrate and bootstrap phases are exercised live by standing the world
 * up; nothing here touches a database.
 */
describe('create-world', () => {
  const base = 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

  it('composes a target URL that swaps only the database name', () => {
    expect(composeDatabaseUrl(base, 'tennis_manager_human1')).toBe(
      'postgresql://tennis:tennis@localhost:5432/tennis_manager_human1',
    );
    expect(composeDatabaseUrl(base, 'postgres')).toBe('postgresql://tennis:tennis@localhost:5432/postgres');
  });

  it('requires --world and defaults the database name and ports from it', () => {
    expect(() => resolveCreateWorldOptions([], { DATABASE_URL: base })).toThrow(/--world/);

    const options = resolveCreateWorldOptions(['--world', 'human1'], { DATABASE_URL: base });
    expect(options).toEqual({
      world: 'human1',
      dbName: 'tennis_manager_human1',
      databaseUrl: 'postgresql://tennis:tennis@localhost:5432/tennis_manager_human1',
      adminUrl: 'postgresql://tennis:tennis@localhost:5432/postgres',
      apiPort: 3200,
      webPort: 3001,
    });
  });

  it('honours explicit --db-name and ports, and falls back to the default DATABASE_URL', () => {
    const options = resolveCreateWorldOptions(
      ['--world', 'human2', '--db-name', 'tm_h2', '--api-port', '3204', '--web-port', '3006'],
      {},
    );
    expect(options.dbName).toBe('tm_h2');
    expect(options.databaseUrl).toBe('postgresql://tennis:tennis@localhost:5432/tm_h2');
    expect(options.apiPort).toBe(3204);
    expect(options.webPort).toBe(3006);
  });

  it('refuses a database name that could not be a safe SQL identifier', () => {
    expect(() => resolveCreateWorldOptions(['--world', 'x', '--db-name', 'bad-name;drop'], { DATABASE_URL: base })).toThrow(
      /--db-name/,
    );
    expect(() => resolveCreateWorldOptions(['--world', 'x', '--api-port', 'nope'], { DATABASE_URL: base })).toThrow(
      /--api-port/,
    );
  });
});
