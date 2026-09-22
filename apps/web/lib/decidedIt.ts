import type { MatchLogDto } from './api';

/**
 * The "what decided it" panel on the replay screen shows the inputs the
 * simulator actually read for a match. This resolves one side's values,
 * preferring the inputs RECORDED in the match log (the real match-time
 * numbers) and falling back to the player's CURRENT values only for logs
 * simulated before that field existed — never fabricating a recorded
 * value. Pure and side-effect-free so it is directly testable.
 */

/** The minimal player shape this needs — avoids pulling the full DTO
 * into a pure helper (and its test). */
export interface DecidedPlayer {
  fatigue: number;
  form: number;
  nationality: string;
  attributes: { surfaceAffinities: Record<string, number> };
}

export type RecordedSideInputs = NonNullable<MatchLogDto['inputs']>['a'];

export interface DecidedSide {
  fatigue: number | null;
  form: number | null;
  surfaceAffinity: number | null;
  homeAdvantage: boolean;
  /** True when these are the recorded match-time values; false when they
   * are the player's current values (an older log, no `inputs`). */
  atMatchTime: boolean;
}

export function resolveDecidedSide(
  recorded: RecordedSideInputs | null | undefined,
  player: DecidedPlayer | null,
  surface: string | null,
  hostCountry: string | null,
): DecidedSide {
  if (recorded) {
    return {
      fatigue: recorded.fatigue,
      form: recorded.form,
      surfaceAffinity: recorded.surfaceAffinity,
      homeAdvantage: recorded.homeAdvantage,
      atMatchTime: true,
    };
  }
  return {
    fatigue: player ? player.fatigue : null,
    form: player ? player.form : null,
    surfaceAffinity: player && surface ? player.attributes.surfaceAffinities[surface] ?? null : null,
    // Home advantage is stable for the match (nationality vs. host
    // country both don't change mid-event), so deriving it is the real
    // value, not a stand-in.
    homeAdvantage: hostCountry != null && player?.nationality === hostCountry,
    atMatchTime: false,
  };
}
