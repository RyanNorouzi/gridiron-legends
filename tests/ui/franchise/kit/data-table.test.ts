import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { DataTable, type Column } from '@/ui/franchise/kit/data-table';
import { charWidth, drawDataTable, fitCell, fitColumns, layoutTable, zebraTone } from '@/ui/franchise/kit/data-table-view';
import { measureText } from '@/ui/render/text';
import { createTheme } from '@/ui/theme';
import type { PointerState } from '@/ui/input/types';
import { createFakeCtx, makeInput, pointerAt } from '../../render/fake-ctx';

interface Row { id: string; name: string; ovr: number; age: number }
const theme = createTheme(DEFAULT_SETTINGS);
const big = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
const rows = (n = 20): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Player Number ${i}`, ovr: 50 + ((i * 37) % 45), age: 21 + (i % 12) }));
const columns: Column<Row>[] = [
  { key: 'name', label: 'NAME', flex: 1, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => ({ text: String(r.ovr), tone: 'success' }), sortValue: (r) => r.ovr },
  { key: 'age', label: 'AGE', width: 3, align: 'right', format: (r) => String(r.age), sortValue: (r) => r.age, defaultDir: 'asc' },
  { key: 'note', label: 'NOTE', width: 4, format: () => '-' },
];
const make = (n = 20, sort: { key: string } | null = { key: 'ovr' }): DataTable<Row> => new DataTable(columns, rows(n), { rowId: (r) => r.id, initialSort: sort });
const rect = { x: 10, y: 20, w: 300, h: 120 };
const release = (x: number, y: number): PointerState => ({ x, y, down: false, justDown: false, justUp: true, drag: null });
const holdAt = (x: number, y: number): PointerState => ({ x, y, down: true, justDown: false, justUp: false, drag: null });

describe('DataTable keyboard/gamepad navigation', () => {
  it('sorts initially and moves the selection with up/down (clamped, no wrap)', () => {
    const t = make();
    const ovrs = t.rows.map((r) => r.ovr);
    expect(ovrs).toEqual([...ovrs].sort((a, b) => b - a));
    expect(t.selectedIndex).toBe(0);
    expect(t.update(1 / 60, makeInput({ pressed: ['menuUp'] }))).toBeNull();
    const ev = t.update(1 / 60, makeInput({ pressed: ['menuDown'] }));
    expect(ev).toMatchObject({ type: 'select', index: 1 });
    t.update(1 / 60, makeInput());
    expect(t.update(1 / 60, makeInput({ pressed: ['moveDown'] }))).toMatchObject({ type: 'select', index: 2 });
  });
  it('repeats while a direction is held (digital or analog)', () => {
    const t = make();
    t.update(1 / 60, makeInput({ pressed: ['menuDown'] }));
    let moves = 0;
    for (let i = 0; i < 60; i++) if (t.update(1 / 60, makeInput({ down: ['menuDown'] }))) moves++;
    expect(moves).toBeGreaterThanOrEqual(5);
    const a = make();
    a.update(1 / 60, makeInput({ axis: { x: 0, y: 1 } }));
    expect(a.selectedIndex).toBe(1);
  });
  it('left/right move the sort column, X flips direction, selection follows the row', () => {
    const t = make();
    t.select(3);
    const id = t.selected?.id;
    const ev = t.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(ev).toEqual({ type: 'sort', key: 'age', dir: 'asc' });
    expect(t.selected?.id).toBe(id);
    const ages = t.rows.map((r) => r.age);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
    expect(t.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }))).toEqual({ type: 'sort', key: 'age', dir: 'desc' });
    expect(t.rows[0]?.age).toBe(32);
    // Unsortable 'note' is skipped; wraps to name.
    expect(t.update(1 / 60, makeInput({ pressed: ['menuRight'] }))).toEqual({ type: 'sort', key: 'name', dir: 'asc' });
    expect(t.update(1 / 60, makeInput({ pressed: ['menuLeft'] }))).toMatchObject({ key: 'age' });
    expect(t.rows.map((r) => r.name).slice(0, 3)).not.toEqual([]);
  });
  it('natural numeric order for names and an unsorted start', () => {
    const t = make(12, null);
    expect(t.sortKey).toBeNull();
    expect(t.rows[0]?.id).toBe('r0');
    expect(t.toggleSortDir()).toBe(false);
    t.sortBy('name');
    expect(t.rows.slice(0, 3).map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
    expect(t.rows[11]?.id).toBe('r11');
    expect(t.sortBy('note')).toBe(false);
  });
  it('confirm activates, back backs out, setRows keeps the selection by id', () => {
    const t = make();
    t.select(4);
    const row = t.selected;
    expect(t.update(1 / 60, makeInput({ pressed: ['confirm'] }))).toEqual({ type: 'activate', row, index: 4 });
    expect(t.update(1 / 60, makeInput({ pressed: ['back'] }))).toEqual({ type: 'back' });
    t.setRows(rows(20).filter((r) => r.id !== 'r0' && r.id !== t.rows[0]?.id));
    expect(t.selected?.id).toBe(row?.id);
    t.setRows([]);
    expect(t.selected).toBeNull();
    expect(t.update(1 / 60, makeInput({ pressed: ['confirm'] }))).toBeNull();
  });
  it('wraps when enabled and pages', () => {
    const t = new DataTable(columns, rows(10), { rowId: (r) => r.id, wrap: true, visibleRows: 4 });
    t.move(-1);
    expect(t.selectedIndex).toBe(9);
    expect(t.scroll).toBe(6);
    t.select(0);
    t.page(1);
    expect(t.selectedIndex).toBe(3);
  });
});

describe('DataTable layout and fitting', () => {
  it('fits fixed and flex columns to the width', () => {
    expect(fitColumns([{ width: 3 }, { flex: 1 }, { flex: 3 }], 200, 6, 4)).toEqual([18, 18 + 34, 18 + 104]);
    const total = fitColumns([{ width: 3 }, { flex: 1 }, { flex: 3 }], 200, 6, 4).reduce((a, b) => a + b, 0);
    expect(total + 8).toBe(200);
    const squeezed = fitColumns([{ width: 10 }, { width: 10 }], 60, 6, 4);
    expect(squeezed.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(56);
    expect(fitColumns([], 100, 6, 4)).toEqual([]);
  });
  it('ellipsises long cells and computes visible rows from the rect', () => {
    expect(fitCell('SHORT', 100, 1)).toBe('SHORT');
    const cut = fitCell('A VERY LONG PLAYER NAME INDEED', 60, 1);
    expect(cut.endsWith('...')).toBe(true);
    expect(measureText(cut, 1).width).toBeLessThanOrEqual(60);
    const t = make();
    const view = layoutTable(t, theme, { ...rect, w: 120 });
    expect(t.visibleRows).toBe(Math.floor((120 - theme.lineHeight) / theme.lineHeight));
    expect(view.rows.length).toBe(t.visibleRows);
    const nameCell = view.rows[0]?.cells[0];
    expect(nameCell?.text.endsWith('...')).toBe(true);
    expect(measureText(nameCell?.text ?? '', 1).width).toBeLessThanOrEqual(nameCell?.w ?? 0);
    expect(view.header?.find((h) => h.key === 'ovr')?.text).toContain('▼');
    expect(view.scrollUp).toBeNull();
    expect(view.scrollDown).not.toBeNull();
    expect(view.rows[0]?.cells[1]?.tone).toBe('success');
  });
  it('keeps the full label next to the sort arrow on 3-character columns (normal and large text)', () => {
    for (const th of [theme, big]) {
      const t = make();
      const view = layoutTable(t, th, rect);
      const ovr = view.header?.find((h) => h.key === 'ovr');
      expect(ovr?.text).toBe('OVR▼');
      // Drawn right-aligned at the column's right edge, the label + arrow fits the column plus the gap before it.
      const width = measureText(ovr?.text ?? '', th.textScale).width;
      const age = view.header?.find((h) => h.key === 'age');
      expect((ovr?.x ?? 0) + (ovr?.w ?? 0) - width).toBeGreaterThan((view.header?.[0]?.x ?? 0) + (view.header?.[0]?.w ?? 0));
      expect(age?.text).toBe('AGE');
      t.sortBy('age');
      expect(layoutTable(t, th, rect).header?.find((h) => h.key === 'age')?.text).toMatch(/^AGE[▲▼]$/);
    }
    // A right-aligned first column only has the table's edge pad to spill into.
    const first = new DataTable<Row>([columns[1] as Column<Row>, columns[0] as Column<Row>], rows(5), { rowId: (r) => r.id, initialSort: { key: 'ovr' } });
    const h = layoutTable(first, theme, rect).header?.[0];
    expect(measureText(h?.text ?? '', 1).width).toBeLessThanOrEqual((h?.w ?? 0) + theme.gap);
  });
  it('shows fewer, larger rows in large-text mode and keeps the selection visible', () => {
    const small = make();
    layoutTable(small, theme, rect);
    const large = make();
    layoutTable(large, big, rect);
    expect(large.visibleRows).toBeLessThan(small.visibleRows);
    expect(charWidth(2)).toBe(2 * charWidth(1));
    large.select(15);
    const v = layoutTable(large, big, rect);
    expect(v.rows.some((r) => r.selected && r.index === 15)).toBe(true);
    expect(v.scrollUp).not.toBeNull();
  });
  it('draws with theme colours and reports an empty state', () => {
    const ctx = createFakeCtx();
    const t = make();
    drawDataTable(ctx, theme, t, rect);
    expect(ctx.fillsWith(theme.colors.selection).length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.success).length).toBeGreaterThan(0);
    // Zebra rows: every odd unselected row gets a full-width band a visible step lighter than the screen.
    const view = layoutTable(t, theme, rect);
    const odd = view.rows.filter((r) => r.index % 2 === 1 && !r.selected);
    expect(odd.length).toBeGreaterThan(0);
    const bands = ctx.fillsWith(zebraTone(theme));
    for (const r of odd) expect(bands.some((f) => f.y === r.y && f.w === rect.w)).toBe(true);
    const lum = (hex: string): number => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255); };
    expect(lum(zebraTone(theme)) - lum(theme.colors.bg)).toBeGreaterThanOrEqual(30);
    const empty = new DataTable(columns, [], { rowId: (r) => r.id, emptyText: 'No players' });
    expect(drawDataTable(ctx, theme, empty, rect).empty).toBe('No players');
  });
});

describe('DataTable pointer input', () => {
  it('taps a header to sort and taps it again to flip', () => {
    const t = make();
    const view = layoutTable(t, theme, rect);
    const age = view.header?.find((h) => h.key === 'age');
    if (!age) throw new Error('no header');
    const hy = rect.y + 2;
    expect(t.update(1 / 60, makeInput({ pointer: pointerAt(age.x + 2, hy, true), device: 'touch' }))).toEqual({ type: 'sort', key: 'age', dir: 'asc' });
    expect(t.update(1 / 60, makeInput({ pointer: pointerAt(age.x + 2, hy, true), device: 'touch' }))).toEqual({ type: 'sort', key: 'age', dir: 'desc' });
    const note = view.header?.find((h) => h.key === 'note');
    expect(t.update(1 / 60, makeInput({ pointer: pointerAt((note?.x ?? 0) + 2, hy, true), device: 'touch' }))).toBeNull();
  });
  it('activates a row on tap release and scrolls on drag without activating', () => {
    const t = make();
    const view = layoutTable(t, theme, rect);
    const r2 = view.rows[2];
    if (!r2) throw new Error('row');
    const x = rect.x + 20;
    expect(t.update(1 / 60, makeInput({ pointer: pointerAt(x, r2.y + 2, true), device: 'touch' }))).toBeNull();
    const ev = t.update(1 / 60, makeInput({ pointer: release(x, r2.y + 2), device: 'touch' }));
    expect(ev).toMatchObject({ type: 'activate', index: 2 });
    const last = view.rows[view.rows.length - 1];
    if (!last) throw new Error('row');
    // Dragging the content up by three rows scrolls three rows further down the list (no activation).
    t.update(1 / 60, makeInput({ pointer: pointerAt(x, last.y + 2, true), device: 'touch' }));
    t.update(1 / 60, makeInput({ pointer: holdAt(x, last.y + 2 - theme.lineHeight * 3), device: 'touch' }));
    expect(t.scroll).toBe(3);
    const end = t.update(1 / 60, makeInput({ pointer: release(x, last.y + 2 - theme.lineHeight * 3), device: 'touch' }));
    expect(end).toBeNull();
    // Dragging down past the top clamps at 0.
    t.update(1 / 60, makeInput({ pointer: pointerAt(x, r2.y + 2, true), device: 'touch' }));
    t.update(1 / 60, makeInput({ pointer: holdAt(x, r2.y + 2 + theme.lineHeight * 5), device: 'touch' }));
    expect(t.scroll).toBe(0);
    t.update(1 / 60, makeInput({ pointer: null, device: 'touch' }));
    expect(t.selectedIndex).toBeLessThan(t.visibleRows);
  });
  it('mouse hover selects and the scroll marker pages', () => {
    const t = make();
    const view = layoutTable(t, theme, rect);
    const r3 = view.rows[3];
    expect(t.update(1 / 60, makeInput({ pointer: pointerAt(rect.x + 30, (r3?.y ?? 0) + 1), device: 'mouse' }))).toMatchObject({ type: 'select', index: 3 });
    const down = view.scrollDown;
    if (!down) throw new Error('marker');
    t.update(1 / 60, makeInput({ pointer: pointerAt(down.x + 1, down.y + 1, true), device: 'mouse' }));
    expect(t.selectedIndex).toBe(3 + t.visibleRows - 1);
    expect(t.scroll).toBeGreaterThan(0);
  });
});
