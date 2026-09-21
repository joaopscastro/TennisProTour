import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MatchId, PlayerId } from '@tennis-manager/domain';
import {
  PlayerAttributes,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { MatchParticipant, RandomSource } from '@tennis-manager/domain';
import { StatisticalMatchSimulator } from '@tennis-manager/domain';
import { MatchLog } from '@tennis-manager/domain';
import { FilesystemMatchLogStore } from './FilesystemMatchLogStore';

/** Cycles through a fixed sequence — deterministic without being
 * constant, so the simulated match has both players winning games. */
class FixedSequenceRandomSource implements RandomSource {
  private index = 0;

  constructor(private readonly values: number[]) {}

  next(): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    return value;
  }
}

function participant(id: string, base: number): MatchParticipant {
  return {
    playerId: PlayerId(id),
    fatigue: 10,
    form: 0,
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
      physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
      mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
      surfaceAffinities: SurfaceAffinities.initial(),
    }),
  };
}

function emptyLog(simulatedAt = new Date().toISOString()): MatchLog {
  return { entries: [], points: [], totalDurationSeconds: 0, simulatedAt };
}

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'match-logs-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('FilesystemMatchLogStore', () => {
  it('round-trips a simulated MatchLog through save and readback (file URL + read())', async () => {
    const simulator = new StatisticalMatchSimulator(
      new FixedSequenceRandomSource([0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8]),
    );
    const { log: simulatedLog } = simulator.simulate(participant('pA', 60), participant('pB', 55), 'clay');
    expect(simulatedLog.entries.length).toBeGreaterThan(0); // meaningful round-trip, not an empty blob
    const log: MatchLog = { ...simulatedLog, simulatedAt: new Date().toISOString() };

    const store = new FilesystemMatchLogStore({ directory, worldId: 'world-a' });
    const { url } = await store.save(MatchId('match-1'), log);

    expect(url.startsWith('file://')).toBe(true);
    const roundTripped: MatchLog = JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
    expect(roundTripped).toEqual(log);

    // read() is the SAME path derivation the writer used (one place).
    expect(JSON.parse(await store.read(MatchId('match-1')))).toEqual(log);

    // Atomic write leaves no temp file behind in the world directory.
    const entries = await readdir(join(directory, 'world-a'));
    expect(entries.sort()).toEqual(['match-1.json']);
  });

  it('overwrites the SAME match id and reads back the SECOND content (was: threw EEXIST)', async () => {
    // Deliberate behavior change: this test used to pin write-once (a
    // second save rejected). That expectation ENCODED THE BUG — match
    // ids are deterministic, so a re-simulated match or a re-bootstrapped
    // demo draw legitimately saves the same id again, and the day tick
    // counted the thrown EEXIST as a failed match while the API kept
    // serving the stale blob. A replay MUST reflect the committed
    // outcome, so the second save must not throw and must win.
    const store = new FilesystemMatchLogStore({ directory, worldId: 'world-a' });

    await store.save(MatchId('match-2'), emptyLog('2020-01-01T00:00:00.000Z'));
    const second = emptyLog('2024-06-01T12:00:00.000Z');
    await expect(store.save(MatchId('match-2'), second)).resolves.toEqual({
      url: expect.stringContaining('match-2.json'),
    });

    expect(JSON.parse(await store.read(MatchId('match-2')))).toEqual(second);
  });

  it('scopes the on-disk layout per world, so two worlds cannot collide on one match id', async () => {
    const worldA = new FilesystemMatchLogStore({ directory, worldId: 'world-a' });
    const worldB = new FilesystemMatchLogStore({ directory, worldId: 'world-b' });

    const logA = emptyLog('2021-01-01T00:00:00.000Z');
    const logB = emptyLog('2022-02-02T00:00:00.000Z');
    await worldA.save(MatchId('shared-id'), logA);
    await worldB.save(MatchId('shared-id'), logB);

    expect(JSON.parse(await worldA.read(MatchId('shared-id')))).toEqual(logA);
    expect(JSON.parse(await worldB.read(MatchId('shared-id')))).toEqual(logB);
  });

  it('builds dev-server URLs when publicBaseUrl is configured (public URL is world-agnostic)', async () => {
    const store = new FilesystemMatchLogStore({
      directory,
      worldId: 'world-a',
      publicBaseUrl: 'http://localhost:3001/match-logs/',
    });
    const { url } = await store.save(MatchId('match-3'), emptyLog());

    expect(url).toBe('http://localhost:3001/match-logs/match-3.json');
  });
});
