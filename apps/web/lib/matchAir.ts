/**
 * The ONE air-state predicate for a match's staggered "Premiere" reveal.
 *
 * A match's result is simulated server-side the moment its day tick runs,
 * but it is not shown to the viewer until its scheduled reveal window has
 * elapsed (see docs/day-tick-and-scheduling.md / matchSchedule.ts): the
 * bracket hides the score behind a "starts in X" countdown, and the replay
 * page hides it behind a "Premieres at …" overlay.
 *
 * `matchState` is the single source of truth: `upcoming | live | aired`,
 * derived from the match's own schedule (`scheduledStartAt` + `revealSeconds`
 * vs `now`). Every view — the bracket's match cards, its round summaries, the
 * champion banner / title celebration, the replay page and the replay player —
 * must consume THIS, never re-derive its own. Before this was the single
 * entry point, four consumers drifted apart and shipped a champion
 * celebration while the final was still live, a replay that said "Premiering
 * now · Result already decided" with every control disabled, and a round
 * header that disagreed with its own cards.
 *
 * An UNDECIDED match is `upcoming` (there is no result to reveal yet); a
 * decided match with no schedule is `aired` (nothing to hide behind). The
 * server-side twin is `apps/api/src/adapters/outbound/matchAir.ts`; both
 * implement the identical rule.
 */
export type MatchState = 'upcoming' | 'live' | 'aired';

/** @deprecated Use `MatchState`. Kept so existing imports keep working. */
export type AirState = MatchState;

export interface AirableMatch {
  /** The match has a recorded outcome (winner/loser) server-side. */
  decided: boolean;
  /** The staggered reveal start (ISO), or null before it is simulated. */
  scheduledStartAt: string | null;
  /** Real-time seconds the reveal occupies (0 = not scheduled). */
  revealSeconds: number;
}

/** The ONE match state. Consume this everywhere; never recompute. */
export function matchState(m: AirableMatch, now: number = Date.now()): MatchState {
  if (!m.decided) return 'upcoming';
  if (!m.scheduledStartAt) return 'aired';
  const startMs = new Date(m.scheduledStartAt).getTime();
  if (Number.isNaN(startMs)) return 'aired';
  if (now < startMs) return 'upcoming';
  if (now < startMs + m.revealSeconds * 1000) return 'live';
  return 'aired';
}

/** Back-compat alias for `matchState` (the name every existing caller uses). */
export function matchAirState(m: AirableMatch, now: number = Date.now()): MatchState {
  return matchState(m, now);
}

/** True once the match's result is viewable everywhere. */
export function hasAired(m: AirableMatch, now: number = Date.now()): boolean {
  return matchState(m, now) === 'aired';
}

/**
 * Whether the champion should be revealed / a title celebrated. This is
 * ONLY true once the FINAL has AIRED — a decided-but-still-revealing final
 * must not crown anyone (the exact bug: a "FIRST TITLE" popup and a
 * "lifts the trophy" hero fired while the final still read "Live now").
 */
export function championRevealed(m: AirableMatch, now: number = Date.now()): boolean {
  return matchState(m, now) === 'aired';
}

/**
 * Whether the replay scoreboard should show the FULL final score rather than
 * a row of "–". True once playback has finished, and also — once the match
 * has AIRED — before playback starts: by then the result is already public on
 * the bracket, so a dashes-only scoreboard contradicts the "Aired … Result
 * already decided" overlay. A pre-premiere match still reveals nothing.
 */
export function replayScoreVisible(finished: boolean, airState: MatchState, started: boolean): boolean {
  return finished || (airState === 'aired' && !started);
}

/** The replay overlay's headline + note. The note is ONLY "Result already
 * decided" once the match has aired: never simultaneously claiming a
 * live/upcoming premiere and a decided result is the exact contradiction
 * ("PREMIERING NOW · RESULT ALREADY DECIDED") this pins. */
export function replayOverlayCopy(airState: MatchState, premiereTime: string): { headline: string; note: string } {
  if (airState === 'aired') return { headline: `Aired at ${premiereTime}`, note: 'Result already decided' };
  if (airState === 'live') return { headline: 'Premiering now', note: 'The result is unfolding point by point' };
  return { headline: `Premieres at ${premiereTime}`, note: 'The result is simulated — it reveals here at the premiere' };
}

/** The label for the set currently being revealed: "PREMIERE" only before
 * the match airs. Once aired (or while live) it must not claim a premiere. */
export function activeSetTag(airState: MatchState): string | null {
  return airState === 'upcoming' ? 'PREMIERE' : null;
}

/**
 * Every bracket draw's match row — main draw, qualifying draw, doubles main
 * and doubles qualifying — carries the same shape: an optional outcome plus
 * its reveal schedule. This is the ONE adapter from a DTO row to
 * `matchState`, so a panel cannot accidentally invent its own "is this
 * aired" test and leak a score the replay still calls "Premieres at".
 */
export interface DtoAirableMatch {
  /** The DTO's outcome object, or null before the match is decided. */
  outcome: unknown | null;
  /** The staggered reveal start, if the match has been simulated. */
  scheduledStartAt?: string | null;
  /** Real-time seconds the reveal occupies (absent = 0). */
  revealSeconds?: number | null;
}

export function matchAirStateForDto(m: DtoAirableMatch, now: number = Date.now()): MatchState {
  return matchState(
    {
      decided: m.outcome != null,
      scheduledStartAt: m.scheduledStartAt ?? null,
      revealSeconds: m.revealSeconds ?? 0,
    },
    now,
  );
}
