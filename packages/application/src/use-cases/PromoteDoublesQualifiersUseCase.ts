import { BracketGenerator, isAgeEligibleForTournamentBand, PairId, PlayerId, Tournament, WorldId } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';

export interface PromoteDoublesQualifiersCommand {
  worldId: WorldId;
}

export interface PromoteDoublesQualifiersResult {
  /** Tournaments whose doubles main draw was seeded by this run. */
  mainDrawsSeeded: number;
  /** Doubles qualifiers actually promoted across those tournaments. */
  promoted: number;
}

/**
 * The bridge between a tournament's two doubles brackets (P8): once its
 * doubles QUALIFYING event has been played out, the surviving pairs take
 * the main-draw places reserved for them, and the doubles main bracket is
 * seeded — the doubles analogue of PromoteQualifiersUseCase.
 *
 * **Deferred main-draw seeding.** The doubles main draw deliberately does
 * not exist while doubles qualifying is being played: seeding it up front
 * would require match slots with a missing "vs. Qualifier" participant.
 * Waiting costs nothing — the doubles qualifying panel is what the page
 * shows in the meantime — and it mirrors the singles/qualifying flow
 * exactly.
 *
 * Run once per DAY tick, right after the match sweep (the worker handler
 * already pairs the singles equivalent), so the day qualifying's last
 * round is decided is the day the doubles main draw is made. Idempotent
 * by construction: promotion is only attempted for a tournament whose
 * qualifying is complete and whose main doubles draw does not exist yet,
 * and it ends by seeding that main draw.
 */
export class PromoteDoublesQualifiersUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly bracketGenerator: BracketGenerator,
    /** Optional and LAST for test compatibility: without it the sparse-
     * doubles-main-draw rescue is inert and the pre-existing "record the
     * promotions, leave the main draw unseeded" behaviour is unchanged.
     * The composition root always passes it. */
    private readonly players?: PlayerRepository,
  ) {}

  async execute(_command: PromoteDoublesQualifiersCommand): Promise<PromoteDoublesQualifiersResult> {
    const result: PromoteDoublesQualifiersResult = { mainDrawsSeeded: 0, promoted: 0 };

    for (const tournament of await this.tournaments.findStarted()) {
      if (!tournament.hasDoublesQualifying) continue;
      if (tournament.hasDoublesDrawStarted) continue;
      if (!tournament.isDoublesQualifyingComplete()) continue;

      // The doubles analogue of PromoteQualifiersUseCase's own fix: a
      // tournament whose doubles main draw came out too sparse to seed
      // (the "sparse field" branch below) is left with its winners
      // already promoted and `hasDoublesDrawStarted` still false, so the
      // guard above can't distinguish "not yet promoted" from "promoted,
      // seeding failed" and reprocesses this tournament every day tick.
      // Unlike the singles side, `promoteDoublesQualifier` has no
      // "already promoted" guard at all, so an unfiltered re-run doesn't
      // even throw — it silently pushes the SAME pair into `_doublesPairs`
      // a second time, corrupting the field. Filtering already-promoted
      // pairs here fixes both failure modes at once.
      const alreadyPromoted = new Set(tournament.doublesPairs.map((p) => p.pairId));
      const winners = tournament.doublesQualifyingWinners().filter((pairId) => !alreadyPromoted.has(pairId));
      for (const winner of winners) {
        tournament.promoteDoublesQualifier(winner);
        result.promoted += 1;
      }

      // Seed the doubles main draw from direct acceptances + qualifiers.
      let bracket = this.bracketGenerator.generate(
        tournament.doublesPairs.map((p) => ({ playerId: p.pairId, seed: null })),
        tournament.doublesDrawSize,
      );
      if (bracket[0].matches.length === 0 && this.players) {
        // Same rescue as the singles side: the qualifying result is a
        // real, earned result that must not be thrown away, so pad the
        // sparse main draw with filler PAIRS and re-generate rather than
        // dead-ending forever.
        await this.padDoublesMainDraw(tournament);
        bracket = this.bracketGenerator.generate(
          tournament.doublesPairs.map((p) => ({ playerId: p.pairId, seed: null })),
          tournament.doublesDrawSize,
        );
      }
      if (bracket[0].matches.length === 0) {
        // Still too sparse even after padding — save the promotions and
        // leave the main draw unseeded; a later tick retries.
        await this.tournaments.save(tournament);
        continue;
      }

      tournament.startDoublesWithBracket([...tournament.doublesPairs], bracket);
      await this.tournaments.save(tournament);
      result.mainDrawsSeeded += 1;
    }

    return result;
  }

  /** Tops a sparse main doubles draw up to a seedable size with filler
   * pairs drawn from the eligible free-agent pool — two age-eligible free
   * agents per pair, none of them already involved in this tournament's
   * doubles field or already committed to another tournament that week.
   * Idempotent across re-runs: pairs already present (including fillers
   * added last time) are excluded by player membership, and pair ids are
   * derived from the growing pair count so they can't collide. */
  private async padDoublesMainDraw(tournament: Tournament): Promise<void> {
    if (!this.players) return;
    const needed = tournament.doublesDrawSize - tournament.doublesPairs.length;
    if (needed <= 0) return;

    const alreadyIn = new Set<PlayerId>();
    for (const pair of [...tournament.doublesPairs, ...tournament.doublesQualifyingPairs]) {
      alreadyIn.add(pair.playerA);
      alreadyIn.add(pair.playerB);
    }

    const freeAgents = await this.players.findFreeAgents();
    const available: PlayerId[] = [];
    for (const player of freeAgents) {
      if (alreadyIn.has(player.id)) continue;
      if (!isAgeEligibleForTournamentBand(player.seasonAgeAnchorWeeks, tournament.ageBand)) continue;
      const committedElsewhere = await this.tournaments.findByPlayerAndWeek(player.id, tournament.weekScheduled);
      if (committedElsewhere.length > 0) continue;
      available.push(player.id);
    }

    let added = 0;
    for (let i = 0; i + 1 < available.length && added < needed; i += 2) {
      tournament.addDoublesMainDrawFiller({
        pairId: PairId(`${tournament.id}-df${tournament.doublesPairs.length}`),
        playerA: available[i],
        playerB: available[i + 1],
        chemistry: 0,
      });
      added += 1;
    }
    await this.tournaments.save(tournament);
  }
}
