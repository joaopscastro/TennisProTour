import { boolean, doublePrecision, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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
/** How rare a generated player's skill band is — see
 * PlayerGenerationPolicy.PlayerRarityTier. */
export const playerRarityTier = pgEnum('player_rarity_tier', ['common', 'strong', 'exceptional']);
export const talentPoolCandidateStatus = pgEnum('talent_pool_candidate_status', ['available', 'claimed', 'expired']);
/** The coarse, noisy signal scouting exposes for a hidden
 * potentialCeiling — see PlayerGenerationPolicy.PotentialTier. */
export const playerPotentialTier = pgEnum('player_potential_tier', ['limited', 'promising', 'high', 'elite']);
export const managerStatus = pgEnum('manager_status', ['active', 'suspended']);

/** One row per game-world clock (single world at MVP). Players/
 * tournaments gain a world_id column when multi-world arrives. */
export const gameWorlds = pgTable('game_worlds', {
  id: text('id').primaryKey(),
  season: integer('season').notNull(),
  week: integer('week').notNull(),
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
export const rankingLedger = pgTable('ranking_ledger', {
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
  /** GameWeek value object flattened, same convention as tournaments.seasonScheduled/weekScheduled. */
  seasonEarned: integer('season_earned').notNull(),
  weekEarned: integer('week_earned').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A manager's cumulative XP balance (Manager & Progression bounded
 * context — see ManagerXpRepository). One row per manager who has ever
 * earned XP; absence of a row = balance 0, same "absence means zero"
 * convention as manager_entitlements above. Credited via
 * SimulateMatchUseCase on every rostered player's deciding match
 * result; spent atomically by spendXpIfSufficient's conditional UPDATE
 * (same "WHERE re-checks the guard as part of the same statement"
 * mechanism as talent_pool_candidates.status / manager_entitlements.
 * custom_player_credits above — no separate row-level locking needed).
 */
export const managerProgression = pgTable('manager_progression', {
  managerId: text('manager_id').primaryKey(),
  xpBalance: integer('xp_balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

  /** The player's standing weekly training focus (Player.currentFocus
   * / TrainingFocus union) — null kind means no focus set. Exactly one
   * of trainingFocusSurface/trainingFocusAttribute is populated when
   * kind is non-null, matching the domain's discriminated union;
   * enforced in the repository mapping layer, not by a DB constraint
   * (same pattern as setScores being validated by the Tournament
   * aggregate, not the schema). */
  trainingFocusKind: trainingFocusKind('training_focus_kind'),
  trainingFocusSurface: surface('training_focus_surface'),
  trainingFocusAttribute: trainableAttribute('training_focus_attribute'),

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
 * Generated players sitting unowned, visible to every manager, until
 * claimed or expired (see TalentPoolCandidate). Attribute columns
 * mirror `players` 1:1 (same flat-column convention, same reasoning),
 * since a claimed candidate's attributes become a real player's
 * attributes verbatim.
 *
 * `status` plus the conditional UPDATE in
 * DrizzleTalentPoolCandidateRepository.claimIfAvailable() (`WHERE
 * status = 'available'`) is the entire race-safety mechanism for
 * claiming — no row-level locking or SELECT ... FOR UPDATE needed,
 * since a single UPDATE's WHERE clause is itself atomic in Postgres.
 */
export const talentPoolCandidates = pgTable('talent_pool_candidates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nationality: text('nationality').notNull(),
  tier: playerRarityTier('tier').notNull(),
  /** Rolled at generation time by PlayerGenerationPolicy within
   * TALENT_POOL_AGE_RANGE (14-16 years) — see GeneratedPlayer.ageInWeeks.
   * Default only covers rows saved before this column existed. */
  ageInWeeks: integer('age_in_weeks').notNull().default(15 * 52),

  serve: integer('serve').notNull(),
  forehand: integer('forehand').notNull(),
  backhand: integer('backhand').notNull(),
  volley: integer('volley').notNull(),
  speed: integer('speed').notNull(),
  stamina: integer('stamina').notNull(),
  strength: integer('strength').notNull(),
  consistency: integer('consistency').notNull(),
  clutch: integer('clutch').notNull(),
  affinityClay: integer('affinity_clay').notNull(),
  affinityGrass: integer('affinity_grass').notNull(),
  affinityHard: integer('affinity_hard').notNull(),
  affinityIndoor: integer('affinity_indoor').notNull(),

  /** Hidden — the real ceiling behind potentialTier below. Read by
   * DrizzleTalentPoolCandidateRepository so it can transfer onto the
   * resulting Player once claimed; MUST NEVER be read by
   * talentPoolRoutes.ts's DTO mapper. */
  potentialCeiling: integer('potential_ceiling').notNull(),
  /** Hidden per-physical-attribute training ceilings — see
   * players.speedCeiling's doc comment above; same non-exposure rule
   * applies here (talentPoolRoutes.ts's DTO mapper must never read
   * these). Default only covers rows saved before these columns
   * existed. */
  speedCeiling: integer('speed_ceiling').notNull().default(100),
  staminaCeiling: integer('stamina_ceiling').notNull().default(100),
  strengthCeiling: integer('strength_ceiling').notNull().default(100),
  /** The noisy, coarse tier scouting actually exposes — computed once
   * at generation time (see PlayerGenerationPolicy), not recomputed
   * per-request, so the same candidate always shows the same tier. */
  potentialTier: playerPotentialTier('potential_tier').notNull(),

  /** GameWeek value object flattened, same convention as elsewhere in
   * this schema — when this candidate was generated, the anchor the
   * 2-week expiry sweep compares against. */
  seasonGenerated: integer('season_generated').notNull(),
  weekGenerated: integer('week_generated').notNull(),

  status: talentPoolCandidateStatus('status').notNull().default('available'),
  /** No FK: managers aren't a stored aggregate anywhere in this schema
   * (manager_entitlements.manager_id is likewise a plain opaque id),
   * same convention as players.manager_id. */
  claimedByManagerId: text('claimed_by_manager_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  tier: tournamentTier('tier').notNull(),
  /** Null for senior tiers, required for junior tiers — see
   * Tournament.ageBand's doc comment. */
  ageBand: ageBand('age_band'),
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
