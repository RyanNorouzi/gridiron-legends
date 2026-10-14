import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { assignPlayer } from '@/franchise/roster';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League } from '@/franchise/types';
import { createHeadlessServices, type HubTab } from '@/ui/franchise/context';
import { GameDayScreen } from '@/ui/franchise/game-day';
import { createHomeTabs, HomeTabScreen, InboxTabScreen } from '@/ui/franchise/home-tab';
import { defaultHubTabs, FranchiseHubScreen, layoutHubHeader } from '@/ui/franchise/hub';
import { ChoiceDialog, ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { WeekRecapScreen } from '@/ui/franchise/shell/recap-screen';
import { SeasonSummaryScreen } from '@/ui/franchise/shell/season-summary';
import { createMemoryStorage, type SaveSystem } from '@/save/index';
import { makeInput, pointerAt } from '../../render/fake-ctx';
import { flushPromises, leagueAt, memorySaves, rcFor, tickUntil, userOf } from './helpers';

const rosterTab: HubTab = {
  id: 'roster', label: 'Roster', group: 'team',
  create: () => ({ id: 'fake-roster', enter: () => undefined, exit: () => undefined, update: () => undefined, render: () => undefined }),
};

const openHub = (league: League, opts: { saves?: SaveSystem; mode?: 'franchise' | 'season'; large?: boolean; debounceMs?: number } = {}): {
  hub: FranchiseHubScreen; services: ReturnType<typeof createHeadlessServices>; exits: number[];
} => {
  const services = createHeadlessServices(opts.large ? { textSize: 'large' } : {});
  const exits: number[] = [];
  let hub: FranchiseHubScreen | null = null;
  hub = new FranchiseHubScreen({
    league, mode: opts.mode ?? 'franchise', slot: opts.saves ? 'franchise-1' : null, saveSystem: opts.saves ?? null, simulator: fallbackSimulator,
    onExit: () => exits.push(1), tabs: [...createHomeTabs(() => hub), rosterTab],
    ...(opts.debounceMs !== undefined ? { autosaveDebounceMs: opts.debounceMs } : {}),
  });
  services.stack.push(hub);
  return { hub, services, exits };
};

describe('FranchiseHubScreen', () => {
  it('sim week updates standings, commits, autosaves and shows the recap', async () => {
    const league = leagueAt(61, 'regularSeason');
    const saves = memorySaves();
    await saves.slots.save('franchise-1', league, null, { name: 'Hub' });
    const { hub, services } = openHub(league, { saves });
    expect(hub.activeTabId).toBe('home');
    const sim = hub.advanceOptions().find((o) => o.id === 'simWeek');
    expect(sim).toBeDefined();
    hub.runAdvance(sim?.action ?? { kind: 'summary' });
    expect(services.stack.top).toBeInstanceOf(SimProgressScreen);
    tickUntil(services.stack, () => services.stack.top instanceof WeekRecapScreen);
    expect(hub.league.season.week).toBe(2);
    const played = Object.values(hub.league.season.standings).filter((s) => s.wins + s.losses + s.ties === 1);
    expect(played.length).toBeGreaterThanOrEqual(26);
    const recap = services.stack.top as WeekRecapScreen;
    expect(recap.view.scoreboard.length).toBe(played.length / 2);
    expect(recap.view.scoreboard[0]?.user).toBe(true);
    recap.render(rcFor(services));
    await flushPromises();
    const saved = await saves.slots.load('franchise-1');
    expect(saved.meta.week).toBe(2);
    expect(saved.league.season.standings[userOf(league)]).toEqual(hub.league.season.standings[userOf(league)]);
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(services.stack.top).toBe(hub);
    expect((hub as unknown as { hosted: Map<string, { screen: HomeTabScreen }> }).hosted.get('home')?.screen.headlines.some((l) => l.text.startsWith('You '))).toBe(true);
  }, 20000);

  it("persists 'edit' commits (facility upgrades, ticket prices, event choices) after the autosaver's quiet period", async () => {
    const league = leagueAt(61, 'regularSeason');
    const saves = memorySaves();
    await saves.slots.save('franchise-1', league, null, { name: 'Hub' });
    const { hub } = openHub(league, { saves, debounceMs: 1 });
    const user = userOf(league);
    const team = hub.league.teams[user]!;
    hub.fc.commit({ ...hub.league, teams: { ...hub.league.teams, [user]: { ...team, finances: { ...team.finances, ticketPrice: 123 } } } }, 'edit');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flushPromises();
    const saved = await saves.slots.load('franchise-1');
    expect(saved.league.teams[user]!.finances.ticketPrice).toBe(123);
  });

  it('a multi-week sim commits every finished week and checkpoints the slot every few weeks, so a closed tab keeps them', async () => {
    const league = leagueAt(61, 'regularSeason');
    const saves = memorySaves();
    await saves.slots.save('franchise-1', league, null, { name: 'Hub' });
    const { hub, services } = openHub(league, { saves });
    const job = hub.startSim({ kind: 'phase', phase: 'playoffs' });
    expect(services.stack.top).toBeInstanceOf(SimProgressScreen);
    // The slot is written every 4 finished weeks (or 5 s) rather than after each week (shell/sim-saves.ts).
    tickUntil(services.stack, () => job.league.season.week >= 5);
    // Still simulating: the hub already holds the finished weeks and the slot has a mid-sim checkpoint on disk.
    expect(job.done).toBe(false);
    expect(services.stack.top).toBeInstanceOf(SimProgressScreen);
    expect(hub.league).toBe(job.league);
    await flushPromises();
    const mid = await saves.slots.load('franchise-1');
    expect(mid.meta.week).toBeGreaterThan(1);
    expect(mid.meta.week).toBeLessThanOrEqual(job.league.season.week);
    // Stopping keeps every finished week, and the end of the sim reaches the slot at once.
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    tickUntil(services.stack, () => !(services.stack.top instanceof SimProgressScreen));
    expect(hub.league.season.week).toBeGreaterThanOrEqual(5);
    await flushPromises();
    const saved = await saves.slots.load('franchise-1');
    expect(saved.meta.week).toBe(hub.league.season.week);
    expect(saved.league.season.standings[userOf(league)]).toEqual(hub.league.season.standings[userOf(league)]);
  }, 30000);

  it('offers context-aware advance options per phase and mode', () => {
    const reg = openHub(leagueAt(61, 'regularSeason')).hub;
    expect(reg.advanceOptions().map((o) => o.id)).toEqual(['play', 'simWeek', 'simTo:playoffs', 'simTo:awards', 'simTo:preseason']);
    expect(reg.advanceOptions()[0]?.label).toMatch(/^Play Week 1 (vs|at) [A-Z]{2,4}$/);
    const season = openHub(leagueAt(61, 'regularSeason'), { mode: 'season' }).hub;
    expect(season.advanceOptions().map((o) => o.id)).not.toContain('simTo:preseason');
    const pre = openHub(leagueAt(61, 'preseason')).hub;
    expect(pre.advanceOptions().map((o) => o.id)).toContain('simTo:regularSeason');
    const awards = openHub(leagueAt(62, 'awards')).hub;
    expect(awards.advanceOptions().map((o) => o.label)).toEqual(['Next: Offseason', 'Sim through offseason']);
    const seasonDone = openHub(leagueAt(62, 'awards'), { mode: 'season' }).hub;
    expect(seasonDone.advanceOptions().map((o) => o.id)).toEqual(['summary']);
  }, 30000);

  it('blocks a week on roster issues and auto-fixes them on request', () => {
    const base = leagueAt(61, 'regularSeason');
    const user = userOf(base);
    let league = base;
    for (const id of (base.teams[user]?.rosterIds ?? []).slice(0, 6)) league = assignPlayer(league, id as PlayerId, null);
    const { hub, services } = openHub(league);
    hub.runAdvance({ kind: 'sim', target: { kind: 'week' } });
    const dialog = services.stack.top as ChoiceDialog;
    expect(dialog).toBeInstanceOf(ChoiceDialog);
    expect(dialog.title).toBe('Roster issues');
    // 'sign' (APP2-04): short rosters can be filled by hand in season, not only by Auto-fix.
    expect(dialog.list.items.map((i) => i.id)).toEqual(['fix', 'sign', 'roster', 'continue', 'cancel']);
    dialog.choose('fix');
    expect(hub.league.teams[user]?.rosterIds.length).toBeGreaterThanOrEqual(base.settings.rosterSize);
    expect(services.stack.top).toBeInstanceOf(SimProgressScreen);
    tickUntil(services.stack, () => services.stack.top instanceof WeekRecapScreen);
    expect(hub.league.season.week).toBe(2);

    const again = openHub(league);
    again.hub.runAdvance({ kind: 'sim', target: { kind: 'week' } });
    (again.services.stack.top as ChoiceDialog).choose('roster');
    expect(again.hub.activeTabId).toBe('roster');
  }, 20000);

  it('opens game day, the advance menu, tabs and the hub menu from every input', async () => {
    const saves = memorySaves();
    const { hub, services, exits } = openHub(leagueAt(61, 'regularSeason'), { saves });
    const play = hub.advanceOptions()[0];
    hub.runAdvance(play?.action ?? { kind: 'summary' });
    expect(services.stack.top).toBeInstanceOf(GameDayScreen);
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(services.stack.top).toBe(hub);

    services.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    expect((services.stack.top as ChoiceDialog).title).toBe('Advance');
    (services.stack.top as ChoiceDialog).choose(null);
    hub.render(rcFor(services));
    const adv = layoutHubHeader(services.theme, services.width).advance;
    services.stack.update(1 / 60, makeInput({ pointer: pointerAt(adv.x + 2, adv.y + 2, true), device: 'touch' }));
    expect((services.stack.top as ChoiceDialog).title).toBe('Advance');
    (services.stack.top as ChoiceDialog).choose(null);

    services.stack.update(1 / 60, makeInput({ pressed: ['menuTabRight'] }));
    expect(hub.activeTabId).toBe('inbox');
    hub.render(rcFor(services));

    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    const menu = services.stack.top as ChoiceDialog;
    expect(menu.list.items.map((i) => i.id)).toEqual(['resume', 'save', 'practice', 'rules', 'quit']);
    menu.choose('quit');
    await flushPromises();
    expect(exits).toHaveLength(1);
    expect((await saves.slots.load('franchise-1')).league.season.week).toBe(1);
  });

  it('still lets the player leave when "Save & quit" cannot write the save', async () => {
    const mem = createMemoryStorage();
    let full = false;
    const storage = { ...mem, kind: mem.kind, setItem: async (k: string, v: string) => { if (full) throw new Error('quota exceeded'); return mem.setItem(k, v); } };
    const saves = memorySaves(storage);
    const { hub, services, exits } = openHub(leagueAt(61, 'regularSeason'), { saves });
    full = true;
    hub.openMenu();
    (services.stack.top as ChoiceDialog).choose('quit');
    await flushPromises();
    expect(exits).toHaveLength(0);
    const ask = services.stack.top as ConfirmDialog;
    expect(ask).toBeInstanceOf(ConfirmDialog);
    expect(ask.title).toBe('Save failed');
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(services.stack.top).toBe(hub);
    expect(exits).toHaveLength(0);
    hub.openMenu();
    (services.stack.top as ChoiceDialog).choose('quit');
    await flushPromises();
    (services.stack.top as ConfirmDialog).choose(true);
    expect(exits).toHaveLength(1);
  });

  it('shows the season summary when a franchise crowns its champion, then returns to the hub', () => {
    const { hub, services } = openHub(leagueAt(62, 'playoffs'));
    const toEnd = hub.advanceOptions().find((o) => o.id === 'simTo:awards');
    hub.runAdvance(toEnd?.action ?? { kind: 'summary' });
    tickUntil(services.stack, () => services.stack.top instanceof WeekRecapScreen, 10000);
    expect(hub.league.season.phase).toBe('awards');
    (services.stack.top as WeekRecapScreen).close();
    const summary = services.stack.top as SeasonSummaryScreen;
    expect(summary).toBeInstanceOf(SeasonSummaryScreen);
    expect(summary.view.champion).toBe(hub.league.season.champion);
    expect(hub.league.season.phase).toBe('awards');
    summary.close();
    expect(services.stack.top).toBe(hub);
    expect(hub.advanceOptions()[0]?.label).toBe('Next: Offseason');
  }, 60000);

  it('renders in normal and large text with the default tab lists', () => {
    for (const large of [false, true]) {
      const services = createHeadlessServices(large ? { textSize: 'large' } : {});
      const hub = new FranchiseHubScreen({ league: leagueAt(61, 'regularSeason'), onExit: () => undefined, simulator: fallbackSimulator });
      services.stack.push(hub);
      const rc = rcFor(services);
      hub.render(rc);
      expect(rc.ctx.fills.length).toBeGreaterThan(100);
      const content = hub.contentRect();
      expect(content.y + content.h).toBeLessThanOrEqual(services.height);
      expect(defaultHubTabs().slice(0, 2).map((t) => t.id)).toEqual(['home', 'inbox']);
      hub.selectTab('inbox');
      hub.render(rcFor(services));
    }
    expect(InboxTabScreen).toBeDefined();
  });
});
