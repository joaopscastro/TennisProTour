'use client';

import React from 'react';
import Link from 'next/link';
import { Avatar } from './Avatar';
import { Flag, OvrRing } from './primitives';
import type { PlayerTournamentHistoryEntryDto } from '../../lib/api';
import { tournamentHistoryResultLabel } from '../../lib/format';

/* ============================================================================
   Player cards (GC-17, docs/ui-direction-v2-game-feel.md)
   Where the player is the SUBJECT (scouting, profile header, replay
   participants) they should read as character cards — prominent avatar,
   identity, rank, recent form, archetype (GC-10), head-to-head (GC-6) — not
   as a row in a data table. Archetype and H2H are not built yet; every piece
   here degrades to nothing when its data is absent, so this is the seam those
   features slot into later without a rewrite.
   ============================================================================ */

/* ---- Recent form -----------------------------------------------------------
   A compact run of the player's most-recent COMPLETED tournament results
   (most recent first). Gold = title, green = deep run, amber = early exit,
   red = first-round loss. Returns null when there's no completed history yet
   (unsigned prospects, brand-new players) so the caller can omit the row. */
export function FormDots({
  history,
  max = 5,
  size = 9,
}: {
  history: PlayerTournamentHistoryEntryDto[] | undefined | null;
  max?: number;
  size?: number;
}) {
  const completed = (history ?? []).filter((h) => h.hasStarted && (h.won || h.eliminated)).slice(0, max);
  if (completed.length === 0) return null;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} aria-label="Recent form">
      {completed.map((h, i) => {
        const totalRounds = Math.max(1, Math.round(Math.log2(h.drawSize || 2)));
        const frac = h.roundsWon / totalRounds;
        const color = h.won
          ? 'var(--gc-gold)'
          : h.roundsWon === 0
            ? 'oklch(62% 0.17 25)'
            : frac >= 0.5
              ? 'oklch(68% 0.15 148)'
              : 'oklch(72% 0.12 70)';
        return (
          <span
            key={`${h.tournamentId}-${i}`}
            title={`${h.name}: ${tournamentHistoryResultLabel(h)}`}
            style={{
              width: size,
              height: size,
              borderRadius: 999,
              background: color,
              boxShadow: h.won ? `0 0 7px ${color}` : 'none',
              flex: 'none',
            }}
          />
        );
      })}
    </div>
  );
}

/* ---- Archetype (GC-10 — not built; degrades to null) ---------------------- */
export function ArchetypeBadge({ archetype }: { archetype?: string | null }) {
  if (!archetype) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 750,
        letterSpacing: '0.3px',
        color: 'oklch(86% 0.1 265)',
        background: 'oklch(45% 0.11 265 / 0.3)',
        border: '1px solid oklch(60% 0.12 265 / 0.4)',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: 'oklch(78% 0.13 265)' }} />
      {archetype}
    </span>
  );
}

/* ---- Compact rank pill ----------------------------------------------------- */
export function RankPill({
  rank,
  points,
  bandLabel,
}: {
  rank: number | null | undefined;
  points?: number;
  bandLabel?: string;
}) {
  const nr = rank == null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      {bandLabel && (
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--gc-ink-faint)' }}>
          {bandLabel}
        </span>
      )}
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-faint)' }}>#</span>
      <span
        style={{
          fontSize: 19,
          fontWeight: 850,
          lineHeight: 1,
          letterSpacing: '-0.4px',
          color: nr ? 'var(--gc-ink-faint)' : 'var(--gc-gold)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {nr ? 'NR' : rank}
      </span>
      {!nr && points != null && (
        <span style={{ fontSize: 11, color: 'var(--gc-ink-mute)', fontVariantNumeric: 'tabular-nums' }}>{points.toLocaleString()} pts</span>
      )}
    </span>
  );
}

export interface PlayerCardRank {
  rank: number | null;
  points?: number;
  bandLabel?: string;
}

/* ---- Full subject card (scouting listings, general use) -------------------
   Identity-forward: a large avatar and name lead; stats/actions follow. */
