import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import {
  ADVANCED_SPECS, LEADER_GROUPS, QUALIFY_SHARE, allTimeRows, defaultStatYear, groupVolume, leaderRows, scopedLines, statYears, teamStatsRows,
} from '@/ui/franchise/league/stats-model';
import { leaderColumns, teamColumns } from '@/ui/franchise/league/stats-tab';
import { StatsTab } from '@/ui/franchise/league/stats-tab';
import { makeInput, mount, nextYearLeague, press, render, seasonLeague, tapAt, userOf } from './helpers';

describe('stats model', () => {
  it('knows which years have stats and defaults to the latest one with data', () => {
    const done = seasonLeague();
    expect(statYears(done)).toEqual([done.season.year]);
    expect(defaultStatYear(done)).toBe(done.season.year);
    const next = nextYearLeague();
    expect(next.season.year).toBe(done.season.year + 1);
    expect(statYears(next)).toEqual([done.season.year]);
    expect(defaultStatYear(next)).toBe(done.season.year);
  });

  it('reads the same season lines live and after they were archived to careers', () => {
    const done = seasonLeague();
    const next = nextYearLeague();
    const year = done.season.year;
    const live = scopedLines(done, 'season', year);
    const archived = scopedLines(next, 'season', year);
    const top = leaderRows(done, 'passing', 'season', year).sort((a, b) => b.line.passing.yards - a.line.passing.yards)[0];
    if (!top) throw new Error('no passer');
    expect(archived.get(top.id)?.line.passing.yards).toBe(live.get(top.id)?.line.passing.yards);
    expect(archived.get(top.id)?.teamId).toBe(live.get(top.id)?.teamId);
    const po = scopedLines(next, 'playoffs', year);
    expect(po.size).toBeGreaterThan(0);
    expect(po.size).toBeLessThan(archived.size);
  });

  it('keeps low-volume cameos off the leader boards', () => {
    const league = seasonLeague();
    for (const group of LEADER_GROUPS) {
      const rows = leaderRows(league, group, 'season', league.season.year);
      expect(rows.length).toBeGreaterThan(0);
      const max = Math.max(...rows.map((r) => groupVolume(r.line, group)));
      expect(rows.every((r) => groupVolume(r.line, group) >= Math.ceil(max * QUALIFY_SHARE))).toBe(true);
    }
  });

  it('sums career lines including a season not yet archived', () => {
    const done = seasonLeague();
    const next = nextYearLeague();
    const id = leaderRows(done, 'rushing', 'season', done.season.year)[0]?.id as PlayerId;
    const liveCareer = scopedLines(done, 'career', 0).get(id);
    const archivedCareer = scopedLines(next, 'career', 0).get(id);
    expect(liveCareer?.line.rushing.yards).toBe(archivedCareer?.line.rushing.yards);
  });

  it('builds team lines for the regular season and the playoffs of the current year only', () => {
    const league = seasonLeague();
    const season = teamStatsRows(league, 'season', league.season.year) ?? [];
    expect(season).toHaveLength(Object.keys(league.teams).length);
    expect(season.every((r) => r.games === league.settings.regularSeasonWeeks)).toBe(true);
    const po = teamStatsRows(league, 'playoffs', league.season.year) ?? [];
    const field = league.settings.playoff.teamsPerConference * league.settings.conferences.length;
    expect(po.length).toBeLessThanOrEqual(field);
    expect(po.find((r) => r.id === league.season.champion)?.games).toBeGreaterThanOrEqual(3);
    expect(teamStatsRows(league, 'season', league.season.year - 1)).toBeNull();
    const all = allTimeRows(nextYearLeague());
    const champ = all.find((r) => r.id === league.season.champion);
    expect(champ).toMatchObject({ seasons: 1, titles: 1, playoffs: 1 });
  });

  it('switches to advanced and compact column sets', () => {
    const adv = leaderColumns('defense', true, true).map((c) => c.key);
    expect(adv).toEqual(['name', 'team', 'pos', 'gp', ...ADVANCED_SPECS.defense.map((s) => s.key)]);
    expect(leaderColumns('passing', false, false).map((c) => c.key)).toEqual(['name', 'team', 'pyds', 'ptd', 'int', 'rtg']);
    expect(leaderColumns('receiving', true, false)).toHaveLength(5);
    expect(teamColumns(true, false).map((c) => c.key)).toEqual(['team', 'ypp', 'epa', 'sr']);
    const mtk = leaderColumns('defense', true, true).find((c) => c.key === 'mtk');
    expect(mtk?.defaultDir).toBe('asc');
  });
});

