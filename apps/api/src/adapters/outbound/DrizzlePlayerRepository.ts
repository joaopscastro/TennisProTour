import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player, PlayerDormantCarryoverBonus, PlayerLifecycleStage } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { PlayerRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { players } from '../../db/schema';
import { noUnfinishedCommitmentFor } from './unfinishedCommitment';

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

  async findFreeAgents(options: { limit?: number; offset?: number; signableOnly?: boolean } = {}): Promise<Player[]> {
    const conditions = [isNull(players.managerId), ne(players.stage, 'retired')];
    // The signable-only filter is the SAME SQL predicate the atomic claim
    // enforces (noUnfinishedCommitmentFor), so a page filtered here can
    // never show a Sign button the claim would refuse.
    if (options.signableOnly) conditions.push(noUnfinishedCommitmentFor(players.id));
    const base = this.db
      .select()
      .from(players)
      .where(and(...conditions))
      // age first (the long-standing "youngest first" ordering), then id
      // so paging is stable when two free agents share an age.
      .orderBy(asc(players.ageInWeeks), asc(players.id));
    if (options.limit !== undefined) {
      return (await base.limit(options.limit).offset(options.offset ?? 0)).map(toDomain);
    }
    if (options.offset !== undefined) {
      return (await base.offset(options.offset)).map(toDomain);
    }
    return (await base).map(toDomain);
  }

  async countFreeAgents(): Promise<{ total: number; signable: number }> {
    const rows = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        signable: sql<number>`count(*) FILTER (WHERE ${noUnfinishedCommitmentFor(players.id)})::int`,
      })
      .from(players)
      .where(and(isNull(players.managerId), ne(players.stage, 'retired')));
    return { total: Number(rows[0]?.total ?? 0), signable: Number(rows[0]?.signable ?? 0) };
  }

  /** The acquisition-loop guard's read (EnsureSignablePoolUseCase): the
   * same `countFreeAgents().signable` number, exposed as its own method
   * so the caller doesn't have to know the grouped shape. */
  async countSignableFreeAgents(): Promise<number> {
    return (await this.countFreeAgents()).signable;
  }

  /**
   * The bulk daily-fatigue recovery — ONE statement instead of a
   * findAll() + one upsert per tired player on every day tick. See
   * PlayerRepository.recoverFatigueForAll's doc comment for why this is
   * exactly equivalent to the per-player loop it replaces:
   * `GREATEST(0, fatigue - amount)` is `Player.recoverFatigue`'s
   * `max(0, min(100, fatigue - amount))` under the game's invariant that
   * fatigue never exceeds 100, and `WHERE fatigue > 0` is the loop's
   * `if (player.fatigue === 0) continue;` skip. `updated_at` is touched
   * the same way a save would.
   */
  async recoverFatigueForAll(amount: number): Promise<void> {
    await this.db
      .update(players)
      .set({ fatigue: sql`GREATEST(0, ${players.fatigue} - ${amount})`, updatedAt: sql`now()` })
      .where(sql`${players.fatigue} > 0`);
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

/** Reassembles the small dormant-bonus value from its two nullable
 * flat columns — same "flat columns for a small optional structured
 * field" convention as trainingFocus above, not jsonb (see
 * schema.ts's players table comment). */
function toDomainDormantCarryoverBonus(row: PlayerRow): PlayerDormantCarryoverBonus | null {
  if (row.dormantCarryoverTargetBand === null || row.dormantCarryoverBonusPoints === null) return null;
  return {
    targetBand: row.dormantCarryoverTargetBand as PlayerDormantCarryoverBonus['targetBand'],
    bonusPoints: row.dormantCarryoverBonusPoints,
  };
}

function dormantCarryoverBonusColumns(bonus: PlayerDormantCarryoverBonus | null) {
  return {
    dormantCarryoverTargetBand: bonus?.targetBand ?? null,
    dormantCarryoverBonusPoints: bonus?.bonusPoints ?? null,
  };
}

export function toDomain(row: PlayerRow): Player {
  return Player.reconstitute({
    id: PlayerId(row.id),
    name: row.name,
    nationality: row.nationality,
    managerId: row.managerId === null ? null : ManagerId(row.managerId),
    ageInWeeks: row.ageInWeeks,
    seasonAgeAnchorWeeks: row.seasonAgeAnchorWeeks,
    stage: row.stage as PlayerLifecycleStage,
    fatigue: row.fatigue,
    form: row.form,
    potentialCeiling: row.potentialCeiling,
    physicalCeilings: { speed: row.speedCeiling, stamina: row.staminaCeiling, strength: row.strengthCeiling },
    talent: row.talent,
    experience: row.experience,
    dormantCarryoverBonus: toDomainDormantCarryoverBonus(row),
    fillOnly: row.fillOnly,
    careerPrizeMoney: row.careerPrizeMoney,
    seasonPrizeMoney: row.seasonPrizeMoney,
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
      doubles: Skill.of(row.doubles),
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
    seasonAgeAnchorWeeks: player.seasonAgeAnchorWeeks,
    stage: player.stage,
    fatigue: player.fatigue,
    form: player.form,
    fillOnly: player.fillOnly,
    potentialCeiling: player.potentialCeiling,
    speedCeiling: player.physicalCeilings.speed,
    staminaCeiling: player.physicalCeilings.stamina,
    strengthCeiling: player.physicalCeilings.strength,
    talent: player.talent,
    experience: player.experience,
    careerPrizeMoney: player.careerPrizeMoney,
    seasonPrizeMoney: player.seasonPrizeMoney,
    ...dormantCarryoverBonusColumns(player.dormantCarryoverBonus),
    // Persist the RAW (unrounded) skill value, not the display-rounded
    // `.value` — the whole point of Skill's fractional-precision fix is
    // that sub-1 training/decline deltas must survive a save/load
    // round-trip instead of being discarded to the nearest integer on
    // every write. These columns are `doublePrecision`, not `integer`,
    // specifically for this (see the migration and Skill's own doc
    // comment).
    serve: technical.serve.raw,
    forehand: technical.forehand.raw,
    backhand: technical.backhand.raw,
    volley: technical.volley.raw,
    speed: physical.speed.raw,
    stamina: physical.stamina.raw,
    strength: physical.strength.raw,
    consistency: mental.consistency.raw,
    clutch: mental.clutch.raw,
    doubles: player.attributes.doubles.raw,
    affinityClay: surfaceAffinities.get('clay'),
    affinityGrass: surfaceAffinities.get('grass'),
    affinityHard: surfaceAffinities.get('hard'),
    affinityIndoor: surfaceAffinities.get('indoor'),
  };
}
