import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createTheme } from '@/ui/theme';
import { MenuList, type MenuItem } from '@/ui/widgets/menu';
import { createFakeCtx, makeInput, pointerAt } from './fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const items = (): MenuItem[] => [
  { id: 'a', label: 'ALPHA' },
  { id: 'b', label: 'BRAVO', disabled: true },
  { id: 'c', label: 'CHARLIE', subLabel: 'third' },
  { id: 'd', label: 'DELTA', value: 'ON' },
];

describe('MenuList navigation', () => {
  it('wraps in both directions and skips disabled items', () => {
    const m = new MenuList(items());
    expect(m.selectedIndex).toBe(0);
    expect(m.move(1)).toBe(true);
    expect(m.selected?.id).toBe('c');
    m.move(1);
    expect(m.selected?.id).toBe('d');
    m.move(1);
    expect(m.selected?.id).toBe('a');
    m.move(-1);
    expect(m.selected?.id).toBe('d');
    m.move(-1);
    expect(m.selected?.id).toBe('c');
    m.move(-1);
    expect(m.selected?.id).toBe('a');
  });
  it('stops at the ends without wrap and refuses disabled selection', () => {
    const m = new MenuList(items(), { wrap: false });
    expect(m.move(-1)).toBe(false);
    expect(m.select(1)).toBe(false);
    expect(m.selected?.id).toBe('a');
    m.move(1);
    m.move(1);
    expect(m.move(1)).toBe(false);
    expect(m.selected?.id).toBe('d');
  });
  it('starts on the first enabled item and handles all-disabled lists', () => {
    const m = new MenuList([{ id: 'x', label: 'X', disabled: true }, { id: 'y', label: 'Y' }]);
    expect(m.selected?.id).toBe('y');
    const none = new MenuList([{ id: 'x', label: 'X', disabled: true }]);
    expect(none.selected).toBeNull();
    expect(none.update(0.016, makeInput({ pressed: ['confirm'] }))).toBeNull();
  });
  it('keeps the selection by id when items change', () => {
    const m = new MenuList(items(), { initialIndex: 3 });
    m.setItems([{ id: 'z', label: 'Z' }, { id: 'd', label: 'DELTA' }]);
    expect(m.selectedIndex).toBe(1);
    m.setItems([{ id: 'q', label: 'Q' }]);
    expect(m.selectedIndex).toBe(0);
  });
});

describe('MenuList input', () => {
  it('moves once on a digital press even when the button is also held', () => {
    const m = new MenuList(items());
    const ev = m.update(0.016, makeInput({ pressed: ['menuDown'] }));
    expect(ev).toMatchObject({ type: 'select', index: 2 });
    expect(m.update(0.016, makeInput({ down: ['menuDown'] }))).toBeNull();
    expect(m.selectedIndex).toBe(2);
  });
  it('repeats while held after the initial delay', () => {
    const m = new MenuList(items(), { repeatDelay: 0.3, repeatRate: 0.1 });
    m.update(0.016, makeInput({ pressed: ['moveDown'] }));
    expect(m.selectedIndex).toBe(2);
    for (let i = 0; i < 18; i++) expect(m.update(0.016, makeInput({ down: ['moveDown'] }))).toBeNull();
    const ev = m.update(0.016, makeInput({ down: ['moveDown'] }));
    expect(ev).toMatchObject({ type: 'select', index: 3 });
    for (let i = 0; i < 5; i++) expect(m.update(0.016, makeInput({ down: ['moveDown'] }))).toBeNull();
    expect(m.update(0.03, makeInput({ down: ['moveDown'] }))).toMatchObject({ type: 'select', index: 0 });
  });
  it('treats the analog axis like a held direction', () => {
    const m = new MenuList(items());
    expect(m.update(0.016, makeInput({ axis: { x: 0, y: -0.9 } }))).toMatchObject({ type: 'select', index: 3 });
    expect(m.update(0.016, makeInput({ axis: { x: 0, y: -0.9 } }))).toBeNull();
    expect(m.update(0.016, makeInput({ axis: { x: 0, y: 0 } }))).toBeNull();
    expect(m.update(0.016, makeInput({ axis: { x: 0, y: 0.9 } }))).toMatchObject({ type: 'select', index: 0 });
  });
  it('emits activate, back and change events', () => {
    const m = new MenuList(items());
    expect(m.update(0.016, makeInput({ pressed: ['confirm'] }))).toMatchObject({ type: 'activate', index: 0, item: { id: 'a' } });
    expect(m.update(0.016, makeInput({ pressed: ['back'] }))).toEqual({ type: 'back' });
    expect(m.update(0.016, makeInput({ pressed: ['menuRight'] }))).toBeNull();
    m.select(3);
    expect(m.update(0.016, makeInput({ pressed: ['menuRight'] }))).toMatchObject({ type: 'change', delta: 1, item: { id: 'd' } });
    expect(m.update(0.016, makeInput({ pressed: ['moveLeft'] }))).toMatchObject({ type: 'change', delta: -1 });
  });
  it('activates rows on pointer taps and follows mouse hover', () => {
    const m = new MenuList(items());
    const ctx = createFakeCtx();
    m.draw(ctx, theme, 10, 20, 200);
    const rowC = 20 + theme.lineHeight * 2 + 2;
    expect(m.hitTest(15, rowC)).toBe(2);
    expect(m.hitTest(5, rowC)).toBe(-1);
    const tap = m.update(0.016, makeInput({ pointer: pointerAt(50, rowC, true), device: 'touch' }));
    expect(tap).toMatchObject({ type: 'activate', index: 2 });
    const rowB = 20 + theme.lineHeight + 2;
    expect(m.update(0.016, makeInput({ pointer: pointerAt(50, rowB, true), device: 'touch' }))).toBeNull();
    expect(m.selectedIndex).toBe(2);
    const rowD = 20 + theme.lineHeight * 3 + (theme.glyphH + 2) + 2;
    expect(m.update(0.016, makeInput({ pointer: pointerAt(50, rowD), device: 'mouse' }))).toMatchObject({ type: 'select', index: 3 });
    expect(m.update(0.016, makeInput({ pointer: pointerAt(50, rowD), device: 'mouse' }))).toBeNull();
    expect(m.update(0.016, makeInput({ pointer: pointerAt(50, 20), device: 'touch' }))).toBeNull();
    expect(m.selectedIndex).toBe(3);
  });
});

