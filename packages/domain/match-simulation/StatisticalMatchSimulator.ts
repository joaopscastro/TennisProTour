import { Surface } from '../player/PlayerAttributes';
import { MatchOutcome, MatchLog, MatchLogEntry } from '../competition/CompetitionTypes';
import { MatchParticipant, MatchSimulator, RandomSource, SimulatedMatch } from './MatchSimulator';

/**
 * A deliberately simple point-by-point statistical model — the
 * "Championship Manager 1992" end of the spectrum, not the "Football
 * Manager 2026 3D engine" end. Enough variance and stat-relevance to
 * feel fair and produce stories, without the years of tuning a full
 * physics-based engine would need.
 *
 * Pure domain logic: no I/O, no framework imports, fully
 * unit-testable by injecting a fixed RandomSource. Crucially, this
 * also means simulation happens once, up front, synchronously —
 * there is no notion of "live" inside this class at all. The
 * MatchLog it produces is what lets the frontend fake a live
 * scenario entirely client-side (see CompetitionTypes.MatchLog).
 */
export class StatisticalMatchSimulator implements MatchSimulator {
  private static readonly SECONDS_PER_GAME = 240; // pacing constant for fake-live playback

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
    log: MatchLog;
  } {
    const sets: Array<{ winnerIsA: boolean; gamesFor: number; gamesAgainst: number }> = [];
    const entries: MatchLogEntry[] = [];
    let setsA = 0;
    let setsB = 0;
    let elapsedSeconds = 0;

    while (setsA < 2 && setsB < 2) {
      const setNumber = sets.length + 1;
      const set = this.playSet(pointWinProbabilityA, setNumber, entries, elapsedSeconds);
      elapsedSeconds = set.elapsedSecondsAfter;
      sets.push(set.result);
      if (set.result.winnerIsA) setsA++;
      else setsB++;
    }

    return { sets, log: { entries, totalDurationSeconds: elapsedSeconds } };
  }

  private playSet(
    pointWinProbabilityA: number,
    setNumber: number,
    entriesOut: MatchLogEntry[],
    elapsedSecondsStart: number,
  ): {
    result: { winnerIsA: boolean; gamesFor: number; gamesAgainst: number };
    elapsedSecondsAfter: number;
  } {
    let gamesA = 0;
    let gamesB = 0;
    let elapsedSeconds = elapsedSecondsStart;

    while (true) {
      const aWinsGame = this.random.next() < pointWinProbabilityA;
      if (aWinsGame) gamesA++;
      else gamesB++;
      elapsedSeconds += StatisticalMatchSimulator.SECONDS_PER_GAME;

      entriesOut.push({
        offsetSeconds: elapsedSeconds,
        setNumber,
        gamesForA: gamesA,
        gamesForB: gamesB,
        wonBy: aWinsGame ? 'A' : 'B',
      });

      const leader = gamesA > gamesB ? gamesA : gamesB;
      const trailer = gamesA > gamesB ? gamesB : gamesA;
      const setWon = leader >= 6 && leader - trailer >= 2;
      const tiebreakNeeded = gamesA === 6 && gamesB === 6;

      if (tiebreakNeeded) {
        const aWinsTiebreak = this.random.next() < pointWinProbabilityA;
        elapsedSeconds += StatisticalMatchSimulator.SECONDS_PER_GAME;
        entriesOut.push({
          offsetSeconds: elapsedSeconds,
          setNumber,
          gamesForA: aWinsTiebreak ? 7 : 6,
          gamesForB: aWinsTiebreak ? 6 : 7,
          wonBy: aWinsTiebreak ? 'A' : 'B',
        });
        return {
          result: aWinsTiebreak
            ? { winnerIsA: true, gamesFor: 7, gamesAgainst: 6 }
            : { winnerIsA: false, gamesFor: 7, gamesAgainst: 6 },
          elapsedSecondsAfter: elapsedSeconds,
        };
      }
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
}
