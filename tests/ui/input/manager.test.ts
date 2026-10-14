import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { vec2 } from '@/core/vec2';
import { createInputManager } from '@/ui/input/manager';
import { loadDefaultProfile, rebind } from '@/ui/input/schemes';
import type { Action, Button, InputSource, InputState, PointerState } from '@/ui/input/types';

interface FakeSource extends InputSource {
  press(b: Button): void;
  release(b: Button): void;
  setAxis(x: number, y: number): void;
  setPointer(p: Partial<PointerState> | null): void;
  attached: EventTarget | null;
}

const fakeSource = (device: InputState['lastDevice']): FakeSource => {
  const buttons = new Set<Button>();
  let axis = vec2(0, 0);
  let pointer: PointerState | null = null;
  const src: FakeSource = {
    device,
    attached: null,
    poll: () => {
      const out = { buttons: new Set(buttons), axis: vec2(axis.x, axis.y), pointer: pointer ? { ...pointer } : null };
      if (pointer) {
        pointer.justDown = false;
        pointer.justUp = false;
      }
      return out;
    },
    attach: (t) => {
      src.attached = t;
    },
    detach: () => {
      src.attached = null;
    },
    press: (b) => buttons.add(b),
    release: (b) => buttons.delete(b),
    setAxis: (x, y) => {
      axis = vec2(x, y);
    },
    setPointer: (p) => {
      pointer = p ? { x: 0, y: 0, down: false, justDown: false, justUp: false, drag: null, ...p } : null;
    },
  };
  return src;
};

const setup = () => {
  const kb = fakeSource('keyboard');
  const pad = fakeSource('gamepad');
  const mouse = fakeSource('mouse');
  const touch = fakeSource('touch');
  const manager = createInputManager([kb, pad, mouse, touch], loadDefaultProfile());
  return { kb, pad, mouse, touch, manager };
};

describe('InputManager edges', () => {
  it('accumulates edges across frames until consumeTick, then clears them', () => {
    const { kb, manager } = setup();
    kb.press('a');
    manager.update();
    manager.update();
    manager.update();
    const tick = manager.consumeTick();
    expect(tick.justPressed.has('confirm')).toBe(true);
    expect(tick.justPressed.has('snap')).toBe(true);
    expect(tick.down.has('confirm')).toBe(true);
    const next = manager.consumeTick();
    expect(next.justPressed.size).toBe(0);
    expect(next.down.has('confirm')).toBe(true);
  });

  it('an edge is seen by exactly one tick even when several ticks run per frame', () => {
    const { kb, manager } = setup();
    kb.press('b');
    manager.update();
    const ticks = [manager.consumeTick(), manager.consumeTick(), manager.consumeTick()];
    expect(ticks.map((t) => t.justPressed.has('juke'))).toEqual([true, false, false]);
    kb.release('b');
    manager.update();
    const after = [manager.consumeTick(), manager.consumeTick()];
    expect(after.map((t) => t.justReleased.has('juke'))).toEqual([true, false]);
    expect(after[0]?.down.has('juke')).toBe(false);
  });

  it('a press and release between two ticks report both edges with the action not down', () => {
    const { kb, manager } = setup();
    manager.consumeTick();
    kb.press('x');
    manager.update();
    kb.release('x');
    manager.update();
    const tick = manager.consumeTick();
    expect(tick.justPressed.has('spin')).toBe(true);
    expect(tick.justReleased.has('spin')).toBe(true);
    expect(tick.down.has('spin')).toBe(false);
  });

  it('held state persists across ticks without re-firing edges', () => {
    const { kb, manager } = setup();
    kb.press('rt');
    for (let i = 0; i < 5; i++) {
      manager.update();
      const tick = manager.consumeTick();
      expect(tick.down.has('sprint')).toBe(true);
      expect(tick.justPressed.has('sprint')).toBe(i === 0);
      expect(manager.isDown('sprint')).toBe(true);
      expect(manager.justPressed('sprint')).toBe(i === 0);
    }
  });

  it('consumeTick without a prior update reports no edges and keeps the last held state', () => {
    const { kb, manager } = setup();
    kb.press('y');
    manager.update();
    manager.consumeTick();
    const tick = manager.consumeTick();
    expect(tick.justPressed.size).toBe(0);
    expect(tick.down.has('audible')).toBe(true);
  });

  it('every transition is reported exactly once under a random press/release/tick sequence', () => {
    const { kb, pad, manager } = setup();
    const rng = createRng(20260923);
    const sources = [kb, pad];
    const buttons: Button[] = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'up', 'down', 'left', 'right', 'start', 'select', 'l3', 'r3'];
    const scheme = manager.getScheme();
    const actions = Object.keys(scheme) as Action[];
    const rawHeld = new Map<FakeSource, Set<Button>>(sources.map((s) => [s, new Set<Button>()]));
    let prevDown = new Set<Action>();
    const expectedPressed = new Set<Action>();
    const expectedReleased = new Set<Action>();
    const resolve = (): Set<Action> => {
      const merged = new Set<Button>();
      for (const held of rawHeld.values()) for (const b of held) merged.add(b);
      return new Set(actions.filter((a) => scheme[a].some((b) => merged.has(b))));
    };
    let ticks = 0;
    let edges = 0;
    for (let step = 0; step < 3000; step++) {
      const roll = rng.next();
      if (roll < 0.55) {
        const src = rng.pick(sources);
        const b = rng.pick(buttons);
        const held = rawHeld.get(src) as Set<Button>;
        if (held.has(b)) {
          held.delete(b);
          src.release(b);
        } else {
          held.add(b);
          src.press(b);
        }
      } else if (roll < 0.8) {
        manager.update();
        const now = resolve();
        for (const a of now) if (!prevDown.has(a)) expectedPressed.add(a);
        for (const a of prevDown) if (!now.has(a)) expectedReleased.add(a);
        prevDown = now;
      } else {
        const tick = manager.consumeTick();
        expect([...tick.justPressed].sort()).toEqual([...expectedPressed].sort());
        expect([...tick.justReleased].sort()).toEqual([...expectedReleased].sort());
        expect([...tick.down].sort()).toEqual([...prevDown].sort());
        edges += expectedPressed.size + expectedReleased.size;
        expectedPressed.clear();
        expectedReleased.clear();
        ticks++;
      }
    }
    expect(ticks).toBeGreaterThan(400);
    expect(edges).toBeGreaterThan(500);
  });
});

