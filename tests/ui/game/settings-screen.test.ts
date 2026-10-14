import { describe, expect, it, vi } from 'vitest';
import { loadDefaultProfile, validateScheme } from '@/ui/input/schemes';
import { RemapScreen } from '@/ui/screens/remap';
import { SettingsScreen, bindingConflicts, cycleBinding } from '@/ui/screens/settings';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from './fixtures';

describe('rebinding', () => {
  it('cycles the primary button and always yields a valid, complete scheme', () => {
    const base = loadDefaultProfile().scheme;
    expect(base.snap).toEqual(['a']);
    const next = cycleBinding(base, 'snap', 1);
    expect(next.snap[0]).toBe('b');
    expect(validateScheme(next).ok).toBe(true);
    expect(base.snap).toEqual(['a']);
    const back = cycleBinding(next, 'snap', -1);
    expect(back.snap[0]).toBe('a');
    const wrapped = cycleBinding(base, 'back', -1);
    expect(wrapped.back[0]).toBe('a');
    expect(wrapped.back).toContain('select');
    expect(bindingConflicts(base, 'snap')).toEqual(expect.arrayContaining(['confirm', 'throw1', 'tackle', 'kick']));
    expect(bindingConflicts(base, 'cameraCycle')).toEqual([]);
  });
});

describe('SettingsScreen', () => {
  it('edits settings in place, applies them live and persists', () => {
    const ui = makeUi();
    const persist = vi.fn();
    const setScheme = vi.spyOn(ui.services.input, 'setScheme');
    const screen = new SettingsScreen(ui.settings, { persist });
    ui.stack.push(screen);
    screen.change('textSize', 1);
    expect(ui.settings.textSize).toBe('large');
    expect(ui.services.theme.textScale).toBe(2);
    expect(persist).toHaveBeenCalledWith(ui.settings);
    screen.change('audio:master', -1);
    expect(ui.settings.audio.master).toBeCloseTo(0.7);
    // CAMERA ZOOM cycles CLOSE (the default) -> STANDARD -> WIDE and wraps both ways.
    expect(screen.list.items.find((i) => i.id === 'cameraZoom')?.value).toBe('CLOSE');
    screen.change('cameraZoom', 1);
    expect(ui.settings.cameraZoom).toBe('standard');
    expect(screen.list.items.find((i) => i.id === 'cameraZoom')?.value).toBe('STANDARD');
    screen.change('cameraZoom', 1);
    expect(ui.settings.cameraZoom).toBe('wide');
    screen.change('cameraZoom', 1);
    expect(ui.settings.cameraZoom).toBe('close');
    screen.change('cameraZoom', -1);
    expect(ui.settings.cameraZoom).toBe('wide');
    expect(persist).toHaveBeenLastCalledWith(ui.settings);
    screen.change('cameraZoom', 1);
    screen.change('camera:defense', 1);
    expect(ui.settings.camera.defense).toBe('standard');
    screen.change('camera:defense', -1);
    expect(ui.settings.camera.defense).toBeUndefined();
    screen.change('defenseMode', 1);
    expect(ui.settings.defenseMode).toBe('watch');
    screen.change('simSpeed', 1);
    expect(ui.settings.simSpeed).toBe(8);
    // CONTROLS opens the remap screen (press-to-bind, clash detection); it shares the settings and persist.
    screen.activate('controls');
    const remap = ui.stack.top;
    if (!(remap instanceof RemapScreen)) throw new Error('expected the remap screen');
    remap.cycle('snap', 1);
    expect(ui.settings.bindings['snap']).toEqual(['b']);
    expect(setScheme).toHaveBeenCalled();
    expect(remap.controlScheme.snap[0]).toBe('b');
    remap.reset();
    expect(ui.settings.bindings['snap']).toEqual(['a']);
    ui.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(ui.stack.top).toBe(screen);
    expect(ui.stack.size).toBe(1);
    screen.activate('back');
    expect(ui.stack.size).toBe(0);
  });

  it('navigates with input and renders with the live theme', () => {
    const ui = makeUi();
    const screen = new SettingsScreen(ui.settings);
    ui.stack.push(screen);
    expect(screen.list.selected?.id).toBe('gameSpeed');
    // The default pace is 1.25x (owner request: faster players); the list steps 0.5 .. 2x.
    expect(ui.settings.gameSpeed).toBe(1.25);
    screen.update(1 / 60, makeInput({ pressed: ['menuRight'] }), ui.services);
    expect(ui.settings.gameSpeed).toBe(1.5);
    screen.update(1 / 60, makeInput({ pressed: ['menuLeft'] }), ui.services);
    screen.update(1 / 60, makeInput({ pressed: ['menuLeft'] }), ui.services);
    expect(ui.settings.gameSpeed).toBe(1);
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(100);
    // Rows fill the panel (not a fixed 9) and keep the selection; large text shows fewer, taller rows.
    const normalRows = screen.list.maxVisible;
    expect(normalRows === 0 || normalRows > 9).toBe(true);
    expect(screen.list.selected?.id).toBe('gameSpeed');
    screen.change('textSize', 1);
    screen.render({ ...ui.rc, theme: ui.services.theme });
    expect(screen.list.maxVisible).toBeGreaterThan(0);
    expect(screen.list.maxVisible).toBeLessThan(normalRows === 0 ? screen.list.items.length : normalRows);
    expect(screen.list.selected?.id).toBe('gameSpeed');
    screen.change('textSize', -1);
    screen.update(1 / 60, makeInput({ pressed: ['back'] }), ui.services);
    expect(ui.stack.size).toBe(0);
  });
});
