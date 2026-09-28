/**
 * Pure digest-feed logic for the agent-played-season harness
 * (`agentSeason.mjs`), extracted so it is unit-testable without importing
 * the runner module (which executes `main()` on import).
 *
 * What lives here, all driven by agent-reported harness findings:
 *   - `tournamentConcluded` — the `pendingEntries` filter. The old filter
 *     was `if (entry.hasStarted) continue`, but by the time a week's
 *     digest is built the rollover has already STARTED every tournament
 *     scheduled for that week, so a registration made last week always
 *     read `hasStarted: true` and the list was permanently empty.
 *   - `buildCandidateView` — the `canEnterNow` view. Rule-restricted
 *     events (rank too high for the tier, or the tier's per-season soft
 *     cap used up) are LISTED as disabled-with-reason instead of
 *     vanishing,
 *     the cap is honest (`truncated`, `enterableTotal`, `hiddenCount`),
 *     and it is high enough to cover the observed slate — the old cap of
 *     10 truncated 302 of 304 measured snapshots, hiding up to 22
 *     enterable events.
 *   - `compareCandidates` / `selectWeekEvents` — the ordering and the
 *     `openByWeek` per-week selection. Senior tiers now sort above junior
 *     tiers (a j200 used to outrank a `tour` event purely on tier
 *     prestige), and a week can never silently drop its senior `tour`/
 *     `major` events; anything not shown is reported as `hiddenCount`.
 *   - the digest's roster mappers (`compactSinglesTitles`,
 *     `compactDoublesTitles`, `compactLastResults`) — doubles titles and
 *     doubles results are first-class digest content, not invisible.
 *   - the decision-replacement predicate + reconciler (`hashDecisionContent`,
 *     `decisionNeedsReaccept`, `reconcileDecisions`) — a rewritten
 *     decision file used to be ignored forever once the manager was
 *     accepted; now it replaces the accepted snapshot while the phase is
 *     still pre-apply.
 *
 * Everything here is pure: no I/O, no hidden fields, no API shapes beyond
 * the `toTournamentDto` / profile / matches fields the digest already
 * reads.
 */
import { createHash } from 'node:crypto';
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

/**
 * How many enterable candidates `canEnterNow` shows. Raised from 10 to 32:
 * measured across 304 harness snapshots the old cap truncated 302 of them,
 * hiding up to 22 enterable events at once — enough for a senior `tour`
 * tier to be invisible for a whole week (25 snapshots), which the agents
 * could not tell apart from "no tour event exists". 32 covers the
 * observed maximum; anything beyond it is reported honestly via
 * `canEnterNowMeta` (`truncated`, `enterableTotal`, `hiddenCount`).
 */
export const MAX_CAN_ENTER_NOW = 32;
/** How many rule-restricted events (rank too high for the tier, or the
 * tier's per-season entry cap used up) are appended
 * (disabled-with-reason) after the enterable slice — a separate, small
 * cap so the rule that narrowed a player's slate is always visible
 * without crowding out actionable events. */
export const MAX_RESTRICTED_SHOWN = 3;

/**
 * `openByWeek`'s per-week caps. The old single cap of 6 events per week
 * (with no per-tier cap) let a junior-heavy week push the week's senior
 * `tour` event out of the list entirely. Now at most
 * `MAX_EVENTS_PER_WEEK_TIER` events of any one tier are shown, every
 * senior `tour`/`major` is ALWAYS included, and whatever is left out is
 * counted per week as `hiddenCount`.
 */
export const MAX_EVENTS_PER_WEEK = 24;
export const MAX_EVENTS_PER_WEEK_TIER = 2;

/** The tiers `openByWeek` must never hide for their own week, and that
 * `canEnterNow` pins into its shown slice even when the cap truncates —
 * a senior tour/major event is exactly what an agent cannot afford to
 * miss (obligatory events, the biggest points/prize). */
