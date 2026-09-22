/**
 * The server-side twin of `apps/web/lib/matchAir.ts`: the ONE definition of
 * a match's air state the API queries share, mirroring the staggered
 * "Premiere" reveal (a match is simulated at its day tick but its result is
 * hidden until `scheduled_start_at + reveal_seconds`).
 *
 * The rule is identical to the web predicate: an undecided match is
 * `upcoming`; a decided match with no schedule is `aired`; otherwise the
 * reveal window decides. Both `DrizzlePlayerMatchesQuery` (the profile's
 * "latest results + next match" strip) and
 * `DrizzlePlayerTournamentHistoryQuery` (the profile's tournament history)
 * read `isMatchAired` from here, so one page can never contradict another.
 *
 * The signing-commitment predicate (`unfinishedCommitment.ts`) is the SQL
 * twin of this same "aired" rule — a tournament is only concluded once its
 * main-draw results have fully AIRED, not merely been decided — so display
 * and enforcement can never disagree about whether a free agent is still
 * competing.
 */
export type MatchState = 'upcoming' | 'live' | 'aired';

export interface AirGateMatch {
  winnerId: string | null;
  scheduledStartAt: Date | null;
  revealSeconds: number | null;
}

export function matchState(match: AirGateMatch, now: number = Date.now()): MatchState {
  if (match.winnerId === null) return 'upcoming';
  if (match.scheduledStartAt === null) return 'aired';
  const startMs = match.scheduledStartAt.getTime();
  if (now < startMs) return 'upcoming';
  if (now < startMs + (match.revealSeconds ?? 0) * 1000) return 'live';
  return 'aired';
}

export function isMatchAired(match: AirGateMatch, now: number = Date.now()): boolean {
  return matchState(match, now) === 'aired';
}
