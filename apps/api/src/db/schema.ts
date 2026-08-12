import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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

export const tournamentTier = pgEnum('tournament_tier', [
  'futures',
  'challenger',
  'tour',
  'major',
  // The combined junior ladder — see JuniorTier's doc comment in
  // packages/domain/src/competition/CompetitionTypes.ts. Age band
  // (u14/u16) is NOT part of the tier; it's the separate ageBand
  // column on `tournaments` below.
  'j30',
  'j60',
  'j100',
  'j200',
  'j300',
  'j500',
  'juniorMasters',
]);
/** Only set (non-null) for junior-tier tournaments — see
 * Tournament.ageBand's doc comment. U12 is deliberately out of scope
 * (real ITF/Tennis Europe U12 play is unranked and unseeded). */
export const ageBand = pgEnum('age_band', ['u14', 'u16']);
/** The three independent rankings a player can hold — see
 * packages/domain/src/ranking/RankingBand.ts. Distinct from `ageBand`
 * above only in that it also has a 'senior' value (a tournament's
 * ageBand is null for senior tiers; a ranking band is never null, it's
 * explicitly 'senior' instead) — used on `players.dormant_carryover_target_band`. */
export const rankingBand = pgEnum('ranking_band', ['senior', 'u14', 'u16']);
export const surface = pgEnum('surface', ['clay', 'grass', 'hard', 'indoor']);
export const playerStage = pgEnum('player_stage', ['youth', 'prime', 'decline', 'retired']);
/** Every attribute TrainingFocus can target — see
 * PlayerAttributes.TrainableAttribute. Deliberately excludes
 * 'consistency'/'clutch' (mental): mental attributes are never a
 * training target at all, per docs/training-redesign-per-attribute.md
 * — enforced at the TypeScript level in the domain, and there is
 * consequently no DB value that could ever represent one either.
 * Replaces the old 'skill_cluster' enum (technical/physical/mental,
 * one delta applied across a whole cluster) now that training targets
 * a single attribute, not a cluster. */
export const trainableAttribute = pgEnum('trainable_attribute', [
  'serve',
  'forehand',
  'backhand',
  'volley',
  'speed',
  'stamina',
  'strength',
]);
/** Discriminant for a player's standing training focus (TrainingFocus
 * union). Kept as a small enum plus two nullable "value" columns
 * (below, on `players`) rather than a jsonb blob, matching this
 * schema's existing convention (skills/affinities are flat columns,
 * not json) — training focus is exactly one of a fixed small set of
 * values, never freeform data. */
export const trainingFocusKind = pgEnum('training_focus_kind', ['surface', 'attribute']);
export const managerStatus = pgEnum('manager_status', ['active', 'suspended']);
/** How an entrant got into a main draw (real tennis convention — see
 * EntryType in the domain / docs/ranking-realism-proposal.md §5): 'da'
 * = direct acceptance by ranking, 'q' = came through qualifying, 'wc'
 * = wildcard. Lowercase values to match every other enum here; the
 * domain's own 'DA'/'Q'/'WC' labels are mapped in the adapter. */
export const tournamentEntryType = pgEnum('tournament_entry_type', ['da', 'q', 'wc']);

/** One row per game-world clock (single world at MVP). Players/
 * tournaments gain a world_id column when multi-world arrives. */
