'use client';

import { useEffect, useState } from 'react';
import { TournamentDto, fetchOpenTournaments, registerEntrant } from '../lib/api';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};

interface Props {
  playerId: string;
  playerName: string;
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
export function EnterTournamentModal({ playerId, playerName, onClose, onEntered }: Props) {
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
      const tournament = await registerEntrant(selectedId, playerId);
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  /** True once this player has already entered juniorEntryCapThisWeek
   * junior tournaments in a given tournament's specific week — the
   * real cap RegisterEntrantUseCase enforces (see
   * juniorEntryCap.ts), surfaced here so the row is disabled up front
   * rather than only failing after a click. Senior tournaments never
   * carry these fields at all, so they're never blocked by this. */
  function overCapFor(t: TournamentDto): boolean {
    return (
      t.juniorEntryCountThisWeek !== undefined &&
      t.juniorEntryCapThisWeek !== undefined &&
      t.juniorEntryCountThisWeek >= t.juniorEntryCapThisWeek
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(20,18,16,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] rounded-[10px] bg-white p-6 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-bold" style={{ color: 'oklch(20% 0.006 75)' }}>
          Enter {playerName} into a tournament
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'oklch(50% 0.006 75)' }}>
          Choose a tournament still open for registration.
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 overflow-y-auto" style={{ minHeight: 60 }}>
          {tournaments === null && !error && (
            <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              Loading open tournaments…
            </div>
          )}
          {tournaments?.length === 0 && (
            <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              No tournaments are open for entries right now.
            </div>
          )}
          {tournaments?.map((t) => {
            const selected = selectedId === t.id;
            const overCap = overCapFor(t);
            return (
              <button
                key={t.id}
                onClick={() => !overCap && setSelectedId(t.id)}
                disabled={overCap}
                className="text-left rounded-[8px] px-[14px] py-[10px] cursor-pointer disabled:cursor-not-allowed"
                style={{
                  border: selected ? '1.5px solid oklch(20% 0.006 75)' : '1px solid oklch(90% 0.005 75)',
                  background: selected ? 'oklch(97% 0.003 75)' : 'white',
                  opacity: overCap ? 0.55 : 1,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[2px] rounded-[4px] text-white flex-none"
                      style={{ background: SURFACE_COLOR[t.surface] ?? 'oklch(50% 0.006 75)' }}
                    >
                      {t.surface}
                    </div>
                    {t.ageBand && (
                      <div
                        className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[2px] rounded-[4px] flex-none"
                        style={{ background: 'oklch(90% 0.1 240)', color: 'oklch(35% 0.14 240)' }}
                      >
                        {t.ageBand}
                      </div>
                    )}
                    <div className="text-[13.5px] font-semibold truncate">{t.id}</div>
                  </div>
                  <div className="text-[11.5px] flex-none" style={{ color: 'oklch(52% 0.006 75)' }}>
                    {t.entrants.length}/{t.drawSize}
                  </div>
                </div>
                <div className="text-[11.5px] mt-[3px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                  {t.tier} · season {t.weekScheduled.season}, week {t.weekScheduled.week}
                </div>
                {overCap && (
                  <div className="text-[11px] font-semibold mt-[4px]" style={{ color: 'oklch(50% 0.16 30)' }}>
                    Already entered {t.juniorEntryCountThisWeek}/{t.juniorEntryCapThisWeek} junior tournaments this week
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
            style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedId || submitting}
            className="px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'oklch(20% 0.006 75)' }}
          >
            {submitting ? 'Entering…' : 'Enter tournament'}
          </button>
        </div>
      </div>
    </div>
  );
}
