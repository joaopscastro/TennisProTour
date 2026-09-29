/**
 * Test-facing type declarations for the SQL-backed evidence collectors
 * (`soakEvidence.mjs`), so the TypeScript integration suite can call the
 * EXACT production archival function the season runner uses (rather than
 * reimplementing its SQL). Deliberately narrow: only the exports the
 * integration tests import are declared. The .mjs module itself stays
 * plain JS because the runners (`soak.mjs`, `agentSeason.mjs`) are
 * executed directly by node, outside the TypeScript build.
 */

/** pg-compatible query surface (`pg.Pool`/`pg.Client` both satisfy it). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function archiveOldMatchRows(
  db: Queryable,
  currentAbs: number,
  trackedIds: string[],
  protectedManagerIds?: string[],
): Promise<{ mainDeleted: number; doublesDeleted: number }>;
