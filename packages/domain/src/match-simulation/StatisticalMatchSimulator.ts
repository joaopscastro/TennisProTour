import { Surface } from '../player/PlayerAttributes';
import { MatchOutcome, MatchLog, MatchLogEntry, MatchPointEntry, PointScoreLabel } from '../competition/CompetitionTypes';
import { MatchParticipant, MatchSimulator, RandomSource, SimulatedMatch } from './MatchSimulator';

const STANDARD_POINT_LABELS: readonly PointScoreLabel[] = ['0', '15', '30', '40'];

/** '0'/'15'/'30'/'40' up to deuce, then 'Ad' for whoever is one point
 * ahead once both sides have reached 40. `mine`/`theirs` are raw point
 * counts *before* the point about to be played — by construction (see
 * playGame) neither counter reaches 4 while the other is below 3, so
 * indexing STANDARD_POINT_LABELS by `mine` is always in range outside
 * deuce territory. */
function standardPointLabel(mine: number, theirs: number): PointScoreLabel {
  if (mine >= 3 && theirs >= 3) {
    if (mine === theirs) return '40'; // deuce
    if (mine === theirs + 1) return 'Ad';
    return '40'; // trailing the opponent's advantage
  }
  return STANDARD_POINT_LABELS[mine];
}

/**
 * A deliberately simple point-by-point statistical model — the
 * "Championship Manager 1992" end of the spectrum, not the "Football
 * Manager 2026 3D engine" end. Enough variance and stat-relevance to
 * feel fair and produce stories, without the years of tuning a full
 * physics-based engine would need.
 *
 * Every game (and every tiebreak) is played out as a real sequence of
 * points — 0/15/30/40, deuce, advantage — not a single coin flip
 * standing in for a whole game. That's what gives the replay UI actual
 * break-point/deuce tension to show, not just games arriving in
 * lockstep jumps.
 *
 * Pure domain logic: no I/O, no framework imports, fully
 * unit-testable by injecting a fixed RandomSource. Crucially, this
 * also means simulation happens once, up front, synchronously —
 * there is no notion of "live" inside this class at all. The
 * MatchLog it produces is what lets the frontend fake a live
 * scenario entirely client-side (see CompetitionTypes.MatchLog).
 */
export class StatisticalMatchSimulator implements MatchSimulator {
  /** Pacing constant for fake-live playback: in-game seconds per
   * point (serve + rally + recovery). Chosen so total match length
   * lands close to the old flat 240s/game constant this replaces — a
   * typical ~6-7 point game averages out to roughly the same duration
   * as before, but a long deuce battle now organically takes longer
   * and a love game takes less, instead of every game costing the
   * same regardless of how contested it was. */
  private static readonly SECONDS_PER_POINT = 35;

  constructor(private readonly random: RandomSource) {}

  simulate(playerA: MatchParticipant, playerB: MatchParticipant, surface: Surface): SimulatedMatch {
    const scoreA = this.effectiveRating(playerA, surface);
    const scoreB = this.effectiveRating(playerB, surface);

    const ratingGap = scoreA - scoreB;
    const pointWinProbabilityA = 1 / (1 + Math.exp(-ratingGap / 15));

    const { sets, log } = this.playBestOfThree(pointWinProbabilityA);
    const setsWonByA = sets.filter((s) => s.winnerIsA).length;
    const winnerIsA = setsWonByA >= 2;

    const outcome: MatchOutcome = {
      winner: winnerIsA ? playerA.playerId : playerB.playerId,
      loser: winnerIsA ? playerB.playerId : playerA.playerId,
      setScores: sets.map((s) => ({
        winnerGames: s.winnerIsA === winnerIsA ? s.gamesFor : s.gamesAgainst,
        loserGames: s.winnerIsA === winnerIsA ? s.gamesAgainst : s.gamesFor,
      })),
    };

    return { outcome, log };
  }

  private effectiveRating(participant: MatchParticipant, surface: Surface): number {
    const { technical, physical, mental } = participant.attributes;
    const technicalAvg = (technical.serve.value + technical.forehand.value + technical.backhand.value + technical.volley.value) / 4;
    const physicalAvg = (physical.speed.value + physical.stamina.value + physical.strength.value) / 3;
    const mentalAvg = (mental.consistency.value + mental.clutch.value) / 2;
    const surfaceBonus = participant.attributes.surfaceAffinities.get(surface);
    const fatiguePenalty = participant.fatigue * 0.15;

    return technicalAvg * 0.5 + physicalAvg * 0.3 + mentalAvg * 0.2 + surfaceBonus * 0.3 - fatiguePenalty;
  }

  private playBestOfThree(pointWinProbabilityA: number): {
    sets: Array<{ winnerIsA: boolean; gamesFor: number; gamesAgainst: number }>;
    log: Omit<MatchLog, 'simulatedAt'>;
  } {
    const sets: Array<{ winnerIsA: boolean; gamesFor: number; gamesAgainst: number }> = [];
    const entries: MatchLogEntry[] = [];
    const points: MatchPointEntry[] = [];
    let setsA = 0;
    let setsB = 0;
    let elapsedSeconds = 0;

    while (setsA < 2 && setsB < 2) {
      const setNumber = sets.length + 1;
      const set = this.playSet(pointWinProbabilityA, setNumber, entries, points, elapsedSeconds);
      elapsedSeconds = set.elapsedSecondsAfter;
      sets.push(set.result);
      if (set.result.winnerIsA) setsA++;
      else setsB++;
    }

    return { sets, log: { entries, points, totalDurationSeconds: elapsedSeconds } };
  }

