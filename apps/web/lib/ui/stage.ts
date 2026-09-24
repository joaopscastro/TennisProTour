import type { PlayerLifecycleStage } from '../api';

/** The ONE dark-theme stage palette (the roster dashboard's version, which
 *  every screen now shares — the old light-theme copy in lib/format.ts is
 *  deleted). Token-based so it tracks the Direction A palette. */

export interface StageMeta {
  bg: string;
  fg: string;
  noteColor: string;
}

export function stageMeta(stage: PlayerLifecycleStage): StageMeta {
  if (stage === 'prime') {
    return { bg: 'color-mix(in srgb, var(--win) 20%, transparent)', fg: 'var(--win)', noteColor: 'var(--ink-3)' };
  }
  if (stage === 'decline') {
    return { bg: 'color-mix(in srgb, var(--warn) 20%, transparent)', fg: 'var(--warn)', noteColor: 'var(--warn)' };
  }
  if (stage === 'retired') {
    return { bg: 'var(--bg-3)', fg: 'var(--ink-3)', noteColor: 'var(--ink-4)' };
  }
  return { bg: 'color-mix(in srgb, var(--hard) 20%, transparent)', fg: 'var(--hard)', noteColor: 'var(--ink-3)' };
}

export function stageLabel(stage: PlayerLifecycleStage): string {
  return stage[0].toUpperCase() + stage.slice(1);
}