export const PINNED_SENIOR_TIERS = ['tour', 'major'];

export function isPinnedSeniorEvent(t) {
  return t.circuit === 'senior' && PINNED_SENIOR_TIERS.includes(t.tier);
}

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
  // A rule-restricted row — rank too high for the tier, or the tier's
  // per-season soft cap used up — is LISTED (disabled-with-reason) rather
  // than omitted; see buildCandidateView. The reason text is the same
  // string the registration use cases put in their refusal, so the
  // digest's disabled state and the server's 409 can never disagree.
  const restricted = t.rankRestricted === true;
  const seasonCapped = t.seasonCapRestricted === true;
  const blockedReason = restricted
    ? t.rankRestrictedReason ?? 'ranking is too high for this tier'
    : seasonCapped
      ? t.seasonCapReason ?? 'the per-season entry limit for this tier is reached'
      : null;
  return {
    ...compactTournamentBase(t),
    entryViaQualifying: t.entryViaQualifying === true,
    qualifyingFieldFull: t.qualifyingFieldFull === true,
    qualifyingFieldSize: t.qualifyingFieldSize ?? 0,
    qualifyingFieldTaken: t.qualifyingFieldTaken ?? 0,
    rankRestricted: restricted,
    rankRestrictedReason: t.rankRestrictedReason ?? null,
    // Batch 4B's challenger soft cap (F1): the API's player-scoped open
    // list already carries these fields; without mapping them here a
    // capped top-50 player's challenger row read `enterable: true` and
    // the runner's POST was refused — the exact preview-vs-enforcement
    // disagreement the rank fields above were added to prevent.
    seasonCapRestricted: seasonCapped,
    seasonCapReason: t.seasonCapReason ?? null,
    seasonCapUsedThisSeason: t.seasonCapUsedThisSeason ?? null,
    seasonCapLimitThisSeason: t.seasonCapLimitThisSeason ?? null,
    weeklyEntryCountThisWeek: t.weeklyEntryCountThisWeek ?? null,
    weeklyEntryCapThisWeek: t.weeklyEntryCapThisWeek ?? null,
    /** Whether the runner will actually submit an entry for this row. */
    enterable: !restricted && !seasonCapped,
    /** Why not, when `enterable` is false (null otherwise). */
    blockedReason,
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

/** How many currently-committed (unsignable) free agents the digest still
 * shows, as the "show all / committed" affordance — enough to know strong
 * prospects exist and are locked by a live draw, without bloating the
 * digest. */
export const MAX_COMMITTED_SHOWN = 8;

/**
 * The digest's talent pool, fixed against the measured blind spot: the
 * digest used to request the youngest 256 free agents and filter to
 * signable CLIENT-side, so once that young cohort was committed to draws
 * the pool read as EMPTY even though the API guarantees ~25+ signable
 * free agents deeper in the pool (the 52-week agent season's "one agent
 * made exactly one signing all season; another escaped using ids from an
 * earlier week's digest"). This splits the two server-side reads:
 *
 *   - `signableBody` — `GET /talent-pool?signableOnly=true`, the SAME
 *     predicate the atomic claim enforces, so a shown row can never be
 *     refused as committed;
 *   - `allBody` — the unfiltered youngest page, source of the committed
 *     list (an honest "these exist but are locked by a live draw" view).
 *
 * `meta.availableTotal` is the API's own count, so the digest's number
 * and the API's number are the same number, never a re-derivation.
 * Pure: accepts the raw response bodies (array or `{ candidates, ... }`)
 * and applies no sorting — the runner's own overall-desc ordering runs
 * after this.
 */
export function selectTalentPool(signableBody, allBody) {
  const candidates = Array.isArray(signableBody)
    ? signableBody
    : (signableBody && Array.isArray(signableBody.candidates) ? signableBody.candidates : []);
  const all = Array.isArray(allBody) ? allBody : (allBody && Array.isArray(allBody.candidates) ? allBody.candidates : []);
  const signable = candidates.filter((a) => a.signingBlocked !== true);
  const signableIds = new Set(signable.map((a) => a.id));
  const committed = all
    .filter((a) => a.signingBlocked === true && !signableIds.has(a.id))
    .slice(0, MAX_COMMITTED_SHOWN);
  const availableTotal = Array.isArray(signableBody)
    ? signable.length
    : typeof signableBody?.availableTotal === 'number'
      ? signableBody.availableTotal
      : signable.length;
  const poolTotal = Array.isArray(allBody)
    ? all.length
    : typeof allBody?.poolTotal === 'number'
      ? allBody.poolTotal
      : all.length;
  return {
    signable,
    committed,
    meta: { availableTotal, poolTotal, committedShown: committed.length },
  };
}

/**
 * Nearest week first, then SENIOR circuit before junior, then tier
 * prestige. The senior-first key is the fix for a measured ordering bug:
 * with only the flat `TIER_PRESTIGE` map, a junior j200 (prestige 4)
 * sorted above a senior `tour` (prestige 3) in the same week, so a
 * truncated list could show a junior event while hiding the tour event
 * the player actually needed. Within one circuit the tier ordering is
 * unchanged.
 */
export function compareCandidates(a, b) {
  const weekDiff = absoWeek(a.weekScheduled) - absoWeek(b.weekScheduled);
  if (weekDiff !== 0) return weekDiff;
  const circuitDiff = (a.circuit === 'senior' ? 0 : 1) - (b.circuit === 'senior' ? 0 : 1);
  if (circuitDiff !== 0) return circuitDiff;
  const tierDiff = (TIER_PRESTIGE[b.tier] ?? 0) - (TIER_PRESTIGE[a.tier] ?? 0);
  if (tierDiff !== 0) return tierDiff;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * The shown slice of the sorted enterable list. Normally the first `cap`
 * rows; when the cap truncates, every pinned senior `tour`/`major` is
 * guaranteed a place (the lowest-priority shown rows make way for them),
 * so "a tour is hidden while a junior event is shown" is structurally
 * impossible, not merely unlikely.
 */
export function selectEnterableSlice(sorted, cap = MAX_CAN_ENTER_NOW) {
  const slice = sorted.slice(0, cap);
  const missingPinned = sorted.filter((t) => isPinnedSeniorEvent(t) && !slice.includes(t));
  if (missingPinned.length === 0) return slice;
  const kept = slice.slice(0, Math.max(0, cap - missingPinned.length));
  return [...kept, ...missingPinned].sort(compareCandidates);
}

/**
 * The player-scoped entry candidates, with the feed fixes the agents
 * asked for:
 *   - rule-restricted events (rank too high for the tier, or the tier's
 *     per-season soft cap used up) are INCLUDED as `enterable: false`
 *     rows with `blockedReason` (they used to vanish silently, which read
 *     as a bug rather than a rule) — appended AFTER the enterable slice
 *     and capped separately, so a long enterable list can never squeeze
 *     them out;
 *   - the cap carries a truncation indicator (`canEnterNowMeta`), so the
 *     shown slice is never mistaken for the whole slate, and reports
 *     `hiddenCount` explicitly.
 * Enterable rows sort first (nearest week, then senior-first, then tier).
 */
export function buildCandidateView(openList, currentAbs) {
  const enterable = [];
  const restricted = [];
  for (const t of openList) {
    if (t.rankRestricted === true || t.seasonCapRestricted === true) {
      restricted.push(t);
      continue;
    }
    if (enterabilityBlockReason(t, currentAbs) !== null) continue;
    enterable.push(t);
  }
  enterable.sort(compareCandidates);
  restricted.sort(compareCandidates);
  const enterableShown = selectEnterableSlice(enterable);
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
      hiddenCount: Math.max(0, enterable.length - enterableShown.length) + Math.max(0, restricted.length - restrictedShown.length),
    },
  };
}

