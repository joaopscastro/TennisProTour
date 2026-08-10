import { compareGameWeek, GameWeek, PlayerId } from '../shared/ids';
import { TrainingFocus } from './TrainingPolicy';

/**
 * One explicit, manager-set training-focus assignment, effective from
 * a specific GameWeek onward — the unit the per-player training
 * schedule is built from (see resolveTrainingFocusForWeek below).
 * Replaces the old single mutable `Player.currentFocus` field: instead
 * of one field a manager overwrites in place, a manager now accumulates
 * a small append/overwrite ledger of "starting week W, train X" orders,
 * and the effective focus for any given week is *resolved* from that
 * ledger rather than read off a live field. `focus: null` is a real,
 * meaningful entry ("explicitly stop training from this week on"), not
 * "no entry yet" — the absence of ANY entry with effectiveFrom <= a
 * week is what "no entry yet" actually looks like to
 * resolveTrainingFocusForWeek.
 *
 * Same "carries playerId even though a repository read is already
 * scoped to one player" convention as RankingLedgerEntry/PeakRankingEntry
 * — needed so a caller building an entry to save() knows which
 * player's row it's writing.
 */
export interface TrainingScheduleEntry {
  readonly playerId: PlayerId;
  readonly effectiveFrom: GameWeek;
  readonly focus: TrainingFocus | null;
}

/**
 * Resolves the standing training focus for one specific week from a
 * player's full set of explicit schedule entries: the entry with the
 * LATEST effectiveFrom that is still <= the target week — i.e. "the
 * most recent order that had already been given by this week." An
 * entry whose effectiveFrom is AFTER the target week is future
 * relative to that week and never affects it, which is the whole
 * mechanism behind three properties this function is built to
 * guarantee (see TrainingSchedule.test.ts for the exact cases):
 *
 *  - Setting an entry for week 5 changes nothing about weeks 1-4:
 *    those weeks' resolution only ever considers entries with
 *    effectiveFrom <= that week, and week 5's entry has
 *    effectiveFrom = 5, so it's excluded from weeks 1-4's candidate
 *    set entirely.
 *  - A week with no entry OF ITS OWN still resolves correctly to the
 *    most recent EARLIER entry ("set and forget" standing order) —
 *    there is no requirement that a week have its own explicit row.
 *  - Resolving what applied at week N is a pure function of entries
 *    with effectiveFrom <= N. Adding a NEW entry later (effectiveFrom
 *    > N, by construction — see SetTrainingScheduleUseCase's
 *    past-week guard, which never lets an entry be inserted for
 *    anything before the world's current week) can never change what
 *    week N already resolved to. "Changing the standing order today"
 *    is always a future-effective entry relative to any week that has
 *    already elapsed, so it can only ever affect resolution for that
 *    week and weeks after it, never before.
 *
 * Returns null when no entry has effectiveFrom <= the target week at
 * all — the real "no standing order has ever been given yet" case,
 * distinct from an explicit `focus: null` entry (which IS an order,
 * just one that means "train nothing").
 */
export function resolveTrainingFocusForWeek(entries: readonly TrainingScheduleEntry[], week: GameWeek): TrainingFocus | null {
  let latest: TrainingScheduleEntry | null = null;
  for (const entry of entries) {
    if (compareGameWeek(entry.effectiveFrom, week) > 0) continue; // entry starts after this week — not applicable yet
    if (latest === null || compareGameWeek(entry.effectiveFrom, latest.effectiveFrom) > 0) {
      latest = entry;
    }
  }
  return latest ? latest.focus : null;
}
