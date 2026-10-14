/**
 * Control remapping model (pure): the actions grouped for the remap screen, the CONTEXTS in which actions are
 * read together (two actions of one context on one button is a real conflict; sharing a button across contexts,
 * like A = snap / throw1 / tackle, is intended), conflict detection, assignment that swaps a conflicting action
 * onto the freed button, and the capture scheme that turns "press the button you want" into a Button.
 */
import { ACTIONS, BUTTONS, cloneScheme, keysFor } from './schemes';
import type { Action, Button, ControlScheme, InputState, KeyCode } from './types';

/** Screen groups of the remap list. */
export interface ControlGroup {
  id: string;
  label: string;
  actions: readonly Action[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  { id: 'menus', label: 'MENUS', actions: ['confirm', 'back', 'pause', 'menuUp', 'menuDown', 'menuLeft', 'menuRight', 'menuTabLeft', 'menuTabRight'] },
  { id: 'move', label: 'MOVEMENT', actions: ['moveUp', 'moveDown', 'moveLeft', 'moveRight'] },
  { id: 'presnap', label: 'PRE-SNAP', actions: ['snap', 'audible', 'showPlayArt', 'callTimeout', 'audibleManBeater', 'audibleZoneBeater', 'audibleBlitzBeater', 'audibleFlipRunPass', 'defAudibleMan', 'defAudibleZone', 'defAudibleBlitz', 'defAudibleSpy'] },
  { id: 'carrier', label: 'BALL CARRIER', actions: ['sprint', 'juke', 'spin', 'stiffArm', 'hurdle', 'dive', 'slide', 'pitch'] },
  { id: 'passing', label: 'PASSING', actions: ['throw1', 'throw2', 'throw3', 'throw4', 'throw5', 'throwAway', 'throwModifier'] },
  { id: 'defense', label: 'DEFENSE', actions: ['switchPlayer', 'tackle', 'hitStick', 'strip', 'jumpSwat', 'strafe', 'defSprint'] },
  { id: 'kicking', label: 'KICKING', actions: ['kick', 'fairCatch'] },
  { id: 'between', label: 'BETWEEN PLAYS', actions: ['challenge', 'skipPlay'] },
  { id: 'watch', label: 'WATCH MODE', actions: ['jumpIn', 'simSpeedUp', 'simSpeedDown'] },
  { id: 'replay', label: 'REPLAY & CAMERA', actions: ['cameraCycle', 'replayPlayPause', 'replaySlow', 'replayFast', 'replayStepBack', 'replayStepForward'] },
  { id: 'dev', label: 'DEVELOPER', actions: ['devToggle', 'devOverlayCycle'] },
];

/** An entry of a context: one action or synonyms that do the same thing there (may share a button). */
type Entry = Action | readonly Action[];

const MOVES: readonly Entry[] = ['moveUp', 'moveDown', 'moveLeft', 'moveRight'];

/** Actions each screen / play situation reads in the same moment. */
export const CONFLICT_CONTEXTS: Readonly<Record<string, readonly Entry[]>> = Object.freeze({
  menus: ['confirm', 'back', 'pause', 'callTimeout', ['menuTabLeft'], ['menuTabRight'], 'menuUp', 'menuDown', 'menuLeft', 'menuRight'],
  presnapOffense: [['snap', 'confirm'], 'audible', 'showPlayArt', 'callTimeout', 'pause', 'cameraCycle', ...MOVES],
  presnapDefense: ['switchPlayer', 'audible', 'showPlayArt', 'callTimeout', 'pause', 'cameraCycle', ...MOVES],
  offenseAudibles: ['audibleManBeater', 'audibleZoneBeater', 'audibleBlitzBeater', 'audibleFlipRunPass', 'back'],
  defenseAudibles: ['defAudibleMan', 'defAudibleZone', 'defAudibleBlitz', 'defAudibleSpy', 'back'],
  ballCarrier: ['sprint', 'juke', 'spin', 'stiffArm', 'hurdle', ['dive', 'slide', 'pitch'], 'pause', ...MOVES],
  quarterback: ['throw1', 'throw2', 'throw3', 'throw4', 'throw5', 'throwAway', 'throwModifier', 'sprint', 'pause', ...MOVES],
  defense: ['switchPlayer', 'tackle', 'hitStick', 'strip', 'jumpSwat', 'strafe', 'defSprint', 'pause', ...MOVES],
  kicking: ['kick', 'pause', ...MOVES],
  postPlay: [['confirm', 'snap'], 'challenge', 'showPlayArt', 'skipPlay', 'callTimeout', 'pause'],
  watch: ['jumpIn', 'skipPlay', 'simSpeedUp', 'simSpeedDown', 'pause', 'cameraCycle'],
  replay: [['replayPlayPause', 'confirm'], 'replaySlow', 'replayFast', ['replayStepBack', 'menuLeft'], ['replayStepForward', 'menuRight'], ['cameraCycle', 'menuUp'], 'back', 'pause', 'callTimeout'],
  developer: ['devToggle', 'devOverlayCycle', 'pause', 'cameraCycle'],
});

/** One clash: two entries of one context on one button. */
export interface Conflict {
  context: string;
  button: Button;
  actions: [Action, Action];
}

const buttonsOf = (scheme: ControlScheme, entry: Entry): Set<Button> =>
  new Set((typeof entry === 'string' ? [entry] : entry).flatMap((a) => scheme[a] ?? []));

const first = (entry: Entry): Action => (typeof entry === 'string' ? entry : (entry[0] as Action));

const has = (entry: Entry, action: Action): boolean => (typeof entry === 'string' ? entry === action : entry.includes(action));

/** Every clash in the scheme. */
export const findConflicts = (scheme: ControlScheme): Conflict[] => {
  const out: Conflict[] = [];
  for (const [context, entries] of Object.entries(CONFLICT_CONTEXTS)) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i] as Entry;
        const b = entries[j] as Entry;
        const bb = buttonsOf(scheme, b);
        for (const btn of buttonsOf(scheme, a)) if (bb.has(btn)) out.push({ context, button: btn, actions: [first(a), first(b)] });
      }
    }
  }
  return out;
};

