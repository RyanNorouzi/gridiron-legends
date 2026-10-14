import type { Action, Button, ControlScheme, DeviceMap, InputState, KeyCode } from './types';
import { keysFor } from './schemes';

/**
 * Button glyph tables per device, used by on-screen prompts ("Press A to snap"). Labels are plain text so the
 * HUD can render them in its pixel font; the renderer may swap known labels for icon sprites.
 */

/** Xbox-style labels for the virtual gamepad. */
export const GAMEPAD_GLYPHS: Readonly<Record<Button, string>> = Object.freeze({
  a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT',
  start: 'Start', select: 'Select', up: '↑', down: '↓', left: '←', right: '→', l3: 'L3', r3: 'R3',
});

/** Labels for the on-screen touch controls; the stick covers the dpad buttons. */
export const TOUCH_GLYPHS: Readonly<Record<Button, string>> = Object.freeze({
  a: 'Tap A', b: 'Tap B', x: 'Tap X', y: 'Tap Y', lb: 'Tap LB', rb: 'Tap RB', lt: 'Tap LT', rt: 'Tap RT',
  start: 'Tap ☰', select: 'Tap ←', up: 'Stick ↑', down: 'Stick ↓', left: 'Stick ←', right: 'Stick →',
  l3: 'Tap L3', r3: 'Tap R3',
});

/** Touch actions performed by tapping the target on the field rather than a button. */
const TOUCH_ACTION_GLYPHS: Partial<Record<Action, string>> = {
  throw1: 'Tap', throw2: 'Tap', throw3: 'Tap', throw4: 'Tap', throw5: 'Tap', switchPlayer: 'Tap', fairCatch: 'Tap',
};

/** Mouse button index -> label. */
export const MOUSE_GLYPHS: Readonly<Record<0 | 1 | 2, string>> = Object.freeze({ 0: 'LMB', 1: 'MMB', 2: 'RMB' });

const NAMED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Bksp', Delete: 'Del',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  MetaLeft: 'Meta', MetaRight: 'Meta', CapsLock: 'Caps', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←',
  ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Home: 'Home', End: 'End', PageUp: 'PgUp',
  PageDown: 'PgDn', Insert: 'Ins', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
});

/** Short label for a KeyboardEvent.code ('KeyW' -> 'W', 'ArrowUp' -> '↑', 'Space' -> 'Space'). */
export const keyCodeGlyph = (code: KeyCode): string => {
  const named = NAMED_KEYS[code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] as string;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1] as string;
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
};

/** Keyboard glyph for a Button: the first key mapped to it, or null when nothing on the keyboard maps to it. */
export const keyboardGlyphFor = (keyboard: Record<KeyCode, Button>, button: Button): string | null => {
  const keys = keysFor(keyboard, button);
  return keys.length > 0 ? keyCodeGlyph(keys[0] as KeyCode) : null;
};

/** Mouse glyph for a Button, or null when no mouse button maps to it. */
export const mouseGlyphFor = (mouse: DeviceMap['mouse'], button: Button): string | null => {
  for (const idx of [0, 1, 2] as const) if (mouse[idx] === button) return MOUSE_GLYPHS[idx];
  return null;
};

/** Glyph of one Button on one device; keyboard falls back to the gamepad label for unmapped buttons. */
export const buttonGlyph = (device: InputState['lastDevice'], button: Button, deviceMap: DeviceMap): string => {
  switch (device) {
    case 'gamepad':
      return GAMEPAD_GLYPHS[button];
    case 'touch':
      return TOUCH_GLYPHS[button];
    case 'mouse':
      return mouseGlyphFor(deviceMap.mouse, button) ?? keyboardGlyphFor(deviceMap.keyboard, button) ?? GAMEPAD_GLYPHS[button];
    case 'keyboard':
      return keyboardGlyphFor(deviceMap.keyboard, button) ?? mouseGlyphFor(deviceMap.mouse, button) ?? GAMEPAD_GLYPHS[button];
  }
};

/**
 * Prompt glyph for an Action on the last active device: the first bound Button that the device can actually
 * produce (mouse prefers mouse buttons, then keys; keyboard prefers keys, then mouse buttons).
 */
export const actionGlyph = (device: InputState['lastDevice'], action: Action, scheme: ControlScheme, deviceMap: DeviceMap): string => {
  const buttons = scheme[action] ?? [];
  if (buttons.length === 0) return '?';
  if (device === 'touch') {
    const special = TOUCH_ACTION_GLYPHS[action];
    if (special) return special;
  }
  if (device === 'mouse') {
    for (const b of buttons) {
      const g = mouseGlyphFor(deviceMap.mouse, b);
      if (g) return g;
    }
  }
  if (device === 'mouse' || device === 'keyboard') {
    for (const b of buttons) {
      const g = keyboardGlyphFor(deviceMap.keyboard, b);
      if (g) return g;
    }
  }
  return buttonGlyph(device, buttons[0] as Button, deviceMap);
};
