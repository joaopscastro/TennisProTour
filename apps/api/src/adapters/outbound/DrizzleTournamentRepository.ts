import { and, asc, eq } from 'drizzle-orm';
import { GameWeek, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import {
  AgeBand,
  BracketRound,
  DrawSize,
  EntryType,
  entryTypeOf,
  MatchOutcome,
  TournamentEntrant,
  TournamentTier,
} from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import { TournamentRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { tournamentEntries, tournamentMatches, tournaments } from '../../db/schema';

type TournamentRow = typeof tournaments.$inferSelect;
type EntryRow = typeof tournamentEntries.$inferSelect;
type MatchRow = typeof tournamentMatches.$inferSelect;

/**
 * Drizzle-backed TournamentRepository adapter. Persists the aggregate
 * whole-hog: save() upserts the tournaments row and replaces the
 * aggregate's child rows (entries, matches) inside one transaction —
 * simple, correct aggregate-style persistence; no partial diffing
 * until profiling ever says it matters. Rehydration goes through
 * Tournament.reconstitute(), never open()/startWithBracket(), so
 * loading a started tournament emits no TournamentStarted event.
 */
export class DrizzleTournamentRepository implements TournamentRepository {
  constructor(private readonly db: Db) {}

  async findById(id: TournamentId): Promise<Tournament | null> {
    const rows = await this.db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.load(rows[0]);
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    const rows = await this.db.select().from(tournaments).where(eq(tournaments.hasStarted, false));
    return Promise.all(rows.map((row) => this.load(row)));
  }

  async findStarted(): Promise<Tournament[]> {
    const rows = await this.db.select().from(tournaments).where(eq(tournaments.hasStarted, true));
    return Promise.all(rows.map((row) => this.load(row)));
  }

  async findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    const rows = await this.db
      .select({ tournament: tournaments })
      .from(tournaments)
      .innerJoin(tournamentEntries, eq(tournamentEntries.tournamentId, tournaments.id))
      .where(
        and(
          eq(tournamentEntries.playerId, playerId),
          eq(tournaments.seasonScheduled, week.season),
          eq(tournaments.weekScheduled, week.week),
        ),
      );
    return Promise.all(rows.map((row) => this.load(row.tournament)));
  }

  async save(tournament: Tournament): Promise<void> {
    const tournamentRow: typeof tournaments.$inferInsert = {
      id: tournament.id,
      name: tournament.name,
      tier: tournament.tier,
      ageBand: tournament.ageBand,
      surface: tournament.surface,
      seasonScheduled: tournament.weekScheduled.season,
      weekScheduled: tournament.weekScheduled.week,
      startDay: tournament.startDay,
      drawSize: tournament.drawSize,
      hostCountry: tournament.hostCountry,
      hasStarted: tournament.hasStarted,
    };

    await this.db.transaction(async (tx) => {
      await tx
        .insert(tournaments)
        .values(tournamentRow)
        .onConflictDoUpdate({
          target: tournaments.id,
          set: { ...tournamentRow, updatedAt: new Date() },
        });

      await tx.delete(tournamentEntries).where(eq(tournamentEntries.tournamentId, tournament.id));
      if (tournament.entrants.length > 0) {
        await tx.insert(tournamentEntries).values(
          tournament.entrants.map((entrant) => ({
            tournamentId: tournament.id,
            playerId: entrant.playerId,
            seed: entrant.seed,
            entryType: toEntryTypeRow(entryTypeOf(entrant)),
          })),
        );
      }

      await tx.delete(tournamentMatches).where(eq(tournamentMatches.tournamentId, tournament.id));
      const matchRows = tournament.getRounds().flatMap((round) =>
        round.matches.map((match, matchIndex) => ({
          tournamentId: tournament.id,
          roundNumber: round.roundNumber,
          matchIndex,
          entrantA: match.entrantA,
          entrantB: match.entrantB,
          winnerId: match.outcome?.winner ?? null,
          loserId: match.outcome?.loser ?? null,
          setScores: match.outcome ? [...match.outcome.setScores] : null,
        })),
      );
      if (matchRows.length > 0) {
        await tx.insert(tournamentMatches).values(matchRows);
      }
    });
  }

  private async load(row: TournamentRow): Promise<Tournament> {
    const [entryRows, matchRows] = await Promise.all([
      this.db
        .select()
        .from(tournamentEntries)
        .where(eq(tournamentEntries.tournamentId, row.id))
        // Secondary tiebreak on playerId, not just createdAt: save()
        // bulk-inserts every entrant in one transaction, and Postgres's
        // defaultNow() resolves once per transaction, not once per
        // row — so a batch of entrants registered together (e.g. an
        // OpenTournamentUseCase-seeded draw) all get an IDENTICAL
        // createdAt, and ORDER BY on that alone is not deterministic
        // (ties break on physical row layout, which can silently
        // change between reads). This makes the read order stable and
        // reproducible; it does NOT recover true chronological
        // registration order for same-transaction ties — that would
        // need an explicit sequence/insertion-order column, which
        // doesn't exist yet. Only matters in practice for unseeded
        // entrants (BracketGenerator.orderBySeed keeps null-seed
        // entrants in their input array's relative order), so this is
        // a determinism fix, not a fairness one.
        .orderBy(asc(tournamentEntries.createdAt), asc(tournamentEntries.playerId)),
      this.db
        .select()
        .from(tournamentMatches)
        .where(eq(tournamentMatches.tournamentId, row.id))
        .orderBy(asc(tournamentMatches.roundNumber), asc(tournamentMatches.matchIndex)),
    ]);

    return Tournament.reconstitute({
      id: TournamentId(row.id),
      name: row.name,
      tier: row.tier as TournamentTier,
      ageBand: row.ageBand as AgeBand | null,
      surface: row.surface as Surface,
      weekScheduled: { season: row.seasonScheduled, week: row.weekScheduled },
      startDay: row.startDay,
      drawSize: row.drawSize as DrawSize,
      hostCountry: row.hostCountry,
      entrants: entryRows.map(toEntrant),
      rounds: toRounds(matchRows),
    });
  }
}

function toEntrant(row: EntryRow): TournamentEntrant {
  return { playerId: PlayerId(row.playerId), seed: row.seed, entryType: toEntryType(row.entryType) };
}

/** The db enum is lowercase like every other enum in this schema; the
 * domain's own labels are the real draw-sheet ones ('DA'/'Q'/'WC').
 * Both directions live here, in the adapter, so neither side has to
 * know about the other's casing convention. */
function toEntryType(value: EntryRow['entryType']): EntryType {
  switch (value) {
    case 'q':
      return 'Q';
    case 'wc':
      return 'WC';
    default:
      return 'DA';
  }
}

function toEntryTypeRow(value: EntryType): 'da' | 'q' | 'wc' {
  switch (value) {
    case 'Q':
      return 'q';
    case 'WC':
      return 'wc';
    default:
      return 'da';
  }
}

function toRounds(rows: MatchRow[]): BracketRound[] {
  const byRound = new Map<number, MatchRow[]>();
  for (const row of rows) {
    const bucket = byRound.get(row.roundNumber) ?? [];
    bucket.push(row);
    byRound.set(row.roundNumber, bucket);
  }

  // Rows arrive ordered by (roundNumber, matchIndex); the domain
  // guarantees matchIndex is dense from 0 within a round, so the
  // bucket's array order is the round's match order.
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([roundNumber, matches]) => ({
      roundNumber,
      matches: matches.map((row) => ({
        entrantA: PlayerId(row.entrantA),
        entrantB: PlayerId(row.entrantB),
        outcome: toOutcome(row),
      })),
    }));
}

function toOutcome(row: MatchRow): MatchOutcome | null {
  if (row.winnerId === null || row.loserId === null) return null;
  return {
    winner: PlayerId(row.winnerId),
    loser: PlayerId(row.loserId),
    setScores: row.setScores ?? [],
  };
}
