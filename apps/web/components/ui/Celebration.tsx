'use client';

import { useState } from 'react';
import { Flag } from './Flag';
import { Icon } from './Icon';

/* ============================================================================
   Celebration moments (GC-16, docs/ui-direction-v2-game-feel.md)
   Five celebration moments, each fired from an existing domain signal (no new
   backend concepts):
     - title            → TournamentCompleted (a champion is decided)
     - title/firstCareer → same event, escalated when it's the player's 1st
     - rank             → peak-ranking crossing top 100 / 10 / 1
     - graduation       → U14→U16 / U16→U18 / U18→senior band change on the tick
     - claim            → claiming a high-/elite-potential prospect
   Direction A renders each as a STATIC broadcast result card: eyebrow, display
   headline, player identity (flag + name + band), a mono figure, and the
   honest one-line caption. No confetti, no spotlight, no trophy art, no
   entrance animation. The card is a fixed-size `.gc-share-card` node
   (data-share-card) so a later share pipeline (GC-12) can screenshot exactly
   that frame — visual only, no upload/sharing wiring here.
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
      band: 'senior' | 'u14' | 'u16' | 'u18';
      playerId: string;
      playerName: string;
      nationality: string;
    }
  | {
      kind: 'graduation';
      from: 'u14' | 'u16' | 'u18';
      to: 'u16' | 'u18' | 'senior';
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

const BAND_LABEL: Record<string, string> = { senior: 'Senior Tour', u14: 'U14 Circuit', u16: 'U16 Circuit', u18: 'U18 Circuit' };

const accentFor = (m: CelebrationMoment): string => {
  if (m.kind === 'title') return 'var(--gold)';
  if (m.kind === 'rank') return m.milestone === 1 ? 'var(--gold)' : 'var(--hard)';
  if (m.kind === 'graduation') return 'var(--win)';
  if (m.kind === 'potential') return m.tier === 'elite' ? 'var(--gold)' : 'var(--hard)';
  // claim — keyed off the OBSERVABLE current OVR only (potential is hidden
  // in this RPG and must never surface, even in a celebration).
  return m.overall >= 78 ? 'var(--gold)' : 'var(--hard)';
};

/** One static card per moment — no art, no motion; the figure carries it. */
function CardBody({ m }: { m: CelebrationMoment }) {
  if (m.kind === 'title') {
    const first = m.firstCareer;
    return (
      <>
        <div className="t-label">{first ? 'A Career Begins' : 'Champion'}</div>
        <div className="t-h2" style={{ marginTop: 6, color: 'var(--ink)' }}>{m.tournamentName}</div>
        <div className="t-mono-s" style={{ marginTop: 6, color: 'var(--ink-3)' }}>
          {m.surface} · Final{first ? ' · First title' : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, fontSize: 20, fontWeight: 700 }}>
          <Flag code={m.nationality} size={20} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.playerName}</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
          {first ? `${m.playerName} lifts a maiden trophy — the first of a career.` : `${m.playerName} lifts the trophy and takes the title.`}
        </div>
      </>
    );
  }

  if (m.kind === 'rank') {
    const isTop1 = m.milestone === 1;
    const cfg = isTop1
      ? { label: 'World No. 1', tag: 'The summit of the game' }
      : m.milestone === 10
        ? { label: 'Top 10', tag: 'Elite company now' }
        : { label: 'Top 100', tag: "You're on the board" };
    return (
      <>
        <div className="t-label">Ranking Milestone</div>
        <div
          className="num"
          style={{ marginTop: 8, fontSize: 56, fontWeight: 700, lineHeight: 1, letterSpacing: '-2px', color: accentFor(m) }}
        >
          #{m.milestone}
        </div>
        <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>{cfg.label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 17, fontWeight: 700 }}>
          <Flag code={m.nationality} size={17} />
          <span>{m.playerName}</span>
          <span className="t-label" style={{ fontSize: 10 }}>{BAND_LABEL[m.band]}</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
          {m.playerName} breaks into the {cfg.label.toLowerCase()} — {cfg.tag.toLowerCase()}.
        </div>
      </>
    );
  }

  if (m.kind === 'graduation') {
    return (
      <>
        <div className="t-label">Moving Up</div>
        <div className="t-h2 num" style={{ marginTop: 8, color: accentFor(m) }}>
          {m.from.toUpperCase()} &rarr; {m.to === 'senior' ? 'SENIOR' : m.to.toUpperCase()}
        </div>
        <div style={{ marginTop: 6, fontSize: 15, fontWeight: 600, color: 'var(--ink-2)' }}>{BAND_LABEL[m.to]}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 18, fontWeight: 700 }}>
          <Flag code={m.nationality} size={18} />
          <span>{m.playerName}</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
          {m.playerName} ages up and graduates to the {BAND_LABEL[m.to].toLowerCase()}. A fresh ranking, tougher fields.
        </div>
      </>
    );
  }

  if (m.kind === 'potential') {
    const isElite = m.tier === 'elite';
    return (
      <>
        <div className="t-label">Potential Realised</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
          <span className="num" style={{ fontSize: 48, fontWeight: 700, lineHeight: 1, letterSpacing: '-2px', color: accentFor(m) }}>
            ~{m.projected}
          </span>
          <span className="gc-badge" style={{ color: accentFor(m), borderColor: `color-mix(in srgb, ${accentFor(m)} 45%, transparent)` }}>
            {isElite ? 'Elite' : 'High'}
          </span>
        </div>
        <div className="t-label" style={{ marginTop: 6 }}>Ceiling</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 18, fontWeight: 700 }}>
          <Flag code={m.nationality} size={18} />
          <span>{m.playerName}</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
          The scouting was right. {m.playerName} has matured into the {isElite ? 'elite' : 'high-ceiling'} prospect the early reads only hinted at.
        </div>
      </>
    );
  }

  // claim — keyed off the OBSERVABLE current OVR only (potential is hidden
  // in this RPG and must never surface, even in a celebration).
  const elite = m.overall >= 78;
  return (
    <>
      <div className="t-label">{elite ? 'Marquee Signing' : 'New Signing'}</div>
      <div className="t-h2" style={{ marginTop: 6 }}>{m.playerName}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
        <span className="num" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, color: accentFor(m) }}>{m.overall}</span>
        <span className="t-label">OVR</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, fontSize: 15, fontWeight: 600, color: 'var(--ink-2)' }}>
        <Flag code={m.nationality} size={16} />
        <span>{m.playerName}</span>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
        {m.playerName} joins your academy. Where they go from here is up to you — now go develop them.
      </div>
    </>
  );
}