/** Actions that clash with `action` (read in one of its contexts on one of its buttons). */
export const conflictsFor = (scheme: ControlScheme, action: Action): Action[] => {
  const out = new Set<Action>();
  for (const entries of Object.values(CONFLICT_CONTEXTS)) {
    const own = entries.find((e) => has(e, action));
    if (!own) continue;
    const mine = buttonsOf(scheme, own);
    for (const e of entries) {
      if (e === own) continue;
      for (const btn of buttonsOf(scheme, e)) {
        if (!mine.has(btn)) continue;
        for (const a of typeof e === 'string' ? [e] : e) if ((scheme[a] ?? []).includes(btn)) out.add(a);
      }
    }
  }
  return [...out];
};

/** Result of an assignment. */
export interface Assignment {
  scheme: ControlScheme;
  /** Actions moved onto the freed button to avoid a clash. */
  swapped: Action[];
  /** Clashes that remain after the swap (e.g. the freed button clashes too). */
  conflicts: Action[];
}

/**
 * Makes `button` the primary button of `action` (its other buttons stay unless they duplicate). Actions that
 * would clash with it on `button` get the action's previous primary button instead (a swap).
 */
export const assignButton = (scheme: ControlScheme, action: Action, button: Button): Assignment => {
  const out = cloneScheme(scheme);
  const previous = scheme[action][0] ?? null;
  if (previous === button) return { scheme: out, swapped: [], conflicts: conflictsFor(out, action) };
  out[action] = [button, ...scheme[action].slice(1).filter((b) => b !== button)];
  const clashing = conflictsFor(out, action).filter((a) => out[a].includes(button));
  const swapped: Action[] = [];
  if (previous) {
    for (const other of clashing) {
      out[other] = out[other].map((b) => (b === button ? previous : b)).filter((b, i, list) => list.indexOf(b) === i);
      swapped.push(other);
    }
  }
  return { scheme: out, swapped, conflicts: conflictsFor(out, action) };
};

/** Capture scheme: every Button raises its own distinct action, so the pressed Button can be read back. */
export const CAPTURE_ACTIONS: Readonly<Record<Button, Action>> = Object.freeze({
  a: 'confirm', b: 'back', x: 'showPlayArt', y: 'audible', lb: 'menuTabLeft', rb: 'menuTabRight', lt: 'callTimeout', rt: 'sprint',
  start: 'pause', select: 'devOverlayCycle', up: 'menuUp', down: 'menuDown', left: 'menuLeft', right: 'menuRight', l3: 'devToggle', r3: 'cameraCycle',
});

/** The ControlScheme installed while waiting for "press a button". */
export const captureScheme = (): ControlScheme => {
  const out = {} as ControlScheme;
  for (const a of ACTIONS) out[a] = [];
  for (const b of BUTTONS) out[CAPTURE_ACTIONS[b]] = [b];
  return out;
};

/** The Button pressed this tick under the capture scheme, or null. */
export const capturedButton = (input: InputState): Button | null => BUTTONS.find((b) => input.justPressed.has(CAPTURE_ACTIONS[b])) ?? null;

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ShiftLeft: 'SHIFT', ShiftRight: 'R-SHIFT', Escape: 'ESC',
  Backspace: 'BKSP', Enter: 'ENTER', NumpadEnter: 'ENTER', Space: 'SPACE', Backquote: '`',
});

/** Short printable name of a KeyboardEvent.code ("KeyK" -> "K", "Digit1" -> "1"). */
export const keyName = (code: KeyCode): string => KEY_NAMES[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '').toUpperCase();

/** "A · SPACE K 1" style description of a button with the keyboard keys that press it. */
export const describeButton = (button: Button, keyboard: Record<KeyCode, Button>): string => {
  const keys = [...new Set(keysFor(keyboard, button).map(keyName))];
  return keys.length > 0 ? `${button.toUpperCase()} · ${keys.join(' ')}` : button.toUpperCase();
};

/** Humanised action name ("throwAway" -> "THROW AWAY"). */
export const actionLabel = (action: Action): string => action.replace(/([A-Z0-9])/g, ' $1').toUpperCase().trim();
