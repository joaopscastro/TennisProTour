import { resolve } from 'node:path';

/**
 * Resolves the match-log directory to an ABSOLUTE path anchored at the
 * repo root.
 *
 * Why this exists (a real cross-process replay bug): the old
 * `MATCH_LOG_DIR ?? './data/match-logs'` was resolved relative to each
 * PROCESS's cwd. The root `npm run dev` launches the API with cwd
 * `apps/api` and the worker with cwd `apps/worker`, so the worker WROTE
 * replay blobs to `apps/worker/data/match-logs` while the API SERVED
 * them from `apps/api/data/match-logs` — every auto-simulated match's
 * replay 404'd. Anchoring the default at the repo root (the same
 * cwd-independent `__dirname` pattern index.ts already uses for `.env`)
 * makes both processes agree regardless of how they were launched.
 *
 * `MATCH_LOG_DIR`, when set, is still honored — but resolved to an
 * absolute path so a relative override can't reintroduce the same
 * cwd-dependent split. An unset value deliberately does NOT hard-fail:
 * the repo-root default is functional on a single host, and object
 * storage behind `MatchLogStorePort` is the real production plan (see
 * FilesystemMatchLogStore's own doc comment).
 *
 * Exported via the @tennis-manager/api package so apps/worker and every
 * seed/utility script share this exact resolution — the two can never
 * drift again.
 */
export function resolveMatchLogDirectory(): string {
  const configured = process.env.MATCH_LOG_DIR;
  return configured ? resolve(configured) : resolve(__dirname, '../../../data/match-logs');
}
