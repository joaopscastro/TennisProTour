import { describe, expect, it } from 'vitest';
import { RandomSource } from '../match-simulation/MatchSimulator';
import { ALL_TOURNAMENT_TIERS } from './CompetitionTypes';
import { TournamentNameGenerator } from './TournamentNameGenerator';

class SeededRandomSource implements RandomSource {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    // Simple deterministic LCG — good enough for varied-but-repeatable
    // test sequences, same pattern used elsewhere in this codebase's
    // tests (e.g. PlayerGenerationPolicy.test.ts's SeededRandomSource).
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
    return this.state / 0x7fffffff;
  }
}

/** Real ATP/WTA/ITF tournament names (or unmistakable fragments of
 * them) that must NEVER appear in a generated name, case-insensitively
 * — this is the "no resemblance to a real tournament" half of the
 * guarantee; TournamentNameGenerator's own word-pool exclusions (no
 * Australia/France/UK/US, no "Masters"/"Grand Prix") are the other,
 * structural half. */
const REAL_TOURNAMENT_FRAGMENTS = [
  'australian open',
  'us open',
  'french open',
  'roland garros',
  'wimbledon',
  'indian wells',
  'miami open',
  'madrid open',
  'italian open',
  'internazionali',
  'cincinnati',
  'shanghai masters',
  'monte carlo',
  'monte-carlo',
  'davis cup',
  'billie jean king cup',
  'atp finals',
  'wta finals',
  'orange bowl',
  'les petits as',
];

describe('TournamentNameGenerator', () => {
  const generator = new TournamentNameGenerator();

  it('produces a non-empty name for every real tournament tier', () => {
    const random = new SeededRandomSource(1);
    for (const tier of ALL_TOURNAMENT_TIERS) {
      const generated = generator.generate(random, tier, 'hard');
      expect(generated.name.trim().length).toBeGreaterThan(0);
      // The picked host country is always surfaced structurally (P6),
      // even when the display name doesn't visibly include it.
      expect(generated.hostCountry.trim().length).toBeGreaterThan(0);
    }
  });

  it('never resembles a real ATP/WTA/ITF tournament name, across many rolls and every tier/surface combination', () => {
    let random = new SeededRandomSource(7);
    const surfaces: Array<'clay' | 'grass' | 'hard' | 'indoor'> = ['clay', 'grass', 'hard', 'indoor'];
    for (let i = 0; i < 500; i++) {
      const tier = ALL_TOURNAMENT_TIERS[i % ALL_TOURNAMENT_TIERS.length];
      const surface = surfaces[i % surfaces.length];
      const generated = generator.generate(random, tier, surface);
      const lower = generated.name.toLowerCase();
      const hostLower = generated.hostCountry.toLowerCase();
      for (const fragment of REAL_TOURNAMENT_FRAGMENTS) {
        expect(lower).not.toContain(fragment);
      }
      // The four real Grand Slam host countries must never appear —
      // this is the structural exclusion HOST_COUNTRIES relies on,
      // in the display name OR the structured host country.
      for (const banned of ['australia', 'france', 'united kingdom', 'united states']) {
        expect(lower).not.toContain(banned);
        expect(hostLower).not.toContain(banned);
      }
      // Real Grand-Slam-adjacent words this generator deliberately
      // never uses in a tier suffix.
      expect(lower).not.toContain('masters');
      expect(lower).not.toContain('grand prix');
      random = new SeededRandomSource(7 + i + 1); // vary the seed each roll
    }
  });

  it('produces varied output across repeated calls, not a single fixed string', () => {
    const random = new SeededRandomSource(3);
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(generator.generate(random, 'challenger', 'clay').name);
    }
    expect(names.size).toBeGreaterThan(5);
  });

  it('is deterministic for a given RandomSource sequence (same seed -> same name)', () => {
    const nameA = generator.generate(new SeededRandomSource(99), 'major', 'grass');
    const nameB = generator.generate(new SeededRandomSource(99), 'major', 'grass');
    expect(nameA).toEqual(nameB);
  });
});
