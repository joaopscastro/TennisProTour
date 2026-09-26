/**
 * Pure digest-feed logic for the agent-played-season harness
 * (`agentSeason.mjs`), extracted so it is unit-testable without importing
 * the runner module (which executes `main()` on import).
 *
 * Two feed fixes live here, both driven by first-session agent reports:
 *   - `tournamentConcluded` — the `pendingEntries` filter. The old filter
 *     was `if (entry.hasStarted) continue`, but by the time a week's
 *     digest is built the rollover has already STARTED every tournament
 *     scheduled for that week, so a registration made last week always
 *     read `hasStarted: true` and the list was permanently empty.
 *   - `buildCandidateView` — the `canEnterNow` view. Rank-restricted
 *     events are LISTED as disabled-with-reason instead of vanishing, and
 *     the cap carries a truncation indicator.
 *
 * Everything here is pure: no I/O, no hidden fields, no API shapes beyond
 * the `toTournamentDto` fields the digest already reads.
 */
import { absoWeek } from './soakEvidence.mjs';

/** Tier prestige ordering for the nearest-week/tier candidate sort. */
export const TIER_PRESTIGE = {
  futures: 1,
  challenger: 2,
  tour: 3,
  major: 4,
  j30: 1,
  j60: 2,
  j100: 3,
  j200: 4,
  j300: 5,
  j500: 6,
  juniorMasters: 7,
};

export const MAX_CAN_ENTER_NOW = 10;
/** How many rank-restricted events are appended (disabled-with-reason)
 * after the enterable slice — a separate, small cap so the rule that
 * narrowed a player's slate is always visible without crowding out
 * actionable events. */
export const MAX_RESTRICTED_SHOWN = 3;

export function compactTournamentBase(t) {
  const totalRounds = Math.round(Math.log2(t.drawSize));
  return {
    id: t.id,
    name: t.name,
    tier: t.tier,
    circuit: t.circuit,
    ageBand: t.ageBand,
    surface: t.surface,
    hostCountry: t.hostCountry,
    weekScheduled: t.weekScheduled,
    drawSize: t.drawSize,
    totalRounds,
    mainDrawEntrants: t.mainDrawEntrants,
    doublesDrawSize: t.doublesDrawSize,
    doublesEntrants: Array.isArray(t.doublesEntrants) ? t.doublesEntrants.length : 0,
    obligatory: t.obligatory === true,
    managerEntrants: typeof t.managerEntrants === 'number' ? t.managerEntrants : null,
    championPoints: Array.isArray(t.pointsBreakdown) ? t.pointsBreakdown[0]?.points ?? null : null,
    championPrizeMoney: Array.isArray(t.prizeMoneyBreakdown) ? t.prizeMoneyBreakdown[0]?.prizeMoney ?? null : null,
  };
}

/**
 * Has this tournament's singles main draw CONCLUDED? Mirrors the domain's
 * `Tournament.isMainDrawFinished` (the same predicate the
 * `/tournaments?status=started` filter uses): false while the main draw
 * isn't seeded yet (deferred/qualifying included), true once the last
 * main round is fully decided. A cancelled draw is terminal too. Used by
 * `pendingEntries` so a just-registered entry in a draw that has started
 * (but not finished) is reported, instead of being filtered away by the
 * old `hasStarted` check.
 */
export function tournamentConcluded(t) {
  if (t.cancelled === true) return true;
  const rounds = Array.isArray(t.rounds) ? t.rounds : [];
  if (rounds.length === 0) return false;
  const last = rounds[rounds.length - 1];
  const matches = Array.isArray(last.matches) ? last.matches : [];
  return matches.length > 0 && matches.every((m) => m.outcome != null);
}

