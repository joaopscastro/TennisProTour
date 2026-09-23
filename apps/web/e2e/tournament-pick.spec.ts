import { expect, test } from '@playwright/test';
import {
  buildTournamentPickGroups,
  describeBrowseFilters,
  entryFitFor,
  entryFitLabel,
  entryPlacement,
  fitGuidance,
  groupTournamentsForPicker,
  matchesTournamentPickFilters,
  pruneTiersForCategory,
  sortTournamentsForPicker,
  tierChipAppliesToCategory,
  tournamentHasRoom,
  tournamentRefusalReason,
} from '../lib/tournamentPick';
import type { PickableTournament } from '../lib/tournamentPick';

/**
 * Pure-logic regression tests for the entry-flow fixes from the naive-user
 * walkthrough. No browser needed — same pattern as display-logic.spec.ts.
 */

function tour(
  overrides: Partial<PickableTournament> & { id: string; weekScheduled: { season: number; week: number } },
): PickableTournament {
  return {
    name: 'Event',
    tier: 'tour',
    surface: 'hard',
    ageBand: null,
    hostCountry: null,
    entrants: [],
    drawSize: 32,
    ...overrides,
  };
}

test.describe('picker sort — weeks ascending, then tier', () => {
  test('a scrambled week order is sorted nearest-first', () => {
    const scrambled = [
      tour({ id: 'w9', name: 'Week 9', weekScheduled: { season: 1, week: 9 } }),
      tour({ id: 'w3', name: 'Week 3', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 'w5', name: 'Week 5', weekScheduled: { season: 1, week: 5 } }),
      tour({ id: 'w4', name: 'Week 4', weekScheduled: { season: 1, week: 4 } }),
    ];
    expect(sortTournamentsForPicker(scrambled).map((t) => t.id)).toEqual(['w3', 'w4', 'w5', 'w9']);
  });

  test('a later season sorts after an earlier one', () => {
    const list = [
      tour({ id: 's2w1', weekScheduled: { season: 2, week: 1 } }),
      tour({ id: 's1w52', weekScheduled: { season: 1, week: 52 } }),
    ];
    expect(sortTournamentsForPicker(list).map((t) => t.id)).toEqual(['s1w52', 's2w1']);
  });

  test('within one week: senior before junior, then lower tier first', () => {
    const list = [
      tour({ id: 'j100', tier: 'j100', ageBand: 'u14', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 'major', tier: 'major', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 'futures', tier: 'futures', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 'j30', tier: 'j30', ageBand: 'u16', weekScheduled: { season: 1, week: 3 } }),
    ];
    expect(sortTournamentsForPicker(list).map((t) => t.id)).toEqual(['futures', 'major', 'j30', 'j100']);
  });
});

test.describe('picker grouping — sectioned by circuit + week', () => {
  test('sorted senior/junior sections stay contiguous', () => {
    const list = [
      tour({ id: 'j1', tier: 'j30', ageBand: 'u14', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 's1', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 's2', weekScheduled: { season: 1, week: 4 } }),
    ];
    const groups = groupTournamentsForPicker(sortTournamentsForPicker(list));
    expect(groups.map((g) => g.key)).toEqual(['senior-1-3', 'junior-1-3', 'senior-1-4']);
    expect(groups[0].label).toContain('Senior');
    expect(groups[1].label).toContain('Junior');
  });

  test('buildTournamentPickGroups filters before grouping', () => {
    const list = [
      tour({ id: 's', weekScheduled: { season: 1, week: 3 } }),
      tour({ id: 'j', tier: 'j30', ageBand: 'u16', weekScheduled: { season: 1, week: 3 } }),
    ];
    const groups = buildTournamentPickGroups(list, { circuit: 'junior', surfaces: new Set(), search: '' });
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((t) => t.id)).toEqual(['j']);
  });
});

