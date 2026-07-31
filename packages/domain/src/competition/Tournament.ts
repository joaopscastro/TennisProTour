import { TournamentId, GameWeek, PlayerId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { BracketRound, DrawSize, MatchOutcome, TournamentEntrant, TournamentTier } from './CompetitionTypes';

export interface TournamentOpenProps {
  id: TournamentId;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: GameWeek;
  drawSize: DrawSize;
}

/**
 * Tournament aggregate root. Owns bracket integrity across its whole
 * lifecycle: registration is open (entrants trickle in one at a time,
 * capped at `drawSize`) until `startWithBracket` seeds the draw; after
 * that, a match's outcome can only be recorded once, and a new round
 * can only be added once every match in the previous round has one.
 * Seeding itself is a separate domain service (`BracketGenerator`) —
 * Tournament only enforces the rules a bracket must satisfy, not how
 * one gets seeded.
 */
export class Tournament {
  private _entrants: TournamentEntrant[] = [];
  private rounds: BracketRound[] = [];
  private domainEvents: DomainEvent[] = [];

  private constructor(
    readonly id: TournamentId,
    readonly tier: TournamentTier,
    readonly surface: Surface,
    readonly weekScheduled: GameWeek,
    readonly drawSize: DrawSize,
  ) {}

  static open(props: TournamentOpenProps): Tournament {
    return new Tournament(props.id, props.tier, props.surface, props.weekScheduled, props.drawSize);
  }

  get entrants(): ReadonlyArray<TournamentEntrant> {
    return this._entrants;
  }

  get hasStarted(): boolean {
    return this.rounds.length > 0;
  }

  registerEntrant(entrant: TournamentEntrant): void {
    if (this.hasStarted) {
      throw new Error(`Cannot register an entrant: tournament ${this.id} has already started`);
    }
    if (this._entrants.some((e) => e.playerId === entrant.playerId)) {
      throw new Error(`Player ${entrant.playerId} is already registered for tournament ${this.id}`);
    }
    if (this._entrants.length >= this.drawSize) {
      throw new Error(`Tournament ${this.id}'s draw is full (${this.drawSize} entrants)`);
    }
    this._entrants.push(entrant);
  }

  startWithBracket(rounds: BracketRound[]): void {
    if (this.hasStarted) {
      throw new Error(`Tournament ${this.id} has already started`);
    }
    if (rounds.length === 0) {
      throw new Error('Cannot start a tournament with an empty bracket');
    }
    if (rounds[0].roundNumber !== 1) {
      throw new Error('The first bracket round must be round number 1');
    }
    this.rounds = [...rounds];
    this.domainEvents.push({
      type: 'TournamentStarted',
      payload: { tournamentId: this.id, entrantCount: this._entrants.length },
    });
  }

  getScheduledMatch(roundNumber: number, matchIndex: number): { entrantA: PlayerId; entrantB: PlayerId } {
    const match = this.requireMatch(roundNumber, matchIndex);
    if (match.outcome) {
      throw new Error(`Match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  recordMatchOutcome(roundNumber: number, matchIndex: number, outcome: MatchOutcome): void {
    const roundIndex = this.rounds.findIndex((round) => round.roundNumber === roundNumber);
    const round = this.rounds[roundIndex];
    const match = this.requireMatch(roundNumber, matchIndex);
    if (match.outcome) {
      throw new Error(`Match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }

    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m));
    this.rounds[roundIndex] = { ...round, matches: updatedMatches };

    this.domainEvents.push({
      type: 'MatchOutcomeRecorded',
      payload: { tournamentId: this.id, roundNumber, matchIndex, winner: outcome.winner },
    });

    if (updatedMatches.every((m) => m.outcome !== null)) {
      this.domainEvents.push({
        type: 'TournamentRoundAdvanced',
        payload: { tournamentId: this.id, roundNumber },
      });
    }
  }

  isRoundComplete(roundNumber: number): boolean {
    const round = this.rounds.find((r) => r.roundNumber === roundNumber);
    if (!round) return false;
    return round.matches.every((m) => m.outcome !== null);
  }

  addRound(round: BracketRound): void {
    const expectedRoundNumber = this.rounds.length + 1;
    if (round.roundNumber !== expectedRoundNumber) {
      throw new Error(`Expected round ${expectedRoundNumber}, got ${round.roundNumber}`);
    }
    if (!this.isRoundComplete(expectedRoundNumber - 1)) {
      throw new Error(`Cannot add round ${expectedRoundNumber} before round ${expectedRoundNumber - 1} is complete`);
    }
    this.rounds.push(round);
  }

  getRounds(): ReadonlyArray<BracketRound> {
    return this.rounds;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }

  private requireMatch(roundNumber: number, matchIndex: number) {
    const round = this.rounds.find((r) => r.roundNumber === roundNumber);
    if (!round) throw new Error(`Round ${roundNumber} has not been generated yet`);
    const match = round.matches[matchIndex];
    if (!match) throw new Error(`No match at index ${matchIndex} in round ${roundNumber}`);
    return match;
  }
}
