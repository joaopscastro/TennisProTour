import { PlayerId, SeasonBonusPoolPolicy, SeasonStanding, WorldId } from '@tennis-manager/domain';
import { PlayerRepository, RankingLedgerRepository } from '../ports/ports';

export interface PaySeasonBonusPoolCommand {
  worldId: WorldId;
  /** The season whose SENIOR-TOUR SINGLES points standings the bonus
   * pool pays out on — the season that just concluded (see
   * AdvanceWorldWeekResult.concludedSeason), never the season about to
   * start. */
  season: number;
}

export interface PaySeasonBonusPoolResult {
  season: number;
  /** How many players had at least one senior-tour singles point this
   * season (the real eligible pool, before the top-10 cutoff). */
  playersConsidered: number;
  /** How many payouts were actually credited to a real, still-existing
   * player (min(playersConsidered, 10), minus any player who's since
   * been removed). */
  payoutsWritten: number;
  totalPaid: number;
}

/**
 * The season-end bonus pool, made live (see StandardSeasonBonusPoolPolicy's
 * doc comment for the full design and its disclosed simplifications
 * versus the real ATP rule it's based on, 2026 Circuit Regulations
 * §1.08.G/H). A SEPARATE use case, same "sibling weekly use case" shape
 * as ApplyObligatoryTournamentZerosUseCase/RefreshTalentPoolUseCase —
 * it needs a whole-ledger read AdvanceWorldWeekUseCase has no other
 * reason to hold, and it's a season-boundary event, not a per-tick
 * weekly one.
 *
 * **Run exactly once per SEASON rollover**, from the worker handler,
 * gated on `AdvanceWorldWeekResult.seasonRolledOver` (only true on the
 * tick where week WEEKS_PER_SEASON -> 1) — never on an ordinary weekly
 * rollover. Standings are drawn straight from the ranking ledger
 * (`RankingLedgerRepository.findAll()`, filtered to `ageBand: null`
 * singles entries dated to the concluded season), never from a
 * separately-tracked running total, so this can never drift from what
 * the ledger actually recorded.
 *
 * **Idempotency**: unlike ApplyObligatoryTournamentZerosUseCase, this
 * class does NOT defend itself against being invoked twice for the
 * same season — a second call would pay every eligible player again.
 * It relies entirely on the caller only ever invoking it from the
 * `seasonRolledOver` signal on a tick that has itself already passed
 * `GameWorld.advanceDay`'s tickKey idempotency check (a genuine retry
 * of the same tick returns `advanced: false` before `seasonRolledOver`
 * is ever computed as true, so the worker handler naturally never
 * double-fires this on a retry). A disclosed, deliberate scope
 * decision — the same trust-the-single-call-site shape most weekly
 * sibling use cases in this codebase already have.
 */
export class PaySeasonBonusPoolUseCase {
  constructor(
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly players: PlayerRepository,
    private readonly policy: SeasonBonusPoolPolicy,
  ) {}

  async execute(command: PaySeasonBonusPoolCommand): Promise<PaySeasonBonusPoolResult> {
    const allEntries = await this.rankingLedger.findAll();
    const totalsByPlayer = new Map<PlayerId, number>();
    for (const entry of allEntries) {
      if (entry.ageBand !== null) continue; // senior tour only
      if ((entry.discipline ?? 'singles') !== 'singles') continue;
      if (entry.weekEarned.season !== command.season) continue;
      totalsByPlayer.set(entry.playerId, (totalsByPlayer.get(entry.playerId) ?? 0) + entry.points);
    }

    const standings: SeasonStanding[] = [...totalsByPlayer.entries()].map(([playerId, points]) => ({ playerId, points }));
    const payouts = this.policy.computePayouts(standings);

    let payoutsWritten = 0;
    let totalPaid = 0;
    for (const payout of payouts) {
      const player = await this.players.findById(payout.playerId);
      if (!player) continue;
      player.creditPrizeMoney(payout.amount);
      await this.players.save(player);
      payoutsWritten += 1;
      totalPaid += payout.amount;
    }

    return {
      season: command.season,
      playersConsidered: standings.filter((s) => s.points > 0).length,
      payoutsWritten,
      totalPaid,
    };
  }
}
