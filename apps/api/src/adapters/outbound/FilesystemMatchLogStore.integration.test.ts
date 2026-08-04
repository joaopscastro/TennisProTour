import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
      physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
      mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
      surfaceAffinities: SurfaceAffinities.initial(),
    }),
  };
}

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'match-logs-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('FilesystemMatchLogStore', () => {
  it('round-trips a simulated MatchLog through save and file readback', async () => {
    const simulator = new StatisticalMatchSimulator(
      new FixedSequenceRandomSource([0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8]),
    );
    const { log } = simulator.simulate(participant('pA', 60), participant('pB', 55), 'clay');
    expect(log.entries.length).toBeGreaterThan(0); // meaningful round-trip, not an empty blob

    const store = new FilesystemMatchLogStore({ directory });
    const { url } = await store.save(MatchId('match-1'), log);

    expect(url.startsWith('file://')).toBe(true);
    const roundTripped: MatchLog = JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
    expect(roundTripped).toEqual(log);
  });

  it('refuses to overwrite an existing log (write-once, like the future object-store adapter)', async () => {
    const store = new FilesystemMatchLogStore({ directory });
    const log: MatchLog = { entries: [], points: [], totalDurationSeconds: 0 };

    await store.save(MatchId('match-2'), log);
    await expect(store.save(MatchId('match-2'), log)).rejects.toThrow();
  });

  it('builds dev-server URLs when publicBaseUrl is configured', async () => {
    const store = new FilesystemMatchLogStore({ directory, publicBaseUrl: 'http://localhost:3001/match-logs/' });
    const { url } = await store.save(MatchId('match-3'), { entries: [], points: [], totalDurationSeconds: 0 });

    expect(url).toBe('http://localhost:3001/match-logs/match-3.json');
  });
});
