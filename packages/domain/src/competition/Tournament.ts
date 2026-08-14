import { TournamentId, GameWeek, PlayerId, PairId } from '../shared/ids';
import { Surface } from '../player/PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import {
  AgeBand,
  BracketRound,
  DrawPhase,
  DrawSize,
  MatchOutcome,
  TournamentDoublesPair,
  TournamentEntrant,
  TournamentTier,
  drawOf,
  isJuniorTier,
} from './CompetitionTypes';
import { GameDay, addDays } from '../world/GameWorld';
import { TournamentSchedulePolicy } from './TournamentSchedulePolicy';

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
  /** Day-within-week (1..7) the tournament begins on, relative to
   * weekScheduled. Round r is then played on
   * roundDay(policy) days after this start day. Optional (defaults to
   * 1) for tournaments/tests created before the day clock existed. */
  startDay?: number;
  /** Real host country (see TournamentNameGenerator.GeneratedTournamentName)
   * — a structured field, not parsed from the display name. Drives the
   * home-advantage rule (P6): a player whose nationality matches this
   * gets a small sim bonus. Optional/nullable: tournaments created
   * before P6 (and the many test call sites) have none, in which case
   * NO player is ever "home" and the rule is simply inert. */
  hostCountry?: string | null;
  /** Size of the QUALIFYING field, and how many main-draw places its
   * survivors will claim (see QualifyingPolicy — the two are derived
   * from tier + drawSize at open time by the use case that opens the
   * tournament, then STORED here rather than re-derived on every read).
   *
   * Stored deliberately: these are PLACEHOLDER balance values, and
   * re-deriving them per read would let a mid-event tuning change
   * resize a draw that is already being played — a tournament that
   * opened with 16 reserved slots must still promote exactly 16
   * qualifiers a fortnight later. Both default to 0, which means "this
   * tournament holds no qualifying" and leaves every pre-qualifying
   * tournament, test call site and persisted row behaving exactly as
   * before. */
  qualifyingDrawSize?: number;
  qualifierSlots?: number;
  /** Size of the DOUBLES draw (P7b) — how many pairs the doubles
   * bracket holds. Derived once at open time by the use case that opens
   * the tournament, stored like qualifyingDrawSize so a later balance
   * change can't resize an event already in progress. 0 = this
   * tournament holds no doubles draw (the pre-P7b default). */
  doublesDrawSize?: number;
  /** Doubles qualifying (P8): the size of the doubles QUALIFYING field
   * and how many main-draw places its survivors claim — derived once at
   * open time from the doubles draw size (see DoublesPolicy), stored like
   * the singles qualifying sizes. Both 0 = no doubles qualifying. */
  doublesQualifyingDrawSize?: number;
  doublesQualifierSlots?: number;
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
  private qualifyingRounds: BracketRound[] = [];
  private doublesRounds: BracketRound<PairId>[] = [];
  private doublesQualifyingRounds: BracketRound<PairId>[] = [];
  private _doublesEntrants: PlayerId[] = [];
  private _doublesPairs: TournamentDoublesPair[] = [];
  private _doublesQualifyingPairs: TournamentDoublesPair[] = [];
  private domainEvents: DomainEvent[] = [];

  private constructor(
    readonly id: TournamentId,
    readonly name: string,
    readonly tier: TournamentTier,
    readonly surface: Surface,
    readonly weekScheduled: GameWeek,
    readonly drawSize: DrawSize,
    readonly ageBand: AgeBand | null,
    readonly startDay: number,
    readonly hostCountry: string | null,
    readonly qualifyingDrawSize: number,
    readonly qualifierSlots: number,
    readonly doublesDrawSize: number,
    readonly doublesQualifyingDrawSize: number,
    readonly doublesQualifierSlots: number,
  ) {}

  /** Both qualifying numbers are either 0 (no qualifying) or a
   * consistent pair: a power-of-two field, at least one reserved slot,
   * and at least 2 rounds' worth of players per slot. The last one is a
   * real structural requirement, not a balance preference — see
   * QualifyingPolicy.QUALIFYING_PLAYERS_PER_SLOT's doc comment (a
   * one-round qualifying event can produce winners who never played a
   * match, via byes, which qualifyingWinners() deliberately doesn't try
   * to reconstruct). */
  private static validateQualifying(qualifyingDrawSize: number, qualifierSlots: number, drawSize: DrawSize): void {
    if (qualifyingDrawSize === 0 && qualifierSlots === 0) return;
    if (qualifyingDrawSize <= 0 || qualifierSlots <= 0) {
      throw new Error(
        `A tournament either holds no qualifying (both 0) or a real one (both > 0), got ` +
          `qualifyingDrawSize=${qualifyingDrawSize}, qualifierSlots=${qualifierSlots}`,
      );
    }
    if (qualifierSlots >= drawSize) {
      throw new Error(`Reserved qualifier slots (${qualifierSlots}) must leave room in a ${drawSize}-draw`);
    }
    const perSlot = qualifyingDrawSize / qualifierSlots;
    if (!Number.isInteger(Math.log2(perSlot)) || perSlot < 4) {
      throw new Error(
        `A qualifying field of ${qualifyingDrawSize} for ${qualifierSlots} slot(s) is ${perSlot} players per ` +
          `slot — must be a power of two and at least 4 (i.e. at least two qualifying rounds)`,
      );
    }
  }

  /** A doubles draw (P7b), when present, must be a power-of-two size —
   * a doubles bracket is a single-elimination draw exactly like the
   * main one, just of pairs. 0 means no doubles draw. */
  private static validateDoublesDrawSize(doublesDrawSize: number): void {
    if (doublesDrawSize === 0) return;
    if (!Number.isInteger(Math.log2(doublesDrawSize)) || doublesDrawSize < 2) {
      throw new Error(`A doubles draw of ${doublesDrawSize} pairs must be a power of two and at least 2`);
    }
  }

  /** Doubles qualifying (P8): either both 0 (no doubles qualifying) or a
   * consistent pair — a power-of-two qualifying field, at least one
   * reserved slot, and reserved slots that leave room in the main draw. */
  private static validateDoublesQualifying(
    doublesQualifyingDrawSize: number,
    doublesQualifierSlots: number,
    doublesDrawSize: number,
  ): void {
    if (doublesQualifyingDrawSize === 0 && doublesQualifierSlots === 0) return;
    if (doublesQualifyingDrawSize <= 0 || doublesQualifierSlots <= 0) {
      throw new Error(
        `Doubles qualifying either holds none (both 0) or a real one (both > 0), got ` +
          `doublesQualifyingDrawSize=${doublesQualifyingDrawSize}, doublesQualifierSlots=${doublesQualifierSlots}`,
      );
    }
    if (doublesQualifierSlots >= doublesDrawSize) {
      throw new Error(`Reserved doubles qualifier slots (${doublesQualifierSlots}) must leave room in a ${doublesDrawSize}-pair draw`);
    }
  }

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

  private static validateStartDay(startDay: number): void {
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > 7) {
      throw new Error(`Tournament startDay must be an integer day-within-week 1..7, got ${startDay}`);
    }
  }

  static open(props: TournamentOpenProps): Tournament {
    const ageBand = props.ageBand ?? null;
    const startDay = props.startDay ?? 1;
    const qualifyingDrawSize = props.qualifyingDrawSize ?? 0;
    const qualifierSlots = props.qualifierSlots ?? 0;
    const doublesDrawSize = props.doublesDrawSize ?? 0;
    const doublesQualifyingDrawSize = props.doublesQualifyingDrawSize ?? 0;
    const doublesQualifierSlots = props.doublesQualifierSlots ?? 0;
    Tournament.validateAgeBand(props.tier, ageBand);
    Tournament.validateName(props.name);
    Tournament.validateStartDay(startDay);
    Tournament.validateQualifying(qualifyingDrawSize, qualifierSlots, props.drawSize);
    Tournament.validateDoublesDrawSize(doublesDrawSize);
    Tournament.validateDoublesQualifying(doublesQualifyingDrawSize, doublesQualifierSlots, doublesDrawSize);
    return new Tournament(props.id, props.name, props.tier, props.surface, props.weekScheduled, props.drawSize, ageBand, startDay, props.hostCountry ?? null, qualifyingDrawSize, qualifierSlots, doublesDrawSize, doublesQualifyingDrawSize, doublesQualifierSlots);
  }

  /** Rehydrates a persisted tournament (repository adapters only).
   * Unlike open()/registerEntrant()/startWithBracket(), this is not a
   * sequence of domain actions — it restores state as-is and emits NO
   * events (loading a started tournament back is not starting it). */
  static reconstitute(
    props: TournamentOpenProps & {
      entrants: TournamentEntrant[];
      rounds: BracketRound[];
      /** Optional: absent (every pre-qualifying persisted row and test
       * call site) means no qualifying bracket was ever played. */
      qualifyingRounds?: BracketRound[];
      /** Doubles draw state (P7b). Optional: absent (every pre-P7b row
       * and test call site) means no doubles draw. */
      doublesEntrants?: PlayerId[];
      doublesPairs?: TournamentDoublesPair[];
      doublesRounds?: BracketRound<PairId>[];
      /** Doubles qualifying state (P8). Optional: absent means no doubles
       * qualifying was ever played. */
      doublesQualifyingPairs?: TournamentDoublesPair[];
      doublesQualifyingRounds?: BracketRound<PairId>[];
    },
  ): Tournament {
    const ageBand = props.ageBand ?? null;
    const startDay = props.startDay ?? 1;
    const qualifyingDrawSize = props.qualifyingDrawSize ?? 0;
    const qualifierSlots = props.qualifierSlots ?? 0;
    const doublesDrawSize = props.doublesDrawSize ?? 0;
    const doublesQualifyingDrawSize = props.doublesQualifyingDrawSize ?? 0;
    const doublesQualifierSlots = props.doublesQualifierSlots ?? 0;
    Tournament.validateAgeBand(props.tier, ageBand);
    Tournament.validateName(props.name);
    Tournament.validateStartDay(startDay);
    Tournament.validateQualifying(qualifyingDrawSize, qualifierSlots, props.drawSize);
    Tournament.validateDoublesDrawSize(doublesDrawSize);
    Tournament.validateDoublesQualifying(doublesQualifyingDrawSize, doublesQualifierSlots, doublesDrawSize);
    const tournament = new Tournament(props.id, props.name, props.tier, props.surface, props.weekScheduled, props.drawSize, ageBand, startDay, props.hostCountry ?? null, qualifyingDrawSize, qualifierSlots, doublesDrawSize, doublesQualifyingDrawSize, doublesQualifierSlots);
    tournament._entrants = [...props.entrants];
    tournament.rounds = [...props.rounds];
    tournament.qualifyingRounds = [...(props.qualifyingRounds ?? [])];
    tournament._doublesEntrants = [...(props.doublesEntrants ?? [])];
    tournament._doublesPairs = [...(props.doublesPairs ?? [])];
    tournament.doublesRounds = [...(props.doublesRounds ?? [])];
    tournament._doublesQualifyingPairs = [...(props.doublesQualifyingPairs ?? [])];
    tournament.doublesQualifyingRounds = [...(props.doublesQualifyingRounds ?? [])];
    return tournament;
  }

  /** EVERY entrant, both draws. Unchanged for tournaments without
   * qualifying (where every entrant is a main-draw one); callers that
   * specifically mean one bracket's field must say so via
   * mainEntrants/qualifyingEntrants. */
  get entrants(): ReadonlyArray<TournamentEntrant> {
    return this._entrants;
  }

  get mainEntrants(): ReadonlyArray<TournamentEntrant> {
    return this._entrants.filter((entrant) => drawOf(entrant) === 'main');
  }

  get qualifyingEntrants(): ReadonlyArray<TournamentEntrant> {
    return this._entrants.filter((entrant) => drawOf(entrant) === 'qualifying');
  }

  /** Does this tournament hold a qualifying event at all? */
  get hasQualifying(): boolean {
    return this.qualifyingDrawSize > 0;
  }

  /** How many main-draw places may be taken by DIRECT registration —
   * the rest are reserved for whoever survives qualifying, and can only
   * be taken via promoteQualifier(). Equals drawSize when there is no
   * qualifying, so nothing changes for those tournaments. */
  get mainDrawCapacity(): number {
    return this.drawSize - this.qualifierSlots;
  }

  /** Total rounds the qualifying bracket plays before exactly
   * `qualifierSlots` players remain — NOT log2(qualifyingDrawSize): a
   * qualifying event deliberately stops several rounds short of a single
   * winner (see QualifyingPolicy). */
  get qualifyingRoundCount(): number {
    if (!this.hasQualifying) return 0;
    return Math.log2(this.qualifyingDrawSize / this.qualifierSlots);
  }

  /** The main bracket exists. This is what "the draw has been made"
   * means, and what every main-draw-specific caller must ask —
   * `hasStarted` is deliberately broader (see below). */
  get hasMainDraw(): boolean {
    return this.rounds.length > 0;
  }

  get hasQualifyingDrawStarted(): boolean {
    return this.qualifyingRounds.length > 0;
  }

  /** Does this tournament hold a doubles draw at all? */
  get hasDoubles(): boolean {
    return this.doublesDrawSize > 0;
  }

  get hasDoublesDrawStarted(): boolean {
    return this.doublesRounds.length > 0;
  }

  /** Does this tournament hold a doubles QUALIFYING event at all? */
  get hasDoublesQualifying(): boolean {
    return this.doublesQualifyingDrawSize > 0;
  }

  get hasDoublesQualifyingDrawStarted(): boolean {
    return this.doublesQualifyingRounds.length > 0;
  }

  /** Main-draw places that may be taken by DIRECT acceptance — the rest
   * are reserved for doubles qualifiers (and can only be filled via
   * promoteDoublesQualifier). Equals doublesDrawSize when there is no
   * doubles qualifying. */
  get doublesDirectAcceptanceCapacity(): number {
    return this.doublesDrawSize - this.doublesQualifierSlots;
  }

  /** Total rounds the doubles bracket plays — log2(doublesDrawSize),
   * 0 when there is no doubles draw. */
  get doublesRoundCount(): number {
    return this.hasDoubles ? Math.log2(this.doublesDrawSize) : 0;
  }

  /** Rounds the doubles qualifying bracket plays — 0 when there is no
   * doubles qualifying. */
  get doublesQualifyingRoundCount(): number {
    if (!this.hasDoublesQualifying) return 0;
    return Math.log2(this.doublesQualifyingDrawSize / this.doublesQualifierSlots);
  }

  get doublesEntrants(): ReadonlyArray<PlayerId> {
    return this._doublesEntrants;
  }

  get doublesPairs(): ReadonlyArray<TournamentDoublesPair> {
    return this._doublesPairs;
  }

  get doublesQualifyingPairs(): ReadonlyArray<TournamentDoublesPair> {
    return this._doublesQualifyingPairs;
  }

  /**
   * The tournament is UNDERWAY — any bracket has been seeded.
   *
   * Deliberately broadened when qualifying arrived, rather than left as
   * "the main bracket exists": every existing meaning of this flag is
   * "registration is closed and this event is in progress" (it gates
   * registerEntrant, `findOpenForRegistration` vs. `findStarted`, and
   * the denormalized `tournaments.has_started` column). A tournament
   * whose qualifying draw is being played is emphatically not still open
   * for registration, and its matches must be swept by the due-match
   * job, so it has to answer true here even though its main draw isn't
   * made yet (the deferred-main-draw model — docs/ranking-realism-proposal.md
   * §5). Callers that genuinely need "is the main bracket there" use
   * `hasMainDraw`.
   *
    * Doubles (P7b) is the third bracket: a tournament whose doubles draw
    * has been seeded is just as underway as one whose singles/qualifying
    * bracket exists, and its doubles matches must be swept the same way.
    * Doubles QUALIFYING (P8) is the fourth: its matches must be swept too.
    */
  get hasStarted(): boolean {
    return (
      this.hasMainDraw ||
      this.hasQualifyingDrawStarted ||
      this.hasDoublesDrawStarted ||
      this.hasDoublesQualifyingDrawStarted
    );
  }

  registerEntrant(entrant: TournamentEntrant): void {
    if (this.hasStarted) {
      throw new Error(`Cannot register an entrant: tournament ${this.id} has already started`);
    }
    if (this._entrants.some((e) => e.playerId === entrant.playerId)) {
      throw new Error(`Player ${entrant.playerId} is already registered for tournament ${this.id}`);
    }
    const draw = drawOf(entrant);
    if (draw === 'qualifying') {
      if (!this.hasQualifying) {
        throw new Error(`Tournament ${this.id} holds no qualifying event`);
      }
      if (this.qualifyingEntrants.length >= this.qualifyingDrawSize) {
        throw new Error(`Tournament ${this.id}'s qualifying field is full (${this.qualifyingDrawSize} entrants)`);
      }
    } else if (this.mainEntrants.length >= this.mainDrawCapacity) {
      throw new Error(
        `Tournament ${this.id}'s draw is full (${this.mainDrawCapacity} directly-accepted entrants` +
          `${this.hasQualifying ? `, plus ${this.qualifierSlots} places reserved for qualifiers` : ''})`,
      );
    }
    this._entrants.push(entrant);
  }

  /**
   * Moves a player who came THROUGH qualifying into the main draw,
   * taking one of the reserved slots. Deliberately a separate operation
   * from registerEntrant(): it is the only way those reserved places can
   * ever be filled (so a direct registrant can never take one), it is
   * legal AFTER the tournament has started (qualifying has by definition
   * been played by then, which registerEntrant rightly refuses), and it
   * preserves the entrant's `entryType: 'Q'` so the draw sheet keeps
   * showing how they got there.
   */
  promoteQualifier(playerId: PlayerId): void {
    if (this.hasMainDraw) {
      throw new Error(`Cannot promote a qualifier: tournament ${this.id}'s main draw is already seeded`);
    }
    const index = this._entrants.findIndex((entrant) => entrant.playerId === playerId);
    if (index === -1) {
      throw new Error(`Player ${playerId} is not an entrant of tournament ${this.id}`);
    }
    if (drawOf(this._entrants[index]) === 'main') {
      throw new Error(`Player ${playerId} is already in tournament ${this.id}'s main draw`);
    }
    if (this.mainEntrants.length >= this.drawSize) {
      throw new Error(`Tournament ${this.id}'s main draw is full (${this.drawSize} entrants)`);
    }
    this._entrants[index] = { ...this._entrants[index], draw: 'main', entryType: 'Q' };
  }

  /** Seeds the MAIN bracket. For a tournament with qualifying this is
   * deliberately allowed after the tournament has already "started" (its
   * qualifying draw), since the main draw is made only once qualifying
   * has produced its winners — the deferred-main-draw model. What can
   * never happen twice is the main bracket itself. */
  startWithBracket(rounds: BracketRound[]): void {
    if (this.hasMainDraw) {
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

  /** Seeds the QUALIFYING bracket — the first thing that happens at a
   * tournament that holds one, days before its main draw is made. Same
   * "a sparse field can produce a matchless round 1" guard as the main
   * draw, for the same reason (see startWithBracket). */
  startQualifyingWithBracket(rounds: BracketRound[]): void {
    if (!this.hasQualifying) {
      throw new Error(`Tournament ${this.id} holds no qualifying event`);
    }
    if (this.hasQualifyingDrawStarted) {
      throw new Error(`Tournament ${this.id}'s qualifying draw has already started`);
    }
    if (this.hasMainDraw) {
      throw new Error(`Cannot start qualifying for tournament ${this.id}: its main draw is already seeded`);
    }
    if (rounds.length === 0 || rounds[0].roundNumber !== 1) {
      throw new Error('The first qualifying round must be round number 1');
    }
    if (rounds[0].matches.length === 0) {
      throw new Error(
        `Cannot start qualifying for tournament ${this.id}: ${this.qualifyingEntrants.length} entrant(s) is too ` +
          `sparse a field for a ${this.qualifyingDrawSize}-player qualifying draw to produce a single real match`,
      );
    }
    this.qualifyingRounds = [...rounds];
    this.domainEvents.push({
      type: 'TournamentQualifyingStarted',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, entrantCount: this.qualifyingEntrants.length },
    });
  }

  getScheduledMatch(roundNumber: number, matchIndex: number, draw: DrawPhase = 'main'): { entrantA: PlayerId; entrantB: PlayerId } {
    const match = this.requireMatch(roundNumber, matchIndex, draw);
    if (match.outcome) {
      throw new Error(`Match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  /** Records the match's SCHEDULED reveal start and reveal window (a
   * wall-clock ISO timestamp + real-seconds, stamped by the application
   * layer at simulation time — the staggered-schedule feature). Mutates
   * the match in place so the repository round-trips them like the
   * outcome; `recordMatchOutcome`'s `{ ...m, outcome }` spread preserves
   * them. */
  setMatchSchedule(roundNumber: number, matchIndex: number, scheduledStartAt: string, revealSeconds: number, draw: DrawPhase = 'main'): void {
    const rounds = this.roundsFor(draw);
    const roundIndex = rounds.findIndex((round) => round.roundNumber === roundNumber);
    const round = rounds[roundIndex];
    this.requireMatch(roundNumber, matchIndex, draw);
    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, scheduledStartAt, revealSeconds } : m));
    rounds[roundIndex] = { ...round, matches: updatedMatches };
  }

  recordMatchOutcome(roundNumber: number, matchIndex: number, outcome: MatchOutcome, draw: DrawPhase = 'main'): void {
    const rounds = this.roundsFor(draw);
    const roundIndex = rounds.findIndex((round) => round.roundNumber === roundNumber);
    const round = rounds[roundIndex];
    const match = this.requireMatch(roundNumber, matchIndex, draw);
    if (match.outcome) {
      throw new Error(`Match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled entrants');
    }

    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m));
    rounds[roundIndex] = { ...round, matches: updatedMatches };

    this.domainEvents.push({
      type: 'MatchOutcomeRecorded',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, roundNumber, matchIndex, winner: outcome.winner, draw },
    });

    if (updatedMatches.every((m) => m.outcome !== null)) {
      if (this.isFinalRound(roundNumber, draw)) {
        // A completed qualifying draw is emphatically NOT a completed
        // tournament — its own event fires instead, and the main draw is
        // still to come (PromoteQualifiersUseCase reacts to this state).
        this.domainEvents.push({
          type: draw === 'qualifying' ? 'TournamentQualifyingCompleted' : 'TournamentCompleted',
          occurredAt: new Date(),
          payload: { tournamentId: this.id },
        });
      } else {
        this.domainEvents.push({
          type: 'TournamentRoundAdvanced',
          occurredAt: new Date(),
          payload: { tournamentId: this.id, roundNumber, draw },
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
  isFinalRound(roundNumber: number, draw: DrawPhase = 'main'): boolean {
    if (draw === 'qualifying') return roundNumber === this.qualifyingRoundCount;
    return roundNumber === Math.log2(this.drawSize);
  }

  /** The absolute GameDay on which `roundNumber` is played, given a
   * schedule policy. The tournament's first day is
   * { ...weekScheduled, day: startDay }; the policy maps each round to a
   * 1-based day offset within the run (round 1 -> day 1), so this is
   * `addDays(firstDay, policy.roundDay(...) - 1)`. Callers gate
   * "is this round due?" by comparing the result against the world's
   * current GameDay (see SimulateDueMatchesUseCase). Delegating the
   * round->day mapping to an injected policy keeps the pacing rule
   * swappable (OCP) rather than baked into the aggregate. */
  roundScheduledDay(roundNumber: number, policy: TournamentSchedulePolicy, draw: DrawPhase = 'main'): GameDay {
    const firstDay: GameDay = { ...this.weekScheduled, day: this.startDay };
    // Qualifying is played FIRST, one round per day, on the tournament's
    // opening days (day 1..qualifyingRoundCount) — exactly like a real
    // event's qualifying week. The MAIN draw's own schedule is then
    // shifted by that many days, so the policy's round->day mapping is
    // reused verbatim (no policy change, no negative days) and a
    // tournament without qualifying shifts by 0, i.e. is byte-for-byte
    // unchanged.
    if (draw === 'qualifying') {
      if (roundNumber < 1 || roundNumber > this.qualifyingRoundCount) {
        throw new Error(`Qualifying round ${roundNumber} out of range (1..${this.qualifyingRoundCount})`);
      }
      return addDays(firstDay, roundNumber - 1);
    }
    const offset = policy.roundDay(this.tier, this.drawSize, roundNumber);
    return addDays(firstDay, this.qualifyingRoundCount + offset - 1);
  }

  isRoundComplete(roundNumber: number, draw: DrawPhase = 'main'): boolean {
    const round = this.roundsFor(draw).find((r) => r.roundNumber === roundNumber);
    if (!round) return false;
    return round.matches.every((m) => m.outcome !== null);
  }

  /** The whole qualifying event has been played out — its last round
   * (qualifyingRoundCount, NOT a single winner) is complete, so exactly
   * the players who earned the reserved main-draw slots are known. */
  isQualifyingComplete(): boolean {
    if (!this.hasQualifying || !this.hasQualifyingDrawStarted) return false;
    return this.isRoundComplete(this.qualifyingRoundCount, 'qualifying');
  }

  /** The players who came THROUGH qualifying, in bracket order — read
   * straight off the final qualifying round's recorded outcomes. Safe
   * precisely because a qualifying event is always at least two rounds
   * (QualifyingPolicy enforces it, Tournament.validateQualifying
   * re-checks it), so no qualifier can ever have advanced on a round-1
   * bye without a match of their own. Empty until qualifying is
   * complete. */
  qualifyingWinners(): PlayerId[] {
    if (!this.isQualifyingComplete()) return [];
    const finalRound = this.qualifyingRounds.find((round) => round.roundNumber === this.qualifyingRoundCount);
    if (!finalRound) return [];
    return finalRound.matches.flatMap((match) => (match.outcome ? [match.outcome.winner] : []));
  }

  addRound(round: BracketRound, draw: DrawPhase = 'main'): void {
    const rounds = this.roundsFor(draw);
    const expectedRoundNumber = rounds.length + 1;
    if (round.roundNumber !== expectedRoundNumber) {
      throw new Error(`Expected round ${expectedRoundNumber}, got ${round.roundNumber}`);
    }
    if (draw === 'qualifying' && expectedRoundNumber > this.qualifyingRoundCount) {
      throw new Error(
        `Tournament ${this.id}'s qualifying draw is only ${this.qualifyingRoundCount} round(s) long — ` +
          `round ${expectedRoundNumber} would play its qualifiers out of the main draw they just earned`,
      );
    }
    if (!this.isRoundComplete(expectedRoundNumber - 1, draw)) {
      throw new Error(`Cannot add round ${expectedRoundNumber} before round ${expectedRoundNumber - 1} is complete`);
    }
    rounds.push(round);
  }

  getRounds(): ReadonlyArray<BracketRound> {
    return this.rounds;
  }

  getQualifyingRounds(): ReadonlyArray<BracketRound> {
    return this.qualifyingRounds;
  }

  /** Counts the rounds this player has a recorded win in — the
   * "roundsWon" RankingPointsTable.pointsFor() expects. A bye never
   * produces a match record at all (see BracketGenerator), so a round
   * skipped via bye does not count here; only rounds actually won via
   * a decided match do. A player appears in at most one match per
   * round in a single-elimination bracket, so this is equivalent to
   * counting matches won. */
  roundsWonBy(playerId: PlayerId, draw: DrawPhase = 'main'): number {
    return this.roundsFor(draw).filter((round) => round.matches.some((match) => match.outcome?.winner === playerId))
      .length;
  }

  // -------------------------------------------------------------------------
  // Doubles draw (P7b). Deliberately a SEPARATE method set keyed on `PairId`
  // rather than generalized into `roundsFor(draw)`: a doubles match has two
  // pairs per side, and the doubles draw has no qualifying and its own
  // formation (pairing + cutoff) upstream. It still reuses the SAME generic
  // `BracketRound<PairId>` / `BracketGenerator` shapes.
  // -------------------------------------------------------------------------

  /** Registers a solo player into the doubles field (P7b) — entry is
   * per-player, not per-pair; they are paired up at draw formation time
   * (see DoublesPairingService). Allowed only while the tournament is
   * open, exactly like singles `registerEntrant`. */
  registerDoublesEntrant(playerId: PlayerId): void {
    if (!this.hasDoubles) {
      throw new Error(`Tournament ${this.id} holds no doubles draw`);
    }
    if (this.hasStarted) {
      throw new Error(`Cannot register a doubles entrant: tournament ${this.id} has already started`);
    }
    if (this._doublesEntrants.includes(playerId)) {
      throw new Error(`Player ${playerId} is already in tournament ${this.id}'s doubles field`);
    }
    this._doublesEntrants.push(playerId);
  }

  /** Seeds the doubles bracket from the formed pairs — the shape the
   * formation use case produces after pairing entrants and applying the
   * combined-ranking cutoff (DoublesPairingService). Records both the
   * pairs (so each `PairId` maps back to its two players) and the seeded
   * bracket. */
  startDoublesWithBracket(pairs: TournamentDoublesPair[], rounds: BracketRound<PairId>[]): void {
    if (!this.hasDoubles) {
      throw new Error(`Tournament ${this.id} holds no doubles draw`);
    }
    if (this.hasDoublesDrawStarted) {
      throw new Error(`Tournament ${this.id}'s doubles draw has already started`);
    }
    if (rounds.length === 0 || rounds[0].roundNumber !== 1) {
      throw new Error('The first doubles round must be round number 1');
    }
    if (rounds[0].matches.length === 0) {
      throw new Error(`Cannot start doubles for tournament ${this.id}: no real pairs to seed a match`);
    }
    this._doublesPairs = [...pairs];
    this.doublesRounds = [...rounds];
    this.domainEvents.push({
      type: 'TournamentDoublesStarted',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, pairCount: pairs.length },
    });
  }

  getDoublesRounds(draw: DrawPhase = 'main'): ReadonlyArray<BracketRound<PairId>> {
    return this.doublesRoundsFor(draw);
  }

  /** The two players behind a doubles slot's `PairId` — what the sim
   * and any display need to resolve a pair back to its members. Searches
   * BOTH the main-draw pairs and the qualifying-field pairs. Null when
   * the pairId isn't in this tournament's doubles draw at all. */
  doublesPlayersFor(pairId: PairId): TournamentDoublesPair | null {
    return (
      this._doublesPairs.find((p) => p.pairId === pairId) ??
      this._doublesQualifyingPairs.find((p) => p.pairId === pairId) ??
      null
    );
  }

  /** Stores the direct-acceptance pairs WITHOUT seeding the main doubles
   * bracket — the deferred main-draw seeding half of doubles qualifying
   * (P8): the main draw can't be seeded until the qualifiers have been
   * promoted, so the direct pairs are parked here first and the main
   * bracket is seeded later by PromoteDoublesQualifiersUseCase. */
  recordDoublesDirectAcceptancePairs(pairs: TournamentDoublesPair[]): void {
    if (this.hasDoublesDrawStarted) {
      throw new Error(`Cannot record doubles direct acceptance: tournament ${this.id}'s doubles draw is already seeded`);
    }
    this._doublesPairs = [...pairs];
  }

  /** Seeds the doubles QUALIFYING bracket (P8) — the small bracket
   * played on the opening days, whose winners claim the reserved main-
   * draw places. Deferred main-draw seeding: the doubles main draw is
   * seeded by PromoteDoublesQualifiersUseCase once qualifying finishes. */
  startDoublesQualifyingWithBracket(pairs: TournamentDoublesPair[], rounds: BracketRound<PairId>[]): void {
    if (!this.hasDoublesQualifying) {
      throw new Error(`Tournament ${this.id} holds no doubles qualifying`);
    }
    if (this.hasDoublesQualifyingDrawStarted) {
      throw new Error(`Tournament ${this.id}'s doubles qualifying has already started`);
    }
    if (this.hasDoublesDrawStarted) {
      throw new Error(`Cannot start doubles qualifying for tournament ${this.id}: its main doubles draw is already seeded`);
    }
    if (rounds.length === 0 || rounds[0].roundNumber !== 1) {
      throw new Error('The first doubles qualifying round must be round number 1');
    }
    if (rounds[0].matches.length === 0) {
      throw new Error(`Cannot start doubles qualifying for tournament ${this.id}: no real pairs to seed a match`);
    }
    this._doublesQualifyingPairs = [...pairs];
    this.doublesQualifyingRounds = [...rounds];
    this.domainEvents.push({
      type: 'TournamentDoublesQualifyingStarted',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, pairCount: pairs.length },
    });
  }

  getDoublesScheduledMatch(roundNumber: number, matchIndex: number, draw: DrawPhase = 'main'): { entrantA: PairId; entrantB: PairId } {
    const match = this.requireDoublesMatch(roundNumber, matchIndex, draw);
    if (match.outcome) {
      throw new Error(`Doubles match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }
    return { entrantA: match.entrantA, entrantB: match.entrantB };
  }

  /** Doubles analogue of setMatchSchedule — records the match's
   * scheduled reveal start + reveal window on the aggregate for the
   * staggered-schedule feature. */
  setDoublesMatchSchedule(roundNumber: number, matchIndex: number, scheduledStartAt: string, revealSeconds: number, draw: DrawPhase = 'main'): void {
    const rounds = this.doublesRoundsFor(draw);
    const roundIndex = rounds.findIndex((round) => round.roundNumber === roundNumber);
    const round = rounds[roundIndex];
    this.requireDoublesMatch(roundNumber, matchIndex, draw);
    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, scheduledStartAt, revealSeconds } : m));
    rounds[roundIndex] = { ...round, matches: updatedMatches };
  }

  recordDoublesMatchOutcome(roundNumber: number, matchIndex: number, outcome: MatchOutcome<PairId>, draw: DrawPhase = 'main'): void {
    const rounds = this.doublesRoundsFor(draw);
    const roundIndex = rounds.findIndex((round) => round.roundNumber === roundNumber);
    const round = rounds[roundIndex];
    const match = this.requireDoublesMatch(roundNumber, matchIndex, draw);
    if (match.outcome) {
      throw new Error(`Doubles match ${roundNumber}/${matchIndex} already has a recorded outcome`);
    }
    if (outcome.winner !== match.entrantA && outcome.winner !== match.entrantB) {
      throw new Error('Winner must be one of the two scheduled pairs');
    }

    const updatedMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, outcome } : m));
    rounds[roundIndex] = { ...round, matches: updatedMatches };

    this.domainEvents.push({
      type: 'DoublesMatchOutcomeRecorded',
      occurredAt: new Date(),
      payload: { tournamentId: this.id, roundNumber, matchIndex, winner: outcome.winner, draw },
    });

    if (updatedMatches.every((m) => m.outcome !== null)) {
      if (this.isDoublesFinalRound(roundNumber, draw)) {
        this.domainEvents.push({
          type: draw === 'qualifying' ? 'TournamentDoublesQualifyingCompleted' : 'TournamentDoublesCompleted',
          occurredAt: new Date(),
          payload: { tournamentId: this.id },
        });
      } else {
        this.domainEvents.push({
          type: 'TournamentDoublesRoundAdvanced',
          occurredAt: new Date(),
          payload: { tournamentId: this.id, roundNumber, draw },
        });
      }
    }
  }

  isDoublesFinalRound(roundNumber: number, draw: DrawPhase = 'main'): boolean {
    return draw === 'qualifying'
      ? roundNumber === this.doublesQualifyingRoundCount
      : roundNumber === this.doublesRoundCount;
  }

  isDoublesRoundComplete(roundNumber: number, draw: DrawPhase = 'main'): boolean {
    const round = this.doublesRoundsFor(draw).find((r) => r.roundNumber === roundNumber);
    if (!round) return false;
    return round.matches.every((m) => m.outcome !== null);
  }

  /** The whole doubles main draw has been played out — its final round
   * is complete, so the doubles champion pair is known. */
  isDoublesComplete(): boolean {
    if (!this.hasDoubles || !this.hasDoublesDrawStarted) return false;
    return this.isDoublesRoundComplete(this.doublesRoundCount, 'main');
  }

  /** The champion pair of the doubles main draw, once complete. */
  doublesWinners(): PairId[] {
    if (!this.isDoublesComplete()) return [];
    const finalRound = this.doublesRoundsFor('main').find((round) => round.roundNumber === this.doublesRoundCount);
    if (!finalRound) return [];
    return finalRound.matches.flatMap((match) => (match.outcome ? [match.outcome.winner] : []));
  }

  /** The doubles qualifying event has been played out — its last round
   * is complete, so exactly the pairs who earned the reserved main-draw
   * places are known. */
  isDoublesQualifyingComplete(): boolean {
    if (!this.hasDoublesQualifying || !this.hasDoublesQualifyingDrawStarted) return false;
    return this.isDoublesRoundComplete(this.doublesQualifyingRoundCount, 'qualifying');
  }

  /** The pairs who came THROUGH doubles qualifying, in bracket order. */
  doublesQualifyingWinners(): PairId[] {
    if (!this.isDoublesQualifyingComplete()) return [];
    const finalRound = this.doublesRoundsFor('qualifying').find(
      (round) => round.roundNumber === this.doublesQualifyingRoundCount,
    );
    if (!finalRound) return [];
    return finalRound.matches.flatMap((match) => (match.outcome ? [match.outcome.winner] : []));
  }

  /** Moves a pair that came through doubles qualifying into the main
   * doubles draw's reserved slots (P8) — the only way those reserved
   * places can be filled. The pair's identity (chemistry +
   * persistentPairId) travels with it. */
  promoteDoublesQualifier(pairId: PairId): void {
    if (this.hasDoublesDrawStarted) {
      throw new Error(`Cannot promote a doubles qualifier: tournament ${this.id}'s doubles draw is already seeded`);
    }
    const index = this._doublesQualifyingPairs.findIndex((p) => p.pairId === pairId);
    if (index === -1) {
      throw new Error(`Pair ${pairId} is not in tournament ${this.id}'s doubles qualifying field`);
    }
    if (this._doublesPairs.length >= this.doublesDrawSize) {
      throw new Error(`Tournament ${this.id}'s doubles draw is full (${this.doublesDrawSize} pairs)`);
    }
    this._doublesPairs.push(this._doublesQualifyingPairs[index]);
  }

  addDoublesRound(round: BracketRound<PairId>, draw: DrawPhase = 'main'): void {
    const rounds = this.doublesRoundsFor(draw);
    const expectedRoundNumber = rounds.length + 1;
    if (round.roundNumber !== expectedRoundNumber) {
      throw new Error(`Expected doubles round ${expectedRoundNumber}, got ${round.roundNumber}`);
    }
    const roundCount = draw === 'qualifying' ? this.doublesQualifyingRoundCount : this.doublesRoundCount;
    if (expectedRoundNumber > roundCount) {
      throw new Error(`Tournament ${this.id}'s doubles ${draw} draw is only ${roundCount} round(s) long`);
    }
    if (!this.isDoublesRoundComplete(expectedRoundNumber - 1, draw)) {
      throw new Error(`Cannot add doubles round ${expectedRoundNumber} before round ${expectedRoundNumber - 1} is complete`);
    }
    rounds.push(round);
  }

  /** Rounds this pair has a recorded win in (per draw) — used to compute
   * doubles ranking / qualifying points. */
  doublesRoundsWonBy(pairId: PairId, draw: DrawPhase = 'main'): number {
    return this.doublesRoundsFor(draw).filter((round) => round.matches.some((match) => match.outcome?.winner === pairId))
      .length;
  }

  /** The absolute GameDay a doubles round is played on. Doubles
   * QUALIFYING plays on the opening days (day 1..roundCount), before
   * either main draw; the doubles main draw runs in parallel with the
   * singles main draw (round r on the main draw's round-r day, already
   * shifted past the singles qualifying days). */
  doublesRoundScheduledDay(roundNumber: number, policy: TournamentSchedulePolicy, draw: DrawPhase = 'main'): GameDay {
    if (draw === 'qualifying') {
      if (roundNumber < 1 || roundNumber > this.doublesQualifyingRoundCount) {
        throw new Error(`Doubles qualifying round ${roundNumber} out of range (1..${this.doublesQualifyingRoundCount})`);
      }
      return addDays({ ...this.weekScheduled, day: this.startDay }, roundNumber - 1);
    }
    return this.roundScheduledDay(roundNumber, policy, 'main');
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }

  /** The live array backing one of the two doubles brackets (main vs
   * qualifying). Same "one implementation, two near-copies avoided"
   * pattern as roundsFor. */
  private doublesRoundsFor(draw: DrawPhase): BracketRound<PairId>[] {
    return draw === 'qualifying' ? this.doublesQualifyingRounds : this.doublesRounds;
  }

  private requireDoublesMatch(roundNumber: number, matchIndex: number, draw: DrawPhase = 'main') {
    const round = this.doublesRoundsFor(draw).find((r) => r.roundNumber === roundNumber);
    if (!round) throw new Error(`Doubles ${draw} round ${roundNumber} has not been generated yet`);
    const match = round.matches[matchIndex];
    if (!match) throw new Error(`No doubles match at index ${matchIndex} in round ${roundNumber}`);
    return match;
  }

  /** The live array backing one of the two brackets. Private and
   * returned by reference on purpose — every mutator in this class works
   * through it, which is what keeps the main/qualifying logic ONE
   * implementation rather than two near-copies. Nothing outside the
   * aggregate ever gets it (getRounds/getQualifyingRounds hand out
   * ReadonlyArrays). Defaults to 'main' at every call site, so a
   * tournament without qualifying behaves exactly as before. */
  private roundsFor(draw: DrawPhase): BracketRound[] {
    return draw === 'qualifying' ? this.qualifyingRounds : this.rounds;
  }

  private requireMatch(roundNumber: number, matchIndex: number, draw: DrawPhase = 'main') {
    const round = this.roundsFor(draw).find((r) => r.roundNumber === roundNumber);
    if (!round) throw new Error(`Round ${roundNumber} has not been generated yet`);
    const match = round.matches[matchIndex];
    if (!match) throw new Error(`No match at index ${matchIndex} in round ${roundNumber}`);
    return match;
  }
}
