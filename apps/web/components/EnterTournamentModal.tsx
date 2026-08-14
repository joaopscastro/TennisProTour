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
  /** When set (the player profile's Schedule planner passes the week
   * the manager clicked "Enter" on), restrict the list to tournaments
   * scheduled for exactly that week — a manager entering a player for
   * a specific future week should not be offered every open
   * tournament across the whole season. Omitted (the roster board's
   * "Enter" action) = show every open tournament, same as before. */
  week?: { season: number; week: number };
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
export function EnterTournamentModal({ playerId, playerName, managerId, week, onClose, onEntered }: Props) {
  const [tournaments, setTournaments] = useState<TournamentDto[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchOpenTournaments(playerId)
      .then((all) =>
        setTournaments(
          all.filter(
            (t) =>
              hasRoomFor(t) &&
              !t.entrants.some((e) => e.playerId === playerId) &&
              (!week || (t.weekScheduled.season === week.season && t.weekScheduled.week === week.week)),
          ),
        ),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId, week]);

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

  /** True when this player would be refused outright because they're a
   * below-cutoff registrant and the qualifying field is already full —
   * the exact "qualifying-full" refusal RegisterEntrantUseCase raises. */
  function qualifyingFullFor(t: TournamentDto): boolean {
    return t.qualifyingFieldFull === true;
  }

  /** Whether this tournament still has room for THIS player. A
   * qualifying-tier entrant below the cutoff is measured against the
   * QUALIFYING field (which `entrants.length < drawSize` can't see —
   * `entrants` includes qualifying entrants), while a direct-acceptance
   * or non-qualifying entrant is measured against the main draw. */
  function hasRoomFor(t: TournamentDto): boolean {
    if (t.entryViaQualifying) return !t.qualifyingFieldFull;
    const mainEntrants = t.entrants.filter((e) => e.draw !== 'qualifying').length;
    const mainCapacity = t.drawSize - (t.qualifierSlots ?? 0);
    return mainEntrants < mainCapacity;
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
              {week ? 'No tournaments are open for this week.' : 'No tournaments are open for entries right now.'}
            </div>
          )}
          {tournaments?.map((t) => {
            const selected = selectedId === t.id;
            const overCap = overCapFor(t);
            const ageIneligible = ageIneligibleFor(t);
            const qualifyingFull = qualifyingFullFor(t);
            const blocked = overCap || ageIneligible || qualifyingFull;
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
                    {t.entryViaQualifying && (
                      <div
                        className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[2px] rounded-[4px] flex-none"
                        style={{ background: 'oklch(45% 0.12 45 / 0.35)', color: 'oklch(85% 0.1 45)' }}
                      >
                        [Q]
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
                {t.entryViaQualifying && !qualifyingFull && (
                  <div className="text-[11px] mt-[4px]" style={{ color: 'var(--gc-ink-dim)' }}>
                    You&apos;ll enter through qualifying — {t.qualifyingFieldTaken}/{t.qualifyingFieldSize} qualifying spots taken
                  </div>
                )}
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
                {!ageIneligible && !overCap && qualifyingFull && (
                  <div className="text-[11px] font-semibold mt-[4px]" style={{ color: 'oklch(78% 0.15 35)' }}>
                    Qualifying field full ({t.qualifyingFieldTaken}/{t.qualifyingFieldSize}) — no [Q] places left
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