describe('MenuList drawing and scrolling', () => {
  it('draws rows sized by the theme and highlights the selection', () => {
    const m = new MenuList(items());
    const ctx = createFakeCtx();
    const h = m.draw(ctx, theme, 0, 0, 100);
    expect(h).toBe(theme.lineHeight * 4 + theme.glyphH + 2);
    const bar = ctx.fillsWith(theme.colors.selection);
    expect(bar).toHaveLength(1);
    expect(bar[0]).toMatchObject({ x: 0, y: 0, w: 100, h: theme.lineHeight });
    expect(ctx.fills.length).toBeGreaterThan(20);
    const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
    const big = createFakeCtx();
    expect(m.draw(big, large, 0, 0, 100)).toBe(large.lineHeight * 4 + large.glyphH + 4);
  });
  it('eases the selection bar under the labels, never over the rows it passes', () => {
    const m = new MenuList([{ id: 'a', label: 'ALPHA' }, { id: 'b', label: 'BRAVO' }, { id: 'c', label: 'CHARLIE' }, { id: 'd', label: 'DELTA' }]);
    const ctx = createFakeCtx();
    m.draw(ctx, theme, 0, 0, 120, { time: 0 });
    m.selectedIndex = 3;
    ctx.reset();
    m.draw(ctx, theme, 0, 0, 120, { time: 0.02 });
    const names = ctx.calls.map((c) => c.name);
    const bar = ctx.calls.findIndex((c) => c.name === 'fillRect' && ctx.fills.length > 0);
    const selFills = ctx.fillsWith(theme.colors.selection);
    expect(selFills.length).toBeGreaterThan(0);
    // mid-ease the bar sits between rows 0 and 3 ...
    const barFill = selFills[0] as { y: number };
    expect(barFill.y).toBeGreaterThan(0);
    expect(barFill.y).toBeLessThan(theme.lineHeight * 3);
    // ... and it is painted before any label glyph, so every label it passes stays readable on top of it
    const firstLabel = names.findIndex((n) => n === 'drawImage' || n === 'fillText');
    const textFill = ctx.fills.findIndex((f) => f.color === theme.colors.text || f.color === theme.colors.accent);
    const selIndex = ctx.fills.findIndex((f) => f.color === theme.colors.selection);
    expect(bar).toBeGreaterThanOrEqual(0);
    if (textFill >= 0) expect(selIndex).toBeLessThan(textFill);
    if (firstLabel >= 0) {
      const selCall = ctx.calls.findIndex((c) => c.name === 'fillRect' && c.args[1] === barFill.y);
      expect(selCall).toBeLessThan(firstLabel);
    }
    expect(firstLabel >= 0 || textFill >= 0).toBe(true);
  });

  it('scrolls to keep the selection visible when taller than maxVisible', () => {
    const many: MenuItem[] = Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, label: `ITEM ${i}` }));
    const m = new MenuList(many, { maxVisible: 4 });
    for (let i = 0; i < 5; i++) m.move(1);
    expect(m.selectedIndex).toBe(5);
    expect(m.scroll).toBe(2);
    const ctx = createFakeCtx();
    m.draw(ctx, theme, 0, 0, 100);
    expect(m.hitTest(1, 1)).toBe(2);
    expect(m.hitTest(1, theme.lineHeight * 4 + 1)).toBe(-1);
    m.move(-1);
    m.move(-1);
    m.move(-1);
    m.move(-1);
    expect(m.scroll).toBe(1);
    m.move(-1);
    m.move(-1);
    expect(m.selectedIndex).toBe(10);
    expect(m.scroll).toBe(7);
    expect(m.measure(theme)).toBe(theme.lineHeight * 4);
  });
});
