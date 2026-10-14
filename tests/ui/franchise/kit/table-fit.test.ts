import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/save/settings-store';
import { DataTable, type Column } from '@/ui/franchise/kit/data-table';
import { layoutTable, shownColumns } from '@/ui/franchise/kit/data-table-view';
import { compactName, initialName } from '@/ui/franchise/kit/format';
import { MIN_BODY_LINES, marketLayout } from '@/ui/franchise/market/common';
import { shortTraits } from '@/ui/franchise/team/staff-tab';
import { createTheme } from '@/ui/theme';
import { makeInput } from '../../render/fake-ctx';

interface Row { id: string; name: string; a: number; b: number; c: number }
const rows: Row[] = [
  { id: '1', name: 'Marquis Whitfield', a: 1, b: 2, c: 3 },
  { id: '2', name: 'Al Bo', a: 4, b: 5, c: 6 },
];
const cols: Column<Row>[] = [
  { key: 'name', label: 'NAME', flex: 1, minWidth: 12, format: (r) => r.name, shorten: initialName, sortValue: (r) => r.name },
  { key: 'a', label: 'A', width: 6, format: (r) => String(r.a), sortValue: (r) => r.a, priority: 1 },
  { key: 'b', label: 'B', width: 6, format: (r) => String(r.b), sortValue: (r) => r.b, priority: 2 },
  { key: 'c', label: 'C', width: 6, format: (r) => String(r.c), sortValue: (r) => r.c },
];
const theme = (large: boolean) => createTheme({ ...defaultSettings(), textSize: large ? 'large' : 'normal' });

describe('fitted table layouts', () => {
  it('hides optional columns highest priority first, never required ones', () => {
    expect(shownColumns(cols, 1000, 6, 4).map((c) => c.key)).toEqual(['name', 'a', 'b', 'c']);
    // 12 + 6 + 6 + 6 chars at 6 px + 3 gaps of 4 = 192: 160 px drops b (priority 2), 110 also a.
    expect(shownColumns(cols, 160, 6, 4).map((c) => c.key)).toEqual(['name', 'a', 'c']);
    expect(shownColumns(cols, 110, 6, 4).map((c) => c.key)).toEqual(['name', 'c']);
    expect(shownColumns(cols, 10, 6, 4).map((c) => c.key)).toEqual(['name', 'c']);
  });

  it('shortens names to initials before cutting, and hidden columns leave the sort cycle', () => {
    const t = theme(true);
    const table = new DataTable(cols, rows, { rowId: (r) => r.id, initialSort: { key: 'name', dir: 'asc' } });
    const view = layoutTable(table, t, { x: 0, y: 0, w: 300, h: 200 });
    expect(view.header?.map((h) => h.key)).toEqual(['name', 'c']);
    const names = view.rows.map((r) => r.cells[0]?.text);
    expect(names).toContain('Al Bo');
    expect(names.some((n) => n?.startsWith('M. Whitfield'))).toBe(true);
    expect(table.shownColumns.map((c) => c.key)).toEqual(['name', 'c']);
    table.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(table.sortKey).toBe('c');
    table.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(table.sortKey).toBe('name');
    const wide = layoutTable(table, theme(false), { x: 0, y: 0, w: 470, h: 200 });
    expect(wide.header?.map((h) => h.key)).toEqual(['name', 'a', 'b', 'c']);
    expect(wide.rows.map((r) => r.cells[0]?.text)).toContain('Marquis Whitfield');
  });

  it('formats short names and trait lists', () => {
    expect(initialName('Marquis Whitfield (TB)')).toBe('M. Whitfield (TB)');
    expect(initialName('Vacant')).toBe('Vacant');
    expect(compactName('Al Bo')).toBe('Al Bo');
    expect(shortTraits('Aggressive, Players Coach, Innovator')).toBe('Aggressive +2');
    expect(shortTraits('Motivator')).toBe('Motivator');
  });

  it('market frames give up status lines before the table drops below MIN_BODY_LINES', () => {
    const t = theme(true);
    const tall = marketLayout(t, { x: 0, y: 40, w: 480, h: 206 }, false, 2);
    expect(tall.status.h).toBe(t.lineHeight * 2);
    const short = marketLayout(t, { x: 16, y: 96, w: 448, h: 128 }, false, 2);
    expect(Math.floor(short.body.h / t.lineHeight)).toBeGreaterThanOrEqual(MIN_BODY_LINES);
    expect(short.status.h).toBeLessThan(t.lineHeight * 2);
  });
});

describe('hub header in large text', () => {
  it('drops the city, then the fans and cash stats, before cutting anything', async () => {
    const { headerStats, headerTeamName } = await import('@/ui/franchise/shell/hub-header');
    const view = { teamName: 'ATLANTA EMBERS', nickname: 'EMBERS', abbr: 'ATL', date: '2026 WEEK 1', cash: { text: '$60.0M' }, capSpace: { text: '$6.9M' }, fans: { text: '75' } };
    expect(headerTeamName(view, 400, 1)).toBe('ATLANTA EMBERS');
    expect(headerTeamName(view, 12 * 10, 2)).toBe('EMBERS');
    expect(headerTeamName(view, 12 * 4, 2)).toBe('ATL');
    expect(headerStats(view, 400, 1).map((s) => s.label)).toEqual(['CASH', 'CAP', 'FANS']);
    expect(headerStats(view, 400, 2).map((s) => s.label)).toEqual(['CAP']);
  });
});
