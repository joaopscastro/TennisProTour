import { GameWeek, PairId, PlayerId, TournamentId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { BracketRound, MatchOutcome, TournamentDoublesPair } from './CompetitionTypes';
import { GroupStageGenerator } from './GroupStageGenerator';
import { Group, groupStandings } from './GroupStage';
import { BracketGenerator } from './BracketGenerator';

export interface MastersCupOpenProps {
  id: TournamentId;
  /** The season this cup is the capstone of. */
  season: number;
  weekScheduled: GameWeek;
  surface: Surface;
  /** Top 8 singles entrants, in seed order (1 = highest). */
  singlesEntrants: PlayerId[];
  /** Top 8 pairs, in seed order. */
  doublesEntrants: TournamentDoublesPair[];
}

/**
 * The Masters Cup (P8b) — the season-end capstone event, run for BOTH
 * singles (top 8 players) and doubles (top 8 pairs). Its genuinely new
 * shape is the ROUND-ROBIN GROUP STAGE: two groups of four, everyone
 * plays the other three, and the top two per group advance to a 4-player
 * knockout (semis + final). The knockout half reuses the existing
 * `BracketRound`/`BracketGenerator` single-elimination machinery; the
 * group stage reuses `GroupStageGenerator`/`groupStandings`.
 *
 * Deliberately a SEPARATE aggregate from `Tournament`: a Tournament is a
 * single-discipline, single-elimination event, while the Masters Cup is a
 * compound, two-discipline, groups-then-knockout event. Trying to wedge
 * it into Tournament would contort that aggregate far more than a small
 * dedicated one.
 */
export class MastersCup {
  private _singlesGroups: Group<PlayerId>[];
  private _doublesGroups: Group<PairId>[];
  private singlesKnockoutRounds: BracketRound<PlayerId>[] = [];
  private doublesKnockoutRounds: BracketRound<PairId>[] = [];

  private constructor(
    readonly id: TournamentId,
    readonly season: number,
    readonly weekScheduled: GameWeek,
    readonly surface: Surface,
    readonly singlesEntrants: ReadonlyArray<PlayerId>,
    readonly doublesEntrants: ReadonlyArray<TournamentDoublesPair>,
  ) {
    this._singlesGroups = new GroupStageGenerator()
      .generate(singlesEntrants.map((id, i) => ({ playerId: id, seed: i + 1 })), 4).groups as Group<PlayerId>[];
    this._doublesGroups = new GroupStageGenerator()
      .generate(doublesEntrants.map((p, i) => ({ playerId: p.pairId, seed: i + 1 })), 4).groups as Group<PairId>[];
  }

  static open(props: MastersCupOpenProps): MastersCup {
    return new MastersCup(props.id, props.season, props.weekScheduled, props.surface, props.singlesEntrants, props.doublesEntrants);
  }

  static reconstitute(props: MastersCupOpenProps & {
    singlesGroups: Group<PlayerId>[];
    doublesGroups: Group<PairId>[];
    singlesKnockoutRounds?: BracketRound<PlayerId>[];
    doublesKnockoutRounds?: BracketRound<PairId>[];
  }): MastersCup {
    const cup = new MastersCup(props.id, props.season, props.weekScheduled, props.surface, props.singlesEntrants, props.doublesEntrants);
    cup._singlesGroups = [...props.singlesGroups];
    cup._doublesGroups = [...props.doublesGroups];
    cup.singlesKnockoutRounds = [...(props.singlesKnockoutRounds ?? [])];
    cup.doublesKnockoutRounds = [...(props.doublesKnockoutRounds ?? [])];
    return cup;
  }

  get singlesGroups(): ReadonlyArray<Group<PlayerId>> {
    return this._singlesGroups;
  }

  get doublesGroups(): ReadonlyArray<Group<PairId>> {
    return this._doublesGroups;
  }

  get singlesKnockout(): ReadonlyArray<BracketRound<PlayerId>> {
    return this.singlesKnockoutRounds;
  }

  get doublesKnockout(): ReadonlyArray<BracketRound<PairId>> {
    return this.doublesKnockoutRounds;
  }

  get hasKnockout(): boolean {
    return this.singlesKnockoutRounds.length > 0;
  }

  // ---- group stage ----

  isGroupStageComplete<S extends string>(groups: ReadonlyArray<Group<S>>): boolean {
    return groups.every((g) => g.matches.every((m) => m.outcome !== null));
  }

  get singlesGroupStageComplete(): boolean {
    return this.isGroupStageComplete(this._singlesGroups);
  }

  get doublesGroupStageComplete(): boolean {
    return this.isGroupStageComplete(this._doublesGroups);
  }

  /** Top 2 per singles group, in the bracket slot order that makes the
   * two semifinals CROSS groups (group 1 winner vs group 2 runner-up,
   * group 2 winner vs group 1 runner-up) rather than rematches of
   * round-robin games. `seedKnockout` feeds this into
   * `BracketGenerator.generate(..., 4)`, whose 4-slot seed order is
   * [1,4,2,3] → matches (slot1, slot4) and (slot2, slot3) — so the
   * array must be [g1 winner, g2 winner, g1 runner-up, g2 runner-up] for
   * slot1 vs slot4 to pair g1-winner against g2-runner-up. Empty until
   * the group stage is complete. */
  singlesSemifinalists(): PlayerId[] {
    if (!this.singlesGroupStageComplete) return [];
    const g1 = groupStandings<PlayerId>(this._singlesGroups[0]);
    const g2 = groupStandings<PlayerId>(this._singlesGroups[1]);
    return [g1[0].entrant, g2[0].entrant, g1[1].entrant, g2[1].entrant];
  }

  doublesSemifinalists(): PairId[] {
    if (!this.doublesGroupStageComplete) return [];
    const g1 = groupStandings<PairId>(this._doublesGroups[0]);
    const g2 = groupStandings<PairId>(this._doublesGroups[1]);
    return [g1[0].entrant, g2[0].entrant, g1[1].entrant, g2[1].entrant];
  }

  getSinglesGroupScheduledMatch(groupIndex: number, matchIndex: number): { entrantA: PlayerId; entrantB: PlayerId } {
    const match = this._singlesGroups[groupIndex].matches[matchIndex];
    if (match.outcome) throw new Error(`Singles group match ${groupIndex}/${matchIndex} already has an outcome`);
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  getDoublesGroupScheduledMatch(groupIndex: number, matchIndex: number): { entrantA: PairId; entrantB: PairId } {
    const match = this._doublesGroups[groupIndex].matches[matchIndex];
    if (match.outcome) throw new Error(`Doubles group match ${groupIndex}/${matchIndex} already has an outcome`);
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  recordSinglesGroupMatchOutcome(groupIndex: number, matchIndex: number, outcome: MatchOutcome<PlayerId>): void {
    const match = this._singlesGroups[groupIndex].matches[matchIndex];
    if (match.outcome) throw new Error(`Singles group match ${groupIndex}/${matchIndex} already has an outcome`);
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled entrants');
    }
    this._singlesGroups[groupIndex].matches[matchIndex] = { ...match, outcome };
  }

  recordDoublesGroupMatchOutcome(groupIndex: number, matchIndex: number, outcome: MatchOutcome<PairId>): void {
    const match = this._doublesGroups[groupIndex].matches[matchIndex];
    if (match.outcome) throw new Error(`Doubles group match ${groupIndex}/${matchIndex} already has an outcome`);
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled pairs');
    }
    this._doublesGroups[groupIndex].matches[matchIndex] = { ...match, outcome };
  }

  // ---- advancement ----

  /** Seeds the knockout (semis + final) once BOTH group stages are
   * complete. Idempotent by construction (guarded by hasKnockout). */
  seedKnockout(): void {
    if (this.hasKnockout) return;
    if (!this.singlesGroupStageComplete || !this.doublesGroupStageComplete) {
      throw new Error('Cannot seed the Masters Cup knockout before both group stages are complete');
    }
    const singles = this.singlesSemifinalists();
    const doubles = this.doublesSemifinalists();
    // A 4-entrant single-elim bracket: round 1 = 2 semis, then round 2
    // (the final) is added lazily once both semis complete.
    const bracket = <S extends string>(entrants: S[]): BracketRound<S>[] =>
      new BracketGenerator().generate(entrants.map((id, i) => ({ playerId: id, seed: i + 1 })), 4);
    this.singlesKnockoutRounds = bracket(singles);
    this.doublesKnockoutRounds = bracket(doubles);
  }

  getSinglesKnockoutScheduledMatch(roundNumber: number, matchIndex: number): { entrantA: PlayerId; entrantB: PlayerId } {
    const match = this.requireKnockoutMatch(this.singlesKnockoutRounds, roundNumber, matchIndex);
    if (match.outcome) throw new Error(`Singles knockout ${roundNumber}/${matchIndex} already has an outcome`);
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  getDoublesKnockoutScheduledMatch(roundNumber: number, matchIndex: number): { entrantA: PairId; entrantB: PairId } {
    const match = this.requireKnockoutMatch(this.doublesKnockoutRounds, roundNumber, matchIndex);
    if (match.outcome) throw new Error(`Doubles knockout ${roundNumber}/${matchIndex} already has an outcome`);
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  recordSinglesKnockoutMatchOutcome(roundNumber: number, matchIndex: number, outcome: MatchOutcome<PlayerId>): void {
    const rounds = this.singlesKnockoutRounds;
    const roundIndex = rounds.findIndex((r) => r.roundNumber === roundNumber);
    const match = this.requireKnockoutMatch(rounds, roundNumber, matchIndex);
    if (match.outcome) throw new Error(`Singles knockout ${roundNumber}/${matchIndex} already has an outcome`);
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled entrants');
    }
    const updated = roundIndex >= 0 ? { ...rounds[roundIndex], matches: rounds[roundIndex].matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m)) } : null;
    if (updated) rounds[roundIndex] = updated;
    if (updated && !this.isKnockoutFinalRound(roundNumber) && updated.matches.every((m) => m.outcome !== null)) {
      // Seed the next (final) round from the two semifinal winners.
      const winners = updated.matches.map((m) => m.outcome!.winner);
      rounds.push({ roundNumber: roundNumber + 1, matches: [{ entrantA: winners[0], entrantB: winners[1], outcome: null }] });
    }
  }

  recordDoublesKnockoutMatchOutcome(roundNumber: number, matchIndex: number, outcome: MatchOutcome<PairId>): void {
    const rounds = this.doublesKnockoutRounds;
    const roundIndex = rounds.findIndex((r) => r.roundNumber === roundNumber);
    const match = this.requireKnockoutMatch(rounds, roundNumber, matchIndex);
    if (match.outcome) throw new Error(`Doubles knockout ${roundNumber}/${matchIndex} already has an outcome`);
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled pairs');
    }
    const updated = roundIndex >= 0 ? { ...rounds[roundIndex], matches: rounds[roundIndex].matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m)) } : null;
    if (updated) rounds[roundIndex] = updated;
    if (updated && !this.isKnockoutFinalRound(roundNumber) && updated.matches.every((m) => m.outcome !== null)) {
      const winners = updated.matches.map((m) => m.outcome!.winner);
      rounds.push({ roundNumber: roundNumber + 1, matches: [{ entrantA: winners[0], entrantB: winners[1], outcome: null }] });
    }
  }

  isKnockoutFinalRound(roundNumber: number): boolean {
    return roundNumber === 2; // semis (1) then final (2) for a 4-entrant knockout
  }

  get singlesKnockoutComplete(): boolean {
    return this.singlesKnockoutRounds.length >= 2 && this.singlesKnockoutRounds[1].matches.every((m) => m.outcome !== null);
  }

  get doublesKnockoutComplete(): boolean {
    return this.doublesKnockoutRounds.length >= 2 && this.doublesKnockoutRounds[1].matches.every((m) => m.outcome !== null);
  }

  get singlesChampion(): PlayerId | null {
    if (!this.singlesKnockoutComplete) return null;
    return this.singlesKnockoutRounds[1].matches[0].outcome?.winner ?? null;
  }

  get doublesChampion(): PairId | null {
    if (!this.doublesKnockoutComplete) return null;
    return this.doublesKnockoutRounds[1].matches[0].outcome?.winner ?? null;
  }

  private requireKnockoutMatch<S extends string>(rounds: BracketRound<S>[], roundNumber: number, matchIndex: number) {
    const round = rounds.find((r) => r.roundNumber === roundNumber);
    if (!round) throw new Error(`Knockout round ${roundNumber} has not been generated yet`);
    const match = round.matches[matchIndex];
    if (!match) throw new Error(`No knockout match at index ${matchIndex} in round ${roundNumber}`);
    return match;
  }
}
