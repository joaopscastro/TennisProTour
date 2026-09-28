import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SUPERVISOR_RESTARTS,
  cleanupRunnerTempFiles,
  decideSupervisorAction,
  readJsonWithTmpFallback,
} from './runnerResilience.mjs';

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-resilience-'));
  mkdirSync(join(dir, 'weeks', 'week-039'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'r1' }));
  writeFileSync(join(dir, 'weeks', 'week-039', 'state.json'), JSON.stringify({ phase: 'open' }));
  return dir;
}

describe('runnerResilience', () => {
  let runDir;
  beforeEach(() => {
    runDir = makeRunDir();
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  describe('readJsonWithTmpFallback', () => {
    it('reads the real file when it is present and valid (the temp is ignored)', () => {
      writeFileSync(join(runDir, 'run.json.tmp-1-2'), JSON.stringify({ runId: 'from-tmp' }));
      expect(readJsonWithTmpFallback(join(runDir, 'run.json'))).toEqual({ runId: 'r1' });
    });

    it('recovers the NEWEST valid temp when the real file is missing (the live crash case)', () => {
      rmSync(join(runDir, 'run.json'));
      writeFileSync(join(runDir, 'run.json.tmp-10-100'), JSON.stringify({ runId: 'old' }));
      writeFileSync(join(runDir, 'run.json.tmp-10-200'), JSON.stringify({ runId: 'new' }));
      expect(readJsonWithTmpFallback(join(runDir, 'run.json'))).toEqual({ runId: 'new' });
    });

    it('skips an unparseable temp and falls back to an older valid one', () => {
      rmSync(join(runDir, 'run.json'));
      writeFileSync(join(runDir, 'run.json.tmp-10-100'), JSON.stringify({ runId: 'valid' }));
      writeFileSync(join(runDir, 'run.json.tmp-10-200'), '{ truncated');
      expect(readJsonWithTmpFallback(join(runDir, 'run.json'))).toEqual({ runId: 'valid' });
    });

    it('recovers a corrupt real file from its temp too', () => {
      writeFileSync(join(runDir, 'run.json'), '{ truncated');
      writeFileSync(join(runDir, 'run.json.tmp-10-50'), JSON.stringify({ runId: 'recovered' }));
      expect(readJsonWithTmpFallback(join(runDir, 'run.json'))).toEqual({ runId: 'recovered' });
    });

    it('returns null when neither the file nor any temp parses', () => {
      rmSync(join(runDir, 'run.json'));
      expect(readJsonWithTmpFallback(join(runDir, 'run.json'))).toBeNull();
    });
  });

  describe('cleanupRunnerTempFiles', () => {
    it('removes stale runner temps at both levels and leaves the real files alone', () => {
      writeFileSync(join(runDir, 'run.json.tmp-1-1'), '{}');
      writeFileSync(join(runDir, 'report.json.tmp-1-2'), '{}');
      writeFileSync(join(runDir, 'weeks', 'week-039', 'state.json.tmp-19232-1790606999999'), '{}');

      const removed = cleanupRunnerTempFiles(runDir);

      expect(removed).toHaveLength(3);
      expect(existsSync(join(runDir, 'run.json'))).toBe(true);
      expect(existsSync(join(runDir, 'weeks', 'week-039', 'state.json'))).toBe(true);
      const leftovers = readdirSync(runDir).filter((n) => n.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('never touches an agent decision temp (a live writer may be mid-rename)', () => {
      mkdirSync(join(runDir, 'weeks', 'week-039', 'decisions'), { recursive: true });
      const decisionTmp = join(runDir, 'weeks', 'week-039', 'decisions', 'agent-m1.json.tmp-9-9');
      writeFileSync(decisionTmp, '{}');

      cleanupRunnerTempFiles(runDir);

      expect(existsSync(decisionTmp)).toBe(true);
    });
  });

  describe('decideSupervisorAction', () => {
    it('stops on a clean exit (0) and on a deliberate StopRunError (3)', () => {
      expect(decideSupervisorAction(0).action).toBe('stop');
      expect(decideSupervisorAction(3).action).toBe('stop');
    });

    it('restarts on an unexpected exit (1 and anything else)', () => {
      expect(decideSupervisorAction(1).action).toBe('restart');
      expect(decideSupervisorAction(137).action).toBe('restart');
      expect(decideSupervisorAction(null).action).toBe('restart');
    });

    it('caps restarts so a permanently-broken environment cannot loop forever', () => {
      expect(MAX_SUPERVISOR_RESTARTS).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_SUPERVISOR_RESTARTS)).toBe(true);
    });
  });
});
