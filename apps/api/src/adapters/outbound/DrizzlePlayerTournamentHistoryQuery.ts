import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { AgeBand, PlayerId, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { Db } from '../../db/client';
import { tournamentEntries, tournamentMatches, tournaments } from '../../db/schema';

export interface PlayerTournamentHistoryEntry {
  tournamentId: TournamentId;
  name: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  surface: string;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  /** How many of this player's OWN matches in this tournament are
   * recorded as a win — 0 for a first-round exit or a not-yet-played
   * entry, never null (a real, always-computable count). */
  roundsWon: number;
  /** True exactly when this player won the tournament's actual final
   * match — mutually exclusive with `eliminated`. */
  won: boolean;
  /** True when this player has a recorded LOSS in this tournament
   * (eliminated at whatever round that was) — mutually exclusive with
   * `won`. Both false means "still alive" (hasStarted but no decided
   * match against this player yet) or "not started yet". */
  eliminated: boolean;
}

/**
 * A player's full tournament history — every tournament they've ever
 * entered, across every season, oldest data included, never pruned
 * (docs/data-archival-principles.md: "the player profile page needs
 * real, full history to remain queryable indefinitely"). Reuses the
 * existing tournament_entries/tournaments/tournament_matches tables
 * exactly as they already are — no new store duplicating tournament
 * data, per the same doc.
 *
 * Two queries, not N+1: (1) every tournament_entries row for this
 * player (now indexed — see idx_tournament_entries_player_id) joined
 * to `tournaments` for display fields, and (2) every tournament_matches
 * row involving this player, constrained to those SAME tournament ids.
 * tournament_matches itself has no player-specific index, but that's
 * fine here: the `tournament_id IN (...)` constraint already lands on
 * that table's primary key's leading column, so this stays a small,
 * bounded read (this player's own matches only) rather than a
 * full-table scan.
 */
export class DrizzlePlayerTournamentHistoryQuery {
  constructor(private readonly db: Db) {}

  async forPlayer(playerId: PlayerId): Promise<PlayerTournamentHistoryEntry[]> {
    const entryRows = await this.db
      .select({ tournament: tournaments })
      .from(tournamentEntries)
      .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
      .where(eq(tournamentEntries.playerId, playerId))
      .orderBy(desc(tournaments.seasonScheduled), desc(tournaments.weekScheduled));

    if (entryRows.length === 0) return [];

    const tournamentIds = entryRows.map((r) => r.tournament.id);
    const matchRows = await this.db
      .select()
      .from(tournamentMatches)
      .where(
        and(
          inArray(tournamentMatches.tournamentId, tournamentIds),
          or(eq(tournamentMatches.entrantA, playerId), eq(tournamentMatches.entrantB, playerId)),
        ),
      );

    const matchesByTournament = new Map<string, typeof matchRows>();
    for (const row of matchRows) {
      const bucket = matchesByTournament.get(row.tournamentId) ?? [];
      bucket.push(row);
      matchesByTournament.set(row.tournamentId, bucket);
    }

    return entryRows.map(({ tournament }) => {
      const ownMatches = matchesByTournament.get(tournament.id) ?? [];
      const finalRoundNumber = Math.log2(tournament.drawSize);
      const roundsWon = ownMatches.filter((m) => m.winnerId === playerId).length;
      const won = ownMatches.some((m) => m.winnerId === playerId && m.roundNumber === finalRoundNumber);
      const eliminated = ownMatches.some((m) => m.loserId === playerId);

      return {
        tournamentId: TournamentId(tournament.id),
        name: tournament.name,
        tier: tournament.tier,
        ageBand: tournament.ageBand as AgeBand | null,
        surface: tournament.surface,
        weekScheduled: { season: tournament.seasonScheduled, week: tournament.weekScheduled },
        drawSize: tournament.drawSize,
        hasStarted: tournament.hasStarted,
        roundsWon,
        won,
        eliminated,
      };
    });
  }
}
