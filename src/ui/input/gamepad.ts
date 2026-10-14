import { clamp01 } from '@/core/math';
import { vec2, type Vec2 } from '@/core/vec2';
import type { Button, DeviceMap, InputSource } from './types';

/**
 * Gamepad InputSource. Polls navigator.getGamepads() every frame (the Gamepad API has no button events) and
 * reads pads with the W3C "standard" layout: face buttons 0-3, shoulders 4-5, triggers 6-7, select/start 8-9,
 * stick clicks 10-11, dpad 12-15; axes 0/1 = left stick, 2/3 = right stick (reported as `aim`, the pull-back pass).
 * Every connected pad is merged so a second controller
 * on the couch works without a device picker. The left stick becomes the analog axis in the screen frame
 * (+y down, which is the raw Gamepad API convention) after a radial deadzone with rescaling.
 */

/** Structural subset of the DOM Gamepad so tests can supply fakes. */
export interface GamepadLike {
  readonly connected: boolean;
  readonly buttons: ReadonlyArray<{ readonly pressed: boolean; readonly value: number }>;
  readonly axes: ReadonlyArray<number>;
}

export interface GamepadSourceOptions {
  /** Pad provider; defaults to navigator.getGamepads() when available, otherwise no pads. */
  getGamepads?: () => ReadonlyArray<GamepadLike | null>;
  /** Radial stick deadzone 0..1 (overridden by setDeviceMap). */
  deadzone?: number;
  /** Analog triggers count as pressed above this value. */
  triggerThreshold?: number;
  /**
   * Also emit dpad Buttons when the left stick passes `stickDpadThreshold` (handy for stick-driven menus).
   * Off by default because the digital move* actions would then double the analog axis during play.
   */
  stickAsDpad?: boolean;
  stickDpadThreshold?: number;
}

export interface GamepadSource extends InputSource {
  readonly device: 'gamepad';
  /** True when the last poll saw at least one connected pad. */
  isConnected(): boolean;
  setDeviceMap(map: DeviceMap): void;
}

/** Standard-mapping button index -> Button. */
export const STANDARD_BUTTONS: ReadonlyArray<Button> = Object.freeze([
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'select', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right',
]);

/** Radial deadzone with rescaling so the output ramps smoothly from 0 just outside the dead radius to 1. */
export const applyDeadzone = (x: number, y: number, deadzone: number): Vec2 => {
  const len = Math.hypot(x, y);
  if (len <= deadzone || len === 0) return vec2(0, 0);
  const dz = clamp01(deadzone);
  const scaled = dz >= 1 ? 1 : clamp01((len - dz) / (1 - dz));
  return vec2((x / len) * scaled, (y / len) * scaled);
};

const defaultGetGamepads = (): ReadonlyArray<GamepadLike | null> => {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  try {
    return navigator.getGamepads();
  } catch {
    return [];
  }
};

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Creates a gamepad source; DOM access only happens inside poll()/attach(). */
export const createGamepadSource = (opts: GamepadSourceOptions = {}): GamepadSource => {
  const getGamepads = opts.getGamepads ?? defaultGetGamepads;
  let deadzone = opts.deadzone ?? 0.2;
  const triggerThreshold = opts.triggerThreshold ?? 0.5;
  const stickAsDpad = opts.stickAsDpad ?? false;
  const stickDpadThreshold = opts.stickDpadThreshold ?? 0.6;
  let connected = false;
  let target: EventTarget | null = null;

  const onConnected = (): void => {
    connected = true;
  };
  const onDisconnected = (): void => {
    connected = getGamepads().some((p) => p?.connected);
  };

  const poll = (): { buttons: ReadonlySet<Button>; axis: Vec2; pointer: null; aim?: Vec2 } => {
    const buttons = new Set<Button>();
    let ax = 0;
    let ay = 0;
    let rx = 0;
    let ry = 0;
    let sawPad = false;
    for (const pad of getGamepads()) {
      if (!pad || !pad.connected) continue;
      sawPad = true;
      pad.buttons.forEach((b, i) => {
        const name = STANDARD_BUTTONS[i];
        if (!name) return;
        const pressed = b.pressed || (name === 'lt' || name === 'rt' ? finite(b.value) > triggerThreshold : false);
        if (pressed) buttons.add(name);
      });
      const stick = applyDeadzone(finite(pad.axes[0]), finite(pad.axes[1]), deadzone);
      ax += stick.x;
      ay += stick.y;
      const right = applyDeadzone(finite(pad.axes[2]), finite(pad.axes[3]), deadzone);
      rx += right.x;
      ry += right.y;
      if (stickAsDpad) {
        if (stick.y <= -stickDpadThreshold) buttons.add('up');
        if (stick.y >= stickDpadThreshold) buttons.add('down');
        if (stick.x <= -stickDpadThreshold) buttons.add('left');
        if (stick.x >= stickDpadThreshold) buttons.add('right');
      }
    }
    connected = sawPad;
    const len = Math.hypot(ax, ay);
    const axis = len > 1 ? vec2(ax / len, ay / len) : vec2(ax, ay);
    const rlen = Math.hypot(rx, ry);
    if (rlen === 0) return { buttons, axis, pointer: null };
    return { buttons, axis, pointer: null, aim: rlen > 1 ? vec2(rx / rlen, ry / rlen) : vec2(rx, ry) };
  };

  const detach = (): void => {
    if (!target) return;
    target.removeEventListener('gamepadconnected', onConnected);
    target.removeEventListener('gamepaddisconnected', onDisconnected);
    target = null;
  };
  const attach = (t: EventTarget): void => {
    detach();
    target = t;
    t.addEventListener('gamepadconnected', onConnected);
    t.addEventListener('gamepaddisconnected', onDisconnected);
  };

  return {
    device: 'gamepad',
    poll,
    attach,
    detach,
    setDeviceMap: (m: DeviceMap) => {
      deadzone = clamp01(m.gamepadDeadzone);
    },
    isConnected: () => connected,
  };
};