test.describe('picker filters — never a silent hide', () => {
  test('the eligible default drops an age-ineligible band', () => {
    const ineligible = tour({ id: 'senior', ageEligible: false, weekScheduled: { season: 1, week: 3 } });
    expect(matchesTournamentPickFilters(ineligible, { circuit: 'eligible', surfaces: new Set(), search: '' })).toBe(false);
    expect(matchesTournamentPickFilters(ineligible, { circuit: 'all', surfaces: new Set(), search: '' })).toBe(true);
  });

  test('junior keeps only junior bands; senior only senior events', () => {
    const junior = tour({ id: 'j', tier: 'j30', ageBand: 'u16', weekScheduled: { season: 1, week: 3 } });
    const senior = tour({ id: 's', weekScheduled: { season: 1, week: 3 } });
    expect(matchesTournamentPickFilters(junior, { circuit: 'junior', surfaces: new Set(), search: '' })).toBe(true);
    expect(matchesTournamentPickFilters(senior, { circuit: 'junior', surfaces: new Set(), search: '' })).toBe(false);
    expect(matchesTournamentPickFilters(senior, { circuit: 'senior', surfaces: new Set(), search: '' })).toBe(true);
  });

  test('search matches name and country, and surface narrows', () => {
    const t = tour({ id: 'x', name: 'Cobalt Clay Open', surface: 'clay', hostCountry: 'Spain', weekScheduled: { season: 1, week: 3 } });
    expect(matchesTournamentPickFilters(t, { circuit: 'all', surfaces: new Set(), search: 'cobalt' })).toBe(true);
    expect(matchesTournamentPickFilters(t, { circuit: 'all', surfaces: new Set(), search: 'spain' })).toBe(true);
    expect(matchesTournamentPickFilters(t, { circuit: 'all', surfaces: new Set(['clay']), search: '' })).toBe(true);
    expect(matchesTournamentPickFilters(t, { circuit: 'all', surfaces: new Set(['grass']), search: '' })).toBe(false);
  });
});

test.describe('Browse Junior filter — the real bug', () => {
  test("pruning drops the senior-only default 'tour' chip when Junior is chosen", () => {
    const pruned = pruneTiersForCategory('junior', new Set(['tour']));
    expect([...pruned]).toEqual([]);
  });

  test('pruning drops junior bands when Senior is chosen', () => {
    expect([...pruneTiersForCategory('senior', new Set(['u16', 'tour']))]).toEqual(['tour']);
  });

  test('All never prunes', () => {
    expect([...pruneTiersForCategory('all', new Set(['u16', 'tour']))].sort()).toEqual(['tour', 'u16']);
  });

  test('tier chips only show for the category they can match', () => {
    expect(tierChipAppliesToCategory('tour', 'junior')).toBe(false);
    expect(tierChipAppliesToCategory('u16', 'junior')).toBe(true);
    expect(tierChipAppliesToCategory('u16', 'senior')).toBe(false);
    expect(tierChipAppliesToCategory('tour', 'all')).toBe(true);
  });
});

test.describe('Browse "All" honesty — the displayed state names the applied tier', () => {
  test('an "All circuits" view with a tour tier filter names the tier', () => {
    const summary = describeBrowseFilters('all', new Set(['tour']), new Set());
    expect(summary).toContain('all circuits');
    expect(summary).toContain('tier tour');
  });

  test('no filters reads as just the circuit', () => {
    expect(describeBrowseFilters('senior', new Set(), new Set())).toBe('senior tour');
  });

  test('surfaces and multiple tiers are all named', () => {
    const summary = describeBrowseFilters('senior', new Set(['tour', 'futures']), new Set(['clay']));
    expect(summary).toBe('senior tour · tier futures + tour · surface clay');
  });
});

test.describe('entry confirmation names the real draw', () => {
  test('a below-cutoff registrant is reported as qualifying, not main draw', () => {
    const entrants = [
      { playerId: 'da-1', draw: 'main' as const },
      { playerId: 'q-1', draw: 'qualifying' as const },
    ];
    expect(entryPlacement(entrants, 'q-1')).toBe('qualifying');
    expect(entryPlacement(entrants, 'da-1')).toBe('main');
    // A wild card / direct acceptance promoted into the main draw reads main.
    expect(entryPlacement([{ playerId: 'wc-1', draw: 'main' as const }], 'wc-1')).toBe('main');
    // A player not present at all (defensive) reads main, never throws.
    expect(entryPlacement([], 'missing')).toBe('main');
  });
});

