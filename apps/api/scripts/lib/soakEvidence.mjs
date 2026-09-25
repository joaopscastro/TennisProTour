#!/usr/bin/env node
/**
 * SQL-backed evidence collectors shared by `soak.mjs` (the bot soak
 * harness) and `agentSeason.mjs` (the LLM-agent season harness).
 *
 * These functions were extracted verbatim out of `soak.mjs` (the SQL is
 * byte-identical — no query was rewritten, only its inputs were
 * parameterised) so both harnesses produce PROVABLY the same evidence
 * sets. Every claim is a `{ sql, params, rows }` triple; never a
 * narrative.
 *
 * Parameterisation notes (the only changes from soak.mjs's originals):
 *   - `snapshotTracked(db, ids)` takes the tracked ids explicitly instead
 *     of reading the soak runner's module-level `runtime`.
 *   - `collectFinalEvidence(db, { ids, worldId, currentAbs })` takes the
 *     current week / world id explicitly instead of calling the soak
 *     HTTP client itself — the caller owns "what is now".
 *   - `collectStrategyOutcomes(db, ids)` likewise.
 * Everything else is untouched.
 */

/** Tiny query helper — same shape soak.mjs always used. */
export async function q(db, sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows;
}

export const evidence = (claim, statements) => ({ claim, statements });

/** Absolute week number (`season * 52 + week`) — the same arithmetic the
 * domain's `weeksBetween` uses; kept here so evidence SQL and the
 * harnesses agree on what "within N weeks" means. */
export function absoWeek(w) {
  return w.season * 52 + w.week;
}

/** Per-week tournament-health counters, captured BEFORE any prune. */
export async function weeklyHealth(db, currentAbs) {
  const rows = await q(
    db,
    `SELECT
       (SELECT count(*) FROM tournaments WHERE has_started = false
         AND (season_scheduled * 52 + week_scheduled) < $1) AS never_started,
       (SELECT count(*) FROM tournaments WHERE has_started = true) AS started,
       (SELECT count(*) FROM tournament_matches) AS matches,
       (SELECT count(*) FROM tournaments WHERE has_started = false) AS open`,
    [currentAbs],
  );
  return rows[0];
}

/**
 * Deletes only never-started, zero-entrant open tournaments more than 3
 * weeks past their week. See soak.mjs's PRUNE_STUCK doc comment: the
 * product has no expiry path for a draw that never fills, so this keeps
 * long runs from growing quadratically. The pre-prune pile size is
 * always snapshotted first (`weeklyHealth`), so the product gap stays
 * visible in the report rather than being silently swallowed.
 */
export async function pruneStuckTournaments(db, currentAbs) {
  const rows = await q(
    db,
    `DELETE FROM tournaments t
     WHERE t.has_started = false
       AND (t.season_scheduled * 52 + t.week_scheduled) < $1
       AND NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM weekly_entry_claims c WHERE c.tournament_id = t.id)
     RETURNING t.id`,
    [currentAbs],
  );
  return rows.length;
}

/**
 * Bootstrap normalization (disclosed harness step): `bootstrapTestWorld`'s
 * phase 4 pre-opens the WHOLE remaining season's senior calendar (~259 open
 * tournaments), which makes every weekly rollover load them all. Production's
 * weekly generator only ever opens NEXT week, so steady state is ~30 open
 * tournaments, not ~290. On a fresh run this deletes the far-future
 * pre-opened senior tournaments (they were opened with zero entrants and are
 * re-created naturally by the weekly generator), restoring a production-like
 * open set. Never touches the current or next two weeks.
 */
export async function normalizeBootstrap(db, currentAbs) {
  const rows = await q(
    db,
    `DELETE FROM tournaments t
     WHERE t.has_started = false
       AND (t.season_scheduled * 52 + t.week_scheduled) > $1
       AND NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM weekly_entry_claims c WHERE c.tournament_id = t.id)
     RETURNING t.id`,
    [currentAbs + 2],
  );
  return rows.length;
}

