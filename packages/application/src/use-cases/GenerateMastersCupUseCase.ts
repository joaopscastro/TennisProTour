import { GameWeek, MastersCup, PairId, PlayerId, Surface, TournamentId, WorldId, doublesEntryRanking } from '@tennis-manager/domain';
import { DoublesPairRepository, IdGeneratorPort, MastersCupRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';

export interface GenerateMastersCupCommand {
  worldId: WorldId;
  season: number;
  weekScheduled: GameWeek;
  surface: Surface;
}

/**
 * Generates the season-end Masters Cup (P8b) — the capstone event for
 * BOTH singles (top 8 senior players) and doubles (top 8 persistent
 * partnerships). The doubles field is ranked by combined doubles ENTRY
 * ranking (doubles-else-singles, the same rule the doubles draw's cutoff
 * uses), so the cup invites the strongest partnerships, not ad-hoc pairs.
 *
 * Idempotent: at most one cup per season — a second run for the same
 * season returns the existing cup.
 *
 * Runs from the worker's weekly rollover (alongside junior-tournament
 * generation), gated on the season/ week being the designated capstone
 * week.
 */
export class GenerateMastersCupUseCase {
  constructor(
    private readonly cups: MastersCupRepository,
    private readonly singlesRank: RankPositionQuery,
    private readonly doublesRank: RankPositionQuery,
    private readonly pairs: DoublesPairRepository,
    private readonly idGenerator: IdGeneratorPort,
  ) {}

  async execute(command: GenerateMastersCupCommand): Promise<MastersCup | null> {
    const existing = await this.cups.findBySeason(command.season);
    if (existing) return existing;

    const [singlesRanked, doublesRanked, activePairs] = await Promise.all([
      this.singlesRank.sortedRankings(),
      this.doublesRank.sortedRankings(),
      this.pairs.findActive(),
    ]);
    const singlesTotals = new Map(singlesRanked.map((r) => [r.playerId, r.totalPoints]));
    const doublesTotals = new Map(doublesRanked.map((r) => [r.playerId, r.totalPoints]));

    const topSingles = singlesRanked.slice(0, 8).map((r) => r.playerId);

    const entryRankingOf = (id: PlayerId) =>
      doublesEntryRanking(doublesTotals.get(id) ?? 0, singlesTotals.get(id) ?? 0);
    const topPairs = activePairs
      .map((p) => ({ pair: p, combined: entryRankingOf(p.playerA) + entryRankingOf(p.playerB) }))
      .sort((a, b) => b.combined - a.combined)
      .slice(0, 8)
      .map((r) => ({
        pairId: r.pair.id,
        playerA: r.pair.playerA,
        playerB: r.pair.playerB,
        chemistry: r.pair.chemistry,
        persistentPairId: r.pair.id,
      }));

    // A cup needs a full field — if either ladder is too thin, skip this
    // season rather than faking a half-empty capstone.
    if (topSingles.length < 8 || topPairs.length < 8) return null;

    const cup = MastersCup.open({
      id: TournamentId(this.idGenerator.generate()),
      season: command.season,
      weekScheduled: command.weekScheduled,
      surface: command.surface,
      singlesEntrants: topSingles,
      doublesEntrants: topPairs,
    });
    await this.cups.save(cup);
    return cup;
  }
}
