/**
 * Footer hints shared by the game-setup screens (quick game, watch mode, custom game, practice): left / right
 * changes the highlighted value, the start button (Enter / START) starts from any row, confirm starts only on
 * the START row (on a value row it steps the value, so the footer never promises that it starts).
 */
import type { Action } from '../input/types';
import type { ButtonHint } from './panel';

/** Hints for a setup screen; `onStartRow` shows confirm as the start key while the START row is highlighted. */
export const setupHints = (input: { glyph(action: Action): string } | null, onStartRow: boolean, startLabel = 'START'): ButtonHint[] => [
  { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'CHANGE' },
  { glyph: onStartRow ? input?.glyph('confirm') ?? 'A' : input?.glyph('pause') ?? 'START', label: startLabel },
  { glyph: input?.glyph('back') ?? 'B', label: 'BACK' },
];