export function PlayerCard({
  id,
  name,
  nationality,
  avatarSize = 66,
  subtitle,
  ovr,
  rank,
  archetype,
  form,
  h2h,
  badges,
  footer,
  accent,
  hover,
  href,
  className = '',
  style,
}: {
  id: string;
  name: string;
  nationality: string;
  avatarSize?: number;
  subtitle?: React.ReactNode;
  ovr?: number;
  rank?: PlayerCardRank;
  archetype?: string | null;
  form?: PlayerTournamentHistoryEntryDto[] | null;
  h2h?: React.ReactNode;
  badges?: React.ReactNode;
  footer?: React.ReactNode;
  accent?: string;
  hover?: boolean;
  href?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hasForm = (form ?? []).some((h) => h.hasStarted && (h.won || h.eliminated));
  const identity = (
    <>
      <Avatar id={id} name={name} size={avatarSize} ring />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 17, letterSpacing: '-0.2px' }}>
          <Flag code={nationality} size={16} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        </div>
        {subtitle != null && (
          <div style={{ fontSize: 11.5, color: 'var(--gc-ink-faint)', marginTop: 3 }}>{subtitle}</div>
        )}
        {archetype ? (
          <div style={{ marginTop: 7 }}>
            <ArchetypeBadge archetype={archetype} />
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      className={`gc-card gc-grain ${hover ? 'gc-card--hover' : ''} ${className}`}
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13, borderColor: accent, ...style }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {href ? (
          <Link
            href={href}
            className="gc-identity-link"
            style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}
          >
            {identity}
          </Link>
        ) : (
          identity
        )}
        {ovr != null && <OvrRing value={ovr} size={50} />}
      </div>

      {(rank || hasForm) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          {rank ? <RankPill rank={rank.rank} points={rank.points} bandLabel={rank.bandLabel} /> : <span />}
          {hasForm && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--gc-ink-faint)' }}>Form</span>
              <FormDots history={form} />
            </div>
          )}
        </div>
      )}

      {badges}
      {h2h}
      {footer && <div style={{ marginTop: 'auto', paddingTop: 4 }}>{footer}</div>}
    </div>
  );
}

/* ---- Versus card (match replay participants) ------------------------------
   A facing pair reads as two players squaring off, not two rows of a table.
   The set-by-set scoreboard stays a grid below (comparison is its actual job);
   this is purely the identity band above it. */
export function VersusPlayer({
  id,
  name,
  nationality,
  rank,
  form,
  archetype,
  winner,
  decided,
  mirror,
  accent,
}: {
  id: string;
  name: string;
  nationality: string;
  rank?: PlayerCardRank;
  form?: PlayerTournamentHistoryEntryDto[] | null;
  archetype?: string | null;
  winner?: boolean;
  decided?: boolean;
  mirror?: boolean;
  accent?: string;
}) {
  const dim = decided && !winner;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: mirror ? 'row-reverse' : 'row',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        borderRadius: 12,
        background: winner
          ? `linear-gradient(${mirror ? '270deg' : '90deg'}, oklch(100% 0 0 / 0.06), transparent)`
          : 'transparent',
        border: '1px solid',
        borderColor: winner ? (accent ?? 'var(--gc-gold)') : 'var(--gc-line)',
        boxShadow: winner ? `0 0 22px -6px ${accent ?? 'var(--gc-gold)'}` : 'none',
        opacity: dim ? 0.62 : 1,
        transition: 'opacity 0.4s ease',
      }}
    >
      <div style={{ position: 'relative', flex: 'none' }}>
        <Avatar id={id} name={name} size={62} ring={!!winner} />
        {winner && (
          <span
            style={{
              position: 'absolute',
              bottom: -6,
              [mirror ? 'left' : 'right']: -6,
              width: 24,
              height: 24,
              borderRadius: 999,
              display: 'grid',
              placeItems: 'center',
              background: 'radial-gradient(circle at 35% 30%, oklch(92% 0.15 92), oklch(74% 0.15 88))',
              border: '2px solid var(--gc-s1)',
              boxShadow: '0 2px 6px oklch(0% 0 0 / 0.5)',
            }}
            title="Winner"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 4h12v3a6 6 0 0 1-12 0z" fill="oklch(30% 0.06 90)" />
              <path d="M9.5 15.5h5l.6 3.5h-6.2zM8.5 19h7" stroke="oklch(30% 0.06 90)" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1, textAlign: mirror ? 'right' : 'left' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: mirror ? 'row-reverse' : 'row',
            alignItems: 'center',
            gap: 8,
            fontWeight: winner ? 850 : 750,
            fontSize: 17,
            letterSpacing: '-0.2px',
            color: 'var(--gc-ink)',
          }}
        >
          <Flag code={nationality} size={16} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: mirror ? 'row-reverse' : 'row',
            alignItems: 'center',
            gap: 10,
            marginTop: 6,
            flexWrap: 'wrap',
          }}
        >
          {rank && <RankPill rank={rank.rank} points={rank.points} />}
          <FormDots history={form} max={5} />
        </div>
        {archetype ? (
          <div style={{ marginTop: 7, display: 'flex', flexDirection: mirror ? 'row-reverse' : 'row' }}>
            <ArchetypeBadge archetype={archetype} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
