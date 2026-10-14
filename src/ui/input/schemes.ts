import controlsJson from '@/data/controls.json';
import type { Settings } from '@/core/settings';
import type { Action, Button, ControlProfile, ControlScheme, DeviceMap, KeyCode } from './types';

/**
 * Control schemes: the runtime vocabulary of Actions/Buttons, the validated default profile from
 * src/data/controls.json, conversion to/from the plain-string records stored in Settings, and rebinding.
 *
 * Buttons are deliberately reused across contexts (menus, pre-snap, ball carrier, quarterback, defense,
 * kicking, watch mode). The screens and src/ui/game/play-input.ts only read the actions relevant to the
 * current context, so `throw2` and `juke` can both live on `b` without conflict.
 */

/** Exhaustive at compile time: adding an Action to types.ts without listing it here is a type error. */
const ACTION_KEYS: Record<Action, 0> = {
  confirm: 0, back: 0, pause: 0, menuUp: 0, menuDown: 0, menuLeft: 0, menuRight: 0, menuTabLeft: 0, menuTabRight: 0,
  moveUp: 0, moveDown: 0, moveLeft: 0, moveRight: 0,
  snap: 0, audible: 0, audibleManBeater: 0, audibleZoneBeater: 0, audibleBlitzBeater: 0, audibleFlipRunPass: 0,
  defAudibleMan: 0, defAudibleZone: 0, defAudibleBlitz: 0, defAudibleSpy: 0,
  showPlayArt: 0, callTimeout: 0, challenge: 0,
  sprint: 0, juke: 0, spin: 0, stiffArm: 0, hurdle: 0, dive: 0, slide: 0, throwAway: 0, pitch: 0,
  throw1: 0, throw2: 0, throw3: 0, throw4: 0, throw5: 0, throwModifier: 0,
  switchPlayer: 0, tackle: 0, hitStick: 0, strip: 0, jumpSwat: 0, strafe: 0, defSprint: 0,
  kick: 0, fairCatch: 0,
  jumpIn: 0, skipPlay: 0, simSpeedUp: 0, simSpeedDown: 0,
  cameraCycle: 0, replayPlayPause: 0, replaySlow: 0, replayFast: 0, replayStepBack: 0, replayStepForward: 0,
  devToggle: 0, devOverlayCycle: 0,
};

const BUTTON_KEYS: Record<Button, 0> = {
  a: 0, b: 0, x: 0, y: 0, lb: 0, rb: 0, lt: 0, rt: 0, start: 0, select: 0,
  up: 0, down: 0, left: 0, right: 0, l3: 0, r3: 0,
};

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Every Action the game understands, in declaration order. */
export const ACTIONS: readonly Action[] = Object.freeze(Object.keys(ACTION_KEYS) as Action[]);
/** Every virtual-gamepad Button. */
export const BUTTONS: readonly Button[] = Object.freeze(Object.keys(BUTTON_KEYS) as Button[]);

/** Type guard for Action strings coming from settings/JSON. */
export const isAction = (v: unknown): v is Action => typeof v === 'string' && hasOwn(ACTION_KEYS, v);
/** Type guard for Button strings coming from settings/JSON. */
export const isButton = (v: unknown): v is Button => typeof v === 'string' && hasOwn(BUTTON_KEYS, v);

/** Deep copy so callers can mutate freely. */
export const cloneScheme = (scheme: ControlScheme): ControlScheme => {
  const out = {} as ControlScheme;
  for (const action of ACTIONS) out[action] = [...(scheme[action] ?? [])];
  return out;
};

/** Deep copy of a DeviceMap. */
export const cloneDeviceMap = (map: DeviceMap): DeviceMap => ({
  keyboard: { ...map.keyboard },
  mouse: { ...map.mouse },
  gamepadDeadzone: map.gamepadDeadzone,
});

export interface SchemeValidation {
  /** True when every entry was valid and every Action is covered. */
  ok: boolean;
  /** Complete scheme (invalid or missing entries filled from `fallback`), or null when a gap could not be filled. */
  scheme: ControlScheme | null;
  /** Human-readable problems, empty when ok. */
  issues: string[];
}

const dedupe = (buttons: readonly Button[]): Button[] => [...new Set(buttons)];

