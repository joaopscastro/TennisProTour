'use client';

import { useEffect, useState } from 'react';
import { CoachConversionPreviewDto, CoachDto, convertPlayerToCoach, fetchCoachConversionPreview } from '../lib/api';

interface Props {
  playerId: string;
  playerName: string;
  managerId: string;
  tier: 'free' | 'pro';
  onClose: () => void;
  onConverted: (coach: CoachDto) => void;
}

/**
 * Converting a player to a coach is PERMANENT — the player leaves the
 * roster entirely and their slot frees up (see
 * ConvertPlayerToCoachUseCase's doc comment on the API side). That's
 * why this is a real modal with a distinct confirm step, not a
 * one-click roster-row action or a native window.confirm() the way
 * Release is: the manager needs to actually see the specific cost and
 * resulting coachRating for THIS player before committing, not just
 * acknowledge a generic warning string.
 */
export function CoachConversionModal({ playerId, playerName, managerId, tier, onClose, onConverted }: Props) {
  const [preview, setPreview] = useState<CoachConversionPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchCoachConversionPreview(playerId, managerId)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId, managerId]);

  const canAfford = preview ? preview.xpBalance >= preview.xpCost : false;
  const canConvert = preview !== null && !preview.atCap && canAfford;

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const coach = await convertPlayerToCoach(playerId, managerId);
      onConverted(coach);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(20,18,16,0.45)' }}
      onClick={onClose}
    >
      <div className="w-full max-w-[440px] rounded-[10px] bg-white p-6" onClick={(e) => e.stopPropagation()}>
        <div className="text-[16px] font-bold" style={{ color: 'oklch(20% 0.006 75)' }}>
          Convert {playerName} to a coach
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'oklch(50% 0.006 75)' }}>
          Their playing career ends here — this frees the roster slot but cannot be undone.
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        {preview === null && !error && (
          <div className="text-[13px] py-3" style={{ color: 'oklch(55% 0.006 75)' }}>
            Calculating cost and coach rating…
          </div>
        )}

        {preview && (
          <>
            <div className="grid grid-cols-2 gap-[10px] mb-4">
              <div className="rounded-[8px] px-[14px] py-[12px]" style={{ background: 'oklch(96% 0.003 75)' }}>
                <div className="text-[10px] font-bold tracking-[0.4px] uppercase mb-1" style={{ color: 'oklch(55% 0.006 75)' }}>
                  XP cost
                </div>
                <div className="text-[19px] font-bold [font-variant-numeric:tabular-nums]" style={{ color: canAfford ? 'oklch(30% 0.006 75)' : 'oklch(55% 0.16 25)' }}>
                  {preview.xpCost}
                </div>
                <div className="text-[11px] mt-[2px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                  You have {preview.xpBalance} XP
                </div>
              </div>
              <div className="rounded-[8px] px-[14px] py-[12px]" style={{ background: 'oklch(96% 0.003 75)' }}>
                <div className="text-[10px] font-bold tracking-[0.4px] uppercase mb-1" style={{ color: 'oklch(55% 0.006 75)' }}>
                  Resulting coach rating
                </div>
                <div className="text-[19px] font-bold [font-variant-numeric:tabular-nums]" style={{ color: 'oklch(30% 0.006 75)' }}>
                  {preview.coachRating}
                </div>
                <div className="text-[11px] mt-[2px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                  Applies a training-speed bonus
                </div>
              </div>
            </div>

            {/* Warning-tinted permanence notice — same treatment
                docs/ui-direction.md reserves for "the one perk with a
                cost" on Manager Pro: a consequential fact stated
                plainly, not buried after the numbers. */}
            <div
              className="mb-4 text-[12px] leading-[1.5] rounded-[6px] px-3 py-2"
              style={{ background: 'oklch(93% 0.03 75)', color: 'oklch(38% 0.1 60)' }}
            >
              Permanent: {playerName} leaves your roster the moment you confirm, freeing their slot. There is no undo
              and no release-back-to-player path.
            </div>

            {preview.atCap && (
              <div className="mb-4 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
                You already have {preview.coachCount}/{preview.coachCap} coaches
                {tier === 'pro' ? '' : ' (free tier)'}.
                {tier === 'pro'
                  ? ' You are at the Manager Pro coach limit.'
                  : ' Upgrade to Manager Pro for a second coach slot.'}
              </div>
            )}

            {!preview.atCap && !canAfford && (
              <div className="mb-4 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
                Need {preview.xpCost - preview.xpBalance} more XP to convert this player.
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            className="px-[14px] py-[9px] rounded-[6px] bg-transparent text-[12.5px] font-semibold cursor-pointer"
            style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConvert || submitting}
            className="px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'oklch(20% 0.006 75)' }}
          >
            {submitting ? 'Converting…' : 'Confirm — convert permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
