import { describe, expect, it } from 'vitest';
import {
  MAX_CAN_ENTER_NOW,
  buildCandidateView,
  compactDoublesTitles,
  compactLastResults,
  compareCandidates,
  decisionNeedsReaccept,
  enterabilityBlockReason,
  hashDecisionContent,
  reconcileDecisions,
  selectWeekEvents,
  tournamentConcluded,
} from './digestFeed.mjs';

/** Minimal toTournamentDto-shaped fixture; only the fields the helpers read. */
function tournament(overrides = {}) {
  return {
    id: overrides.id ?? 't1',
    name: overrides.name ?? 'Test Open',
    tier: overrides.tier ?? 'futures',
    circuit: overrides.circuit ?? 'senior',
    ageBand: overrides.ageBand ?? null,
    surface: overrides.surface ?? 'hard',
    hostCountry: overrides.hostCountry ?? 'Spain',
    weekScheduled: overrides.weekScheduled ?? { season: 1, week: 5 },
    drawSize: overrides.drawSize ?? 32,
    mainDrawEntrants: overrides.mainDrawEntrants ?? 8,
    doublesDrawSize: overrides.doublesDrawSize ?? 0,
    doublesEntrants: overrides.doublesEntrants ?? [],
    hasStarted: overrides.hasStarted ?? false,
    cancelled: overrides.cancelled ?? false,
    rounds: overrides.rounds ?? [],
    rankRestricted: overrides.rankRestricted ?? false,
    rankRestrictedReason: overrides.rankRestrictedReason ?? null,
    seasonCapRestricted: overrides.seasonCapRestricted ?? false,
    seasonCapReason: overrides.seasonCapReason ?? null,
    seasonCapUsedThisSeason: overrides.seasonCapUsedThisSeason ?? null,
    seasonCapLimitThisSeason: overrides.seasonCapLimitThisSeason ?? null,
    ...overrides,
  };
}

describe('tournamentConcluded (the pendingEntries filter)', () => {
  it('is false for a draw that has not been seeded yet (incl. still in qualifying)', () => {
    expect(tournamentConcluded(tournament({ rounds: [] }))).toBe(false);
  });

  it('is false for a seeded draw whose last round still has an undecided match', () => {
    const t = tournament({
      rounds: [
        { roundNumber: 1, matches: [{ outcome: { winner: 'a' } }] },
        { roundNumber: 2, matches: [{ outcome: null }] },
      ],
    });
    expect(tournamentConcluded(t)).toBe(false);
  });

  it('is true only once the last main round is fully decided', () => {
    const t = tournament({
      rounds: [
        { roundNumber: 1, matches: [{ outcome: { winner: 'a' } }] },
        { roundNumber: 2, matches: [{ outcome: { winner: 'a' } }] },
      ],
    });
    expect(tournamentConcluded(t)).toBe(true);
  });

  it('is true for a cancelled draw (terminal, never plays)', () => {
    expect(tournamentConcluded(tournament({ cancelled: true, rounds: [] }))).toBe(true);
  });

  it('regression: a STARTED but unfinished draw is NOT concluded (the exact old filter bug)', () => {
    // The old digest filter was `if (entry.hasStarted) continue` — by digest
    // time every tournament scheduled for the current week has started, so
    // a just-registered entry was always dropped. It must instead survive
    // until the draw CONCLUDES.
    const started = tournament({
      hasStarted: true,
      rounds: [{ roundNumber: 1, matches: [{ outcome: null }, { outcome: null }] }],
    });
    expect(started.hasStarted).toBe(true);
    expect(tournamentConcluded(started)).toBe(false);
  });
});

