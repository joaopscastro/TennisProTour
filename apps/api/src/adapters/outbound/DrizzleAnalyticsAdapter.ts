import { AnalyticsEvent, AnalyticsPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { analyticsEvents } from '../../db/schema';

/**
 * Minimal product analytics writer: one append-only insert per event.
 *
 * Deliberately swallows any error. Analytics is best-effort telemetry that
 * must NEVER break the request that produced it — a manager signing a
 * player, entering a tournament, or opening the app has to succeed even if
 * the analytics table is missing, the DB is briefly unavailable, or a
 * dedupe-key race fires. Callers fire-and-forget `record()`, so this is
 * also the one place that guarantee can be enforced without scattering
 * try/catch across every route.
 *
 * `dedupeKey` uses a single-statement `ON CONFLICT DO NOTHING` so an
 * exactly-once-per-period event (app_open per manager per day) is atomic
 * under concurrent requests rather than a read-then-write. A plain insert
 * omits the key; Postgres treats NULLs as distinct, so an unset key never
 * blocks a row. `target` is the unique column, not the constraint name, so
 * this keeps working if the constraint is ever regenerated.
 */
export class DrizzleAnalyticsAdapter implements AnalyticsPort {
  constructor(private readonly db: Db) {}

  async record(event: AnalyticsEvent): Promise<void> {
    try {
      await this.db
        .insert(analyticsEvents)
        .values({
          managerId: event.managerId ?? null,
          name: event.name,
          dedupeKey: event.dedupeKey ?? null,
          props: event.props ?? {},
        })
        .onConflictDoNothing({ target: analyticsEvents.dedupeKey });
    } catch {
      // Intentionally silent — see the class doc comment. A failed analytics
      // write is not an application error.
    }
  }
}