export const gameWorlds = pgTable('game_worlds', {
  id: text('id').primaryKey(),
  season: integer('season').notNull(),
  week: integer('week').notNull(),
  /** Day within the week, 1..7. Defaults to 1 for worlds created
   * before the day clock existed. See GameWorld / day-tick design. */
  currentDay: integer('current_day').notNull().default(1),
  /** Idempotency guard for the weekly advance job — see GameWorld. */
  lastAppliedTick: text('last_applied_tick'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Manager Pro entitlement state, maintained exclusively by billing
 * webhooks (checkout completed -> active, subscription deleted ->
 * canceled). Game logic reads it only through BillingPort — one row
 * per manager who has ever subscribed; absence of a row = free tier.
 */
export const managerEntitlements = pgTable('manager_entitlements', {
  managerId: text('manager_id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  status: text('status', { enum: ['active', 'canceled'] }).notNull(),
  /** Custom-player-creation credit balance — +1 on each confirmed
   * Stripe subscription *renewal* (StripeBillingAdapter.
   * grantCustomPlayerCredit, fired from the invoice.paid webhook when
   * billing_reason is subscription_cycle, never on the initial
   * signup), -1 each time CreateCustomPlayerUseCase spends one. */
  customPlayerCredits: integer('custom_player_credits').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Application-owned manager profile linked to an external auth subject.
 * Community profile data belongs here; provider tokens and passwords never
 * do. Public features should use publicHandle, not authSubject or id. */
export const managers = pgTable('managers', {
  id: text('id').primaryKey(),
  authSubject: text('auth_subject').notNull().unique(),
  displayName: text('display_name').notNull(),
  publicHandle: text('public_handle').notNull().unique(),
  status: managerStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only ledger of dated ranking results — one row per tournament
 * result a player earns, never updated after insert. This is the
 * source of truth RankingCalculationService reads from to compute a
 * player's rolling 52-week/best-18-cap total; player_rankings above
 * (a single mutable totalPoints) predates this and is being phased out
 * in favor of computing the total on read instead of storing it.
 */
export const rankingLedger = pgTable(
  'ranking_ledger',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    tier: tournamentTier('tier').notNull(),
    /** Mirrors the earning tournament's age_band — null for a senior
     * result, u14/u16 for a junior one. Scopes this entry to exactly one
     * of a player's independent rankings — see RankingBand (domain). */
    ageBand: ageBand('age_band'),
    points: doublePrecision('points').notNull(),
    /** Marks a MANDATORY-SKIP zero (see ObligatoryTournamentPolicy /
     * docs/ranking-realism-proposal.md): an obligatory event this
     * player was entitled to enter by ranking but didn't play, which
     * still burns one of their best-N counted slots at 0 points. Kept
     * distinguishable from a genuine first-round major loss (also 0
     * points, but obligatory = false) for honest display/audit; the
     * ranking TOTAL treats the two identically. Defaults false, so
     * every pre-existing row reads back exactly as the domain's own
     * default — no backfill needed. */
    obligatory: boolean('obligatory').notNull().default(false),
    /** GameWeek value object flattened, same convention as tournaments.seasonScheduled/weekScheduled. */
    seasonEarned: integer('season_earned').notNull(),
    weekEarned: integer('week_earned').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The real gap docs/data-archival-principles.md's index audit
     * found: findByPlayer() (AdvanceWorldWeekUseCase's graduation-
     * carryover check on every weekly tick, and the new player-profile
     * tournament/ranking history query) filters by player_id alone —
     * with no index at all here, that was a full-table sequential
     * scan. This is the fix, not just the finding. */
    index('idx_ranking_ledger_player_id').on(table.playerId),
  ],
);

/**
 * The permanent high-water-mark table (docs/data-archival-principles.md
 * — "small and mutable ... never append-only"). Composite primary key
 * on (player_id, band) is the structural half of "one row per player
 * per scope": a second write for the same player+band can only ever
 * be an UPDATE (upsert), never a second INSERT, so this table's size
 * is bounded by player count × 3 bands, not by how many times a
 * ranking is recomputed.
 */
export const peakRankings = pgTable(
  'peak_rankings',
  {
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    band: rankingBand('band').notNull(),
    peakPoints: doublePrecision('peak_points').notNull(),
    /** When this peak was actually last reached — display context, not
     * part of the ordering rule (see PeakRanking.isNewPeak). */
    peakAsOfSeason: integer('peak_as_of_season').notNull(),
    peakAsOfWeek: integer('peak_as_of_week').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.playerId, table.band] })],
);

/**
 * Append-only title/trophy table (docs/data-archival-principles.md —
 * "lean ... referencing tournament data rather than copying it").
 * `tournament_id` as the PRIMARY KEY (not a synthetic id) is a
 * structural guarantee, not just a convention: a tournament can only
 * ever have one winner, so the schema itself makes a second title row
 * for the same tournament impossible, matching RankingLedgerEntry's
 * minimal-scalar-denormalization shape (tier/age_band/season/week
 * duplicated for cheap filtering; the tournament's generated name,
 * surface, draw size, etc. are NOT copied here — display-time code
 * joins back to `tournaments` for those).
 */
export const titles = pgTable(
  'titles',
  {
    tournamentId: text('tournament_id')
      .primaryKey()
      .references(() => tournaments.id),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    tier: tournamentTier('tier').notNull(),
    ageBand: ageBand('age_band'),
    seasonEarned: integer('season_earned').notNull(),
    weekEarned: integer('week_earned').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The trophy-list read pattern ("every title this player has ever
    // won") is exactly the same per-player shape the index audit above
    // fixed for ranking_ledger/tournament_entries — built with the
    // index from the start here rather than as a follow-up gap.
    index('idx_titles_player_id').on(table.playerId),
  ],
);

/**
 * A manager's cumulative XP balance (Manager & Progression bounded
 * context — see ManagerXpRepository). One row per manager who has ever
 * earned XP; absence of a row = balance 0, same "absence means zero"
 * convention as manager_entitlements above. Credited via
 * SimulateMatchUseCase on every rostered player's deciding match
 * result; spent atomically by spendXpIfSufficient's conditional UPDATE
 * (same "WHERE re-checks the guard as part of the same statement"
 * mechanism as manager_entitlements.custom_player_credits above — no
 * separate row-level locking needed).
 */
export const managerProgression = pgTable('manager_progression', {
  managerId: text('manager_id').primaryKey(),
  xpBalance: integer('xp_balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A manager's DECAYING public ladder score (Manager & Progression
 * context — see ManagerLadderRepository). Deliberately a SEPARATE table
 * from manager_progression above: that one is the monotonic spendable
 * XP wallet, this one is the eroding competitive standing that answers
 * "am I winning vs other managers?" (docs/rocking-rackets-competitive-
 * analysis.md §1d). Score is `double precision`, not integer, because
 * the weekly 1% decay (score = score * 0.99) produces fractional
 * values — callers round only for display. One row per manager who has
 * ever banked a point; absence = 0 (same "absence means zero"
 * convention as manager_progression). Credited via SimulateMatchUseCase
 * at the same event as ranking-ledger writes; decayed once per weekly
 * rollover by a single whole-table UPDATE (AdvanceWorldWeekUseCase).
 * The score index serves the public leaderboard's ORDER BY score DESC.
 */
export const managerLadder = pgTable(
  'manager_ladder',
  {
    managerId: text('manager_id').primaryKey(),
    score: doublePrecision('score').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_manager_ladder_score').on(table.score)],
);

/**
 * A manager's converted coach (Manager & Progression bounded context —
 * see Coach/ConvertPlayerToCoachUseCase). No FK to players: a coach's
 * sourcePlayerId/sourcePlayerName are lineage/flavor snapshotted at
 * conversion time, same "no FK, opaque id" convention as players.
 * manager_id elsewhere in this schema — the source player row keeps
 * existing (released, not deleted), but the coach doesn't need a live
 * reference back to it since coachRating is fixed at conversion, not
 * recomputed from the player's current (now-frozen, ex-roster) state.
 */
export const coaches = pgTable('coaches', {
  id: text('id').primaryKey(),
  managerId: text('manager_id').notNull(),
  coachRating: integer('coach_rating').notNull(),
  sourcePlayerId: text('source_player_id').notNull(),
  sourcePlayerName: text('source_player_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable('players', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Display-only (a flag next to the player's name) — no gameplay
   * meaning, no validation against a country reference table. Free
   * text rather than an enum since none exists elsewhere in this
   * schema. */
  nationality: text('nationality').notNull().default('XX'),
  /** Null = free agent — either released by a manager (fillOnly stays
   * false) or a fillOnly player, which never had a manager at all (see
   * fillOnly below). */
  managerId: text('manager_id'),
  ageInWeeks: integer('age_in_weeks').notNull(),
  stage: playerStage('stage').notNull(),
  fatigue: integer('fatigue').notNull().default(0),
  /** Match rhythm counter (see Player.form's doc comment, packages/domain).
   * Accrues +1 per real match, decays 15%/week on the world tick. */
  form: integer('form').notNull().default(0),
  /** See Player.fillOnly's doc comment (packages/domain). True only
   * for a player generated by GenesisSeedFillOnlyPlayersUseCase or
   * converted from an expired TalentPoolCandidate
   * (RefreshTalentPoolUseCase) — never true for hire()/claim-created
   * players, and never flips back to false. Defaults to false so every
   * pre-existing row (all of which predate this column) is correctly
   * NOT fill-only. */
  fillOnly: boolean('fill_only').notNull().default(false),
  /** Hidden ceiling on skill-cluster training growth (see
   * Player.potentialCeiling) — NEVER read by playerDto.ts or any other
   * HTTP-facing mapper. Defaults to 100 (no meaningful ceiling),
   * matching Player.hire()'s own default, for any row that predates
   * this column. */
  potentialCeiling: integer('potential_ceiling').notNull().default(100),
  /** Hidden per-physical-attribute training ceilings (see
   * Player.physicalCeilings / docs/training-redesign-per-attribute.md)
   * — NEVER read by playerDto.ts or any other HTTP-facing mapper.
   * Defaults to 100 each (no meaningful ceiling), matching
   * Player.hire()'s own default, for any row that predates these
   * columns. */
  speedCeiling: integer('speed_ceiling').notNull().default(100),
  staminaCeiling: integer('stamina_ceiling').notNull().default(100),
  strengthCeiling: integer('strength_ceiling').notNull().default(100),
  /** Hidden Talent stat (see Player.talent / PlayerDevelopmentPolicy) —
   * gates weekly free development income; NEVER read by playerDto.ts or
   * any other HTTP-facing mapper. Defaults to 50 (a neutral mid value)
   * for any row that predates this column. */
  talent: integer('talent').notNull().default(50),
  /** Accumulated, spendable player-development experience (see
   * Player.experience / PlayerDevelopmentPolicy) — earned by playing
   * matches + weekly talent income, spent to fund training growth.
   * Stored as double precision (not integer) because it legitimately
   * carries fractional remainders: weekly income minus the fractional
   * cost of a sub-1-point funded training step (same doublePrecision
   * precedent as dormantCarryoverBonusPoints). NEVER read by
   * playerDto.ts or any other HTTP-facing mapper. Defaults to 0 for any
   * row that predates this column. */
  experience: doublePrecision('experience').notNull().default(0),

  // NOTE: there is deliberately no training_focus_kind/surface/attribute
  // column here anymore — a player's training focus moved from a
  // single mutable field on this row to a per-GameWeek schedule (see
  // the trainingSchedule table below), replaced rather than kept
  // alongside it.

  /** A dormant graduation-carryover bonus (see
   * packages/domain/src/ranking/GraduationCarryover.ts) — null target
   * band means no pending bonus. Same "flat nullable columns for a
   * small optional structured field" convention as trainingFocus
   * above, not jsonb (see this table's top-level doc comment on
   * setScores for why jsonb is reserved for write-once/read-whole
   * blobs, which this isn't — it's mutated in place). */
  dormantCarryoverTargetBand: rankingBand('dormant_carryover_target_band'),
  dormantCarryoverBonusPoints: doublePrecision('dormant_carryover_bonus_points'),

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

/**
 * A player's per-GameWeek training-focus schedule (see
 * packages/domain/src/player/TrainingSchedule.ts) — replaces the old
 * single mutable training_focus_kind/surface/attribute columns that
 * used to live on `players` itself. One row per explicit entry a
 * manager has ever set; composite primary key on (player_id,
 * effective_from_season, effective_from_week) is the structural half
 * of "setting the same week twice overwrites, never duplicates" (a
 * second write for the same player+week can only ever be an UPDATE,
 * same "one row per scope" reasoning as peak_rankings above) — and
 * since player_id is the PK's leading column, "every entry for this
 * player" (what resolveTrainingFocusForWeek needs) is already served
 * by the PK's own index, no separate index required (same reasoning
 * peak_rankings' (player_id, band) PK already relies on).
 *
 * `focus_kind` null means an explicit "train nothing from this week
 * on" order — a real, meaningful row, not the absence of one; the
 * absence of any row with effective_from <= a given week is what "no
 * standing order yet" actually looks like.
 */
export const trainingSchedule = pgTable(
  'training_schedule',
  {
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    effectiveFromSeason: integer('effective_from_season').notNull(),
    effectiveFromWeek: integer('effective_from_week').notNull(),
    focusKind: trainingFocusKind('focus_kind'),
    focusSurface: surface('focus_surface'),
    focusAttribute: trainableAttribute('focus_attribute'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.playerId, table.effectiveFromSeason, table.effectiveFromWeek] })],
);

export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  /** A real, original generated display name (TournamentNameGenerator)
   * — NOT NULL: Tournament.open()/reconstitute() both refuse to
   * construct a tournament with an empty name, and the only two use
   * cases that ever open one (OpenTournamentUseCase/
   * OpenRegistrationUseCase) always generate one internally, so there
   * is structurally no code path that could ever write a null/blank
   * value here. */
  name: text('name').notNull(),
  tier: tournamentTier('tier').notNull(),
  /** Null for senior tiers, required for junior tiers — see
   * Tournament.ageBand's doc comment. */
  ageBand: ageBand('age_band'),
  surface: surface('surface').notNull(),
  /** GameWeek value object flattened to its two components. */
  seasonScheduled: integer('season_scheduled').notNull(),
  weekScheduled: integer('week_scheduled').notNull(),
  /** Day-within-week (1..7) the tournament begins on, relative to
   * weekScheduled. Round r is played on roundDay days after this start
   * day (see TournamentSchedulePolicy). Defaults to 1 for tournaments
   * created before the day clock existed. */
  startDay: integer('start_day').notNull().default(1),
  drawSize: integer('draw_size').notNull(),
  /** Host country (P6 home advantage). Nullable: pre-P6 rows and any
   * tournament opened without a generated name have none, in which
   * case no player is ever "home". Set from
   * TournamentNameGenerator's picked country at open time. */
  hostCountry: text('host_country'),
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
    /** Direct acceptance / qualifier / wildcard (see
     * tournamentEntryType above). Defaults to 'da' so every row written
     * before qualifying existed reads back as a direct acceptance,
     * matching the domain's own default. */
    entryType: tournamentEntryType('entry_type').notNull().default('da'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tournamentId, table.playerId] }),
    /** The composite PK above leads with tournament_id, so it doesn't
     * serve a player_id-only lookup ("every tournament this player
     * entered" — the tournament-history query's access pattern) any
     * better than a full scan would. A second real gap the index audit
     * found; this is the fix. */
    index('idx_tournament_entries_player_id').on(table.playerId),
  ],
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
