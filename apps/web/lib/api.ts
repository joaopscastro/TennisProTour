/** Thin fetch client for the Fastify API. The frontend talks HTTP
 * only — it never imports domain/application code (see CLAUDE.md's
 * monorepo layout note on apps/web). */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
let authTokenProvider: (() => Promise<string | null>) | null = null;

export function setAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  authTokenProvider = provider;
}

export interface PlayerDto {
  id: string;
  name: string;
  nationality: string;
  managerId: string | null;
  ageInWeeks: number;
  stage: 'youth' | 'prime' | 'decline' | 'retired';
  fatigue: number;
  form: number;
  /** True for a permanent, manager-less filler free agent padding an
   * under-filled draw — distinct from a released player (managerId also
   * null, but fillOnly stays false). See apps/api's playerDto.ts. */
  fillOnly: boolean;
  /** Cumulative on-site prize money earned across this player's whole
   * career. */
  careerPrizeMoney: number;
  /** Prize money earned so far in the current season only — resets to
   * 0 at every season rollover. */
  seasonPrizeMoney: number;
  attributes: {
    technical: { serve: number; forehand: number; backhand: number; volley: number };
    physical: { speed: number; stamina: number; strength: number };
    mental: { consistency: number; clutch: number };
    doubles: number;
    surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
  };
}

export type Surface = 'clay' | 'grass' | 'hard' | 'indoor';
/** Still used for read-only grouping (attribute display, dropdown
 * headers) — no longer a training axis itself now that TrainingFocus
 * targets a single attribute. Kept for the same reason the domain side
 * kept SkillCluster (see packages/domain/src/player/PlayerAttributes.ts). */
export type SkillCluster = 'technical' | 'physical' | 'mental';
export type TechnicalAttribute = 'serve' | 'forehand' | 'backhand' | 'volley';
export type PhysicalAttribute = 'speed' | 'stamina' | 'strength';
/** Mirrors the domain's TrainableAttribute — deliberately excludes
 * 'consistency'/'clutch' (mental): mental attributes are never a
 * training target, see packages/domain/src/player/PlayerAttributes.ts. */
export type TrainableAttribute = TechnicalAttribute | PhysicalAttribute;
export type PlayerLifecycleStage = 'youth' | 'prime' | 'decline' | 'retired';
export type TrainingFocus = { kind: 'surface'; surface: Surface } | { kind: 'attribute'; attribute: TrainableAttribute };

/** The read model behind the Roster Dashboard screen — see
 * DrizzleRosterDashboardQuery on the API side for how this is built. */
export interface RosterDashboardEntryDto {
  id: string;
  name: string;
  nationality: string;
  ageInWeeks: number;
  stage: PlayerLifecycleStage;
  /** "Prime in ~2 seasons" / "Decline in ~4 seasons" / "Retires in 1
   * season" / "Retired" — computed server-side against the real
   * StandardAgingPolicy thresholds (see DrizzleRosterDashboardQuery). */
  stageNote: string;
  fatigue: number;
  /** Match rhythm (0–100). Both under- and over-playing hurt; a
   * mid-band "match sharp" zone is ideal. See Player.form in the domain. */
  form: number;
  overall: number;
  rank: number | null;
  /** See RankingBand's doc comment above — which of the three
   * independent rankings `rank`/`points` are scoped to, derived purely
   * from the player's current age. */
  rankBand: RankingBand;
  points: number;
  lastResult: string | null;
  trainingFocus: TrainingFocus | null;
  surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
}

export interface EntitlementDto {
  managerId: string;
  tier: 'free' | 'pro';
  /** Custom-player-creation credits: +1 per confirmed Stripe
   * subscription renewal, spent one at a time by createCustomPlayer(). */
  customPlayerCredits: number;
  /** Current XP balance — shown persistently in the sidebar (see
   * Sidebar.tsx) so a manager never has to navigate anywhere specific
   * to check it before deciding whether to claim a candidate or
   * convert a player to a coach. */
  xpBalance: number;
}

/** Which of a player's four independent rankings a roster-dashboard
 * row's rank/points came from — see DrizzleRosterDashboardQuery's
 * rankBand doc comment on the API side. Mirrors the domain's
 * RankingBand. */
export type RankingBand = 'senior' | 'u14' | 'u16' | 'u18';

