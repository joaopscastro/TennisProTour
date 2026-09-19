import { and, desc, eq } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { NotificationDeliveryRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { notificationDeliveries } from '../../db/schema';

/**
 * Drizzle-backed NotificationDeliveryRepository (Notifications STAGE 1).
 *
 * `tryClaim` mirrors DrizzlePracticeSessionRepository.tryRecord exactly:
 * the composite (manager_id, kind, window_key) primary key is the "at
 * most one send per manager per window" guard, and
 * `.onConflictDoNothing().returning()` yields a row ONLY when this
 * statement actually inserted it — so two concurrent runs can't both get
 * `true` from a read-then-write.
 *
 * `previousCoveredUntil` reads the most recent SENT row's `covered_until`
 * (not failed/sending), which is the deliberately non-advancing failure
 * behavior the digest cursor depends on: a failed send must re-cover its
 * window next run.
 */
export class DrizzleNotificationDeliveryRepository implements NotificationDeliveryRepository {
  constructor(private readonly db: Db) {}

  async tryClaim(managerId: ManagerId, kind: string, windowKey: string, coveredUntil: Date): Promise<boolean> {
    const rows = await this.db
      .insert(notificationDeliveries)
      .values({ managerId, kind, windowKey, coveredUntil, status: 'sending' })
      .onConflictDoNothing()
      .returning({ managerId: notificationDeliveries.managerId });
    return rows.length > 0;
  }

  async previousCoveredUntil(managerId: ManagerId, kind: string): Promise<Date | null> {
    const rows = await this.db
      .select({ coveredUntil: notificationDeliveries.coveredUntil })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.managerId, managerId),
          eq(notificationDeliveries.kind, kind),
          eq(notificationDeliveries.status, 'sent'),
        ),
      )
      .orderBy(desc(notificationDeliveries.coveredUntil))
      .limit(1);
    return rows[0]?.coveredUntil ?? null;
  }

  async markSent(managerId: ManagerId, kind: string, windowKey: string): Promise<void> {
    await this.db
      .update(notificationDeliveries)
      .set({ status: 'sent', sentAt: new Date() })
      .where(
        and(
          eq(notificationDeliveries.managerId, managerId),
          eq(notificationDeliveries.kind, kind),
          eq(notificationDeliveries.windowKey, windowKey),
        ),
      );
  }

  async markFailed(managerId: ManagerId, kind: string, windowKey: string): Promise<void> {
    await this.db
      .update(notificationDeliveries)
      .set({ status: 'failed' })
      .where(
        and(
          eq(notificationDeliveries.managerId, managerId),
          eq(notificationDeliveries.kind, kind),
          eq(notificationDeliveries.windowKey, windowKey),
        ),
      );
  }
}
