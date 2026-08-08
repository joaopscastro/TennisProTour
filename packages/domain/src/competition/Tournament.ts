import { TournamentId, GameWeek, PlayerId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { AgeBand, BracketRound, DrawSize, MatchOutcome, TournamentEntrant, TournamentTier, isJuniorTier } from './CompetitionTypes';

export interface TournamentOpenProps {
  id: TournamentId;
  /** A real, original display name (see TournamentNameGenerator) —
   * REQUIRED, not optional: there is no such thing as a nameless or
   * placeholder-named tournament. This is one half of that guarantee;
   * the other half is open()/reconstitute()'s non-empty runtime check
   * below, since TypeScript alone can't stop a caller passing `''`. */
  name: string;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: GameWeek;
  drawSize: DrawSize;
  /** Required for junior tiers (J30-J500, JuniorMasters), forbidden for
   * senior tiers — validated in open()/reconstitute(). Lives on the
   * tournament instance, not folded into the tier name, so the same
   * six J-grades work identically for u14 and u16 (see JuniorTier's
   * doc comment in CompetitionTypes.ts). */
  ageBand?: AgeBand | null;
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
    readonly name: string,
    readonly tier: TournamentTier,
    readonly surface: Surface,
    readonly weekScheduled: GameWeek,
    readonly drawSize: DrawSize,
    readonly ageBand: AgeBand | null,
  ) {}

  /** Junior tiers must carry an ageBand; senior tiers must not — a
   * `u16` age band on a `challenger` tournament, or a bandless `j100`,
   * are both invalid states this aggregate refuses to construct. */
  private static validateAgeBand(tier: TournamentTier, ageBand: AgeBand | null): void {
    if (isJuniorTier(tier) && ageBand === null) {
      throw new Error(`Tournament tier '${tier}' requires an ageBand`);
    }
    if (!isJuniorTier(tier) && ageBand !== null) {
      throw new Error(`Tournament tier '${tier}' must not have an ageBand`);
    }
  }

  /** Runtime half of the "every tournament has a real name" guarantee
   * (see TournamentOpenProps.name's doc comment) — closes the loophole
   * a required TypeScript field alone can't: a caller technically CAN
   * still pass `''` or `'   '` at runtime, so this rejects that
   * outright rather than silently accepting a blank/junk name. */
  private static validateName(name: string): void {
    if (name.trim().length === 0) {
      throw new Error('Tournament name must not be empty');
    }
  }

  static open(props: TournamentOpenProps): Tournament {
    const ageBand = props.ageBand ?? null;
    Tournament.validateAgeBand(props.tier, ageBand);
    Tournament.validateName(props.name);
    return new Tournament(props.id, props.name, props.tier, props.surface, props.weekScheduled, props.drawSize, ageBand);
  }

  /** Rehydrates a persisted tournament (repository adapters only).
   * Unlike open()/registerEntrant()/startWithBracket(), this is not a
   * sequence of domain actions — it restores state as-is and emits NO
   * events (loading a started tournament back is not starting it). */
  static reconstitute(
    props: TournamentOpenProps & { entrants: TournamentEntrant[]; rounds: BracketRound[] },
  ): Tournament {
    const ageBand = props.ageBand ?? null;
    Tournament.validateAgeBand(props.tier, ageBand);
    Tournament.validateName(props.name);
    const tournament = new Tournament(props.id, props.name, props.tier, props.surface, props.weekScheduled, props.drawSize, ageBand);
    tournament._entrants = [...props.entrants];
    tournament.rounds = [...props.rounds];
    return tournament;
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
    // A real, previously-latent bug this guard closes: BracketGenerator's
    // standard seed-slot placement (1v16, 8v9, 4v13, ...) spreads top
    // seeds apart specifically so they can't meet early — which means a
    // small enough field can have EVERY entrant land on the bye side of
    // their pair, producing a round 1 with real entrants but ZERO real
    // matches (for a 16-draw this is any count from 1 to 8 entrants; the
    // first real match only appears at 9). Such a round is not just
    // useless, it's actively broken: Tournament.isRoundComplete() is
    // vacuously true for an empty matches array, so the tournament can
    // never progress to round 2 (nothing is ever "decided" to trigger
    // it), and DrizzleTournamentRepository's round reconstruction groups
    // rows FROM tournament_matches — a round with zero match rows loses
    // its round entirely on the next read, so even hasStarted alone
    // becomes an inconsistent, undebuggable state. Refusing to start
    // here, before any of that state ever exists, is the correct fix:
    // an under-filled draw should stay open (StartDueTournamentsUseCase
    // leaves it open and retries a later tick with more fillers) rather
    // than starting into a dead end.
    if (rounds[0].matches.length === 0) {
      throw new Error(
        `Cannot start tournament ${this.id}: ${this._entrants.length} entrant(s) is too sparse a field for a ` +
          `${this.drawSize}-draw to produce a single real round-1 match — every entrant would receive a bye ` +
          `with nobody to actually play`,
      );
    }
    this.rounds = [...rounds];
    this.domainEvents.push({
      type: 'TournamentStarted',
      occurredAt: new Date(),
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
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled entrants');
    }

    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m));
    this.rounds[roundIndex] = { ...round, matches: updatedMatches };

    this.domainEvents.push({
      type: 'MatchOutcomeRecorded',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, roundNumber, matchIndex, winner: outcome.winner },
    });

    if (updatedMatches.every((m) => m.outcome !== null)) {
      if (this.isFinalRound(roundNumber)) {
        this.domainEvents.push({
          type: 'TournamentCompleted',
          occurredAt: new Date(),
          payload: { tournamentId: this.id },
        });
      } else {
        this.domainEvents.push({
          type: 'TournamentRoundAdvanced',
          occurredAt: new Date(),
          payload: { tournamentId: this.id, roundNumber },
        });
      }
    }
  }

  /** Total rounds in a single-elimination draw of this tournament's
   * drawSize is log2(drawSize) (16 -> 4 rounds, 32 -> 5, ...), so the
   * round that just completed is the final one exactly when its
   * number equals that total — no separate "is this the last round I
   * happen to have on file" check is needed, which matters since
   * rounds are added incrementally via addRound(), not all upfront.
   * Public so use cases can decide whether to generate a next round
   * without duplicating this formula themselves. */
  isFinalRound(roundNumber: number): boolean {
    return roundNumber === Math.log2(this.drawSize);
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

  /** Counts the rounds this player has a recorded win in — the
   * "roundsWon" RankingPointsTable.pointsFor() expects. A bye never
   * produces a match record at all (see BracketGenerator), so a round
   * skipped via bye does not count here; only rounds actually won via
   * a decided match do. A player appears in at most one match per
   * round in a single-elimination bracket, so this is equivalent to
   * counting matches won. */
  roundsWonBy(playerId: PlayerId): number {
    return this.rounds.filter((round) => round.matches.some((match) => match.outcome?.winner === playerId)).length;
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
