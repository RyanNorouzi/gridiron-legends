import { describe, expect, it } from 'vitest';
import { createKeyboardSource } from '@/ui/input/keyboard';
import { loadDefaultProfile } from '@/ui/input/schemes';

const keyEvent = (type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event =>
  Object.assign(new Event(type, { cancelable: true }), { code, ...extra });

describe('keyboard source', () => {
  it('maps held keys to buttons and prevents default only for game keys', () => {
    const src = createKeyboardSource(loadDefaultProfile().deviceMap.keyboard);
    const target = new EventTarget();
    src.attach(target);
    const w = keyEvent('keydown', 'KeyW');
    target.dispatchEvent(w);
    expect(w.defaultPrevented).toBe(true);
    const z = keyEvent('keydown', 'KeyZ');
    target.dispatchEvent(z);
    expect(z.defaultPrevented).toBe(false);
    expect([...src.poll().buttons]).toEqual(['up']);
    expect([...src.poll().buttons]).toEqual(['up']);
    target.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(src.poll().buttons.size).toBe(0);
    expect(src.poll().axis).toEqual({ x: 0, y: 0 });
    expect(src.poll().pointer).toBeNull();
  });

  it('latches a key pressed and released between polls so a quick tap counts once', () => {
    const src = createKeyboardSource({ Space: 'a' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(keyEvent('keydown', 'Space'));
    target.dispatchEvent(keyEvent('keyup', 'Space'));
    expect([...src.poll().buttons]).toEqual(['a']);
    expect(src.poll().buttons.size).toBe(0);
  });

  it('ignores key repeats, system-modifier chords and events without a code', () => {
    const src = createKeyboardSource({ KeyW: 'up', Space: 'a' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    target.dispatchEvent(keyEvent('keyup', 'KeyW'));
    src.poll();
    target.dispatchEvent(keyEvent('keydown', 'KeyW', { repeat: true }));
    expect(src.poll().buttons.size).toBe(0);
    const chord = keyEvent('keydown', 'Space', { metaKey: true });
    target.dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(false);
    expect(src.poll().buttons.size).toBe(0);
    target.dispatchEvent(new Event('keydown'));
    expect(src.poll().buttons.size).toBe(0);
  });

  it('releases everything on blur and on detach', () => {
    const src = createKeyboardSource({ KeyW: 'up', KeyD: 'right' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    target.dispatchEvent(keyEvent('keydown', 'KeyD'));
    expect(src.poll().buttons.size).toBe(2);
    target.dispatchEvent(new Event('blur'));
    expect(src.poll().buttons.size).toBe(0);
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    src.detach();
    expect(src.poll().buttons.size).toBe(0);
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(src.poll().buttons.size).toBe(0);
  });

  it('applies a new device map to keys that are already held', () => {
    const src = createKeyboardSource({ KeyW: 'up' });
    src.keyDown('KeyW');
    src.keyDown('KeyZ');
    expect([...src.poll().buttons]).toEqual(['up']);
    src.setDeviceMap({ keyboard: { KeyW: 'a', KeyZ: 'b' }, mouse: {}, gamepadDeadzone: 0 });
    expect([...src.poll().buttons].sort()).toEqual(['a', 'b']);
    expect([...src.heldCodes()]).toEqual(['KeyW', 'KeyZ']);
    src.keyUp('KeyW');
    expect([...src.poll().buttons]).toEqual(['b']);
  });

  it('does not treat prototype names as game keys', () => {
    const src = createKeyboardSource({ KeyW: 'up' });
    src.keyDown('constructor');
    src.keyDown('__proto__');
    expect(src.poll().buttons.size).toBe(0);
  });
});
