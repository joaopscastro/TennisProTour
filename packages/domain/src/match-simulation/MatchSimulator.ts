import { PlayerAttributes, Surface } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';
import { MatchOutcome, MatchLog } from '../competition/CompetitionTypes';

export interface MatchParticipant {
  playerId: PlayerId;
  attributes: PlayerAttributes;
  fatigue: number; // 0–100, read from Player at simulation time
}

export interface SimulatedMatch {
  outcome: MatchOutcome;
  /** Full replay log for client-side fake-live playback. Kept
   * separate from `outcome` because callers that only care about the
   * result (e.g. updating rankings) shouldn't be forced to also carry
   * the heavier log around. */
  log: MatchLog;
}

/**
 * Port (interface) for match simulation. This is the seam the whole
 * game's credibility rests on — per the architecture plan, treat this
 * as the highest-priority piece to test and tune.
 *
 * Depending on an interface here (not a concrete class) means the
 * Competition context — and any future single-player/preview mode —
 * can consume match simulation without caring whether it's the
 * current statistical model or a future, more elaborate one
 * (Open/Closed: swap SimpleMatchSimulator for a v2 without touching
 * any caller).
 */
export interface MatchSimulator {
  simulate(playerA: MatchParticipant, playerB: MatchParticipant, surface: Surface): SimulatedMatch;
}

/** Injected rather than imported directly (Dependency Inversion) so
 * the simulator is fully deterministic and testable: pass a seeded
 * RNG in tests, a real random source in production. */
export interface RandomSource {
  /** Returns a float in [0, 1). */
  next(): number;
}
