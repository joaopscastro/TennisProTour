import { sql, SQL } from 'drizzle-orm';
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
 * been played to its final" — the SQL twins of Tournament.isMainDrawFinished()
 * / isDoublesMainDrawFinished(), reusing the same shape
 * DrizzleTournamentRepository.findStartedLive() established: a main-draw
 * match exists (hasMainDraw) AND no main-draw match is still undecided.
 * A tournament that has not started, is mid-draw, or is sitting between
 * qualifying and main-draw seeding is therefore unfinished; one whose
 * main draw is decided is finished.
 *
 * Note the semantics are TOURNAMENT-level, not player-level (per the
 * spec): a player eliminated in round 1 of an event still in progress
 * remains committed until that event concludes. That is deliberate — it
 * is what makes "a signing is always clean" hold, and it is why the
 * signable pool is temporarily smaller than it used to be.
 *
 * Both fragment constants assume the tournaments table is aliased `t`
 * in the surrounding query (all callers here do).
 */

/** The singles main draw of tournament `t` is NOT finished. */
export const singlesMainDrawUnfinished = sql`(
  NOT EXISTS (SELECT 1 FROM tournament_matches m WHERE m.tournament_id = t.id AND m.draw = 'main')
  OR EXISTS (SELECT 1 FROM tournament_matches m WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.winner_id IS NULL)
)`;

/** The doubles main draw of tournament `t` is NOT finished. */
export const doublesMainDrawUnfinished = sql`(
  NOT EXISTS (SELECT 1 FROM tournament_doubles_matches m WHERE m.tournament_id = t.id AND m.draw = 'main')
  OR EXISTS (SELECT 1 FROM tournament_doubles_matches m WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.winner_id IS NULL)
)`;

/**
 * Boolean SQL predicate: this player has NO unfinished tournament
 * commitment, i.e. every tournament they hold a singles entry or a
 * doubles entry/pair in has its relevant main draw decided. Covers both
 * entry paths (singles `tournament_entries`, doubles
 * `tournament_doubles_entrants` registrations AND formed
 * `tournament_doubles_pairs`, so a manager-less filler placed into a
 * pair is covered too).
 */
export function noUnfinishedCommitment(playerId: PlayerId): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM tournament_entries e
      JOIN tournaments t ON t.id = e.tournament_id
      WHERE e.player_id = ${playerId} AND ${singlesMainDrawUnfinished}
    )
    AND NOT EXISTS (
      SELECT 1 FROM tournament_doubles_entrants de
      JOIN tournaments t ON t.id = de.tournament_id
      WHERE de.player_id = ${playerId} AND ${doublesMainDrawUnfinished}
    )
    AND NOT EXISTS (
      SELECT 1 FROM tournament_doubles_pairs dp
      JOIN tournaments t ON t.id = dp.tournament_id
      WHERE (dp.player_a = ${playerId} OR dp.player_b = ${playerId}) AND ${doublesMainDrawUnfinished}
    )
  )`;
}