/**
 * Which of one week's open events `openByWeek` shows, and how many it
 * leaves out. Pure and deterministic:
 *   - every senior `tour`/`major` of the week is ALWAYS included;
 *   - at most `maxPerTier` events of any one tier (the "at most 2-3 per
 *     (week, tier)" rule — stops a junior-heavy week from monopolising
 *     the list);
 *   - at most `maxPerWeek` events in total;
 *   - `hiddenCount` is exactly `events.length - shown.length`, so a
 *     capped week is never presented as complete.
 */
export function selectWeekEvents(events, maxPerWeek = MAX_EVENTS_PER_WEEK, maxPerTier = MAX_EVENTS_PER_WEEK_TIER) {
  const sorted = [...events].sort(compareCandidates);
  const selected = [];
  const perTier = new Map();
  const seen = new Set();
  const take = (t, force) => {
    if (seen.has(t.id)) return;
    const count = perTier.get(t.tier) ?? 0;
    if (!force && count >= maxPerTier) return;
    if (!force && selected.length >= maxPerWeek) return;
    selected.push(t);
    seen.add(t.id);
    perTier.set(t.tier, count + 1);
  };
  for (const t of sorted) if (isPinnedSeniorEvent(t)) take(t, true);
  for (const t of sorted) take(t, false);
  selected.sort(compareCandidates);
  return { events: selected, hiddenCount: Math.max(0, events.length - selected.length) };
}

