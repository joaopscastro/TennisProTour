import {
  AgingPolicy,
  BracketGenerator,
  isAgeEligibleForTournamentBand,
  PlayerId,
  RankingBand,
  StandardAgingPolicy,
  TalentPoolCandidate,
  Tournament,
  TournamentEntrant,
  weeksBetween,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, TalentPoolCandidateRepository, TournamentRepository } from '../ports/ports';
import { convertToFillOnlyPlayer } from './fillOnlyConversion';
import { RankPositionQuery } from '../queries/RankPositionQuery';

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

/** A single unclaimed-player fill candidate, whichever pool it came
 * from — kept uniform so selection/ordering logic doesn't need to know
 * which repository it originated from until the moment it's actually
 * chosen. */
interface FillCandidate {
  playerId: PlayerId;
  ageInWeeks: number;
  /** 'fresh' candidates aren't Players yet and must be converted
   * (`convertToFillOnlyPlayer`) the moment they're actually selected —
   * not for every candidate merely considered, since most considered
   * candidates never get picked. */
  source: { kind: 'fillOnly' } | { kind: 'fresh'; candidate: TalentPoolCandidate };
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
 * Fills the remaining slots from the unclaimed-player pool (both
 * still-actively-claimable "fresh" TalentPoolCandidate rows AND
 * long-term fillOnly Players), THEN generates the bracket — reusing
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
 * fillOnly players before fresh candidates (a fresh candidate is still
 * sitting in front of real managers in the Scouting list; consuming an
 * existing fillOnly player first minimizes collateral impact on that
 * economy), broken by id for a fully deterministic, testable order.
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
    private readonly talentPoolCandidates: TalentPoolCandidateRepository,
    private readonly bracketGenerator: BracketGenerator,
    private readonly rankPositionByBand: Record<RankingBand, RankPositionQuery>,
    private readonly agingPolicy: AgingPolicy = new StandardAgingPolicy(),
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
      const needed = tournament.drawSize - tournament.entrants.length;
      if (needed > 0) {
        filled += await this.fillSlots(tournament, needed);
      }
      // A tournament that stayed at zero entrants (no real
      // registrants AND no eligible/available filler) has nothing to
      // start — leave it open for a later tick, once more fillers
      // exist, rather than seeding a degenerate zero-match bracket.
      if (tournament.entrants.length === 0) continue;

      const bracket = this.bracketGenerator.generate(tournament.entrants, tournament.drawSize);
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
      if (bracket[0].matches.length === 0) continue;
      tournament.startWithBracket(bracket);
      await this.tournaments.save(tournament);
      started += 1;
    }

    return { started, filled };
  }

  /** Registers up to `needed` eligible unclaimed players as entrants on
   * `tournament` (mutating it in place, same as RegisterEntrantUseCase
   * does), converting any selected 'fresh' candidate into a real
   * fillOnly Player along the way. Returns how many were actually
   * added — may be fewer than `needed` if the eligible pool runs out. */
  private async fillSlots(tournament: Tournament, needed: number): Promise<number> {
    const band: RankingBand = tournament.ageBand ?? 'senior';

    const [fillOnlyPlayers, freshCandidates, ranked] = await Promise.all([
      this.players.findAll().then((all) => all.filter((p) => p.fillOnly)),
      this.talentPoolCandidates.findAvailable(),
      this.rankPositionByBand[band].sortedRankings(),
    ]);
    const rankOrder = new Map(ranked.map((r, index) => [r.playerId, index]));

    const eligible: FillCandidate[] = [
      ...fillOnlyPlayers
        .filter((p) => isAgeEligibleForTournamentBand(p.ageInWeeks, tournament.ageBand))
        .map((p): FillCandidate => ({ playerId: p.id, ageInWeeks: p.ageInWeeks, source: { kind: 'fillOnly' } })),
      ...freshCandidates
        .filter((c) => isAgeEligibleForTournamentBand(c.ageInWeeks, tournament.ageBand))
        .map((c): FillCandidate => ({ playerId: PlayerId(c.id), ageInWeeks: c.ageInWeeks, source: { kind: 'fresh', candidate: c } })),
    ];

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
      // Then existing fillOnly players before fresh candidates still
      // sitting in front of real managers in Scouting.
      if (a.source.kind !== b.source.kind) return a.source.kind === 'fillOnly' ? -1 : 1;
      // Fully deterministic tie-break — never a skill/rating proxy.
      return a.playerId.localeCompare(b.playerId);
    });

    const selected = available.slice(0, needed);
    for (const candidate of selected) {
      if (candidate.source.kind === 'fresh') {
        // Same narrow, pre-existing read-then-write race
        // RefreshTalentPoolUseCase's own expiry sweep already carries
        // (see its doc comment): a real manager successfully claiming
        // this exact candidate in the window between the read at the
        // top of fillSlots() and this save() would get silently
        // overwritten back to 'expired'. Disclosed there and here
        // rather than fixed as a side effect of unrelated work — see
        // docs/tournament-fill-system.md's "Known gap" section.
        const fresh = candidate.source.candidate;
        fresh.markExpired();
        await this.talentPoolCandidates.save(fresh);
        const fillOnlyPlayer = convertToFillOnlyPlayer(fresh, this.agingPolicy);
        await this.players.save(fillOnlyPlayer);
      }
      const entrant: TournamentEntrant = { playerId: candidate.playerId, seed: null };
      tournament.registerEntrant(entrant);
    }
    // Persist the fill immediately — later tournaments processed this
    // same run rely on findByPlayerAndWeek seeing it (see this class's
    // doc comment on weekly-commitment exclusion).
    await this.tournaments.save(tournament);

    return selected.length;
  }
}
