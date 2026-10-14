/**
 * The shared FrameScreen chrome (pure layout, pager geometry, input rules for hosted vs pushed screens, the
 * mouse-click sanitiser) and the league tabs registered in tabs-league.ts, hosted by the real franchise hub.
 */
import { describe, expect, it } from 'vitest';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createHeadlessServices, TEST_CONTENT_RECT } from '@/ui/franchise/context';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import { carryTable, pctText, resultText, sanitizeInput } from '@/ui/franchise/league/common';
import { MIN_BODY_ROWS, frameLayout, pagerLayout } from '@/ui/franchise/league/frame';
import { RecordsTab } from '@/ui/franchise/league/records-tab';
import { ScheduleTab } from '@/ui/franchise/league/schedule-tab';
import { StatsTab } from '@/ui/franchise/league/stats-tab';
import { TeamViewScreen } from '@/ui/franchise/league/team-view';
import { BoxScoreScreen } from '@/ui/franchise/league/boxscore-screen';
import { CareerScreen } from '@/ui/franchise/league/career-screen';
import { SeasonDetailScreen } from '@/ui/franchise/league/season-screen';
import type { FrameScreen } from '@/ui/franchise/league/frame';
import type { PlayerId } from '@/core/ids';
import { leagueTabs } from '@/ui/franchise/tabs-league';
import { createTheme } from '@/ui/theme';
import { defaultSettings } from '@/save/settings-store';
import type { Action } from '@/ui/input/types';
import { DataTable } from '@/ui/franchise/kit/data-table';
import { createFakeCtx } from '../../render/fake-ctx';
import { centre, makeInput, midSeasonLeague, mount, nextYearLeague, press, render, seasonLeague, tap, tapAt, userOf } from './helpers';

const theme = (large = false) => createTheme({ ...defaultSettings(), textSize: large ? 'large' : 'normal' });

describe('frame layout', () => {
  it('stacks chips, status, body, detail and hints inside the rect', () => {
    const t = theme();
    const l = frameLayout(t, TEST_CONTENT_RECT, { pushed: false, options: true });
    expect(l.title).toBeNull();
    expect(l.options?.x).toBe(TEST_CONTENT_RECT.x + TEST_CONTENT_RECT.w - (l.options?.w ?? 0));
    expect(l.status?.y).toBeGreaterThan(l.chips.y);
    expect(l.body.y).toBe((l.status?.y ?? 0) + t.lineHeight);
    expect(l.detail && l.hints).toBeTruthy();
    expect((l.hints?.y ?? 0) + (l.hints?.h ?? 0)).toBe(TEST_CONTENT_RECT.y + TEST_CONTENT_RECT.h);
    expect(frameLayout(t, TEST_CONTENT_RECT, { pushed: false, options: false }).options).toBeNull();
  });

  it('drops hints, the detail line and a pager-less status line in large text to keep the table usable', () => {
    const t = theme(true);
    const rect = { x: 16, y: 92, w: 448, h: 132 };
    const l = frameLayout(t, rect, { pushed: false, options: true });
    expect(l.hints).toBeNull();
    expect(l.detail).toBeNull();
    expect(l.status).toBeNull();
    expect(Math.floor(l.body.h / t.lineHeight) - 1).toBe(MIN_BODY_ROWS);
    expect(l.body.y + l.body.h).toBeLessThanOrEqual(rect.y + rect.h);
    const paged = frameLayout(t, rect, { pushed: false, options: true, keepStatus: true });
    expect(paged.status).not.toBeNull();
    expect(paged.body.y).toBe((paged.status?.y ?? 0) + t.lineHeight);
    const pushed = frameLayout(t, { x: 16, y: 0, w: 448, h: 262 }, { pushed: true, titleLines: 2, options: false });
    expect(pushed.title?.h).toBe(t.lineHeight * 2 + t.gap);
    expect(pushed.hints).not.toBeNull();
    expect(Math.floor(pushed.body.h / t.lineHeight) - 1).toBeGreaterThanOrEqual(MIN_BODY_ROWS);
  });

  it('places the pager arrows around a fitted label', () => {
    const t = theme();
    const status = { x: 0, y: 50, w: 300, h: t.lineHeight };
    const p = pagerLayout(t, status, 'Conference Championship');
    expect(p.prev.x).toBe(0);
    expect(p.next.x).toBeGreaterThan(p.labelX);
    expect(p.rest.x).toBeGreaterThan(p.next.x);
    const tiny = pagerLayout(t, { ...status, w: 60 }, 'A very long label that cannot fit');
    expect(tiny.label.endsWith('...') || tiny.label === '').toBe(true);
  });
});

