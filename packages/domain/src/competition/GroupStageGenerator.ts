import { GroupStage, Group } from './GroupStage';
import { SeedableEntrant } from './BracketGenerator';

/**
 * Seeds a round-robin group stage (P8b/P8c) — the group-stage analogue
 * of BracketGenerator. Splits sorted entrants into groups via SNAKE
 * seeding (seed 1 in group 1, 2 in group 2, 3 back in group 2, 4 in
 * group 1, ...), so top seeds are spread across groups and can't all
 * meet early, then generates every pairwise match within each group.
 * Pure and deterministic.
 */
export class GroupStageGenerator {
  generate<S extends string>(entrants: ReadonlyArray<SeedableEntrant<S>>, groupSize: number): GroupStage<S> {
    if (entrants.length === 0) return { groups: [] };
    const sorted = [...entrants].sort((a, b) => {
      if (a.seed === null && b.seed === null) return a.playerId.localeCompare(b.playerId);
      if (a.seed === null) return 1;
      if (b.seed === null) return -1;
      return a.seed - b.seed;
    });

    const groupCount = Math.ceil(sorted.length / groupSize);
    const buckets: S[][] = Array.from({ length: groupCount }, () => []);
    for (let i = 0; i < sorted.length; i++) {
      const round = Math.floor(i / groupCount);
      const pos = i % groupCount;
      const groupIndex = round % 2 === 0 ? pos : groupCount - 1 - pos;
      buckets[groupIndex].push(sorted[i].playerId);
    }

    const groups: Group<S>[] = buckets.map((groupEntrants) => {
      const matches = [];
      for (let i = 0; i < groupEntrants.length; i++) {
        for (let j = i + 1; j < groupEntrants.length; j++) {
          matches.push({ entrantA: groupEntrants[i], entrantB: groupEntrants[j], outcome: null });
        }
      }
      return { entrants: groupEntrants, matches };
    });

    return { groups };
  }
}
