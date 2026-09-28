import { BracketGenerator, DoublesPairingService, RandomSource, Tournament, RankingBand, PairId, doublesEntryRanking, isAgeEligibleForTournamentBand } from '@tennis-manager/domain';
import { Player, PlayerId, doublesSideStrength, orderDoublesFieldFillers, CHEMISTRY_BONUS_PER_POINT } from '@tennis-manager/domain';
import { DoublesPairRepository, PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankedPlayer, RankPositionQuery } from '../queries/RankPositionQuery';

/**
 * Run-wide inputs a caller that forms SEVERAL doubles draws in one
 * execution (StartDueTournamentsUseCase) can load once and share,
 * instead of re-reading rankings + the free-agent pool per draw (the
 * profile's per-tournament hot spot). Every field is OPTIONAL and falls
 * back to today's per-call read, so existing callers (the
 * RegisterEntrantUseCase auto-start path) and the unit tests are
 * unchanged.
 *
 * `freeAgents` must be `players.findFreeAgents()`'s own result — the
 * SAME query and ordering — and `enteredPlayerIdsForWeek` the set form
 * of `findByPlayerAndWeek(...).length > 0`, so the padding below sees the
 * same pool and per-week exclusions a per-call read would.
 */
export interface FormDoublesDrawPreloaded {
  singlesRanked?: ReadonlyArray<RankedPlayer>;
  doublesRanked?: ReadonlyArray<RankedPlayer>;
  freeAgents?: ReadonlyArray<Player>;
  enteredPlayerIdsForWeek?: Set<PlayerId>;
  /** The set form of the signing rule's `noUnfinishedCommitment`
   * predicate, from `TournamentRepository.findUnfinishedCommitmentPlayerIds`
   * — the SAME set the singles fill consumes. A filler still alive in an
   * earlier week's draw (a 14-day major, a late-running event) must not
   * be padded into this draw either: the per-week set above only sees
   * entries scheduled for the same week, so it cannot stop a
   * cross-week double-booking. When absent, the use case reads the set
   * itself if the repository supports it (one query); ids actually
   * padded by this call are added to the set so a later draw in the same
   * run can't reuse them. */
  unfinishedCommitmentPlayerIds?: Set<PlayerId>;
}

