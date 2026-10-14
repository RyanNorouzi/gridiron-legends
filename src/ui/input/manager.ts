import { clampLen, vec2, type Vec2 } from '@/core/vec2';
import type {
  Action, Button, ControlProfile, ControlScheme, DeviceMap, InputManager, InputSource, InputState, PointerState,
} from './types';
import { ACTIONS, cloneDeviceMap, cloneScheme } from './schemes';
import { actionGlyph } from './glyphs';

/**
 * InputManager: merges every InputSource each frame, resolves Buttons to Actions through the ControlScheme,
 * accumulates press/release edges between simulation ticks and hands out per-tick snapshots.
 *
 * Frame/tick contract (see types.ts): update() once per animation frame (no clearing); consumeTick() once per
 * simulation tick — the first tick after one or more updates sees every edge that happened since the previous
 * consumeTick, later ticks in the same frame see none. Held state and the axis are live for every tick.
 */
export interface ManagedInput extends InputManager {
  /** Binds every source to `target` (window or canvas); createBrowserInput does the per-source split. */
  attach(target: EventTarget): void;
  detach(): void;
  readonly sources: readonly InputSource[];
}

type Device = InputState['lastDevice'];

/** Screen-frame unit vectors for the digital move actions (+y = down on the canvas). */
const DIGITAL_MOVES: ReadonlyArray<readonly [Action, Vec2]> = [
  ['moveUp', vec2(0, -1)],
  ['moveDown', vec2(0, 1)],
  ['moveLeft', vec2(-1, 0)],
  ['moveRight', vec2(1, 0)],
];

interface SourceMemory {
  buttons: ReadonlySet<Button>;
  pointer: PointerState | null;
}

const emptyState = (device: Device): InputState => ({
  axis: vec2(0, 0),
  down: new Set<Action>(),
  justPressed: new Set<Action>(),
  justReleased: new Set<Action>(),
  pointer: null,
  lastDevice: device,
});

const copyPointer = (p: PointerState, justDown: boolean, justUp: boolean, wheel = 0): PointerState => ({
  ...(wheel !== 0 ? { wheel } : {}),
  x: p.x,
  y: p.y,
  down: p.down,
  justDown,
  justUp,
  drag: p.drag ? vec2(p.drag.x, p.drag.y) : null,
  ...(p.secondary ? { secondary: true } : {}),
});

/**
 * Activity score of one source this frame: 2 for a new press, pointer edge or pointer motion, 1 for anything
 * held or a live axis, 0 for silence. Drives lastDevice (a fresh press beats a key merely still held elsewhere).
 */
const activityScore = (buttons: ReadonlySet<Button>, axis: Vec2, pointer: PointerState | null, prev: SourceMemory | undefined): number => {
  let score = 0;
  if (buttons.size > 0) {
    score = 1;
    for (const b of buttons) if (!prev?.buttons.has(b)) score = 2;
  }
  if (axis.x !== 0 || axis.y !== 0) score = Math.max(score, 1);
  if (pointer) {
    if (pointer.justDown || pointer.justUp || pointer.drag || pointer.wheel) score = 2;
    else if (prev?.pointer && (prev.pointer.x !== pointer.x || prev.pointer.y !== pointer.y)) score = 2;
    else if (pointer.down) score = Math.max(score, 1);
  }
  return score;
};

