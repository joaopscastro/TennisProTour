import { describe, expect, it } from 'vitest';
import { GameWorld, ManagerId, PlayerId, RankingBand, RankingLedgerEntry, WorldId } from '@tennis-manager/domain';
import {
  GameWorldRepository,
  ManagerContactPort,
  NotificationDeliveryRepository,
  NotificationPort,
  NotificationPreferenceRepository,
  OutboundEmail,
  RankingLedgerRepository,
} from '../ports/ports';
import { DigestPlayerData, DigestResult, ManagerDigestQuery } from '../queries/ManagerDigestQuery';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { FIRST_DIGEST_LOOKBACK_MS, RESULTS_DIGEST_KIND } from './managerDigest';
import { SendManagerDigestsUseCase } from './SendManagerDigestsUseCase';

const playerId = PlayerId('p1');
const worldId = WorldId('main');

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();
  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }
  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

class InMemoryRankingLedgerRepository implements RankingLedgerRepository {
  private readonly entries: RankingLedgerEntry[] = [];
  async append(entry: RankingLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }
  async findByPlayer(id: PlayerId): Promise<RankingLedgerEntry[]> {
    return this.entries.filter((entry) => entry.playerId === id);
  }
  async findAll(): Promise<RankingLedgerEntry[]> {
    return [...this.entries];
  }
}

class InMemoryDeliveryRepository implements NotificationDeliveryRepository {
  private readonly rows = new Map<string, { coveredUntil: Date; status: 'sending' | 'sent' | 'failed' }>();
  claims = 0;

  private key(managerId: ManagerId, kind: string, windowKey: string): string {
    return `${managerId}|${kind}|${windowKey}`;
  }

  async tryClaim(managerId: ManagerId, kind: string, windowKey: string, coveredUntil: Date): Promise<boolean> {
    const key = this.key(managerId, kind, windowKey);
    if (this.rows.has(key)) return false;
    this.rows.set(key, { coveredUntil, status: 'sending' });
    this.claims += 1;
    return true;
  }

  async previousCoveredUntil(managerId: ManagerId, kind: string): Promise<Date | null> {
    let best: Date | null = null;
    for (const [key, row] of this.rows) {
      if (!key.startsWith(`${managerId}|${kind}|`)) continue;
      if (row.status !== 'sent') continue;
      if (best === null || row.coveredUntil.getTime() > best.getTime()) best = row.coveredUntil;
    }
    return best;
  }

  async markSent(managerId: ManagerId, kind: string, windowKey: string): Promise<void> {
    const row = this.rows.get(this.key(managerId, kind, windowKey));
    if (row) row.status = 'sent';
  }

  async markFailed(managerId: ManagerId, kind: string, windowKey: string): Promise<void> {
    const row = this.rows.get(this.key(managerId, kind, windowKey));
    if (row) row.status = 'failed';
  }

  statusFor(managerId: ManagerId, kind: string, windowKey: string): string | null {
    return this.rows.get(this.key(managerId, kind, windowKey))?.status ?? null;
  }
}

class InMemoryPreferenceRepository implements NotificationPreferenceRepository {
  private readonly optedOut = new Set<string>();
  async isOptedOut(managerId: ManagerId): Promise<boolean> {
    return this.optedOut.has(managerId);
  }
  async setOptOut(managerId: ManagerId, optOut: boolean): Promise<void> {
    if (optOut) this.optedOut.add(managerId);
    else this.optedOut.delete(managerId);
  }
}

class InMemoryContactPort implements ManagerContactPort {
  readonly emails = new Map<string, string | null>();
  async emailFor(managerId: ManagerId): Promise<string | null> {
    return this.emails.has(managerId) ? this.emails.get(managerId)! : null;
  }
}

class RecordingNotificationPort implements NotificationPort {
  readonly sent: OutboundEmail[] = [];
  fail = false;
  async sendEmail(message: OutboundEmail): Promise<void> {
    if (this.fail) throw new Error('transport down');
    this.sent.push(message);
  }
}

class InMemoryManagerDigestQuery implements ManagerDigestQuery {
  managers: ManagerId[] = [];
  readonly dataByManager = new Map<string, DigestPlayerData[]>();
  readonly loadedSince: Date[] = [];

  async listManagerIds(): Promise<ManagerId[]> {
    return this.managers;
  }

  async load(input: { managerId: ManagerId; since: Date; until: Date }): Promise<DigestPlayerData[]> {
    this.loadedSince.push(input.since);
    return this.dataByManager.get(input.managerId) ?? [];
  }
}

function digestResult(airedAt: Date): DigestResult {
  return {
    matchId: `m-${airedAt.getTime()}`,
    tournamentId: 't1',
    tournamentName: 'Riga Open',
    tier: 'tour',
    ageBand: null,
    roundNumber: 3,
    drawSize: 16,
    opponentName: 'Bob Opponent',
    won: true,
    setScores: [{ winnerGames: 6, loserGames: 4 }],
    airedAt,
  };
}

function playerData(results: DigestResult[]): DigestPlayerData {
  return {
    playerId,
    name: 'Alice Player',
    seasonAgeAnchorWeeks: 20 * 52,
    results,
    titles: [],
    next: null,
  };
}

