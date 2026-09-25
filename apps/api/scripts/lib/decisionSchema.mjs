#!/usr/bin/env node
/**
 * The agent decision schema — ONE validator, used by BOTH the pre-flight
 * `agentWeek.mjs write` CLI and the runner's collect phase (`agentSeason.mjs`).
 *
 * The whole point is that a naive agent's JSON mistake is caught at the
 * `write` step with a precise error path, instead of being NACKed after
 * landing. The runner still re-validates every file it finds (a file can
 * be placed there without going through the CLI), so the two can never
 * disagree about what "valid" means.
 *
 * Decision shape (schemaVersion 1):
 *   {
 *     "schemaVersion": 1,
 *     "runId": "...",
 *     "weekIndex": 0,
 *     "managerId": "agent-m1",
 *     "summary": "what this week's plan is, in prose",
 *     "actions": [ ... <= 40 ... ]
 *   }
 */

export const DECISION_SCHEMA_VERSION = 1;
export const MAX_ACTIONS = 40;

/**
 * Trainable attributes — deliberately the SAME set `PUT
 * /players/:id/training-focus`'s JSON schema accepts (see
 * playerRoutes.ts): the four technical, three physical, plus the
 * standalone `doubles` skill. Mental (`consistency`/`clutch`) is
 * structurally excluded — not a runtime choice, the API schema itself
 * refuses it.
 */
export const TRAINABLE_ATTRIBUTES = [
  'serve',
  'forehand',
  'backhand',
  'volley',
  'speed',
  'stamina',
  'strength',
  'doubles',
];

export const ACTION_TYPES = [
  'release',
  'claim',
  'dissolvePair',
  'createPair',
  'acceptPair',
  'enterSingles',
  'enterDoubles',
  'setTrainingFocus',
  'practice',
];

/** Per-type allowed keys; anything else is rejected (typo protection). */
const ACTION_FIELDS = {
  release: ['type', 'playerId'],
  claim: ['type', 'playerId'],
  dissolvePair: ['type', 'pairId'],
  createPair: ['type', 'playerA', 'playerB'],
  acceptPair: ['type', 'pairId'],
  enterSingles: ['type', 'playerId', 'tournamentId'],
  enterDoubles: ['type', 'playerId', 'tournamentId'],
  setTrainingFocus: ['type', 'playerId', 'attribute', 'effectiveFrom'],
  practice: ['type', 'playerId', 'days'],
};

/** The HTTP call the RUNNER issues for each action type, for RULES.md. */
export const ACTION_HTTP = {
  release: 'POST /players/:playerId/release',
  claim: 'POST /talent-pool/:playerId/claim  {managerId}',
  dissolvePair: 'POST /doubles-pairs/:pairId/dissolve',
  createPair: 'POST /doubles-pairs  {playerA, playerB}',
  acceptPair: 'POST /doubles-pairs/:pairId/accept',
  enterSingles: 'POST /tournaments/:tournamentId/entrants  {playerId}',
  enterDoubles: 'POST /tournaments/:tournamentId/doubles-entrants  {playerId}',
  setTrainingFocus: 'PUT /players/:playerId/training-focus  {focus:{kind:"attribute",attribute}, week?:{season,week}}',
  practice: 'POST /players/:playerId/practice  (run on each listed game day, before that day\'s tick)',
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(errors, value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path, message: 'must be a non-empty string' });
    return false;
  }
  return true;
}

function requireInteger(errors, value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `must be an integer in [${min}, ${max}]` });
    return false;
  }
  return true;
}

/**
 * Validates a decision object.
 *
 * Args:
 *   decision: The parsed JSON value.
 *   ctx: `{ runId, weekIndex, managerId, currentWeek? }`. `currentWeek` is
 *     `{season, week}` when available (the runner always has it; the CLI
 *     reads it from the open week file) and enables the
 *     "effectiveFrom must not be in the past" check.
 *
 * Returns:
 *   `{ ok: true, errors: [] }` or `{ ok: false, errors: [{path, message}] }`.
 */
