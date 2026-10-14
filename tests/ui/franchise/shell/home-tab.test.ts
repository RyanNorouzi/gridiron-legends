import { describe, expect, it } from 'vitest';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { FranchiseEvent, League } from '@/franchise/types';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { createHomeTabs, HomeTabScreen, InboxTabScreen } from '@/ui/franchise/home-tab';
import { ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import { EventDetailScreen } from '@/ui/franchise/shell/event-detail';
import { divisionRows, eventStatus, homeHeadlines, inboxRows, latestResults, unreadCount } from '@/ui/franchise/shell/home-model';
import { makeInput } from '../../render/fake-ctx';
import { leagueAt, rcFor, userOf } from './helpers';

const sponsorEvent = (league: League, id: string, read = false): FranchiseEvent => ({
  id, year: league.year, week: 1, type: 'sponsorOffer', teamId: userOf(league), playerId: null, coachId: null, title: 'Sponsorship offer',
  description: 'A regional company offers $2.0M to become an official partner.', read, resolvedChoice: null, data: { amount: 2_000_000 },
  choices: [
    { id: 'accept', label: 'Accept', description: 'Take the money.' },
    { id: 'negotiate', label: 'Negotiate for more', description: 'Ask for 30% more.' },
    { id: 'decline', label: 'Decline', description: 'Not the right partner.' },
  ],
});

describe('home model', () => {
  it('derives division rows, headlines and inbox rows from the league', () => {
    const league = advanceLeagueWeek(leagueAt(81, 'regularSeason'), { simulator: fallbackSimulator }).league;
    const user = userOf(league);
    const rows = divisionRows(league, user);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.user)).toHaveLength(1);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(latestResults(league).every((g) => g.week === 1 && !g.isPreseason)).toBe(true);
    const lines = homeHeadlines(league, user);
    expect(lines[0]?.text).toMatch(/^You (beat|lost to|tied) [A-Z]+ \d+-\d+/);
    expect(lines.length).toBeGreaterThan(2);
    const withEvents: League = { ...league, events: [...league.events, sponsorEvent(league, 'e1'), sponsorEvent(league, 'e2', true)] };
    const inbox = inboxRows(withEvents, user).filter((r) => r.id === 'e1' || r.id === 'e2');
    expect(inbox.map((r) => r.id)).toEqual(['e2', 'e1']);
    expect(inbox[1]?.unread).toBe(true);
    expect(eventStatus(sponsorEvent(league, 'x')).text).toBe('Open');
    expect(unreadCount(withEvents, user)).toBe(unreadCount(league, user) + 1);
  });

  it('lists inbox events in calendar order even across the offseason (week 0) and preseason weeks', () => {
    const league = leagueAt(81, 'regularSeason');
    const user = userOf(league);
    const late = { ...sponsorEvent(league, 'reg9'), week: 9 };
    const offseason = { ...sponsorEvent(league, 'off'), week: 0 };
    const rows = inboxRows({ ...league, events: [late, offseason] }, user);
    expect(rows.map((r) => r.id)).toEqual(['off', 'reg9']);
  });
});

describe('home and inbox tabs', () => {
  it('home tab shows the next opponent and routes its actions', () => {
    const league = leagueAt(81, 'regularSeason');
    const fc = createTestFranchiseContext(league);
    const calls: string[] = [];
    const tabs = createHomeTabs(() => ({ mode: 'franchise', openAdvanceMenu: () => calls.push('advance'), selectTab: (id) => { calls.push(`tab:${id}`); return true; } }));
    expect(tabs.map((t) => t.id)).toEqual(['home', 'inbox']);
    const home = tabs[0]?.create(fc) as HomeTabScreen;
    fc.push(home);
    expect(home.card?.gameId).toBeDefined();
    expect(home.list.items[0]?.label).toMatch(/^Play Week 1/);
    fc.tick(makeInput({ pressed: ['confirm'] }));
    fc.tick(makeInput({ pressed: ['menuDown'] }));
    fc.tick(makeInput({ pressed: ['confirm'] }));
    fc.tick(makeInput({ pressed: ['menuDown'] }));
    fc.tick(makeInput({ pressed: ['confirm'] }));
    expect(calls).toEqual(['advance', 'tab:inbox']);
    expect(fc.openedTeams).toHaveLength(1);
    home.render(rcFor(fc.services));
    const large = createTestFranchiseContext(league, { settings: { textSize: 'large' } });
    const big = new HomeTabScreen(large, () => null);
    large.push(big);
    big.render(rcFor(large.services));
  });

  it('home tab shows the phase card outside the game phases', () => {
    const awards = createTestFranchiseContext(leagueAt(82, 'awards'));
    const off = new HomeTabScreen(awards, () => null);
    expect(off.card).toBeNull();
    expect(off.list.items[0]?.label).toBe('Next: Offseason');
    awards.push(off);
    off.render(rcFor(awards.services));
  }, 30000);

  it('inbox opens an event, marks it read and resolves a choice through resolveEvent', () => {
    const base = leagueAt(81, 'regularSeason');
    const league: League = { ...base, events: [...base.events, sponsorEvent(base, 'evt-1')] };
    const fc = createTestFranchiseContext(league);
    const badge = createHomeTabs(() => null)[1]?.badge?.(league);
    expect(Number(badge)).toBeGreaterThanOrEqual(1);
    const inbox = new InboxTabScreen(fc);
    fc.push(inbox);
    inbox.table.selectById('evt-1');
    inbox.render(rcFor(fc.services));
    fc.tick(makeInput({ pressed: ['confirm'] }));
    const detail = fc.stack.top as EventDetailScreen;
    expect(detail).toBeInstanceOf(EventDetailScreen);
    expect(fc.league().events.find((e) => e.id === 'evt-1')?.read).toBe(true);
    expect(detail.list.items.map((i) => i.id)).toEqual(['choice:accept', 'choice:negotiate', 'choice:decline', 'back']);
    detail.render(rcFor(fc.services));
    const cashBefore = fc.league().teams[userOf(league)]?.finances.cash ?? 0;
    fc.tick(makeInput({ pressed: ['confirm'] }));
    const confirm = fc.stack.top as ConfirmDialog;
    expect(confirm).toBeInstanceOf(ConfirmDialog);
    confirm.choose(true);
    const resolved = fc.league().events.find((e) => e.id === 'evt-1');
    expect(resolved?.resolvedChoice).toBe('accept');
    expect(fc.league().teams[userOf(league)]?.finances.cash ?? 0).toBeGreaterThan(cashBefore);
    expect(detail.list.items.map((i) => i.id)).toEqual(['back']);
    expect(detail.resolve('decline')).toBe(false);
    fc.tick(makeInput({ pressed: ['back'] }));
    expect(fc.stack.top).toBe(inbox);
    expect(inbox.table.rows.find((r) => r.id === 'evt-1')?.status).toBe('Accept');
  });
});