test.describe('entry fit — the picker guides which event suits the player', () => {
  test('a qualifying-tier entry reads "qualifying", everything else "direct"', () => {
    expect(entryFitFor(tour({ id: 'q', entryViaQualifying: true, weekScheduled: { season: 1, week: 3 } }))).toBe('qualifying');
    expect(entryFitFor(tour({ id: 'd', weekScheduled: { season: 1, week: 3 } }))).toBe('direct');
    // undefined (a non-qualifying tier / non-player-scoped list) is "direct".
    expect(entryFitFor(tour({ id: 'u', weekScheduled: { season: 1, week: 3 } }))).toBe('direct');
  });

  test('the fit label is human-readable', () => {
    expect(entryFitLabel('direct')).toBe('Direct entry');
    expect(entryFitLabel('qualifying')).toBe('Via qualifying');
  });

  test('the "direct entry only" filter drops qualifying events and is off by default', () => {
    const q = tour({ id: 'q', entryViaQualifying: true, weekScheduled: { season: 1, week: 3 } });
    const d = tour({ id: 'd', weekScheduled: { season: 1, week: 3 } });
    const base = { circuit: 'all' as const, surfaces: new Set<string>(), search: '' };
    // Absent field = no narrowing (every existing caller is unchanged).
    expect(matchesTournamentPickFilters(q, base)).toBe(true);
    expect(matchesTournamentPickFilters(q, { ...base, directEntryOnly: true })).toBe(false);
    expect(matchesTournamentPickFilters(d, { ...base, directEntryOnly: true })).toBe(true);
  });

  test('fit guidance names the rank and always disclaims predicting results', () => {
    expect(fitGuidance(null)).toBeNull();
    const ranked = fitGuidance({ overall: 62, rank: 45, rankBand: 'senior' })!;
    expect(ranked).toContain('#45');
    expect(ranked).toContain('SENIOR');
    expect(ranked).toContain('Direct entry');
    expect(ranked).toContain('Via qualifying');
    expect(ranked.toLowerCase()).toContain('predict');
    const unranked = fitGuidance({ overall: 48, rank: null, rankBand: 'senior' })!;
    expect(unranked).toContain('unranked');
    expect(unranked).toContain('SENIOR');
  });
});

test.describe('refusal reasons mirror the server rules', () => {
  test('age, cap, qualifying-full and full-draw are all surfaced', () => {
    const base = { entrants: [], drawSize: 32 };
    expect(tournamentRefusalReason(tour({ id: 'a', ageBand: 'u14', ageEligible: false, weekScheduled: { season: 1, week: 3 } }))).toContain('Too old');
    expect(
      tournamentRefusalReason(
        tour({ id: 'b', weeklyEntryCountThisWeek: 1, weeklyEntryCapThisWeek: 1, weekScheduled: { season: 1, week: 3 } }),
      ),
    ).toContain('Already entered');
    expect(
      tournamentRefusalReason(
        tour({
          id: 'c',
          entryViaQualifying: true,
          qualifyingFieldFull: true,
          qualifyingFieldTaken: 8,
          qualifyingFieldSize: 8,
          weekScheduled: { season: 1, week: 3 },
        }),
      ),
    ).toContain('Qualifying field full');
    expect(
      tournamentRefusalReason(
        tour({
          id: 'd',
          ...base,
          entrants: Array.from({ length: 32 }, () => ({ draw: 'main' as const })),
          weekScheduled: { season: 1, week: 3 },
        }),
      ),
    ).toContain('Main draw full');
  });

  test('an enterable tournament has no refusal and has room', () => {
    const t = tour({ id: 'ok', weekScheduled: { season: 1, week: 3 } });
    expect(tournamentRefusalReason(t)).toBeNull();
    expect(tournamentHasRoom(t)).toBe(true);
  });

  test('a below-cutoff entrant is measured against the qualifying field', () => {
    const t = tour({
      id: 'q',
      entryViaQualifying: true,
      qualifyingFieldFull: true,
      weekScheduled: { season: 1, week: 3 },
    });
    expect(tournamentHasRoom(t)).toBe(false);
  });
});
