'use client';

import { useEffect, useState } from 'react';
import { TournamentDto, fetchOpenTournaments, registerEntrant } from '../lib/api';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

interface Props {
  playerId: string;
  playerName: string;
  /** The player's actual owning manager — required so the register
   * call authenticates as the right manager (see registerEntrant's
   * doc comment); omitting this silently falls back to the dev-mode
   * default manager, which only coincidentally works when that
   * happens to be who's logged in. */
  managerId: string;
  onClose: () => void;
  onEntered: (tournament: TournamentDto) => void;
}

/**
 * Real tournament picker for the roster row's "Enter" action —
 * replaces the earlier "register into whichever open tournament has
 * room first" shortcut. Lists every tournament actually open for
 * registration (GET /tournaments?status=open) and lets the manager
 * choose, since silently picking one on the player's behalf is a
 * meaningful decision (surface, tier, field size) a manager should
 * make deliberately.
 */
export function EnterTournamentModal({ playerId, playerName, managerId, onClose, onEntered }: Props) {
  const [tournaments, setTournaments] = useState<TournamentDto[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchOpenTournaments(playerId)
      .then((all) => setTournaments(all.filter((t) => t.entrants.length < t.drawSize && !t.entrants.some((e) => e.playerId === playerId))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

  async function handleConfirm() {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const tournament = await registerEntrant(selectedId, playerId, managerId);
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  /** True once this player has already entered weeklyEntryCapThisWeek
   * same-band tournaments in a given tournament's specific week — the
   * real cap RegisterEntrantUseCase enforces (junior 3/week, senior
   * 1/week; see juniorEntryCap.ts), surfaced here so the row is
   * disabled up front rather than only failing after a click. */
  function overCapFor(t: TournamentDto): boolean {
    return (
      t.weeklyEntryCountThisWeek !== undefined &&
      t.weeklyEntryCapThisWeek !== undefined &&
      t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek
    );
  }

  /** True when this player's current age is too old for this junior
   * band — playing UP into an older junior band is fine (ageEligible
   * stays true then), only playing down or a senior entering a junior
   * draw sets this. Senior tournaments never carry `ageEligible` at
   * all (undefined), so they're never blocked by this. */
  function ageIneligibleFor(t: TournamentDto): boolean {
    return t.ageEligible === false;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(6,10,8,0.66)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] gc-card rounded-[14px] p-6 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-bold" style={{ color: 'var(--gc-ink)' }}>
          Enter {playerName} into a tournament
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'var(--gc-ink-mute)' }}>
          Choose a tournament still open for registration.
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 overflow-y-auto" style={{ minHeight: 60 }}>
          {tournaments === null && !error && (
            <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
              Loading open tournaments…
            </div>
          )}
          {tournaments?.length === 0 && (
            <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
              No tournaments are open for entries right now.
            </div>
          )}
          {tournaments?.map((t) => {
            const selected = selectedId === t.id;
            const overCap = overCapFor(t);
            const ageIneligible = ageIneligibleFor(t);
            const blocked = overCap || ageIneligible;
            return (
              <button
                key={t.id}
                onClick={() => !blocked && setSelectedId(t.id)}
                disabled={blocked}
                className="text-left rounded-[8px] px-[14px] py-[10px] cursor-pointer disabled:cursor-not-allowed"
                style={{
                  border: selected ? '1.5px solid var(--gc-ball)' : '1px solid var(--gc-line)',
                  background: selected ? 'var(--gc-s3)' : 'var(--gc-s2)',
                  opacity: blocked ? 0.55 : 1,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[2px] rounded-[4px] text-white flex-none"
                      style={{ background: SURFACE_COLOR[t.surface] ?? 'var(--gc-ink-mute)' }}
                    >
                      {t.surface}
                    </div>
                    {t.ageBand && (
                      <div
                        className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[2px] rounded-[4px] flex-none"
                        style={{ background: 'oklch(45% 0.1 240 / 0.35)', color: 'oklch(85% 0.08 240)' }}
                      >
                        {t.ageBand}
                      </div>
                    )}
                    <div className="text-[13.5px] font-semibold truncate">{t.name}</div>
                  </div>
                  <div className="text-[11.5px] flex-none" style={{ color: 'var(--gc-ink-mute)' }}>
                    {t.entrants.length}/{t.drawSize}
                  </div>
                </div>
                <div className="text-[11.5px] mt-[3px]" style={{ color: 'var(--gc-ink-mute)' }}>
                  {t.tier} · season {t.weekScheduled.season}, week {t.weekScheduled.week}
                </div>
                {ageIneligible && (
                  <div className="text-[11px] font-semibold mt-[4px]" style={{ color: 'oklch(78% 0.15 35)' }}>
                    Too old for this {t.ageBand} draw — a player may play up into an older junior band, not down
                  </div>
                )}
                {!ageIneligible && overCap && (
                  <div className="text-[11px] font-semibold mt-[4px]" style={{ color: 'oklch(78% 0.15 35)' }}>
                    {t.weeklyEntryCapThisWeek === 1
                      ? 'Already entered a tournament this week — a player can only play one tournament per week'
                      : `Already entered ${t.weeklyEntryCountThisWeek}/${t.weeklyEntryCapThisWeek} tournaments this week`}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-[14px] py-[9px] rounded-[6px] bg-transparent text-[12.5px] font-semibold cursor-pointer"
            style={{ border: '1px solid var(--gc-line)', color: 'var(--gc-ink-dim)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedId || submitting}
            className="px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--gc-ink)' }}
          >
            {submitting ? 'Entering…' : 'Enter tournament'}
          </button>
        </div>
      </div>
    </div>
  );
}
