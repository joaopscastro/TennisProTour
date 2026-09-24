/** Surface (court) reference — the ONE source of truth for clay/grass/hard/
 *  indoor across every screen. Colour is a token value only (Direction A:
 *  colour encodes surface, never a page background), so the same key can
 *  drive a dot, a badge, a border or a chart with no gradient copies. */

export type SurfaceKey = 'clay' | 'grass' | 'hard' | 'indoor';

export const ALL_SURFACES: SurfaceKey[] = ['clay', 'grass', 'hard', 'indoor'];

/** Token value per surface — no gradients, no per-screen copies. Typed with
 *  a string index signature so the pre-existing call sites' own
 *  `SURFACE_COLOR[x] ?? fallback` pattern (unknown surfaces included) keeps
 *  working unchanged; new code should prefer `surfaceMeta()`. */
export const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--clay)',
  grass: 'var(--grass)',
  hard: 'var(--hard)',
  indoor: 'var(--indoor)',
};

export interface SurfaceMeta {
  key: SurfaceKey;
  label: string;
  letter: string;
  color: string;
}

const SURFACE_META: Record<SurfaceKey, SurfaceMeta> = {
  clay: { key: 'clay', label: 'Clay', letter: 'C', color: SURFACE_COLOR.clay },
  grass: { key: 'grass', label: 'Grass', letter: 'G', color: SURFACE_COLOR.grass },
  hard: { key: 'hard', label: 'Hard', letter: 'H', color: SURFACE_COLOR.hard },
  indoor: { key: 'indoor', label: 'Indoor', letter: 'I', color: SURFACE_COLOR.indoor },
};

/** Coerce any surface string (unknown/null included) to a known key — an
 *  unknown surface is 'hard', the neutral default the old theme used. */
export function surfaceKeyFor(surface: string | null | undefined): SurfaceKey {
  const key = (surface ?? '').toLowerCase() as SurfaceKey;
  return ALL_SURFACES.includes(key) ? key : 'hard';
}

export function surfaceMeta(surface: string | null | undefined): SurfaceMeta {
  return SURFACE_META[surfaceKeyFor(surface)];
}

