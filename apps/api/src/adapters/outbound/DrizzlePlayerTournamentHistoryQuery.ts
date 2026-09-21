import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { AgeBand, PlayerId, StandardPrizeMoneyTable, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { Db } from '../../db/client';
import { tournamentEntries, tournamentMatches, tournaments } from '../../db/schema';
import { isMatchAired } from './matchAir';

/** Same "shared, stateless lookup" reasoning as tournamentRoutes.ts's
 * own PRIZE_MONEY_TABLE instance. */
const PRIZE_MONEY_TABLE = new StandardPrizeMoneyTable();

export interface PlayerTournamentHistoryEntry {
  tournamentId: TournamentId;
  name: string;
  tier: TournamentTier;
  ageBand: AgeBand | null;
  surface: string;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  /** How many of this player's OWN AIRED matches in this tournament are
   * recorded as a win — 0 for a first-round exit, a not-yet-played entry,
   * or a match still inside its reveal window, never null (a real,
   * always-computable count). A result only counts once it has aired, so
   * the history can't spoil a "Premiere" the Matches strip still shows as
   * upcoming (see matchAir.ts). */
  roundsWon: number;
  /** True exactly when this player won the tournament's actual AIRED final
   * match — mutually exclusive with `eliminated`. */
  won: boolean;
  /** True when this player has an AIRED recorded LOSS in this tournament
   * (eliminated at whatever round that was) — mutually exclusive with
   * `won`. Both false means "still alive" or "not started yet". A decided
   * but not-yet-aired loss stays false until its reveal window elapses. */
  eliminated: boolean;
  /** On-site prize money earned in THIS tournament — derived from
   * `roundsWon`/`tier` via the same StandardPrizeMoneyTable
   * SimulateMatchUseCase itself awards from, never a stored/duplicated
   * amount (same "single source of truth" discipline as
   * tournamentRoutes.ts's pointsBreakdown). 0 for a not-yet-played
   * entry (no match decided yet) and always 0 for a junior tier. */
  prizeMoney: number;
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

    const now = Date.now();
    return entryRows.map(({ tournament }) => {
      const ownMatches = matchesByTournament.get(tournament.id) ?? [];
      // Only AIRED matches count toward the displayed result. A match that
      // has been simulated but is still inside its staggered reveal window
      // is presented as "pending" by the profile's Matches strip (which uses
      // the same predicate) — so the history must not call it a loss yet.
      // Before this, one page could show "NEXT UP … Playing in 58:05" and
      // "Lost - Round of 16" for the SAME match.
      const airedMatches = ownMatches.filter((m) => isMatchAired(m, now));
      const finalRoundNumber = Math.log2(tournament.drawSize);
      const roundsWon = airedMatches.filter((m) => m.winnerId === playerId).length;
      const won = airedMatches.some((m) => m.winnerId === playerId && m.roundNumber === finalRoundNumber);
      const eliminated = airedMatches.some((m) => m.loserId === playerId);

      // Prize money is only ever actually credited (by
      // SimulateMatchUseCase) the moment a player is eliminated OR
      // wins the final — a still-alive/not-started entry has earned
      // nothing yet, matching real behavior rather than pre-crediting
      // a hypothetical amount.
      const prizeMoney = eliminated || won ? PRIZE_MONEY_TABLE.prizeMoneyFor(tournament.tier as TournamentTier, roundsWon) : 0;

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
        prizeMoney,
      };
    });
  }
}