/**
 * Match-row archival (HARNESS MITIGATION, disclosed): the product never
 * prunes `tournament_matches`, so every finished tournament is reloaded in
 * full by `findStarted()` on every day tick forever. For finished, old
 * tournaments with NO tracked-player entry, this keeps only the FINAL round
 * (so "never concluded" detection still works) and drops earlier rounds and
 * all doubles matches. It does not touch ranking_ledger, titles, entries or
 * XP, so economy/ranking/title evidence is unaffected; per-match evidence for
 * tracked players is preserved by the tracked-player exclusion.
 */
export async function archiveOldMatchRows(db, currentAbs, trackedIds) {
  const ids = trackedIds.length > 0 ? trackedIds : ['__none__'];
  const archivableCte = `
    WITH finals AS (
      SELECT tournament_id, MAX(round_number) AS rn
      FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
    ),
    archivable AS (
      SELECT t.id, f.rn
      FROM tournaments t JOIN finals f ON f.tournament_id = t.id
      WHERE t.has_started = true
        AND (t.season_scheduled * 52 + t.week_scheduled) < $1
        AND NOT EXISTS (SELECT 1 FROM tournament_matches fm
                        WHERE fm.tournament_id = t.id AND fm.draw = 'main'
                          AND fm.round_number = f.rn AND fm.winner_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM tournament_entries e
                        WHERE e.tournament_id = t.id AND e.player_id = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM tournament_doubles_entrants de
                        WHERE de.tournament_id = t.id AND de.player_id = ANY($2::text[]))
    )`;
  const mainDeleted = await q(
    db,
    `${archivableCte}
     DELETE FROM tournament_matches tm
     USING archivable a
     WHERE tm.tournament_id = a.id AND tm.draw = 'main' AND tm.round_number < a.rn
     RETURNING tm.tournament_id`,
    [currentAbs - 3, ids],
  );
  const doublesDeleted = await q(
    db,
    `${archivableCte}
     DELETE FROM tournament_doubles_matches dm
     USING archivable a
     WHERE dm.tournament_id = a.id
     RETURNING dm.tournament_id`,
    [currentAbs - 3, ids],
  );
  return { mainDeleted: mainDeleted.length, doublesDeleted: doublesDeleted.length };
}

/** Raw skill/XP/money snapshot for a cohort of tracked players. */
export async function snapshotTracked(db, ids) {
  if (ids.length === 0) return [];
  const rows = await q(
    db,
    `SELECT id, name, stage, age_in_weeks, serve, forehand, backhand, volley, speed, stamina, strength,
            consistency, clutch, doubles, experience, fatigue, form, career_prize_money, season_prize_money
     FROM players WHERE id = ANY($1::text[]) ORDER BY id`,
    [ids],
  );
  return rows;
}

export async function snapshotEconomy(db, managerIds) {
  const rows = await q(
    db,
    `SELECT
       (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
       (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
       (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
       (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
       (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`,
    [],
  );
  const perManagerXp = await q(
    db,
    `SELECT manager_id, xp_balance FROM manager_progression WHERE manager_id = ANY($1::text[]) ORDER BY manager_id`,
    [managerIds],
  );
  const perManagerLadder = await q(
    db,
    `SELECT manager_id, score FROM manager_ladder WHERE manager_id = ANY($1::text[]) ORDER BY manager_id`,
    [managerIds],
  );
  return { totals: rows[0], perManagerXp, perManagerLadder };
}