/** Creates the manager; the profile is copied so later rebinding never mutates the caller's object. */
export const createInputManager = (sources: readonly InputSource[], profile: ControlProfile): ManagedInput => {
  let scheme = cloneScheme(profile.scheme);
  let deviceMap = cloneDeviceMap(profile.deviceMap);
  for (const s of sources) s.setDeviceMap?.(deviceMap);

  const memory = new Map<InputSource, SourceMemory>();
  let rawButtons: ReadonlySet<Button> = new Set<Button>();
  let analog = vec2(0, 0);
  let aimAnalog = vec2(0, 0);
  let downActions = new Set<Action>();
  const pendingText: string[] = [];
  const pendingPressed = new Set<Action>();
  const pendingReleased = new Set<Action>();
  let pointer: PointerState | null = null;
  let pointerSource: InputSource | null = null;
  let pendingPointerDown = false;
  let pendingPointerUp = false;
  let pendingWheel = 0;
  let lastDevice: Device = 'keyboard';
  let snapshot: InputState = emptyState(lastDevice);

  const resolveActions = (buttons: ReadonlySet<Button>): Set<Action> => {
    const out = new Set<Action>();
    for (const action of ACTIONS) {
      const bound = scheme[action];
      for (let i = 0; i < bound.length; i++) {
        if (buttons.has(bound[i] as Button)) {
          out.add(action);
          break;
        }
      }
    }
    return out;
  };

  const computeAxis = (): Vec2 => {
    let x = analog.x;
    let y = analog.y;
    for (const [action, dir] of DIGITAL_MOVES) {
      if (downActions.has(action)) {
        x += dir.x;
        y += dir.y;
      }
    }
    return clampLen(vec2(x, y), 1);
  };

  const update = (): void => {
    const merged = new Set<Button>();
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    let bestScore = 0;
    let bestDevice: Device | null = null;
    let bestPointer: PointerState | null = null;
    let bestPointerSource: InputSource | null = null;
    let bestPointerScore = -1;
    for (const source of sources) {
      const sample = source.poll();
      const prev = memory.get(source);
      // The right stick (aim) counts as activity like the left one.
      const live = sample.axis.x !== 0 || sample.axis.y !== 0 ? sample.axis : sample.aim ?? sample.axis;
      const score = activityScore(sample.buttons, live, sample.pointer, prev);
      if (score > bestScore || (score === bestScore && score > 0 && source.device === lastDevice)) {
        bestScore = score;
        bestDevice = source.device;
      }
      for (const b of sample.buttons) merged.add(b);
      if (sample.text) pendingText.push(...sample.text);
      ax += sample.axis.x;
      ay += sample.axis.y;
      if (sample.aim) {
        bx += sample.aim.x;
        by += sample.aim.y;
      }
      if (sample.pointer) {
        const pScore = sample.pointer.justDown || sample.pointer.justUp ? 3 : score;
        // Ties keep the pointer on the source that owned it last so an idle mouse never displaces a touch tap.
        if (pScore > bestPointerScore || (pScore === bestPointerScore && source === pointerSource)) {
          bestPointerScore = pScore;
          bestPointer = sample.pointer;
          bestPointerSource = source;
        }
        if (sample.pointer.justDown) pendingPointerDown = true;
        if (sample.pointer.wheel) pendingWheel += sample.pointer.wheel;
        if (sample.pointer.justUp) pendingPointerUp = true;
      }
      memory.set(source, { buttons: new Set(sample.buttons), pointer: sample.pointer });
    }
    if (bestDevice && bestScore > 0) lastDevice = bestDevice;
    rawButtons = merged;
    analog = vec2(ax, ay);
    aimAnalog = clampLen(vec2(bx, by), 1);
    if (bestPointer) {
      pointer = bestPointer;
      pointerSource = bestPointerSource;
    }
    const now = resolveActions(merged);
    for (const a of now) if (!downActions.has(a)) pendingPressed.add(a);
    for (const a of downActions) if (!now.has(a)) pendingReleased.add(a);
    downActions = now;
  };

  const consumeTick = (): InputState => {
    const state: InputState = {
      axis: computeAxis(),
      down: new Set(downActions),
      justPressed: new Set(pendingPressed),
      justReleased: new Set(pendingReleased),
      pointer: pointer ? copyPointer(pointer, pendingPointerDown, pendingPointerUp, pendingWheel) : null,
      ...(aimAnalog.x !== 0 || aimAnalog.y !== 0 ? { aim: vec2(aimAnalog.x, aimAnalog.y) } : {}),
      lastDevice,
      ...(pendingText.length > 0 ? { text: pendingText.splice(0, pendingText.length) } : {}),
    };
    pendingPressed.clear();
    pendingReleased.clear();
    pendingPointerDown = false;
    pendingPointerUp = false;
    pendingWheel = 0;
    snapshot = state;
    return state;
  };

  const setScheme = (next: ControlScheme): void => {
    scheme = cloneScheme(next);
    // A rebind while keys are held is not a press or a release: re-resolve without generating edges.
    downActions = resolveActions(rawButtons);
  };

  const setDeviceMap = (map: DeviceMap): void => {
    deviceMap = cloneDeviceMap(map);
    for (const s of sources) s.setDeviceMap?.(deviceMap);
  };

  return {
    sources,
    update,
    consumeTick,
    state: () => snapshot,
    setScheme,
    getScheme: () => cloneScheme(scheme),
    setDeviceMap,
    getDeviceMap: () => cloneDeviceMap(deviceMap),
    isDown: (action) => snapshot.down.has(action),
    justPressed: (action) => snapshot.justPressed.has(action),
    axis: () => vec2(snapshot.axis.x, snapshot.axis.y),
    glyph: (action) => actionGlyph(lastDevice, action, scheme, deviceMap),
    attach: (target) => {
      for (const s of sources) s.attach(target);
    },
    detach: () => {
      for (const s of sources) s.detach();
    },
  };
};
