import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Drizzle schema for the Player & Roster and Competition contexts.
 *
 * How the bracket is normalized — the decision and why:
 *
 * Two tables, not three. `tournament_entries` holds registration
 * (who's in the draw, with what seed), and `tournament_matches` holds
 * one row per bracket match, keyed by (tournament_id, round_number,
 * match_index) — the exact coordinates the domain already uses in
 * Tournament.getScheduledMatch()/recordMatchOutcome(), so repository
 * adapters translate addressing 1:1 with no mapping layer.
 *
 * There is deliberately NO tournament_rounds table: in the domain, a
 * BracketRound is nothing but { roundNumber, matches[] } — a round has
 * no attributes of its own, and its existence is implied by its
 * matches (BracketGenerator never emits an empty round; byes are
 * represented by a match simply not existing in round 1). A rounds
 * table would add a join with zero extra information. If rounds ever
 * grow their own state (e.g. per-round scheduling windows), that's the
 * point to introduce the table, not before.
 *
 * Set scores live in a jsonb column on the match row rather than a
 * fourth table: the domain treats MatchOutcome.setScores as an
 * immutable value written once at simulation time and only ever read
 * back whole — nothing queries "all 7-6 sets" relationally. (The full
 * MatchLog replay blob is NOT here at all; per CLAUDE.md it belongs in
 * object storage behind MatchLogStorePort, not in Postgres rows.)
 *
 * Player attributes are explicit integer columns rather than a jsonb
 * blob: the nine skills + four surface affinities are a fixed, small
 * set, and flat columns keep them queryable for the features this
 * game is built around (scouting lists, leaderboards, "best clay
 * players") without json-path indexing gymnastics.
 */

export const tournamentTier = pgEnum('tournament_tier', ['junior', 'futures', 'challenger', 'tour', 'major']);
export const surface = pgEnum('surface', ['clay', 'grass', 'hard', 'indoor']);
export const playerStage = pgEnum('player_stage', ['youth', 'prime', 'decline', 'retired']);

export const players = pgTable('players', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Null = free agent (released or never hired). */
  managerId: text('manager_id'),
  ageInWeeks: integer('age_in_weeks').notNull(),
  stage: playerStage('stage').notNull(),
  fatigue: integer('fatigue').notNull().default(0),

  // Technical
  serve: integer('serve').notNull(),
  forehand: integer('forehand').notNull(),
  backhand: integer('backhand').notNull(),
  volley: integer('volley').notNull(),
  // Physical
  speed: integer('speed').notNull(),
  stamina: integer('stamina').notNull(),
  strength: integer('strength').notNull(),
  // Mental
  consistency: integer('consistency').notNull(),
  clutch: integer('clutch').notNull(),

  // Surface affinities (percentage bonus per surface, capped in domain)
  affinityClay: integer('affinity_clay').notNull(),
  affinityGrass: integer('affinity_grass').notNull(),
  affinityHard: integer('affinity_hard').notNull(),
  affinityIndoor: integer('affinity_indoor').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  tier: tournamentTier('tier').notNull(),
  surface: surface('surface').notNull(),
  /** GameWeek value object flattened to its two components. */
  seasonScheduled: integer('season_scheduled').notNull(),
  weekScheduled: integer('week_scheduled').notNull(),
  drawSize: integer('draw_size').notNull(),
  /** Mirrors Tournament.hasStarted (rounds exist). Denormalized so
   * findOpenForRegistration() is a flag filter, not an EXISTS probe
   * against tournament_matches. */
  hasStarted: boolean('has_started').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tournamentEntries = pgTable(
  'tournament_entries',
  {
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    /** Null = unseeded entrant. */
    seed: integer('seed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tournamentId, table.playerId] })],
);

export const tournamentMatches = pgTable(
  'tournament_matches',
  {
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    roundNumber: integer('round_number').notNull(),
    matchIndex: integer('match_index').notNull(),
    entrantA: text('entrant_a')
      .notNull()
      .references(() => players.id),
    entrantB: text('entrant_b')
      .notNull()
      .references(() => players.id),
    /** Null until the match is simulated (outcome recorded once, never
     * updated after — enforced by the Tournament aggregate, not the DB). */
    winnerId: text('winner_id').references(() => players.id),
    loserId: text('loser_id').references(() => players.id),
    /** MatchOutcome.setScores verbatim:
     * [{ winnerGames: number, loserGames: number }, ...] */
    setScores: jsonb('set_scores').$type<Array<{ winnerGames: number; loserGames: number }>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tournamentId, table.roundNumber, table.matchIndex] })],
);
