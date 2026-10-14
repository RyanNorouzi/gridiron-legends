import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { TabBar, drawTabBar, tabWindow, type TabSpec } from '@/ui/franchise/kit/tabbar';
import { clampIndex, compareValues, cycleIndex, cycleOption, groupBy, RepeatAxis, scrollToShow, sortRows } from '@/ui/franchise/kit/list';
import { ratingBarModel, drawRatingBar } from '@/ui/franchise/kit/rating-bar';
import { createTheme } from '@/ui/theme';
import { createFakeCtx, makeInput, pointerAt } from '../../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const big = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
const tabs: TabSpec[] = [
  { id: 'news', label: 'News', group: 'home', badge: '3' },
  { id: 'roster', label: 'Roster', group: 'team' },
  { id: 'depth', label: 'Depth Chart', group: 'team' },
  { id: 'staff', label: 'Staff', group: 'team', disabled: true },
  { id: 'fa', label: 'Free Agents', group: 'market' },
  { id: 'trades', label: 'Trades', group: 'market' },
  { id: 'standings', label: 'Standings', group: 'league' },
  { id: 'records', label: 'Records', group: 'league' },
];

describe('list helpers', () => {
  it('sorts stably with nullish last and numeric-aware strings', () => {
    const rows = [{ v: 3 }, { v: null }, { v: 1 }, { v: 3 }, { v: 2 }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 2, 3, 3, null]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([3, 3, 2, 1, null]);
    expect(sortRows(rows, (r) => r.v, 'desc')[0]).toBe(rows[0]);
    expect(compareValues('item 2', 'item 10')).toBeLessThan(0);
    expect(compareValues('abc', 'ABC')).toBe(0);
  });
  it('cycles, clamps, scrolls and groups', () => {
    expect(cycleIndex(0, -1, 5)).toBe(4);
    expect(cycleIndex(4, 1, 5)).toBe(0);
    expect(cycleIndex(0, 1, 0)).toBe(-1);
    expect(clampIndex(9, 3)).toBe(2);
    expect(cycleOption(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycleOption(['a', 'b'], 'z', 1)).toBe('a');
    expect(scrollToShow(0, 9, 4, 20)).toBe(6);
    expect(scrollToShow(6, 2, 4, 20)).toBe(2);
    expect(scrollToShow(18, 19, 4, 20)).toBe(16);
    expect(groupBy(tabs, (t) => t.group ?? '').map((g) => [g.key, g.items.length])).toEqual([['home', 1], ['team', 3], ['market', 2], ['league', 2]]);
  });
  it('repeats a held direction after a delay', () => {
    const axis = new RepeatAxis(['menuUp'], ['menuDown'], 'y', 0.3, 0.1);
    expect(axis.step(0.1, makeInput({ pressed: ['menuDown'] }))).toBe(1);
    expect(axis.step(0.1, makeInput({ down: ['menuDown'] }))).toBe(0);
    expect(axis.step(0.25, makeInput({ down: ['menuDown'] }))).toBe(1);
    expect(axis.step(0.05, makeInput({ down: ['menuDown'] }))).toBe(0);
    expect(axis.step(0.06, makeInput({ down: ['menuDown'] }))).toBe(1);
    expect(axis.step(0.1, makeInput())).toBe(0);
  });
});

describe('TabBar', () => {
  it('switches with menuTabLeft/Right, wraps and skips disabled tabs', () => {
    const bar = new TabBar(tabs, { initialId: 'depth' });
    expect(bar.update(0, makeInput({ pressed: ['menuTabRight'] }))).toMatchObject({ type: 'change', tab: { id: 'fa' } });
    bar.selectById('news');
    expect(bar.update(0, makeInput({ pressed: ['menuTabLeft'] }))?.tab.id).toBe('records');
    expect(bar.select(3)).toBe(false);
    expect(bar.update(0, makeInput())).toBeNull();
  });
  it('keeps the active tab by id when tabs change', () => {
    const bar = new TabBar(tabs, { initialId: 'trades' });
    bar.setTabs(tabs.filter((t) => t.id !== 'news'));
    expect(bar.current?.id).toBe('trades');
    bar.setTabs([{ id: 'x', label: 'X', disabled: true }, { id: 'y', label: 'Y' }]);
    expect(bar.current?.id).toBe('y');
  });
  it('windows overflowing tabs around the active one and handles taps', () => {
    expect(tabWindow([50, 50, 50, 50], 3, 120)).toEqual({ start: 2, end: 3 });
    expect(tabWindow([], 0, 100)).toEqual({ start: 0, end: -1 });
    const bar = new TabBar(tabs, { initialId: 'records', groupLabels: { home: 'Home', team: 'Team', market: 'Market', league: 'League' } });
    const view = bar.layout(big, { x: 0, y: 0, w: 480, h: 24 });
    expect(view.tabs.some((t) => t.active && t.index === 7)).toBe(true);
    expect(view.tabs[0]?.index).toBeGreaterThan(0);
    expect(view.moreLeft).not.toBeNull();
    expect(view.caption).toBe('League');
    for (const t of view.tabs) expect(t.x + t.w).toBeLessThanOrEqual(480);
    const small = bar.layout(theme, { x: 0, y: 0, w: 480, h: 14 });
    // The League caption labels the League tabs: the window starts at that group (earlier ones behind the arrow).
    expect(small.tabs[0]?.index).toBe(6);
    expect(small.moreLeft).not.toBeNull();
    const standings = small.tabs.find((t) => t.index === 6);
    if (!standings) throw new Error('standings visible');
    expect(bar.update(0, makeInput({ pointer: pointerAt(standings.x + 2, 4, true), device: 'touch' }))?.tab.id).toBe('standings');
    // Without a caption every group stays in view, split by dividers, and a tap switches group.
    const plain = new TabBar(tabs, { initialId: 'records' });
    const all = plain.layout(theme, { x: 0, y: 0, w: 480, h: 14 });
    expect(all.tabs.filter((t) => t.divider).length).toBeGreaterThan(0);
    const roster = all.tabs.find((t) => t.index === 1);
    if (!roster) throw new Error('roster visible');
    expect(plain.update(0, makeInput({ pointer: pointerAt(roster.x + 2, 4, true), device: 'touch' }))?.tab.id).toBe('roster');
  });
  it('draws the active tab and badges with theme colours', () => {
    const ctx = createFakeCtx();
    const bar = new TabBar(tabs);
    drawTabBar(ctx, theme, bar, { x: 0, y: 0, w: 480, h: 14 });
    expect(ctx.fillsWith(theme.colors.selection).length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.warning).length).toBeGreaterThan(0);
  });
});

describe('rating bar', () => {
  it('computes fill, tone and marker', () => {
    const m = ratingBarModel(99, 52, { marker: 50 });
    expect(m.innerW).toBe(50);
    expect(m.fillW).toBe(50);
    expect(m.tone).toBe('accent');
    expect(m.markerX).toBe(25);
    expect(ratingBarModel(0, 52).fillW).toBe(0);
    expect(ratingBarModel(Number.NaN, 52).fillW).toBe(0);
    expect(ratingBarModel(45, 52).tone).toBe('danger');
    const ctx = createFakeCtx();
    drawRatingBar(ctx, theme, 0, 0, 40, 5, 85);
    expect(ctx.fillsWith(theme.colors.success).length).toBe(1);
  });
});