/**
 * Forms a tournament's doubles draw (P7b) from its solo entrants — the
 * step that turns "who signed up" into "who plays, and with whom":
 * persistent partnerships are kept together, real solo entrants are
 * randomly paired (free-agent fillers cover an odd leftover), each pair's
 * combined ranking (sum of the two players' DOUBLES-else-SINGLES entry
 * rankings) decides who makes the `doublesDrawSize` cut, and the
 * survivors are seeded into the doubles bracket.
 *
 * Free-agent PADDING (the field-completion step) is strength-aware and
 * cap-aware, not random — see the block inside `form()` and
 * `orderDoublesFieldFillers` for the measured rationale (the "doubles is
 * an uncontested economy" finding).
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

  async form(tournament: Tournament, preloaded: FormDoublesDrawPreloaded = {}): Promise<void> {
    if (!tournament.hasDoubles || tournament.hasDoublesDrawStarted) return;
    const realEntrants = [...tournament.doublesEntrants];
    if (realEntrants.length === 0) return;

    // Junior doubles (P8): the combined ranking is computed in the
    // tournament's OWN band — a u14 doubles draw ranks entrants by their
    // u14 doubles (else u14 singles), never the senior tour's.
    const band: RankingBand = tournament.ageBand ?? 'senior';

    const [doublesRanked, singlesRanked, freeAgents, entrantPlayers, rawPersistentPairs] = await Promise.all([
      preloaded.doublesRanked ? Promise.resolve(preloaded.doublesRanked) : this.doublesRankByBand[band].sortedRankings(),
      preloaded.singlesRanked ? Promise.resolve(preloaded.singlesRanked) : this.singlesRankByBand[band].sortedRankings(),
      preloaded.freeAgents ? Promise.resolve(preloaded.freeAgents) : this.players.findFreeAgents(),
      Promise.all(realEntrants.map((id) => this.players.findById(id))),
      this.pairs.findByPlayers(realEntrants),
    ]);
    // The run-wide set when preloaded (StartDueTournamentsUseCase), or a
    // one-off read otherwise (the RegisterEntrantUseCase auto-start path),
    // so an odd-leftover/padding filler can never be someone still alive
    // in an earlier week's draw. Absent only when the repository doesn't
    // implement the read (an in-memory fake), where the old same-week-only
    // exclusion still applies.
    const unfinishedCommitments =
      preloaded.unfinishedCommitmentPlayerIds ??
      (this.tournaments.findUnfinishedCommitmentPlayerIds
        ? new Set(await this.tournaments.findUnfinishedCommitmentPlayerIds())
        : undefined);
    const doublesTotals = new Map(doublesRanked.map((r) => [r.playerId, r.totalPoints]));
    const singlesTotals = new Map(singlesRanked.map((r) => [r.playerId, r.totalPoints]));

    // ---- Strength-aware, cap-aware padding (docs/balance-tuning-report.md) ----
    // The measured finding: padding drew from ranked free agents but the
    // random shuffle diluted them into one weak average pair, so a strong
    // persistent pair won 29-30 doubles titles a season against largely
    // filler fields. The fix is FIELD STRENGTH, not points (ATP doubles
    // points parity is sourced and deliberately untouched): every padded
    // filler is selected in strength order and every padded pair is
    // formed strongest-with-strongest, bounded by a cap — the strength of
    // the WEAKEST real manager pair in the draw — so anonymous padding is
    // never stronger than a manager's own pair (principle #1: padding is
    // convenience, never an advantage inversion).
    const strength = new Map<PlayerId, number>();
    for (const p of entrantPlayers) {
      if (p) strength.set(p.id, doublesSideStrength(p.attributes, tournament.surface));
    }
    for (const p of freeAgents) {
      strength.set(p.id, doublesSideStrength(p.attributes, tournament.surface));
    }

    const persistentPairs = rawPersistentPairs
      .filter((p) => p.isActive && realEntrants.includes(p.playerA) && realEntrants.includes(p.playerB))
      .map((p) => ({ playerA: p.playerA, playerB: p.playerB, pairId: p.id, chemistry: p.chemistry }));

    const pairStrengthOf = (playerA: PlayerId, playerB: PlayerId, chemistry: number): number =>
      ((strength.get(playerA) ?? 0) + (strength.get(playerB) ?? 0)) / 2 + CHEMISTRY_BONUS_PER_POINT * chemistry;

    // Cap reference: the weakest real manager pair that already exists.
    // When the draw has no persistent pair yet (solo entrants only), fall
    // back to the weakest ENTRANT's own strength — deliberately
    // conservative: a pair containing that entrant can only be at least
    // that strong, so padding stays below every manager on the board.
    const cap =
      persistentPairs.length > 0
        ? Math.min(...persistentPairs.map((p) => pairStrengthOf(p.playerA, p.playerB, p.chemistry)))
        : Math.min(...realEntrants.map((id) => strength.get(id) ?? 0));

    // Age-eligible, uncommitted candidates in field-strength order:
    // strongest under-cap first, then (only if the field still can't be
    // filled) the over-cap candidates weakest-first. The commitment
    // checks below still gate every individual pick, exactly as before.
    const candidates = orderDoublesFieldFillers(
      freeAgents
        .filter((p) => isAgeEligibleForTournamentBand(p.seasonAgeAnchorWeeks, tournament.ageBand))
        .filter((p) => !realEntrants.includes(p.id))
        .map((p) => ({ playerId: p.id, strength: strength.get(p.id) ?? 0 })),
      cap,
    );

    // Pad the PAIRING INPUT (not `tournament.doublesEntrants` — a filler
    // never actually "registers", exactly like the pre-existing
    // odd-leftover filler already didn't; registering here would also
    // incorrectly throw once this tournament's SINGLES draw has already
    // started, which it usually has by the time this runs) with enough
    // free agents to reach a full `doublesDrawSize` worth of pairs — the
    // same "fill all the way to capacity" philosophy `fillSlots` applies
    // to singles, so a lightly subscribed doubles field gets a real,
    // full-sized bracket. Excludes any filler already committed to
    // another tournament the same week (the same check `fillSlots` uses)
    // or still alive in an earlier week's draw.
    const targetFieldSize = tournament.doublesDrawSize * 2;
    const needed = Math.max(0, targetFieldSize - realEntrants.length);
    const padded: PlayerId[] = [];
    for (const candidate of candidates) {
      if (padded.length >= needed) break;
      const id = candidate.playerId;
      if (unfinishedCommitments?.has(id)) continue;
      const committedElsewhere = preloaded.enteredPlayerIdsForWeek
        ? preloaded.enteredPlayerIdsForWeek.has(id)
        : (await this.tournaments.findByPlayerAndWeek(id, tournament.weekScheduled)).length > 0;
      if (!committedElsewhere) padded.push(id);
    }
    const entrants = [...realEntrants, ...padded];
    const fillerIds = candidates.map((c) => c.playerId).filter((id) => !padded.includes(id));
    // Mirror fillDrawSlots: record the new commitments so a later draw
    // in the same run (same week or a later one) can't reuse a player
    // this padding just placed.
    for (const id of padded) {
      unfinishedCommitments?.add(id);
      preloaded.enteredPlayerIdsForWeek?.add(id);
    }

    const entryRanking = new Map<PlayerId, number>();
    for (const id of [...entrants, ...fillerIds]) {
      entryRanking.set(id, doublesEntryRanking(doublesTotals.get(id) ?? 0, singlesTotals.get(id) ?? 0));
    }

    const result = this.pairingService.pair({
      tournamentId: tournament.id,
      entrants,
      entryRanking,
      persistentPairs,
      freeAgentFillers: fillerIds,
      drawSize: tournament.doublesDrawSize,
      random: this.random,
      // Field-strength fix: the service keeps the padding order (strongest
      // pair first) instead of shuffling padded fillers into the pool.
      strength,
      fillerEntrants: new Set(padded),
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