function makeRanks(): Record<RankingBand, RankPositionQuery> {
  const worlds = new InMemoryGameWorldRepository();
  const ledger = new InMemoryRankingLedgerRepository();
  // `worlds.findById` is async but RankPositionQuery falls back to week 1
  // when the world is absent, so an unsaved world is fine here.
  return {
    senior: new RankPositionQuery(ledger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(ledger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(ledger, worlds, worldId, 'u16'),
    u18: new RankPositionQuery(ledger, worlds, worldId, 'u18'),
  };
}

function setup(managerId = ManagerId('m1')) {
  const query = new InMemoryManagerDigestQuery();
  const deliveries = new InMemoryDeliveryRepository();
  const preferences = new InMemoryPreferenceRepository();
  const contacts = new InMemoryContactPort();
  const notifications = new RecordingNotificationPort();
  query.managers = [managerId];
  contacts.emails.set(managerId, 'alice@example.com');
  const useCase = new SendManagerDigestsUseCase(query, deliveries, preferences, contacts, notifications, makeRanks());
  return { managerId, query, deliveries, preferences, contacts, notifications, useCase };
}

const NOW = new Date('2026-01-15T12:00:00.000Z');

describe('SendManagerDigestsUseCase', () => {
  it('sends a digest once for a manager with news', async () => {
    const { managerId, query, deliveries, notifications, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(notifications.sent).toHaveLength(1);
    expect(notifications.sent[0].to).toBe('alice@example.com');
    expect(notifications.sent[0].subject).toContain('results digest');
    expect(deliveries.statusFor(managerId, RESULTS_DIGEST_KIND, '2026-01-15')).toBe('sent');
  });

  it('does not send twice in the same window', async () => {
    const { managerId, query, deliveries, notifications, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);

    await useCase.execute({ now: NOW, windowKey: '2026-01-15' });
    const second = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(second).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(notifications.sent).toHaveLength(1);
    expect(deliveries.claims).toBe(1);
  });

  it('skips an opted-out manager without claiming', async () => {
    const { managerId, query, deliveries, notifications, preferences, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);
    await preferences.setOptOut(managerId, true);

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(notifications.sent).toHaveLength(0);
    expect(deliveries.claims).toBe(0);
  });

  it('skips a manager with no email without claiming', async () => {
    const { managerId, query, deliveries, notifications, contacts, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);
    contacts.emails.set(managerId, null);

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(notifications.sent).toHaveLength(0);
    expect(deliveries.claims).toBe(0);
  });

  it('marks a failed send failed and leaves the cursor unchanged', async () => {
    const { managerId, query, deliveries, notifications, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);
    notifications.fail = true;

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(deliveries.statusFor(managerId, RESULTS_DIGEST_KIND, '2026-01-15')).toBe('failed');
    expect(await deliveries.previousCoveredUntil(managerId, RESULTS_DIGEST_KIND)).toBeNull();
  });

  it('skips an empty digest without claiming and without advancing the cursor', async () => {
    const { managerId, query, deliveries, notifications, useCase } = setup();
    // Roster present but nothing to report.
    query.dataByManager.set(managerId, [playerData([])]);

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(deliveries.claims).toBe(0);
    expect(notifications.sent).toHaveLength(0);
    expect(await deliveries.previousCoveredUntil(managerId, RESULTS_DIGEST_KIND)).toBeNull();
  });

  it('uses a 24h lookback for a manager who has never received a digest', async () => {
    const { managerId, query, useCase } = setup();
    query.dataByManager.set(managerId, [playerData([digestResult(NOW)])]);

    await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(query.loadedSince[0].getTime()).toBe(NOW.getTime() - FIRST_DIGEST_LOOKBACK_MS);
  });

  it('covers a multi-day gap once, resuming from the last sent cursor', async () => {
    const { managerId, query, notifications, useCase } = setup();
    const day1 = new Date('2026-01-15T12:00:00.000Z');
    const day3 = new Date('2026-01-17T12:00:00.000Z');
    const day2Result = new Date('2026-01-16T12:00:00.000Z');
    query.dataByManager.set(managerId, [playerData([digestResult(day1), digestResult(day2Result)])]);

    await useCase.execute({ now: day1, windowKey: '2026-01-15' });
    const second = await useCase.execute({ now: day3, windowKey: '2026-01-17' });

    expect(notifications.sent).toHaveLength(2);
    expect(second.sent).toBe(1);
    // The second run resumed from day1's sent cursor, NOT a fresh 24h lookback.
    expect(query.loadedSince[1].getTime()).toBe(day1.getTime());
    // The day-2 result (inside the gap) is what the second digest covers.
    expect(notifications.sent[1].text).toContain('Riga Open');
  });

  it('continues past a manager whose load throws', async () => {
    const { query, useCase } = setup();
    const goodManager = ManagerId('m2');
    query.managers = [ManagerId('broken'), goodManager];
    query.load = async (input) => {
      if (input.managerId === 'broken') throw new Error('db hiccup');
      return [];
    };

    const result = await useCase.execute({ now: NOW, windowKey: '2026-01-15' });

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
  });
});
