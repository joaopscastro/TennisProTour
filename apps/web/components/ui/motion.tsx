'use client';

import React, { useEffect, useRef, useState } from 'react';

/* ============================================================================
   Motion & feedback system (GC-15, docs/ui-direction-v2-game-feel.md)
   Principle: no state change happens silently. Every one of these primitives
   degrades to instant-but-visible under `prefers-reduced-motion` — the
   feedback (the delta chip, the new number, the flash target) stays present,
   only the movement is removed.
   ============================================================================ */

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const numberFmt = (n: number) => Math.round(n).toLocaleString();

/**
 * A number that tweens from its PREVIOUS value to its new value whenever the
 * value prop changes (unlike CountUp, which always animates from 0). On first
 * mount it counts up from `mountFrom` (default 0). Pass an explicit `from` to
 * override the start of the very first tween (used with a persisted snapshot
 * so a weekly-tick gain animates up from the last value the manager saw).
 */
export function AnimatedNumber({
  value,
  from,
  mountFrom = 0,
  durationMs = 700,
  format = numberFmt,
  className,
  style,
  pop = true,
}: {
  value: number;
  from?: number;
  mountFrom?: number;
  durationMs?: number;
  format?: (n: number) => string;
  className?: string;
  style?: React.CSSProperties;
  pop?: boolean;
}) {
  const initial = from ?? mountFrom;
  const [display, setDisplay] = useState(initial);
  const prevRef = useRef(initial);
  const raf = useRef<number | undefined>(undefined);
  const firstRun = useRef(true);
  const [popKey, setPopKey] = useState(0);

  useEffect(() => {
    const start = firstRun.current ? initial : prevRef.current;
    firstRun.current = false;
    const target = value;
    prevRef.current = target;
    if (start === target) { setDisplay(target); return; }

    if (prefersReducedMotion()) { setDisplay(target); if (pop) setPopKey((k) => k + 1); return; }

    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(start + (target - start) * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else if (pop) setPopKey((k) => k + 1);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      <span key={popKey} className={pop ? 'gc-num-pop' : undefined}>{format(display)}</span>
    </span>
  );
}

/**
 * A self-contained floating +/− chip. Watches a numeric `value`; each time it
 * changes it renders a rising, fading delta. `invert` flips sign semantics for
 * rank (a rank going 5→3 is an IMPROVEMENT of +2, shown green/up).
 * Must live inside a `position: relative` wrapper.
 */
export function Delta({
  value,
  invert = false,
  format = (n) => Math.abs(Math.round(n)).toLocaleString(),
  suffix,
  side = 'right',
}: {
  value: number;
  invert?: boolean;
  format?: (n: number) => string;
  suffix?: string;
  side?: 'left' | 'right';
}) {
  const prev = useRef<number | null>(null);
  const [floats, setFloats] = useState<Array<{ id: number; raw: number }>>([]);

  useEffect(() => {
    if (prev.current === null) { prev.current = value; return; }
    const raw = value - prev.current;
    prev.current = value;
    if (raw === 0) return;
    const id = Date.now() + Math.random();
    setFloats((f) => [...f, { id, raw }]);
    const timeout = setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1600);
    return () => clearTimeout(timeout);
  }, [value]);

  const pos: React.CSSProperties = side === 'left'
    ? { right: '100%', left: 'auto', marginRight: 7, marginLeft: 0 }
    : {};

  return (
    <>
      {floats.map((f) => {
        const improved = invert ? f.raw < 0 : f.raw > 0;
        const dir = improved ? 'up' : 'down';
        const arrow = improved ? '▲' : '▼';
        const sign = f.raw > 0 ? '+' : '−';
        return (
          <span key={f.id} className="gc-delta" data-dir={dir} style={pos} aria-hidden>
            <span style={{ fontSize: 8 }}>{arrow}</span>
            {sign}{format(f.raw)}{suffix ? ` ${suffix}` : ''}
          </span>
        );
      })}
    </>
  );
}

/**
 * Wraps children and briefly plays a green gain-flash whenever `value`
 * increases (attribute up after a tick, a game won). Never flashes on
 * decrease — that's decay, not a gain.
 */
export function FlashOnGain({
  value,
  children,
  className,
  style,
  radius = 999,
}: {
  value: number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  radius?: number;
}) {
  const prev = useRef<number | null>(null);
  const [flashKey, setFlashKey] = useState<number | null>(null);

  useEffect(() => {
    if (prev.current === null) { prev.current = value; return; }
    if (value > prev.current) setFlashKey(Date.now());
    prev.current = value;
  }, [value]);

  return (
    <span
      key={flashKey ?? 'idle'}
      className={`${flashKey ? 'gc-gain-flash' : ''} ${className ?? ''}`}
      style={{ display: 'inline-flex', borderRadius: radius, ...style }}
    >
      {children}
    </span>
  );
}

/**
 * Pops a wrapped score value each time it changes (game/set count in replay).
 * Change (not just increase) — a corrected/rewound score should still register.
 */
export function ScorePop({ value, children, style }: { value: number | string; children: React.ReactNode; style?: React.CSSProperties }) {
  const prev = useRef<number | string | null>(null);
  const [key, setKey] = useState<number | null>(null);
  useEffect(() => {
    if (prev.current === null) { prev.current = value; return; }
    if (value !== prev.current) setKey(Date.now());
    prev.current = value;
  }, [value]);
  return (
    <span key={key ?? 'idle'} className={key ? 'gc-score-pop' : undefined} style={{ display: 'inline-flex', ...style }}>
      {children}
    </span>
  );
}

/** Rank-shift indicator: ▲2 / ▼1 / — no change. Lower rank number is better. */
export function RankShift({ from, to }: { from: number | null; to: number | null }) {
  if (from == null || to == null || from === to) return null;
  const moved = from - to; // positive = moved up (toward #1)
  const dir = moved > 0 ? 'up' : 'down';
  return (
    <span className="gc-shift" data-dir={dir} title={`Moved ${moved > 0 ? 'up' : 'down'} ${Math.abs(moved)} from #${from}`}>
      <span style={{ fontSize: 9 }}>{moved > 0 ? '▲' : '▼'}</span>{Math.abs(moved)}
    </span>
  );
}

/** Skeleton block for skeleton→content reveals. */
export function Skeleton({ width, height = 14, radius = 8, style }: { width?: number | string; height?: number | string; radius?: number; style?: React.CSSProperties }) {
  return <div className="gc-skeleton" style={{ width: width ?? '100%', height, borderRadius: radius, ...style }} />;
}

/** Fades/rises content in once it's ready (paired with Skeleton). */
export function Reveal({ children, delayMs = 0, style }: { children: React.ReactNode; delayMs?: number; style?: React.CSSProperties }) {
  return <div className="gc-reveal" style={{ animationDelay: `${delayMs}ms`, ...style }}>{children}</div>;
}

/**
 * Reads a persisted previous value for `key` (localStorage) so a change that
 * happened between sessions — e.g. a weekly worker tick raising an attribute
 * or ranking points — animates up from what the manager last saw, instead of
 * silently rendering the new value. Returns the previous value (or null the
 * first time this key is ever seen) and writes the current value back.
 */
export function usePersistedPrevious(key: string, value: number): number | null {
  const [prev, setPrev] = useState<number | null>(null);
  const read = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!read.current) {
      read.current = true;
      const stored = window.localStorage.getItem(key);
      setPrev(stored === null ? null : Number(stored));
    }
    window.localStorage.setItem(key, String(value));
  }, [key, value]);
  return prev;
}

