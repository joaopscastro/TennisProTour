'use client';

import { TournamentDto } from '../lib/api';
import { formatMoney } from '../lib/format';

/**
 * Tournament rewards rendering — the entry decision used to be made
 * blind (surface/age band/tier/week/entrants only). The open-tournament
 * DTO has always carried `pointsBreakdown` and `prizeMoneyBreakdown`
 * (Champion-first, computed from the domain tables on the API side), so
 * this is purely surfacing data that already exists — no new query, no
 * new field, and the numbers can never drift from what the sim actually
 * awards because both read the same domain tables.
 *
 * Two shapes, deliberately:
 *  - `TournamentRewardSummary` — one scannable line per candidate, for
 *    the entry picker's list and the narrow planner columns.
 *  - `TournamentRewardsLadder` — the full compact ladder, for the
 *    selected tournament so a manager can see every stage, not just the
 *    two endpoints.
 *
 * The zero-points note is a real rule, not a UI quirk: a first-round
 * loss earns 0 ranking points at every tier (the same "a ranking is
 * earned by winning" copy the tournament detail page shows), so it is
 * stated plainly wherever the ladder is shown.
 */

/** One line: the champion's reward and the first-round reward, the two
 *  ends of the ladder a manager is really weighing. Falls back to
 *  nothing rather than a broken line if a breakdown is somehow empty. */
export function TournamentRewardSummary({ tournament }: { tournament: TournamentDto }) {
  const champion = tournament.pointsBreakdown[0];
  const firstRound = tournament.pointsBreakdown[tournament.pointsBreakdown.length - 1];
  if (!champion || !firstRound) return null;
  const championPrize = tournament.prizeMoneyBreakdown[0]?.prizeMoney ?? 0;
  const firstRoundPrize = tournament.prizeMoneyBreakdown[tournament.prizeMoneyBreakdown.length - 1]?.prizeMoney ?? 0;
  return (
    <div className="text-[10.5px] mt-[5px] leading-[1.5]" style={{ color: 'var(--gc-ink-mute)' }}>
      <span style={{ color: 'var(--gc-gold)', fontWeight: 700 }}>★ Champion</span>{' '}
      {champion.points > 0 ? `${champion.points.toLocaleString()} pts` : 'no points'}
      {championPrize > 0 ? ` · ${formatMoney(championPrize)}` : ''}
      {' — '}
      <span style={{ color: 'var(--gc-ink-faint)' }}>
        first round: {firstRound.points > 0 ? `${firstRound.points.toLocaleString()} pts` : 'no pts'}
        {firstRoundPrize > 0 ? `, ${formatMoney(firstRoundPrize)}` : ''}
      </span>
    </div>
  );
}

/** The full, compact ladder — stage, ranking points, prize money, from
 *  Champion down to a first-round loss. Read straight off the DTO's two
 *  breakdown arrays, joined by `matchesWon`. */
export function TournamentRewardsLadder({ tournament }: { tournament: TournamentDto }) {
  if (tournament.pointsBreakdown.length === 0 && tournament.prizeMoneyBreakdown.length === 0) return null;
  const prizeByMatches = new Map(tournament.prizeMoneyBreakdown.map((r) => [r.matchesWon, r.prizeMoney]));
  const junior = tournament.circuit === 'junior';
  return (
    <div>
      <div className="flex items-center justify-between text-[9.5px] font-bold tracking-[0.5px] uppercase px-[2px] mb-[4px]" style={{ color: 'var(--gc-ink-faint)' }}>
        <span>Result</span>
        <span className="flex gap-[14px]">
          <span style={{ width: 58, textAlign: 'right' }}>Points</span>
          <span style={{ width: 58, textAlign: 'right' }}>Prize</span>
        </span>
      </div>
      <div className="rounded-[7px] overflow-hidden" style={{ border: '1px solid var(--gc-line)' }}>
        {tournament.pointsBreakdown.map((row, i) => {
          const isChampion = row.stageLabel === 'Champion';
          const prize = prizeByMatches.get(row.matchesWon) ?? 0;
          const zeroPoints = row.points === 0;
          return (
            <div
              key={row.matchesWon}
              className="flex items-center justify-between px-[10px] py-[5px]"
              style={{
                borderBottom: i < tournament.pointsBreakdown.length - 1 ? '1px solid var(--gc-line)' : undefined,
                background: isChampion ? 'linear-gradient(90deg, oklch(92% 0.09 85 / 0.4), transparent)' : undefined,
              }}
            >
              <span className="text-[11.5px]" style={{ fontWeight: isChampion ? 800 : 550, color: zeroPoints ? 'var(--gc-ink-faint)' : 'var(--gc-ink)' }}>
                {isChampion ? '★ ' : ''}{row.stageLabel}
              </span>
              <span className="flex gap-[14px] text-[11.5px] [font-variant-numeric:tabular-nums]">
                <span style={{ width: 58, textAlign: 'right', fontWeight: 700, color: zeroPoints ? 'var(--gc-ink-faint)' : 'var(--gc-ink-dim)' }}>
                  {zeroPoints ? 'no pts' : `${row.points.toLocaleString()} pts`}
                </span>
                <span style={{ width: 58, textAlign: 'right', fontWeight: 700, color: prize > 0 ? 'var(--gc-ink-dim)' : 'var(--gc-ink-faint)' }}>
                  {prize > 0 ? formatMoney(prize) : junior ? '—' : formatMoney(0)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-[10.5px] mt-[6px] leading-[1.5]" style={{ color: 'var(--gc-ink-mute)' }}>
        A first-round loss earns no ranking points — a ranking is earned by winning.
        {junior
          ? ' Junior events are an amateur circuit and pay no cash prize money.'
          : ' Prize money, unlike points, is paid for any match played.'}
      </div>
    </div>
  );
}
