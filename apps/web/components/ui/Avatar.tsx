'use client';

/** Illustrated procedural avatar (ui-direction-v2-game-feel.md §4 "Character").
 *
 *  REPLACES the old flat initials-in-a-colored-square. That was fine at 32px
 *  in a table but reads as a placeholder at the larger sizes this redesign
 *  uses everywhere (player cards, profile hero). This generates a clean,
 *  flat-vector PORTRAIT — skin tone, hair style/color, brows, eyes, mouth,
 *  and a tennis sweatband — deterministically from the player id, so a given
 *  player always looks like themselves. No external asset, no network, SSR-safe
 *  (pure function of the id), and crisp at any size because it's SVG.
 */

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const SKINS = [
  ['#f2d2b8', '#e0b18f'], ['#eac3a0', '#d29a72'], ['#d9a679', '#bd8354'],
  ['#c88f5f', '#a86e3e'], ['#a4693c', '#824d29'], ['#7a4a2b', '#5d341c'],
  ['#f6dcc4', '#e7bd9e'],
];
const HAIRS = [
  '#2b2320', '#4a3626', '#6b4a2e', '#8a5a2b', '#101010', '#c9a24a',
  '#8a8f96', '#b5651d', '#2c2f36', '#e2e2e2',
];
const BG_HUES = [46, 150, 248, 305, 20, 122, 270, 200];
const BAND_COLORS = ['var(--sf-clay)', 'var(--sf-grass)', 'var(--sf-hard)', 'var(--sf-indoor)', 'var(--gc-ball)'];

export interface AvatarProps {
  id: string;
  name?: string;
  size?: number;
  /** Show the outer ring / frame. */
  ring?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function Avatar({ id, name, size = 44, ring = true, className, style }: AvatarProps) {
  const r = rng(hash(id));
  const [skin, skinShade] = SKINS[Math.floor(r() * SKINS.length)];
  const hair = HAIRS[Math.floor(r() * HAIRS.length)];
  const hue = BG_HUES[Math.floor(r() * BG_HUES.length)];
  const hairStyle = Math.floor(r() * 6); // 0 short,1 buzz,2 top,3 curly,4 long,5 bald
  const hasBand = r() > 0.55;
  const band = BAND_COLORS[Math.floor(r() * BAND_COLORS.length)];
  const smile = r() > 0.5;
  const browY = 30 + Math.floor(r() * 3);
  const uid = `av${hash(id).toString(36)}`;

  const bgTop = `oklch(58% 0.11 ${hue})`;
  const bgBot = `oklch(34% 0.08 ${hue})`;

  return (
    <div
      className={className}
      style={{
        width: size, height: size, flex: 'none', borderRadius: '26%',
        overflow: 'hidden', position: 'relative',
        border: ring ? '1.5px solid oklch(100% 0 0 / 0.16)' : 'none',
        boxShadow: ring ? '0 1px 0 oklch(100% 0 0 / 0.14) inset, 0 4px 10px oklch(0% 0 0 / 0.35)' : 'none',
        ...style,
      }}
      aria-label={name ? `${name} portrait` : 'player portrait'}
      role="img"
    >
      <svg viewBox="0 0 64 64" width={size} height={size} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={`${uid}bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={bgTop} />
            <stop offset="1" stopColor={bgBot} />
          </linearGradient>
          <linearGradient id={`${uid}sk`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={skin} />
            <stop offset="1" stopColor={skinShade} />
          </linearGradient>
        </defs>

        <rect width="64" height="64" fill={`url(#${uid}bg)`} />
        {/* soft spotlight */}
        <ellipse cx="32" cy="20" rx="30" ry="22" fill="#fff" opacity="0.10" />

        {/* shoulders */}
        <path d="M12 64 C12 50 22 45 32 45 C42 45 52 50 52 64 Z" fill="oklch(30% 0.02 260)" />
        <path d="M12 64 C12 50 22 45 32 45 C42 45 52 50 52 64 Z" fill="#000" opacity="0.15" />

        {/* neck */}
        <rect x="27" y="38" width="10" height="10" rx="4" fill={skinShade} />

        {/* head */}
        <ellipse cx="32" cy="28" rx="13" ry="14.5" fill={`url(#${uid}sk)`} />
        {/* ears */}
        <circle cx="19.5" cy="29" r="2.4" fill={skinShade} />
        <circle cx="44.5" cy="29" r="2.4" fill={skinShade} />

        {/* hair */}
        {hairStyle !== 5 && (
          <g fill={hair}>
            {hairStyle === 0 && <path d="M18 26 C18 14 46 14 46 26 C46 20 42 16 32 16 C22 16 18 20 18 26 Z" />}
            {hairStyle === 1 && <path d="M19 25 C19 16 45 16 45 25 C45 22 44 18 32 18 C20 18 19 22 19 25 Z" opacity="0.92" />}
            {hairStyle === 2 && <path d="M20 24 C22 12 42 12 44 24 C44 19 40 14 32 14 C25 14 22 17 20 24 Z" />}
            {hairStyle === 3 && (
              <g>
                <circle cx="22" cy="20" r="5" /><circle cx="28" cy="16" r="5.5" />
                <circle cx="36" cy="16" r="5.5" /><circle cx="42" cy="20" r="5" />
                <circle cx="19" cy="26" r="4" /><circle cx="45" cy="26" r="4" />
              </g>
            )}
            {hairStyle === 4 && <path d="M17 40 C15 22 20 13 32 13 C44 13 49 22 47 40 L43 40 C45 24 42 18 32 18 C22 18 19 24 21 40 Z" />}
          </g>
        )}

        {/* sweatband */}
        {hasBand && <rect x="18.5" y="20" width="27" height="5.4" rx="2.6" fill={band} stroke="#000" strokeOpacity="0.12" />}

        {/* brows */}
        <g stroke={hair} strokeWidth="1.5" strokeLinecap="round">
          <path d={`M25 ${browY} q3 -2 6 0`} fill="none" />
          <path d={`M33 ${browY} q3 -2 6 0`} fill="none" />
        </g>

        {/* eyes */}
        <g fill="#2a2320">
          <circle cx="27.5" cy="33.5" r="1.9" />
          <circle cx="36.5" cy="33.5" r="1.9" />
        </g>
        <g fill="#fff" opacity="0.9">
          <circle cx="28.1" cy="32.9" r="0.6" />
          <circle cx="37.1" cy="32.9" r="0.6" />
        </g>

        {/* nose */}
        <path d="M32 34 l-1.4 4 q1.4 1 2.8 0" fill="none" stroke={skinShade} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />

        {/* mouth */}
        {smile
          ? <path d="M28 41 q4 3.5 8 0" fill="none" stroke="#8a4038" strokeWidth="1.6" strokeLinecap="round" />
          : <path d="M28.5 41.5 h7" fill="none" stroke="#8a4038" strokeWidth="1.6" strokeLinecap="round" />}
      </svg>
    </div>
  );
}
