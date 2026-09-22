'use client';

import { useCallback, useEffect, useState } from 'react';
import { EntitlementDto, fetchEntitlement } from './api';

/**
 * The single source of a manager's entitlement (tier + XP balance) for
 * every surface in one browser session.
 *
 * Why this exists: each page used to call `fetchEntitlement` on its own
 * and hold the result in local state. That is fine on a fresh mount, but
 * a page whose React state is preserved across client-side navigation
 * (Next's router cache / back-forward restore) could keep showing a
 * pre-spend balance while another surface showed the current one — the
 * "XP differs between screens" class of bug. Here every surface reads
 * the same cached value and subscribes to the same updates, and a spend
 * (a claim, a coach conversion) calls `refreshEntitlement` once so ALL
 * surfaces update without a hard reload.
 *
 * Deliberately NOT a React context/provider: a module-level store works
 * across client-side route changes without wrapping the whole app, and
 * keeps the diff small. It is keyed by manager id (empty string in Clerk
 * mode, where the API resolves identity from the session).
 */

interface Entry {
  value: EntitlementDto | null;
  loaded: boolean;
  inFlight: Promise<EntitlementDto | null> | null;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function entryFor(managerId: string): Entry {
  let entry = store.get(managerId);
  if (!entry) {
    entry = { value: null, loaded: false, inFlight: null };
    store.set(managerId, entry);
  }
  return entry;
}

function emit(managerId: string): void {
  const set = listeners.get(managerId);
  if (!set) return;
  for (const listener of set) listener();
}

/** The last-known entitlement for a manager, or null if never loaded. */
export function peekEntitlement(managerId: string): EntitlementDto | null {
  return store.get(managerId)?.value ?? null;
}

/**
 * Fetches the current entitlement and broadcasts it to every subscriber.
 * Concurrent callers share one in-flight request. A failure leaves the
 * last-known value in place (it never blanks a known balance) and
 * resolves to whatever value is cached.
 */
export function refreshEntitlement(managerId: string): Promise<EntitlementDto | null> {
  const entry = entryFor(managerId);
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = fetchEntitlement(managerId)
    .then((value) => {
      entry.value = value;
      entry.loaded = true;
      emit(managerId);
      return value;
    })
    .catch(() => entry.value)
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}

/**
 * Subscribes a component to one manager's shared entitlement. Fetches
 * once if nothing is cached yet, re-reads on focus/visibility so a tab
 * left open (or restored from bfcache) can't show a stale balance, and
 * returns a `refresh` to call after a spend.
 */
export function useEntitlement(managerId: string): {
  entitlement: EntitlementDto | null;
  loaded: boolean;
  refresh: () => Promise<EntitlementDto | null>;
} {
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  useEffect(() => {
    let set = listeners.get(managerId);
    if (!set) {
      set = new Set();
      listeners.set(managerId, set);
    }
    set.add(rerender);
    if (!entryFor(managerId).loaded) void refreshEntitlement(managerId);
    return () => {
      set!.delete(rerender);
      if (set!.size === 0) listeners.delete(managerId);
    };
  }, [managerId, rerender]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshEntitlement(managerId);
    };
    window.addEventListener('focus', onVisible);
    window.addEventListener('pageshow', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('pageshow', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [managerId]);

  const entry = store.get(managerId);
  const refresh = useCallback(() => refreshEntitlement(managerId), [managerId]);
  return { entitlement: entry?.value ?? null, loaded: entry?.loaded ?? false, refresh };
}