describe('InputManager merging and axis', () => {
  it('merges buttons from several sources; an action stays down until every source releases', () => {
    const { kb, pad, manager } = setup();
    kb.press('a');
    pad.press('a');
    manager.update();
    manager.consumeTick();
    kb.release('a');
    manager.update();
    let tick = manager.consumeTick();
    expect(tick.down.has('confirm')).toBe(true);
    expect(tick.justReleased.has('confirm')).toBe(false);
    pad.release('a');
    manager.update();
    tick = manager.consumeTick();
    expect(tick.down.has('confirm')).toBe(false);
    expect(tick.justReleased.has('confirm')).toBe(true);
  });

  it('digital move actions produce a screen-frame axis (+y down)', () => {
    const { kb, manager } = setup();
    kb.press('up');
    manager.update();
    expect(manager.consumeTick().axis).toEqual({ x: 0, y: -1 });
    kb.press('right');
    manager.update();
    const diag = manager.consumeTick().axis;
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1);
    expect(diag.x).toBeCloseTo(Math.SQRT1_2);
    expect(diag.y).toBeCloseTo(-Math.SQRT1_2);
    kb.press('left');
    manager.update();
    expect(manager.consumeTick().axis).toEqual({ x: 0, y: -1 });
    kb.press('down');
    manager.update();
    expect(manager.consumeTick().axis).toEqual({ x: 0, y: 0 });
  });

  it('sums analog axes from every source with digital moves and clamps the magnitude to 1', () => {
    const { kb, pad, touch, manager } = setup();
    pad.setAxis(0.6, 0);
    touch.setAxis(0.3, 0);
    manager.update();
    const summed = manager.consumeTick().axis;
    expect(summed.x).toBeCloseTo(0.9);
    expect(summed.y).toBe(0);
    kb.press('right');
    manager.update();
    const tick = manager.consumeTick();
    expect(tick.axis.x).toBeCloseTo(1);
    expect(tick.axis.y).toBe(0);
    expect(manager.axis().x).toBeCloseTo(1);
    pad.setAxis(0.8, 0.8);
    touch.setAxis(0, 0);
    kb.release('right');
    manager.update();
    const clamped = manager.consumeTick().axis;
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(1);
    expect(clamped.x).toBeCloseTo(clamped.y);
    pad.setAxis(0.3, -0.4);
    manager.update();
    expect(manager.consumeTick().axis).toEqual({ x: 0.3, y: -0.4 });
  });

  it('axis() returns a copy of the snapshot axis', () => {
    const { pad, manager } = setup();
    pad.setAxis(0.5, 0);
    manager.update();
    manager.consumeTick();
    const a = manager.axis();
    a.x = 99;
    expect(manager.axis().x).toBe(0.5);
  });
});

