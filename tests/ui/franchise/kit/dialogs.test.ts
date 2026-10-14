import { describe, expect, it, vi } from 'vitest';
import { LetterGridModel, StepperModel, snapToStep, ABBR_ROWS } from '@/ui/franchise/kit/dialog-models';
import { ChoiceDialog, ConfirmDialog, StepperDialog, TextEntryDialog } from '@/ui/franchise/kit/dialogs';
import { formatMoney } from '@/ui/franchise/kit/format';
import { createHeadlessServices } from '@/ui/franchise/context';
import type { RenderContext, Screen, ScreenServices } from '@/ui/screens/screen';
import { createFakeCtx, makeInput, pointerAt } from '../../render/fake-ctx';

const base: Screen = { id: 'base', enter: () => undefined, exit: () => undefined, update: () => undefined, render: () => undefined };
const setup = (settings = {}): { services: ScreenServices; rc: RenderContext; toasts: string[] } => {
  const toasts: string[] = [];
  const services = createHeadlessServices(settings, (m) => toasts.push(m));
  services.stack.push(base);
  const rc: RenderContext = { ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 };
  return { services, rc, toasts };
};

describe('stepper model', () => {
  it('snaps to the step grid and clamps', () => {
    expect(snapToStep(1_234_567, { min: 500_000, max: 30_000_000, step: 50_000 })).toBe(1_250_000);
    expect(snapToStep(-5, { min: 1, max: 7, step: 1 })).toBe(1);
    expect(snapToStep(99, { min: 1, max: 7, step: 1 })).toBe(7);
    expect(snapToStep(0.35, { min: 0, max: 1, step: 0.1 })).toBe(0.4);
    expect(snapToStep(Number.NaN, { min: 2, max: 7, step: 1 })).toBe(2);
    expect(() => snapToStep(1, { min: 0, max: 1, step: 0 })).toThrow();
  });
  it('steps within bounds with small and big steps across fields', () => {
    const m = new StepperModel([
      { id: 'salary', label: 'Salary', min: 1_000_000, max: 5_000_000, step: 100_000, value: 4_950_000 },
      { id: 'years', label: 'Years', min: 1, max: 5, step: 1, bigStep: 2, value: 3 },
    ]);
    expect(m.value('salary')).toBe(5_000_000);
    expect(m.atMax()).toBe(true);
    expect(m.step(1)).toBe(false);
    expect(m.step(-1, true)).toBe(true);
    expect(m.value('salary')).toBe(4_000_000);
    m.moveFocus(1);
    expect(m.focused.id).toBe('years');
    m.step(1, true);
    m.step(1, true);
    expect(m.value('years')).toBe(5);
    m.step(-1);
    expect(m.values()).toEqual({ salary: 4_000_000, years: 4 });
    expect(m.moveFocus(1)).toBe(true);
    expect(m.focus).toBe(0);
    expect(m.value('nope')).toBeNaN();
    expect(() => new StepperModel([])).toThrow();
  });
});

describe('letter grid model', () => {
  it('types with title casing, deletes and respects max length', () => {
    const g = new LetterGridModel({ maxLength: 8 });
    for (const ch of 'HARBOR') g.type(ch);
    expect(g.text).toBe('Harbor');
    expect(g.type(' ')).toBe(true);
    expect(g.type(' ')).toBe(false);
    g.type('x');
    expect(g.text).toBe('Harbor X');
    expect(g.type('Y')).toBe(false);
    g.focus(0, 0);
    expect(g.press()).toBe('full');
    expect(g.backspace()).toBe(true);
    expect(g.text).toBe('Harbor ');
    expect(g.result()).toBe('Harbor');
  });
  it('navigates the grid with wrap and presses special keys', () => {
    const g = new LetterGridModel({ maxLength: 4, rows: ABBR_ROWS, allowSpace: false, casing: 'upper', minLength: 2, validate: (t) => (t === 'XX' ? 'Taken' : null) });
    expect(g.keys[g.keys.length - 1]).toEqual(['DEL', 'OK']);
    expect(g.key).toBe('A');
    g.move(-1, 0);
    expect(g.key).toBe('M');
    g.move(0, 1);
    expect(g.key).toBe('Z');
    expect(g.press()).toBe('typed');
    g.move(0, 1);
    expect(g.key).toBe('OK');
    expect(g.press()).toBe('invalid');
    expect(g.error).toBe('At least 2 characters');
    g.type('q');
    expect(g.text).toBe('ZQ');
    expect(g.press()).toBe('submit');
    g.move(-1, 0);
    expect(g.press()).toBe('deleted');
    g.type('x');
    g.backspace();
    g.backspace();
    g.type('X');
    g.type('X');
    expect(g.error).toBe('Taken');
    expect(g.type('1')).toBe(false);
    expect(new LetterGridModel({ maxLength: 3, initial: 'abcd' }).text).toBe('Abc');
  });
});