/**
 * Overall-rating ring whose fill and number tween from the previously-seen
 * value (persisted across sessions), and which plays a gain-flash when the
 * rating has risen since last seen — so a weekly training gain reads as the
 * stat *growing*, not a silently higher number.
 */
export function AnimatedOvrRing({ value, size = 46, persistKey }: { value: number; size?: number; persistKey?: string }) {
  const prev = usePersistedPrevious(persistKey ?? `ovr-fallback`, value);
  const [shown, setShown] = useState(value);
  const raf = useRef<number | undefined>(undefined);
  const started = useRef(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prev == null) { setShown(value); return; }
    if (started.current && prev === value) return;
    const gained = value > prev;
    if (!started.current) {
      started.current = true;
      if (prev === value) { setShown(value); return; }
    }
    if (gained) { setFlash(true); setTimeout(() => setFlash(false), 950); }
    if (prefersReducedMotion()) { setShown(value); return; }
    const start = prev;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 800);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(start + (value - start) * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev, value]);

  const pct = Math.max(0, Math.min(100, shown));
  const hue = 30 + (pct / 100) * 100;
  const col = `oklch(72% 0.16 ${hue})`;
  return (
    <span className={flash ? 'gc-gain-flash' : undefined} style={{ display: 'inline-flex', borderRadius: 999 }}>
      <div style={{
        width: size, height: size, borderRadius: 999, flex: 'none',
        display: 'grid', placeItems: 'center', position: 'relative',
        background: `conic-gradient(${col} ${pct}%, oklch(0% 0 0 / 0.4) 0)`,
        boxShadow: '0 2px 6px oklch(0% 0 0 / 0.3)',
      }}>
        <div style={{ position: 'absolute', inset: 4, borderRadius: 999, background: 'var(--gc-s1)', display: 'grid', placeItems: 'center' }}>
          <span style={{ fontSize: size * 0.34, fontWeight: 850, color: col, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{Math.round(shown)}</span>
        </div>
      </div>
    </span>
  );
}
