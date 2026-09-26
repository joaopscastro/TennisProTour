import { describe, expect, it } from 'vitest';
import { Dependencies } from '@tennis-manager/api';
import { makeAdvanceWorldHandler } from './handlers';

/**
 * Pins the D3 ordering contract in the REAL handler: the acquisition
 * guard (ensureSignablePool) must run AFTER startDueTournaments — never
 * before — because the week's filler/entry placements have to be
 * committed first. Running it earlier would let the placements consume
 * the very signable pool the guard just guaranteed. The rest of the
 * weekly order is pinned alongside it, so a future edit can't silently
 * reshuffle the systems this test's sibling tests cover.
 */
describe('makeAdvanceWorldHandler — weekly system ordering (D3)', () => {
  function buildRecordingDeps(): { deps: Dependencies; calls: string[] } {
    const calls: string[] = [];
    const record = (name: string) => ({
      execute: async () => {
        calls.push(name);
        return {};
      },
    });

    const deps = {
      advanceWorldWeek: {
        execute: async () => {
          calls.push('advanceWorldWeek');
          return {
            advanced: true,
            weekRolledOver: true,
            playersAged: 0,
            seasonRolledOver: false,
          };
        },
      },
      refreshTalentPool: record('refreshTalentPool'),
      generateJuniorTournaments: record('generateJuniorTournaments'),
      generateSeniorTournaments: record('generateSeniorTournaments'),
      ensureFillOnlyPopulation: record('ensureFillOnlyPopulation'),
      startDueTournaments: record('startDueTournaments'),
      ensureSignablePool: record('ensureSignablePool'),
      applyObligatoryTournamentZeros: record('applyObligatoryTournamentZeros'),
      paySeasonBonusPool: record('paySeasonBonusPool'),
      worlds: {
        findById: async () => ({ currentWeek: { season: 1, week: 10 } }),
      },
      simulateDueMatches: {
        execute: async () => {
          calls.push('simulateDueMatches');
          return { simulated: [], failed: [] };
        },
      },
      promoteQualifiers: record('promoteQualifiers'),
      promoteDoublesQualifiers: record('promoteDoublesQualifiers'),
      simulateDueMastersCupMatches: record('simulateDueMastersCupMatches'),
      advanceMastersCup: record('advanceMastersCup'),
      simulateDueWorldTeamCupRubbers: record('simulateDueWorldTeamCupRubbers'),
      advanceWorldTeamCup: record('advanceWorldTeamCup'),
      // The handler never touches anything else this run.
    } as unknown as Dependencies;

    return { deps, calls };
  }

  it('runs the acquisition loop immediately after startDueTournaments, before the ranking corrections', async () => {
    const { deps, calls } = buildRecordingDeps();
    const handler = makeAdvanceWorldHandler(deps, null);

    await handler({ worldId: 'main' });

    const weekly = calls.filter((c) => c !== 'advanceWorldWeek' && c !== 'simulateDueMatches');
    expect(weekly.indexOf('ensureSignablePool')).toBe(weekly.indexOf('startDueTournaments') + 1);
    // And the deliberate "last" ranking correction stays last.
    expect(weekly.indexOf('applyObligatoryTournamentZeros')).toBe(weekly.indexOf('ensureSignablePool') + 1);
    // The guard runs on the weekly rollover, after the placements.
    expect(calls).toContain('ensureSignablePool');
  });

  it('does not run the acquisition loop on an ordinary (non-rollover) day tick', async () => {
    const { deps, calls } = buildRecordingDeps();
    (deps.advanceWorldWeek as unknown as { execute: () => Promise<unknown> }).execute = async () => {
      calls.push('advanceWorldWeek');
      return { advanced: true, weekRolledOver: false, playersAged: 0, seasonRolledOver: false };
    };
    const handler = makeAdvanceWorldHandler(deps, null);

    await handler({ worldId: 'main' });

    expect(calls).not.toContain('ensureSignablePool');
    expect(calls).not.toContain('startDueTournaments');
    expect(calls).toContain('simulateDueMatches');
  });
});
