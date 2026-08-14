import {
  BracketGenerator,
  DrawPhase,
  isAgeEligibleForTournamentBand,
  PlayerId,
  RankingBand,
  Tournament,
  TournamentEntrant,
  weeksBetween,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { FormDoublesDrawUseCase } from './FormDoublesDrawUseCase';

export interface StartDueTournamentsCommand {
  worldId: WorldId;
}

export interface StartDueTournamentsResult {
  /** Tournaments actually started this run (bracket seeded). */
  started: number;
  /** Total unclaimed-player slots filled across every started
   * tournament — 0 whenever every started tournament was already full
   * of real registrants. */
  filled: number;
}

/** A single unclaimed-player fill candidate — always a real fillOnly
 * free-agent Player now (candidate/player unification, see
 * docs/CLAUDE.md): there is no separate "fresh candidate" source to
 * convert anymore, every prospect is already a Player. */
interface FillCandidate {
  playerId: PlayerId;
  ageInWeeks: number;
}

/**
 * The missing "this tournament's registration window is over, time to
 * start it" trigger (docs/tournament-fill-system.md item 5). Before
 * this use case existed, a tournament opened via OpenRegistrationUseCase
 * had exactly one path out of "open for registration": RegisterEntrantUseCase
 * starting it the instant the LAST slot fills. An under-registered
 * tournament had no way to ever start at all — a previously-disclosed,
 * genuine gap (CLAUDE.md: "open tournaments never expire if their draw
 * doesn't fill"), not a hypothetical one.
 *
 * Run from the same weekly worker tick as AdvanceWorldWeekUseCase/
 * RefreshTalentPoolUseCase/GenerateJuniorTournamentsUseCase, gated on
 * that tick's `advanced` result (apps/worker/src/jobs/handlers.ts) —
 * same idempotency reasoning as those siblings. Deliberately does NOT
 * touch OpenTournamentUseCase (admin-seeded fixed entrant lists — the
 * dev seed script's deliberately-partial demo tournament and
 * GenerateJuniorTournamentsUseCase's "must be earned into, never
 * auto-filled" juniorMasters both rely on getting EXACTLY the entrant
 * list they were given, not a topped-up one) or RegisterEntrantUseCase's
 * exactly-full trigger (fill can never engage there — by the time that
 * branch runs, there are no unfilled slots left to fill).
 *
 * For every open tournament whose `weekScheduled` has fully PASSED
 * (`weeksBetween(weekScheduled, currentWeek) > 0`, strictly greater —
 * same rolling-week arithmetic the talent pool's own expiry and the
 * ranking window already use) and which is short of `drawSize`.
 * Deliberately strict, not `>= 0`: `GenerateJuniorTournamentsUseCase`
 * opens every junior tournament with `weekScheduled: currentWeek` (this
 * exact tick's week), and this use case runs on that SAME tick, right
 * after junior generation (apps/worker/src/jobs/handlers.ts) — an
 * inclusive `>= 0` comparison would force-start a junior tournament the
 * very same tick it opens, before any manager ever had a chance to see
 * or register for it. Strict `> 0` guarantees at least one full tick's
 * worth of real open-registration window first.
 *
 * Fills the remaining slots from the unclaimed-player pool (fillOnly
 * free-agent Players), THEN generates the bracket — reusing
 * BracketGenerator exactly as any
 * other start path does (a still-short draw after filling gets byes,
 * same as OpenTournamentUseCase's own deliberately-partial demo case).
 * Real registrants are never touched or displaced — fill only ever
 * tops up remaining empty slots, never replaces or reorders existing
 * entrants (Tournament.registerEntrant only ever appends).
 *
 * **Selection is scoped by ranking BAND membership, not a competing
 * ranking approximation.** "Ranking appropriateness for this
 * tournament's tier/age-band" is read literally: `isAgeEligibleForTournamentBand`
 * (the exact same one-directional rule RegisterEntrantUseCase already
 * enforces on real registrations — play up allowed, play down or
 * senior-into-junior not) decides who's even eligible. Among the
 * eligible pool, this reuses the REAL `RankPositionQuery` for that band
 * to prefer anyone who happens to already have a qualifying ranked
 * result first (mirrors GenerateJuniorTournamentsUseCase's juniorMasters
 * invite order) — in practice this is close to always empty, since an
 * unclaimed player has by definition never played a ranked match, but
 * the query is still genuinely reused, not stubbed out, so this stays
 * correct if that ever changes. Everyone else eligible fills in next,
 * broken by id for a fully deterministic, testable order.
 * `PlayerAttributes.overallRating()` or any other "how good is this
 * player" number is never read for ordering — that would be exactly
 * the "separate ranking approximation" this design deliberately avoids.
 *
 * **Weekly-commitment exclusion**: a fill candidate already registered
 * in ANY other tournament scheduled the same `weekScheduled` (reusing
 * `TournamentRepository.findByPlayerAndWeek` — the same underlying
 * query RegisterEntrantUseCase's junior weekly-cap check already reads,
 * generalized here to every tier, not just junior) is skipped, so a
 * single filler is never double-booked into two tournaments the same
 * week. Tournaments are processed one at a time, saving each before
 * moving to the next, so this check correctly sees fills already made
 * earlier in the SAME run — including a fresh candidate that was just
 * converted into a fillOnly Player moments ago for a different
 * tournament this same tick.
 */
export class StartDueTournamentsUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly bracketGenerator: BracketGenerator,
    private readonly rankPositionByBand: Record<RankingBand, RankPositionQuery>,
    /** Doubles draw formation (P7b) — optional for test compatibility
     * (the pre-P7b unit tests construct this use case without one);
     * the composition root always passes it. */
    private readonly formDoublesDraw?: FormDoublesDrawUseCase,
  ) {}

  async execute(command: StartDueTournamentsCommand): Promise<StartDueTournamentsResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const currentWeek = world.currentWeek;

    const open = await this.tournaments.findOpenForRegistration();
    const due = open.filter((t) => weeksBetween(t.weekScheduled, currentWeek) > 0);

    let started = 0;
    let filled = 0;

    for (const tournament of due) {
      // At a tournament that holds qualifying, the QUALIFYING field is
      // filled from free agents too, alongside the human registrants
      // who chose to enter it — a half-empty qualifying draw would make
      // "earning your way in" trivial. Filled first, and separately from
      // the main draw's directly-accepted places, because the two fields
      // have separate capacities (mainDrawCapacity deliberately excludes
      // the places reserved for qualifiers).
      if (tournament.hasQualifying) {
        const qualifyingNeeded = tournament.qualifyingDrawSize - tournament.qualifyingEntrants.length;
        if (qualifyingNeeded > 0) {
          filled += await this.fillSlots(tournament, qualifyingNeeded, 'qualifying');
        }
      }
      const needed = tournament.mainDrawCapacity - tournament.mainEntrants.length;
      if (needed > 0) {
        filled += await this.fillSlots(tournament, needed);
      }
      // A tournament that stayed at zero SINGLES entrants has nothing to
      // seed for the singles/qualifying bracket — but may still have a
      // doubles field to form (P7b). Only skip entirely when there are
      // neither singles entrants nor doubles entrants.
      const hasDoublesEntrants = tournament.hasDoubles && tournament.doublesEntrants.length > 0;
      if (tournament.entrants.length === 0 && !hasDoublesEntrants) continue;

      if (tournament.entrants.length > 0) {
        // With qualifying, the QUALIFYING bracket is what gets seeded now
        // — it is played over the tournament's opening days, and only its
        // survivors go into the main draw, which PromoteQualifiersUseCase
        // seeds later (the deferred main-draw model,
        // docs/ranking-realism-proposal.md §5).
        if (tournament.hasQualifying) {
          const qualifyingBracket = this.bracketGenerator.generate(
            tournament.qualifyingEntrants,
            tournament.qualifyingDrawSize,
          );
          if (qualifyingBracket[0].matches.length === 0) {
            await this.formDoublesDraw?.form(tournament);
            continue;
          }
          tournament.startQualifyingWithBracket(qualifyingBracket);
          await this.tournaments.save(tournament);
          started += 1;
          await this.formDoublesDraw?.form(tournament);
          continue;
        }

        const bracket = this.bracketGenerator.generate(tournament.mainEntrants, tournament.drawSize);
        // BracketGenerator's standard seed-slot placement (1v16, 8v9,
        // 4v13, ...) spreads top seeds apart so they can't meet early —
        // which means a field that's short but non-empty can still have
        // EVERY entrant land on the bye side of its pair, producing round
        // 1 matches: []. Tournament.startWithBracket() refuses that (see
        // its own doc comment — such a round can never progress, and
        // loses its identity entirely on the next repository read). This
        // is an expected, ordinary outcome of filling from a limited
        // pool, not an error: leave the tournament open and let a later
        // tick — with more fillers generated/converted by then — try
        // again, exactly like the zero-entrants case above.
        if (bracket[0].matches.length === 0) {
          await this.formDoublesDraw?.form(tournament);
          continue;
        }
        tournament.startWithBracket(bracket);
        await this.tournaments.save(tournament);
        started += 1;
      }

      // The doubles draw (P7b) forms independently of the singles one.
      await this.formDoublesDraw?.form(tournament);
    }

    return { started, filled };
  }

  /** Registers up to `needed` eligible unclaimed players as entrants on
   * `tournament` (mutating it in place, same as RegisterEntrantUseCase
   * does), converting any selected 'fresh' candidate into a real
   * fillOnly Player along the way. Returns how many were actually
   * added — may be fewer than `needed` if the eligible pool runs out. */
  private async fillSlots(tournament: Tournament, needed: number, draw: DrawPhase = 'main'): Promise<number> {
    const band: RankingBand = tournament.ageBand ?? 'senior';

    const [fillOnlyPlayers, ranked] = await Promise.all([
      this.players.findAll().then((all) => all.filter((p) => p.fillOnly)),
      this.rankPositionByBand[band].sortedRankings(),
    ]);
    const rankOrder = new Map(ranked.map((r, index) => [r.playerId, index]));

    const eligible: FillCandidate[] = fillOnlyPlayers
      .filter((p) => isAgeEligibleForTournamentBand(p.ageInWeeks, tournament.ageBand))
      .map((p): FillCandidate => ({ playerId: p.id, ageInWeeks: p.ageInWeeks }));

    const available: FillCandidate[] = [];
    for (const candidate of eligible) {
      const committedElsewhere = await this.tournaments.findByPlayerAndWeek(candidate.playerId, tournament.weekScheduled);
      if (committedElsewhere.length === 0) available.push(candidate);
    }

    available.sort((a, b) => {
      const aRank = rankOrder.get(a.playerId);
      const bRank = rankOrder.get(b.playerId);
      // Really-ranked candidates first (in their real rank order) —
      // structurally near-impossible for an unclaimed player today
      // (see this class's doc comment), but genuinely honored, not
      // dead code.
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      // Fully deterministic tie-break — never a skill/rating proxy.
      return a.playerId.localeCompare(b.playerId);
    });

    const selected = available.slice(0, needed);
    for (const candidate of selected) {
      // A filler in the qualifying field IS a qualifier — it has to win
      // its way through exactly like a human registrant there, and the
      // draw sheet says so. Left absent (i.e. 'main'/'DA') for the main
      // draw, unchanged from before qualifying existed.
      const entrant: TournamentEntrant =
        draw === 'qualifying'
          ? { playerId: candidate.playerId, seed: null, draw, entryType: 'Q' }
          : { playerId: candidate.playerId, seed: null };
      tournament.registerEntrant(entrant);
    }
    // Persist the fill immediately — later tournaments processed this
    // same run rely on findByPlayerAndWeek seeing it (see this class's
    // doc comment on weekly-commitment exclusion).
    await this.tournaments.save(tournament);

    return selected.length;
  }
}
