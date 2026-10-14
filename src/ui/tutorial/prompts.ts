/**
 * Tutorial prompt text: `{action}` tokens are replaced with the glyph currently bound to that action on the
 * last-used device (InputManager.glyph), so keyboard, gamepad and touch players each read their own buttons.
 * `{move}` names the movement control for the device (WASD-style keys, the left stick or the touch stick); `{aim}` and
 * `{aimLob}` name the pull-back pass's aim and lob switch.
 */
import { isAction } from '../input/schemes';
import type { Action, InputManager, InputState } from '../input/types';

const TOKEN = /\{([A-Za-z0-9]+)\}/g;

/** Glyph source a prompt needs: the bound glyph per action and the last device. */
export type GlyphSource = Pick<InputManager, 'glyph' | 'state'>;

/** Name of the movement control on a device. */
export const moveGlyph = (device: InputState['lastDevice'], glyph: (a: Action) => string): string => {
  if (device === 'gamepad') return 'L-STICK';
  if (device === 'touch') return 'STICK';
  const keys = [glyph('moveUp'), glyph('moveLeft'), glyph('moveDown'), glyph('moveRight')];
  return keys.every((k) => k.length === 1) ? keys.join('') : keys.join(' ');
};

/** Name of the pull-back pass aim on a device ({aim}). */
export const aimGlyph = (device: InputState['lastDevice'], glyph: (a: Action) => string): string => {
  if (device === 'gamepad') return 'R-STICK';
  if (device === 'touch') return 'PULL BACK';
  if (device === 'mouse') return 'DRAG BACK';
  return `${glyph('throwModifier')}+${moveGlyph(device, glyph)}`;
};

/** Name of the pull-back pass's lob switch on a device ({aimLob}). */
export const aimLobGlyph = (device: InputState['lastDevice'], glyph: (a: Action) => string): string => {
  if (device === 'gamepad') return glyph('throwModifier');
  if (device === 'touch') return '2ND FINGER';
  // Keyboard: sprint (Shift) is the bullet button now (throw-aim BULLET_ACTION); the reticle's lob switch is the right mouse button.
  return 'RIGHT BUTTON';
};

const SPECIAL: Readonly<Record<string, (device: InputState['lastDevice'], glyph: (a: Action) => string) => string>> = {
  move: moveGlyph, aim: aimGlyph, aimLob: aimLobGlyph,
};

/** Every `{token}` in a text, in order. */
export const promptTokens = (text: string): string[] => Array.from(text.matchAll(TOKEN), (m) => m[1] as string);

/** True for a token the formatter understands (`move`, `aim`, `aimLob` or an Action name). */
export const isPromptToken = (token: string): boolean => Object.prototype.hasOwnProperty.call(SPECIAL, token) || isAction(token);

/** Replaces the tokens of `text` with bracketed glyphs from `input`; unknown tokens are left untouched. */
export const formatPrompt = (text: string, input: GlyphSource): string => {
  const device = input.state().lastDevice;
  return text.replace(TOKEN, (whole, token: string) => {
    const special = Object.prototype.hasOwnProperty.call(SPECIAL, token) ? SPECIAL[token] : undefined;
    if (special) return `[${special(device, (a) => input.glyph(a))}]`;
    return isAction(token) ? `[${input.glyph(token)}]` : whole;
  });
};