describe('buildCandidateView (canEnterNow)', () => {
  const currentAbs = 1 * 52 + 5; // S1W5

  it('lists rank-restricted events as disabled-with-reason instead of omitting them', () => {
    const restricted = tournament({
      id: 'restricted-1',
      name: 'Vanished Futures',
      tier: 'futures',
      rankRestricted: true,
      rankRestrictedReason: 'ranked #37 on the senior ladder — too high to enter a futures event',
    });
    const { rows, meta } = buildCandidateView([restricted], currentAbs);
    expect(rows).toHaveLength(1);
    expect(rows[0].enterable).toBe(false);
    expect(rows[0].blockedReason).toContain('too high to enter a futures event');
    expect(meta).toMatchObject({ shown: 1, enterableShown: 0, enterableTotal: 0, restrictedShown: 1, restrictedTotal: 1 });
  });

  it('lists season-cap-restricted challengers as disabled-with-reason too (Batch 4B, F1)', () => {
    // The API's player-scoped open list flags a top-50 player's 4th
    // challenger of the season with seasonCapRestricted/seasonCapReason.
    // compactCandidate used to ignore those fields, so the row read
    // `enterable: true` while the POST was refused (409) — exactly the
    // preview-vs-enforcement disagreement the rank fields prevent.
    const capped = tournament({
      id: 'capped-challenger',
      name: 'Capped Challenger',
      tier: 'challenger',
      seasonCapRestricted: true,
      seasonCapReason: 'you have already entered 3 challenger events this season (limit 3)',
      seasonCapUsedThisSeason: 3,
      seasonCapLimitThisSeason: 3,
    });
    const { rows, meta } = buildCandidateView([capped], currentAbs);
    expect(rows).toHaveLength(1);
    expect(rows[0].enterable).toBe(false);
    expect(rows[0].blockedReason).toContain('limit 3');
    expect(rows[0].seasonCapRestricted).toBe(true);
    expect(rows[0].seasonCapUsedThisSeason).toBe(3);
    expect(rows[0].seasonCapLimitThisSeason).toBe(3);
    expect(meta).toMatchObject({ shown: 1, enterableShown: 0, enterableTotal: 0, restrictedShown: 1, restrictedTotal: 1 });
  });

  it('never marks a season-capped row enterable, even when the enterable list is capped, and leaves plain rows neutral', () => {
    const enterable = Array.from({ length: MAX_CAN_ENTER_NOW + 2 }, (_, i) =>
      tournament({ id: `open-${i}`, name: `Open ${String(i).padStart(2, '0')}` }),
    );
    const capped = tournament({
      id: 'capped-1',
      name: 'Capped Challenger',
      tier: 'challenger',
      seasonCapRestricted: true,
      seasonCapReason: 'season limit reached',
    });
    const { rows, meta } = buildCandidateView([...enterable, capped], currentAbs);
    expect(rows.filter((r) => r.enterable)).toHaveLength(MAX_CAN_ENTER_NOW);
    expect(rows.filter((r) => !r.enterable)).toHaveLength(1);
    expect(rows[rows.length - 1].id).toBe('capped-1');
    expect(meta).toMatchObject({
      enterableShown: MAX_CAN_ENTER_NOW,
      enterableTotal: MAX_CAN_ENTER_NOW + 2,
      restrictedShown: 1,
      restrictedTotal: 1,
      truncated: true,
      hiddenCount: 2,
    });
    // A plain enterable row keeps its neutral season fields and no reason.
    expect(rows[0].seasonCapRestricted).toBe(false);
    expect(rows[0].blockedReason).toBeNull();
  });

  it('always shows restricted rows even when the enterable list is already capped', () => {
    const enterable = Array.from({ length: MAX_CAN_ENTER_NOW + 2 }, (_, i) =>
      tournament({ id: `open-${i}`, name: `Open ${String(i).padStart(2, '0')}` }),
    );
    const restricted = tournament({ id: 'r1', name: 'Restricted Open', rankRestricted: true, rankRestrictedReason: 'too high' });
    const { rows, meta } = buildCandidateView([...enterable, restricted], currentAbs);
    // MAX_CAN_ENTER_NOW enterable shown (capped) + the restricted row appended.
    expect(rows.filter((r) => r.enterable)).toHaveLength(MAX_CAN_ENTER_NOW);
    expect(rows.filter((r) => !r.enterable)).toHaveLength(1);
    expect(rows[rows.length - 1].id).toBe('r1');
    expect(meta).toMatchObject({
      enterableShown: MAX_CAN_ENTER_NOW,
      enterableTotal: MAX_CAN_ENTER_NOW + 2,
      restrictedShown: 1,
      restrictedTotal: 1,
      truncated: true,
      hiddenCount: 2,
    });
  });

  it('reports truncation so a capped list is never mistaken for the whole slate', () => {
    const enterable = Array.from({ length: 3 }, (_, i) => tournament({ id: `e${i}`, name: `Event ${i}` }));
    const { meta } = buildCandidateView(enterable, currentAbs);
    expect(meta).toMatchObject({ shown: 3, enterableShown: 3, enterableTotal: 3, truncated: false, hiddenCount: 0 });
  });

  it('never hides a senior tour while showing a junior event, even when the cap truncates', () => {
    // The measured bug: with a flat tier-prestige order a j200 outranked a
    // tour, and the cap of 10 could truncate the tour away entirely (the
    // senior tour was invisible in 25 snapshots). Fixture is deliberately
    // hostile: the tour is the FARTHEST week and junior events fill the
    // nearest weeks, so nearest-week ordering alone would hide it.
    const juniors = Array.from({ length: MAX_CAN_ENTER_NOW + 5 }, (_, i) =>
      tournament({
        id: `j-${i}`,
        name: `Junior ${String(i).padStart(2, '0')}`,
        tier: 'j200',
        circuit: 'junior',
        ageBand: 'u16',
        weekScheduled: { season: 1, week: 6 },
      }),
    );
    const tour = tournament({
      id: 'the-tour',
      name: 'Big Tour Event',
      tier: 'tour',
      circuit: 'senior',
      weekScheduled: { season: 1, week: 9 },
    });
    const { rows, meta } = buildCandidateView([...juniors, tour], currentAbs);
    const shownIds = rows.filter((r) => r.enterable).map((r) => r.id);
    expect(shownIds).toContain('the-tour');
    expect(meta.truncated).toBe(true);
    expect(meta.hiddenCount).toBeGreaterThan(0);
    // Every shown junior must be accompanied by the tour — the exact
    // "shows a junior while hiding a tour" contradiction.
    expect(meta.enterableShown).toBe(MAX_CAN_ENTER_NOW);
  });

  it('sorts senior tiers above junior tiers within the same week (a j200 no longer outranks a tour)', () => {
    const tour = tournament({ id: 'tour-1', tier: 'tour', circuit: 'senior', name: 'Tour Event' });
    const j200 = tournament({ id: 'j200-1', tier: 'j200', circuit: 'junior', name: 'Junior 200' });
    const { rows } = buildCandidateView([j200, tour], currentAbs);
    expect(rows.map((r) => r.id)).toEqual(['tour-1', 'j200-1']);
    expect(compareCandidates(tour, j200)).toBeLessThan(0);
  });

  it('still omits non-rank-restricted blocked rows (started, full, cap reached, ineligible, past)', () => {
    const rows = [
      tournament({ id: 'started', hasStarted: true }),
      tournament({ id: 'full', mainDrawEntrants: 32 }),
      tournament({ id: 'capped', weeklyEntryCountThisWeek: 1, weeklyEntryCapThisWeek: 1 }),
      tournament({ id: 'age', ageEligible: false }),
      tournament({ id: 'past', weekScheduled: { season: 1, week: 4 } }),
      tournament({ id: 'ok', name: 'Real Option' }),
    ];
    const { rows: shown } = buildCandidateView(rows, currentAbs);
    expect(shown.map((r) => r.id)).toEqual(['ok']);
  });

  it('sorts enterable candidates nearest-week first', () => {
    const rows = [
      tournament({ id: 'later', name: 'Later', weekScheduled: { season: 1, week: 8 } }),
      tournament({ id: 'sooner', name: 'Sooner', weekScheduled: { season: 1, week: 6 } }),
    ];
    const { rows: shown } = buildCandidateView(rows, currentAbs);
    expect(shown.map((r) => r.id)).toEqual(['sooner', 'later']);
  });
});