export function cohortDeltas(weekly, ids) {
  if (weekly.length === 0) return [];
  const first = weekly[0];
  const last = weekly[weekly.length - 1];
  const firstById = new Map(first.map((r) => [r.id, r]));
  const lastById = new Map(last.map((r) => [r.id, r]));
  const skillCols = ['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength', 'consistency', 'clutch', 'doubles'];
  return ids.map((id) => {
    const a = firstById.get(id);
    const b = lastById.get(id);
    if (!a || !b) return { id, present: false };
    const skillDelta = {};
    let skillsMoved = 0;
    for (const c of skillCols) {
      const d = Number(b[c]) - Number(a[c]);
      skillDelta[c] = Number(d.toFixed(3));
      if (Math.abs(d) > 0.01) skillsMoved += 1;
    }
    const expDelta = Number((Number(b.experience) - Number(a.experience)).toFixed(3));
    const ovr = (row) => {
      const vals = ['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength', 'consistency', 'clutch'];
      return vals.reduce((s, c) => s + Number(row[c]), 0) / vals.length;
    };
    return {
      id,
      name: b.name,
      stageStart: a.stage,
      stageEnd: b.stage,
      experienceDelta: expDelta,
      overallDelta: Number((ovr(b) - ovr(a)).toFixed(3)),
      skillsMoved,
      skillDelta,
      // The exact old-bug signature: XP/experience accumulating while every
      // skill column stays flat.
      experienceRisingSkillsFlat: expDelta > 0.5 && skillsMoved === 0,
    };
  });
}

/**
 * The full final evidence set — identical SQL to soak.mjs's collector,
 * with the clock/world/ids passed in by the caller.
 *
 * Args:
 *   db: A connected pg client/pool handle.
 *   opts.ids: Tracked player ids.
 *   opts.worldId: The game world id (for the world-clock evidence row).
 *   opts.currentAbs: Absolute week number (`absoWeek(clock.currentWeek)`).
 */
