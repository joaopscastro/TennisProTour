import { MastersCupRepository } from '../ports/ports';

export interface AdvanceMastersCupCommand {
  season: number;
}

/**
 * Advances the Masters Cup (P8b) from its group stage to its knockout
 * stage: once BOTH group stages (singles and doubles) are fully played,
 * seed the semifinals/final from each group's top two. Idempotent (guarded
 * by the cup's own `hasKnockout` + `seedKnockout`). Run once per DAY tick,
 * after the match sweep, so the day the last group match is decided is the
 * day the knockout is made — the same deferred-seeding pattern the
 * qualifying → main-draw flows already use.
 */
export class AdvanceMastersCupUseCase {
  constructor(private readonly cups: MastersCupRepository) {}

  async execute(command: AdvanceMastersCupCommand): Promise<void> {
    const cup = await this.cups.findBySeason(command.season);
    if (!cup || cup.hasKnockout) return;
    if (!cup.singlesGroupStageComplete || !cup.doublesGroupStageComplete) return;
    cup.seedKnockout();
    await this.cups.save(cup);
  }
}
