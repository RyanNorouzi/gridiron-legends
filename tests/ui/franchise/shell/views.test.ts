import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { SEASON_PHASE_ORDER } from '@/franchise/types';
import { createTestFranchiseContext, type TestFranchiseContext } from '@/ui/franchise/context';
import { GameDayScreen } from '@/ui/franchise/game-day';
import { HomeTabScreen } from '@/ui/franchise/home-tab';
import { NewFranchiseScreen } from '@/ui/franchise/new-franchise';
import { BracketView } from '@/ui/franchise/shell/bracket-view';
import { EventDetailScreen } from '@/ui/franchise/shell/event-detail';
import { blockerSummary, hubHeader, rosterTabId, weekLabel } from '@/ui/franchise/shell/hub-model';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { buildRecap } from '@/ui/franchise/shell/recap-model';
import { WeekRecapScreen } from '@/ui/franchise/shell/recap-screen';
import { SeasonSummaryScreen } from '@/ui/franchise/shell/season-summary';
import { SimJob } from '@/ui/franchise/shell/sim-job';
import { TeamPickScreen } from '@/ui/franchise/shell/team-picker';
import { refitMenu } from '@/ui/franchise/shell/widgets';
import type { Screen } from '@/ui/screens/screen';
import { MenuList } from '@/ui/widgets/menu';
import { makeInput, pointerAt } from '../../render/fake-ctx';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { FranchiseMenuScreen, LoadFranchiseScreen } from '@/ui/franchise/load-franchise';
import { playoffField, PlayoffsModeScreen, withUserTeam } from '@/ui/franchise/playoffs-mode';
import { CustomTeamScreen } from '@/ui/franchise/shell/custom-team-screen';
import { CustomGameScreen } from '@/ui/screens/custom-game';
import { quickGameLeague } from '@/ui/screens/quick-game-setup';
import { leagueAt, memorySaves, rcFor, userOf } from './helpers';

/** Renders a screen and checks every filled pixel stays on the 480x270 canvas. */
const renderInBounds = (fc: TestFranchiseContext, screen: Screen): number => {
  const rc = rcFor(fc.services);
  screen.render(rc);
  const out = rc.ctx.fills.filter((f) => f.x < -1 || f.y < -1 || f.x + f.w > rc.width + 1 || f.y + f.h > rc.height + 1);
  expect(out.slice(0, 3)).toEqual([]);
  return rc.ctx.fills.length;
};

describe('hub and recap models', () => {
  it('builds the header, week labels, blocker text and the roster tab id', () => {
    const league = leagueAt(101, 'regularSeason');
    const h = hubHeader(league, userOf(league));
    expect(h).toMatchObject({ abbr: 'BOS', record: '0-0', date: `${league.season.year} Week 1`, phase: 'regularSeason' });
    expect(h.cash.text).toMatch(/^-?\$/);
    expect(h.capSpace.tone).toMatch(/success|warning|danger/);
    expect(weekLabel(league)).toBe('Week 1');
    expect(() => hubHeader(league, 'x' as never)).toThrow();
    expect(blockerSummary([{ kind: 'overCap', severity: 'blocking', message: 'a' }, { kind: 'overCap', severity: 'blocking', message: 'b' }], 1)).toBe('a. +1 more');
    expect(rosterTabId([{ id: 'home', group: 'home' }, { id: 'team-roster', group: 'team' }])).toBe('team-roster');
    expect(rosterTabId([{ id: 'home', group: 'home' }, { id: 'depth', group: 'team' }])).toBe('depth');
    expect(rosterTabId([{ id: 'home', group: 'home' }])).toBeNull();
  });

  it('headlines award winners by their label, never by the raw award id', () => {
    const league = leagueAt(62, 'awards');
    const r = new SimJob(league, { kind: 'phase', phase: SEASON_PHASE_ORDER[SEASON_PHASE_ORDER.indexOf('awards') + 1] ?? 'awards' }, { simulator: fallbackSimulator }).runToEnd();
    const lines = buildRecap(league, r, userOf(league)).headlines;
    expect(lines.some((l) => l.text.startsWith('Most Valuable Player: '))).toBe(true);
    expect(lines.some((l) => /^(MVP|OPOY|DPOY|OROY|DROY|COY|best[A-Za-z]+):/.test(l.text))).toBe(false);
  });

  it('summarises a multi-week stretch with results, scoreboard and headlines', () => {
    const league = leagueAt(101, 'regularSeason');
    const r = new SimJob(league, { kind: 'phase', phase: 'playoffs' }, { simulator: fallbackSimulator }).runToEnd();
    const recap = buildRecap(league, r, userOf(league));
    expect(recap.title).toMatch(/^Simulated \d+ weeks/);
    expect(recap.box).toBeNull();
    expect(recap.results.length).toBe(league.settings.regularSeasonWeeks);
    expect(recap.scoreboard.length).toBeGreaterThan(0);
    expect(recap.headlines.some((l) => /Playoffs|playoff field/.test(l.text))).toBe(true);
    const fc = createTestFranchiseContext(r.league, { settings: { textSize: 'large' } });
    const screen = new WeekRecapScreen(fc, recap);
    fc.push(screen);
    expect(screen.section).toBe('results');
    renderInBounds(fc, screen);
    fc.tick(makeInput({ pressed: ['menuTabRight'] }));
    expect(screen.section).toBe('scores');
    renderInBounds(fc, screen);
    fc.tick(makeInput({ pressed: ['menuTabRight'] }));
    expect(screen.section).toBe('headlines');
    const idx = screen.view.headlines.findIndex((l) => l.teamId || l.playerId);
    if (idx >= 0) {
      screen.table.select(idx);
      fc.tick(makeInput({ pressed: ['confirm'] }));
      expect(fc.openedTeams.length + fc.openedPlayers.length).toBe(1);
    }
    fc.tick(makeInput({ pressed: ['pause'] }));
    expect(fc.stack.size).toBe(0);
  }, 30000);
});

