import { describe, expect, it } from 'vitest';
import { ConcurrentModificationError } from '../ports/ports';
import { DEFAULT_RETRY_ON_CONFLICT_ATTEMPTS, retryOnConflict } from './retryOnConflict';

/** Deterministic no-wait sleep + jitter for every case below. */
function harness(attempts = DEFAULT_RETRY_ON_CONFLICT_ATTEMPTS) {
  const sleeps: number[] = [];
  return {
    sleeps,
    options: {
      attempts,
      random: () => 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('retryOnConflict', () => {
  it('returns the result directly when the operation never conflicts', async () => {
    const { sleeps, options } = harness();
    let calls = 0;
    const result = await retryOnConflict(async () => {
      calls += 1;
      return 'ok';
    }, options);
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a ConcurrentModificationError and succeeds against the fresh state', async () => {
    const { sleeps, options } = harness();
    let calls = 0;
    const result = await retryOnConflict(async () => {
      calls += 1;
      if (calls < 3) throw new ConcurrentModificationError('t1');
      return calls;
    }, options);
    expect(result).toBe(3);
    expect(calls).toBe(3);
    // Two backoffs: base 25 doubled -> 25 then 50 (random()=0 halves
    // each: round(25*0.5)=13, round(50*0.5)=25).
    expect(sleeps).toEqual([13, 25]);
  });

  it('rethrows a NON-conflict error immediately, without retrying', async () => {
    const { sleeps, options } = harness();
    let calls = 0;
    await expect(
      retryOnConflict(async () => {
        calls += 1;
        throw new Error('rule violation');
      }, options),
    ).rejects.toThrow('rule violation');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the bounded attempts and rethrows the ORIGINAL conflict (the route still maps it to 409)', async () => {
    const { sleeps, options } = harness(4);
    let calls = 0;
    let thrown: unknown;
    try {
      await retryOnConflict(async () => {
        calls += 1;
        throw new ConcurrentModificationError('t-busy');
      }, options);
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(4);
    expect(thrown).toBeInstanceOf(ConcurrentModificationError);
    expect((thrown as Error).message).toContain('t-busy');
    expect(sleeps).toHaveLength(3); // never sleeps after the final attempt
  });

  it('defaults to the documented attempt count and rejects an impossible configuration', async () => {
    const { options } = harness(1);
    let calls = 0;
    await expect(
      retryOnConflict(async () => {
        calls += 1;
        throw new ConcurrentModificationError('t');
      }, options),
    ).rejects.toThrow(ConcurrentModificationError);
    expect(calls).toBe(1);

    await expect(retryOnConflict(async () => 'x', { attempts: 0 })).rejects.toThrow(/at least one attempt/);
  });
});
