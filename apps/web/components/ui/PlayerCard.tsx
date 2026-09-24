'use client';

import { Flag } from './Flag';
import { Icon } from './Icon';
import type { PlayerTournamentHistoryEntryDto } from '../../lib/api';
import { tournamentHistoryResultLabel } from '../../lib/format';

/* ============================================================================
   Player identity blocks (Direction A: broadcast telemetry)
   Where the player is the SUBJECT (profile hero, replay participants) they
   read as a flat identity plate — flag, name, rank — not as a row in a data
   table. Archetype and H2H are not built yet; every piece here degrades to
   nothing when its data is absent, so this is the seam those features slot
   into later without a rewrite.
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
          ? 'var(--gold)'
          : h.roundsWon === 0
            ? 'var(--loss)'
            : frac >= 0.5
              ? 'var(--win)'
              : 'var(--warn)';
        return (
          <span
            key={`${h.tournamentId}-${i}`}
            title={`${h.name}: ${tournamentHistoryResultLabel(h)}`}
            style={{
              width: size,
              height: size,
              borderRadius: 999,
              background: color,
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
        color: 'var(--hard)',
        background: 'color-mix(in srgb, var(--hard) 20%, transparent)',
        border: '1px solid color-mix(in srgb, var(--hard) 35%, transparent)',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--hard)' }} />
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
        <span className="t-label" style={{ fontSize: 9.5 }}>
          {bandLabel}
        </span>
      )}
      <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-4)' }}>#</span>
      <span
        className="num"
        style={{
          fontSize: 19,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '-0.4px',
          color: nr ? 'var(--ink-4)' : 'var(--ink)',
        }}
      >
        {nr ? 'NR' : rank}
      </span>
      {!nr && points != null && (
        <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{points.toLocaleString()} pts</span>
      )}
    </span>
  );
}

export interface PlayerCardRank {
  rank: number | null;
  points?: number;
  bandLabel?: string;
}

/* ---- Versus plate (match replay participants) ------------------------------
   A facing pair reads as two broadcast identity plates, not two rows of a
   table. The set-by-set scoreboard stays a grid below (comparison is its
   actual job); this is purely the identity band above it. */
export function VersusPlayer({
  name,
  nationality,
  rank,
  form,
  archetype,
  winner,
  decided,
  mirror,
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
        borderRadius: 'var(--r2)',
        background: winner ? 'color-mix(in srgb, var(--win) 8%, transparent)' : 'transparent',
        border: '1px solid',
        borderColor: winner ? 'color-mix(in srgb, var(--win) 35%, transparent)' : 'var(--hair)',
        opacity: dim ? 0.62 : 1,
      }}
    >
      <Flag code={nationality} size={26} />
      <div style={{ minWidth: 0, flex: 1, textAlign: mirror ? 'right' : 'left' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: mirror ? 'row-reverse' : 'row',
            alignItems: 'center',
            gap: 8,
            fontWeight: winner ? 800 : 700,
            fontSize: 17,
            letterSpacing: '-0.2px',
            color: 'var(--ink)',
          }}
        >
          {winner && (
            <span style={{ display: 'inline-flex', color: 'var(--gold)' }} title="Winner">
              <Icon name="trophy" size={14} />
            </span>
          )}
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
          {rank && <RankPill rank={rank.rank} points={rank.points} bandLabel={rank.bandLabel} />}
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
