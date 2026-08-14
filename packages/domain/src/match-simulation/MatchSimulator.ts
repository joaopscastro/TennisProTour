import { PlayerAttributes, Surface } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';
import { MatchOutcome, MatchLog } from '../competition/CompetitionTypes';

/**
 * One side of a match, generic over the slot id `S` so the same shape
 * describes a singles player (`S = PlayerId`, the default) and a
 * doubles pair (`S = PairId`, where `playerId` actually holds the PAIR's
 * id — see DoublesPairPolicy, which produces a composite participant
 * for a two-player side). The simulator never cares what an id names;
 * it only reports which side won via that id.
 */
export interface MatchParticipant<S extends string = PlayerId> {
  playerId: S;
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
  /** The side's combined doubles skill (P7b) — 0-100, only ever set for
   * a DOUBLES side (a composite of two players produced by
   * DoublesPairPolicy). Absent for a singles participant, so the sim
   * adds no doubles term and stays byte-identical for singles. The
   * simulator applies its own `DOUBLES_SKILL_WEIGHT` to this — RR's
   * "40% of the doubles stat adds to skill" rule, a placeholder. */
  doublesSkill?: number;
  /** The side's pair chemistry (P7c) — 0-100, only for a doubles side
   * that is a PERSISTENT partnership (a random pairing has none). The
   * simulator applies `CHEMISTRY_BONUS_PER_POINT` to it; absent for
   * singles and for ad-hoc pairs, so nothing changes there. */
  chemistry?: number;
}

export interface SimulatedMatch<S extends string = PlayerId> {
  outcome: MatchOutcome<S>;
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
  simulate<S extends string>(playerA: MatchParticipant<S>, playerB: MatchParticipant<S>, surface: Surface): SimulatedMatch<S>;
}

/** Injected rather than imported directly (Dependency Inversion) so
 * the simulator is fully deterministic and testable: pass a seeded
 * RNG in tests, a real random source in production. */
export interface RandomSource {
  /** Returns a float in [0, 1). */
  next(): number;
}
