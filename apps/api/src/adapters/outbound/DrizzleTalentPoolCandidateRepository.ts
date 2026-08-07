import { and, eq } from 'drizzle-orm';
import { ManagerId, PlayerAttributes, PlayerRarityTier, PotentialTier, Skill, SurfaceAffinities, TalentPoolCandidate, TalentPoolCandidateId } from '@tennis-manager/domain';
import { TalentPoolCandidateRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { talentPoolCandidates } from '../../db/schema';

type TalentPoolCandidateRow = typeof talentPoolCandidates.$inferSelect;

/**
 * Drizzle-backed TalentPoolCandidateRepository. Everything is a plain
 * find/save except claimIfAvailable(), which is deliberately NOT
 * built from this class's own findById()/save() — composing a claim
 * from a separate read and a separate write would reopen exactly the
 * race the port's doc comment warns about (two managers both reading
 * "available," both then writing "claimed"). Instead it's a single
 * conditional UPDATE whose WHERE clause re-checks availability as
 * part of the same atomic statement: Postgres guarantees only one
 * concurrent transaction can match that row and get it back from
 * .returning() — the loser's UPDATE simply matches zero rows.
 */
export class DrizzleTalentPoolCandidateRepository implements TalentPoolCandidateRepository {
  constructor(private readonly db: Db) {}

  async findById(id: TalentPoolCandidateId): Promise<TalentPoolCandidate | null> {
    const rows = await this.db.select().from(talentPoolCandidates).where(eq(talentPoolCandidates.id, id)).limit(1);
    return rows.length > 0 ? toDomain(rows[0]) : null;
  }

  async findAvailable(): Promise<TalentPoolCandidate[]> {
    const rows = await this.db.select().from(talentPoolCandidates).where(eq(talentPoolCandidates.status, 'available'));
    return rows.map(toDomain);
  }

  async save(candidate: TalentPoolCandidate): Promise<void> {
    const row = toRow(candidate);
    await this.db
      .insert(talentPoolCandidates)
      .values(row)
      .onConflictDoUpdate({ target: talentPoolCandidates.id, set: { ...row, updatedAt: new Date() } });
  }

  async claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null> {
    const rows = await this.db
      .update(talentPoolCandidates)
      .set({ status: 'claimed', claimedByManagerId: managerId, updatedAt: new Date() })
      .where(and(eq(talentPoolCandidates.id, id), eq(talentPoolCandidates.status, 'available')))
      .returning();
    return rows.length > 0 ? toDomain(rows[0]) : null;
  }
}

/** Exported for DrizzleTalentClaimAdapter, which needs to map a row
 * back to the domain type from inside its own transaction — reusing
 * this mapping rather than duplicating it, since a claimed candidate's
 * row shape is identical either way. */
export function toDomain(row: TalentPoolCandidateRow): TalentPoolCandidate {
  return TalentPoolCandidate.reconstitute({
    id: TalentPoolCandidateId(row.id),
    name: row.name,
    nationality: row.nationality,
    tier: row.tier as PlayerRarityTier,
    ageInWeeks: row.ageInWeeks,
    potentialCeiling: row.potentialCeiling,
    potentialTier: row.potentialTier as PotentialTier,
    generatedAtWeek: { season: row.seasonGenerated, week: row.weekGenerated },
    status: row.status,
    claimedByManagerId: row.claimedByManagerId === null ? null : ManagerId(row.claimedByManagerId),
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

function toRow(candidate: TalentPoolCandidate): typeof talentPoolCandidates.$inferInsert {
  const { technical, physical, mental, surfaceAffinities } = candidate.attributes;
  return {
    id: candidate.id,
    name: candidate.name,
    nationality: candidate.nationality,
    tier: candidate.tier,
    ageInWeeks: candidate.ageInWeeks,
    potentialCeiling: candidate.potentialCeiling,
    potentialTier: candidate.potentialTier,
    seasonGenerated: candidate.generatedAtWeek.season,
    weekGenerated: candidate.generatedAtWeek.week,
    status: candidate.status,
    claimedByManagerId: candidate.claimedByManagerId,
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