describe('shell screens render inside the canvas in normal and large text', () => {
  it('progress, team picker, bracket, event detail, game day, home and summary', () => {
    const league = leagueAt(101, 'regularSeason');
    const inPlayoffs = { ...league };
    for (const size of ['normal', 'large'] as const) {
      const fc = createTestFranchiseContext(league, { settings: { textSize: size } });
      const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator });
      const progress = new SimProgressScreen(job, { onDone: () => undefined });
      fc.push(progress);
      expect(renderInBounds(fc, progress)).toBeGreaterThan(10);
      fc.pop();

      const picked: string[] = [];
      const picker = new TeamPickScreen({ title: 'PICK', subtitle: 'Sub', teams: Object.values(league.teams), onPick: (t) => picked.push(t.abbr), note: (t) => (t.abbr === 'BOS' ? '#1 X' : null) });
      fc.push(picker);
      renderInBounds(fc, picker);
      const row = picker.table.hitMap?.rows[1];
      if (row) {
        const tap = (): void => {
          fc.tick(makeInput({ pointer: { ...pointerAt(row.rect.x + 2, row.rect.y + 1, true), down: true }, device: 'touch' }));
          fc.tick(makeInput({ pointer: { x: row.rect.x + 2, y: row.rect.y + 1, down: false, justDown: false, justUp: true, drag: null }, device: 'touch' }));
        };
        // First tap on another row only highlights it (its preview card shows); a second tap chooses it.
        tap();
        expect(picked).toHaveLength(0);
        expect(picker.table.selected?.id).toBe(picker.table.rows[1]?.id);
        tap();
        expect(picked).toEqual([picker.table.selected?.abbr]);
      }
      fc.pop();

      const day = new GameDayScreen(fc, league.season.schedule.find((g) => g.week === 1 && (g.home === userOf(league) || g.away === userOf(league)))?.id ?? ('' as never), { simulator: fallbackSimulator });
      fc.push(day);
      renderInBounds(fc, day);
      fc.pop();

      const home = new HomeTabScreen(fc, () => null);
      fc.push(home);
      renderInBounds(fc, home);
      fc.pop();

      const summary = new SeasonSummaryScreen(fc, () => undefined);
      fc.push(summary);
      renderInBounds(fc, summary);
      fc.pop();

      const eventLeague = { ...league, events: [{ id: 'e', year: league.year, week: 1, type: 'unhappyPlayer' as const, teamId: userOf(league), playerId: league.teams[userOf(league)]?.rosterIds[0] as PlayerId, coachId: null, title: 'An unhappy player wants a word with the coaching staff today', description: 'He feels his role has shrunk and wants to know where he stands. '.repeat(6), choices: [{ id: 'a', label: 'Promise more snaps', description: 'He will expect it.' }, { id: 'b', label: 'Stand firm', description: 'Morale may dip.' }], resolvedChoice: null, read: false }] };
      const efc = createTestFranchiseContext(eventLeague, { settings: { textSize: size } });
      const detail = new EventDetailScreen(efc, 'e');
      efc.push(detail);
      renderInBounds(efc, detail);
      efc.tick(makeInput({ pressed: ['menuDown'] }));
      efc.tick(makeInput({ pressed: ['menuDown'] }));
      efc.tick(makeInput({ pressed: ['confirm'] }));
      expect(efc.openedPlayers).toHaveLength(1);

      const wizard = new NewFranchiseScreen({ onCreate: () => undefined, seed: () => 1 });
      fc.push(wizard);
      renderInBounds(fc, wizard);
      fc.pop();
    }
    expect(inPlayoffs).toBeDefined();
  });

  it('bracket view switches rounds and opens teams', () => {
    const league = leagueAt(102, 'playoffs');
    for (const size of ['normal', 'large'] as const) {
      const fc = createTestFranchiseContext(league, { settings: { textSize: size } });
      const view = new BracketView(league, userOf(league));
      expect(view.round).toBe(1);
      const rc = rcFor(fc.services);
      view.draw(rc.ctx, fc.services.theme, { x: 8, y: 20, w: 464, h: 220 });
      expect(rc.ctx.fills.every((f) => f.x + f.w <= 481)).toBe(true);
      expect(view.update(1 / 60, makeInput({ pressed: ['menuTabRight'] }))).toBeNull();
      expect(view.round).toBe(2);
      expect(view.table.rows).toHaveLength(0);
      view.update(1 / 60, makeInput({ pressed: ['menuTabLeft'] }));
      const opened = view.update(1 / 60, makeInput({ pressed: ['confirm'] }));
      expect(opened && typeof opened === 'object' ? opened.open : null).toBeTruthy();
      expect(view.update(1 / 60, makeInput({ pressed: ['back'] }))).toBe('back');
    }
  }, 30000);

  it('hub, playoffs, save and custom screens stay on the canvas', async () => {
    const league = leagueAt(101, 'regularSeason');
    const saves = memorySaves();
    await saves.slots.save('franchise-1', league, null, { name: 'A very long franchise save name here' });
    for (const size of ['normal', 'large'] as const) {
      const fc = createTestFranchiseContext(league, { settings: { textSize: size } });
      const hub = new FranchiseHubScreen({ league, onExit: () => undefined, simulator: fallbackSimulator });
      fc.push(hub);
      renderInBounds(fc, hub);
      hub.selectTab('inbox');
      renderInBounds(fc, hub);
      fc.pop();
      const playoffs = new PlayoffsModeScreen({ league: leagueAt(102, 'playoffs'), onExit: () => undefined, simulator: fallbackSimulator });
      fc.push(playoffs);
      while (fc.stack.top !== playoffs) fc.pop();
      renderInBounds(fc, playoffs);
      fc.pop();
      const load = new LoadFranchiseScreen({ slots: saves.slots, onLoad: () => undefined });
      fc.push(load);
      await load.refresh();
      renderInBounds(fc, load);
      fc.pop();
      const menu = new FranchiseMenuScreen({ slots: saves.slots, onNew: () => undefined, onLoadList: () => undefined, onContinue: () => undefined });
      fc.push(menu);
      await menu.refresh();
      renderInBounds(fc, menu);
      fc.pop();
      const custom = new CustomGameScreen({ league: quickGameLeague(7), onStart: () => undefined });
      fc.push(custom);
      renderInBounds(fc, custom);
      fc.pop();
      const editor = new CustomTeamScreen({ teams: Object.values(league.teams), onCreate: () => undefined });
      fc.push(editor);
      renderInBounds(fc, editor);
      fc.pop();
    }
  }, 30000);

  it('advance and team-choice dialogs fit the canvas in large text', () => {
    const fc = createTestFranchiseContext(leagueAt(101, 'regularSeason'), { settings: { textSize: 'large' } });
    const hub = new FranchiseHubScreen({ league: fc.league(), onExit: () => undefined, simulator: fallbackSimulator });
    fc.push(hub);
    hub.openAdvanceMenu();
    const dialog = fc.stack.top as Screen;
    expect(dialog.id).toBe('franchise-choice');
    renderInBounds(fc, dialog);
    const inPlayoffs = leagueAt(102, 'playoffs');
    const missed = Object.keys(inPlayoffs.teams).find((id) => !playoffField(inPlayoffs).includes(id as never)) as string;
    const mode = new PlayoffsModeScreen({ league: withUserTeam(inPlayoffs, missed as never), onExit: () => undefined, simulator: fallbackSimulator });
    fc.push(mode);
    expect(fc.stack.top?.id).toBe('franchise-choice');
    renderInBounds(fc, fc.stack.top as Screen);
  }, 30000);

  it('refits menus to the rows that fit', () => {
    const menu = new MenuList([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], { initialIndex: 2 });
    const fitted = refitMenu(menu, 2);
    expect(fitted.maxVisible).toBe(2);
    expect(fitted.selected?.id).toBe('c');
    expect(refitMenu(fitted, 2)).toBe(fitted);
    expect(refitMenu(fitted, 5).maxVisible).toBe(0);
  });
});
