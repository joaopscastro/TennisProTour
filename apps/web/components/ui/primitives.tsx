'use client';

import React from 'react';
import { surfaceMeta } from '../../lib/ui/surfaces';

export { Flag } from './Flag';

/* ---- Layout shell ---------------------------------------------------------- */
/** Every screen renders its own Sidebar + content; this wraps the content
 *  column so the background and max-width are consistent. */
export function PageShell({ children, wash }: { children: React.ReactNode; wash?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--bg)' }}>
      {wash && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: wash }} />}
      <div className="gc-container" style={{ position: 'relative', padding: '30px 24px 80px' }}>{children}</div>
    </div>
  );
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>{children}</div>;
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
export function Badge({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span className="gc-badge" style={style}>{children}</span>;
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

/** Rank as a compact mono plate: band label + rank figure, no gold. */
export function RankBadge({ rank, points, band }: { rank: number | null; points: number; band?: string }) {
  const nr = rank == null;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      {band && <span className="t-label" style={{ fontSize: 10 }}>{band}</span>}
      <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: nr ? 'var(--ink-4)' : 'var(--ink)' }}>
        {nr ? 'NR' : `#${rank}`}
      </span>
      {!nr && <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{points.toLocaleString()} pts</span>}
    </div>
  );
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

/* ---- Hero band ------------------------------------------------------------- */
/** Flat page-top band: panel surface, hairline border, a 2px surface-coloured
 *  top edge. No surface gradient, no grain. */
export function Hero({ surface, children, minHeight = 150 }: { surface?: string | null; children: React.ReactNode; minHeight?: number }) {
  const meta = surfaceMeta(surface);
  return (
    <div style={{
      background: 'var(--bg-2)',
      border: '1px solid var(--hair)',
      borderTop: `2px solid ${surface ? meta.color : 'var(--hair-2)'}`,
      borderRadius: 'var(--r3)',
      minHeight,
      padding: '26px 30px',
      display: 'flex',
      alignItems: 'flex-end',
    }}>
      <div style={{ width: '100%' }}>{children}</div>
    </div>
  );
}
