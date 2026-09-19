import { juniorEligibilityForAge, ManagerId, PlayerId, RankingBand } from '@tennis-manager/domain';
import {
  ManagerContactPort,
  NotificationDeliveryRepository,
  NotificationPort,
  NotificationPreferenceRepository,
} from '../ports/ports';
import { DigestPlayerData, ManagerDigestQuery } from '../queries/ManagerDigestQuery';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import {
  buildManagerDigest,
  DigestPlayerRank,
  FIRST_DIGEST_LOOKBACK_MS,
  renderDigestEmail,
  RESULTS_DIGEST_KIND,
} from './managerDigest';

export interface SendManagerDigestsCommand {
  /** The wall-clock instant this run covers up to — the digest cursor's
   * upper bound and the delivery row's `coveredUntil`. Passed in rather
   * than read from the clock so tests are deterministic. */
  now: Date;
  /** UTC date (YYYY-MM-DD) identifying this send window — the delivery
   * ledger's composite key component that makes a second same-day send
   * structurally impossible. */
  windowKey: string;
}

export interface SendManagerDigestsResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Notifications bounded context (STAGE 1) — the per-manager results
 * digest sender.
 *
 * For each manager with a roster:
 *   1. resume from their last SENT cursor (or a 24h lookback if none);
 *   2. load and assemble their digest;
 *   3. SKIP WITHOUT CLAIMING if there's nothing to report;
 *   4. resolve a contact address (null -> skip without claiming);
 *   5. skip if they've opted out;
 *   6. atomically claim this manager+kind+window (false -> skip);
 *   7. send; on success mark sent, on failure mark failed and log.
 *
 * Never throws out of the per-manager loop — one manager's bad data or
 * a transient transport failure must not stop the rest, the same
 * per-unit tolerance SimulateDueMatchesUseCase applies per match. A
 * failure leaves the cursor where it was (previousCoveredUntil only
 * reads SENT rows), so the next run re-covers the failed window.
 *
 * Deliberately NOT wired into the frozen day-tick worker handler in this
 * stage; it is invoked by whatever scheduler the notifications rollout
 * adds, so its only dependencies are the ports below.
 */
export class SendManagerDigestsUseCase {
  constructor(
    private readonly digestQuery: ManagerDigestQuery,
    private readonly deliveries: NotificationDeliveryRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly contacts: ManagerContactPort,
    private readonly notifications: NotificationPort,
    private readonly rankPositionByBand: Record<RankingBand, RankPositionQuery>,
    /** Optional structured log sink; defaults to a no-op so callers
     * don't have to supply one. */
    private readonly log: (message: string) => void = () => {},
  ) {}

  async execute(command: SendManagerDigestsCommand): Promise<SendManagerDigestsResult> {
    const result: SendManagerDigestsResult = { sent: 0, skipped: 0, failed: 0 };
    const managerIds = await this.digestQuery.listManagerIds();

    for (const managerId of managerIds) {
      try {
        await this.sendOne(managerId, command, result);
      } catch (error) {
        // Belt-and-braces: sendOne already handles its own send failure,
        // but a failure in the resume/load/rank path must not abort the
        // whole run either.
        this.log(`Manager digest failed for ${managerId}: ${error instanceof Error ? error.message : String(error)}`);
        result.failed += 1;
      }
    }

    return result;
  }

  private async sendOne(
    managerId: ManagerId,
    command: SendManagerDigestsCommand,
    result: SendManagerDigestsResult,
  ): Promise<void> {
    const previous = await this.deliveries.previousCoveredUntil(managerId, RESULTS_DIGEST_KIND);
    const since = previous ?? new Date(command.now.getTime() - FIRST_DIGEST_LOOKBACK_MS);

    const data = await this.digestQuery.load({ managerId, since, until: command.now });
    const digest = buildManagerDigest({
      managerId,
      since,
      until: command.now,
      players: data,
      ranks: await this.loadRanks(data),
    });
    if (!digest) {
      // Nothing to report — do NOT claim, so the cursor stays put and
      // the window is reconsidered next run.
      result.skipped += 1;
      return;
    }

    const email = await this.contacts.emailFor(managerId);
    if (email === null) {
      result.skipped += 1;
      return;
    }

    if (await this.preferences.isOptedOut(managerId)) {
      result.skipped += 1;
      return;
    }

    const claimed = await this.deliveries.tryClaim(managerId, RESULTS_DIGEST_KIND, command.windowKey, command.now);
    if (!claimed) {
      // Already claimed (a previous run or a concurrent one) — no send.
      result.skipped += 1;
      return;
    }

    try {
      const rendered = renderDigestEmail(digest);
      await this.notifications.sendEmail({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      await this.deliveries.markSent(managerId, RESULTS_DIGEST_KIND, command.windowKey);
      result.sent += 1;
    } catch (error) {
      await this.deliveries.markFailed(managerId, RESULTS_DIGEST_KIND, command.windowKey);
      this.log(`Manager digest send failed for ${managerId}: ${error instanceof Error ? error.message : String(error)}`);
      result.failed += 1;
    }
  }

  /** Each player's live standing from the SAME band-scoped
   * RankPositionQuery instances StartDueTournamentsUseCase uses, scoped
   * by `juniorEligibilityForAge(seasonAgeAnchorWeeks)` — never a stored
   * snapshot. */
  private async loadRanks(players: DigestPlayerData[]): Promise<Map<PlayerId, DigestPlayerRank>> {
    const ranks = new Map<PlayerId, DigestPlayerRank>();
    for (const player of players) {
      const band = juniorEligibilityForAge(player.seasonAgeAnchorWeeks);
      const standing = await this.rankPositionByBand[band].rankFor(player.playerId);
      ranks.set(player.playerId, { rank: standing.rank, totalPoints: standing.totalPoints });
    }
    return ranks;
  }
}
