'use client';

import { useState } from 'react';
import { PlayerDto, createCustomPlayer } from '../lib/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/primitives';

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
    <Modal
      open
      onClose={onClose}
      title="Create a custom player"
      width={440}
      footer={
        <>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" form="create-custom-player" disabled={!canSubmit || submitting}>
            {submitting ? 'Creating…' : 'Create player (1 credit)'}
          </Button>
        </>
      }
    >
      <form id="create-custom-player" onSubmit={handleSubmit}>
        <div className="t-body-sm" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Skip the talent pool and name your own player — attributes are still randomly generated the same way a pool
          candidate&apos;s are, no stat advantage.
        </div>
        <div
          className="gc-badge"
          style={{ margin: '14px 0', color: 'var(--gold)', borderColor: 'color-mix(in srgb, var(--gold) 40%, transparent)' }}
        >
          {creditsRemaining} custom player credit{creditsRemaining === 1 ? '' : 's'} remaining
        </div>

        {error && (
          <div
            className="gc-notice"
            style={{
              marginBottom: 12,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          <span className="t-label">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marta Vukovic"
            className="gc-input"
            style={{ fontSize: 13.5 }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="t-label">Nationality (2-letter code)</span>
          <input
            value={nationality}
            onChange={(e) => setNationality(e.target.value.slice(0, 2).toUpperCase())}
            placeholder="e.g. BR"
            maxLength={2}
            className="gc-input"
            style={{ fontSize: 13.5, width: 100, textTransform: 'uppercase' }}
          />
        </label>
        {nationality.length > 0 && !nationalityValid && (
          <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--warn)' }}>
            Enter exactly 2 letters, e.g. &quot;BR&quot; or &quot;US&quot;.
          </div>
        )}
      </form>
    </Modal>
  );
}