  private playSet(
    pointWinProbabilityA: number,
    setNumber: number,
    entriesOut: MatchLogEntry[],
    pointsOut: MatchPointEntry[],
    elapsedSecondsStart: number,
  ): {
    result: { winnerIsA: boolean; gamesFor: number; gamesAgainst: number };
    elapsedSecondsAfter: number;
  } {
    let gamesA = 0;
    let gamesB = 0;
    let elapsedSeconds = elapsedSecondsStart;

    while (true) {
      const gameNumber = gamesA + gamesB + 1;
      const tiebreak = gamesA === 6 && gamesB === 6;

      const game = tiebreak
        ? this.playTiebreak(pointWinProbabilityA, setNumber, gameNumber, pointsOut, elapsedSeconds)
        : this.playGame(pointWinProbabilityA, setNumber, gameNumber, pointsOut, elapsedSeconds);
      elapsedSeconds = game.elapsedSecondsAfter;

      if (game.aWinsGame) gamesA++;
      else gamesB++;

      entriesOut.push({
        offsetSeconds: elapsedSeconds,
        setNumber,
        gamesForA: gamesA,
        gamesForB: gamesB,
        wonBy: game.aWinsGame ? 'A' : 'B',
      });

      if (tiebreak) {
        // A tiebreak always ends the set 7-6 (for whoever just won it).
        return {
          result: game.aWinsGame
            ? { winnerIsA: true, gamesFor: 7, gamesAgainst: 6 }
            : { winnerIsA: false, gamesFor: 7, gamesAgainst: 6 },
          elapsedSecondsAfter: elapsedSeconds,
        };
      }

      const leader = gamesA > gamesB ? gamesA : gamesB;
      const trailer = gamesA > gamesB ? gamesB : gamesA;
      const setWon = leader >= 6 && leader - trailer >= 2;
      if (setWon) {
        return {
          result:
            gamesA > gamesB
              ? { winnerIsA: true, gamesFor: gamesA, gamesAgainst: gamesB }
              : { winnerIsA: false, gamesFor: gamesB, gamesAgainst: gamesA },
          elapsedSecondsAfter: elapsedSeconds,
        };
      }
    }
  }

  /** Plays one standard game point-by-point: 0/15/30/40, deuce at
   * 40-40, and advantage swings until someone leads by 2. */
  private playGame(
    pointWinProbabilityA: number,
    setNumber: number,
    gameNumber: number,
    pointsOut: MatchPointEntry[],
    elapsedSecondsStart: number,
  ): { aWinsGame: boolean; elapsedSecondsAfter: number } {
    let pointsA = 0;
    let pointsB = 0;
    let elapsedSeconds = elapsedSecondsStart;

    while (true) {
      const pointScoreA = standardPointLabel(pointsA, pointsB);
      const pointScoreB = standardPointLabel(pointsB, pointsA);

      const aWinsPoint = this.random.next() < pointWinProbabilityA;
      if (aWinsPoint) pointsA++;
      else pointsB++;
      elapsedSeconds += StatisticalMatchSimulator.SECONDS_PER_POINT;

      pointsOut.push({
        offsetSeconds: elapsedSeconds,
        setNumber,
        gameNumber,
        pointScoreA,
        pointScoreB,
        wonBy: aWinsPoint ? 'A' : 'B',
      });

      if (pointsA >= 4 && pointsA - pointsB >= 2) return { aWinsGame: true, elapsedSecondsAfter: elapsedSeconds };
      if (pointsB >= 4 && pointsB - pointsA >= 2) return { aWinsGame: false, elapsedSecondsAfter: elapsedSeconds };
    }
  }

  /** Plays a tiebreak point-by-point: first to 7 points with a
   * 2-point margin (sudden-death beyond that, same as real tennis —
   * 8-6, 10-8, and so on). Scored as literal point counts, not
   * 0/15/30/40 — there's no "deuce"/"advantage" vocabulary in a
   * tiebreak, only the raw score. */
  private playTiebreak(
    pointWinProbabilityA: number,
    setNumber: number,
    gameNumber: number,
    pointsOut: MatchPointEntry[],
    elapsedSecondsStart: number,
  ): { aWinsGame: boolean; elapsedSecondsAfter: number } {
    let pointsA = 0;
    let pointsB = 0;
    let elapsedSeconds = elapsedSecondsStart;

    while (true) {
      const pointScoreA: PointScoreLabel = `${pointsA}`;
      const pointScoreB: PointScoreLabel = `${pointsB}`;

      const aWinsPoint = this.random.next() < pointWinProbabilityA;
      if (aWinsPoint) pointsA++;
      else pointsB++;
      elapsedSeconds += StatisticalMatchSimulator.SECONDS_PER_POINT;

      pointsOut.push({
        offsetSeconds: elapsedSeconds,
        setNumber,
        gameNumber,
        pointScoreA,
        pointScoreB,
        wonBy: aWinsPoint ? 'A' : 'B',
      });

      if (pointsA >= 7 && pointsA - pointsB >= 2) return { aWinsGame: true, elapsedSecondsAfter: elapsedSeconds };
      if (pointsB >= 7 && pointsB - pointsA >= 2) return { aWinsGame: false, elapsedSecondsAfter: elapsedSeconds };
    }
  }
}
