import { describe, expect, it } from 'vitest';
import { applyDeadzone, createGamepadSource, STANDARD_BUTTONS, type GamepadLike } from '@/ui/input/gamepad';

const pad = (pressed: number[] = [], axes: number[] = [0, 0], connected = true): GamepadLike => ({
  connected,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
  axes,
});

describe('gamepad source', () => {
  it('reads the standard mapping', () => {
    let pads: (GamepadLike | null)[] = [];
    const src = createGamepadSource({ getGamepads: () => pads });
    expect(src.poll().buttons.size).toBe(0);
    expect(src.isConnected()).toBe(false);
    pads = [null, pad([0, 3, 9, 12, 15])];
    const sample = src.poll();
    expect([...sample.buttons].sort()).toEqual(['a', 'right', 'start', 'up', 'y']);
    expect(src.isConnected()).toBe(true);
    expect(STANDARD_BUTTONS.length).toBe(16);
    pads = [pad([], [0, 0], false)];
    expect(src.poll().buttons.size).toBe(0);
    expect(src.isConnected()).toBe(false);
  });

  it('treats analog triggers as pressed above the threshold', () => {
    const p = pad();
    const buttons = p.buttons as { pressed: boolean; value: number }[];
    buttons[6] = { pressed: false, value: 0.3 };
    buttons[7] = { pressed: false, value: 0.8 };
    const src = createGamepadSource({ getGamepads: () => [p] });
    expect([...src.poll().buttons]).toEqual(['rt']);
  });

  it('applies a radial deadzone with rescaling to the left stick', () => {
    expect(applyDeadzone(0.1, 0.1, 0.2)).toEqual({ x: 0, y: 0 });
    const full = applyDeadzone(0, 1, 0.2);
    expect(full.y).toBeCloseTo(1);
    const mid = applyDeadzone(0.6, 0, 0.2);
    expect(mid.x).toBeCloseTo(0.5);
    expect(applyDeadzone(0, 0, 0.2)).toEqual({ x: 0, y: 0 });
    const src = createGamepadSource({ getGamepads: () => [pad([], [0.15, -0.1])], deadzone: 0.25 });
    expect(src.poll().axis).toEqual({ x: 0, y: 0 });
    const src2 = createGamepadSource({ getGamepads: () => [pad([], [0, -1])], deadzone: 0.25 });
    const a = src2.poll().axis;
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(-1);
  });

  it('merges every connected pad and clamps the combined axis', () => {
    const src = createGamepadSource({ getGamepads: () => [pad([1], [1, 0]), pad([2], [1, 0])], deadzone: 0 });
    const s = src.poll();
    expect([...s.buttons].sort()).toEqual(['b', 'x']);
    expect(s.axis.x).toBeCloseTo(1);
    expect(s.axis.y).toBeCloseTo(0);
  });

  it('setDeviceMap changes the deadzone and stickAsDpad emits dpad buttons', () => {
    let axes = [0.5, 0];
    const src = createGamepadSource({ getGamepads: () => [pad([], axes)], deadzone: 0.1 });
    expect(src.poll().axis.x).toBeGreaterThan(0.4);
    src.setDeviceMap({ keyboard: {}, mouse: {}, gamepadDeadzone: 0.6 });
    expect(src.poll().axis.x).toBe(0);
    const dpad = createGamepadSource({ getGamepads: () => [pad([], axes)], deadzone: 0, stickAsDpad: true, stickDpadThreshold: 0.4 });
    expect([...dpad.poll().buttons]).toEqual(['right']);
    axes = [0, -0.9];
    expect([...dpad.poll().buttons]).toEqual(['up']);
    expect(dpad.poll().pointer).toBeNull();
  });

  it('tracks connection events and survives a missing navigator', () => {
    const src = createGamepadSource();
    expect(src.poll().buttons.size).toBe(0);
    let pads: GamepadLike[] = [];
    const evented = createGamepadSource({ getGamepads: () => pads });
    const target = new EventTarget();
    evented.attach(target);
    target.dispatchEvent(new Event('gamepadconnected'));
    expect(evented.isConnected()).toBe(true);
    target.dispatchEvent(new Event('gamepaddisconnected'));
    expect(evented.isConnected()).toBe(false);
    pads = [pad()];
    target.dispatchEvent(new Event('gamepaddisconnected'));
    expect(evented.isConnected()).toBe(true);
    evented.detach();
  });
});
