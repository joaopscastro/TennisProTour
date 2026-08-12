'use client';

import React, { useMemo, useState } from 'react';
import { Avatar } from './Avatar';
import { Flag, OvrRing } from './primitives';
import { prefersReducedMotion } from './motion';
import { surfaceTheme } from '../../lib/surfaces';

/* ============================================================================
   Celebration moments (GC-16, docs/ui-direction-v2-game-feel.md)
   Five deliberately DIFFERENT celebratory interstitials, each fired from an
   existing domain signal (no new backend concepts):
     - title            → TournamentCompleted (a champion is decided)
     - title/firstCareer → same event, escalated when it's the player's 1st
     - rank             → peak-ranking crossing top 100 / 10 / 1
     - graduation       → U14→U16 / U16→senior band change on the weekly tick
     - claim            → claiming a high-/elite-potential prospect
   Each renders inside a fixed-size `.gc-share-card` node (data-share-card) so a
   later share pipeline (GC-12) can screenshot exactly that frame. This builds
   the VISUAL only — no upload/sharing wiring here.
   ============================================================================ */

export type CelebrationMoment =
  | {
      kind: 'title';
      firstCareer: boolean;
      playerId: string;
      playerName: string;
      nationality: string;
      tournamentName: string;
      surface: string;
    }
  | {
      kind: 'rank';
      milestone: 1 | 10 | 100;
      band: 'senior' | 'u14' | 'u16';
      playerId: string;
      playerName: string;
      nationality: string;
    }
  | {
      kind: 'graduation';
      from: 'u14' | 'u16';
      to: 'u16' | 'senior';
      playerId: string;
      playerName: string;
      nationality: string;
    }
  | {
      kind: 'claim';
      playerId: string;
      playerName: string;
      nationality: string;
      overall: number;
    }
  | {
      kind: 'potential';
      playerId: string;
      playerName: string;
      nationality: string;
      /** The scout's projected-ceiling midpoint at the moment the read
       * resolved — the number that just got confirmed. */
      projected: number;
      tier: 'high' | 'elite';
    };

const BAND_LABEL: Record<string, string> = { senior: 'Senior Tour', u14: 'U14 Circuit', u16: 'U16 Circuit' };

/* ---- Confetti (skipped entirely under reduced motion) ---------------------- */
function Confetti({ colors, count = 46 }: { colors: string[]; count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, k) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        dur: 2.3 + Math.random() * 1.9,
        color: colors[k % colors.length],
        w: 5 + Math.random() * 6,
        h: 9 + Math.random() * 8,
        rot: Math.random() * 360,
      })),
    [colors, count],
  );
  if (prefersReducedMotion()) return null;
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 3 }}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="gc-confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.h,
            background: p.color,
            transform: `rotate(${p.rot}deg)`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
          }}
        />
      ))}
    </div>
  );
}

function Trophy({ color, size = 76 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 4h12v3a6 6 0 0 1-12 0V4z" fill={color} stroke="oklch(100% 0 0 / 0.5)" strokeWidth="0.6" />
      <path d="M6 5H3.5a2.5 2.5 0 0 0 3 2.4M18 5h2.5a2.5 2.5 0 0 1-3 2.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10 12.5h4l-.4 3h-3.2z" fill={color} />
      <path d="M8.5 19h7M9.5 15.5h5l.6 3.5h-6.2z" fill={color} stroke="oklch(100% 0 0 / 0.4)" strokeWidth="0.5" />
    </svg>
  );
}

function Crown({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 8l3.5 3L12 5l5.5 6L21 8l-1.5 10h-15z" fill={color} stroke="oklch(100% 0 0 / 0.4)" strokeWidth="0.6" strokeLinejoin="round" />
      <circle cx="3" cy="8" r="1.4" fill={color} /><circle cx="21" cy="8" r="1.4" fill={color} /><circle cx="12" cy="4.4" r="1.4" fill={color} />
    </svg>
  );
}

function BrandMark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.8 }}>
      <span style={{ width: 13, height: 13, borderRadius: 4, background: 'radial-gradient(circle at 35% 30%, oklch(90% 0.19 122), oklch(66% 0.17 122))', flex: 'none' }} />
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--gc-ink-mute)' }}>Grand Circuit</span>
    </div>
  );
}

const Eyebrow = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <div style={{ fontSize: 11, fontWeight: 850, letterSpacing: '3px', textTransform: 'uppercase', color }}>{children}</div>
);