describe('selectWeekEvents (openByWeek)', () => {
  it('keeps the senior tour in a 30-event week and reports the hidden remainder', () => {
    const events = [
      tournament({ id: 'tour-w', tier: 'tour', circuit: 'senior', name: 'Weekly Tour' }),
      tournament({ id: 'major-w', tier: 'major', circuit: 'senior', name: 'Weekly Major' }),
      ...Array.from({ length: 18 }, (_, i) =>
        tournament({ id: `j30-${i}`, tier: 'j30', circuit: 'junior', name: `J30 ${i}` }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        tournament({ id: `j500-${i}`, tier: 'j500', circuit: 'junior', name: `J500 ${i}` }),
      ),
    ];
    expect(events).toHaveLength(30);
    const { events: shown, hiddenCount } = selectWeekEvents(events);
    const ids = shown.map((t) => t.id);
    expect(ids).toContain('tour-w');
    expect(ids).toContain('major-w');
    // At most 2 per (week, tier).
    expect(ids.filter((id) => id.startsWith('j30-'))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith('j500-'))).toHaveLength(2);
    expect(shown.length).toBeLessThan(events.length);
    expect(hiddenCount).toBe(events.length - shown.length);
  });

  it('reports hiddenCount 0 for a week it shows completely', () => {
    const events = [
      tournament({ id: 'a', tier: 'futures', circuit: 'senior' }),
      tournament({ id: 'b', tier: 'j60', circuit: 'junior' }),
    ];
    const { events: shown, hiddenCount } = selectWeekEvents(events);
    expect(shown).toHaveLength(2);
    expect(hiddenCount).toBe(0);
  });

  it('caps the total per week while still always including the pinned senior events', () => {
    const tiers = ['futures', 'challenger', 'tour', 'j30', 'j60'];
    const events = tiers.flatMap((tier) =>
      Array.from({ length: 8 }, (_, i) =>
        tournament({
          id: `${tier}-${i}`,
          tier,
          circuit: tier.startsWith('j') ? 'junior' : 'senior',
          name: `${tier} ${i}`,
        }),
      ),
    );
    expect(events).toHaveLength(40);
    const { events: shown, hiddenCount } = selectWeekEvents(events, 10, 2);
    expect(shown).toHaveLength(10);
    expect(hiddenCount).toBe(30);
    expect(shown.map((t) => t.id)).toContain('tour-0');
  });
});