export async function collectFinalEvidence(db, { ids, worldId, currentAbs }) {
  const ev = {};

  ev.entryCap = evidence(
    'No tracked player exceeds the weekly entry cap (1 senior / 3 junior, singles+doubles deduped by tournament).',
    [{
      sql: `WITH combined AS (
              SELECT e.player_id, t.season_scheduled AS season, t.week_scheduled AS week,
                     (t.age_band IS NOT NULL) AS is_junior, t.id AS tournament_id
              FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
              UNION ALL
              SELECT de.player_id, t.season_scheduled, t.week_scheduled,
                     (t.age_band IS NOT NULL), t.id
              FROM tournament_doubles_entrants de JOIN tournaments t ON t.id = de.tournament_id
            )
            SELECT player_id, season, week, is_junior, count(DISTINCT tournament_id) AS entries
            FROM combined
            WHERE player_id = ANY($1::text[])
            GROUP BY player_id, season, week, is_junior
            HAVING count(DISTINCT tournament_id) > CASE WHEN is_junior THEN 3 ELSE 1 END
            ORDER BY player_id, season, week`,
      params: [ids],
      rows: await q(db, `WITH combined AS (
              SELECT e.player_id, t.season_scheduled AS season, t.week_scheduled AS week,
                     (t.age_band IS NOT NULL) AS is_junior, t.id AS tournament_id
              FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
              UNION ALL
              SELECT de.player_id, t.season_scheduled, t.week_scheduled,
                     (t.age_band IS NOT NULL), t.id
              FROM tournament_doubles_entrants de JOIN tournaments t ON t.id = de.tournament_id
            )
            SELECT player_id, season, week, is_junior, count(DISTINCT tournament_id) AS entries
            FROM combined
            WHERE player_id = ANY($1::text[])
            GROUP BY player_id, season, week, is_junior
            HAVING count(DISTINCT tournament_id) > CASE WHEN is_junior THEN 3 ELSE 1 END
            ORDER BY player_id, season, week`, [ids]),
    }],
  );

  ev.neverStarted = evidence(
    'No tournament remained open past its scheduled week (has_started = false with week_scheduled < current week).',
    [{
      sql: `SELECT id, name, tier, age_band, season_scheduled, week_scheduled
            FROM tournaments
            WHERE has_started = false AND (season_scheduled * 52 + week_scheduled) < $1
            ORDER BY season_scheduled, week_scheduled LIMIT 200`,
      params: [currentAbs],
      rows: await q(db, `SELECT id, name, tier, age_band, season_scheduled, week_scheduled
            FROM tournaments
            WHERE has_started = false AND (season_scheduled * 52 + week_scheduled) < $1
            ORDER BY season_scheduled, week_scheduled LIMIT 200`, [currentAbs]),
    },
    {
      sql: `SELECT tier, age_band, count(*) AS n,
                   count(*) FILTER (WHERE entrant_count = 0) AS zero_entrant
            FROM (
              SELECT t.id, t.tier, t.age_band,
                     (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = t.id) AS entrant_count
              FROM tournaments t
              WHERE t.has_started = false AND (t.season_scheduled * 52 + t.week_scheduled) < $1
            ) s
            GROUP BY tier, age_band ORDER BY n DESC`,
      params: [currentAbs],
      rows: await q(db, `SELECT tier, age_band, count(*) AS n,
                   count(*) FILTER (WHERE entrant_count = 0) AS zero_entrant
            FROM (
              SELECT t.id, t.tier, t.age_band,
                     (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = t.id) AS entrant_count
              FROM tournaments t
              WHERE t.has_started = false AND (t.season_scheduled * 52 + t.week_scheduled) < $1
            ) s
            GROUP BY tier, age_band ORDER BY n DESC`, [currentAbs]),
    }],
  );

  ev.neverConcluded = evidence(
    'Every started tournament at least 3 weeks past its scheduled week has a decided main draw.',
    [{
      sql: `WITH last_round AS (
              SELECT tournament_id, MAX(round_number) AS rn
              FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
            )
            SELECT t.id, t.name, t.tier, t.age_band, t.season_scheduled, t.week_scheduled, lr.rn,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn) AS final_matches,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) AS final_undecided
            FROM tournaments t
            LEFT JOIN last_round lr ON lr.tournament_id = t.id
            WHERE t.has_started = true
              AND (t.season_scheduled * 52 + t.week_scheduled) < $1
              AND NOT EXISTS (SELECT 1 FROM titles ti WHERE ti.tournament_id = t.id)
              AND (lr.rn IS NULL OR (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) > 0)
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`,
      params: [currentAbs - 3],
      rows: await q(db, `WITH last_round AS (
              SELECT tournament_id, MAX(round_number) AS rn
              FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
            )
            SELECT t.id, t.name, t.tier, t.age_band, t.season_scheduled, t.week_scheduled, lr.rn,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn) AS final_matches,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) AS final_undecided
            FROM tournaments t
            LEFT JOIN last_round lr ON lr.tournament_id = t.id
            WHERE t.has_started = true
              AND (t.season_scheduled * 52 + t.week_scheduled) < $1
              AND NOT EXISTS (SELECT 1 FROM titles ti WHERE ti.tournament_id = t.id)
              AND (lr.rn IS NULL OR (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) > 0)
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`, [currentAbs - 3]),
    }],
  );

  ev.underfilled = evidence(
    'No started tournament has fewer entrants than its draw size.',
    [{
      sql: `SELECT t.id, t.name, t.tier, t.age_band, t.draw_size, count(e.player_id) AS entrants
            FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
            WHERE t.has_started = true
            GROUP BY t.id, t.name, t.tier, t.age_band, t.draw_size
            HAVING count(e.player_id) < t.draw_size
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`,
      params: [],
      rows: await q(db, `SELECT t.id, t.name, t.tier, t.age_band, t.draw_size, count(e.player_id) AS entrants
            FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
            WHERE t.has_started = true
            GROUP BY t.id, t.name, t.tier, t.age_band, t.draw_size
            HAVING count(e.player_id) < t.draw_size
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`, []),
    }],
  );

  ev.titlesAndLedger = evidence(
    'Titles and ranking-ledger rows exist and no ranking-ledger row has negative points.',
    [
      { sql: 'SELECT count(*) AS singles_titles FROM titles', params: [], rows: await q(db, 'SELECT count(*) AS singles_titles FROM titles') },
      { sql: 'SELECT count(*) AS doubles_titles FROM doubles_titles', params: [], rows: await q(db, 'SELECT count(*) AS doubles_titles FROM doubles_titles') },
      { sql: `SELECT count(*) AS ledger_rows,
                     count(*) FILTER (WHERE points < 0) AS negative_points,
                     count(*) FILTER (WHERE obligatory) AS obligatory_zeros,
                     COALESCE(min(points),0) AS min_points, COALESCE(max(points),0) AS max_points
              FROM ranking_ledger`, params: [], rows: await q(db, `SELECT count(*) AS ledger_rows,
                     count(*) FILTER (WHERE points < 0) AS negative_points,
                     count(*) FILTER (WHERE obligatory) AS obligatory_zeros,
                     COALESCE(min(points),0) AS min_points, COALESCE(max(points),0) AS max_points
              FROM ranking_ledger`) },
    ],
  );

  ev.worldClock = evidence('The world clock is monotonic and has a single applied tick key.', [
    {
      sql: 'SELECT id, season, week, current_day, last_applied_tick FROM game_worlds WHERE id = $1',
      params: [worldId],
      rows: await q(db, 'SELECT id, season, week, current_day, last_applied_tick FROM game_worlds WHERE id = $1', [worldId]),
    },
  ]);

  ev.playerStateSanity = evidence('No player has an out-of-range skill/fatigue/form/money value; no retired player is managed.', [
    {
      sql: `SELECT count(*) AS out_of_range FROM players
            WHERE age_in_weeks < 0 OR fatigue < 0 OR fatigue > 100 OR form < 0 OR form > 100
               OR serve < 0 OR serve > 100 OR forehand < 0 OR forehand > 100 OR backhand < 0 OR backhand > 100
               OR volley < 0 OR volley > 100 OR speed < 0 OR speed > 100 OR stamina < 0 OR stamina > 100
               OR strength < 0 OR strength > 100 OR consistency < 0 OR consistency > 100
               OR clutch < 0 OR clutch > 100 OR doubles < 0 OR doubles > 100
               OR experience < 0 OR career_prize_money < 0 OR season_prize_money < 0`,
      params: [],
      rows: await q(db, `SELECT count(*) AS out_of_range FROM players
            WHERE age_in_weeks < 0 OR fatigue < 0 OR fatigue > 100 OR form < 0 OR form > 100
               OR serve < 0 OR serve > 100 OR forehand < 0 OR forehand > 100 OR backhand < 0 OR backhand > 100
               OR volley < 0 OR volley > 100 OR speed < 0 OR speed > 100 OR stamina < 0 OR stamina > 100
               OR strength < 0 OR strength > 100 OR consistency < 0 OR consistency > 100
               OR clutch < 0 OR clutch > 100 OR doubles < 0 OR doubles > 100
               OR experience < 0 OR career_prize_money < 0 OR season_prize_money < 0`),
    },
    {
      sql: `SELECT count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NOT NULL) AS retired_but_managed,
                   count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NULL) AS retired_free_agents
            FROM players`,
      params: [],
      rows: await q(db, `SELECT count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NOT NULL) AS retired_but_managed,
                   count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NULL) AS retired_free_agents
            FROM players`),
    },
  ]);

  ev.fatigueForm = evidence(
    'Fatigue/form distributions for ALL players (context) and for the TRACKED cohort (where a pin is a real signal, since idle fill-only players legitimately sit at fatigue 0).',
    [
      {
        sql: `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players`,
        params: [],
        rows: await q(db, `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred FROM players`),
      },
      {
        sql: `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three FROM players`,
        params: [],
        rows: await q(db, `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three FROM players`),
      },
      {
        sql: `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players WHERE id = ANY($1::text[])`,
        params: [ids],
        rows: await q(db, `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players WHERE id = ANY($1::text[])`, [ids]),
      },
      {
        sql: `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three
              FROM players WHERE id = ANY($1::text[])`,
        params: [ids],
        rows: await q(db, `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three
              FROM players WHERE id = ANY($1::text[])`, [ids]),
      },
    ],
  );

  ev.economy = evidence('Economy totals across the run.', [
    {
      sql: `SELECT
              (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
              (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
              (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
              (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
              (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`,
      params: [],
      rows: await q(db, `SELECT
              (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
              (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
              (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
              (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
              (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`),
    },
  ]);

  return ev;
}

