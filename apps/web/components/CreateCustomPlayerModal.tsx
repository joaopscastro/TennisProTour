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
      style={{ background: 'rgba(20,18,16,0.45)' }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[420px] rounded-[10px] bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-bold" style={{ color: 'oklch(20% 0.006 75)' }}>
          Create a custom player
        </div>
        <div className="text-[12.5px] mt-1 mb-4" style={{ color: 'oklch(50% 0.006 75)' }}>
          Skip the talent pool and name your own player — attributes are still randomly generated the same way a pool
          candidate&apos;s are, no stat advantage.
        </div>
        <div
          className="mb-4 text-[12px] font-semibold rounded-[6px] px-3 py-2 inline-block"
          style={{ background: 'oklch(93% 0.03 75)', color: 'oklch(38% 0.1 60)' }}
        >
          {creditsRemaining} custom player credit{creditsRemaining === 1 ? '' : 's'} remaining
        </div>

        {error && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        <label className="flex flex-col gap-[6px] mb-3">
          <span className="text-[12px] font-semibold" style={{ color: 'oklch(35% 0.006 75)' }}>
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marta Vukovic"
            className="rounded-[6px] px-3 py-[9px] text-[13.5px]"
            style={{ border: '1px solid oklch(85% 0.006 75)' }}
          />
        </label>

        <label className="flex flex-col gap-[6px] mb-1">
          <span className="text-[12px] font-semibold" style={{ color: 'oklch(35% 0.006 75)' }}>
            Nationality (2-letter code)
          </span>
          <input
            value={nationality}
            onChange={(e) => setNationality(e.target.value.slice(0, 2).toUpperCase())}
            placeholder="e.g. BR"
            maxLength={2}
            className="rounded-[6px] px-3 py-[9px] text-[13.5px] w-[100px] uppercase"
            style={{ border: '1px solid oklch(85% 0.006 75)' }}
          />
        </label>
        {nationality.length > 0 && !nationalityValid && (
          <div className="text-[11.5px] mb-2" style={{ color: 'oklch(50% 0.13 30)' }}>
            Enter exactly 2 letters, e.g. "BR" or "US".
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-[14px] py-[9px] rounded-[6px] bg-transparent text-[12.5px] font-semibold cursor-pointer"
            style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'oklch(20% 0.006 75)' }}
          >
            {submitting ? 'Creating…' : 'Create player (1 credit)'}
          </button>
        </div>
      </form>
    </div>
  );
}
