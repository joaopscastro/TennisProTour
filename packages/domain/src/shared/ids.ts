/** Branded string IDs so a PlayerId can never be passed where a
 * TournamentId is expected, without needing full value-object
 * wrapper classes for something this simple. */
export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type TournamentId = string & { readonly __brand: 'TournamentId' };
export type ManagerId = string & { readonly __brand: 'ManagerId' };
export type MatchId = string & { readonly __brand: 'MatchId' };

export function asPlayerId(value: string): PlayerId {
  return value as PlayerId;
}

export function asTournamentId(value: string): TournamentId {
  return value as TournamentId;
}

export function asManagerId(value: string): ManagerId {
  return value as ManagerId;
}

export function asMatchId(value: string): MatchId {
  return value as MatchId;
}

/** The in-game clock's unit of time. Every domain rule (aging,
 * tournament scheduling) is expressed in weeks, never wall-clock
 * dates, so game-speed servers can compress or stretch real time
 * without touching domain logic. */
export class GameWeek {
  private constructor(private readonly weekNumber: number) {}

  static of(weekNumber: number): GameWeek {
    if (!Number.isInteger(weekNumber) || weekNumber < 0) {
      throw new Error(`Invalid GameWeek: ${weekNumber}`);
    }
    return new GameWeek(weekNumber);
  }

  next(): GameWeek {
    return new GameWeek(this.weekNumber + 1);
  }

  toNumber(): number {
    return this.weekNumber;
  }

  isBefore(other: GameWeek): boolean {
    return this.weekNumber < other.weekNumber;
  }

  equals(other: GameWeek): boolean {
    return this.weekNumber === other.weekNumber;
  }
}
