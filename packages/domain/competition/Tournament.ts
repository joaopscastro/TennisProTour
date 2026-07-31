import { TournamentId, GameWeek, PlayerId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { BracketRound, MatchOutcome, TournamentEntrant, TournamentTier } from './CompetitionTypes';

export interface TournamentProps {
  id: TournamentId;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: GameWeek;
  entrants: TournamentEntrant[];
  firstRound: BracketRound;
}

/**
 * Tournament aggregate root. Owns bracket integrity: a match's
 * outcome can only be recorded once, and a new round can only be
 * added once every match in the previous round has one. Seeding a
 * bracket is a separate, not-yet-built `BracketGenerator` domain
 * service — Tournament only enforces the rules a bracket must satisfy,
 * not how one gets generated.
 */
export class Tournament {
  private rounds: BracketRound[];
  private domainEvents: DomainEvent[] = [];

  private constructor(
    readonly id: TournamentId,
    readonly tier: TournamentTier,
    readonly surface: Surface,
    readonly weekScheduled: GameWeek,
    readonly entrants: ReadonlyArray<TournamentEntrant>,
    firstRound: BracketRound,
  ) {
    this.rounds = [firstRound];
  }

  static schedule(props: TournamentProps): Tournament {
    if (props.entrants.length < 2) {
      throw new Error('A tournament needs at least 2 entrants');
    }
    if (props.firstRound.roundNumber !== 1) {
      throw new Error('First round must be round number 1');
    }
    return new Tournament(
      props.id,
      props.tier,
      props.surface,
      props.weekScheduled,
      props.entrants,
      props.firstRound,
    );
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
