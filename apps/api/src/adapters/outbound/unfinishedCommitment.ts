import { SQL, sql } from 'drizzle-orm';
import { AnyColumn } from 'drizzle-orm';
import { PlayerId } from '@tennis-manager/domain';

/**
 * The ONE definition of "this player still has an unfinished tournament
 * commitment" — the deliberate design rule that a free agent cannot be
 * signed while they are committed to a tournament that has not
 * concluded. Every place that needs the rule reads it from this module:
 * the atomic claim's conditional UPDATE (DrizzleTalentClaimAdapter,
 * race-safe) and the Scouting pool's per-player read
 * (DrizzlePlayerMatchesQuery.unfinishedCommitmentByPlayer), so the
 * client's disabled-Sign state and the server's refusal can never
 * disagree.
 *
 * "Unfinished" here means exactly "the tournament's MAIN draw has not
 * been played out AND fully AIRED" — the SQL twin of the web/API
 * `matchState` rule (matchAir.ts), NOT merely of
 * Tournament.isMainDrawFinished(). A main-draw match is still live for
 * this purpose while its result is decided but its staggered reveal
 * window has not elapsed, because that is exactly the state the UI
 * presents as "still competing" (the profile's "Next: vs … in 4:39:09"
 * strip). Before this, a free agent whose final was decided but not yet
 * aired was signable while still looking mid-match — the exact
 * confusion the signing rule exists to remove.
 *
 * A tournament that has not started, is mid-draw, or is sitting between
 * qualifying and main-draw seeding is therefore unfinished; one whose
 * main draw is decided AND fully aired is finished.
 *
 * Note the semantics are TOURNAMENT-level, not player-level (per the
 * spec): a player eliminated in round 1 of an event still in progress
 * remains committed until that event concludes. That is deliberate — it
 * is what makes "a signing is always clean" hold, and it is why the
 * signable pool is temporarily smaller than it used to be.
 *
 * **A CANCELLED draw is never unfinished.** A draw that never seeded and
 * was cancelled past its grace window (see Tournament.cancel) will never
 * play its main draw, so without this clause its entrants would be
 * "unfinished" forever — the exact permanent lock the cancelled state
 * exists to release. `t.cancelled_at IS NULL` is folded into the two
 * fragment constants themselves, so every consumer (the atomic claim, the
 * pool's per-player read, the fillers' set read) inherits it from the one
 * definition rather than repeating the clause.
 *
 * Both fragment constants assume the tournaments table is aliased `t`
 * in the surrounding query (all callers here do).
 */

/** The singles main draw of tournament `t` is NOT finished (decided, aired
 * and not cancelled). */
export const singlesMainDrawUnfinished = sql`(
  t.cancelled_at IS NULL
  AND (
    NOT EXISTS (SELECT 1 FROM tournament_matches m WHERE m.tournament_id = t.id AND m.draw = 'main')
    OR EXISTS (
      SELECT 1 FROM tournament_matches m
      WHERE m.tournament_id = t.id AND m.draw = 'main'
        AND (
          m.winner_id IS NULL
          OR (
            m.scheduled_start_at IS NOT NULL
            AND now() < m.scheduled_start_at + make_interval(secs => COALESCE(m.reveal_seconds, 0))
          )
        )
    )
  )
)`;

/** The doubles main draw of tournament `t` is NOT finished (decided, aired
 * and not cancelled). */
export const doublesMainDrawUnfinished = sql`(
  t.cancelled_at IS NULL
  AND (
    NOT EXISTS (SELECT 1 FROM tournament_doubles_matches m WHERE m.tournament_id = t.id AND m.draw = 'main')
    OR EXISTS (
      SELECT 1 FROM tournament_doubles_matches m
      WHERE m.tournament_id = t.id AND m.draw = 'main'
        AND (
          m.winner_id IS NULL
          OR (
            m.scheduled_start_at IS NOT NULL
            AND now() < m.scheduled_start_at + make_interval(secs => COALESCE(m.reveal_seconds, 0))
          )
        )
    )
  )
)`;

/**
 * Boolean SQL predicate: the player identified by `playerRef` (a bound
 * id value OR a column reference such as `players.id`) has NO unfinished
 * tournament commitment, i.e. every tournament they hold a singles entry
 * or a doubles entry/pair in has its relevant main draw decided AND
 * fully aired. Covers all three entry paths (singles
 * `tournament_entries`, doubles `tournament_doubles_entrants`
 * registrations AND formed `tournament_doubles_pairs`, so a manager-less
 * filler placed into a pair is covered too).
 *
 * The column form is what lets the Scouting pool filter signable free
 * agents IN SQL (`DrizzlePlayerRepository.findFreeAgents({signableOnly})`
 * / `countFreeAgents`) without fetching the whole pool — the same
 * predicate the atomic claim enforces, not a near-copy.
 */
export function noUnfinishedCommitmentFor(playerRef: PlayerId | AnyColumn): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM tournament_entries e
      JOIN tournaments t ON t.id = e.tournament_id
      WHERE e.player_id = ${playerRef} AND ${singlesMainDrawUnfinished}
    )
    AND NOT EXISTS (
      SELECT 1 FROM tournament_doubles_entrants de
      JOIN tournaments t ON t.id = de.tournament_id
      WHERE de.player_id = ${playerRef} AND ${doublesMainDrawUnfinished}
    )
    AND NOT EXISTS (
      SELECT 1 FROM tournament_doubles_pairs dp
      JOIN tournaments t ON t.id = dp.tournament_id
      WHERE (dp.player_a = ${playerRef} OR dp.player_b = ${playerRef}) AND ${doublesMainDrawUnfinished}
    )
  )`;
}

/** The per-player convenience form (the atomic claim passes a bound id). */
export function noUnfinishedCommitment(playerId: PlayerId): SQL {
  return noUnfinishedCommitmentFor(playerId);
}