/**
 * Full-screen celebration overlay. Renders one static result card at a
 * time; if the queue has more, a "Next" button steps through them, else
 * "Continue" closes.
 */
export function CelebrationOverlay({ moments, onClose }: { moments: CelebrationMoment[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  if (moments.length === 0) return null;
  const idx = Math.min(i, moments.length - 1);
  const m = moments[idx];
  const more = idx < moments.length - 1;
  const step = () => (more ? setI(idx + 1) : onClose());

  return (
    <div className="gc-modal-backdrop" role="dialog" aria-modal="true" onClick={step}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }} onClick={(e) => e.stopPropagation()}>
        <div
          className="gc-share-card"
          data-share-card
          data-testid="celebration-card"
          style={{ ['--share-accent' as string]: accentFor(m) }}
        >
          <div style={{ padding: '26px 26px 22px' }}>
            <CardBody m={m} />
          </div>
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 18px', borderTop: '1px solid var(--hair)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.8 }}>
              <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="ball" size={13} /></span>
              <span className="t-label" style={{ fontSize: 9.5, letterSpacing: '2px' }}>Grand Circuit</span>
            </span>
            <span className="t-mono-s" style={{ color: 'var(--ink-4)' }}>{moments.length > 1 ? `${idx + 1} / ${moments.length}` : 'Share'}</span>
          </div>
        </div>
        <button className="gc-btn gc-btn--primary" onClick={step} style={{ minWidth: 150, justifyContent: 'center' }}>
          {more ? 'Next →' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