describe('frame input', () => {
  it('drops the Confirm edge of a mouse click but keeps keyboard Confirm', () => {
    const click = makeInput({ pressed: ['confirm'], pointer: tap(5, 5, 'down'), device: 'mouse' });
    expect(sanitizeInput(click).justPressed.has('confirm')).toBe(false);
    const key = makeInput({ pressed: ['confirm'] });
    expect(sanitizeInput(key)).toBe(key);
    const touch = makeInput({ pressed: ['confirm'], pointer: tap(5, 5, 'down'), device: 'touch' });
    expect(sanitizeInput(touch).justPressed.has('confirm')).toBe(true);
  });

  it('leaves U/O and Back to the hub when hosted but uses them when pushed', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new ScheduleTab(c));
    press(fc, 'menuTabRight');
    expect(screen.view).toBe('mine');
    press(fc, 'back');
    expect(fc.pops()).toBe(0);
    const page = mount(league, (c) => new TeamViewScreen(c, userOf(league)));
    press(page.fc, 'menuTabRight');
    expect(page.screen.view).toBe('schedule');
    press(page.fc, 'back');
    expect(page.fc.pops()).toBe(1);
  });

  it('closes a pushed screen with a touch or mouse tap on CLOSE; hosted tabs have no CLOSE button', () => {
    const league = midSeasonLeague();
    for (const device of ['touch', 'mouse'] as const) {
      const page = mount(league, (c) => new TeamViewScreen(c, userOf(league)));
      render(page.fc);
      const close = page.screen.lastLayout?.close;
      if (!close) throw new Error('no CLOSE button');
      expect(close.x + close.w).toBeLessThanOrEqual(480);
      expect(close.y + close.h).toBeLessThanOrEqual(page.screen.lastLayout?.chips.y ?? 0);
      tapAt(page.fc, centre(close).x, centre(close).y, device);
      expect(page.fc.pops(), device).toBe(1);
    }
    const hosted = mount(league, (c) => new ScheduleTab(c));
    render(hosted.fc);
    expect(hosted.screen.lastLayout?.close).toBeNull();
  });

  it('keeps the CLOSE button and the title inside the canvas in large text', () => {
    const league = midSeasonLeague();
    const page = mount(league, (c) => new TeamViewScreen(c, userOf(league)), { settings: { textSize: 'large' } });
    const ctx = render(page.fc);
    const l = page.screen.lastLayout;
    if (!l?.close || !l.title) throw new Error('layout');
    expect(l.title.x + l.title.w).toBeLessThanOrEqual(l.close.x);
    expect(ctx.fills.filter((f) => f.x < 0 || f.x + f.w > 480 || f.y < 0 || f.y + f.h > 270)).toHaveLength(0);
  });

  it('lists hints for the current device and view', () => {
    const league = seasonLeague();
    const { screen } = mount(league, (c) => new StatsTab(c));
    expect(screen.hints().map((h) => h.label)).toEqual(['View', 'Options', 'Sort', 'Open']);
    const sched = mount(league, (c) => new ScheduleTab(c, { view: 'scores' }));
    expect(sched.screen.hints().map((h) => h.label)).toEqual(['View', 'Week', 'Open']);
  });

  it('offers Open only when the selected row acts and starts grouped tables on their first real row', () => {
    const league = nextYearLeague();
    const page = mount(league, (c) => new TeamViewScreen(c, userOf(league), { view: 'staff' }));
    expect(page.screen.hints().map((h) => h.label)).not.toContain('Open');
    page.screen.showView('history');
    expect(page.screen.infoTable?.selected?.heading).toBeFalsy();
    expect(page.screen.hints().map((h) => h.label)).not.toContain('Open');
    const rival = page.screen.infoTable?.rows.findIndex((l) => l.id.startsWith('rival:')) ?? -1;
    page.screen.infoTable?.select(rival);
    expect(page.screen.hints().map((h) => h.label)).toContain('Open');
    const records = mount(league, (c) => new RecordsTab(c, { view: 'franchise' }));
    expect(records.screen.recordTable?.selected?.kind).toBe('record');
  });

  it('carries sort and selection into a rebuilt table', () => {
    const cols = [{ key: 'n', label: 'N', width: 3, format: (r: { id: string; n: number }) => String(r.n), sortValue: (r: { id: string; n: number }) => r.n }];
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 3 }, { id: 'c', n: 2 }];
    const first = new DataTable(cols, rows, { rowId: (r) => r.id, initialSort: { key: 'n', dir: 'asc' } });
    first.selectById('c');
    const next = carryTable(first, cols, [...rows, { id: 'd', n: 0 }], { rowId: (r) => r.id });
    expect(next.sortDir).toBe('asc');
    expect(next.rows[0]?.id).toBe('d');
    expect(next.selected?.id).toBe('c');
    expect(pctText(3, 1)).toBe('.750');
    expect(pctText(0, 0)).toBe('.000');
    expect(pctText(2, 0)).toBe('1.000');
    const g = midSeasonLeague().season.schedule.find((x) => x.result && x.home === userOf(midSeasonLeague()));
    if (g) expect(resultText(g, g.away).text[0]).toMatch(/[WLT]/);
  });
});

