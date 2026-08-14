import { WorldTeamCupRepository } from '../ports/ports';

export interface AdvanceWorldTeamCupCommand {
  season: number;
}

/**
 * Advances the World Team Cup (P8c) from groups to knockout, and from
 * semifinals to final: once all group ties finish, seed the semifinals;
 * once both semifinal ties finish, seed the final. Idempotent (guarded by
 * the aggregate's own hasKnockout/advanceKnockout). Run once per DAY tick,
 * after the rubber sweep.
 */
export class AdvanceWorldTeamCupUseCase {
  constructor(private readonly cups: WorldTeamCupRepository) {}

  async execute(command: AdvanceWorldTeamCupCommand): Promise<void> {
    const cup = await this.cups.findBySeason(command.season);
    if (!cup || cup.complete) return;
    if (!cup.hasKnockout && cup.allGroupStagesComplete) {
      cup.seedKnockout();
    } else if (cup.hasKnockout) {
      cup.advanceKnockout();
    }
    await this.cups.save(cup);
  }
}
