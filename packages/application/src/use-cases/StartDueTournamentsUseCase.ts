import {
  BracketGenerator,
  DrawPhase,
  GameWeek,
  Player,
  PlayerId,
  RankingBand,
  Tournament,
  TournamentEntrant,
  weeksBetween,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankedPlayer, RankPositionQuery } from '../queries/RankPositionQuery';
import { FormDoublesDrawPreloaded, FormDoublesDrawUseCase } from './FormDoublesDrawUseCase';
import { applyWildCards, wildCardsApplicableTo } from './applyWildCards';
import { FillDrawSlotsPreloaded, fillDrawSlots } from './fillDrawSlots';

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
  /** Never-started draws expired this run because they sat past their
   * scheduled week without ever filling. Two cases qualify (see the
   * expiry pass doc comment): a genuinely EMPTY shell, and a
   * MANAGER-LESS but non-empty draw (only fillers/free agents — nobody
   * invested a decision in it). The first closes the "world slowly
   * accumulating permanently-stuck shells" gap (a 3-season soak peaked
   * at 34 and had to delete 305); the second releases the fillers of a
   * draw that will never seed so they become signable again. 0 whenever
   * none qualify. */
  expired: number;
  /** Never-started draws CANCELLED this run because they sat past the
   * cancellation grace window (CANCELLED_DRAW_GRACE_WEEKS) without ever
   * becoming seedable — the terminal state that replaced "kept open
   * forever" for a draw holding a manager's real registration (see
   * Tournament.cancel). Entries are KEPT; the draw never plays and its
   * players stop being locked out of the signing pool. 0 on ordinary
   * ticks. */
  cancelled: number;
}

/** How many weeks past its scheduled week a never-started tournament
 * is left open before it is expired, provided nobody with a manager is
 * entered in it. Deliberately small: a tournament that no manager ever
 * entered (or one only fillers placed themselves into) and whose week
 * is long gone is an abandoned shell, not a pending event. Two weeks
 * leaves room for the filler top-up (and the odd late rollover) without
 * letting shells pile up. Named and doc-commented, same "explicit
 * PLACEHOLDER threshold" discipline as every other pacing constant
 * here. */
export const ABANDONED_TOURNAMENT_EXPIRY_WEEKS = 2;

/** How many weeks past its scheduled week a never-started, STILL
 * UNSEDEABLE draw is left open before it is CANCELLED. Deliberately
 * longer than ABANDONED_TOURNAMENT_EXPIRY_WEEKS: the delete path only
 * ever fires for a draw nobody (manager-owned) entered, while this is
 * the last resort for one a manager DID register in — it gets several
 * extra rollovers to fill and seed before the world gives up on it, and
 * even then its entries are kept (marked cancelled), never deleted. On
 * a saturated week (one filler can pad only one tournament) this is the
 * difference between a manager's entry being stuck in limbo forever —
 * and its players locked out of the signing pool forever, since a
 * never-seeded draw never concludes — and the entry being honestly
 * closed out. PLACEHOLDER, same flagged-threshold discipline as every
 * other pacing constant here. */
export const CANCELLED_DRAW_GRACE_WEEKS = 4;

/** The single plain-language reason stamped on every cancelled draw —
 * surfaced verbatim by the tournament/roster/profile/digest UI (item
 * C3), so the copy has ONE definition rather than a per-surface string. */