/** Per-manager match/entry/title/points outcomes for the tracked cohort. */
export async function collectStrategyOutcomes(db, ids) {
  if (ids.length === 0) return null;
  const matchRecords = await q(
    db,
    `WITH sides AS (
       SELECT m.tournament_id, m.winner_id, m.entrant_a AS player_id
       FROM tournament_matches m WHERE m.winner_id IS NOT NULL
       UNION ALL
       SELECT m.tournament_id, m.winner_id, m.entrant_b
       FROM tournament_matches m WHERE m.winner_id IS NOT NULL
     )
     SELECT p.manager_id, t.tier, (t.age_band IS NOT NULL) AS is_junior,
            count(*) AS matches, count(*) FILTER (WHERE s.winner_id = s.player_id) AS wins
     FROM sides s JOIN players p ON p.id = s.player_id JOIN tournaments t ON t.id = s.tournament_id
     WHERE s.player_id = ANY($1::text[])
     GROUP BY p.manager_id, t.tier, (t.age_band IS NOT NULL)
     ORDER BY p.manager_id, t.tier`,
    [ids],
  );
  const entries = await q(
    db,
    `SELECT p.manager_id, t.tier, count(*) AS entries
     FROM tournament_entries e JOIN players p ON p.id = e.player_id JOIN tournaments t ON t.id = e.tournament_id
     WHERE e.player_id = ANY($1::text[])
     GROUP BY p.manager_id, t.tier ORDER BY p.manager_id, t.tier`,
    [ids],
  );
  const doublesEntries = await q(
    db,
    `SELECT p.manager_id, count(*) AS entries
     FROM tournament_doubles_entrants de JOIN players p ON p.id = de.player_id
     WHERE de.player_id = ANY($1::text[]) GROUP BY p.manager_id ORDER BY p.manager_id`,
    [ids],
  );
  const titles = await q(
    db,
    `SELECT p.manager_id, ti.tier, (ti.age_band IS NOT NULL) AS is_junior, count(*) AS titles
     FROM titles ti JOIN players p ON p.id = ti.player_id
     WHERE ti.player_id = ANY($1::text[]) GROUP BY p.manager_id, ti.tier, (ti.age_band IS NOT NULL)
     ORDER BY p.manager_id, ti.tier`,
    [ids],
  );
  const points = await q(
    db,
    `SELECT p.manager_id, rl.tier, COALESCE(sum(rl.points),0) AS points, count(*) AS results
     FROM ranking_ledger rl JOIN players p ON p.id = rl.player_id
     WHERE rl.player_id = ANY($1::text[]) GROUP BY p.manager_id, rl.tier ORDER BY p.manager_id, rl.tier`,
    [ids],
  );
  return {
    matchRecords: { sql: 'sides CTE over tournament_matches joined to players/tournaments', rows: matchRecords },
    entries: { sql: 'tournament_entries grouped by manager/tier', rows: entries },
    doublesEntries: { sql: 'tournament_doubles_entries grouped by manager', rows: doublesEntries },
    titles: { sql: 'titles grouped by manager/tier', rows: titles },
    points: { sql: 'ranking_ledger grouped by manager/tier', rows: points },
  };
}
