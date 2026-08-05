import { describe, expect, it } from 'vitest';
import * as application from './index';

describe('application package boundary', () => {
  it('exposes its main exports', () => {
    expect(application.ClaimTalentPoolCandidateUseCase).toBeDefined();
    expect(application.SimulateMatchUseCase).toBeDefined();
  });
});
