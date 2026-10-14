import { describe, expect, it, vi } from 'vitest';
import { assignButton, captureScheme, capturedButton, conflictsFor, describeButton, findConflicts, keyName, actionLabel, CONTROL_GROUPS } from '@/ui/input/remap';
import { ACTIONS, loadDefaultProfile } from '@/ui/input/schemes';
import { RemapScreen } from '@/ui/screens/remap';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from '../game/fixtures';

describe('remap model', () => {
  const base = loadDefaultProfile();
  it('the default layout has no clashes and every action is listed once', () => {
    expect(findConflicts(base.scheme)).toEqual([]);
    const listed = CONTROL_GROUPS.flatMap((g) => g.actions);
    expect([...listed].sort()).toEqual([...ACTIONS].sort());
  });

  it('finds clashes inside one situation only, and swaps on assignment', () => {
    // juke (b) onto x clashes with spin (x) for the ball carrier; spin moves to b.
    const r = assignButton(base.scheme, 'juke', 'x');
    expect(r.scheme.juke[0]).toBe('x');
    expect(r.swapped).toEqual(['spin']);
    expect(r.scheme.spin).toEqual(['b']);
    expect(r.conflicts).toEqual([]);
    // tackle on b would clash with switchPlayer on defense; throw1 (a) is not read on defense.
    const clash = { ...base.scheme, tackle: ['b' as const] };
    expect(conflictsFor(clash, 'tackle')).toContain('switchPlayer');
    expect(findConflicts(clash).some((c) => c.context === 'defense' && c.button === 'b')).toBe(true);
  });

  it('reads the pressed button back under the capture scheme and names keys', () => {
    const cap = captureScheme();
    const seen = new Set(Object.values(cap).flat());
    expect(seen.size).toBe(16);
    expect(capturedButton(makeInput({ pressed: ['menuTabRight'] }))).toBe('rb');
    expect(capturedButton(makeInput())).toBeNull();
    expect(keyName('KeyK')).toBe('K');
    expect(keyName('ArrowUp')).toBe('UP');
    expect(describeButton('a', base.deviceMap.keyboard)).toBe('A · SPACE K 1');
    expect(actionLabel('throwAway')).toBe('THROW AWAY');
  });
});

describe('RemapScreen', () => {
  it('press-to-bind on any device, cancel with Esc / timeout, clash note, persist and reset', () => {
    const ui = makeUi();
    const persist = vi.fn();
    const setScheme = vi.spyOn(ui.services.input, 'setScheme');
    const screen = new RemapScreen(ui.settings, { persist });
    ui.stack.push(screen);
    screen.render(ui.rc);
    expect(screen.list.selected?.id).toBe('bind:confirm');
    const idx = screen.list.items.findIndex((i) => i.id === 'bind:juke');
    screen.list.select(idx);
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(screen.capturing).toBe('juke');
    expect(setScheme).toHaveBeenLastCalledWith(captureScheme());
    // Under the capture scheme the X button raises showPlayArt.
    ui.stack.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }));
    expect(screen.capturing).toBeNull();
    expect(ui.settings.bindings['juke']).toEqual(['x']);
    expect(ui.settings.bindings['spin']).toEqual(['b']);
    expect(screen.lastNote).toContain('SWAPPED WITH SPIN');
    expect(persist).toHaveBeenCalled();
    screen.render(ui.rc);
    // Esc (select) cancels; a timeout cancels too.
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    ui.stack.update(1 / 60, makeInput({ pressed: ['devOverlayCycle'] }));
    expect(screen.capturing).toBeNull();
    expect(screen.lastNote).toBe('NO CHANGE');
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    for (let i = 0; i < 6 * 60 && screen.capturing; i++) ui.stack.update(1 / 60, makeInput());
    expect(screen.capturing).toBeNull();
    // Left/right step through buttons.
    ui.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(ui.settings.bindings['juke']?.[0]).not.toBe('x');
    screen.reset();
    expect(ui.settings.bindings['juke']).toEqual(['b']);
    screen.render({ ...ui.rc, theme: ui.services.theme });
    ui.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(ui.stack.size).toBe(0);
  });
});
