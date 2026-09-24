'use client';

import { useEffect, useState } from 'react';
import { CoachConversionPreviewDto, CoachDto, convertPlayerToCoach, fetchCoachConversionPreview } from '../lib/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/primitives';

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

  const warningStyle = {
    color: 'var(--loss)',
    background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--loss) 35%, transparent)',
  } as const;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Convert ${playerName} to a coach`}
      width={460}
      footer={
        <>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" onClick={handleConfirm} disabled={!canConvert || submitting}>
            {submitting ? 'Converting…' : 'Confirm — convert permanently'}
          </Button>
        </>
      }
    >
      <div className="t-body-sm" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        Their playing career ends here — this frees the roster slot but cannot be undone.
      </div>

      {error && (
        <div className="gc-notice" style={{ ...warningStyle, marginTop: 12 }}>{error}</div>
      )}

      {preview === null && !error && (
        <div style={{ fontSize: 13, padding: '12px 0', color: 'var(--ink-3)' }}>
          Calculating cost and coach rating…
        </div>
      )}

      {preview && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '16px 0' }}>
            <div style={{ background: 'var(--bg-3)', borderRadius: 'var(--r2)', padding: '12px 14px' }}>
              <div className="t-label" style={{ marginBottom: 4 }}>XP cost</div>
              <div className="num" style={{ fontSize: 19, fontWeight: 700, color: canAfford ? 'var(--ink)' : 'var(--loss)' }}>
                {preview.xpCost}
              </div>
              <div style={{ fontSize: 11, marginTop: 2, color: 'var(--ink-3)' }}>
                You have {preview.xpBalance} XP
              </div>
            </div>
            <div style={{ background: 'var(--bg-3)', borderRadius: 'var(--r2)', padding: '12px 14px' }}>
              <div className="t-label" style={{ marginBottom: 4 }}>Resulting coach rating</div>
              <div className="num" style={{ fontSize: 19, fontWeight: 700, color: 'var(--ink)' }}>
                {preview.coachRating}
              </div>
              <div style={{ fontSize: 11, marginTop: 2, color: 'var(--ink-3)' }}>
                Applies a training-speed bonus
              </div>
            </div>
          </div>

          {/* Warning-tinted permanence notice — same treatment
              docs/ui-direction.md reserves for "the one perk with a
              cost" on Manager Pro: a consequential fact stated
              plainly, not buried after the numbers. */}
          <div
            className="gc-notice"
            style={{
              marginBottom: 16,
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--gold)',
              borderColor: 'color-mix(in srgb, var(--gold) 40%, transparent)',
              background: 'color-mix(in srgb, var(--gold) 12%, transparent)',
            }}
          >
            Permanent: {playerName} leaves your roster the moment you confirm, freeing their slot. There is no undo
            and no release-back-to-player path.
          </div>

          {preview.atCap && (
            <div className="gc-notice" style={{ ...warningStyle, marginBottom: 16 }}>
              You already have {preview.coachCount}/{preview.coachCap} coaches
              {tier === 'pro' ? '' : ' (free tier)'}.
              {tier === 'pro'
                ? ' You are at the Manager Pro coach limit.'
                : ' Upgrade to Manager Pro for a second coach slot.'}
            </div>
          )}

          {!preview.atCap && !canAfford && (
            <div className="gc-notice" style={{ ...warningStyle, marginBottom: 16 }}>
              Need {preview.xpCost - preview.xpBalance} more XP to convert this player.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
