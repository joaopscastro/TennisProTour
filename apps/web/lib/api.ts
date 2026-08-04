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

export function fetchRoster(managerId: string): Promise<PlayerDto[]> {
  return getJson(`/managers/${encodeURIComponent(managerId)}/players`);
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
