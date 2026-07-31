/**
 * Branded primitive types so a PlayerId can never be accidentally passed
 * where a TournamentId is expected, without needing full value-object
 * ceremony for simple identifiers.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PlayerId = Brand<string, 'PlayerId'>;
export type ManagerId = Brand<string, 'ManagerId'>;
export type TournamentId = Brand<string, 'TournamentId'>;
export type MatchId = Brand<string, 'MatchId'>;

export const PlayerId = (value: string): PlayerId => value as PlayerId;
export const ManagerId = (value: string): ManagerId => value as ManagerId;
export const TournamentId = (value: string): TournamentId => value as TournamentId;
export const MatchId = (value: string): MatchId => value as MatchId;

/** A single point in in-game time. Kept as a value object so the domain
 * never depends on wall-clock Date directly (see ClockPort). */
export interface GameWeek {
  readonly season: number;
  readonly week: number;
}

export function compareGameWeek(a: GameWeek, b: GameWeek): number {
  if (a.season !== b.season) return a.season - b.season;
  return a.week - b.week;
}
