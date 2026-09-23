/**
 * Round status + collapse for the tournament bracket — pure so the
 * "undecided round reads as Decided" bug can't come back unnoticed.
 *
 * The original defect: an un-played round satisfied "every match aired"
 * and was labelled "Decided" and collapsed into fake "X def. Y" rows —
 * some of which linked to replays that were never written. `matchState`
 * now reports an undecided match as 'upcoming' (never 'aired'), and the
 * rule below additionally counts "aired" only over DECIDED matches, so
 * an un-played round is always "Upcoming".
 *
 * A SECOND defect (found after the first fix shipped): the round's badge
 * was derived from the reveal state but its subtitle ("8 of 8 played")
 * counted decided matches. A round whose results were all simulated but
 * still revealing therefore read "Airing — 8 of 8 played" while its own
 * cards said "Starts in 0:14". `roundSubtitle` now derives from the SAME
 * per-match air states the cards use, so the header can never contradict
 * the cards beneath it.
 */
import { matchState, type AirState } from './matchAir';

export type { AirState };

export interface DisplayMatchAir {
  decided: boolean;
  airState: AirState;
}

export type RoundStatus = 'Upcoming' | 'In progress' | 'Scheduled' | 'Airing' | 'Decided';

/** A round's badge. Read together with `roundSubtitle`. */
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

/** A round's subtitle, derived from the SAME air states as its cards, so
 * the header and the cards always agree. */
export function roundSubtitle(generated: boolean, matches: ReadonlyArray<DisplayMatchAir>): string {
  const total = matches.length;
  const plural = total === 1 ? '' : 'es';
  if (!generated || total === 0) return `${total} match${plural} scheduled`;
  const decided = matches.filter((m) => m.decided).length;
  if (decided === 0) return `${total} match${plural} scheduled`;
  if (decided < total) return `${decided} of ${total} played`;
  const aired = matches.filter((m) => m.decided && m.airState === 'aired').length;
  if (aired === total) return `${total} of ${total} played`;
  const revealed = matches.filter((m) => m.decided && m.airState !== 'upcoming').length;
  if (revealed === 0) return 'All played — results air shortly';
  return `${revealed} of ${total} results revealed`;
}

/** A round is collapsed into its compact result list only once it is
 * genuinely Decided — every match played AND aired. */
export function roundCollapsed(generated: boolean, matches: ReadonlyArray<DisplayMatchAir>): boolean {
  return generated && matches.length > 0 && matches.every((m) => m.decided && m.airState === 'aired');
}

export interface HeadlineMatch {
  decided: boolean;
  scheduledStartAt: string | null;
  revealSeconds: number;
}

export interface HeadlineRound {
  roundNumber: number;
  label: string;
  generated: boolean;
  matches: ReadonlyArray<HeadlineMatch>;
}

/**
 * The tournament hero's one-line status, derived from the SAME per-round
 * `roundStatus` (which itself reads the one `matchState` predicate) the
 * round badges use — never a second notion of "under way".
 *
 * The bug this fixes: the hero used to pick "the first generated round with
 * an undecided match" and call it "in progress", so a final that had not
 * begun read "Final in progress" while its own badge read "Upcoming" — two
 * labels on one page disagreeing about whether the final was under way.
 * Here a round with nothing decided yet is `Upcoming`, so it can never be
 * reported as in progress.
 */
export function tournamentHeadline(
  rounds: ReadonlyArray<HeadlineRound>,
  totalRounds: number,
  now: number = Date.now(),
): string {
  const generated = rounds.filter((r) => r.generated);
  if (generated.length === 0) return 'Awaiting entrants';
  const statusOf = (r: HeadlineRound) =>
    roundStatus(r.generated, r.matches.map((m) => ({ decided: m.decided, airState: matchState(m, now) })));

  // A round genuinely under way (some match played, not all aired).
  const active = generated.find((r) => statusOf(r) === 'In progress');
  if (active) return `${active.label} in progress`;
  // Any round fully played but not fully aired — its results are airing.
  if (generated.some((r) => statusOf(r) === 'Airing' || statusOf(r) === 'Scheduled')) return 'Results airing';

  const last = generated[generated.length - 1];
  const lastStatus = statusOf(last);
  if (last.roundNumber === totalRounds && lastStatus === 'Decided') return 'Tournament complete';
  // The last generated round hasn't begun — say so (never "in progress"),
  // matching its own "Upcoming" badge.
  if (lastStatus === 'Upcoming') return `${last.label} upcoming`;
  return `${last.label} complete`;
}
