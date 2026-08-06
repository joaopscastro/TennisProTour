import { describe, expect, it } from 'vitest';
import { CoachId, ManagerId, PlayerId } from '../shared/ids';
import { Coach } from './Coach';

describe('Coach', () => {
  it('convert() sets all fields and emits a PlayerConvertedToCoach domain event', () => {
    const coach = Coach.convert(CoachId('coach1'), ManagerId('m1'), 72, PlayerId('p1'), 'Marta Silva');

    expect(coach.id).toBe(CoachId('coach1'));
    expect(coach.managerId).toBe(ManagerId('m1'));
    expect(coach.coachRating).toBe(72);
    expect(coach.sourcePlayerId).toBe(PlayerId('p1'));
    expect(coach.sourcePlayerName).toBe('Marta Silva');

    const events = coach.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('PlayerConvertedToCoach');
    expect(events[0].payload).toMatchObject({ coachId: 'coach1', managerId: 'm1', sourcePlayerId: 'p1', coachRating: 72 });
  });

  it('pullDomainEvents drains events, returning nothing on a second call', () => {
    const coach = Coach.convert(CoachId('coach1'), ManagerId('m1'), 50, PlayerId('p1'), 'X');
    coach.pullDomainEvents();
    expect(coach.pullDomainEvents()).toHaveLength(0);
  });

  it('reconstitute() rehydrates without emitting any event', () => {
    const coach = Coach.reconstitute({
      id: CoachId('coach1'),
      managerId: ManagerId('m1'),
      coachRating: 50,
      sourcePlayerId: PlayerId('p1'),
      sourcePlayerName: 'X',
    });
    expect(coach.pullDomainEvents()).toHaveLength(0);
    expect(coach.coachRating).toBe(50);
  });
});
