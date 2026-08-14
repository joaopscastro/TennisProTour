import { PlayerId } from '../shared/ids';
import { BracketRound } from './CompetitionTypes';

type BracketMatch<S extends string> = BracketRound<S>['matches'][number];

/**
 * Any power-of-two bracket this generator can seed. Deliberately WIDER
 * than `DrawSize` (16/32/64/128): a QUALIFYING field is a real bracket
 * too, and a small one is legitimately smaller than any main draw the
 * game offers (e.g. 8 players contesting a 16-draw challenger's 2
 * reserved slots). Widening the parameter is backwards-compatible —
 * every existing caller passes a `DrawSize`, which is assignable here.
 */
export type BracketSize = number;

/**
 * The minimal entrant shape a bracket seed needs — a slot id plus an
 * optional seed. Generic over the slot id `S` so the SAME generator
 * seeds a singles draw (`S = PlayerId`, the default) and a doubles draw
 * (`S = PairId`): the field is named `playerId` to stay structurally
 * compatible with `TournamentEntrant` (so every existing singles call
 * site passes its `TournamentEntrant[]` unchanged), but for a doubles
 * draw `S = PairId` and `playerId` actually carries the PAIR's id.
 */
export interface SeedableEntrant<S extends string = PlayerId> {
  playerId: S;
  seed: number | null;
}

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
  generate<S extends string>(entrants: ReadonlyArray<SeedableEntrant<S>>, drawSize: BracketSize): BracketRound<S>[] {
    if (entrants.length > drawSize) {
      throw new Error(`Cannot seed ${entrants.length} entrants into a draw size of ${drawSize}`);
    }

    const seeded = this.orderBySeed(entrants);
    const slots = BracketGenerator.seedSlotOrder(drawSize);

    const matches: BracketMatch<S>[] = [];
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

  /**
   * Pairs the winners of a completed round into the next round: winner
   * of match 0 vs winner of match 1, winner of match 2 vs winner of
   * match 3, and so on.
   *
   * Round 1 needs special handling here that later rounds don't: a bye
   * never gets a match entry at all (see generate()), so a bye
   * recipient's "win" can't be read off completedRound.matches — it has
   * to be reconstructed from the same seed slot order used to build
   * round 1 in the first place, which is why this method takes the
   * same entrants + drawSize generate() does. From round 2 onward,
   * every entrant already has a real recorded match (byes only ever
   * happen in round 1), so pairing is just reading winners off in
   * match order, exactly as round 1 would be if there were no byes.
   */
  generateNextRound<S extends string>(
    completedRound: BracketRound<S>,
    entrants: ReadonlyArray<SeedableEntrant<S>>,
    drawSize: BracketSize,
  ): BracketRound<S> {
    const winners =
      completedRound.roundNumber === 1
        ? this.round1WinnersInBracketOrder(completedRound, entrants, drawSize)
        : completedRound.matches.map((m) => this.requireWinner(m));

    const matches: BracketMatch<S>[] = [];
    for (let i = 0; i < winners.length; i += 2) {
      matches.push({ entrantA: winners[i], entrantB: winners[i + 1], outcome: null });
    }

    return { roundNumber: completedRound.roundNumber + 1, matches };
  }

  private round1WinnersInBracketOrder<S extends string>(
    completedRound: BracketRound<S>,
    entrants: ReadonlyArray<SeedableEntrant<S>>,
    drawSize: BracketSize,
  ): S[] {
    const seeded = this.orderBySeed(entrants);
    const slots = BracketGenerator.seedSlotOrder(drawSize);
    const winners: S[] = [];

    for (let i = 0; i < slots.length; i += 2) {
      const entrantA = this.entrantForSlot(seeded, slots[i]);
      const entrantB = this.entrantForSlot(seeded, slots[i + 1]);

      if (entrantA && entrantB) {
        const match = completedRound.matches.find(
          (m) => m.entrantA === entrantA.playerId && m.entrantB === entrantB.playerId,
        );
        if (!match) {
          throw new Error(`No completed match found for seeds ${slots[i]} vs ${slots[i + 1]}`);
        }
        winners.push(this.requireWinner(match));
      } else if (entrantA) {
        winners.push(entrantA.playerId); // bye: carries over as if they'd won
      } else if (entrantB) {
        winners.push(entrantB.playerId); // bye: carries over as if they'd won
      }
      // Neither slot filled: nobody to carry over — only possible with
      // very few entrants relative to the draw size.
    }

    return winners;
  }

  private requireWinner<S extends string>(match: BracketRound<S>['matches'][number]): S {
    if (!match.outcome) {
      throw new Error('Cannot generate the next round: a match has no recorded outcome yet');
    }
    return match.outcome.winner;
  }

  private orderBySeed<S extends string>(entrants: ReadonlyArray<SeedableEntrant<S>>): SeedableEntrant<S>[] {
    // Unseeded entrants (seed === null) must still sort deterministically
    // and independent of the input array's order: this array is
    // reconstructed from a fresh repository read every time a later
    // round is generated, and that read order does not necessarily match
    // the order entrants were in when round 1 was originally seeded. If
    // two reconstructions of the same entrant set disagree on order, the
    // seed-slot pairing used to look up round 1's winners no longer
    // matches any pairing that actually played, and generation fails.
    return [...entrants].sort((a, b) => {
      if (a.seed === null && b.seed === null) return a.playerId.localeCompare(b.playerId);
      if (a.seed === null) return 1;
      if (b.seed === null) return -1;
      return a.seed - b.seed;
    });
  }

  private entrantForSlot<S extends string>(seeded: SeedableEntrant<S>[], slotSeed: number): SeedableEntrant<S> | null {
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
