'use client';

import { useState } from 'react';
import { PlayerDto, createCustomPlayer } from '../lib/api';

interface Props {
  managerId: string;
  creditsRemaining: number;
  onClose: () => void;
  onCreated: (player: PlayerDto) => void;
}

/**
 * Pro-only, credit-gated alternative to the talent pool: choose your
 * own name/nationality instead of claiming a generated candidate.
 * Deliberately does NOT let the manager touch attributes at all — they
 * come from the exact same generation policy any pool candidate uses
 * (see CreateCustomPlayerUseCase's doc comment on the API side). This
 * modal only ever renders for a Pro manager with creditsRemaining > 0
 * (see page.tsx) — the button that opens it is hidden otherwise.
 */
export function CreateCustomPlayerModal({ managerId, creditsRemaining, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [nationality, setNationality] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nationalityValid = /^[A-Za-z]{2}$/.test(nationality);
  const canSubmit = name.trim().length > 0 && nationalityValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const player = await createCustomPlayer({ managerId, name: name.trim(), nationality: nationality.toUpperCase() });
      onCreated(player);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(6,10,8,0.66)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[420px] gc-card rounded-[14px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-bold" style={{ color: 'var(--gc-ink)' }}>
          Create a custom player
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'var(--gc-ink-mute)' }}>
          Skip the talent pool and name your own player — attributes are still randomly generated the same way a pool
          candidate&apos;s are, no stat advantage.
        </div>
        <div
          className="mb-4 text-[12px] font-semibold rounded-[6px] px-3 py-2 inline-block"
          style={{ background: 'oklch(45% 0.13 80 / 0.28)', color: 'var(--gc-gold)' }}
        >
          {creditsRemaining} custom player credit{creditsRemaining === 1 ? '' : 's'} remaining
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        <label className="flex flex-col gap-[6px] mb-3">
          <span className="text-[12px] font-semibold" style={{ color: 'var(--gc-ink-dim)' }}>
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marta Vukovic"
            className="rounded-[6px] px-3 py-[9px] text-[13.5px]"
            style={{ border: '1px solid var(--gc-line)', background: 'var(--gc-bg-deep)', color: 'var(--gc-ink)' }}
          />
        </label>

        <label className="flex flex-col gap-[6px] mb-1">
          <span className="text-[12px] font-semibold" style={{ color: 'var(--gc-ink-dim)' }}>
            Nationality (2-letter code)
          </span>
          <input
            value={nationality}
            onChange={(e) => setNationality(e.target.value.slice(0, 2).toUpperCase())}
            placeholder="e.g. BR"
            maxLength={2}
            className="rounded-[6px] px-3 py-[9px] text-[13.5px] w-[100px] uppercase"
            style={{ border: '1px solid var(--gc-line)', background: 'var(--gc-bg-deep)', color: 'var(--gc-ink)' }}
          />
        </label>
        {nationality.length > 0 && !nationalityValid && (
          <div className="text-[11.5px] mb-2" style={{ color: 'oklch(78% 0.14 35)' }}>
            Enter exactly 2 letters, e.g. "BR" or "US".
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-[14px] py-[9px] rounded-[6px] bg-transparent text-[12.5px] font-semibold cursor-pointer"
            style={{ border: '1px solid var(--gc-line)', color: 'var(--gc-ink-dim)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--gc-ink)' }}
          >
            {submitting ? 'Creating…' : 'Create player (1 credit)'}
          </button>
        </div>
      </form>
    </div>
  );
}
