import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '../shared/ids';
import { Player } from './Player';
import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: {
      serve: Skill.of(30),
      forehand: Skill.of(30),
      backhand: Skill.of(30),
      volley: Skill.of(30),
    },
    physical: {
      speed: Skill.of(30),
      stamina: Skill.of(30),
      strength: Skill.of(30),
    },
    mental: {
      consistency: Skill.of(30),
      clutch: Skill.of(30),
    },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

describe('Player', () => {
  it('hires a player in the youth stage with no fatigue and emits PlayerHired', () => {
    const managerId = ManagerId('m1');
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), managerId);

    expect(player.stage).toBe('youth');
    expect(player.fatigue).toBe(0);
    expect(player.managerId).toBe(managerId);
    expect(player.isRetired()).toBe(false);

    const events = player.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PlayerHired',
      payload: { playerId: player.id, managerId },
    });
    expect(events[0].occurredAt).toBeInstanceOf(Date);
  });

  it('pullDomainEvents drains events so a second call returns nothing', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.pullDomainEvents();
    expect(player.pullDomainEvents()).toHaveLength(0);
  });

  it('clamps match fatigue to [0, 100]', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.applyMatchFatigue(150);
    expect(player.fatigue).toBe(100);

    player.recoverFatigue(1000);
    expect(player.fatigue).toBe(0);
  });

  it('applies training by replacing attributes, unless the player is retired', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const trained = startingAttributes();

    player.applyTraining('clay', trained);
    expect(player.attributes).toBe(trained);
  });

  it('throws when training a retired player', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52, startingAttributes(), ManagerId('m1'));
    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());

    expect(() => player.applyTraining('clay', startingAttributes())).toThrow();
  });

  it('advanceWeek updates age, stage, and attributes', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 100, startingAttributes(), ManagerId('m1'));
    const nextAttributes = startingAttributes();

    player.advanceWeek(101, 'youth', nextAttributes);

    expect(player.ageInWeeks).toBe(101);
    expect(player.stage).toBe('youth');
    expect(player.attributes).toBe(nextAttributes);
  });

  it('emits PlayerRetired exactly on the transition into retired, not on every advance while already retired', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52 - 1, startingAttributes(), ManagerId('m1'));

    player.advanceWeek(38 * 52, 'retired', startingAttributes());
    player.pullDomainEvents(); // drain PlayerHired + PlayerRetired from this call

    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());
    const eventsAfterSecondAdvance = player.pullDomainEvents();

    expect(eventsAfterSecondAdvance).toHaveLength(0);
  });

  it('releaseFromManager sets managerId to null', () => {
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));

    player.releaseFromManager();

    expect(player.managerId).toBeNull();
  });
});
