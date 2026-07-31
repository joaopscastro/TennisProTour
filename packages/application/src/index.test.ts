import { describe, expect, it } from 'vitest';
import * as application from './index';

describe('application package boundary', () => {
  it('exposes its main exports', () => {
    expect(application.HirePlayerUseCase).toBeDefined();
    expect(application.SimulateMatchUseCase).toBeDefined();
  });
});
