import { BracketGenerator, DoublesPairingService, RandomSource, Tournament, RankingBand, PairId, doublesEntryRanking } from '@tennis-manager/domain';
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
    const entrants = [...tournament.doublesEntrants];
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

    // Free-agent fillers: manager-less players not already in the field.
    const fillerIds: PlayerId[] = freeAgents.map((p) => p.id).filter((id) => !entrants.includes(id));

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
