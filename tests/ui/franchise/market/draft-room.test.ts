import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { isUserOnTheClock } from '@/franchise/draft';
import { MAJOR_NEED, teamNeeds } from '@/franchise/gm/needs';
import { phaseBlocker } from '@/franchise/phase';
import { advanceLeaguePhase } from '@/franchise/season-loop';
import type { League } from '@/franchise/types';
import type { Team } from '@/teams/types';
import { ChoiceDialog, ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import {
  NEED_FIT_WEIGHT, autoPickUser, availableRows, draftBadge, draftProspect, draftRoomStatus, ensureDraftStarted, logRows, orderRows, simToEnd, simToMine,
} from '@/ui/franchise/market/draft-model';
import { DraftRoomScreen } from '@/ui/franchise/market/draft-screen';
import { ProspectScreen } from '@/ui/franchise/market/prospect-detail';
import { TradesScreen } from '@/ui/franchise/market/trades-screen';
import { contextFor, draftLeague, guardedLeague, mount, press, rcFor } from './fixtures';

let before: League;
let started: League;
let onClock: League;
let user: TeamId;

beforeAll(() => {
  before = draftLeague();
  user = before.userTeamId as TeamId;
  started = ensureDraftStarted(before, createRng(1));
  onClock = simToMine(started, createRng(2));
}, 60_000);

describe('draft room view-models', () => {
  it('starts the draft from the room and lays out the order', () => {
    expect(draftRoomStatus(before, user)).toMatchObject({ started: false, complete: false, totalPicks: 0 });
    const fc = contextFor(before);
    const screen = mount(fc, new DraftRoomScreen(fc));
    expect(screen.status().text).toContain('not started');
    expect(screen.actions().map((a) => a.id)).toContain('start');
    screen.runAction('start');
    expect(fc.commits.at(-1)?.reason).toBe('draftPick');
    const s = screen.room;
    expect(s).toMatchObject({ started: true, round: 1, pickInRound: 1, overall: 1, pickIndex: 0 });
    const order = orderRows(fc.league(), user);
    expect(order).toHaveLength(fc.league().draft?.order.length ?? -1);
    expect(order.filter((r) => r.isCurrent).map((r) => r.index)).toEqual([0]);
    expect(order.filter((r) => r.isUser).length).toBe(s.userPicksLeft);
    expect(order[0]?.label).toBe('1-1');
    expect(screen.order.selected?.isCurrent).toBe(true);
    expect(ensureDraftStarted(fc.league(), createRng(9))).toBe(fc.league());
  });

  it('ranks the pool by the user reports with need and fit, never reading the ground truth', () => {
    const guarded = guardedLeague(onClock);
    const rows = availableRows(guarded, user);
    expect(rows).toHaveLength(onClock.draft?.prospects.length ?? -1);
    const needs = teamNeeds(onClock, onClock.teams[user] as Team);
    for (const r of rows.slice(0, 20)) {
      expect(r.report).toBe(onClock.draft?.reports[user]?.[r.id]);
      expect(r.need).toBe(needs.positions[r.position].need);
      expect(r.fit).toBeCloseTo(r.value + NEED_FIT_WEIGHT * r.need, 9);
      expect(r.needText.text).toBe(r.need >= MAJOR_NEED ? 'High' : r.need >= 0.2 ? 'Some' : 'Low');
    }
    const fc = contextFor(guarded);
    const screen = mount(fc, new DraftRoomScreen(fc));
    for (const s of ['available', 'board', 'order', 'log']) {
      screen.showSection(s);
      screen.render(rcFor(fc));
    }
    expect(screen.room.userOnClock).toBe(true);
    expect(draftBadge(onClock)).toBe('!');
    expect(draftBadge(started)).toBeNull();
  });

  it('drafts for the user only on the clock, logs the pick with the scouts grade', () => {
    const s = draftRoomStatus(onClock, user);
    expect(s.userOnClock).toBe(true);
    expect(s.picksUntilUser).toBe(0);
    const best = availableRows(onClock, user).sort((a, b) => b.fit - a.fit)[0];
    if (!best) throw new Error('empty pool');
    const after = draftProspect(onClock, user, best.id, createRng(3));
    const p = after.players[best.id];
    expect(p?.teamId).toBe(user);
    expect(p?.contract).not.toBeNull();
    expect(after.draft?.prospects.some((x) => x.player.id === best.id)).toBe(false);
    const log = logRows(after, user);
    expect(log[0]).toMatchObject({ playerId: best.id, isUser: true, grade: best.grade, label: `${s.round}-${s.pickInRound}` });
    expect(() => draftProspect(after, user, (after.draft?.prospects[0]?.player.id ?? '') as PlayerId, createRng(4))).toThrow(/not on the clock/);
    expect(() => draftProspect(started, user, best.id, createRng(4))).toThrow(/not on the clock/);
  });

  it('auto-picks the top of the user board', () => {
    const target = availableRows(onClock, user)[40]?.id as PlayerId;
    const withBoard: League = { ...onClock, draft: { ...(onClock.draft as NonNullable<League['draft']>), userBoard: [target] } };
    const r = autoPickUser(withBoard, user, createRng(5));
    expect(r.playerId).toBe(target);
    expect(r.league.players[target]?.teamId).toBe(user);
    expect(isUserOnTheClock(r.league)).toBe(false);
  });

  it('sims to the end: every pick made, the draft closed and graded, the phase free to advance', () => {
    const done = simToEnd(onClock, createRng(6));
    const s = draftRoomStatus(done, user);
    expect(s.complete).toBe(true);
    expect(s.userPicksLeft).toBe(0);
    const log = logRows(done, user);
    expect(log).toHaveLength(done.draft?.order.length ?? -1);
    expect(log.filter((r) => r.isUser).every((r) => r.grade !== '?')).toBe(true);
    expect(draftBadge(done)).toBeNull();
    expect(phaseBlocker(done)).toBeNull();
    expect(advanceLeaguePhase(done).league.season.phase).toBe('postDraft');
  });
});

describe('DraftRoomScreen', () => {
  it('sims to the user pick and drafts with confirmations', () => {
    const fc = contextFor(started);
    const screen = mount(fc, new DraftRoomScreen(fc, { section: 'order' }));
    screen.runAction('sim-mine');
    expect(fc.toasts.at(-1)).toContain('you are on the clock');
    expect(screen.section).toBe('available');
    expect(screen.status().text).toContain('You are on the clock');
    const pick = screen.available.selected;
    if (!pick) throw new Error('no selection');
    screen.update(1 / 60, press('confirm'));
    const choice = fc.stack.top as ChoiceDialog;
    expect(choice).toBeInstanceOf(ChoiceDialog);
    choice.choose('draft');
    const confirm = fc.stack.top as ConfirmDialog;
    expect(confirm).toBeInstanceOf(ConfirmDialog);
    confirm.choose(true);
    expect(fc.commits.at(-1)?.reason).toBe('draftPick');
    expect(fc.toasts.at(-1)).toContain(`You drafted ${pick.name}`);
    expect(fc.league().players[pick.id]?.teamId).toBe(user);
    expect(screen.room.userOnClock).toBe(false);
    expect(screen.actions().find((a) => a.id === 'auto')?.disabledReason).toBe('not on the clock');
    screen.update(1 / 60, press('confirm'));
    expect(fc.stack.top).toBeInstanceOf(ProspectScreen);
  });

  it('hooks a pick into the trade builder from the menu and from the order', () => {
    const fc = contextFor(started);
    const screen = mount(fc, new DraftRoomScreen(fc));
    screen.runAction('trade-pick');
    const choice = fc.stack.top as ChoiceDialog;
    expect(choice).toBeInstanceOf(ChoiceDialog);
    const first = choice.list.items[0]?.id as string;
    choice.choose(first);
    const trades = fc.stack.top as TradesScreen;
    expect(trades).toBeInstanceOf(TradesScreen);
    expect(trades.pushed).toBe(true);
    expect(trades.deal.give).toEqual([expect.objectContaining({ kind: 'pick', pick: expect.objectContaining({ id: first }) })]);
    expect(trades.section).toBe('get');
    fc.tick(press('back'));
    expect(fc.stack.top).toBeNull();
    screen.showSection('order');
    const mine = screen.order.rows.find((r) => r.isUser && !r.made);
    if (!mine) throw new Error('no user pick');
    screen.order.selectById(mine.id);
    screen.update(1 / 60, press('confirm'));
    expect((fc.stack.top as TradesScreen).deal.give.map((a) => (a.kind === 'pick' ? a.pick.id : a.playerId))).toEqual([mine.id]);
  });

  it('sims to the end from the menu and shows the graded log in large text', () => {
    const fc = contextFor(onClock, true);
    const screen = mount(fc, new DraftRoomScreen(fc));
    expect(screen.available.columns.map((c) => c.key)).toEqual(['name', 'pos', 'grd', 'need']);
    screen.runAction('auto');
    expect(fc.toasts.at(-1)).toContain('Auto-pick');
    screen.runAction('sim-end');
    (fc.stack.top as ConfirmDialog).choose(true);
    expect(screen.room.complete).toBe(true);
    expect(screen.status().text).toContain('complete');
    expect(screen.actions().find((a) => a.id === 'sim-end')?.disabledReason).toBe('draft complete');
    screen.showSection('log');
    screen.render(rcFor(fc));
    expect(screen.log.rows.length).toBe(fc.league().draft?.order.length);
    screen.update(1 / 60, press('confirm'));
    expect(fc.openedPlayers).toHaveLength(1);
  });
});