/** A free agent: a real, unowned `Player` (managerId null, not retired)
 * that lives in the world for its whole career whether or not anyone
 * ever signs it — it never expires or vanishes (see docs/CLAUDE.md's
 * candidate/player unification). A manager browses free agents and
 * signs one, which transfers ownership and costs XP. Current attributes
 * are exposed precisely (they're "observable"); rarity/potential are
 * DELIBERATELY not sent at all — a manager judges value from observable
 * attributes only, this being an RPG (enforced server-side in
 * talentPoolRoutes.ts). */
export interface TalentPoolCandidateDto {
  id: string;
  name: string;
  nationality: string;
  ageInWeeks: number;
  /** The exact XP cost signing this free agent would charge right now
   * — see TalentClaimPricingPolicy on the API side. Never free; a free
   * agent whose cost exceeds the manager's balance still appears in the
   * list (see docs/ui-direction.md's "never hide unaffordable" rule),
   * just with Sign disabled. */
  claimCost: number;
  attributes: {
    technical: { serve: number; forehand: number; backhand: number; volley: number };
    physical: { speed: number; stamina: number; strength: number };
    mental: { consistency: number; clutch: number };
    surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
  };
}

export interface MatchOutcomeDto {
  winner: string;
  loser: string;
  setScores: Array<{ winnerGames: number; loserGames: number }>;
}

export type AgeBand = 'u14' | 'u16' | 'u18';

export interface TournamentDto {
  id: string;
  /** A real, original generated display name (TournamentNameGenerator)
   * — always present, never a placeholder/debug string or a bare id. */
  name: string;
  tier: string;
  /** 'junior' for J-grades/juniorMasters, 'senior' otherwise — the
   * circuit shown on the tournament profile. */
  circuit: 'junior' | 'senior';
  /** null = senior tour. See docs/junior-circuit-research-and-proposal.md
   * — the same six tier grades work identically for both junior bands,
   * this is the field that distinguishes them. */
  ageBand: AgeBand | null;
  surface: string;
  /** Host country (P6 home advantage). null = none recorded (pre-P6
   * rows / tests), in which case no entrant is ever "home". A player
   * whose nationality matches this gets a modest sim bonus in matches
   * here — surfaced so the mechanic is legible, not hidden. */
  hostCountry: string | null;
  /** Points-per-round ladder for this tournament's actual draw size,
   * Champion-first (matchesWon = number of matches that result requires).
   * Straight from the domain points table. */
  pointsBreakdown: Array<{ matchesWon: number; stageLabel: string; points: number }>;
  /** True only for juniorMasters (unsourced placeholder points) — flag
   * them honestly rather than as authoritative. */
  pointsArePlaceholder: boolean;
  /** Prize-money-per-round ladder for this tournament's actual draw
   * size, Champion-first — the money counterpart to pointsBreakdown.
   * Unlike points, a first-round loss (matchesWon = 0) is NOT zero at a
   * senior tier (real ATP rule: paid to play, ranked to win); always 0
   * at every row for a junior tier. */
  prizeMoneyBreakdown: Array<{ matchesWon: number; stageLabel: string; prizeMoney: number }>;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  entrants: Array<{
    playerId: string;
    seed: number | null;
    /** How this entrant got their place — 'DA' (direct acceptance by
     * ranking), 'Q' (came through/is playing qualifying), 'WC' (an
     * automatic wild card — see WildCardPolicy). A wild card is never
     * requested by a manager: the algorithm promotes the best-ranked
     * host-country locals out of qualifying into the main draw the
     * moment registration for that field closes. Only ever 'Q' at a
     * tier that holds qualifying; 'WC' only at a tier that awards wild
     * cards (a tier with qualifying, and only ever a registrant who
     * shares the tournament's host country). */
    entryType: 'DA' | 'Q' | 'WC';
    /** Which draw they are in right now. A 'Q' entrant sits in
     * 'qualifying' until they actually win their way through, then
     * moves to 'main'. */
    draw: 'main' | 'qualifying';
  }>;
  /** Main-draw places reserved for qualifiers — 0 at every tier that
   * holds no qualifying (see QualifyingPolicy on the API side). */
  qualifierSlots: number;
  /** How many players contest those reserved places in the qualifying
   * draw, and over how many rounds. 0 = this tournament holds no
   * qualifying. */
  qualifyingDrawSize: number;
  qualifyingRoundCount: number;
  /** Wild cards (see WildCardPolicy): total main-draw places available
   * for this tier, and how many are already taken — 0/0 at every
   * junior tier (wild cards are senior-tour only). */
  wildCardSlots: number;
  wildCardSlotsTaken: number;
  /** The qualifying draw has been played out, so its survivors are
   * known (they are promoted into the main draw on the next tick). */
  qualifyingComplete: boolean;
  /** The main bracket has been seeded. Distinct from hasStarted, which
   * is also true while a tournament is still playing QUALIFYING and its
   * main draw does not exist yet. */
  hasMainDraw: boolean;
  /** True when a top-ranked player must count this event even if they
   * skip it (the obligatory-tournament rule). */
  obligatory: boolean;
  /** Only present when GET /tournaments was called with ?playerId=.
   * Attached for BOTH bands now — see fetchOpenTournaments and
   * attachEntryInfo on the API side. Junior tiers cap at 3/week, the
   * senior tour at 1/week. Absent (not zero) only when no ?playerId=
   * was supplied. */
  weeklyEntryCountThisWeek?: number;
  weeklyEntryCapThisWeek?: number;
  /** Whether the queried player's CURRENT age is eligible for this
   * tournament's band — see isAgeEligibleForTournamentBand on the API
   * side. "Playing up" into an older junior band is eligible; playing
   * down, or a senior player entering either junior band, is not. The
   * senior tour has no age restriction, so it's always true there.
   * Only set when ?playerId= was supplied. */
  ageEligible?: boolean;
  /** Whether THIS player would enter through qualifying (`[Q]`) rather
   * than a direct main-draw place — the API's resolveEntryType preview.
   * Only set when ?playerId= was supplied; only meaningful at a tier
   * that holds qualifying. */
  entryViaQualifying?: boolean;
  /** The qualifying field is already full, so a below-cutoff player
   * would be refused. Only set when ?playerId= was supplied; only
   * meaningful when entryViaQualifying. */
  qualifyingFieldFull?: boolean;
  /** How many `[Q]` places are taken / the field's total capacity
   * (0/0 at a tier with no qualifying). Only set when ?playerId=. */
  qualifyingFieldTaken?: number;
  qualifyingFieldSize?: number;
  rounds: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  /** The qualifying bracket, same shape as `rounds`. Empty for every
   * tournament that holds no qualifying. */
  qualifyingRounds: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  /** Doubles draw (P7b). `doublesDrawSize` 0 = no doubles draw.
   * `doublesEntrants` are the solo signups (player ids); `doublesPairs`
   * maps each bracket slot's pairId back to its two players;
   * `doublesRounds` is the pair-keyed bracket (entrantA/entrantB are pair
   * ids — resolve through `doublesPairs`). */
  doublesDrawSize: number;
  doublesEntrants: string[];
  doublesPairs: Array<{ pairId: string; playerA: string; playerB: string; chemistry: number }>;
  doublesRounds: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  doublesComplete: boolean;
  /** Doubles qualifying (P8). `doublesQualifyingDrawSize` 0 = no doubles
   * qualifying. */
  doublesQualifyingDrawSize: number;
  doublesQualifierSlots: number;
  doublesQualifyingPairs: Array<{ pairId: string; playerA: string; playerB: string; chemistry: number }>;
  doublesQualifyingRounds: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  doublesQualifyingComplete: boolean;
}

