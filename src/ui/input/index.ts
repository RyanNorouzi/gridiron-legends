import type { Vec2 } from '@/core/vec2';
import type { ControlProfile } from './types';
import { createKeyboardSource, type KeyboardSource } from './keyboard';
import { createMouseSource, type MouseSource, type ToLogical } from './mouse';
import { createGamepadSource, type GamepadSource } from './gamepad';
import { createTouchSource, type TouchSource } from './touch';
import { touchFreeAt, touchHintAt, touchOverlayShown } from './touch-frame';
import { createInputManager, type ManagedInput } from './manager';
import { loadDefaultProfile } from './schemes';

/**
 * Public surface of the input layer. Everything here is safe to import in Node; only createBrowserInput()
 * touches the DOM, and only when called.
 */
export type {
  Action, Button, ControlProfile, ControlScheme, DeviceMap, InputManager, InputSource, InputState, KeyCode, PointerState,
} from './types';
export { createInputManager, type ManagedInput } from './manager';
export { createKeyboardSource, type KeyboardSource } from './keyboard';
export { createMouseSource, type MouseSource, type ToLogical } from './mouse';
export { applyDeadzone, createGamepadSource, STANDARD_BUTTONS, type GamepadLike, type GamepadSource, type GamepadSourceOptions } from './gamepad';
export {
  createTouchSource, type TouchButtonLayout, type TouchLayout, type TouchSource, type TouchSourceOptions, type TouchStickLayout,
} from './touch';
export {
  ACTIONS, BUTTONS, actionsFor, cloneDeviceMap, cloneScheme, isAction, isButton, keyboardMapToSettings, keysFor,
  loadDefaultProfile, profileFromSettings, profileToSettings, rebind, schemeToSettings, settingsToKeyboardMap,
  settingsToScheme, validateDeviceMap, validateKeyboardMap, validateScheme,
  type DeviceMapValidation, type KeyboardMapValidation, type SchemeValidation,
} from './schemes';
export {
  GAMEPAD_GLYPHS, MOUSE_GLYPHS, TOUCH_GLYPHS, actionGlyph, buttonGlyph, keyCodeGlyph, keyboardGlyphFor, mouseGlyphFor,
} from './glyphs';

/** Logical render resolution the renderer scales up with integer factors. */
export const LOGICAL_WIDTH = 480;
export const LOGICAL_HEIGHT = 270;

export interface BrowserInputOptions {
  profile?: ControlProfile;
  /** Logical canvas size used for pointer coordinates and the touch layout. */
  logical?: { width: number; height: number };
}

export interface BrowserInput {
  manager: ManagedInput;
  keyboard: KeyboardSource;
  mouse: MouseSource;
  gamepad: GamepadSource;
  touch: TouchSource;
  /** Maps viewport coordinates to logical canvas pixels (shared by mouse and touch). */
  toLogical: ToLogical;
  /** Unbinds every listener. */
  detach(): void;
}

/** Viewport -> logical canvas transform from the canvas' current CSS box (letterboxing handled by the caller's CSS). */
export const makeToLogical = (canvas: HTMLCanvasElement, logical: { width: number; height: number }): ToLogical =>
  (clientX: number, clientY: number): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? logical.width / rect.width : 1;
    const sy = rect.height > 0 ? logical.height / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  };

/**
 * Wires every device to a canvas: keyboard and gamepad listen on window, mouse and touch on the canvas.
 * Browser only — never call this from simulation code or tests.
 */
export const createBrowserInput = (canvas: HTMLCanvasElement, opts: BrowserInputOptions = {}): BrowserInput => {
  const profile = opts.profile ?? loadDefaultProfile();
  const logical = opts.logical ?? { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT };
  const toLogical = makeToLogical(canvas, logical);
  const keyboard = createKeyboardSource(profile.deviceMap.keyboard);
  const mouse = createMouseSource(toLogical, profile.deviceMap.mouse);
  const gamepad = createGamepadSource({ deadzone: profile.deviceMap.gamepadDeadzone });
  const touch = createTouchSource(toLogical, { width: logical.width, height: logical.height, controlsVisible: touchOverlayShown, hintAt: touchHintAt, freeAt: touchFreeAt });
  const manager = createInputManager([keyboard, mouse, gamepad, touch], profile);
  canvas.style.touchAction = 'none';
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  keyboard.attach(window);
  gamepad.attach(window);
  mouse.attach(canvas);
  touch.attach(canvas);
  return {
    manager,
    keyboard,
    mouse,
    gamepad,
    touch,
    toLogical,
    detach: () => {
      keyboard.detach();
      gamepad.detach();
      mouse.detach();
      touch.detach();
    },
  };
};
