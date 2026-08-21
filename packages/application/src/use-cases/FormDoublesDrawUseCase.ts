import { BracketGenerator, DoublesPairingService, RandomSource, Tournament, RankingBand, PairId, doublesEntryRanking, isAgeEligibleForTournamentBand } from '@tennis-manager/domain';
import { PlayerId } from '@tennis-manager/domain';
import { DoublesPairRepository, PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';

/**
 * Forms a tournament's doubles draw (P7b) from its solo entrants — the
 * step that turns "who signed up" into "who plays, and with whom":
 * persistent partnerships are kept together, everyone else is randomly
 * paired (free-agent fillers cover an odd leftover), each pair's
 * combined ranking (sum of the two players' DOUBLES-else-SINGLES entry
 * rankings) decides who makes the `doublesDrawSize` cut, and the
 * survivors are seeded into the doubles bracket.
 *
 * Deliberately a separate use case (called from the two tournament-start
 * paths — StartDueTournamentsUseCase's weekly trigger and
 * RegisterEntrantUseCase's full-draw auto-start) rather than a branch
 * inside either, for the same "distinct state transition" reason
 * PromoteQualifiersUseCase is separate from the match sweep. It mutates
 * the already-loaded `Tournament` in place and saves it, so the caller
 * controls the surrounding transaction/order.
 *
 * Idempotent by construction: it no-ops for a tournament with no
 * doubles draw, one whose doubles draw has already started, or one with
 * no entrants.
 */
export class FormDoublesDrawUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly pairs: DoublesPairRepository,
    /** The SINGLES rank queries, one per band — the fallback half of
     * `doublesEntryRanking` (a player with no doubles ranking yet in the
     * tournament's own band uses their singles ranking there). */
    private readonly singlesRankByBand: Record<RankingBand, RankPositionQuery>,
    /** The DOUBLES rank queries, one per band (best-14 senior, best-6
     * junior) — the primary half. */
    private readonly doublesRankByBand: Record<RankingBand, RankPositionQuery>,
    private readonly pairingService: DoublesPairingService,
    private readonly bracketGenerator: BracketGenerator,
    private readonly random: RandomSource,
  ) {}

  async form(tournament: Tournament): Promise<void> {
    if (!tournament.hasDoubles || tournament.hasDoublesDrawStarted) return;
    let entrants = [...tournament.doublesEntrants];
    if (entrants.length === 0) return;

    // Junior doubles (P8): the combined ranking is computed in the
    // tournament's OWN band — a u14 doubles draw ranks entrants by their
    // u14 doubles (else u14 singles), never the senior tour's.
    const band: RankingBand = tournament.ageBand ?? 'senior';

    const [doublesRanked, singlesRanked, freeAgents] = await Promise.all([
      this.doublesRankByBand[band].sortedRankings(),
      this.singlesRankByBand[band].sortedRankings(),
      this.players.findFreeAgents(),
    ]);
    const doublesTotals = new Map(doublesRanked.map((r) => [r.playerId, r.totalPoints]));
    const singlesTotals = new Map(singlesRanked.map((r) => [r.playerId, r.totalPoints]));

    // Free-agent fillers: manager-less players not already in the field,
    // age-eligible for this tournament's band (this filter is new — see
    // the padding block below for why it matters more now than it did
    // when a filler could only ever cover a single odd leftover).
    let fillerIds: PlayerId[] = freeAgents
      .filter((p) => isAgeEligibleForTournamentBand(p.ageInWeeks, tournament.ageBand))
      .map((p) => p.id)
      .filter((id) => !entrants.includes(id));

    // A doubles field never forms a bracket below 2 pairs — see
    // DoublesPairingService.pair: persistent partnerships pair off,
    // remaining solo entrants pair two-by-two, and only ONE odd leftover
    // ever gets a filler. There is no general backfill of a sparse field,
    // unlike SINGLES draws, which StartDueTournamentsUseCase.fillSlots
    // already pads from the fill-only pool up to full draw capacity. A
    // single persistent pair entering alone — the common real case —
    // forms exactly 1 pair and silently never plays: `form()` still runs
    // to completion and saves, no error, `hasDoublesDrawStarted` just
    // never becomes true, and SimulateDueMatchesUseCase.sweepDoubles
    // gates on exactly that flag, forever. Confirmed live during an
    // extended playtest: 0 decided doubles matches anywhere in the
    // world, across 3+ seasons and 89 real doubles-entrant registrations.
    //
    // Fix: pad the PAIRING INPUT (not `tournament.doublesEntrants` — a
    // filler never actually "registers", exactly like the pre-existing
    // odd-leftover filler already didn't; registering here would also
    // incorrectly throw once this tournament's SINGLES draw has already
    // started, which it usually has by the time this runs) with enough
    // free agents to reach a full `doublesDrawSize` worth of pairs — the
    // same "fill all the way to capacity, not just the bare minimum"
    // philosophy `fillSlots` already applies to singles, so a lightly
    // subscribed doubles field gets a real, full-sized bracket instead of
    // perpetually forming just one padded pair. Excludes any filler
    // already committed to another tournament the same week (the same
    // check `fillSlots` already uses for singles), so padding can never
    // double-book a filler across two draws forming in the same tick.
    const targetFieldSize = tournament.doublesDrawSize * 2;
    if (entrants.length < targetFieldSize) {
      const padded: PlayerId[] = [];
      for (const id of fillerIds) {
        if (entrants.length + padded.length >= targetFieldSize) break;
        const committedElsewhere = await this.tournaments.findByPlayerAndWeek(id, tournament.weekScheduled);
        if (committedElsewhere.length === 0) padded.push(id);
      }
      entrants = [...entrants, ...padded];
      fillerIds = fillerIds.filter((id) => !padded.includes(id));
    }

    const entryRanking = new Map<PlayerId, number>();
    for (const id of [...entrants, ...fillerIds]) {
      entryRanking.set(id, doublesEntryRanking(doublesTotals.get(id) ?? 0, singlesTotals.get(id) ?? 0));
    }

    const persistentPairs = (await this.pairs.findByPlayers(entrants))
      .filter((p) => p.isActive && entrants.includes(p.playerA) && entrants.includes(p.playerB))
      .map((p) => ({ playerA: p.playerA, playerB: p.playerB, pairId: p.id, chemistry: p.chemistry }));

    const result = this.pairingService.pair({
      tournamentId: tournament.id,
      entrants,
      entryRanking,
      persistentPairs,
      freeAgentFillers: fillerIds,
      drawSize: tournament.doublesDrawSize,
      random: this.random,
    });

    const toPair = (p: { pairId: PairId; playerA: PlayerId; playerB: PlayerId; chemistry?: number; persistentPairId?: PairId }) => ({
      pairId: p.pairId,
      playerA: p.playerA,
      playerB: p.playerB,
      chemistry: p.chemistry,
      persistentPairId: p.persistentPairId,
    });
    const seedable = (pairs: ReturnType<typeof toPair>[]) => pairs.map((p) => ({ playerId: p.pairId, seed: null }));
    const seedMainDraw = (pairs: ReturnType<typeof toPair>[]) => {
      const rounds = this.bracketGenerator.generate(seedable(pairs), tournament.doublesDrawSize);
      if (rounds[0].matches.length === 0) return;
      tournament.startDoublesWithBracket(pairs, rounds);
    };

    // Doubles qualifying (P8): the top `doublesDirectAcceptanceCapacity`
    // pairs go straight into the main draw, the next
    // `doublesQualifyingDrawSize` go into doubles qualifying (seeded now,
    // played on the opening days), the rest are cut. Without qualifying
    // this reduces to the pre-P8 "top-N make the draw, rest cut" behavior.
    const sorted = result.pairs;
    const direct = sorted.slice(0, tournament.doublesDirectAcceptanceCapacity).map(toPair);
    const qualifying = sorted
      .slice(tournament.doublesDirectAcceptanceCapacity, tournament.doublesDirectAcceptanceCapacity + tournament.doublesQualifyingDrawSize)
      .map(toPair);

    if (tournament.hasDoublesQualifying) {
      if (direct.length > 0) {
        tournament.recordDoublesDirectAcceptancePairs(direct);
      }
      if (qualifying.length >= 2) {
        const qRounds = this.bracketGenerator.generate(seedable(qualifying), tournament.doublesQualifyingDrawSize);
        if (qRounds[0].matches.length > 0) {
          tournament.startDoublesQualifyingWithBracket(qualifying, qRounds);
        } else if (direct.length >= 2) {
          // A qualifying field too sparse to seed a match — fall back to
          // seeding the main draw from the direct pairs alone.
          seedMainDraw(direct);
        }
      } else if (direct.length >= 2) {
        seedMainDraw(direct);
      }
    } else if (direct.length >= 2) {
      seedMainDraw(direct);
    }

    await this.tournaments.save(tournament);
  }
}