/** Mirrors the domain's MatchLog replay blob (CompetitionTypes.ts). */
export interface MatchLogDto {
  entries: Array<{
    offsetSeconds: number;
    setNumber: number;
    gamesForA: number;
    gamesForB: number;
    wonBy: 'A' | 'B';
    /** Who served this game — alternates every game, continuously
     * across the whole match (see MatchLogEntry.server on the API
     * side). The break-of-serve commentary moment is exactly
     * `wonBy !== server`, except for a tiebreak-decided game (score
     * 7-6/6-7), where "break" isn't a meaningful concept since
     * service rotates every 2 points within a breaker. */
    server: 'A' | 'B';
  }>;
  /** Point-by-point detail alongside `entries` — drives the replay
   * screen's "current game" point line (0/15/30/40/deuce/advantage)
   * and the derived commentary feed (break-of-serve/tiebreak/set/match
   * moments); `entries` remains the game-level rollup the set-score
   * columns and bracket/scrub-bar tick marks consume. */
  points: Array<{
    offsetSeconds: number;
    setNumber: number;
    gameNumber: number;
    pointScoreA: string;
    pointScoreB: string;
    wonBy: 'A' | 'B';
  }>;
  totalDurationSeconds: number;
  /** ISO 8601 timestamp of when this match was actually simulated —
   * the anchor for the wall-clock-synced "Premiere" live-edge cap
   * (see docs/ui-direction.md and MatchReplayPlayer). */
  simulatedAt: string;
}

