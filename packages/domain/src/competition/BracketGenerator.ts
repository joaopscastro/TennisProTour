import { BracketRound, DrawSize, TournamentEntrant } from './CompetitionTypes';

type BracketMatch = BracketRound['matches'][number];

/**
 * Seeds a single-elimination draw: standard "1 vs lowest remaining
 * seed" bracket placement (the same slot order real tournament draws
 * use — 1v16, 8v9, 4v13, ... for a 16-draw), with byes given to the
 * top seeds when there are fewer entrants than the draw size. A pure,
 * stateless domain service — same shape as PlayerAgingService — with
 * no I/O, fully unit-testable.
 *
 * Only produces round 1: pairing for later rounds depends on winners
 * that aren't known yet, so those get added later via
 * Tournament.addRound() as earlier rounds complete.
 */
export class BracketGenerator {
  generate(entrants: ReadonlyArray<TournamentEntrant>, drawSize: DrawSize): BracketRound[] {
    if (entrants.length > drawSize) {
      throw new Error(`Cannot seed ${entrants.length} entrants into a draw size of ${drawSize}`);
    }

    const seeded = this.orderBySeed(entrants);
    const slots = BracketGenerator.seedSlotOrder(drawSize);

    const matches: BracketMatch[] = [];
    for (let i = 0; i < slots.length; i += 2) {
      const entrantA = this.entrantForSlot(seeded, slots[i]);
      const entrantB = this.entrantForSlot(seeded, slots[i + 1]);

      if (entrantA && entrantB) {
        matches.push({ entrantA: entrantA.playerId, entrantB: entrantB.playerId, outcome: null });
      }
      // Exactly one real entrant: that entrant has a bye and advances
      // without a round-1 match, so no match is recorded for this slot
      // pair. Neither slot filled: only possible with very few
      // entrants relative to the draw size — also no match.
    }

    return [{ roundNumber: 1, matches }];
  }

  private orderBySeed(entrants: ReadonlyArray<TournamentEntrant>): TournamentEntrant[] {
    return [...entrants].sort((a, b) => {
      if (a.seed === null && b.seed === null) return 0;
      if (a.seed === null) return 1;
      if (b.seed === null) return -1;
      return a.seed - b.seed;
    });
  }

  private entrantForSlot(seeded: TournamentEntrant[], slotSeed: number): TournamentEntrant | null {
    return slotSeed <= seeded.length ? seeded[slotSeed - 1] : null;
  }

  /** Recursively doubles the standard bracket slot order: [1] -> [1,2]
   * -> [1,4,2,3] -> [1,8,4,5,2,7,3,6] -> ... so seed 1 always meets the
   * lowest remaining seed, and top seeds can only meet in later rounds. */
  private static seedSlotOrder(drawSize: number): number[] {
    let order = [1];
    while (order.length < drawSize) {
      const n = order.length;
      const next: number[] = [];
      for (const seed of order) {
        next.push(seed, 2 * n + 1 - seed);
      }
      order = next;
    }
    return order;
  }
}
