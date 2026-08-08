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
  currentFocus: TrainingFocus | null;
  attributes: {
    technical: { serve: number; forehand: number; backhand: number; volley: number };
    physical: { speed: number; stamina: number; strength: number };
    mental: { consistency: number; clutch: number };
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

/** Which of a player's three independent rankings a roster-dashboard
 * row's rank/points came from — see DrizzleRosterDashboardQuery's
 * rankBand doc comment on the API side. Mirrors the domain's
 * RankingBand. */
export type RankingBand = 'senior' | 'u14' | 'u16';

export type PlayerRarityTier = 'common' | 'strong' | 'exceptional';

/** A coarse, deliberately imperfect read on a candidate's hidden
 * potential ceiling — the real number is never sent to the client at
 * all (see talentPoolRoutes.ts on the API side). Every manager sees
 * the exact same noisy tier on the exact same candidate; there is no
 * per-manager scouting-accuracy system (see docs/CLAUDE.md). */
export type PotentialTier = 'limited' | 'promising' | 'high' | 'elite';

/** A generated player sitting unowned in the talent pool — see
 * DrizzleTalentPoolCandidateRepository on the API side. Hiring is
 * pool-based now: a manager browses/claims one of these instead of
 * hiring an arbitrary player on demand (see docs/CLAUDE.md). Current
 * attributes are exposed precisely (they're "observable"); potential
 * is deliberately only the coarse `potentialTier`, never a number. */
export interface TalentPoolCandidateDto {
  id: string;
  name: string;
  nationality: string;
  tier: PlayerRarityTier;
  potentialTier: PotentialTier;
  /** The exact XP cost claiming this candidate would charge right now
   * — see TalentClaimPricingPolicy on the API side. Never claimable
   * for free; a candidate whose cost exceeds the manager's balance
   * still appears in the list (see docs/ui-direction.md's "never hide
   * unaffordable candidates" convention), just with Claim disabled. */
  claimCost: number;
  generatedAtWeek: { season: number; week: number };
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

export type AgeBand = 'u14' | 'u16';

export interface TournamentDto {
  id: string;
  /** A real, original generated display name (TournamentNameGenerator)
   * — always present, never a placeholder/debug string or a bare id. */
  name: string;
  tier: string;
  /** null = senior tour. See docs/junior-circuit-research-and-proposal.md
   * — the same six tier grades work identically for both junior bands,
   * this is the field that distinguishes them. */
  ageBand: AgeBand | null;
  surface: string;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  entrants: Array<{ playerId: string; seed: number | null }>;
  /** Only present when GET /tournaments was called with ?playerId= AND
   * this tournament is junior-tier — see fetchOpenTournaments and
   * attachJuniorEntryInfo on the API side. Absent (not zero) for senior
   * tournaments, since the weekly cap deliberately doesn't apply there. */
  juniorEntryCountThisWeek?: number;
  juniorEntryCapThisWeek?: number;
  /** Whether the queried player's CURRENT age is eligible for this
   * tournament's band — see isAgeEligibleForTournamentBand on the API
   * side. "Playing up" into an older junior band is eligible; playing
   * down, or a senior player entering either junior band, is not.
   * Same presence rule as the two fields above: only set for junior
   * tournaments when ?playerId= was supplied — the senior tour has no
   * age restriction at all, so this is never attached there. */
  ageEligible?: boolean;
  rounds: Array<{
    roundNumber: number;
    matches: Array<{ entrantA: string; entrantB: string; outcome: MatchOutcomeDto | null }>;
  }>;
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

async function getJson<T>(path: string, managerId?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: await requestHeaders(managerId), credentials: 'include' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
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
    throw new Error(responseBody?.error ?? `${response.status} ${response.statusText}`);
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

export function claimTalentPoolCandidate(candidateId: string, managerId: string): Promise<PlayerDto> {
  return sendJson('POST', `/talent-pool/${encodeURIComponent(candidateId)}/claim`, { managerId }, managerId);
}

/** Pro-only, credit-gated: bypasses the talent pool (choose your own
 * name/nationality) but NOT the same generation policy — attributes
 * are still rolled the same way any pool candidate's are, only the
 * name/nationality are the manager's choice. See
 * CreateCustomPlayerUseCase's doc comment on the API side. */
export function createCustomPlayer(input: { managerId: string; name: string; nationality: string }): Promise<PlayerDto> {
  return sendJson('POST', '/players/custom', input, input.managerId);
}

export function setTrainingFocus(playerId: string, focus: TrainingFocus | null, managerId?: string): Promise<PlayerDto> {
  return sendJson('PUT', `/players/${encodeURIComponent(playerId)}/training-focus`, { focus }, managerId);
}

export function releasePlayer(playerId: string, managerId?: string): Promise<PlayerDto> {
  return sendJson('POST', `/players/${encodeURIComponent(playerId)}/release`, undefined, managerId);
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

/** playerId, when supplied, attaches juniorEntryCountThisWeek/CapThisWeek
 * to junior-tier tournaments in the response (see TournamentDto) — used
 * by EnterTournamentModal to disable an over-cap entry attempt up
 * front rather than only learning about it from a failed POST. */
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

/** managerId must be the ACTUAL owning manager, not left to the
 * request-header default — the API's ownership check
 * (`player.managerId === manager.id`) means a caller that omits this
 * on any manager other than the dev-mode default silently
 * authenticates as the wrong manager and gets a real "Player not
 * found in your roster" 404, never the intended registration. */
export function registerEntrant(tournamentId: string, playerId: string, managerId?: string): Promise<TournamentDto> {
  return sendJson('POST', `/tournaments/${encodeURIComponent(tournamentId)}/entrants`, { playerId }, managerId);
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
 * matchIdForSlot in the application layer). */
export function matchIdForSlot(tournamentId: string, roundNumber: number, matchIndex: number): string {
  return `${tournamentId}-r${roundNumber}-m${matchIndex}`;
}

/** Inverse of matchIdForSlot — the replay screen is reached with only
 * a matchId in the URL, so this is how it recovers which tournament
 * and bracket slot to look up player names / next-round links from.
 * Relies on tournamentId never itself containing "-rN-mM"; every
 * tournamentId in this codebase (seed script, demo data) is a plain
 * slug, so this holds in practice even though it isn't structurally
 * guaranteed by the id's type. */
export function parseMatchId(matchId: string): { tournamentId: string; roundNumber: number; matchIndex: number } | null {
  const m = /^(.+)-r(\d+)-m(\d+)$/.exec(matchId);
  if (!m) return null;
  return { tournamentId: m[1], roundNumber: Number(m[2]), matchIndex: Number(m[3]) };
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
  nextTickAt: string;
}

export function fetchWorldClock(): Promise<WorldClockDto> {
  return getJson('/world/clock');
}