// ---------------------------------------------------------------------------
// Digest roster mappers (titles + results, doubles included)
// ---------------------------------------------------------------------------

/** The digest's singles-titles mapping — field shape unchanged. */
export function compactSinglesTitles(profile) {
  return (profile?.titles ?? []).map((t) => ({
    tournamentId: t.tournamentId,
    name: t.name,
    tier: t.tier,
    ageBand: t.ageBand,
    weekEarned: t.weekEarned,
  }));
}

/**
 * Doubles titles were previously invisible in the digest (`titles` mapped
 * only `profile.titles`), so 28 doubles titles across a measured season
 * were only ever inferred from prize-money jumps — even though a senior
 * doubles title pays real ranking points. The DTO already carries the
 * interesting half (the partner), so this is a straight map.
 */
export function compactDoublesTitles(profile) {
  return (profile?.doublesTitles ?? []).map((t) => ({
    tournamentId: t.tournamentId,
    tier: t.tier,
    partnerId: t.partnerId,
    partnerName: t.partnerName,
    partnerNationality: t.partnerNationality,
    weekEarned: t.weekEarned,
  }));
}

function compactResult(m, discipline) {
  return {
    tournamentId: m.tournamentId,
    tournamentName: m.tournamentName,
    tier: m.tier,
    roundNumber: m.roundNumber,
    result: m.result,
    setScores: m.setScores,
    weekScheduled: m.weekScheduled,
    /** Which draw this result came from — the digest's one new tag, so a
     * doubles win can never be misread as a singles win. */
    discipline,
  };
}

/**
 * The digest's `lastResults`: the API's `recent` (singles) and the new
 * `recentDoubles`, each capped, tagged with `discipline`, merged and
 * sorted newest-first by scheduled week then round. A pre-`recentDoubles`
 * API response still maps fine (doubles simply absent).
 */
