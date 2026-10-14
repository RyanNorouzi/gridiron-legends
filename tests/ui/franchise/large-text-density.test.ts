/**
 * Large-text density of the hub's crowded tables (Roster, Staff, Trades, Free Agency) inside the real hub: at
 * least three rows stay visible and no person name is cut with "..." (initials instead); the Free Agency
 * "CARES ABOUT" column and the staff traits fit (shortened) at normal text size.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TableView } from '@/ui/franchise/kit/data-table-view';

const views: TableView[] = [];
vi.mock('@/ui/franchise/kit/data-table-view', async (orig) => {
  const m = await orig<typeof import('@/ui/franchise/kit/data-table-view')>();
  return {
    ...m,
    drawDataTable: (...a: Parameters<typeof m.drawDataTable>) => {
      const v = m.drawDataTable(...a);
      views.push(v);
      return v;
    },
  };
});

import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League } from '@/franchise/types';
import { createHeadlessServices } from '@/ui/franchise/context';
import { FranchiseHubScreen, defaultHubTabs } from '@/ui/franchise/hub';
import { fitTail } from '@/ui/franchise/kit/dialogs';
import { TeamPickScreen } from '@/ui/franchise/shell/team-picker';
import { measureText } from '@/ui/render/text';
import { freeAgencyLeague, regularSeasonLeague } from './market/fixtures';
import { createFakeCtx } from '../render/fake-ctx';

/** Every table drawn for a hub tab, scrolled through all its rows. */
const tablesOf = (league: League, tab: string, large: boolean): TableView[] => {
  const services = createHeadlessServices({ textSize: large ? 'large' : 'normal' });
  const hub = new FranchiseHubScreen({ league, onExit: () => undefined, simulator: fallbackSimulator, tabs: defaultHubTabs() });
  services.stack.push(hub);
  expect(hub.selectTab(tab)).toBe(true);
  const rc = { ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 };
  views.length = 0;
  services.stack.render(rc);
  const first = [...views];
  // Page through the rows so every name is laid out once.
  for (let i = 0; i < 30; i++) {
    services.stack.update(1 / 60, { axis: { x: 0, y: 0 }, down: new Set(), justPressed: new Set(['menuDown']), justReleased: new Set(), pointer: null, lastDevice: 'keyboard' });
    services.stack.render(rc);
  }
  return [...first, ...views];
};

const cutCells = (vs: TableView[], keys: string[]): string[] =>
  vs.flatMap((v) => v.rows.flatMap((r) => r.cells.filter((c) => keys.includes(c.key) && c.text.endsWith('...')).map((c) => `${c.key}:${c.text}`)));

describe('large-text density in the hub', () => {
  const cases: [string, () => League][] = [
    ['team-roster', regularSeasonLeague], ['team-staff', regularSeasonLeague], ['market-trades', regularSeasonLeague], ['market-free-agency', freeAgencyLeague],
  ];
  for (const [tab, league] of cases) {
    it(`${tab}: 3+ rows and whole names in large text`, () => {
      const vs = tablesOf(league(), tab, true);
      expect(vs.length).toBeGreaterThan(0);
      expect(vs[0]?.rows.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(cutCells(vs, ['name', 'role'])).toEqual([]);
    }, 60000);
  }

  it('normal text: staff traits and FA "cares about" fit without "..."', () => {
    expect(cutCells(tablesOf(regularSeasonLeague(), 'team-staff', false), ['name', 'traits'])).toEqual([]);
    const fa = tablesOf(freeAgencyLeague(), 'market-free-agency', false);
    expect(fa[0]?.header?.map((h) => h.key)).toContain('cares');
    expect(cutCells(fa, ['name', 'cares', 'offer'])).toEqual([]);
  }, 60000);

  it('team picker: large text shows team abbreviations instead of cut names and keeps the rating headers (market column dropped first)', () => {
    const services = createHeadlessServices({ textSize: 'large' });
    const league = regularSeasonLeague();
    const picker = new TeamPickScreen({ title: 'PICK', teams: Object.values(league.teams), onPick: () => undefined });
    services.stack.push(picker);
    const rc = { ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 };
    views.length = 0;
    services.stack.render(rc);
    const abbrs = new Set(Object.values(league.teams).map((t) => t.abbr));
    const cells = views.flatMap((v) => v.rows.flatMap((r) => r.cells.filter((c) => c.key === 'team').map((c) => c.text)));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((t) => t.endsWith('...'))).toEqual([]);
    expect(cells.every((t) => abbrs.has(t) || Object.values(league.teams).some((x) => `${x.city} ${x.name}` === t))).toBe(true);
    expect(views[0]?.header?.map((h) => h.key)).not.toContain('mkt');
    // The rating columns keep their full width (and so their header labels).
    expect(views[0]?.header?.filter((h) => h.key === 'off' || h.key === 'def').map((h) => h.text)).toEqual(['OFF', 'DEF']);
  }, 60000);

  it('text entry keeps the end of a long name in view, clear of the length counter', () => {
    const text = 'SALT LAKE CITY SNOWCAPS_';
    const room = measureText('SALT LAKE CITY', 2).width;
    const fitted = fitTail(text, room, 2);
    expect(fitted.startsWith('...')).toBe(true);
    expect(fitted.endsWith('CAPS_')).toBe(true);
    expect(measureText(fitted, 2).width).toBeLessThanOrEqual(room);
    expect(fitTail('SHORT', room, 2)).toBe('SHORT');
  });
});
