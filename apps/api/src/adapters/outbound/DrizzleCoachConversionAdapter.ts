import { and, eq, gte, ne, or, sql } from 'drizzle-orm';
import { Coach, CoachId, ManagerId, PlayerId } from '@tennis-manager/domain';
import { CoachConversionOutcome, CoachConversionPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { coaches, doublesPairs, managerProgression, players } from '../../db/schema';

/** Thrown only to trigger Postgres transaction rollback from inside the
 * db.transaction() callback below — never escapes convertAndCharge()
 * itself, which catches it and converts it back into a typed
 * CoachConversionOutcome. A manager short on XP or a player no longer
 * owned are ordinary outcomes, not exceptional ones. */
class ConversionRollback extends Error {
  constructor(readonly outcome: CoachConversionOutcome) {
    super('conversion rollback');
  }
}

/**
 * See CoachConversionPort's doc comment for why this needs to exist:
 * converting a rostered player into a coach spans four tables
 * (manager_progression XP debit, players ownership release,
 * doubles_pairs cascade dissolve, coaches insert), which must all commit
 * or all roll back together. Before this, ConvertPlayerToCoachUseCase
 * performed those four writes as separate application-layer calls, so a
 * mid-sequence failure could leave XP spent with no coach created (or a
 * coach with the player still rostered).
 *
 * Order mirrors DrizzleTalentClaimAdapter: debit XP FIRST (cheapest
 * failure to detect, never touch the roster for a manager who can't
 * afford it), then the conditional player release, then the pair
 * cascade, then the coach insert. Any failure throws ConversionRollback
 * so Postgres rolls the whole thing back.
 *
 * The player release is a narrow, conditional
 * `UPDATE players SET manager_id = NULL WHERE id = :id AND manager_id = :mid`
 * (only the ownership column changes — Player.releaseFromManager() alters
 * nothing else), which also makes two near-simultaneous conversions of
 * the same player safe: exactly one UPDATE affects a row.
 */
export class DrizzleCoachConversionAdapter implements CoachConversionPort {
  constructor(private readonly db: Db) {}

  async convertAndCharge(input: {
    playerId: PlayerId;
    managerId: ManagerId;
    coachId: CoachId;
    xpCost: number;
    coachRating: number;
    sourcePlayerName: string;
  }): Promise<CoachConversionOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const spendRows = await tx
          .update(managerProgression)
          .set({ xpBalance: sql`${managerProgression.xpBalance} - ${input.xpCost}`, updatedAt: new Date() })
          .where(and(eq(managerProgression.managerId, input.managerId), gte(managerProgression.xpBalance, input.xpCost)))
          .returning();

        if (spendRows.length === 0) {
          const balanceRows = await tx
            .select({ xpBalance: managerProgression.xpBalance })
            .from(managerProgression)
            .where(eq(managerProgression.managerId, input.managerId))
            .limit(1);
          const balance = balanceRows.length > 0 ? balanceRows[0].xpBalance : 0;
          throw new ConversionRollback({ kind: 'insufficient-xp', required: input.xpCost, balance });
        }

        const releaseRows = await tx
          .update(players)
          .set({ managerId: null, updatedAt: new Date() })
          .where(and(eq(players.id, input.playerId), eq(players.managerId, input.managerId)))
          .returning();

        if (releaseRows.length === 0) {
          throw new ConversionRollback({ kind: 'player-unavailable' });
        }

        await tx
          .update(doublesPairs)
          .set({ status: 'dissolved', updatedAt: new Date() })
          .where(
            and(
              ne(doublesPairs.status, 'dissolved'),
              or(eq(doublesPairs.playerA, input.playerId), eq(doublesPairs.playerB, input.playerId)),
            ),
          );

        await tx.insert(coaches).values({
          id: input.coachId,
          managerId: input.managerId,
          coachRating: input.coachRating,
          sourcePlayerId: input.playerId,
          sourcePlayerName: input.sourcePlayerName,
        });

        return {
          kind: 'converted',
          xpSpent: input.xpCost,
          coach: Coach.reconstitute({
            id: CoachId(input.coachId),
            managerId: ManagerId(input.managerId),
            coachRating: input.coachRating,
            sourcePlayerId: PlayerId(input.playerId),
            sourcePlayerName: input.sourcePlayerName,
          }),
        };
      });
    } catch (error) {
      if (error instanceof ConversionRollback) return error.outcome;
      throw error;
    }
  }
}
