import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cosmeticById, MANAGER_COSMETICS, ownedBadgeFor } from './ManagerCosmetics';

describe('ManagerCosmetics catalog', () => {
  it('offers all three cosmetic kinds with unique ids and positive XP prices', () => {
    const ids = MANAGER_COSMETICS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(MANAGER_COSMETICS.map((item) => item.kind));
    expect(kinds).toEqual(new Set(['banner', 'badge', 'celebration']));
    for (const item of MANAGER_COSMETICS) {
      expect(item.price).toBeGreaterThan(0);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.glyph.length).toBeGreaterThan(0);
    }
  });

  it('is presentation-only — every item carries no effect-bearing field', () => {
    // The shape IS the guarantee: exactly these six keys, none of which
    // any game system reads for an effect (see the module doc comment's
    // explicit statement of what was deliberately rejected).
    for (const item of MANAGER_COSMETICS) {
      expect(Object.keys(item).sort()).toEqual(['description', 'glyph', 'id', 'kind', 'name', 'price'].sort());
    }
  });

  it('resolves items by id and refuses unknown ids', () => {
    expect(cosmeticById('badge-star')?.kind).toBe('badge');
    expect(cosmeticById('not-a-real-item')).toBeNull();
  });

  it('picks the highest-priced owned badge for the leaderboard, ignoring other kinds and unknown ids', () => {
    expect(ownedBadgeFor([])).toBeNull();
    expect(ownedBadgeFor(['banner-classic', 'celebration-confetti'])).toBeNull();
    expect(ownedBadgeFor(['badge-star'])?.id).toBe('badge-star');
    // Highest price wins regardless of input order.
    expect(ownedBadgeFor(['badge-star', 'badge-crown', 'badge-comet'])?.id).toBe('badge-crown');
    expect(ownedBadgeFor(['ghost-item', 'badge-star', 'not-a-cosmetic'])?.id).toBe('badge-star');
  });
});

describe('cosmetics can never touch the simulation, training or rankings (Batch 4B, F2)', () => {
  // A real structural guard, not a comment: the load-bearing competitive
  // modules are read as source and asserted to contain no reference to
  // cosmetics at all. If a future change wires a cosmetic into one of
  // them, this fails — which is exactly the review trigger design
  // principle #1 requires.
  const domainSrc = join(__dirname, '..');
  const guardedFiles = [
    join(domainSrc, 'match-simulation', 'StatisticalMatchSimulator.ts'),
    join(domainSrc, 'player', 'TrainingPolicy.ts'),
    join(domainSrc, 'player', 'Player.ts'),
    join(domainSrc, 'player', 'PlayerDevelopmentPolicy.ts'),
    join(domainSrc, 'ranking', 'RankingCalculationService.ts'),
    join(domainSrc, 'ranking', 'RankingLedgerEntry.ts'),
    join(domainSrc, 'competition', 'Tournament.ts'),
  ];

  it('no simulator, training, development, ranking or tournament module references cosmetics', () => {
    for (const file of guardedFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source.toLowerCase()).not.toContain('cosmetic');
    }
  });
});
