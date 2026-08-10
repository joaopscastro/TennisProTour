import { eq } from 'drizzle-orm';
import { PlayerId, Surface, TrainableAttribute, TrainingFocus, TrainingScheduleEntry } from '@tennis-manager/domain';
import { TrainingScheduleRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { trainingSchedule } from '../../db/schema';

type TrainingScheduleRow = typeof trainingSchedule.$inferSelect;

/** Reassembles the discriminated TrainingFocus union from its three
 * nullable flat columns — same convention DrizzlePlayerRepository used
 * for the old (now-removed) training_focus_* columns on `players`. */
function toDomainFocus(row: TrainingScheduleRow): TrainingFocus | null {
  if (row.focusKind === 'surface' && row.focusSurface) {
    return { kind: 'surface', surface: row.focusSurface as Surface };
  }
  if (row.focusKind === 'attribute' && row.focusAttribute) {
    return { kind: 'attribute', attribute: row.focusAttribute as TrainableAttribute };
  }
  return null;
}

function focusColumns(focus: TrainingFocus | null) {
  if (!focus) return { focusKind: null, focusSurface: null, focusAttribute: null };
  return focus.kind === 'surface'
    ? { focusKind: 'surface' as const, focusSurface: focus.surface, focusAttribute: null }
    : { focusKind: 'attribute' as const, focusSurface: null, focusAttribute: focus.attribute };
}

export class DrizzleTrainingScheduleRepository implements TrainingScheduleRepository {
  constructor(private readonly db: Db) {}

  async findByPlayer(playerId: PlayerId): Promise<TrainingScheduleEntry[]> {
    const rows = await this.db.select().from(trainingSchedule).where(eq(trainingSchedule.playerId, playerId));
    return rows.map((row) => ({
      playerId: PlayerId(row.playerId),
      effectiveFrom: { season: row.effectiveFromSeason, week: row.effectiveFromWeek },
      focus: toDomainFocus(row),
    }));
  }

  async save(entry: TrainingScheduleEntry): Promise<void> {
    const row = {
      playerId: entry.playerId,
      effectiveFromSeason: entry.effectiveFrom.season,
      effectiveFromWeek: entry.effectiveFrom.week,
      ...focusColumns(entry.focus),
    };
    await this.db
      .insert(trainingSchedule)
      .values(row)
      .onConflictDoUpdate({
        target: [trainingSchedule.playerId, trainingSchedule.effectiveFromSeason, trainingSchedule.effectiveFromWeek],
        set: row,
      });
  }
}