/* ---- Per-moment card content ---------------------------------------------- */
function CardContent({ m }: { m: CelebrationMoment }) {
  if (m.kind === 'title') {
    const t = surfaceTheme(m.surface);
    const gold = 'var(--gc-gold)';
    const first = m.firstCareer;
    return (
      <>
        <Confetti colors={first ? [gold, t.color, 'oklch(92% 0.02 95)', 'oklch(83% 0.15 90)'] : [t.color, gold, 'oklch(92% 0.02 95)']} count={first ? 60 : 46} />
        <div style={{ position: 'absolute', inset: 0, background: t.gradient, opacity: 0.5 }} className="gc-cele-glow" />
        <div style={{ position: 'relative', zIndex: 4, padding: '30px 30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 6 }}>
          {first && (
            <div style={{ position: 'absolute', top: 14, right: -46, transform: 'rotate(38deg)', background: gold, color: 'oklch(25% 0.06 90)', fontSize: 10, fontWeight: 900, letterSpacing: '1.5px', padding: '5px 52px', textTransform: 'uppercase', boxShadow: '0 2px 8px oklch(0% 0 0 / 0.4)' }}>First Title</div>
          )}
          <div className="gc-trophy-rise"><Trophy color={gold} size={72} /></div>
          <Eyebrow color={gold}>{first ? 'A Career Begins' : 'Champion'}</Eyebrow>
          <div style={{ marginTop: 6, position: 'relative' }}>
            <Avatar id={m.playerId} name={m.playerName} size={88} ring />
            {first && (
              <div className="gc-seal-pop" style={{ position: 'absolute', right: -12, bottom: -8, width: 40, height: 40, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 35% 30%, oklch(92% 0.15 92), oklch(74% 0.15 88))', color: 'oklch(25% 0.06 90)', fontSize: 13, fontWeight: 900, border: '2px solid oklch(96% 0.02 95)', boxShadow: '0 3px 10px oklch(0% 0 0 / 0.5)' }}>1st</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 24, fontWeight: 850, letterSpacing: '-0.4px', color: 'white', marginTop: 8, textShadow: '0 2px 10px oklch(0% 0 0 / 0.5)' }}>
            <Flag code={m.nationality} size={20} /> {m.playerName}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'oklch(94% 0.02 95)' }}>{m.tournamentName}</div>
          <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'white', background: `linear-gradient(180deg, ${t.color}, ${t.deep})`, padding: '4px 11px', borderRadius: 7, border: '1px solid oklch(100% 0 0 / 0.25)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'oklch(100% 0 0 / 0.9)' }} />{t.label} · Final
          </div>
          <div style={{ marginTop: 12, fontSize: 13.5, lineHeight: 1.5, color: 'oklch(92% 0.01 95)', maxWidth: 340 }}>
            {first ? `${m.playerName} lifts a maiden trophy — the first of a career.` : `${m.playerName} lifts the trophy and takes the title.`}
          </div>
        </div>
      </>
    );
  }

  if (m.kind === 'rank') {
    const isTop1 = m.milestone === 1;
    const cfg = isTop1
      ? { accent: 'var(--gc-gold)', label: 'World No. 1', tag: 'The summit of the game' }
      : m.milestone === 10
        ? { accent: 'oklch(72% 0.14 235)', label: 'Top 10', tag: 'Elite company now' }
        : { accent: 'oklch(70% 0.13 245)', label: 'Top 100', tag: "You're on the board" };
    return (
      <>
        {isTop1 && <Confetti colors={['var(--gc-gold)', 'oklch(92% 0.02 95)', 'oklch(83% 0.15 90)']} count={54} />}
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 50% 0%, ${cfg.accent} / 0.22, transparent 60%)` }} className="gc-cele-glow" />
        <div style={{ position: 'relative', zIndex: 4, padding: '30px 30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
          {isTop1 && <div className="gc-trophy-rise"><Crown color={cfg.accent} size={44} /></div>}
          <Eyebrow color={cfg.accent}>Ranking Milestone</Eyebrow>
          <div className="gc-slam" style={{ display: 'flex', alignItems: 'baseline', gap: 2, color: cfg.accent, textShadow: `0 0 30px ${cfg.accent}` }}>
            <span style={{ fontSize: 34, fontWeight: 800 }}>#</span>
            <span style={{ fontSize: 84, fontWeight: 900, lineHeight: 0.9, letterSpacing: '-3px', fontVariantNumeric: 'tabular-nums' }}>{m.milestone}</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 850, color: 'white', letterSpacing: '0.5px' }}>{cfg.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <Avatar id={m.playerId} name={m.playerName} size={44} ring />
            <div style={{ textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 750, color: 'var(--gc-ink)' }}><Flag code={m.nationality} /> {m.playerName}</div>
              <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)' }}>{BAND_LABEL[m.band]}</div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--gc-ink-dim)', maxWidth: 330 }}>
            {m.playerName} breaks into the {cfg.label.toLowerCase()} — {cfg.tag.toLowerCase()}.
          </div>
        </div>
      </>
    );
  }

  if (m.kind === 'graduation') {
    const green = 'oklch(70% 0.15 148)';
    const steps: Array<'u14' | 'u16' | 'senior'> = ['u14', 'u16', 'senior'];
    const toIdx = steps.indexOf(m.to);
    return (
      <>
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 50% 0%, ${green} / 0.2, transparent 60%)` }} className="gc-cele-glow" />
        <div style={{ position: 'relative', zIndex: 4, padding: '30px 30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
          <div className="gc-trophy-rise" style={{ color: green }}>
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 3l7 6h-4v9h-6v-9H5z" fill={green} stroke="oklch(100% 0 0 / 0.4)" strokeWidth="0.6" strokeLinejoin="round" /></svg>
          </div>
          <Eyebrow color={green}>Moving Up</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <Avatar id={m.playerId} name={m.playerName} size={64} ring />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 19, fontWeight: 800, color: 'var(--gc-ink)' }}><Flag code={m.nationality} size={17} /> {m.playerName}</div>
          {/* Ladder: which circuit the player now competes on */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            {steps.map((s, i) => {
              const reached = i <= toIdx;
              const isTo = i === toIdx;
              return (
                <React.Fragment key={s}>
                  {i > 0 && <span style={{ position: 'relative', width: 26, height: 3, borderRadius: 2, background: 'var(--gc-s3)', overflow: 'hidden' }}>{reached && <span className="gc-step-fill" style={{ position: 'absolute', inset: 0, background: green }} />}</span>}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: isTo ? 'oklch(20% 0.05 150)' : reached ? green : 'var(--gc-ink-faint)', background: isTo ? green : 'var(--gc-s2)', border: `1px solid ${reached ? green : 'var(--gc-line)'}`, boxShadow: isTo ? `0 0 16px ${green}` : 'none' }}>
                    {BAND_LABEL[s].replace(' Circuit', '').replace(' Tour', '')}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.5, color: 'var(--gc-ink-dim)', maxWidth: 330 }}>
            {m.playerName} ages up and graduates to the {BAND_LABEL[m.to].toLowerCase()}. A fresh ranking, tougher fields.
          </div>
        </div>
      </>
    );
  }

  if (m.kind === 'potential') {
    const isElite = m.tier === 'elite';
    const accent = isElite ? 'oklch(66% 0.17 320)' : 'oklch(70% 0.15 250)';
    return (
      <>
        {isElite && <Confetti colors={[accent, 'oklch(85% 0.15 320)', 'var(--gc-gold)', 'oklch(92% 0.02 95)']} count={52} />}
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(120% 90% at 50% 0%, ${accent} / 0.24, transparent 62%)` }} className="gc-cele-glow" />
        <div style={{ position: 'relative', zIndex: 4, padding: '30px 30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
          <div className="gc-trophy-rise"><Crown color={accent} size={40} /></div>
          <Eyebrow color={accent}>Potential Realised</Eyebrow>
          <div style={{ marginTop: 4 }}><Avatar id={m.playerId} name={m.playerName} size={88} ring /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 22, fontWeight: 850, color: 'var(--gc-ink)', marginTop: 6 }}>
            <Flag code={m.nationality} size={19} /> {m.playerName}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>Ceiling</span>
            <span className="gc-slam" style={{ fontSize: 52, fontWeight: 900, lineHeight: 0.9, letterSpacing: '-2px', color: accent, textShadow: `0 0 30px ${accent}`, fontVariantNumeric: 'tabular-nums' }}>~{m.projected}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 850, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'white', background: `linear-gradient(180deg, ${accent}, color-mix(in oklch, ${accent}, black 22%))`, boxShadow: `0 0 20px ${accent}` }}>
              {isElite ? 'Elite' : 'High'}
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--gc-ink-dim)', maxWidth: 340 }}>
            The scouting was right. {m.playerName} has matured into the {isElite ? 'elite' : 'high-ceiling'} prospect the early reads only hinted at.
          </div>
        </div>
      </>
    );
  }

  // claim — keyed off the OBSERVABLE current OVR only (potential is
  // hidden in this RPG and must never surface, even in a celebration).
  const elite = m.overall >= 78;
  const accent = elite ? 'oklch(66% 0.17 320)' : 'oklch(70% 0.13 200)';
  return (
    <>
      {elite && <Confetti colors={[accent, 'oklch(85% 0.15 320)', 'oklch(92% 0.02 95)']} count={40} />}
      <div className="gc-spotlight" style={{ position: 'absolute', top: -40, left: '50%', width: 260, height: 320, transform: 'translateX(-50%)', background: `conic-gradient(from 180deg at 50% 0, transparent 55%, ${accent} / 0.28 68%, transparent 80%)`, filter: 'blur(4px)', zIndex: 2, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', zIndex: 4, padding: '30px 30px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
        <Eyebrow color={accent}>{elite ? 'Marquee Signing' : 'New Signing'}</Eyebrow>
        <div className="gc-trophy-rise" style={{ marginTop: 4 }}><Avatar id={m.playerId} name={m.playerName} size={96} ring /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 22, fontWeight: 850, color: 'var(--gc-ink)', marginTop: 6 }}>
          <Flag code={m.nationality} size={19} /> {m.playerName}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <OvrRing value={m.overall} size={46} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px', borderRadius: 8, fontSize: 12, fontWeight: 850, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'white', background: `linear-gradient(180deg, ${accent}, color-mix(in oklch, ${accent}, black 22%))`, border: '1px solid oklch(100% 0 0 / 0.22)', boxShadow: `0 0 20px ${accent}` }}>
            {m.overall} OVR
          </span>
        </div>
        <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5, color: 'var(--gc-ink-dim)', maxWidth: 330 }}>
          {m.playerName} joins your academy. Where they go from here is up to you — now go develop them.
        </div>
      </div>
    </>
  );
}

function glowFor(m: CelebrationMoment): string {
  if (m.kind === 'title') return m.firstCareer ? 'oklch(80% 0.15 90 / 0.55)' : `${surfaceTheme(m.surface).color} / 0.45`;
  if (m.kind === 'rank') return m.milestone === 1 ? 'oklch(80% 0.15 90 / 0.55)' : 'oklch(65% 0.14 240 / 0.45)';
  if (m.kind === 'graduation') return 'oklch(70% 0.15 148 / 0.45)';
  if (m.kind === 'potential') return m.tier === 'elite' ? 'oklch(66% 0.17 320 / 0.5)' : 'oklch(70% 0.15 250 / 0.45)';
  return m.overall >= 78 ? 'oklch(66% 0.17 320 / 0.5)' : 'oklch(70% 0.13 200 / 0.45)';
}

/**
 * Full-screen celebration interstitial. Renders one moment at a time; if the
 * queue has more, a "Next" button steps through them, else "Done" closes.
 */
export function CelebrationOverlay({ moments, onClose }: { moments: CelebrationMoment[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  if (moments.length === 0) return null;
  const idx = Math.min(i, moments.length - 1);
  const m = moments[idx];
  const more = idx < moments.length - 1;

  return (
    <div className="gc-cele-backdrop" role="dialog" aria-modal="true" onClick={() => (more ? setI(idx + 1) : onClose())}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }} onClick={(e) => e.stopPropagation()}>
        <div key={idx} className="gc-share-card gc-grain" data-share-card data-testid="celebration-card" style={{ ['--_glow' as string]: glowFor(m), background: 'linear-gradient(180deg, var(--gc-s2), var(--gc-s1))' }}>
          <CardContent m={m} />
          <div style={{ position: 'relative', zIndex: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--gc-line)' }}>
            <BrandMark />
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.5px', color: 'var(--gc-ink-faint)' }}>{moments.length > 1 ? `${idx + 1} / ${moments.length}` : 'Share'}</span>
          </div>
        </div>
        <button className="gc-btn gc-btn--primary" onClick={() => (more ? setI(idx + 1) : onClose())} style={{ minWidth: 150 }}>
          {more ? 'Next →' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
