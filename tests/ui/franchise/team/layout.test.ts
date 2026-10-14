import { describe, expect, it } from 'vitest';
import { createTheme } from '@/ui/theme';
import { defaultSettings } from '@/save/settings-store';
import { ChipBar, MIN_TABLE_ROWS, ViewTable, isWide, tabLayout } from '@/ui/franchise/team/layout';
import { infoColumns, moneyPrecise, meterTone, plural, refused, done, teamOrThrow, ATTR_ABBR } from '@/ui/franchise/team/common';
import { ATTRIBUTE_KEYS } from '@/players/types';
import { createFakeCtx, makeInput, pointerAt } from '../../render/fake-ctx';
import { baseLeague, userId } from './helpers';

const normal = createTheme({ ...defaultSettings(), textSize: 'normal' });
const large = createTheme({ ...defaultSettings(), textSize: 'large' });
const rect = { x: 0, y: 40, w: 480, h: 206 };

describe('tabLayout', () => {
  it('stacks chips, summary, table, detail and hints inside the content rect', () => {
    const l = tabLayout(normal, rect, { menuW: 60, hintH: 11 });
    expect(l.chips.y).toBe(40);
    expect(l.menu?.x).toBe(420);
    expect(l.chips.w).toBe(480 - 60 - normal.gap);
    expect(l.summary).not.toBeNull();
    expect(l.detail).not.toBeNull();
    expect(l.hints).not.toBeNull();
    expect(l.table.y).toBeGreaterThan(l.chips.y);
    const bottom = (l.hints?.y ?? 0) + (l.hints?.h ?? 0);
    expect(bottom).toBeLessThanOrEqual(rect.y + rect.h);
    expect(Math.floor(l.table.h / normal.lineHeight) - 1).toBeGreaterThanOrEqual(MIN_TABLE_ROWS);
  });
  it('drops optional lines in large text to keep the table usable and splits a side panel', () => {
    const l = tabLayout(large, { x: 0, y: 60, w: 480, h: 170 }, { menuW: 80, hintH: 22, side: 0.4 });
    expect(l.hints).toBeNull();
    expect(Math.floor(l.table.h / large.lineHeight) - 1).toBeGreaterThanOrEqual(MIN_TABLE_ROWS - 1);
    expect(l.side?.w).toBe(192);
    expect(l.table.w).toBe(480 - 192 - large.gap);
    expect(tabLayout(normal, rect, { menuW: 0 }).menu).toBeNull();
  });
  it('switches to the compact column set when a table is narrow', () => {
    expect(isWide(normal, 470)).toBe(true);
    expect(isWide(large, 470)).toBe(false);
  });
});

describe('ChipBar', () => {
  it('cycles with Y, selects taps and ignores U/O (kept by the hub)', () => {
    const chips = new ChipBar([{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }]);
    expect(chips.current).toBe('a');
    expect(chips.update(makeInput({ pressed: ['menuTabRight'] }))).toBeNull();
    expect(chips.update(makeInput({ pressed: ['audible'] }))).toBe('b');
    const view = chips.draw(createFakeCtx(), normal, { x: 0, y: 0, w: 300, h: 14 });
    const gamma = view.tabs.find((t) => t.index === 2);
    if (!gamma) throw new Error('layout');
    expect(chips.update(makeInput({ pointer: pointerAt(gamma.x + 2, 5, true) }))).toBe('c');
    expect(chips.update(makeInput({ pointer: pointerAt(gamma.x + 2, 5, true) }))).toBeNull();
    expect(chips.update(makeInput({ pointer: pointerAt(gamma.x + 2, 100, true) }))).toBeNull();
    expect(chips.cycle(1)).toBe(true);
    expect(chips.current).toBe('a');
    expect(chips.lastView).not.toBeNull();
  });
  it('uses the overflow markers when the chips do not fit', () => {
    const chips = new ChipBar(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `Chip number ${i}` })));
    const view = chips.draw(createFakeCtx(), normal, { x: 0, y: 0, w: 160, h: 14 });
    expect(view.moreRight).not.toBeNull();
    const r = view.moreRight as { x: number; y: number };
    expect(chips.update(makeInput({ pointer: pointerAt(r.x + 1, r.y + 1, true) }))).toBe('c1');
  });
});

describe('ViewTable', () => {
  interface Row { id: string; v: number }
  const rows: Row[] = [{ id: 'a', v: 3 }, { id: 'b', v: 9 }, { id: 'c', v: 1 }];
  it('keeps sort and selection across column-set switches and activates rows', () => {
    const activated: string[] = [];
    const view = new ViewTable<Row>({
      id: 'x', label: 'X', rows: () => rows, rowId: (r) => r.id,
      columns: (wide) => [
        { key: 'id', label: 'ID', width: 3, format: (r) => r.id, sortValue: (r) => r.id, defaultDir: 'asc' },
        ...(wide ? [{ key: 'v', label: 'V', width: 3, format: (r: Row) => String(r.v), sortValue: (r: Row) => r.v }] : []),
      ],
      initialSort: { key: 'v' },
      detail: (r) => `row ${r.id}`,
      activate: (r) => activated.push(r.id),
    });
    expect(view.table.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    view.table.select(1);
    view.setWide(false);
    expect(view.isWide).toBe(false);
    expect(view.table.columns).toHaveLength(1);
    expect(view.table.selected?.id).toBe('a');
    expect(view.detail()).toBe('row a');
    view.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(activated).toEqual(['a']);
    view.setWide(true);
    view.table.sortBy('id');
    view.setWide(false);
    expect(view.table.sortKey).toBe('id');
    view.rebuild();
    expect(view.table.selectedIndex).toBe(0);
  });
});

describe('common helpers', () => {
  it('formats and wraps results', () => {
    const league = baseLeague();
    expect(moneyPrecise(12_345_000)).toBe('$12.35M');
    expect(moneyPrecise(950_000)).toBe('$950K');
    expect(moneyPrecise(-500)).toBe('-$500');
    expect(meterTone(80)).toBe('success');
    expect(meterTone(20)).toBe('danger');
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(2, 'coach', 'coaches')).toBe('2 coaches');
    expect(refused(league, 'no').ok).toBe(false);
    expect(done(league, 'yes').message).toBe('yes');
    expect(teamOrThrow(league, userId(league)).id).toBe(userId(league));
    expect(() => teamOrThrow(league, 't_missing' as never)).toThrow();
    expect(infoColumns()).toHaveLength(2);
    for (const k of ATTRIBUTE_KEYS) expect(ATTR_ABBR[k]).toHaveLength(3);
  });
});
