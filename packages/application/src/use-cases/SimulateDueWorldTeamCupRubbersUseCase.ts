import { MatchId, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, WorldTeamCupRepository } from '../ports/ports';
import { SimulateWorldTeamCupRubberUseCase } from './SimulateWorldTeamCupRubberUseCase';

export interface SimulateDueWorldTeamCupRubbersCommand {
  season: number;
  worldId: WorldId;
}

export interface SimulateDueWorldTeamCupRubbersResult {
  simulated: MatchId[];
  failed: Array<{ matchId: MatchId; reason: string }>;
}

function matchIdFor(cupId: string, discipline: 's' | 'd', loc: string, rubberIndex: number): MatchId {
  return MatchId(`${cupId}-${discipline}-${loc}-r${rubberIndex}`);
}

/**
 * The World Team Cup's "play what's due" job (P8c). Paces the event day
 * by day: group ties play over the opening days, the semifinal ties on day
 * 4, the final tie on day 5. For each tie it simulates the next due rubber
 * (singles 1, singles 2, then doubles only when the singles split 1-1).
 */
export class SimulateDueWorldTeamCupRubbersUseCase {
  constructor(
    private readonly cups: WorldTeamCupRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly simulateRubber: SimulateWorldTeamCupRubberUseCase,
  ) {}

  async execute(command: SimulateDueWorldTeamCupRubbersCommand): Promise<SimulateDueWorldTeamCupRubbersResult> {
    const result: SimulateDueWorldTeamCupRubbersResult = { simulated: [], failed: [] };
    const cup = await this.cups.findBySeason(command.season);
    if (!cup) return result;

    const world = await this.worlds.findById(this.worldId);
    const today = world?.currentGameDay ?? { season: 1, week: 1, day: 1 };
    const firstDay = { ...cup.weekScheduled, day: 1 };
    const idx = (d: { season: number; week: number; day: number }) => d.season * 100000 + d.week * 10 + d.day;
    if (idx(today) < idx(firstDay)) return result;
    const relativeDay = idx(today) - idx(firstDay) + 1;

    // Group ties: due over relative days 1-3 (a tie can take up to 3
    // rubbers). Knockout semis: day 4; final: day 5.
    for (let groupIndex = 0; groupIndex < cup.groups.length; groupIndex++) {
      const group = cup.groups[groupIndex];
      for (let tieIndex = 0; tieIndex < group.ties.length; tieIndex++) {
        if (relativeDay > 3) break;
        await this.playDueRubber(cup.id, command.season, { phase: 'group', groupIndex, tieIndex }, result);
      }
    }
    if (cup.hasKnockout) {
      for (let roundNumber = 1; roundNumber <= cup.knockout.length; roundNumber++) {
        const dueDay = roundNumber === 1 ? 4 : 5;
        if (relativeDay < dueDay) continue;
        for (let tieIndex = 0; tieIndex < cup.knockout[roundNumber - 1].length; tieIndex++) {
          await this.playDueRubber(cup.id, command.season, { phase: 'knockout', roundNumber, tieIndex }, result);
        }
      }
    }

    return result;
  }

  private async playDueRubber(
    cupId: string,
    season: number,
    loc: { phase: 'group' | 'knockout'; groupIndex?: number; roundNumber?: number; tieIndex: number },
    result: SimulateDueWorldTeamCupRubbersResult,
  ): Promise<void> {
    const cup = await this.cups.findBySeason(season);
    if (!cup) return;
    const tie = loc.phase === 'group'
      ? cup.groups[loc.groupIndex!].ties[loc.tieIndex]
      : cup.knockout[loc.roundNumber! - 1][loc.tieIndex];
    const rubberIndex = cup.nextDueRubberIndex(tie);
    if (rubberIndex === null) return;
    const rubber = tie.rubbers[rubberIndex];
    const discipline = rubber.kind === 'singles' ? 's' : 'd';
    const locKey = loc.phase === 'group' ? `g${loc.groupIndex}-t${loc.tieIndex}` : `k${loc.roundNumber}-t${loc.tieIndex}`;
    const matchId = matchIdFor(cupId, discipline, locKey, rubberIndex);
    try {
      await this.simulateRubber.execute({
        matchId,
        cupId: cup.id,
        season,
        phase: loc.phase,
        groupIndex: loc.groupIndex,
        roundNumber: loc.roundNumber,
        tieIndex: loc.tieIndex,
        rubberIndex,
      });
      result.simulated.push(matchId);
    } catch (error) {
      result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}
