/** Thin fetch client for the Fastify API. The frontend talks HTTP
 * only — it never imports domain/application code (see CLAUDE.md's
 * monorepo layout note on apps/web). */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface PlayerDto {
  id: string;
  name: string;
  managerId: string | null;
  ageInWeeks: number;
  stage: 'youth' | 'prime' | 'decline' | 'retired';
  fatigue: number;
  attributes: {
    technical: { serve: number; forehand: number; backhand: number; volley: number };
    physical: { speed: number; stamina: number; strength: number };
    mental: { consistency: number; clutch: number };
    surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
  };
}

export type Surface = 'clay' | 'grass' | 'hard' | 'indoor';
export type SkillCluster = 'technical' | 'physical' | 'mental';
export type PlayerLifecycleStage = 'youth' | 'prime' | 'decline' | 'retired';
export type TrainingFocus = { kind: 'surface'; surface: Surface } | { kind: 'skill'; cluster: SkillCluster };

/** The read model behind the Roster Dashboard screen — see
 * DrizzleRosterDashboardQuery on the API side for how this is built. */
export interface RosterDashboardEntryDto {
  id: string;
  name: string;
  nationality: string;
  ageInWeeks: number;
  stage: PlayerLifecycleStage;
  fatigue: number;
  overall: number;
  rank: number | null;
  points: number;
  lastResult: string | null;
  trainingFocus: TrainingFocus | null;
  surfaceAffinities: { clay: number; grass: number; hard: number; indoor: number };
}

export interface EntitlementDto {
  managerId: string;
  tier: 'free' | 'pro';
}

export interface MatchOutcomeDto {
  winner: string;
  loser: string;
  setScores: Array<{ winnerGames: number; loserGames: number }>;
}

export interface TournamentDto {
  id: string;
  tier: string;
  surface: string;
  weekScheduled: { season: number; week: number };
  drawSize: number;
  hasStarted: boolean;
  entrants: Array<{ playerId: string; seed: number | null }>;
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
  }>;
  /** Point-by-point detail alongside `entries` — not yet consumed by
   * MatchReplayPlayer, which still renders off the game-level rollup
   * above, but typed here so a future point-level UI has it ready. */
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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function fetchRoster(managerId: string): Promise<PlayerDto[]> {
  return getJson(`/managers/${encodeURIComponent(managerId)}/players`);
}

export function fetchRosterDashboard(managerId: string): Promise<RosterDashboardEntryDto[]> {
  return getJson(`/managers/${encodeURIComponent(managerId)}/roster-dashboard`);
}

export function fetchEntitlement(managerId: string): Promise<EntitlementDto> {
  return getJson(`/managers/${encodeURIComponent(managerId)}/entitlement`);
}

export function hirePlayer(input: {
  playerId: string;
  name: string;
  nationality: string;
  managerId: string;
  startingAgeInWeeks: number;
}): Promise<PlayerDto> {
  return sendJson('POST', '/players', input);
}

export function setTrainingFocus(playerId: string, focus: TrainingFocus | null): Promise<PlayerDto> {
  return sendJson('PUT', `/players/${encodeURIComponent(playerId)}/training-focus`, { focus });
}

export function releasePlayer(playerId: string): Promise<PlayerDto> {
  return sendJson('POST', `/players/${encodeURIComponent(playerId)}/release`);
}

export function fetchOpenTournaments(): Promise<TournamentDto[]> {
  return getJson('/tournaments?status=open');
}

export function registerEntrant(tournamentId: string, playerId: string): Promise<TournamentDto> {
  return sendJson('POST', `/tournaments/${encodeURIComponent(tournamentId)}/entrants`, { playerId });
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
    { method: 'POST' },
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
