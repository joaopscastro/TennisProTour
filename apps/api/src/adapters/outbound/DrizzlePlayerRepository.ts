import { eq } from 'drizzle-orm';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player, PlayerLifecycleStage } from '@tennis-manager/domain';
import {
  PlayerAttributes,
  Skill,
  SkillCluster,
  Surface,
  SurfaceAffinities,
  TrainingFocus,
} from '@tennis-manager/domain';
import { PlayerRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { players } from '../../db/schema';

type PlayerRow = typeof players.$inferSelect;

/**
 * Drizzle-backed PlayerRepository adapter. All row <-> aggregate
 * mapping lives here — the domain has no Drizzle imports, and this
 * class holds no domain rules. Rehydration goes through
 * Player.reconstitute(), never Player.hire(), so loading a player
 * back emits no PlayerHired event.
 */
export class DrizzlePlayerRepository implements PlayerRepository {
  constructor(private readonly db: Db) {}

  async findById(id: PlayerId): Promise<Player | null> {
    const rows = await this.db.select().from(players).where(eq(players.id, id)).limit(1);
    return rows.length > 0 ? toDomain(rows[0]) : null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    const rows = await this.db.select().from(players).where(eq(players.managerId, managerId));
    return rows.map(toDomain);
  }

  async findAll(): Promise<Player[]> {
    const rows = await this.db.select().from(players);
    return rows.map(toDomain);
  }

  async save(player: Player): Promise<void> {
    const row = toRow(player);
    await this.db
      .insert(players)
      .values(row)
      .onConflictDoUpdate({
        target: players.id,
        set: { ...row, updatedAt: new Date() },
      });
  }
}

/** Reassembles the discriminated TrainingFocus union from its two
 * nullable flat columns — the inverse of focusColumns() below. */
function toDomainFocus(row: PlayerRow): TrainingFocus | null {
  if (row.trainingFocusKind === 'surface' && row.trainingFocusSurface) {
    return { kind: 'surface', surface: row.trainingFocusSurface as Surface };
  }
  if (row.trainingFocusKind === 'skill' && row.trainingFocusCluster) {
    return { kind: 'skill', cluster: row.trainingFocusCluster as SkillCluster };
  }
  return null;
}

function focusColumns(focus: TrainingFocus | null) {
  if (!focus) return { trainingFocusKind: null, trainingFocusSurface: null, trainingFocusCluster: null };
  return focus.kind === 'surface'
    ? { trainingFocusKind: 'surface' as const, trainingFocusSurface: focus.surface, trainingFocusCluster: null }
    : { trainingFocusKind: 'skill' as const, trainingFocusSurface: null, trainingFocusCluster: focus.cluster };
}

function toDomain(row: PlayerRow): Player {
  return Player.reconstitute({
    id: PlayerId(row.id),
    name: row.name,
    nationality: row.nationality,
    managerId: row.managerId === null ? null : ManagerId(row.managerId),
    ageInWeeks: row.ageInWeeks,
    stage: row.stage as PlayerLifecycleStage,
    fatigue: row.fatigue,
    currentFocus: toDomainFocus(row),
    potentialCeiling: row.potentialCeiling,
    attributes: new PlayerAttributes({
      technical: {
        serve: Skill.of(row.serve),
        forehand: Skill.of(row.forehand),
        backhand: Skill.of(row.backhand),
        volley: Skill.of(row.volley),
      },
      physical: {
        speed: Skill.of(row.speed),
        stamina: Skill.of(row.stamina),
        strength: Skill.of(row.strength),
      },
      mental: {
        consistency: Skill.of(row.consistency),
        clutch: Skill.of(row.clutch),
      },
      surfaceAffinities: SurfaceAffinities.of({
        clay: row.affinityClay,
        grass: row.affinityGrass,
        hard: row.affinityHard,
        indoor: row.affinityIndoor,
      }),
    }),
  });
}

function toRow(player: Player): typeof players.$inferInsert {
  const { technical, physical, mental, surfaceAffinities } = player.attributes;
  return {
    id: player.id,
    name: player.name,
    nationality: player.nationality,
    managerId: player.managerId,
    ageInWeeks: player.ageInWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
    potentialCeiling: player.potentialCeiling,
    ...focusColumns(player.currentFocus),
    serve: technical.serve.value,
    forehand: technical.forehand.value,
    backhand: technical.backhand.value,
    volley: technical.volley.value,
    speed: physical.speed.value,
    stamina: physical.stamina.value,
    strength: physical.strength.value,
    consistency: mental.consistency.value,
    clutch: mental.clutch.value,
    affinityClay: surfaceAffinities.get('clay'),
    affinityGrass: surfaceAffinities.get('grass'),
    affinityHard: surfaceAffinities.get('hard'),
    affinityIndoor: surfaceAffinities.get('indoor'),
  };
}
