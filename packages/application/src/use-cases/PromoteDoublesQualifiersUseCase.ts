import { BracketGenerator, WorldId } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

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
  ) {}

  async execute(_command: PromoteDoublesQualifiersCommand): Promise<PromoteDoublesQualifiersResult> {
    const result: PromoteDoublesQualifiersResult = { mainDrawsSeeded: 0, promoted: 0 };

    for (const tournament of await this.tournaments.findStarted()) {
      if (!tournament.hasDoublesQualifying) continue;
      if (tournament.hasDoublesDrawStarted) continue;
      if (!tournament.isDoublesQualifyingComplete()) continue;

      for (const winner of tournament.doublesQualifyingWinners()) {
        tournament.promoteDoublesQualifier(winner);
        result.promoted += 1;
      }

      // Seed the doubles main draw from direct acceptances + qualifiers.
      const bracket = this.bracketGenerator.generate(
        tournament.doublesPairs.map((p) => ({ playerId: p.pairId, seed: null })),
        tournament.doublesDrawSize,
      );
      if (bracket[0].matches.length === 0) {
        // Too sparse to seed a real match — save the promotions and leave
        // the main draw unseeded (honest: qualifying completed, no main
        // draw yet).
        await this.tournaments.save(tournament);
        continue;
      }

      tournament.startDoublesWithBracket([...tournament.doublesPairs], bracket);
      await this.tournaments.save(tournament);
      result.mainDrawsSeeded += 1;
    }

    return result;
  }
}
