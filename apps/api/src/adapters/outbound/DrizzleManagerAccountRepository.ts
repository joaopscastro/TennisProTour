import { eq } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managers } from '../../db/schema';

export class DrizzleManagerAccountRepository implements ManagerAccountRepository {
  constructor(private readonly db: Db) {}

  async findByAuthSubject(authSubject: string): Promise<ManagerAccount | null> {
    const rows = await this.db.select().from(managers).where(eq(managers.authSubject, authSubject)).limit(1);
    return rows.length === 0 ? null : toAccount(rows[0]);
  }

  async save(account: ManagerAccount): Promise<void> {
    await this.db
      .insert(managers)
      .values({
        id: account.id,
        authSubject: account.authSubject,
        displayName: account.displayName,
        publicHandle: account.publicHandle,
        status: account.status,
      })
      .onConflictDoUpdate({
        target: managers.id,
        set: {
          authSubject: account.authSubject,
          displayName: account.displayName,
          publicHandle: account.publicHandle,
          status: account.status,
          updatedAt: new Date(),
        },
      });
  }
}

function toAccount(row: typeof managers.$inferSelect): ManagerAccount {
  return {
    id: ManagerId(row.id),
    authSubject: row.authSubject,
    displayName: row.displayName,
    publicHandle: row.publicHandle,
    status: row.status,
  };
}