export const CANCELLED_DRAW_REASON = 'The draw could not be filled in time';

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
 * For every open tournament whose `weekScheduled` has ARRIVED
 * (`weeksBetween(weekScheduled, currentWeek) >= 0`, inclusive — same
 * rolling-week arithmetic the talent pool's own expiry and the ranking
 * window already use) and which is short of `drawSize`. Inclusive now,
 * where it used to be strict `> 0`: tournament generation opens
 * tournaments for NEXT week (see GenerateJuniorTournamentsUseCase/
 * GenerateSeniorTournamentsUseCase), so the tournaments labeled W are
 * seeded at the rollover INTO W and play during their OWN labeled week,
 * not a week late. The old strict `> 0` was only needed back when
 * generation opened the same week it ran — an inclusive check then
 * would have force-started a tournament the same tick it opened, before
 * any manager could register; with next-week generation the newly-opened
 * tournaments are `weeksBetween === -1`, so the inclusive check no
 * longer touches them.
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
 *
 * **Wild cards** (see WildCardPolicy/applyWildCards) are applied to
 * each due tournament's REAL registered qualifying entrants BEFORE the
 * filler-padding above and before either bracket is seeded — a filler
 * has no manager and never qualifies as a wild card candidate, and a
 * wild card must be granted before the qualifying draw exists to
 * bypass. Idempotent across repeated weekly runs on the same
 * still-open tournament: once granted, a player is no longer in
 * `qualifyingEntrants`, so a later run never reconsiders them.
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
    /** The DOUBLES rank queries, one per band. Used ONLY to resolve the
     * precomputed doubles ranking lists once per run (see the run-wide
     * preload in execute()) — without it, each doubles draw's formation
     * falls back to loading both rankings itself. Optional for test
     * compatibility; the composition root always passes it. */
    private readonly doublesRankByBand?: Record<RankingBand, RankPositionQuery>,
  ) {}

  async execute(command: StartDueTournamentsCommand): Promise<StartDueTournamentsResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const currentWeek = world.currentWeek;

    const open = await this.tournaments.findOpenForRegistration();

    // Expiry pass FIRST, before anything can fill/start a shell. A
    // never-started tournament whose scheduled week is more than
    // ABANDONED_TOURNAMENT_EXPIRY_WEEKS in the past is abandoned when
    // NO MANAGER-OWNED player is entered in it. Two shapes qualify:
    //
    //   1. A genuinely EMPTY shell (`entrants.length === 0 &&
    //      doublesEntrants.length === 0`) — nobody ever chose it.
    //   2. A MANAGER-LESS but non-empty draw — every entrant is a
    //      filler/free agent (managerId null). This is the case a
    //      partially-filled draw falls into when bye placement leaves an
    //      EMPTY round 1 (the `bracket[0].matches.length === 0` branch
    //      below deliberately leaves it open for a later tick), the week
    //      passes, and the draw can therefore never seed. Its fillers
    //      would otherwise be locked out of the signing pool forever by
    //      the "unfinished commitment" rule, since their main draw never
    //      exists. Deleting it releases them.
    //
    // A never-started draw that has even ONE manager-owned entrant is
    // NEVER expired (deleted) here, no matter how far past its week it
    // is: a manager invested a real decision in it and may still be
    // waiting on its bracket. Those keep getting the normal start/fill
    // path — and, once past CANCELLED_DRAW_GRACE_WEEKS without ever
    // becoming seedable, are CANCELLED by the pass at the end of this
    // method instead (entries kept; players released from the
    // unfinished-commitment lock). A started tournament never appears in
    // `open` at all. Idempotent: a deleted draw simply never appears
    // again, and cancel() itself is idempotent.
    // `deleteAbandonedTournament` is optional on the port (in-memory
    // fakes omit it); when absent the pass is inert.
    const expiredIds = new Set<string>();
    if (this.tournaments.deleteAbandonedTournament) {
      for (const tournament of open) {
        if (weeksBetween(tournament.weekScheduled, currentWeek) <= ABANDONED_TOURNAMENT_EXPIRY_WEEKS) {
          continue;
        }
        const isEmpty = tournament.entrants.length === 0 && tournament.doublesEntrants.length === 0;
        if (!isEmpty && (await this.hasManagerOwnedEntrant(tournament))) continue;
        if (await this.tournaments.deleteAbandonedTournament(tournament.id)) {
          expiredIds.add(tournament.id);
        }
      }
    }

    // A tournament is due when its scheduled week has ARRIVED (inclusive
    // `>= 0`): generation now opens tournaments for NEXT week (see
    // GenerateJuniorTournamentsUseCase/GenerateSeniorTournamentsUseCase),
    // so at the rollover INTO week W the tournaments labeled W have
    // `weeksBetween === 0` and are seeded here, then play during week W —
    // their own labeled week. The old strict `> 0` forced the tournament
    // to wait until its week had fully PASSED, so it played a week LATE;
    // that was only necessary back when generation opened the SAME week
    // (an inclusive check would then have force-started a tournament the
    // same tick it opened, before any registration). */
    const due = open.filter(
      (t) => !expiredIds.has(t.id) && weeksBetween(t.weekScheduled, currentWeek) >= 0,
    );

    let started = 0;
    let filled = 0;

    // -----------------------------------------------------------------
    // Run-wide preloads (performance pass — see AGENTS.md). Everything
    // below used to be re-read per fill / per doubles draw / per
    // wild-card candidate: every `fillSlots()` did a fresh
    // `players.findAll()`, every `form()` re-loaded both band rankings
    // and the free-agent pool, and every wild-card candidate re-ran the
    // whole cross-player senior ranking query. With dozens of due
    // tournaments that is hundreds of full reads per rollover. Loading
    // them ONCE here and threading them down keeps the exact same
    // content AND ordering (see FillDrawSlotsPreloaded/
    // FormDoublesDrawPreloaded's doc comments).
    //
    // SAFE ONLY BECAUSE NOTHING IN THIS METHOD WRITES THE LEDGER OR
    // PLAYER ROWS: the only writes below are tournament saves (plus the
    // expiry deletes above), so a list read once at the start of the run
    // is byte-identical to what each fill would have read moments later.
    // The one thing that DOES change within the run — who is entered in
    // a tournament this week — is handled by mutating the week's entered
    // set as fills land (see fillDrawSlots), exactly mirroring the old
    // per-candidate DB read seeing earlier fills in the same run.
    // -----------------------------------------------------------------
    const fillOnlyPool = (await this.players.findAll()).filter((p) => p.fillOnly && !p.isRetired());
    const freeAgents = this.formDoublesDraw ? await this.players.findFreeAgents() : undefined;

    // Still-alive-in-any-draw set (see the port's doc comment): one read
    // per run, so a filler alive in an earlier week's 14-day major (or a
    // late-running draw) can never be double-booked into a later week's
    // draw. Absent when the repository doesn't implement it (an
    // in-memory fake) — the old same-week-only exclusion applies. The
    // fill helper mutates this set as it fills, so a later draw in the
    // SAME run can't reuse a filler either. SAFE for the same reason the
    // other preloads are: nothing in this method changes any player's
    // commitments except the fills themselves, which the helper records.
    const unfinishedCommitmentPlayerIds = this.tournaments.findUnfinishedCommitmentPlayerIds
      ? new Set(await this.tournaments.findUnfinishedCommitmentPlayerIds())
      : undefined;

    // One `sortedRankings()` per band per RUN, resolved lazily on first
    // use. The ledger is never written below, so the cached list is what
    // every later call would have re-computed.
    const singlesRankedByBand = new Map<RankingBand, Promise<RankedPlayer[]>>();
    const singlesRankedFor = (band: RankingBand): Promise<RankedPlayer[]> => {
      const cached = singlesRankedByBand.get(band);
      if (cached) return cached;
      const pending = this.rankPositionByBand[band].sortedRankings();
      singlesRankedByBand.set(band, pending);
      return pending;
    };
    const doublesRankedByBand = new Map<RankingBand, Promise<RankedPlayer[]>>();
    const doublesRankedFor = (band: RankingBand): Promise<RankedPlayer[]> => {
      const cached = doublesRankedByBand.get(band);
      if (cached) return cached;
      if (!this.doublesRankByBand) return Promise.resolve([]);
      const pending = this.doublesRankByBand[band].sortedRankings();
      doublesRankedByBand.set(band, pending);
      return pending;
    };

    // The week's "already entered somewhere" set, loaded once per
    // DISTINCT scheduled week among the due tournaments (due can span
    // more than one week when an old draw was left open). Absent when
    // the repository doesn't implement the set read — the fill helpers
    // then keep today's per-candidate findByPlayerAndWeek check.
    const weekKey = (week: GameWeek): string => `${week.season}:${week.week}`;
    const enteredByWeek = new Map<string, Set<PlayerId>>();
    if (this.tournaments.findEnteredPlayerIdsForWeek) {
      for (const tournament of due) {
        const key = weekKey(tournament.weekScheduled);
        if (enteredByWeek.has(key)) continue;
        enteredByWeek.set(key, new Set(await this.tournaments.findEnteredPlayerIdsForWeek(tournament.weekScheduled)));
      }
    }

    for (const tournament of due) {
      const band: RankingBand = tournament.ageBand ?? 'senior';
      const enteredPlayerIdsForWeek = enteredByWeek.get(weekKey(tournament.weekScheduled));
      const fillPreloaded: FillDrawSlotsPreloaded = {
        fillOnlyPool,
        ranked: await singlesRankedFor(band),
        enteredPlayerIdsForWeek,
        unfinishedCommitmentPlayerIds,
      };
      const doublesPreloaded: FormDoublesDrawPreloaded = {
        singlesRanked: await singlesRankedFor(band),
        doublesRanked: this.doublesRankByBand ? await doublesRankedFor(band) : undefined,
        freeAgents,
        enteredPlayerIdsForWeek,
      };

      // The automatic wild card algorithm (see WildCardPolicy/
      // applyWildCards) runs FIRST, before the qualifying field is
      // padded with fillers below — it must only ever consider REAL,
      // manager-registered qualifying entrants (a filler has no
      // manager and shouldn't get a "break"), and it must run before
      // the qualifying bracket is ever seeded, same requirement
      // RegisterEntrantUseCase's own auto-start path has. The senior
      // ranking list is resolved only for a tournament that can
      // actually award one (tier has slots + a host country recorded).
      await applyWildCards(
        tournament,
        this.players,
        this.rankPositionByBand.senior,
        wildCardsApplicableTo(tournament) ? await singlesRankedFor('senior') : undefined,
      );

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
          filled += await this.fillSlots(tournament, qualifyingNeeded, 'qualifying', fillPreloaded);
        }
      }
      // The main draw's fill target. Wild cards actually AWARDED (by
      // applyWildCards above) already occupy their reserved places and
      // are counted in `mainEntrants`; the places the algorithm did NOT
      // award (its reserved slot count minus what it handed out) are
      // fillable from the pool exactly like a direct-acceptance place.
      // So the direct+filler capacity is
      //   drawSize − qualifierSlots − wildCardsTaken,
      // NOT the static mainDrawCapacity (which subtracts ALL reserved
      // wild-card slots). Without this, an event whose host country
      // matched no qualifying registrant started `wildCardSlots` short
      // even when the filler pool was abundant — a structural shortfall,
      // unlike the accepted supply-driven one (see AGENTS.md).
      const wildCardsTaken = tournament.wildCardSlotsTaken;
      const mainDrawFillTarget = tournament.drawSize - tournament.qualifierSlots - wildCardsTaken;
      const directlyFilled = tournament.mainEntrants.length - wildCardsTaken;
      const needed = mainDrawFillTarget - directlyFilled;
      if (needed > 0) {
        filled += await this.fillSlots(tournament, needed, 'main', fillPreloaded);
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
            await this.formDoublesDraw?.form(tournament, doublesPreloaded);
            continue;
          }
          tournament.startQualifyingWithBracket(qualifyingBracket);
          await this.tournaments.save(tournament);
          started += 1;
          await this.formDoublesDraw?.form(tournament, doublesPreloaded);
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
          await this.formDoublesDraw?.form(tournament, doublesPreloaded);
          continue;
        }
        tournament.startWithBracket(bracket);
        await this.tournaments.save(tournament);
        started += 1;
      }

      // The doubles draw (P7b) forms independently of the singles one.
      await this.formDoublesDraw?.form(tournament, doublesPreloaded);
    }

    // -----------------------------------------------------------------
    // Cancellation pass (P1-C1). LAST, deliberately: every due draw has
    // just had its fill/start attempt above, so a never-started draw that
    // is STILL unseeded past CANCELLED_DRAW_GRACE_WEEKS genuinely cannot
    // be made to play this tick. Before this existed, a draw holding one
    // manager-owned entrant was kept open forever (the delete pass
    // rightly refuses to delete it), and once the "no signing while
    // committed" rule landed, every player inside such a draw was locked
    // out of the Scouting pool FOREVER — the 52-week agent season measured
    // exactly that: 21 never-started tournaments (18 with manager
    // entries, 30 entries trapped) and 549/549 free agents unsignable for
    // 49 straight weeks. CANCELLING instead is terminal and honest: the
    // draw never plays, every entry is KEPT (the manager's decision and
    // the player's history remain), and Tournament.cancel's SQL twin
    // (`unfinishedCommitment.ts`'s `t.cancelled_at IS NULL`) releases the
    // entrants to the signing pool on the very next read.
    // Idempotent: a tournament already cancelled is never due (it is
    // excluded by findOpenForRegistration), and cancel() itself is a
    // no-op on a second call.
    // -----------------------------------------------------------------
    let cancelled = 0;
    for (const tournament of due) {
      if (tournament.hasStarted || tournament.isCancelled) continue;
      if (weeksBetween(tournament.weekScheduled, currentWeek) <= CANCELLED_DRAW_GRACE_WEEKS) continue;
      tournament.cancel(CANCELLED_DRAW_REASON);
      await this.tournaments.save(tournament);
      cancelled += 1;
    }

    return { started, filled, expired: expiredIds.size, cancelled };
  }

  /** Registers up to `needed` eligible unclaimed players as entrants on
   * `tournament` (mutating it in place, same as RegisterEntrantUseCase
   * does). Thin delegation to the shared fillDrawSlots helper — the
   * exact same selection this class used before, now reused by
   * PromoteQualifiersUseCase too (see that file). `preloaded` carries the
   * run-wide pool/rankings/commitment set (see execute()). Returns how
   * many were actually added — may be fewer than `needed` if the
   * eligible pool runs out. */
  private async fillSlots(
    tournament: Tournament,
    needed: number,
    draw: DrawPhase = 'main',
    preloaded: FillDrawSlotsPreloaded = {},
  ): Promise<number> {
    const band: RankingBand = tournament.ageBand ?? 'senior';
    return fillDrawSlots(
      { players: this.players, tournaments: this.tournaments, rankQuery: this.rankPositionByBand[band] },
      tournament,
      needed,
      draw,
      draw === 'qualifying'
        ? (entrant) => tournament.registerEntrant(entrant)
        : (entrant) => this.addMainDrawEntrant(tournament, entrant),
      preloaded,
    );
  }

  /**
   * True when a never-started draw should be KEPT because it may hold a
   * manager-owned entrant. Used ONLY by the expiry pass. An entrant counts
   * as manager-owned when its `Player` is owned by a manager OR when no
   * `Player` row can be found for it — a missing player is treated
   * CONSERVATIVELY as manager-owned, since a real registration is never
   * manager-less and the delete should only ever fire when every entrant
   * is POSITIVELY identifiable as a filler/free agent (managerId null).
   * Only positively-manager-less draws are releasable. This exactly
   * matches the production adapter's own transaction-scoped guard, where
   * every entrant has a player row.
   */
  private async hasManagerOwnedEntrant(tournament: Tournament): Promise<boolean> {
    const entrantIds = [
      ...tournament.entrants.map((e) => e.playerId),
      ...tournament.doublesEntrants,
    ];
    for (const playerId of entrantIds) {
      const player = await this.players.findById(playerId);
      if (!player || player.managerId != null) return true;
    }
    return false;
  }

  /**
   * Adds a filler to the MAIN draw. A DIRECT-acceptance place goes in
   * through `registerEntrant` — the aggregate enforces that capacity, and
   * a filler must never take a place reserved for a qualifier. Once the
   * direct places are gone, the remainder of the fill target can only be
   * un-awarded WILDCARD places, which `addMainDrawFiller` fills (legal
   * before the main bracket is seeded, which is exactly where this runs).
   * Keeping the two paths explicit is what preserves the aggregate's
   * capacity invariant while still letting an un-awarded reserved place
   * be filled.
   */
  private addMainDrawEntrant(tournament: Tournament, entrant: TournamentEntrant): void {
    if (tournament.mainEntrants.length < tournament.mainDrawCapacity) {
      tournament.registerEntrant(entrant);
      return;
    }
    tournament.addMainDrawFiller(entrant.playerId);
  }
}
