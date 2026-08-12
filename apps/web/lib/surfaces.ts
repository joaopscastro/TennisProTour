/** Surface (court) theme tokens — the environmental color system from
 *  ui-direction-v2-game-feel.md. Surface colors are used as *environment*
 *  (hero gradients, screen atmosphere), not just small badges. One source
 *  of truth for clay/grass/hard/indoor across every screen. */

export type SurfaceKey = 'clay' | 'grass' | 'hard' | 'indoor';

export interface SurfaceTheme {
  key: SurfaceKey;
  label: string;
  letter: string;
  /** Bright environment color. */
  color: string;
  /** Deep environment color (shadowed edge of a gradient). */
  deep: string;
  /** A ready-made hero/environment background gradient. */
  gradient: string;
  /** A subtle screen-wide wash gradient (very low chroma bleed). */
  wash: string;
}

const THEMES: Record<SurfaceKey, SurfaceTheme> = {
  clay: {
    key: 'clay', label: 'Clay', letter: 'C',
    color: 'var(--sf-clay)', deep: 'var(--sf-clay-d)',
    gradient: 'linear-gradient(135deg, oklch(52% 0.15 46) 0%, oklch(40% 0.13 40) 55%, oklch(28% 0.09 38) 100%)',
    wash: 'radial-gradient(120% 90% at 80% -20%, oklch(52% 0.15 46 / 0.28), transparent 60%)',
  },
  grass: {
    key: 'grass', label: 'Grass', letter: 'G',
    color: 'var(--sf-grass)', deep: 'var(--sf-grass-d)',
    gradient: 'linear-gradient(135deg, oklch(52% 0.15 150) 0%, oklch(38% 0.12 152) 55%, oklch(26% 0.08 155) 100%)',
    wash: 'radial-gradient(120% 90% at 80% -20%, oklch(52% 0.14 150 / 0.26), transparent 60%)',
  },
  hard: {
    key: 'hard', label: 'Hard', letter: 'H',
    color: 'var(--sf-hard)', deep: 'var(--sf-hard-d)',
    gradient: 'linear-gradient(135deg, oklch(52% 0.14 248) 0%, oklch(38% 0.12 255) 55%, oklch(25% 0.08 262) 100%)',
    wash: 'radial-gradient(120% 90% at 80% -20%, oklch(52% 0.14 248 / 0.26), transparent 60%)',
  },
  indoor: {
    key: 'indoor', label: 'Indoor', letter: 'I',
    color: 'var(--sf-indoor)', deep: 'var(--sf-indoor-d)',
    gradient: 'linear-gradient(135deg, oklch(50% 0.13 305) 0%, oklch(36% 0.11 310) 55%, oklch(24% 0.08 315) 100%)',
    wash: 'radial-gradient(120% 90% at 80% -20%, oklch(50% 0.13 305 / 0.26), transparent 60%)',
  },
};

export function surfaceTheme(surface: string | null | undefined): SurfaceTheme {
  const key = (surface ?? '').toLowerCase() as SurfaceKey;
  return THEMES[key] ?? THEMES.hard;
}

export const ALL_SURFACES: SurfaceTheme[] = [THEMES.clay, THEMES.grass, THEMES.hard, THEMES.indoor];