/**
 * Validates a plain Action -> Button[] record (e.g. Settings.bindings). Unknown actions, unknown buttons,
 * non-array values and empty lists are reported. With a `fallback`, missing or invalid actions are filled
 * from it so a usable scheme is still returned alongside the issues.
 */
export const validateScheme = (record: Record<string, unknown>, fallback?: ControlScheme): SchemeValidation => {
  const issues: string[] = [];
  const partial: Partial<ControlScheme> = {};
  for (const key of Object.keys(record)) {
    if (!isAction(key)) {
      issues.push(`unknown action "${key}"`);
      continue;
    }
    const value = record[key];
    if (!Array.isArray(value)) {
      issues.push(`action "${key}": expected an array of buttons`);
      continue;
    }
    const good: Button[] = [];
    for (const b of value) {
      if (isButton(b)) good.push(b);
      else issues.push(`action "${key}": unknown button "${String(b)}"`);
    }
    if (good.length === 0) {
      issues.push(`action "${key}": no buttons bound`);
      continue;
    }
    if (good.length === value.length) partial[key] = dedupe(good);
  }
  const scheme = {} as ControlScheme;
  let complete = true;
  for (const action of ACTIONS) {
    const bound = partial[action] ?? fallback?.[action];
    if (bound && bound.length > 0) scheme[action] = [...bound];
    else {
      complete = false;
      if (!hasOwn(record, action)) issues.push(`action "${action}": missing`);
    }
  }
  return { ok: issues.length === 0, scheme: complete ? scheme : null, issues };
};

export interface KeyboardMapValidation {
  ok: boolean;
  map: Record<KeyCode, Button>;
  issues: string[];
}

/** Validates a KeyboardEvent.code -> Button record (Settings.keyboardMap). Invalid entries are dropped. */
export const validateKeyboardMap = (record: Record<string, unknown>): KeyboardMapValidation => {
  const issues: string[] = [];
  const map: Record<KeyCode, Button> = {};
  for (const code of Object.keys(record)) {
    const button = record[code];
    if (code.length === 0) issues.push('empty key code');
    else if (!isButton(button)) issues.push(`key "${code}": unknown button "${String(button)}"`);
    else map[code] = button;
  }
  return { ok: issues.length === 0, map, issues };
};

export interface DeviceMapValidation {
  ok: boolean;
  map: DeviceMap | null;
  issues: string[];
}

const MOUSE_BUTTONS = [0, 1, 2] as const;

/** Validates an untyped DeviceMap (JSON). Mouse keys may be numbers or numeric strings. */
export const validateDeviceMap = (value: unknown): DeviceMapValidation => {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null) return { ok: false, map: null, issues: ['deviceMap must be an object'] };
  const obj = value as Record<string, unknown>;
  const kb = obj['keyboard'];
  const keyboard = typeof kb === 'object' && kb !== null ? validateKeyboardMap(kb as Record<string, unknown>) : null;
  if (!keyboard) issues.push('deviceMap.keyboard must be an object');
  else issues.push(...keyboard.issues);
  const mouse: DeviceMap['mouse'] = {};
  const ms = obj['mouse'];
  if (typeof ms !== 'object' || ms === null) issues.push('deviceMap.mouse must be an object');
  else {
    for (const [k, b] of Object.entries(ms as Record<string, unknown>)) {
      const idx = Number(k);
      const slot = MOUSE_BUTTONS.find((m) => m === idx);
      if (slot === undefined) issues.push(`deviceMap.mouse: unsupported mouse button "${k}"`);
      else if (!isButton(b)) issues.push(`deviceMap.mouse[${k}]: unknown button "${String(b)}"`);
      else mouse[slot] = b;
    }
  }
  const dz = obj['gamepadDeadzone'];
  const deadzone = typeof dz === 'number' && Number.isFinite(dz) && dz >= 0 && dz < 1 ? dz : null;
  if (deadzone === null) issues.push('deviceMap.gamepadDeadzone must be a number in [0, 1)');
  const ok = issues.length === 0;
  return {
    ok,
    map: keyboard && deadzone !== null ? { keyboard: keyboard.map, mouse, gamepadDeadzone: deadzone } : null,
    issues,
  };
};

let cachedDefault: ControlProfile | null = null;

