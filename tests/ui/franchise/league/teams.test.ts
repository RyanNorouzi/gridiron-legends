import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import type { League } from '@/franchise/types';
import { POSITIONS } from '@/players/types';
import { STARTER_COUNTS } from '@/teams/depth-chart';
import { createHeadlessServices, createFranchiseContext } from '@/ui/franchise/context';
import { TeamViewScreen, rosterColumns } from '@/ui/franchise/league/team-view';
import { coachRows, financeLines, historyLines, rosterRows, teamHeader, teamListRows, unitRows } from '@/ui/franchise/league/teams-model';
import { TeamsTab } from '@/ui/franchise/league/teams-tab';
import type { Action } from '@/ui/input/types';
import { createFakeCtx, makeInput, type FakeCtx } from '../../render/fake-ctx';
import { mount, nextYearLeague, press, render, userOf } from './helpers';

const otherTeam = (league: League): TeamId => {
  const id = (Object.keys(league.teams) as TeamId[]).find((t) => t !== league.userTeamId);
  if (!id) throw new Error('no other team');
  return id;
};

describe('teams model', () => {
  it('lists every team with record, ratings, coach and titles', () => {
    const league = nextYearLeague();
    const rows = teamListRows(league, userOf(league));
    expect(rows).toHaveLength(Object.keys(league.teams).length);
    expect(rows.filter((r) => r.user)).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.titles, 0)).toBe(1);
    expect(rows.every((r) => r.coach.length > 0)).toBe(true);
    expect(rows.every((r) => r.name.endsWith(r.nickname) && r.nickname.length < r.name.length)).toBe(true);
    expect(rows.every((r) => r.coachShort === 'Vacant' || /^.\. /.test(r.coachShort))).toBe(true);
    expect(teamHeader(league, userOf(league))?.subtitle).toContain('OVR');
    expect(teamHeader(league, 'nope' as TeamId)).toBeNull();
  });

  it('shows exact potential for the user roster and hides it elsewhere', () => {
    const league = nextYearLeague();
    const mine = rosterRows(league, userOf(league), userOf(league));
    expect(mine).toHaveLength(league.teams[userOf(league)]?.rosterIds.length ?? -1);
    expect(mine.every((r) => /^\d+$/.test(r.potential.text) && r.potentialSort !== null)).toBe(true);
    const theirs = rosterRows(league, otherTeam(league), userOf(league));
    expect(theirs.filter((r) => r.potential.text === '?').length).toBeGreaterThan(0);
    expect(theirs.filter((r) => r.potential.text === '?').every((r) => r.potentialSort === null)).toBe(true);
  });

  it('rates each position unit from its depth-chart starters', () => {
    const league = nextYearLeague();
    const u = userOf(league);
    const units = unitRows(league, u);
    expect(units.map((r) => r.position)).toEqual([...POSITIONS]);
    const qb = units.find((r) => r.position === 'QB');
    const starterId = league.teams[u]?.depthChart.QB[0];
    expect(qb?.average).toBe(starterId ? league.players[starterId]?.overall : 0);
    expect(units.every((r) => r.starters <= STARTER_COUNTS[r.position])).toBe(true);
    expect(units.every((r) => r.bestOverall >= r.average || r.starters > 1)).toBe(true);
  });

  it('summarises staff, finances and history', () => {
    const league = nextYearLeague();
    const u = userOf(league);
    const staff = coachRows(league, u);
    expect(staff[0]?.role).toBe('Head coach');
    const fin = financeLines(league, u);
    expect(fin.filter((l) => l.heading).map((l) => l.id)).toEqual(['h:season', 'h:cap', 'h:club', 'h:past']);
    expect(fin.find((l) => l.id === `past:${league.season.year - 1}`)).toBeDefined();
    const hist = historyLines(league, u);
    const last = hist.find((l) => l.id === `yr:${league.season.year - 1}`);
    const h = league.teams[u]?.history[0];
    expect(last?.value).toMatchObject({ text: expect.stringContaining(`${h?.wins}-${h?.losses}`) });
    const rivals = hist.filter((l) => l.id.startsWith('rival:'));
    expect(rivals).toHaveLength(3);
    expect(rivals.every((l) => l.teamId && l.teamId !== u)).toBe(true);
  });
});

describe('TeamsTab and TeamViewScreen', () => {
  it('selects the user team first and opens teams through fc.openTeam', () => {
    const league = nextYearLeague();
    const { fc, screen } = mount(league, (c) => new TeamsTab(c));
    expect(screen.table?.selected?.id).toBe(userOf(league));
    press(fc, 'confirm');
    expect(fc.openedTeams).toEqual([userOf(league)]);
    press(fc, 'audible');
    expect(screen.view).toBe(`conf:${league.settings.conferences[0]}`);
    expect(screen.table?.rows.every((r) => r.conference === league.settings.conferences[0])).toBe(true);
  });

  it('the default openTeam pushes a read-only team page that chains to rivals and players', () => {
    const league = nextYearLeague();
    const services = createHeadlessServices();
    const openedPlayers: string[] = [];
    const fc = createFranchiseContext({ services, getLeague: () => league, setLeague: () => undefined, openPlayer: (_c, id) => { openedPlayers.push(id); } });
    const step = (a: Action): void => services.stack.update(1 / 60, makeInput({ pressed: [a] }));
    const draw = (): FakeCtx => {
      const ctx = createFakeCtx();
      services.stack.render({ ctx, width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 });
      return ctx;
    };
    services.stack.push(new TeamsTab(fc));
    step('confirm');
    const page = services.stack.top as TeamViewScreen;
    expect(page).toBeInstanceOf(TeamViewScreen);
    expect(page.teamId).toBe(userOf(league));
    expect(page.rosterTable?.sortKey).toBe('pos');
    step('confirm');
    expect(openedPlayers).toHaveLength(1);
    page.showView('history');
    const rival = page.infoTable?.rows.findIndex((l) => l.id.startsWith('rival:')) ?? -1;
    page.infoTable?.select(rival);
    step('confirm');
    const second = services.stack.top as TeamViewScreen;
    expect(second).toBeInstanceOf(TeamViewScreen);
    expect(second.teamId).not.toBe(userOf(league));
    step('back');
    expect(services.stack.top).toBe(page);
    for (const v of ['schedule', 'ratings', 'staff', 'finances']) {
      page.showView(v);
      expect(page.body()).not.toBeNull();
      draw();
    }
    expect(draw().fills.length).toBeGreaterThan(0);
  });

  it('keeps large text readable with the compact roster columns', () => {
    const league = nextYearLeague();
    const { fc } = mount(league, (c) => new TeamViewScreen(c, otherTeam(league)), { settings: { textSize: 'large' } });
    const page = fc.stack.top as TeamViewScreen;
    expect(page.rosterTable?.columns.map((c) => c.key)).toEqual(rosterColumns(false).map((c) => c.key));
    render(fc);
    const layout = page.lastLayout;
    if (!layout) throw new Error('layout');
    expect(layout.hints).not.toBeNull();
    expect(Math.floor(layout.body.h / fc.services.theme.lineHeight) - 1).toBeGreaterThanOrEqual(3);
  });
});
