'use client';

import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Panel width in px (clamped to 92vw by CSS). */
  width?: number;
  className?: string;
}

/**
 * Direction A modal shell: flat `--bg-2` panel, hairline border, no blur on
 * the backdrop. Esc and click-outside both close. Purely a shell — the
 * existing bespoke modals migrate onto it in later stages.
 */
export function Modal({ open, onClose, title, children, footer, width = 520, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="gc-modal-backdrop" onClick={onClose}>
      <div
        className={`gc-modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gc-modal-hd">
          <span className="t-label" style={{ color: 'var(--ink-2)' }}>{title}</span>
          <button type="button" className="gc-btn gc-btn--ghost gc-btn--sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="gc-modal-bd">{children}</div>
        {footer && <div className="gc-modal-ft">{footer}</div>}
      </div>
    </div>
  );
}