/** Validates src/data/controls.json once and returns a fresh deep copy of the DEFAULT profile. */
export const loadDefaultProfile = (): ControlProfile => {
  if (!cachedDefault) {
    const raw = controlsJson as unknown as Record<string, unknown>;
    if (raw['version'] !== 1) throw new Error(`controls.json: unsupported version ${String(raw['version'])}`);
    const schemeRaw = raw['scheme'];
    if (typeof schemeRaw !== 'object' || schemeRaw === null) throw new Error('controls.json: scheme must be an object');
    const scheme = validateScheme(schemeRaw as Record<string, unknown>);
    if (!scheme.ok || !scheme.scheme) throw new Error(`controls.json: invalid scheme\n  ${scheme.issues.join('\n  ')}`);
    const deviceMap = validateDeviceMap(raw['deviceMap']);
    if (!deviceMap.ok || !deviceMap.map) throw new Error(`controls.json: invalid deviceMap\n  ${deviceMap.issues.join('\n  ')}`);
    cachedDefault = { version: 1, scheme: scheme.scheme, deviceMap: deviceMap.map };
  }
  return { version: 1, scheme: cloneScheme(cachedDefault.scheme), deviceMap: cloneDeviceMap(cachedDefault.deviceMap) };
};

/** Scheme as the plain-string record persisted in Settings.bindings. */
export const schemeToSettings = (scheme: ControlScheme): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const action of ACTIONS) out[action] = [...scheme[action]];
  return out;
};

/**
 * Lenient inverse of schemeToSettings for the settings store: valid entries win, anything invalid or
 * missing falls back to `fallback` (default profile). Never throws on stale settings.
 */
export const settingsToScheme = (bindings: Record<string, string[]>, fallback: ControlScheme = loadDefaultProfile().scheme): ControlScheme =>
  validateScheme(bindings, fallback).scheme ?? cloneScheme(fallback);

/** Keyboard map as the plain-string record persisted in Settings.keyboardMap. */
export const keyboardMapToSettings = (map: Record<KeyCode, Button>): Record<string, string> => ({ ...map });

/** Lenient inverse of keyboardMapToSettings; an empty record yields the fallback map. */
export const settingsToKeyboardMap = (record: Record<string, string>, fallback: Record<KeyCode, Button> = loadDefaultProfile().deviceMap.keyboard): Record<KeyCode, Button> => {
  const valid = validateKeyboardMap(record).map;
  return Object.keys(valid).length > 0 ? valid : { ...fallback };
};

/** Builds a ControlProfile from persisted settings on top of `base` (default profile when omitted). */
export const profileFromSettings = (settings: Pick<Settings, 'bindings' | 'keyboardMap'>, base: ControlProfile = loadDefaultProfile()): ControlProfile => ({
  version: 1,
  scheme: settingsToScheme(settings.bindings, base.scheme),
  deviceMap: {
    keyboard: settingsToKeyboardMap(settings.keyboardMap, base.deviceMap.keyboard),
    mouse: { ...base.deviceMap.mouse },
    gamepadDeadzone: base.deviceMap.gamepadDeadzone,
  },
});

/** The persisted slice of a profile (bindings + keyboardMap) for Settings. */
export const profileToSettings = (profile: ControlProfile): Pick<Settings, 'bindings' | 'keyboardMap'> => ({
  bindings: schemeToSettings(profile.scheme),
  keyboardMap: keyboardMapToSettings(profile.deviceMap.keyboard),
});

/** Returns a NEW scheme with `action` bound to `buttons` (deduplicated). Throws when no button is given. */
export const rebind = (scheme: ControlScheme, action: Action, buttons: readonly Button[]): ControlScheme => {
  const list = dedupe(buttons.filter(isButton));
  if (list.length === 0) throw new Error(`rebind(${action}): at least one button is required`);
  const out = cloneScheme(scheme);
  out[action] = list;
  return out;
};

/** Every action currently triggered by `button` (used by the remap UI to show conflicts). */
export const actionsFor = (scheme: ControlScheme, button: Button): Action[] => ACTIONS.filter((a) => scheme[a].includes(button));

/** Key codes that map to `button`, in map order (first one is the preferred prompt glyph). */
export const keysFor = (keyboard: Record<KeyCode, Button>, button: Button): KeyCode[] =>
  Object.keys(keyboard).filter((code) => keyboard[code] === button);