describe('digest roster mappers (doubles titles + results)', () => {
  it('maps doubles titles distinctly, partner included', () => {
    const profile = {
      doublesTitles: [
        {
          tournamentId: 'dt-1',
          tier: 'challenger',
          partnerId: 'p2',
          partnerName: 'Partner Two',
          partnerNationality: 'BR',
          weekEarned: { season: 1, week: 9 },
        },
      ],
    };
    expect(compactDoublesTitles(profile)).toEqual([
      {
        tournamentId: 'dt-1',
        tier: 'challenger',
        partnerId: 'p2',
        partnerName: 'Partner Two',
        partnerNationality: 'BR',
        weekEarned: { season: 1, week: 9 },
      },
    ]);
    expect(compactDoublesTitles(null)).toEqual([]);
  });

  it('merges recent singles and recent doubles with a discipline tag, newest first', () => {
    const matches = {
      recent: [
        { tournamentId: 's1', tournamentName: 'S One', tier: 'futures', roundNumber: 1, result: 'win', setScores: [], weekScheduled: { season: 1, week: 4 } },
      ],
      recentDoubles: [
        { tournamentId: 'd1', tournamentName: 'D One', tier: 'challenger', roundNumber: 2, result: 'loss', setScores: [], weekScheduled: { season: 1, week: 6 } },
        { tournamentId: 'd2', tournamentName: 'D Two', tier: 'challenger', roundNumber: 1, result: 'win', setScores: [], weekScheduled: { season: 1, week: 2 } },
      ],
    };
    const merged = compactLastResults(matches);
    expect(merged.map((m) => [m.tournamentId, m.discipline])).toEqual([
      ['d1', 'doubles'],
      ['s1', 'singles'],
      ['d2', 'doubles'],
    ]);
  });

  it('maps a pre-recentDoubles API response without error (doubles simply absent)', () => {
    const matches = {
      recent: [
        { tournamentId: 's1', tournamentName: 'S One', tier: 'futures', roundNumber: 1, result: 'win', setScores: [], weekScheduled: { season: 1, week: 4 } },
      ],
    };
    const merged = compactLastResults(matches);
    expect(merged).toHaveLength(1);
    expect(merged[0].discipline).toBe('singles');
  });
});