async function requestHeaders(managerId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await authTokenProvider?.();
  if (token) headers.authorization = `Bearer ${token}`;
  else if (!CLERK_ENABLED) headers['x-dev-manager-id'] = managerId ?? process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1';
  return headers;
}

function managerPath(managerId: string, resource: 'players' | 'roster-dashboard' | 'entitlement'): string {
  return CLERK_ENABLED ? `/me/${resource}` : `/managers/${encodeURIComponent(managerId)}/${resource}`;
}

/** An HTTP error that carries its status code, so callers can tell a
 * real failure from an expected 404 ("no such resource yet"). */
function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

async function getJson<T>(path: string, managerId?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: await requestHeaders(managerId), credentials: 'include' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw httpError(response.status, body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'PUT', path: string, body?: unknown, managerId?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(await requestHeaders(managerId)) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw httpError(response.status, responseBody?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function fetchRoster(managerId: string): Promise<PlayerDto[]> {
  return getJson(managerPath(managerId, 'players'), managerId);
}

export function fetchRosterDashboard(managerId: string): Promise<RosterDashboardEntryDto[]> {
  return getJson(managerPath(managerId, 'roster-dashboard'), managerId);
}

export function fetchEntitlement(managerId: string): Promise<EntitlementDto> {
  return getJson(managerPath(managerId, 'entitlement'), managerId);
}

export function fetchTalentPool(): Promise<TalentPoolCandidateDto[]> {
  return getJson('/talent-pool');
}

export function claimTalentPoolCandidate(playerId: string, managerId: string): Promise<PlayerDto> {
  return sendJson('POST', `/talent-pool/${encodeURIComponent(playerId)}/claim`, { managerId }, managerId);
}

/** Pro-only, credit-gated: bypasses the talent pool (choose your own
 * name/nationality) but NOT the same generation policy — attributes
 * are still rolled the same way any pool candidate's are, only the
 * name/nationality are the manager's choice. See
 * CreateCustomPlayerUseCase's doc comment on the API side. */
export function createCustomPlayer(input: { managerId: string; name: string; nationality: string }): Promise<PlayerDto> {
  return sendJson('POST', '/players/custom', input, input.managerId);
}

/** One explicit training-schedule entry — see
 * SetTrainingScheduleUseCase/PlayerTrainingScheduleQuery on the API
 * side. `effectiveFrom` is always present in a response (the backend
 * fills in "now" when a request omits `week`), never optional here. */
export interface TrainingScheduleEntryDto {
  playerId: string;
  effectiveFrom: { season: number; week: number };
  focus: TrainingFocus | null;
}

/** The roster dashboard's quick "Set focus" action — no week means
 * "starting right now," the exact same standing-order semantics this
 * always had. See setTrainingScheduleEntry below for scheduling an
 * explicit future week (the player profile's Schedule view). */
export function setTrainingFocus(playerId: string, focus: TrainingFocus | null, managerId?: string): Promise<TrainingScheduleEntryDto> {
  return sendJson('PUT', `/players/${encodeURIComponent(playerId)}/training-focus`, { focus }, managerId);
}

/** Schedules a training-focus change for a specific future (or
 * current) week without touching any other week's standing order —
 * same PUT route as setTrainingFocus above, just with an explicit
 * `week`. Used by the player profile's Schedule view (Step 2), reusing
 * this exact call rather than a second endpoint. */
export function setTrainingScheduleEntry(
  playerId: string,
  focus: TrainingFocus | null,
  week: { season: number; week: number },
  managerId?: string,
): Promise<TrainingScheduleEntryDto> {
  return sendJson('PUT', `/players/${encodeURIComponent(playerId)}/training-focus`, { focus, week }, managerId);
}

export function releasePlayer(playerId: string, managerId?: string): Promise<PlayerDto> {
  return sendJson('POST', `/players/${encodeURIComponent(playerId)}/release`, undefined, managerId);
}

/** Runs one practice session (P8a) — no form, no ranking; grants
 * development XP + a small ladder credit for a small fatigue cost. Once
 * per player per game day. */
export function runPractice(playerId: string, managerId?: string): Promise<{ experience: number; fatigue: number; ladderPoints: number }> {
  return sendJson('POST', `/players/${encodeURIComponent(playerId)}/practice`, undefined, managerId);
}

/** A doubles partnership (P7a) as the board read returns it — both
 * players' identities inlined so the client can tell an incoming invite
 * (I own playerB, pending) from an active pair without extra fetches. */
export interface DoublesPairDto {
  id: string;
  status: 'pending' | 'active' | 'dissolved';
  chemistry: number;
  playerA: { playerId: string; name: string; nationality: string; managerId: string | null };
  playerB: { playerId: string; name: string; nationality: string; managerId: string | null };
}

export function fetchDoublesPairs(managerId?: string): Promise<DoublesPairDto[]> {
  return getJson('/me/doubles-pairs', managerId);
}

export function createDoublesPair(playerA: string, playerB: string, managerId?: string): Promise<DoublesPairDto> {
  return sendJson('POST', '/doubles-pairs', { playerA, playerB }, managerId);
}

export function acceptDoublesPair(pairId: string, managerId?: string): Promise<DoublesPairDto> {
  return sendJson('POST', `/doubles-pairs/${encodeURIComponent(pairId)}/accept`, undefined, managerId);
}

export function dissolveDoublesPair(pairId: string, managerId?: string): Promise<DoublesPairDto> {
  return sendJson('POST', `/doubles-pairs/${encodeURIComponent(pairId)}/dissolve`, undefined, managerId);
}

/** Read-only preview computed from the real CoachConversionPolicy —
 * see GET /players/:id/coach-conversion-preview on the API side. Does
 * not spend XP or touch the roster; shown before requiring the
 * explicit confirmation step convertPlayerToCoach performs. */
export interface CoachConversionPreviewDto {
  xpCost: number;
  coachRating: number;
  xpBalance: number;
  coachCount: number;
  coachCap: number;
  atCap: boolean;
}

export function fetchCoachConversionPreview(playerId: string, managerId?: string): Promise<CoachConversionPreviewDto> {
  return getJson(`/players/${encodeURIComponent(playerId)}/coach-conversion-preview`, managerId);
}

export interface CoachDto {
  id: string;
  coachRating: number;
  sourcePlayerName: string;
}

/** Permanent: removes the player from the roster and frees their slot
 * — see ConvertPlayerToCoachUseCase's doc comment on the API side.
 * Always preceded by fetchCoachConversionPreview + an explicit
 * confirmation step (docs/ui-direction.md), never a single click. */
export function convertPlayerToCoach(playerId: string, managerId?: string): Promise<CoachDto> {
  return sendJson('POST', `/players/${encodeURIComponent(playerId)}/convert-to-coach`, undefined, managerId);
}

/** playerId, when supplied, attaches weeklyEntryCountThisWeek/CapThisWeek
 * to every tournament in the response (both bands — junior 3/week,
 * senior 1/week; see TournamentDto) — used by EnterTournamentModal to
 * disable an over-cap entry attempt up front rather than only learning
 * about it from a failed POST. */
export function fetchOpenTournaments(playerId?: string): Promise<TournamentDto[]> {
  return getJson(`/tournaments?status=open${playerId ? `&playerId=${encodeURIComponent(playerId)}` : ''}`);
}

export function fetchStartedTournaments(): Promise<TournamentDto[]> {
  return getJson('/tournaments?status=started');
}

/** One row of the multi-week planner response — see
 * PlayerEntryPlannerQuery/GET /players/:id/entry-planner on the API
 * side. `entries` is a real, possibly-empty list of the tournaments
 * this player is registered in for exactly this GameWeek — an empty
 * array is a genuine "nothing yet," not a loading/error state. */
export interface PlannerWeekDto {
  week: { season: number; week: number };
  entries: TournamentDto[];
}

/** weeksAhead defaults server-side to DEFAULT_PLANNER_WEEKS (6) when
 * omitted. The window always starts at the world's current week. */
export function fetchEntryPlanner(playerId: string, weeksAhead?: number): Promise<PlannerWeekDto[]> {
  return getJson(`/players/${encodeURIComponent(playerId)}/entry-planner${weeksAhead ? `?weeks=${weeksAhead}` : ''}`);
}

/** One row of the training-schedule planner response — the
 * PlayerTrainingScheduleQuery mirror of PlannerWeekDto above, same
 * window/defaults (see GET /players/:id/training-schedule). `focus` is
 * already resolved (the standing order carried forward, or a week's
 * own explicit entry); `isExplicit` says which — the player profile's
 * Schedule view uses it to show "this is where the order changes"
 * distinctly from "this week just inherits the earlier order". */
export interface TrainingScheduleWeekDto {
  week: { season: number; week: number };
  focus: TrainingFocus | null;
  isExplicit: boolean;
}

export function fetchTrainingSchedule(playerId: string, weeksAhead?: number): Promise<TrainingScheduleWeekDto[]> {
  return getJson(`/players/${encodeURIComponent(playerId)}/training-schedule${weeksAhead ? `?weeks=${weeksAhead}` : ''}`);
}

/** managerId must be the ACTUAL owning manager, not left to the
 * request-header default — the API's ownership check
 * (`player.managerId === manager.id`) means a caller that omits this
 * on any manager other than the dev-mode default silently
 * authenticates as the wrong manager and gets a real "Player not
 * found in your roster" 404, never the intended registration. */
export function registerEntrant(tournamentId: string, playerId: string, managerId?: string): Promise<TournamentDto> {
  return sendJson('POST', `/tournaments/${encodeURIComponent(tournamentId)}/entrants`, { playerId }, managerId);
}

export function registerDoublesEntrant(tournamentId: string, playerId: string, managerId?: string): Promise<TournamentDto> {
  return sendJson('POST', `/tournaments/${encodeURIComponent(tournamentId)}/doubles-entrants`, { playerId }, managerId);
}

export function fetchTournament(id: string): Promise<TournamentDto> {
  return getJson(`/tournaments/${encodeURIComponent(id)}`);
}

export function fetchMatchLog(matchId: string): Promise<MatchLogDto> {
  return getJson(`/match-logs/${encodeURIComponent(matchId)}.json`);
}

export async function simulateMatch(
  tournamentId: string,
  roundNumber: number,
  matchIndex: number,
): Promise<{ matchId: string; replayUrl: string }> {
  const response = await fetch(
    `${API_BASE}/tournaments/${encodeURIComponent(tournamentId)}/matches/${roundNumber}/${matchIndex}/simulate`,
    { method: 'POST', headers: await requestHeaders(), credentials: 'include' },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** The same deterministic slot id the backend derives (see
 * matchIdForSlot in the application layer). The qualifying bracket has
 * its own round numbering, so its ids carry a `-q` segment before the
 * round so a qualifying round 1 can't collide with the main draw's
 * round 1 (same tournament, same replay blob id). */
export function matchIdForSlot(
  tournamentId: string,
  roundNumber: number,
  matchIndex: number,
  draw: 'main' | 'qualifying' = 'main',
): string {
  const prefix = draw === 'qualifying' ? `${tournamentId}-q` : `${tournamentId}`;
  return `${prefix}-r${roundNumber}-m${matchIndex}`;
}

/** Inverse of matchIdForSlot — the replay screen is reached with only
 * a matchId in the URL, so this is how it recovers which tournament
 * and bracket slot to look up player names / next-round links from.
 * Relies on tournamentId never itself containing "-rN-mM"; every
 * tournamentId in this codebase (seed script, demo data) is a plain
 * slug, so this holds in practice even though it isn't structurally
 * guaranteed by the id's type. */
export function parseMatchId(
  matchId: string,
): { tournamentId: string; roundNumber: number; matchIndex: number; draw: 'main' | 'qualifying' } | null {
  const m = /^(.+)-r(\d+)-m(\d+)$/.exec(matchId);
  if (!m) return null;
  const rawId = m[1];
  const draw: 'main' | 'qualifying' = rawId.endsWith('-q') ? 'qualifying' : 'main';
  const tournamentId = draw === 'qualifying' ? rawId.slice(0, -2) : rawId;
  return { tournamentId, roundNumber: Number(m[2]), matchIndex: Number(m[3]), draw };
}

export function fetchPlayer(id: string): Promise<PlayerDto> {
  return getJson(`/players/${encodeURIComponent(id)}`);
}

/** Deduped, parallel fetch for however many distinct players a bracket
 * or replay screen needs names/flags for — there's no batch-read
 * endpoint, so this is N parallel GETs to the existing single-player
 * route rather than a new backend read model, which is enough at the
 * roster-cap-driven scale (a few dozen players per tournament) this
 * game runs at. */
export async function fetchPlayersByIds(ids: Iterable<string>): Promise<Map<string, PlayerDto>> {
  const unique = [...new Set(ids)];
  const players = await Promise.all(unique.map((id) => fetchPlayer(id)));
  return new Map(unique.map((id, i) => [id, players[i]]));
}

export function createProCheckoutSession(managerId: string): Promise<{ url: string }> {
  return sendJson('POST', '/billing/checkout', { managerId }, managerId);
}

/** Persistent world-clock chrome (Sidebar) and the scouting page's
 * "next refresh" countdown both read this same endpoint — one fetch,
 * one source of truth for "what week is it" and "when does the next
 * tick land," instead of each screen computing its own guess. See
 * worldRoutes.ts on the API side for how nextTickAt is derived. */
export interface WorldClockDto {
  currentWeek: { season: number; week: number };
  currentDay: number;
  daysPerWeek: number;
  nextTickAt: string;
  nextWeekTickAt: string;
}

export function fetchWorldClock(): Promise<WorldClockDto> {
  return getJson('/world/clock');
}

export interface ManagerLadderRowDto {
  rank: number;
  managerId: string;
  displayName: string;
  score: number;
  isSelf: boolean;
}

export interface ManagerLeaderboardDto {
  standings: ManagerLadderRowDto[];
  self: {
    managerId: string;
    displayName: string;
    score: number;
    rank: number | null;
  };
}

export function fetchManagerLeaderboard(limit = 100): Promise<ManagerLeaderboardDto> {
  return getJson(`/managers/leaderboard?limit=${limit}`);
}

export interface RankingRowDto {
  rank: number;
  playerId: string;
  name: string;
  nationality: string | null;
  points: number;
}

export interface RankingsBoardDto {
  band: RankingBand;
  standings: RankingRowDto[];
}

/** Public player standings board (senior/u14/u16/u18) — GET /rankings/:band. No
 * auth required, unlike fetchManagerLeaderboard (there's no "self" row here,
 * a player isn't the authenticated caller). */
export function fetchRankings(band: RankingBand, limit = 100): Promise<RankingsBoardDto> {
  return getJson(`/rankings/${band}?limit=${limit}`);
}

export interface PlayerTournamentHistoryEntryDto {
  tournamentId: string;
  name: string;
  tier: string;
  ageBand: AgeBand | null;
  surface: string;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  roundsWon: number;
  won: boolean;
  eliminated: boolean;
  /** On-site prize money earned in THIS tournament — 0 for an entry
   * with no decided match yet. */
  prizeMoney: number;
}

/** The single aggregated read the player profile page needs — see
 * DrizzlePlayerProfileQuery on the API side for how this is composed
 * (avatar identity, current rolling rankings, permanent peak rankings,
 * full tournament history, and titles, all in one call). */
export interface PlayerProfileDto {
  playerId: string;
  name: string;
  nationality: string;
  /** null for a free agent (no manager) — the Schedule section's
   * inline actions (set training focus, enter a tournament) need this
   * to authenticate as the real owning manager. */
  managerId: string | null;
  ageInWeeks: number;
  stage: PlayerLifecycleStage;
  /** Which ONE band this player's current age makes "live" for —
   * derived server-side via juniorEligibilityForAge, never re-derived
   * client-side (see RankingBand's doc comment above). */
  currentEligibleBand: RankingBand;
  /** Cumulative on-site prize money earned across this player's whole
   * career. */
  careerPrizeMoney: number;
  /** Prize money earned so far in the current season only. */
  seasonPrizeMoney: number;
  currentRankings: Array<{ band: RankingBand; totalPoints: number; rank: number | null }>;
  peakRankings: Array<{ band: RankingBand; peakPoints: number; peakAsOfWeek: { season: number; week: number } }>;
  tournamentHistory: PlayerTournamentHistoryEntryDto[];
  titles: Array<{ tournamentId: string; name: string; tier: string; ageBand: AgeBand | null; weekEarned: { season: number; week: number } }>;
  /** The profile-only "scout's projection" of upside (P5). Age-fuzzed,
   * derived server-side from hidden ceilings — narrows toward truth as
   * the player ages. Never present on any list/pool DTO. */
  potential: PotentialProjectionDto;
  /** The player's doubles partner (P7a): the OTHER member of the
   * player's non-dissolved pair, with its status, or null when the
   * player isn't in a pair. An ACTIVE pair is what the profile hero
   * highlights; a PENDING invite shows as pending. */
  doublesPartner: DoublesPartnerDto | null;
  /** Permanent high-water-mark DOUBLES ranking totals, one per band (P7c
   * + junior doubles). */
  doublesPeaks: Array<{ band: RankingBand; peakPoints: number; peakAsOfWeek: { season: number; week: number } }>;
  /** Doubles titles (P7c) — each shows the partner. */
  doublesTitles: Array<{
    tournamentId: string;
    tier: string;
    partnerId: string;
    partnerName: string;
    partnerNationality: string;
    weekEarned: { season: number; week: number };
  }>;
}

export interface DoublesPartnerDto {
  pairId: string;
  status: 'pending' | 'active' | 'dissolved';
  playerId: string;
  name: string;
  nationality: string;
  chemistry: number;
}

export type PotentialTier = 'limited' | 'promising' | 'high' | 'elite';

export interface AttributeProjectionDto {
  current: number;
  projected: number;
  mature: boolean;
}

export interface PotentialProjectionDto {
  projectedOverallLow: number;
  projectedOverallMid: number;
  projectedOverallHigh: number;
  developmentPercent: number;
  tier: PotentialTier;
  confidence: number;
  resolved: boolean;
  growth: 'slow' | 'steady' | 'rapid';
  attributes: {
    technical: Record<string, AttributeProjectionDto>;
    physical: Record<string, AttributeProjectionDto>;
    mental: Record<string, AttributeProjectionDto>;
  };
}

export function fetchPlayerProfile(playerId: string): Promise<PlayerProfileDto> {
  return getJson(`/players/${encodeURIComponent(playerId)}/profile`);
}

export interface PlayerMatchSummaryDto {
  tournamentId: string;
  tournamentName: string;
  tier: string;
  ageBand: AgeBand | null;
  surface: string;
  roundNumber: number;
  drawSize: number;
  weekScheduled: { season: number; week: number };
  opponentId: string;
  opponentName: string;
  opponentNationality: string;
  result: 'win' | 'loss' | 'pending';
  setScores: Array<{ winnerGames: number; loserGames: number }> | null;
}

/** The profile page's "latest results + next match" strip. Carries no
 * per-match countdown by design (matches are swept synchronously when
 * due — see DrizzlePlayerMatchesQuery on the API side). */
export interface PlayerMatchesDto {
  recent: PlayerMatchSummaryDto[];
  next: PlayerMatchSummaryDto | null;
}

export function fetchPlayerMatches(playerId: string): Promise<PlayerMatchesDto> {
  return getJson(`/players/${encodeURIComponent(playerId)}/current-matches`);
}

/** The Masters Cup (P8b) — the season-end capstone, returned whole. */
export interface MastersCupDto {
  id: string;
  season: number;
  weekScheduled: { season: number; week: number };
  surface: string;
  singlesEntrants: string[];
  doublesEntrants: Array<{ pairId: string; playerA: string; playerB: string; chemistry?: number }>;
  singlesGroups: Array<{
    entrants: string[];
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  doublesGroups: Array<{
    entrants: string[];
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  singlesKnockout: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  doublesKnockout: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null; scheduledStartAt: string | null; revealSeconds: number }>;
  }>;
  singlesGroupStageComplete: boolean;
  doublesGroupStageComplete: boolean;
  hasKnockout: boolean;
  singlesChampion: string | null;
  doublesChampion: string | null;
}

export function fetchMastersCup(season: number): Promise<MastersCupDto> {
  return getJson(`/masters-cup/${season}`);
}

/** The World Team Cup (P8c) — the Davis-Cup-style national team event. */
export interface WorldTeamCupDto {
  id: string;
  season: number;
  weekScheduled: { season: number; week: number };
  surface: string;
  teams: Array<{ country: string; players: string[] }>;
  groups: Array<{
    teams: string[];
    ties: Array<{
      teamA: string;
      teamB: string;
      winner: string | null;
      rubbers: Array<{
        kind: 'singles' | 'doubles';
        playerA?: string;
        playerB?: string;
        pairA?: string;
        pairB?: string;
        outcome: MatchOutcomeDto | null;
      }>;
    }>;
  }>;
  knockout: Array<Array<{
    teamA: string;
    teamB: string;
    winner: string | null;
    rubbers: Array<{
      kind: 'singles' | 'doubles';
      playerA?: string;
      playerB?: string;
      pairA?: string;
      pairB?: string;
      outcome: MatchOutcomeDto | null;
    }>;
  }>>;
  hasKnockout: boolean;
  champion: string | null;
}

export function fetchWorldTeamCup(season: number): Promise<WorldTeamCupDto> {
  return getJson(`/world-team-cup/${season}`);
}