describe('InputManager scheme and device map', () => {
  it('rebind updates isDown without emitting phantom edges', () => {
    const { kb, manager } = setup();
    kb.press('x');
    manager.update();
    manager.consumeTick();
    expect(manager.isDown('spin')).toBe(true);
    expect(manager.isDown('juke')).toBe(false);
    manager.setScheme(rebind(manager.getScheme(), 'juke', ['x']));
    manager.update();
    const tick = manager.consumeTick();
    expect(manager.isDown('juke')).toBe(true);
    expect(tick.justPressed.has('juke')).toBe(false);
    expect(manager.getScheme().juke).toEqual(['x']);
    manager.setScheme(rebind(manager.getScheme(), 'spin', ['y']));
    manager.update();
    const after = manager.consumeTick();
    expect(manager.isDown('spin')).toBe(false);
    expect(after.justReleased.has('spin')).toBe(false);
  });

  it('getScheme/getDeviceMap return copies and setDeviceMap propagates to sources', () => {
    const { kb, manager } = setup();
    const seen: string[] = [];
    kb.setDeviceMap = (m) => seen.push(String(m.gamepadDeadzone));
    const scheme = manager.getScheme();
    scheme.confirm.push('y');
    expect(manager.getScheme().confirm).toEqual(['a']);
    const map = manager.getDeviceMap();
    map.gamepadDeadzone = 0.5;
    map.keyboard['KeyZ'] = 'a';
    expect(manager.getDeviceMap().gamepadDeadzone).not.toBe(0.5);
    manager.setDeviceMap(map);
    expect(manager.getDeviceMap().keyboard['KeyZ']).toBe('a');
    expect(seen).toEqual(['0.5']);
  });

  it('does not mutate the profile passed in', () => {
    const profile = loadDefaultProfile();
    const manager = createInputManager([], profile);
    manager.setScheme(rebind(profile.scheme, 'snap', ['y']));
    expect(profile.scheme.snap).toEqual(['a']);
  });
});

describe('InputManager lastDevice, pointer and glyphs', () => {
  it('tracks the device that produced the latest input and picks glyphs for it', () => {
    const { kb, pad, mouse, touch, manager } = setup();
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('keyboard');
    expect(manager.glyph('confirm')).toBe('Space');
    expect(manager.glyph('moveUp')).toBe('W');
    pad.press('a');
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('gamepad');
    expect(manager.glyph('confirm')).toBe('A');
    expect(manager.glyph('sprint')).toBe('RT');
    kb.press('b');
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('keyboard');
    pad.release('a');
    kb.release('b');
    pad.setAxis(0.7, 0);
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('gamepad');
    pad.setAxis(0, 0);
    mouse.setPointer({ x: 10, y: 10, down: true, justDown: true });
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('mouse');
    expect(manager.glyph('confirm')).toBe('LMB');
    expect(manager.glyph('sprint')).toBe('Shift');
    touch.press('a');
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('touch');
    expect(manager.glyph('confirm')).toBe('Tap A');
    expect(manager.glyph('throw1')).toBe('Tap');
  });

  it('a held key on one device does not steal lastDevice from a fresh press elsewhere', () => {
    const { kb, pad, manager } = setup();
    kb.press('rt');
    manager.update();
    manager.consumeTick();
    pad.press('a');
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('gamepad');
    manager.update();
    expect(manager.consumeTick().lastDevice).toBe('gamepad');
  });

  it('accumulates pointer edges across frames and clears them per tick', () => {
    const { mouse, manager } = setup();
    mouse.setPointer({ x: 100, y: 50, down: true, justDown: true });
    manager.update();
    mouse.setPointer({ x: 120, y: 60, down: false, justUp: true });
    manager.update();
    const tick = manager.consumeTick();
    expect(tick.pointer).toEqual({ x: 120, y: 60, down: false, justDown: true, justUp: true, drag: null });
    const next = manager.consumeTick();
    expect(next.pointer?.justDown).toBe(false);
    expect(next.pointer?.justUp).toBe(false);
    expect(next.pointer?.x).toBe(120);
  });

  it('attach/detach forward to every source', () => {
    const { kb, pad, manager } = setup();
    const target = new EventTarget();
    manager.attach(target);
    expect(kb.attached).toBe(target);
    expect(pad.attached).toBe(target);
    manager.detach();
    expect(kb.attached).toBeNull();
  });

  it('an idle mouse pointer does not displace a touch tap before its edges are consumed', () => {
    const { mouse, touch, manager } = setup();
    mouse.setPointer({ x: 5, y: 5 });
    manager.update();
    manager.consumeTick();
    touch.setPointer({ x: 200, y: 100, down: false, justDown: true, justUp: true });
    manager.update();
    // Zero-tick frame: both pointers are now idle; the touch one must survive the tie.
    manager.update();
    const tick = manager.consumeTick();
    expect(tick.pointer).toMatchObject({ x: 200, y: 100, justDown: true, justUp: true });
    expect(tick.lastDevice).toBe('touch');
    mouse.setPointer({ x: 50, y: 60 });
    manager.update();
    expect(manager.consumeTick().pointer).toMatchObject({ x: 50, y: 60 });
  });
});
