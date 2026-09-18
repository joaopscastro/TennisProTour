'use client';

import { CLERK_ENABLED } from './api';

/**
 * The local development manager id, or `undefined` when a real identity
 * provider is configured.
 *
 * A page's manager-id input is a DEVELOPMENT affordance only. With Clerk
 * enabled, identity comes from the signed-in session — the API reads the
 * bearer token and ignores `x-dev-manager-id` entirely under
 * `AUTH_MODE=clerk` — so prefilling "seed-m1" would only mislead. This
 * used to be a hardcoded `'seed-m1'` default on every page; returning
 * `undefined` in a Clerk build removes that production default while
 * keeping local development unchanged.
 *
 * `CLERK_ENABLED` is a build-time constant (`NEXT_PUBLIC_*` is inlined),
 * so the value is stable across renders, not something that flips.
 */
export function useDevManagerId(): string | undefined {
  return CLERK_ENABLED ? undefined : (process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1');
}
