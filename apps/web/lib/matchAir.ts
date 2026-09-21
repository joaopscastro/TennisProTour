/**
 * The ONE air-state predicate for a match's staggered "Premiere" reveal.
 *
 * A match's result is simulated server-side the moment its day tick runs,
 * but it is not shown to the viewer until its scheduled reveal window has
 * elapsed (see docs/day-tick-and-scheduling.md / matchSchedule.ts): the
 * bracket hides the score behind a "starts in X" countdown, and the replay
 * page hides it behind a "Premieres at …" overlay.
 *
 * Before this existed, the bracket computed the state its own way
 * (`matchAirState` inside tournaments/[id]/page.tsx) while the replay page
 * assumed every match had already premiered — so a bracket could show a
 * final score for a match whose replay still said "PREMIERES AT 14:05"
 * (the two views disagreed on whether the match had aired). Both now read
 * this single function.
 *
 * `decided` is part of the input on purpose: an UNDECIDED match has no
 * reveal window to wait for and is treated as "aired" (there is nothing to
 * hide), which is also why `roundStatus`/`roundCollapsed` count "aired"
 * only over decided matches.
 */
export type AirState = 'upcoming' | 'live' | 'aired';

export interface AirableMatch {
  /** The match has a recorded outcome (winner/loser) server-side. */
  decided: boolean;
  /** The staggered reveal start (ISO), or null before it is simulated. */
  scheduledStartAt: string | null;
  /** Real-time seconds the reveal occupies (0 = not scheduled). */
  revealSeconds: number;
}

export function matchAirState(m: AirableMatch, now: number = Date.now()): AirState {
  if (!m.decided || !m.scheduledStartAt) return 'aired';
  const startMs = new Date(m.scheduledStartAt).getTime();
  if (Number.isNaN(startMs)) return 'aired';
  if (now < startMs) return 'upcoming';
  if (now < startMs + m.revealSeconds * 1000) return 'live';
  return 'aired';
}

/** True once the match's result is viewable everywhere (bracket + replay). */
export function hasAired(m: AirableMatch, now: number = Date.now()): boolean {
  return matchAirState(m, now) === 'aired';
}
