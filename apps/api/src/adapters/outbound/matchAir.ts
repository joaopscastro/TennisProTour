/**
 * The server-side twin of `apps/web/lib/matchAir.ts`: the ONE definition of
 * "has this match aired" the API queries share, mirroring the staggered
 * "Premiere" reveal (a match is simulated at its day tick but its result is
 * hidden until `scheduled_start_at + reveal_seconds`).
 *
 * Both `DrizzlePlayerMatchesQuery` (the profile's "latest results + next
 * match" strip) and `DrizzlePlayerTournamentHistoryQuery` (the profile's
 * tournament history) must agree: before this helper, the history counted a
 * decided-but-not-yet-aired loss as "Lost" while the profile strip still
 * showed that same match as "Next up" — one page contradicting itself. The
 * Scouting "competing" flag had the mirror bug: it used `winner_id IS NULL`,
 * so a free agent whose match was already decided but still revealing was
 * not flagged as competing.
 */
export interface AirGateMatch {
  winnerId: string | null;
  scheduledStartAt: Date | null;
  revealSeconds: number | null;
}

export function isMatchAired(match: AirGateMatch, now: number = Date.now()): boolean {
  if (match.winnerId === null) return false;
  if (match.scheduledStartAt === null) return true;
  return now >= match.scheduledStartAt.getTime() + (match.revealSeconds ?? 0) * 1000;
}