describe('dialog screens', () => {
  it('confirm resolves once, pops itself and treats back as no', () => {
    const { services, rc } = setup();
    const onResult = vi.fn();
    const d = new ConfirmDialog('Release player?', 'His dead money will count against the cap.', { onResult, defaultNo: true });
    services.stack.push(d);
    d.render(rc);
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(onResult).toHaveBeenCalledWith(false);
    expect(services.stack.top).toBe(base);
    const yes = vi.fn();
    const d2 = new ConfirmDialog('Sure?', '', { onResult: yes });
    services.stack.push(d2);
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    d2.choose(false);
    expect(yes).toHaveBeenCalledTimes(1);
    expect(yes).toHaveBeenCalledWith(true);
    const no = vi.fn();
    services.stack.push(new ConfirmDialog('Sure?', '', { onResult: no }));
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(no).toHaveBeenCalledWith(false);
  });
  it('choice returns the picked id or null', () => {
    const { services, rc } = setup({ textSize: 'large' });
    const onResult = vi.fn();
    const d = new ChoiceDialog('Training focus', 'Pick one', [{ id: 'a', label: 'Speed' }, { id: 'b', label: 'Hands', disabled: true }, { id: 'c', label: 'Strength' }], onResult);
    services.stack.push(d);
    d.render(rc);
    services.stack.update(1 / 60, makeInput({ pressed: ['menuDown'] }));
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(onResult).toHaveBeenCalledWith('c');
    const cancel = vi.fn();
    services.stack.push(new ChoiceDialog('X', '', [{ id: 'a', label: 'A' }], cancel));
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(cancel).toHaveBeenCalledWith(null);
  });
  it('stepper dialog steps with keys and taps, validates and submits', () => {
    const { services, rc, toasts } = setup();
    const onResult = vi.fn();
    const d = new StepperDialog('Offer', 'Make an offer', [
      { id: 'salary', label: 'Salary', min: 1_000_000, max: 20_000_000, step: 250_000, bigStep: 1_000_000, value: 2_000_000, format: formatMoney },
      { id: 'years', label: 'Years', min: 1, max: 5, step: 1, value: 2 },
    ], { onResult, summary: (v) => `${v.years}y ${formatMoney((v.salary ?? 0) * (v.years ?? 0))}`, validate: (v) => ((v.salary ?? 0) < 3_000_000 ? 'Too low' : null) });
    services.stack.push(d);
    services.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(d.model.value('salary')).toBe(2_250_000);
    services.stack.update(1 / 60, makeInput({ pressed: ['menuTabRight'] }));
    expect(d.model.value('salary')).toBe(3_250_000);
    services.stack.update(1 / 60, makeInput({ pressed: ['menuTabLeft'] }));
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(toasts).toContain('Too low');
    expect(onResult).not.toHaveBeenCalled();
    d.render(rc);
    const hits = d.hitMap;
    if (!hits) throw new Error('hits');
    const years = hits.fields[1];
    if (!years) throw new Error('years');
    services.stack.update(1 / 60, makeInput({ pointer: pointerAt(years.plus.x + 1, years.plus.y + 1, true), device: 'touch' }));
    expect(d.model.value('years')).toBe(3);
    expect(d.model.focus).toBe(1);
    d.model.setValue('salary', 4_000_000);
    expect(d.summary).toBe('3y $12.0M');
    services.stack.update(1 / 60, makeInput({ pointer: pointerAt(hits.ok.x + 1, hits.ok.y + 1, true), device: 'touch' }));
    expect(onResult).toHaveBeenCalledWith({ salary: 4_000_000, years: 3 });
    expect(services.stack.top).toBe(base);
  });
  it('text entry types from the grid, deletes, submits and cancels', () => {
    const { services, rc } = setup();
    const onResult = vi.fn();
    const d = new TextEntryDialog('Team name', '', { maxLength: 12 }, onResult);
    services.stack.push(d);
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    services.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(d.model.text).toBe('Ab');
    services.stack.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }));
    expect(d.model.text).toBe('A');
    d.render(rc);
    const z = d.keys.find((k) => k.key === 'Z');
    if (!z) throw new Error('key');
    services.stack.update(1 / 60, makeInput({ pointer: pointerAt(z.rect.x + 1, z.rect.y + 1, true), device: 'touch' }));
    expect(d.model.text).toBe('Az');
    services.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    expect(onResult).toHaveBeenCalledWith('Az');
    const cancel = vi.fn();
    const d2 = new TextEntryDialog('Abbr', '', { maxLength: 4, initial: 'B' }, cancel);
    services.stack.push(d2);
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(d2.model.text).toBe('');
    expect(cancel).not.toHaveBeenCalled();
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(cancel).toHaveBeenCalledWith(null);
  });
});