export function compactCandidate(t) {
  // A rank-restricted row is LISTED (disabled-with-reason) rather than
  // omitted — see buildCandidateView. The reason text is the same string
  // the registration use cases put in their refusal.
  const restricted = t.rankRestricted === true;
  return {
    ...compactTournamentBase(t),
    entryViaQualifying: t.entryViaQualifying === true,
    qualifyingFieldFull: t.qualifyingFieldFull === true,
    qualifyingFieldSize: t.qualifyingFieldSize ?? 0,
    qualifyingFieldTaken: t.qualifyingFieldTaken ?? 0,
    rankRestricted: restricted,
    rankRestrictedReason: t.rankRestrictedReason ?? null,
    weeklyEntryCountThisWeek: t.weeklyEntryCountThisWeek ?? null,
    weeklyEntryCapThisWeek: t.weeklyEntryCapThisWeek ?? null,
    /** Whether the runner will actually submit an entry for this row. */
    enterable: !restricted,
    /** Why not, when `enterable` is false (null otherwise). */
    blockedReason: restricted ? t.rankRestrictedReason ?? 'ranking is too high for this tier' : null,
  };
}

/**
 * Why the runner cannot submit an entry for `t` right now, or null when it
 * can. Rank restriction is deliberately NOT part of this check — those
 * rows are surfaced disabled-with-reason instead (see buildCandidateView).
 */
export function enterabilityBlockReason(t, currentAbs) {
  if (t.hasStarted || t.registrationOpen === false) return 'entries are closed';
  if (t.ageEligible === false) return 'not age-eligible for this band';
  if (
    typeof t.weeklyEntryCountThisWeek === 'number' &&
    typeof t.weeklyEntryCapThisWeek === 'number' &&
    t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek
  ) {
    return 'weekly entry cap reached';
  }
  const mainRoom = (t.mainDrawEntrants ?? 0) < t.drawSize;
  const qualifyingRoom = t.entryViaQualifying === true && t.qualifyingFieldFull !== true;
  if (!mainRoom && !qualifyingRoom) return 'the draw is full';
  if (absoWeek(t.weekScheduled) < currentAbs) return 'the week has already passed';
  return null;
}

export function compareCandidates(a, b) {
  const weekDiff = absoWeek(a.weekScheduled) - absoWeek(b.weekScheduled);
  if (weekDiff !== 0) return weekDiff;
  const tierDiff = (TIER_PRESTIGE[b.tier] ?? 0) - (TIER_PRESTIGE[a.tier] ?? 0);
  if (tierDiff !== 0) return tierDiff;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * The player-scoped entry candidates, with the two feed fixes the agents
 * asked for:
 *   - rank-restricted events are INCLUDED as `enterable: false` rows with
 *     `blockedReason` (they used to vanish silently, which read as a bug
 *     rather than a rule) — appended AFTER the enterable slice and capped
 *     separately, so a long enterable list can never squeeze them out;
 *   - the cap carries a truncation indicator (`canEnterNowMeta`), so the
 *     shown slice is never mistaken for the whole slate.
 * Enterable rows sort first (nearest week, then tier).
 */
export function buildCandidateView(openList, currentAbs) {
  const enterable = [];
  const restricted = [];
  for (const t of openList) {
    if (t.rankRestricted === true) {
      restricted.push(t);
      continue;
    }
    if (enterabilityBlockReason(t, currentAbs) !== null) continue;
    enterable.push(t);
  }
  enterable.sort(compareCandidates);
  restricted.sort(compareCandidates);
  const enterableShown = enterable.slice(0, MAX_CAN_ENTER_NOW);
  const restrictedShown = restricted.slice(0, MAX_RESTRICTED_SHOWN);
  const rows = [...enterableShown, ...restrictedShown].map(compactCandidate);
  return {
    rows,
    meta: {
      shown: rows.length,
      enterableShown: enterableShown.length,
      enterableTotal: enterable.length,
      restrictedShown: restrictedShown.length,
      restrictedTotal: restricted.length,
      truncated: enterable.length > enterableShown.length || restricted.length > restrictedShown.length,
    },
  };
}
