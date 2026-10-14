import { vec2 } from '@/core/vec2';
import type { Button, DeviceMap, InputSource, KeyCode } from './types';

/**
 * Keyboard InputSource. Physical keys are identified by KeyboardEvent.code and translated to virtual-gamepad
 * Buttons through the DeviceMap at poll time (so a remap applies to keys already held). Keys that are pressed
 * and released between two polls are latched so a very short tap still produces a one-frame press. Game keys
 * have their default browser behaviour suppressed; keys held together with Ctrl/Meta are left to the browser.
 * Every keydown also records the text it types (printable characters, Backspace / Enter / Escape) for text-entry
 * screens, whether or not the key is bound. No DOM access happens at import or construction time; listeners
 * bind in attach().
 */
export interface KeyboardSource extends InputSource {
  readonly device: 'keyboard';
  /** Programmatic press (tests, on-screen keyboards). Ignores repeats of a key already held. */
  keyDown(code: KeyCode): void;
  keyUp(code: KeyCode): void;
  /** Programmatic typing (tests): queues characters as if typed ('\b', '\n', '\x1b' for the special keys). */
  typeText(text: string): void;
  /** Releases every held key; called on window blur so keys never stick. */
  releaseAll(): void;
  /** Codes currently held (after mapping filters nothing — raw). */
  heldCodes(): ReadonlySet<KeyCode>;
  setDeviceMap(map: DeviceMap): void;
}

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const readCode = (e: Event): KeyCode | null => {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
};

/** Text a keydown types ('\b' Backspace, '\n' Enter, '\x1b' Escape, else the printable character), or null. */
export const typedText = (e: Event): string | null => {
  const key = (e as { key?: unknown }).key;
  if (typeof key !== 'string') return null;
  if (key === 'Backspace') return '\b';
  if (key === 'Enter') return '\n';
  if (key === 'Escape') return '\x1b';
  return key.length === 1 ? key : null;
};

const isRepeat = (e: Event): boolean => (e as { repeat?: unknown }).repeat === true;
const hasSystemModifier = (e: Event): boolean => {
  const ev = e as { metaKey?: unknown; ctrlKey?: unknown };
  return ev.metaKey === true || ev.ctrlKey === true;
};

/** Creates a keyboard source using `keyboard` (KeyboardEvent.code -> Button) as its initial map. */
export const createKeyboardSource = (keyboard: Record<KeyCode, Button> = {}): KeyboardSource => {
  let map: Record<KeyCode, Button> = { ...keyboard };
  const held = new Set<KeyCode>();
  const latched = new Set<KeyCode>();
  let target: EventTarget | null = null;
  const typed: string[] = [];

  const keyDown = (code: KeyCode): void => {
    if (held.has(code)) return;
    held.add(code);
    latched.add(code);
  };
  const keyUp = (code: KeyCode): void => {
    held.delete(code);
  };
  const releaseAll = (): void => held.clear();

  const onKeyDown = (e: Event): void => {
    const code = readCode(e);
    const text = hasSystemModifier(e) ? null : typedText(e);
    if (text !== null) typed.push(text);
    if (!code || !hasOwn(map, code)) return;
    if (hasSystemModifier(e)) return;
    e.preventDefault();
    if (isRepeat(e)) return;
    keyDown(code);
  };
  const onKeyUp = (e: Event): void => {
    const code = readCode(e);
    if (!code) return;
    if (hasOwn(map, code)) e.preventDefault();
    keyUp(code);
  };
  const onBlur = (): void => releaseAll();

  const poll = (): { buttons: ReadonlySet<Button>; axis: { x: number; y: number }; pointer: null; text?: string[] } => {
    const buttons = new Set<Button>();
    for (const code of held) if (hasOwn(map, code)) buttons.add(map[code] as Button);
    for (const code of latched) if (hasOwn(map, code)) buttons.add(map[code] as Button);
    latched.clear();
    const text = typed.splice(0, typed.length);
    return { buttons, axis: vec2(0, 0), pointer: null, ...(text.length > 0 ? { text } : {}) };
  };

  const detach = (): void => {
    if (!target) return;
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
    target = null;
    releaseAll();
    latched.clear();
  };

  const attach = (t: EventTarget): void => {
    detach();
    target = t;
    t.addEventListener('keydown', onKeyDown);
    t.addEventListener('keyup', onKeyUp);
    t.addEventListener('blur', onBlur);
  };

  return {
    device: 'keyboard',
    poll,
    attach,
    detach,
    setDeviceMap: (m: DeviceMap) => {
      map = { ...m.keyboard };
    },
    keyDown,
    keyUp,
    typeText: (text: string) => { typed.push(...Array.from(text)); },
    releaseAll,
    heldCodes: () => held,
  };
};
