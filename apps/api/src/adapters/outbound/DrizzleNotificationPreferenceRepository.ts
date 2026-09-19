import { eq } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { NotificationPreferenceRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerNotificationStates } from '../../db/schema';

/**
 * Drizzle-backed NotificationPreferenceRepository (Notifications
 * STAGE 1). The default is ON: absence of a row means opted in, so
 * `isOptedOut` returns false for a manager who has never touched the
 * setting. `setOptOut` upserts the one row per manager.
 */
export class DrizzleNotificationPreferenceRepository implements NotificationPreferenceRepository {
  constructor(private readonly db: Db) {}

  async isOptedOut(managerId: ManagerId): Promise<boolean> {
    const rows = await this.db
      .select({ digestOptOut: managerNotificationStates.digestOptOut })
      .from(managerNotificationStates)
      .where(eq(managerNotificationStates.managerId, managerId))
      .limit(1);
    return rows[0]?.digestOptOut ?? false;
  }

  async setOptOut(managerId: ManagerId, optOut: boolean): Promise<void> {
    await this.db
      .insert(managerNotificationStates)
      .values({ managerId, digestOptOut: optOut, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: managerNotificationStates.managerId,
        set: { digestOptOut: optOut, updatedAt: new Date() },
      });
  }
}
