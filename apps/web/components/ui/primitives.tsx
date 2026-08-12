'use client';

import React, { useEffect, useRef, useState } from 'react';
import { surfaceTheme } from '../../lib/surfaces';
import { flagFor } from '../../lib/format';

/* ---- Layout shell ---------------------------------------------------------- */
/** Every screen renders its own Sidebar + content; this wraps the content
 *  column so the atmospheric background and max-width are consistent. */
export function PageShell({ children, wash }: { children: React.ReactNode; wash?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--gc-bg)' }}>
      {wash && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: wash }} />}
      <div style={{ position: 'relative', maxWidth: 1180, margin: '0 auto', padding: '30px 34px 80px' }}>{children}</div>
    </div>
  );
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--gc-bg-deep)' }}>{children}</div>;
}

/* ---- Panel ----------------------------------------------------------------- */
export function Panel({ children, className = '', style, grain, hover }: {
  children: React.ReactNode; className?: string; style?: React.CSSProperties; grain?: boolean; hover?: boolean;
}) {
  return (
    <div className={`gc-card${hover ? ' gc-card--hover' : ''}${grain ? ' gc-grain' : ''} ${className}`} style={style}>
      {children}
    </div>
  );
}

/* ---- Section heading with net motif --------------------------------------- */
export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '30px 2px 14px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '1.4px', textTransform: 'uppercase', color: 'var(--gc-ink-mute)' }}>
        {children}
      </div>
      <div className="gc-net" style={{ flex: 1 }}><span /></div>
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
  const t = surfaceTheme(surface);
  return (
    <span className="gc-surface-chip" style={{
      background: `linear-gradient(180deg, ${t.color}, ${t.deep})`,
      fontSize: size === 'sm' ? 9.5 : 10.5,
      padding: size === 'sm' ? '2px 7px 2px 6px' : undefined,
    }}>
      <span className="dot" />{t.label}
    </span>
  );
}

export function AgeBandBadge({ band }: { band: 'u14' | 'u16' | null | undefined }) {
  if (!band) return null;
  return <span className="gc-badge" style={{ background: 'oklch(45% 0.1 240 / 0.35)', color: 'oklch(85% 0.08 240)', borderColor: 'oklch(60% 0.1 240 / 0.4)' }}>{band.toUpperCase()}</span>;
}

/** Rank as a prominent broadcast-style plate. */
export function RankBadge({ rank, points, band }: { rank: number | null; points: number; band?: string }) {
  const nr = rank == null;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>#</span>
      <span style={{
        fontSize: 26, fontWeight: 850, lineHeight: 1, letterSpacing: '-0.5px',
        color: nr ? 'var(--gc-ink-faint)' : 'var(--gc-gold)',
        fontVariantNumeric: 'tabular-nums',
      }}>{nr ? 'NR' : rank}</span>
      {!nr && <span style={{ fontSize: 11.5, color: 'var(--gc-ink-mute)', fontVariantNumeric: 'tabular-nums' }}>{points.toLocaleString()} pts</span>}
    </div>
  );
}

/* ---- Flag ------------------------------------------------------------------ */
export function Flag({ code, size = 15 }: { code: string; size?: number }) {
  return <span style={{ fontSize: size, lineHeight: 1 }} title={code.toUpperCase()}>{flagFor(code)}</span>;
}

/* ---- Overall rating ring --------------------------------------------------- */
export function OvrRing({ value, size = 46 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const hue = 30 + (pct / 100) * 100; // red→green
  const col = `oklch(72% 0.16 ${hue})`;
  return (
    <div style={{
      width: size, height: size, borderRadius: 999, flex: 'none',
      display: 'grid', placeItems: 'center', position: 'relative',
      background: `conic-gradient(${col} ${pct}%, oklch(0% 0 0 / 0.4) 0)`,
      boxShadow: '0 2px 6px oklch(0% 0 0 / 0.3)',
    }}>
      <div style={{ position: 'absolute', inset: 4, borderRadius: 999, background: 'var(--gc-s1)', display: 'grid', placeItems: 'center' }}>
        <span style={{ fontSize: size * 0.34, fontWeight: 850, color: col, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{Math.round(value)}</span>
      </div>
    </div>
  );
}

/* ---- Stat bar -------------------------------------------------------------- */
export function StatBar({ label, value, max = 100, color }: { label?: string; value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const hue = 30 + (Math.min(100, value) / 100) * 100;
  const c = color ?? `oklch(70% 0.15 ${hue})`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {label && <span style={{ width: 68, fontSize: 11.5, color: 'var(--gc-ink-mute)', textTransform: 'capitalize' }}>{label}</span>}
      <div className="gc-bar" style={{ flex: 1 }}><i style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${c}, color-mix(in oklch, ${c}, white 18%))` }} /></div>
      <span style={{ width: 26, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(value)}</span>
    </div>
  );
}

/* ---- Count-up number (juice) ---------------------------------------------- */
export function CountUp({ value, className, style, format }: { value: number; className?: string; style?: React.CSSProperties; format?: (n: number) => string }) {
  const [n, setN] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(value); return; }
    const start = performance.now();
    const from = 0; const dur = 700;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setN(from + (value - from) * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [value]);
  return <span className={className} style={style}>{(format ?? ((x) => Math.round(x).toLocaleString()))(n)}</span>;
}

/* ---- Environmental hero ---------------------------------------------------- */
export function Hero({ surface, children, minHeight = 150 }: { surface?: string | null; children: React.ReactNode; minHeight?: number }) {
  const t = surfaceTheme(surface);
  const bg = surface ? t.gradient : 'linear-gradient(135deg, oklch(30% 0.03 150), oklch(18% 0.02 150) 70%)';
  return (
    <div className="gc-hero gc-grain gc-rise" style={{ background: bg, minHeight, padding: '26px 30px', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ position: 'relative', zIndex: 1, width: '100%' }}>{children}</div>
    </div>
  );
}