describe('league tabs in the hub', () => {
  it('registers six league tabs with unique ids', () => {
    expect(leagueTabs.map((t) => t.id)).toEqual(['league-schedule', 'league-standings', 'league-stats', 'league-teams', 'league-history', 'league-hof']);
    expect(leagueTabs.every((t) => t.group === 'league')).toBe(true);
  });

  it('hosts every league tab: renders, handles input and opens team pages through the wrapper', () => {
    const services = createHeadlessServices();
    const hub = new FranchiseHubScreen({ league: midSeasonLeague(), mode: 'season', simulator: fallbackSimulator, onExit: () => undefined, tabs: leagueTabs });
    services.stack.push(hub);
    const step = (...a: Action[]): void => services.stack.update(1 / 60, makeInput({ pressed: a }));
    const rc = { ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 };
    for (const tab of leagueTabs) {
      expect(hub.selectTab(tab.id)).toBe(true);
      hub.render(rc);
      step('menuDown');
      step('audible');
      hub.render(rc);
      expect(services.stack.top).toBe(hub);
    }
    expect(hub.selectTab('league-teams')).toBe(true);
    hub.render(rc);
    step('confirm');
    expect(services.stack.top).toBeInstanceOf(TeamViewScreen);
    step('back');
    expect(services.stack.top).toBe(hub);
    expect(hub.selectTab('league-stats')).toBe(true);
    step('callTimeout');
    expect(services.stack.top).toBeInstanceOf(ChoiceDialog);
    step('back');
    step('pause');
    expect((services.stack.top as ChoiceDialog).title).toBe('Advance');
  });

  it('never mutates the League: every view and option of every tab and drill-down runs over a deep-frozen League', () => {
    const freeze = <T>(o: T, seen = new Set<unknown>()): T => {
      if (o && typeof o === 'object' && !seen.has(o)) {
        seen.add(o);
        for (const v of Object.values(o as object)) freeze(v, seen);
        Object.freeze(o);
      }
      return o;
    };
    const league = freeze(structuredClone(seasonLeague()));
    const every = (screen: FrameScreen, fc: Parameters<typeof render>[0]): void => {
      for (const v of screen.chips.tabs.map((t) => t.id)) {
        expect(screen.showView(v) || screen.view === v).toBe(true);
        render(fc);
        for (const o of screen.options()) for (const c of o.choices) screen.setOption(o.id, c.id);
        screen.page(1);
        screen.page(-1);
        render(fc);
      }
    };
    for (const tab of leagueTabs) {
      const { fc, screen } = mount(league, (c) => tab.create(c) as FrameScreen);
      every(screen, fc);
    }
    const game = league.season.schedule.find((g) => g.result);
    if (!game) throw new Error('no played game');
    const drill: ((c: Parameters<Parameters<typeof mount>[1]>[0]) => FrameScreen)[] = [
      (c) => new BoxScoreScreen(c, game.id), (c) => new TeamViewScreen(c, userOf(league)), (c) => new SeasonDetailScreen(c, league.season.year),
      (c) => new CareerScreen(c, (Object.keys(league.season.stats)[0] ?? Object.keys(league.careerStats)[0]) as PlayerId),
    ];
    for (const make of drill) {
      const { fc, screen } = mount(league, make);
      every(screen, fc);
    }
  });

  it('renders every tab in large text without drawing outside the content area', () => {
    const league = seasonLeague();
    for (const tab of leagueTabs) {
      const { fc } = mount(league, (c) => tab.create(c), { settings: { textSize: 'large' }, contentRect: { x: 16, y: 92, w: 448, h: 132 } });
      const ctx = render(fc);
      const outside = ctx.fills.filter((f) => f.y < 92 || f.y + f.h > 92 + 132 + 1);
      expect(outside, tab.id).toHaveLength(0);
    }
  });
});
