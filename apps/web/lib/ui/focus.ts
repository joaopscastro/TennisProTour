import type { TrainingFocus } from '../api';
import { ALL_SURFACES } from './surfaces';

/** Training-focus reference data + labels, shared by the roster dashboard
 *  and the player profile (they each carried a copy before).
 *
 *  Single-attribute selection (see docs/training-redesign-per-attribute.md)
 *  — no "Mental" group at all: mental attributes are never a training
 *  target, enforced at the type level by TrainableAttribute, so there is no
 *  `focus` value this module could even construct for one. */

export interface FocusOption {
  label: string;
  focus: TrainingFocus;
}

export const FOCUS_GROUPS: Array<{ label: string; options: FocusOption[] }> = [
  {
    label: 'Surface',
    options: ALL_SURFACES.map((key) => ({
      label: key[0].toUpperCase() + key.slice(1),
      focus: { kind: 'surface', surface: key },
    })),
  },
  {
    label: 'Technical',
    options: [
      { label: 'Serve', focus: { kind: 'attribute', attribute: 'serve' } },
      { label: 'Forehand', focus: { kind: 'attribute', attribute: 'forehand' } },
      { label: 'Backhand', focus: { kind: 'attribute', attribute: 'backhand' } },
      { label: 'Volley', focus: { kind: 'attribute', attribute: 'volley' } },
    ],
  },
  {
    label: 'Physical',
    options: [
      { label: 'Speed', focus: { kind: 'attribute', attribute: 'speed' } },
      { label: 'Stamina', focus: { kind: 'attribute', attribute: 'stamina' } },
      { label: 'Strength', focus: { kind: 'attribute', attribute: 'strength' } },
    ],
  },
];

export function trainingFocusLabel(focus: TrainingFocus | null, emptyLabel = 'Set focus'): string {
  if (!focus) return emptyLabel;
  if (focus.kind === 'surface') return focus.surface[0].toUpperCase() + focus.surface.slice(1);
  return focus.attribute[0].toUpperCase() + focus.attribute.slice(1);
}

export function focusEquals(a: TrainingFocus | null, b: TrainingFocus): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'surface' && b.kind === 'surface'
    ? a.surface === b.surface
    : (a as { attribute: string }).attribute === (b as { attribute: string }).attribute;
}
