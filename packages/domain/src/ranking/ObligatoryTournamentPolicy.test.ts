import { describe, expect, it } from 'vitest';
import {
  computeObligatoryZeroEntries,
  DIRECT_ACCEPTANCE_CUTOFF,
  HeldObligatoryTournament,
  isEligibleForDirectAcceptance,
} from './ObligatoryTournamentPolicy';
import { GameWeek, PlayerId, TournamentId } from '../shared/ids';

const player = PlayerId('p1');

function held(id: string, overrides: Partial<HeldObligatoryTournament> = {}): HeldObligatoryTournament {
  return {
    tournamentId: TournamentId(id),
    tier: 'major',
    weekHeld: { season: 1, week: 1 } as GameWeek,
    ...overrides,
  };
}

describe('isEligibleForDirectAcceptance', () => {
  it('is true at and above the cutoff rank, false below it or when unranked', () => {
    expect(isEligibleForDirectAcceptance(1)).toBe(true);
    expect(isEligibleForDirectAcceptance(DIRECT_ACCEPTANCE_CUTOFF)).toBe(true);
    expect(isEligibleForDirectAcceptance(DIRECT_ACCEPTANCE_CUTOFF + 1)).toBe(false);
    expect(isEligibleForDirectAcceptance(null)).toBe(false);
  });
});

describe('computeObligatoryZeroEntries', () => {
  it('owes one 0-point obligatory entry per unplayed held obligatory event, for an eligible player', () => {
    const zeros = computeObligatoryZeroEntries({
      playerId: player,
      currentSeniorRank: 5,
      heldObligatory: [held('slam-a'), held('slam-b')],
      playedTournamentIds: new Set([]),
    });

    expect(zeros).toHaveLength(2);
    for (const z of zeros) {
      expect(z.points).toBe(0);
      expect(z.obligatory).toBe(true);
      expect(z.tier).toBe('major');
      expect(z.ageBand).toBeNull();
      expect(z.playerId).toBe(player);
    }
    expect(zeros.map((z) => z.tournamentId).sort()).toEqual([TournamentId('slam-a'), TournamentId('slam-b')]);
  });

  it('never produces a zero for an event the player actually played (regardless of result)', () => {
    const zeros = computeObligatoryZeroEntries({
      playerId: player,
      currentSeniorRank: 1,
      heldObligatory: [held('slam-a'), held('slam-b')],
      playedTournamentIds: new Set([TournamentId('slam-a')]),
    });

    expect(zeros).toHaveLength(1);
    expect(zeros[0].tournamentId).toBe(TournamentId('slam-b'));
  });

  it('owes nothing for a player below the direct-acceptance cutoff', () => {
    expect(
      computeObligatoryZeroEntries({
        playerId: player,
        currentSeniorRank: DIRECT_ACCEPTANCE_CUTOFF + 1,
        heldObligatory: [held('slam-a')],
        playedTournamentIds: new Set([]),
      }),
    ).toEqual([]);
  });

  it('owes nothing for an unranked player', () => {
    expect(
      computeObligatoryZeroEntries({
        playerId: player,
        currentSeniorRank: null,
        heldObligatory: [held('slam-a')],
        playedTournamentIds: new Set([]),
      }),
    ).toEqual([]);
  });

  it('dates each zero to the week the event was held, so it ages out on the same schedule a real result would', () => {
    const zeros = computeObligatoryZeroEntries({
      playerId: player,
      currentSeniorRank: 3,
      heldObligatory: [held('slam-a', { weekHeld: { season: 2, week: 30 } as GameWeek })],
      playedTournamentIds: new Set([]),
    });

    expect(zeros[0].weekEarned).toEqual({ season: 2, week: 30 });
  });

  it('is idempotent: feeding the produced zeros back in as played ids yields no further zeros', () => {
    const input = {
      playerId: player,
      currentSeniorRank: 2,
      heldObligatory: [held('slam-a'), held('slam-b')],
      playedTournamentIds: new Set<ReturnType<typeof TournamentId>>([]),
    };
    const first = computeObligatoryZeroEntries(input);
    const second = computeObligatoryZeroEntries({
      ...input,
      playedTournamentIds: new Set(first.map((z) => z.tournamentId)),
    });
    expect(second).toEqual([]);
  });
});
