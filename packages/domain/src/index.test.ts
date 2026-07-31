import { describe, expect, it } from 'vitest';
import * as domain from './index';

describe('domain package boundary', () => {
  it('exposes its main exports', () => {
    expect(domain.Player).toBeDefined();
    expect(domain.PlayerAgingService).toBeDefined();
    expect(domain.PlayerAttributes).toBeDefined();
    expect(domain.Skill).toBeDefined();
    expect(domain.Tournament).toBeDefined();
    expect(domain.StatisticalMatchSimulator).toBeDefined();
    expect(domain.StandardRankingPointsTable).toBeDefined();
    expect(domain.compareGameWeek).toBeDefined();
  });
});
