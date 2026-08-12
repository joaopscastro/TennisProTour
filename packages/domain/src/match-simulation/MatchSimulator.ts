import { PlayerAttributes, Surface } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';
import { MatchOutcome, MatchLog } from '../competition/CompetitionTypes';

export interface MatchParticipant {
  playerId: PlayerId;
  attributes: PlayerAttributes;
  fatigue: number; // 0–100, read from Player at simulation time
  form: number; // 0–100 rhythm counter, read from Player at simulation time
  /** True when this match's tournament is in the player's own country
   * (home advantage, P6). Optional — absent/false means no bonus, so
   * every existing caller and test is unaffected. Resolved by
   * SimulateMatchUseCase (player nationality == tournament hostCountry),
   * not by the simulator, which never sees nationality/host country
   * directly — it stays a pure function of match-relevant inputs. */
  homeAdvantage?: boolean;
}

export interface SimulatedMatch {
  outcome: MatchOutcome;
  /** Full replay log for client-side fake-live playback. Kept
   * separate from `outcome` because callers that only care about the
   * result (e.g. updating rankings) shouldn't be forced to also carry
   * the heavier log around.
   *
   * Missing `simulatedAt` on purpose: the simulator is pure and
   * deterministic given a RandomSource, with no real Date.now()
   * dependency, so it cannot honestly produce a real-world timestamp.
   * The caller (SimulateMatchUseCase) stamps that on before handing
   * the log to MatchLogStorePort — see MatchLog's own doc comment. */
  log: Omit<MatchLog, 'simulatedAt'>;
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