export function validateDecision(decision, ctx) {
  const errors = [];
  if (!isPlainObject(decision)) {
    return { ok: false, errors: [{ path: '$', message: 'decision must be a JSON object' }] };
  }

  if (decision.schemaVersion !== DECISION_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `must be ${DECISION_SCHEMA_VERSION} (got ${JSON.stringify(decision.schemaVersion)})`,
    });
  }
  if (typeof decision.runId !== 'string' || decision.runId !== ctx.runId) {
    errors.push({ path: 'runId', message: `must equal the active run id "${ctx.runId}"` });
  }
  if (!Number.isInteger(decision.weekIndex) || decision.weekIndex !== ctx.weekIndex) {
    errors.push({ path: 'weekIndex', message: `must equal the current week index ${ctx.weekIndex}` });
  }
  if (typeof decision.managerId !== 'string' || decision.managerId !== ctx.managerId) {
    errors.push({ path: 'managerId', message: `must equal your manager id "${ctx.managerId}"` });
  }
  if (typeof decision.summary !== 'string') {
    errors.push({ path: 'summary', message: 'must be a string (may be empty)' });
  } else if (decision.summary.length > 2000) {
    errors.push({ path: 'summary', message: 'must be <= 2000 characters' });
  }

  if (!Array.isArray(decision.actions)) {
    errors.push({ path: 'actions', message: 'must be an array' });
    return { ok: errors.length === 0, errors };
  }
  if (decision.actions.length > MAX_ACTIONS) {
    errors.push({ path: 'actions', message: `has ${decision.actions.length} entries — at most ${MAX_ACTIONS} allowed` });
  }

  const currentAbs =
    ctx.currentWeek !== undefined && Number.isInteger(ctx.currentWeek?.season) && Number.isInteger(ctx.currentWeek?.week)
      ? ctx.currentWeek.season * 52 + ctx.currentWeek.week
      : null;

  decision.actions.forEach((action, i) => {
    const p = `actions[${i}]`;
    if (!isPlainObject(action)) {
      errors.push({ path: p, message: 'must be an object' });
      return;
    }
    if (!ACTION_TYPES.includes(action.type)) {
      errors.push({ path: `${p}.type`, message: `must be one of: ${ACTION_TYPES.join(', ')}` });
      return;
    }
    const allowed = ACTION_FIELDS[action.type];
    for (const key of Object.keys(action)) {
      if (!allowed.includes(key)) {
        errors.push({ path: `${p}.${key}`, message: `unknown field for action "${action.type}"` });
      }
    }

    switch (action.type) {
      case 'release':
      case 'claim': {
        requireString(errors, action.playerId, `${p}.playerId`);
        break;
      }
      case 'dissolvePair':
      case 'acceptPair': {
        requireString(errors, action.pairId, `${p}.pairId`);
        break;
      }
      case 'createPair': {
        const a = requireString(errors, action.playerA, `${p}.playerA`);
        const b = requireString(errors, action.playerB, `${p}.playerB`);
        if (a && b && action.playerA === action.playerB) {
          errors.push({ path: p, message: 'playerA and playerB must be different players' });
        }
        break;
      }
      case 'enterSingles':
      case 'enterDoubles': {
        requireString(errors, action.playerId, `${p}.playerId`);
        requireString(errors, action.tournamentId, `${p}.tournamentId`);
        break;
      }
      case 'setTrainingFocus': {
        requireString(errors, action.playerId, `${p}.playerId`);
        if (!TRAINABLE_ATTRIBUTES.includes(action.attribute)) {
          errors.push({
            path: `${p}.attribute`,
            message: `must be one of: ${TRAINABLE_ATTRIBUTES.join(', ')} (mental attributes are never trainable)`,
          });
        }
        if (action.effectiveFrom !== undefined) {
          const ef = action.effectiveFrom;
          if (!isPlainObject(ef)) {
            errors.push({ path: `${p}.effectiveFrom`, message: 'must be {season, week} when present' });
          } else {
            const okSeason = requireInteger(errors, ef.season, `${p}.effectiveFrom.season`, 1, 999);
            const okWeek = requireInteger(errors, ef.week, `${p}.effectiveFrom.week`, 1, 52);
            if (okSeason && okWeek && currentAbs !== null && ef.season * 52 + ef.week < currentAbs) {
              errors.push({
                path: `${p}.effectiveFrom`,
                message: `is in the past (${ef.season}/${ef.week}) — training focus can only be set for the current or a future week`,
              });
            }
          }
        }
        break;
      }
      case 'practice': {
        requireString(errors, action.playerId, `${p}.playerId`);
        if (!Array.isArray(action.days) || action.days.length === 0) {
          errors.push({ path: `${p}.days`, message: 'must be a non-empty array of game days 1..7' });
        } else {
          const seen = new Set();
          action.days.forEach((day, j) => {
            if (!Number.isInteger(day) || day < 1 || day > 7) {
              errors.push({ path: `${p}.days[${j}]`, message: 'must be an integer in [1, 7]' });
            } else if (seen.has(day)) {
              errors.push({ path: `${p}.days[${j}]`, message: `duplicate day ${day}` });
            }
            seen.add(day);
          });
        }
        break;
      }
      default:
        break;
    }
  });

  return { ok: errors.length === 0, errors };
}

/** Human-readable one-line-per-error rendering for CLI output. */
export function formatValidationErrors(errors) {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}