describe('decision replacement (rewritten file replaces an accepted snapshot)', () => {
  const managerId = 'agent-m1';
  const decision = (summary, actionCount) => ({
    summary,
    actions: Array.from({ length: actionCount }, (_, i) => ({ type: 'practice', playerId: `p${i}`, days: [1] })),
  });
  const alwaysValid = () => ({ ok: true, errors: [] });

  it('the pure predicate: changed hash + pre-apply phase → replace; same hash or apply phase → keep', () => {
    expect(decisionNeedsReaccept({ phase: 'open', acceptedHash: 'aaa', currentHash: 'bbb' })).toBe(true);
    expect(decisionNeedsReaccept({ phase: 'collect', acceptedHash: 'aaa', currentHash: 'bbb' })).toBe(true);
    expect(decisionNeedsReaccept({ phase: 'ready', acceptedHash: 'aaa', currentHash: 'bbb' })).toBe(true);
    expect(decisionNeedsReaccept({ phase: 'collect', acceptedHash: 'aaa', currentHash: 'aaa' })).toBe(false);
    expect(decisionNeedsReaccept({ phase: 'apply', acceptedHash: 'aaa', currentHash: 'bbb' })).toBe(false);
    expect(decisionNeedsReaccept({ phase: 'advance', acceptedHash: 'aaa', currentHash: 'bbb' })).toBe(false);
    // A legacy snapshot without a stored hash is re-read once, pre-apply.
    expect(decisionNeedsReaccept({ phase: 'collect', acceptedHash: undefined, currentHash: 'bbb' })).toBe(true);
  });

  it('hashes content stably and differently per content', () => {
    expect(hashDecisionContent('{"a":1}')).toBe(hashDecisionContent('{"a":1}'));
    expect(hashDecisionContent('{"a":1}')).not.toBe(hashDecisionContent('{"a":2}'));
  });

  it('simulated write → accept → rewrite-before-apply race applies the REWRITTEN actions', () => {
    // Pass 1: the manager writes decision v1; the collect pass accepts it.
    const v1 = JSON.stringify(decision('original plan', 1));
    const first = reconcileDecisions({
      phase: 'open',
      managers: [managerId],
      files: { [managerId]: v1 },
      accepted: {},
      validate: alwaysValid,
    });
    expect(first).toEqual([
      expect.objectContaining({ managerId, action: 'accept', actionCount: 1, contentHash: hashDecisionContent(v1) }),
    ]);
    let accepted = {
      [managerId]: {
        receivedAt: 't0',
        contentHash: hashDecisionContent(v1),
        decision: JSON.parse(v1),
        actions: 1,
      },
    };

    // Pass 2: same file — nothing changes.
    const unchanged = reconcileDecisions({
      phase: 'collect',
      managers: [managerId],
      files: { [managerId]: v1 },
      accepted,
      validate: alwaysValid,
    });
    expect(unchanged[0].action).toBe('keep');

    // Pass 3: the manager REWRITES the file (v2) while still in collect.
    // The old runner skipped accepted managers entirely, so v1 was applied;
    // the reconciler must instruct a reaccept carrying v2.
    const v2 = JSON.stringify(decision('corrected plan', 3));
    const rewrite = reconcileDecisions({
      phase: 'collect',
      managers: [managerId],
      files: { [managerId]: v2 },
      accepted,
      validate: alwaysValid,
    });
    expect(rewrite).toEqual([
      expect.objectContaining({ managerId, action: 'reaccept', actionCount: 3, contentHash: hashDecisionContent(v2) }),
    ]);
    // Apply the instruction the way collectDecisionsOnce does.
    accepted = {
      [managerId]: {
        receivedAt: accepted[managerId].receivedAt,
        replacedAt: 't1',
        contentHash: rewrite[0].contentHash,
        decision: rewrite[0].decision,
        actions: rewrite[0].actionCount,
      },
    };
    // The applied actions are the REWRITTEN ones, not the original.
    expect(accepted[managerId].decision.summary).toBe('corrected plan');
    expect(accepted[managerId].decision.actions).toHaveLength(3);
    expect(accepted[managerId].replacedAt).toBe('t1');
  });

  it('ignores a rewrite once the phase is past collect, keeping the accepted snapshot', () => {
    const v1 = JSON.stringify(decision('original plan', 1));
    const v2 = JSON.stringify(decision('late rewrite', 2));
    const accepted = { [managerId]: { receivedAt: 't0', contentHash: hashDecisionContent(v1), decision: JSON.parse(v1), actions: 1 } };
    const results = reconcileDecisions({
      phase: 'apply',
      managers: [managerId],
      files: { [managerId]: v2 },
      accepted,
      validate: alwaysValid,
    });
    expect(results).toEqual([expect.objectContaining({ managerId, action: 'ignored-rewrite' })]);
    // The accepted snapshot is untouched — apply reads v1.
    expect(accepted[managerId].decision.summary).toBe('original plan');
  });

  it('NACKs an invalid rewrite but keeps the previously accepted snapshot', () => {
    const v1 = JSON.stringify(decision('original plan', 1));
    const accepted = { [managerId]: { receivedAt: 't0', contentHash: hashDecisionContent(v1), decision: JSON.parse(v1), actions: 1 } };
    const results = reconcileDecisions({
      phase: 'collect',
      managers: [managerId],
      files: { [managerId]: '{ not json' },
      accepted,
      validate: alwaysValid,
    });
    expect(results[0].action).toBe('nack');
    expect(results[0].errors[0].message).toContain('invalid JSON');
    expect(accepted[managerId].decision.summary).toBe('original plan');
  });

  it('runs schema validation on a rewrite and NACKs it when invalid', () => {
    const v1 = JSON.stringify(decision('original plan', 1));
    const accepted = { [managerId]: { receivedAt: 't0', contentHash: hashDecisionContent(v1), decision: JSON.parse(v1), actions: 1 } };
    const results = reconcileDecisions({
      phase: 'collect',
      managers: [managerId],
      files: { [managerId]: JSON.stringify(decision('bad rewrite', 1)) },
      accepted,
      validate: () => ({ ok: false, errors: [{ path: 'actions', message: 'nope' }] }),
    });
    expect(results[0].action).toBe('nack');
  });
});

describe('enterabilityBlockReason', () => {
  it('returns a plain reason for each blocked state, null when enterable', () => {
    expect(enterabilityBlockReason(tournament({ hasStarted: true }), 57)).toBe('entries are closed');
    expect(enterabilityBlockReason(tournament({ ageEligible: false }), 57)).toBe('not age-eligible for this band');
    expect(enterabilityBlockReason(tournament({ mainDrawEntrants: 32 }), 57)).toBe('the draw is full');
    expect(enterabilityBlockReason(tournament({ weekScheduled: { season: 1, week: 1 } }), 57)).toBe('the week has already passed');
    expect(enterabilityBlockReason(tournament(), 57)).toBeNull();
  });
});
