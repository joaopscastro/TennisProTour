import { MatchId, TournamentId, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, MastersCupRepository } from '../ports/ports';
import { SimulateMastersCupMatchUseCase } from './SimulateMastersCupMatchUseCase';

export interface SimulateDueMastersCupMatchesCommand {
  season: number;
  worldId: WorldId;
}

export interface SimulateDueMastersCupMatchesResult {
  simulated: MatchId[];
  failed: Array<{ matchId: MatchId; reason: string }>;
}

function matchIdFor(discipline: 'singles' | 'doubles', phase: 'group' | 'knockout', cupId: TournamentId, groupIndex: number | undefined, roundNumber: number | undefined, matchIndex: number): MatchId {
  const loc = phase === 'group' ? `g${groupIndex}` : `k${roundNumber}`;
  return MatchId(`${cupId}-${discipline[0]}-${loc}-m${matchIndex}`);
}

/**
 * The Masters Cup's "play what's due" job (P8b) — sweeps the current
 * season's cup, pacing it day-by-day: the group stage plays on the cup's
 * opening day, the semifinals on day 2, the final on day 3. Advances from
 * group to knockout are NOT this class's job (AdvanceMastersCupUseCase,
 * run right after); this only simulates matches whose scheduled day has
 * arrived.
 */
export class SimulateDueMastersCupMatchesUseCase {
  constructor(
    private readonly cups: MastersCupRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly simulateMastersCupMatch: SimulateMastersCupMatchUseCase,
  ) {}

  async execute(command: SimulateDueMastersCupMatchesCommand): Promise<SimulateDueMastersCupMatchesResult> {
    const result: SimulateDueMastersCupMatchesResult = { simulated: [], failed: [] };
    const cup = await this.cups.findBySeason(command.season);
    if (!cup) return result;

    const world = await this.worlds.findById(this.worldId);
    const today = world?.currentGameDay ?? { season: 1, week: 1, day: 1 };

    // A day is "due" if the cup's week has begun and the relative day has
    // arrived. Group = day 1, semis = day 2, final = day 3.
    const firstDay = { ...cup.weekScheduled, day: 1 };
    const dayIndex = (season: number, week: number, day: number) => season * 100000 + week * 10 + day;
    const cupWeekStarted = dayIndex(today.season, today.week, today.day) >= dayIndex(firstDay.season, firstDay.week, 1);
    if (!cupWeekStarted) return result;

    const relativeDay = Math.max(1, (dayIndex(today.season, today.week, today.day) - dayIndex(firstDay.season, firstDay.week, 1)) + 1);

    // Group stage: due on relative day 1 (and stays due until complete).
    if (!cup.singlesGroupStageComplete && relativeDay >= 1) {
      await this.sweepGroup(cup.id, command.season, 'singles', result);
      await this.sweepGroup(cup.id, command.season, 'doubles', result);
    }

    // Knockout: semis on relative day 2, final on relative day 3.
    if (cup.hasKnockout) {
      for (const discipline of ['singles', 'doubles'] as const) {
        for (let roundNumber = 1; roundNumber <= 2; roundNumber++) {
          const dueDay = roundNumber === 1 ? 2 : 3;
          if (relativeDay < dueDay) continue;
          const fresh = await this.cups.findBySeason(command.season);
          if (!fresh) return result;
          const rounds = discipline === 'singles' ? fresh.singlesKnockout : fresh.doublesKnockout;
          const round = rounds.find((r) => r.roundNumber === roundNumber);
          if (!round) continue;
          for (let matchIndex = 0; matchIndex < round.matches.length; matchIndex++) {
            if (round.matches[matchIndex].outcome !== null) continue;
            const matchId = matchIdFor(discipline, 'knockout', cup.id, undefined, roundNumber, matchIndex);
            try {
              await this.simulateMastersCupMatch.execute({
                matchId,
                cupId: cup.id,
                season: command.season,
                discipline,
                phase: 'knockout',
                roundNumber,
                matchIndex,
              });
              result.simulated.push(matchId);
            } catch (error) {
              result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
            }
          }
        }
      }
    }

    return result;
  }

  private async sweepGroup(cupId: TournamentId, season: number, discipline: 'singles' | 'doubles', result: SimulateDueMastersCupMatchesResult): Promise<void> {
    // Re-fetch fresh each match: SimulateMastersCupMatchUseCase loads and
    // SAVES the cup itself, so the sweep must not hold a stale reference.
    const cup = await this.cups.findBySeason(season);
    if (!cup) return;
    const groups = discipline === 'singles' ? cup.singlesGroups : cup.doublesGroups;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      for (let matchIndex = 0; matchIndex < groups[groupIndex].matches.length; matchIndex++) {
        const fresh = await this.cups.findBySeason(season);
        if (!fresh) return;
        const freshGroups = discipline === 'singles' ? fresh.singlesGroups : fresh.doublesGroups;
        if (freshGroups[groupIndex].matches[matchIndex].outcome !== null) continue;
        const matchId = matchIdFor(discipline, 'group', cupId, groupIndex, undefined, matchIndex);
        try {
          await this.simulateMastersCupMatch.execute({
            matchId,
            cupId,
            season,
            discipline,
            phase: 'group',
            groupIndex,
            matchIndex,
          });
          result.simulated.push(matchId);
        } catch (error) {
          result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
}
