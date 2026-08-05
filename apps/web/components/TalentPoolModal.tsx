'use client';

import { useEffect, useState } from 'react';
import { PlayerDto, PlayerRarityTier, TalentPoolCandidateDto, claimTalentPoolCandidate, fetchTalentPool } from '../lib/api';
import { flagFor } from '../lib/format';

const TIER_META: Record<PlayerRarityTier, { label: string; bg: string; fg: string }> = {
  common: { label: 'Common', bg: 'oklch(93% 0.006 75)', fg: 'oklch(40% 0.006 75)' },
  strong: { label: 'Strong', bg: 'oklch(90% 0.1 240)', fg: 'oklch(35% 0.14 240)' },
  exceptional: { label: 'Exceptional', bg: 'oklch(88% 0.13 75)', fg: 'oklch(38% 0.16 60)' },
};

function overallOf(c: TalentPoolCandidateDto): number {
  const { technical, physical, mental } = c.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

interface Props {
  managerId: string;
  onClose: () => void;
  onClaimed: (player: PlayerDto) => void;
}

/**
 * Real talent-pool browser — replaces the earlier direct "Hire
 * player" form. Hiring is no longer instant/on-demand: a manager
 * claims a specific, already-generated candidate out of the shared
 * pool every manager sees (see docs/CLAUDE.md's "hiring is pool-based
 * and scarce" note). Claiming can fail with a 409 if another manager
 * claims the same candidate first — race-safety is real, not just a
 * UI nicety, so that failure path is handled explicitly, not just
 * assumed away.
 */
export function TalentPoolModal({ managerId, onClose, onClaimed }: Props) {
  const [candidates, setCandidates] = useState<TalentPoolCandidateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  useEffect(() => {
    fetchTalentPool()
      .then(setCandidates)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleClaim(candidateId: string) {
    setClaimingId(candidateId);
    setError(null);
    try {
      const player = await claimTalentPoolCandidate(candidateId, managerId);
      onClaimed(player);
    } catch (e) {
      // A 409 here most likely means someone else claimed it first —
      // refresh the list so the (now-stale) candidate disappears
      // rather than leaving a dead entry the manager could click again.
      setError(e instanceof Error ? e.message : String(e));
      setClaimingId(null);
      fetchTalentPool()
        .then(setCandidates)
        .catch(() => undefined);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(20,18,16,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] rounded-[10px] bg-white p-6 max-h-[82vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-bold" style={{ color: 'oklch(20% 0.006 75)' }}>
          Talent pool
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'oklch(50% 0.006 75)' }}>
          Claim a player before another manager does — the pool refreshes weekly and unclaimed candidates expire after 2 weeks.
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 overflow-y-auto" style={{ minHeight: 60 }}>
          {candidates === null && !error && (
            <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              Loading talent pool…
            </div>
          )}
          {candidates?.length === 0 && (
            <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              No candidates available right now — check back after the next weekly refresh.
            </div>
          )}
          {candidates?.map((c) => {
            const tier = TIER_META[c.tier];
            const busy = claimingId === c.id;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-[8px] px-[14px] py-[10px]"
                style={{ border: '1px solid oklch(90% 0.005 75)', opacity: busy ? 0.6 : 1 }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-[7px]">
                    <span className="flex-none">{flagFor(c.nationality)}</span>
                    <span className="text-[13.5px] font-semibold truncate">{c.name}</span>
                    <span
                      className="text-[10px] font-bold tracking-[0.3px] uppercase px-[7px] py-[2px] rounded-[4px] flex-none"
                      style={{ background: tier.bg, color: tier.fg }}
                    >
                      {tier.label}
                    </span>
                  </div>
                  <div className="text-[11.5px] mt-[3px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                    {overallOf(c)} OVR · generated season {c.generatedAtWeek.season}, week {c.generatedAtWeek.week}
                  </div>
                </div>
                <button
                  onClick={() => handleClaim(c.id)}
                  disabled={claimingId !== null}
                  className="flex-none px-[14px] py-[8px] rounded-[6px] text-white border-none text-[12px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: 'oklch(20% 0.006 75)' }}
                >
                  {busy ? 'Claiming…' : 'Claim'}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-[14px] py-[9px] rounded-[6px] bg-transparent text-[12.5px] font-semibold cursor-pointer"
            style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
