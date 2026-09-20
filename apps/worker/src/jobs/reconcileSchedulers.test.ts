import { describe, expect, it } from 'vitest';
import { LegacySchedulerTarget, removeLegacySchedulers } from './reconcileSchedulers';

/** A fake Queue recording removeJobScheduler calls. `existing` models
 * which scheduler ids actually exist in Redis. */
function fakeQueue(existing: Set<string>) {
  const removed: string[] = [];
  return {
    removed,
    removeJobScheduler: async (id: string): Promise<boolean> => {
      if (!existing.has(id)) return false;
      existing.delete(id);
      removed.push(id);
      return true;
    },
  };
}

describe('removeLegacySchedulers', () => {
  it('removes every legacy scheduler that exists and logs each removal', async () => {
    const world = fakeQueue(new Set(['advance-world-week']));
    const matches = fakeQueue(new Set(['simulate-due-matches']));
    const logs: Array<{ message: string; payload: Record<string, unknown> }> = [];

    const targets: LegacySchedulerTarget[] = [
      { queueName: 'world', queue: world, schedulerIds: ['advance-world-week'] },
      { queueName: 'matches', queue: matches, schedulerIds: ['simulate-due-matches'] },
    ];
    await removeLegacySchedulers(targets, (message, payload) => logs.push({ message, payload }));

    expect(world.removed).toEqual(['advance-world-week']);
    expect(matches.removed).toEqual(['simulate-due-matches']);
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.payload.schedulerId)).toEqual(['advance-world-week', 'simulate-due-matches']);
  });

  it('is idempotent and silent when the legacy schedulers are already gone', async () => {
    const world = fakeQueue(new Set());
    const logs: Array<{ message: string; payload: Record<string, unknown> }> = [];

    await removeLegacySchedulers(
      [{ queueName: 'world', queue: world, schedulerIds: ['advance-world-week'] }],
      (message, payload) => logs.push({ message, payload }),
    );

    expect(world.removed).toEqual([]);
    expect(logs).toHaveLength(0);
  });

  it('logs (rather than throws) when removal fails, so boot is not blocked', async () => {
    const logs: Array<{ message: string; payload: Record<string, unknown> }> = [];
    const flaky: LegacySchedulerTarget = {
      queueName: 'world',
      queue: { removeJobScheduler: async () => { throw new Error('redis unavailable'); } },
      schedulerIds: ['advance-world-week'],
    };

    await expect(
      removeLegacySchedulers([flaky], (message, payload) => logs.push({ message, payload })),
    ).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('legacy job scheduler cleanup failed');
    expect(logs[0].payload.error).toBe('redis unavailable');
  });
});
