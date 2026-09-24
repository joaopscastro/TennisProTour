/**
 * WORLD_TICK_PROFILE=1-gated phase timing for the world tick and its
 * use cases (soak/performance work — see AGENTS.md).
 *
 * WHY THIS LIVES IN THE APPLICATION PACKAGE, NOT THE WORKER: the phases
 * worth measuring (per-player weekly loop, ladder decay, windowed
 * ranking reads) are inside use cases that must stay callable from
 * tests and scripts. A tiny, dependency-free profiler here means the
 * SAME gating (one env var) covers both the worker's handler phases and
 * the use-case-internal phases, and a run driven by
 * `apps/worker/src/scripts/soakTick.ts` (which bypasses BullMQ) still
 * reports the identical table.
 *
 * ENV GATING: `WORLD_TICK_PROFILE=1` enables it; anything else (unset,
 * empty, "0") leaves it off. A disabled profiler never calls
 * `Date.now()` and never touches the console — `mark()` is a single
 * boolean check — so production behaviour (and production cost) is
 * byte-identical with the flag unset.
 */
export function isTickProfileEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.WORLD_TICK_PROFILE === '1';
}

/**
 * One log line per phase, JSON-shaped and machine-readable:
 * `{"msg":"world-tick-profile","scope":"...","phase":"...","ms":N,...}`.
 *
 * Time is measured BETWEEN marks, not since construction — so a handler
 * that wraps each awaited system in one mark gets each system's own
 * duration, and a use case can mark its own internal phases the same
 * way. `extra` carries counts or flags that make the phase table
 * legible (players aged, matches simulated, ...).
 */
export class TickProfiler {
  private readonly enabled: boolean;
  private last: number;

  constructor(private readonly scope: string) {
    this.enabled = isTickProfileEnabled();
    this.last = this.enabled ? Date.now() : 0;
  }

  /** True when WORLD_TICK_PROFILE=1 — callers that would otherwise add
   * per-item timing arithmetic can guard on this to keep the disabled
   * path allocation-free. */
  get profiling(): boolean {
    return this.enabled;
  }

  /** Logs ms since construction (or the previous mark) under `phase`.
   * No-op when the profile flag is unset. */
  mark(phase: string, extra?: Record<string, number | string | boolean>): void {
    if (!this.enabled) return;
    const now = Date.now();
    const line = JSON.stringify({
      msg: 'world-tick-profile',
      scope: this.scope,
      phase,
      ms: now - this.last,
      ...extra,
    });
    // eslint-disable-next-line no-console
    console.log(line);
    this.last = now;
  }
}