describe('StatsTab', () => {
  it('sorts leaders by the category stat and opens the player card', () => {
    const league = seasonLeague();
    const { fc, screen } = mount(league, (c) => new StatsTab(c));
    const table = screen.leaderTable;
    if (!table) throw new Error('table');
    expect(table.sortKey).toBe('pyds');
    const ys = table.rows.map((r) => r.line.passing.yards);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    press(fc, 'confirm');
    expect(fc.openedPlayers).toEqual([table.rows[0]?.id]);
    press(fc, 'menuRight');
    expect(screen.leaderTable?.sortKey).toBe('ptd');
    press(fc, 'showPlayArt');
    expect(screen.leaderTable?.sortDir).toBe('asc');
  });

  it('sets scope, year and advanced columns through the options menu (LT then a value)', () => {
    const league = nextYearLeague();
    const { fc, screen } = mount(league, (c) => new StatsTab(c, { view: 'receiving' }));
    expect(screen.year).toBe(league.season.year - 1);
    press(fc, 'callTimeout');
    const menu = fc.stack.top;
    expect(menu).toBeInstanceOf(ChoiceDialog);
    (menu as ChoiceDialog).choose('advanced');
    const values = fc.stack.top as ChoiceDialog;
    values.choose('on');
    expect(screen.advanced).toBe(true);
    expect(screen.leaderTable?.sortKey).toBe('yac');
    expect(screen.summary().text).toContain('Advanced');
    expect(screen.setOption('scope', 'career')).toBe(true);
    expect(screen.options().map((o) => o.id)).toEqual(['scope', 'advanced']);
    expect(screen.summary().text).toContain('Career');
    expect(screen.leaderTable?.rows.length).toBeGreaterThan(0);
    expect(screen.setOption('scope', 'nope')).toBe(false);
  });

  it('shows team stats, the all-time table for careers, and opens teams', () => {
    const league = seasonLeague();
    const { fc, screen } = mount(league, (c) => new StatsTab(c, { view: 'teams' }));
    expect(screen.teamTable?.rows).toHaveLength(Object.keys(league.teams).length);
    expect(screen.teamTable?.sortKey).toBe('pts');
    press(fc, 'confirm');
    expect(fc.openedTeams).toHaveLength(1);
    screen.setOption('scope', 'career');
    expect(screen.body()).not.toBeNull();
    expect(screen.allTimeTable?.rows).toHaveLength(Object.keys(league.teams).length);
    const next = mount(nextYearLeague(), (c) => new StatsTab(c, { view: 'teams' }));
    expect(next.screen.teamTable?.rows).toHaveLength(0);
    expect(next.screen.teamTable?.emptyText).toContain('current season');
  });

  it('opens the options menu with a tap on OPTIONS and switches views with a tapped chip', () => {
    const league = seasonLeague();
    const { fc, screen } = mount(league, (c) => new StatsTab(c));
    render(fc);
    const layout = screen.lastLayout;
    if (!layout?.options) throw new Error('layout');
    tapAt(fc, layout.options.x + 2, layout.options.y + 2);
    expect(fc.stack.top).toBeInstanceOf(ChoiceDialog);
    (fc.stack.top as ChoiceDialog).choose(null);
    expect(fc.stack.top).toBe(screen);
    render(fc);
    const bar = screen.chips.layout(fc.services.theme, layout.chips);
    const rushing = bar.tabs.find((t) => screen.chips.tabs[t.index]?.id === 'rushing');
    if (!rushing) throw new Error('chip');
    fc.tick(makeInput({ pointer: { x: rushing.x + 2, y: layout.chips.y + 2, down: true, justDown: true, justUp: false, drag: null }, device: 'touch' }));
    expect(screen.view).toBe('rushing');
    expect(screen.leaderTable?.rows.every((r) => r.line.rushing.attempts > 0)).toBe(true);
    expect(userOf(league)).toBeTruthy();
  });
});
