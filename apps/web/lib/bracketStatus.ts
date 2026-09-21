/**
 * Round status + collapse for the tournament bracket — pure so the
 * "undecided round reads as Decided" bug can't come back unnoticed.
 *
 * The original defect: `matchAirState` returns 'aired' for a match that
 * has NOT been decided (there is no reveal window to wait for), so a
 * round where nothing had been played satisfied "every match aired" and
 * was labelled "Decided" and collapsed into fake "X def. Y" rows — some
 * of which linked to replays that were never written. The rule below
 * makes "aired" count only for DECIDED matches, so an un-played round is
 * always "Upcoming".
 */
export type AirState = 'upcoming' | 'live' | 'aired';

export interface DisplayMatchAir {
  decided: boolean;
  airState: AirState;
}

export type RoundStatus = 'Upcoming' | 'In progress' | 'Scheduled' | 'Airing' | 'Decided';

/** A round's badge. Read together with the "N of M played" subtitle. */
export function roundStatus(generated: boolean, matches: ReadonlyArray<DisplayMatchAir>): RoundStatus {
  if (!generated || matches.length === 0) return 'Upcoming';
  const decided = matches.filter((m) => m.decided).length;
  if (decided === 0) return 'Upcoming';
  if (decided < matches.length) return 'In progress';
  // Every match is played. "Decided" requires every result to have AIRED;
  // "aired"/"live" are only meaningful for a decided match.
  const aired = matches.filter((m) => m.decided && m.airState === 'aired').length;
  if (aired === matches.length) return 'Decided';
  const anyAiredOrLive = matches.some((m) => m.decided && m.airState !== 'upcoming');
  return anyAiredOrLive ? 'Airing' : 'Scheduled';
}

/** A round is collapsed into its compact result list only once it is
 * genuinely Decided — every match played AND aired. */
export function roundCollapsed(generated: boolean, matches: ReadonlyArray<DisplayMatchAir>): boolean {
  return generated && matches.length > 0 && matches.every((m) => m.decided && m.airState === 'aired');
}
