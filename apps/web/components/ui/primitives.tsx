'use client';

import React from 'react';
import { surfaceMeta } from '../../lib/ui/surfaces';

export { Flag } from './Flag';

/* ---- Layout shell ---------------------------------------------------------- */
/** Wraps a screen's content column inside the persistent `AppShell` chrome so
 *  the max-width and page padding are consistent across every route. */
export function PageShell({ children, wash }: { children: React.ReactNode; wash?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--bg)' }}>
      {wash && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: wash }} />}
      <div className="gc-container" style={{ position: 'relative', padding: '30px 24px 80px' }}>{children}</div>
    </div>
  );
}

/* ---- Panel ----------------------------------------------------------------- */
export function Panel({ children, className = '', style }: {
  children: React.ReactNode; className?: string; style?: React.CSSProperties;
}) {
  return (
    <div className={`gc-card ${className}`} style={style}>
      {children}
    </div>
  );
}

/** Flat panel header bar: an uppercase label plus an optional mono figure. */
export function PanelHeader({ children, right, className = '' }: {
  children: React.ReactNode; right?: React.ReactNode; className?: string;
}) {
  return (
    <div className={`gc-panel-hd ${className}`}>
      <span className="t-label" style={{ color: 'var(--ink-2)' }}>{children}</span>
      {right != null && <span className="fig">{right}</span>}
    </div>
  );
}

/* ---- Section heading ------------------------------------------------------- */
export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '30px 2px 14px' }}>
      <div className="t-label" style={{ fontSize: 12.5, letterSpacing: '1.4px' }}>
        {children}
      </div>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/* ---- Button ---------------------------------------------------------------- */
type BtnVariant = 'primary' | 'default' | 'ghost';
export function Button({ variant = 'default', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  const v = variant === 'primary' ? ' gc-btn--primary' : variant === 'ghost' ? ' gc-btn--ghost' : '';
  return <button className={`gc-btn${v} ${className}`} {...rest} />;
}

/* ---- Badges ---------------------------------------------------------------- */
export function Badge({ children, style, title, className = '' }: {
  children: React.ReactNode; style?: React.CSSProperties; title?: string; className?: string;
}) {
  return <span className={`gc-badge ${className}`} style={style} title={title}>{children}</span>;
}

export function SurfaceBadge({ surface, size = 'md' }: { surface: string; size?: 'sm' | 'md' }) {
  const meta = surfaceMeta(surface);
  return (
    <span className="gc-badge gc-badge--surface" style={{ fontSize: size === 'sm' ? 10 : 11 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, display: 'inline-block' }} />
      {meta.label}
    </span>
  );
}

export function AgeBandBadge({ band }: { band: 'u14' | 'u16' | 'u18' | null | undefined }) {
  if (!band) return null;
  return <span className="gc-badge gc-badge--band">{band.toUpperCase()}</span>;
}

/* ---- Stat bar (segmented 10-block) ----------------------------------------- */
export function StatBar({ label, value, max = 100, color }: { label?: string; value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const c = color ?? 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {label && <span className="t-label" style={{ width: 68, textTransform: 'capitalize' }}>{label}</span>}
      <span className="gc-seg" style={{ flex: 1, ['--p' as string]: pct, ['--seg' as string]: c }} />
      <span className="gc-seg-val" style={{ width: 26, fontWeight: 600, color: 'var(--ink)' }}>{Math.round(value)}</span>
    </div>
  );
}