export function compactLastResults(matches, limitPerDiscipline = 3) {
  const weekOf = (m) => (m?.weekScheduled ? absoWeek(m.weekScheduled) : 0);
  const singles = (matches?.recent ?? []).slice(0, limitPerDiscipline).map((m) => compactResult(m, 'singles'));
  const doubles = (matches?.recentDoubles ?? []).slice(0, limitPerDiscipline).map((m) => compactResult(m, 'doubles'));
  return [...singles, ...doubles].sort((a, b) => {
    const weekDiff = weekOf(b) - weekOf(a);
    if (weekDiff !== 0) return weekDiff;
    return (b.roundNumber ?? 0) - (a.roundNumber ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Decision replacement (a rewritten file must replace an accepted snapshot)
// ---------------------------------------------------------------------------

/** Phases during which the runner still re-reads a REWRITTEN decision
 * file and replaces the accepted snapshot. Everything from `apply`
 * onward keeps the snapshot taken when apply began — a contract stated in
 * the generated protocol docs. */
export const REACCEPT_DECISION_PHASES = ['open', 'ready', 'collect'];

export function isReacceptDecisionPhase(phase) {
  return REACCEPT_DECISION_PHASES.includes(phase);
}

/** Stable content hash of a decision file's raw text. */
export function hashDecisionContent(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * The pure replacement predicate: an ALREADY-ACCEPTED manager's decision
 * file needs re-reading (and its accepted snapshot replacing) exactly when
 * the phase is still pre-apply AND the file's content hash differs from
 * the accepted one. Same hash (no rewrite) or a post-collect phase
 * (apply/advance/close) → false; the accepted snapshot stands. A legacy
 * snapshot without a stored hash is re-read once (pre-apply), which
 * stamps the hash and makes every later pass hash-comparable.
 */
export function decisionNeedsReaccept({ phase, acceptedHash, currentHash }) {
  if (!isReacceptDecisionPhase(phase)) return false;
  if (acceptedHash === undefined || acceptedHash === null) return true;
  return acceptedHash !== currentHash;
}

/**
 * One collect pass's decision reconciliation, as a pure function: given
 * the phase, the manager list, each manager's raw decision-file content
 * (null when absent) and the already-accepted snapshots, it returns one
 * instruction per manager. `collectDecisionsOnce` in the runner is the
 * thin I/O wrapper (read files → reconcile → apply results → persist), so
 * the write→accept→rewrite-before-apply race is unit-testable without a
 * file system or the runner module.
 *
 * Actions:
 *   - `none` — no file on disk; nothing to do.
 *   - `accept` — first acceptance of a valid file.
 *   - `reaccept` — an ACCEPTED manager's file changed while the phase is
 *     still pre-apply; this snapshot REPLACES the old one (the caller
 *     stamps `replacedAt`).
 *   - `keep` — accepted and unchanged (or no re-accept window left and
 *     unchanged).
 *   - `ignored-rewrite` — the file changed, but the phase is past the
 *     re-accept window; the accepted snapshot stands (the caller logs the
 *     warning).
 *   - `nack` — invalid JSON or schema failure; the caller records it.
 */
export function reconcileDecisions({ phase, managers, files, accepted, validate }) {
  const results = [];
  for (const managerId of managers) {
    const raw = files?.[managerId] ?? null;
    if (raw === null) {
      results.push({ managerId, action: 'none' });
      continue;
    }
    const currentHash = hashDecisionContent(raw);
    const snapshot = accepted?.[managerId] ?? null;
    if (snapshot) {
      if (!isReacceptDecisionPhase(phase)) {
        results.push({
          managerId,
          action: snapshot.contentHash === currentHash ? 'keep' : 'ignored-rewrite',
          currentHash,
        });
        continue;
      }
      if (!decisionNeedsReaccept({ phase, acceptedHash: snapshot.contentHash, currentHash })) {
        results.push({ managerId, action: 'keep', currentHash });
        continue;
      }
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      results.push({ managerId, action: 'nack', errors: [{ path: '$', message: `invalid JSON: ${error.message}` }] });
      continue;
    }
    const { ok, errors } = validate(parsed, managerId);
    if (!ok) {
      results.push({ managerId, action: 'nack', errors });
      continue;
    }
    results.push({
      managerId,
      action: snapshot ? 'reaccept' : 'accept',
      contentHash: currentHash,
      summary: parsed.summary,
      actionCount: Array.isArray(parsed.actions) ? parsed.actions.length : 0,
      decision: parsed,
    });
  }
  return results;
}
