import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { isTaskDone } from '@/franchise/awards';
import { capSpace, contractApy, leagueCapYear, minimumSalaryFor } from '@/franchise/contracts';
import { makeFreeAgentOffer } from '@/franchise/free-agency';
import { acceptThreshold, counterOffer, preferenceScore } from '@/franchise/negotiation';
import { phaseBlocker } from '@/franchise/phase';
import { advanceLeaguePhase } from '@/franchise/season-loop';
import type { League } from '@/franchise/types';
import type { Team } from '@/teams/types';
import { ChoiceDialog, ConfirmDialog, StepperDialog } from '@/ui/franchise/kit/dialogs';
import { FaDetailScreen } from '@/ui/franchise/market/fa-detail';
import {
  DEFAULT_FA_FILTERS, FA_FILTER_CHOICES, acceptCounter, cycleFilter, declineCounter, ensureMarketOpen, faBadge, faPoolRows, faStatus, filterLabel,
  offerProblem, placeOffer, preferenceView, runRound, signingRows, userOfferRows, userPending, withdrawOffer, type FaPoolRow,
} from '@/ui/franchise/market/fa-model';
import { FreeAgencyScreen } from '@/ui/franchise/market/fa-screen';
import { centre, contextFor, mount, press, rcFor, tap, freeAgencyLeague } from './fixtures';

let before: League;
let opened: League;
let user: TeamId;

beforeAll(() => {
  before = freeAgencyLeague();
  user = before.userTeamId as TeamId;
  opened = ensureMarketOpen(before);
}, 60_000);

/** Mid-tier free agents with a generous offer (60% more salary, starter role). */
const generous = (league: League, n: number): { rows: FaPoolRow[]; league: League } => {
  const rows = faPoolRows(league, user).filter((r) => r.overall >= 60 && r.overall < 70).slice(0, n);
  let out = league;
  for (const r of rows) out = placeOffer(out, user, r.id, { ...r.ask, salary: Math.round(r.ask.salary * 1.6), role: 'starter' });
  return { rows, league: out };
};

describe('free agency view-models', () => {
  it('shows the closed market, then opens it with the expiring deals in the pool', () => {
    const s = faStatus(before, user);
    expect(s).toMatchObject({ started: false, open: false, finished: false });
    expect(s.expiring).toBeGreaterThan(0);
    const fc = contextFor(before);
    const screen = mount(fc, new FreeAgencyScreen(fc));
    expect(screen.status().text).toContain('Market not open');
    expect(screen.actions().map((a) => a.id)).toContain('open');
    screen.runAction('open');
    expect(fc.commits.at(-1)?.reason).toBe('signing');
    expect(fc.league().freeAgency?.round).toBe(1);
    expect(faStatus(fc.league(), user).poolSize).toBeGreaterThan(s.poolSize);
    expect(screen.status().text).toContain('Round 1 of 5');
    expect(ensureMarketOpen(fc.league())).toBe(fc.league());
  });

  it('filters the pool by position, overall, age and ask', () => {
    const all = faPoolRows(opened, user);
    expect(all.length).toBe(opened.freeAgentIds.length);
    expect(all.map((r) => r.overall)).toEqual([...all.map((r) => r.overall)].sort((a, b) => b - a));
    expect(faPoolRows(opened, user, { ...DEFAULT_FA_FILTERS, position: 'QB' }).every((r) => r.position === 'QB')).toBe(true);
    expect(faPoolRows(opened, user, { ...DEFAULT_FA_FILTERS, minOverall: 70 }).every((r) => r.overall >= 70)).toBe(true);
    expect(faPoolRows(opened, user, { ...DEFAULT_FA_FILTERS, maxAge: 25 }).every((r) => r.age <= 25)).toBe(true);
    const cheap = faPoolRows(opened, user, { ...DEFAULT_FA_FILTERS, maxAsk: 1_000_000 });
    expect(cheap.length).toBeGreaterThan(0);
    expect(cheap.every((r) => r.ask.apy <= 1_000_000)).toBe(true);
    let f = cycleFilter(DEFAULT_FA_FILTERS, 'position');
    expect(f.position).toBe('QB');
    for (let i = 1; i < FA_FILTER_CHOICES.position.length; i++) f = cycleFilter(f, 'position');
    expect(f.position).toBeNull();
    expect(filterLabel('minOverall', 70)).toBe('OVR 70+');
    expect(filterLabel('maxAsk', null)).toBe('Ask any');
  });

  it('explains what a player values and how the user team scores', () => {
    const row = faPoolRows(opened, user).find((r) => r.overall >= 65) as FaPoolRow;
    const player = opened.players[row.id];
    const team = opened.teams[user] as Team;
    if (!player) throw new Error('player');
    const view = preferenceView(opened, player, user);
    expect(view.lines).toHaveLength(7);
    expect(view.lines.reduce((s, l) => s + l.share, 0)).toBeCloseTo(1, 6);
    expect(view.lines.map((l) => l.share)).toEqual([...view.lines.map((l) => l.share)].sort((a, b) => b - a));
    expect(view.score).toBeCloseTo(preferenceScore(player, team, view.ask, opened, { ask: view.ask }), 9);
    // The exact signing bar is never exposed (it could be probed); the staff's banded read stands in for it.
    expect(view).not.toHaveProperty('threshold');
    expect(view).not.toHaveProperty('wouldSign');
    expect(['likely', 'close', 'far']).toContain(view.read.band);
    expect(view.talks).toMatchObject({ rounds: 0, walkedAway: false });
    expect(acceptThreshold(view.patience)).toBeGreaterThan(0);
    const rich = preferenceView(opened, player, user, { ...view.ask, salary: view.ask.salary * 2 });
    const money = (v: typeof view): number => v.lines.find((l) => l.key === 'money')?.appeal ?? 0;
    expect(money(rich)).toBeGreaterThanOrEqual(money(view));
    expect(row.cares.split(', ')).toHaveLength(2);
  });

  it('records, replaces, validates and withdraws offers', () => {
    const row = faPoolRows(opened, user).find((r) => r.overall >= 60) as FaPoolRow;
    let l = placeOffer(opened, user, row.id, row.ask);
    expect(userPending(l, user).current.map((o) => o.playerId)).toEqual([row.id]);
    l = placeOffer(l, user, row.id, { ...row.ask, years: Math.min(7, row.ask.years + 1) });
    expect(userPending(l, user).current).toHaveLength(1);
    expect(faPoolRows(l, user).find((r) => r.id === row.id)?.offer).toBe('pending');
    const player = l.players[row.id];
    if (!player) throw new Error('player');
    expect(offerProblem(l, user, player, { ...row.ask, salary: 0, signingBonus: 0 })).toContain('minimum');
    const space = capSpace(l.teams[user] as Team, l.players, l.settings, leagueCapYear(l));
    expect(offerProblem(l, user, player, { ...row.ask, salary: space + 1_000_000, signingBonus: 0 })).toContain('cap space');
    const rostered = l.players[(l.teams[user] as Team).rosterIds[0] as PlayerId];
    if (!rostered) throw new Error('rostered');
    expect(offerProblem(l, user, rostered, row.ask)).toContain('not a free agent');
    expect(() => placeOffer(l, user, rostered.id, row.ask)).toThrow();
    const id = userPending(l, user).current[0]?.id as string;
    l = withdrawOffer(l, user, id);
    expect(userPending(l, user).current).toEqual([]);
    expect(userOfferRows(l, user)[0]?.status.text).toBe('Withdrawn');
  });

  it('runs bidding rounds with the user offers and closes the market after the last one', () => {
    const { rows, league } = generous(opened, 3);
    const r1 = runRound(league, user, createRng(11));
    expect(r1.round).toBe(1);
    expect(userPending(r1.league, user).current).toEqual([]);
    expect(r1.signed.length).toBeGreaterThan(0);
    for (const id of r1.signed) {
      expect(rows.map((r) => r.id)).toContain(id);
      expect(r1.league.players[id]?.teamId).toBe(user);
    }
    expect(r1.message).toContain('Round 1: signed');
    expect(signingRows(r1.league, user).filter((s) => s.isUser)).toHaveLength(r1.signed.length);
    expect(r1.league.freeAgency?.round).toBe(2);
    let l = r1.league;
    let last = r1;
    for (let guard = 0; !last.closed && guard < 10; guard++) {
      last = runRound(l, user, createRng(20 + guard));
      l = last.league;
    }
    expect(last.closed).toBe(true);
    expect(last.message).toContain('closed');
    expect(isTaskDone(l, l.season.year, 'freeAgency')).toBe(true);
    expect(phaseBlocker(l)).toBeNull();
    expect(faStatus(l, user).finished).toBe(true);
    expect(() => runRound(l, user, createRng(1))).toThrow();
    const signings = l.freeAgency?.signings.length;
    const next = advanceLeaguePhase(l).league;
    expect(next.season.phase).toBe('draft');
    expect(next.freeAgency?.signings.length).toBe(signings);
  });

  it('lets the user accept or decline a player counter', () => {
    const r1 = runRound(opened, user, createRng(4));
    const l1 = r1.league;
    const row = faPoolRows(l1, user).find((r) => r.overall >= 62) as FaPoolRow;
    const player = l1.players[row.id];
    const fa = l1.freeAgency;
    if (!player || !fa) throw new Error('setup');
    const lowball = { ...makeFreeAgentOffer(l1, user, row.id, { ...row.ask, salary: Math.round(row.ask.salary * 0.6) }), id: 'low', round: 1 };
    const counter = counterOffer(player, l1.teams[user] as Team, lowball, l1, leagueCapYear(l1));
    const withCounter: League = { ...l1, freeAgency: { ...fa, offers: [...fa.offers, counter] } };
    expect(userPending(withCounter, user).counters.map((o) => o.id)).toEqual([counter.id]);
    expect(faBadge(withCounter)).toBe('!');
    expect(faPoolRows(withCounter, user).find((r) => r.id === row.id)?.offer).toBe('counter');
    expect(declineCounter(withCounter, user, counter.id).freeAgency?.offers.find((o) => o.id === counter.id)?.status).toBe('rejected');
    const fc = contextFor(withCounter);
    const screen = mount(fc, new FreeAgencyScreen(fc, { section: 'offers' }));
    expect(screen.offers.selected?.kind).toBe('counter');
    screen.update(1 / 60, press('confirm'));
    (fc.stack.top as ChoiceDialog).choose('counter-accept');
    expect(fc.commits.at(-1)?.reason).toBe('edit');
    const accepted = userPending(fc.league(), user).current.find((o) => o.id === counter.id);
    expect(accepted?.round).toBe(fa.round);
    expect(contractApy(accepted ?? counter)).toBe(contractApy(counter));
    const r2 = runRound(fc.league(), user, createRng(5));
    expect(r2.league.freeAgency?.offers.find((o) => o.id === counter.id)?.status).not.toBe('pending');
    expect(() => acceptCounter(r2.league, user, counter.id)).toThrow();
  });
});

describe('free-agent talks in the market UI', () => {
  it('lowballing the same player makes him walk away: the pool, the round message and new offers say so', () => {
    const dry = runRound(opened, user, createRng(3));
    const bidOn = new Set((dry.league.freeAgency?.offers ?? []).map((o) => o.playerId));
    const bottom = (id: PlayerId) => ({ salary: minimumSalaryFor(opened.players[id]!.experience, opened.settings), years: 1, guaranteed: 0, signingBonus: 0, role: 'developmental' as const });
    /** Lowballs `id` for up to three rounds; the league and last message once he walks away, else null. */
    const lowballUntilGone = (id: PlayerId): { l: League; last: string } | null => {
      let l = opened;
      for (let i = 0; i < 3; i++) {
        l = placeOffer(l, user, id, bottom(id));
        const r = runRound(l, user, createRng(3 + i));
        l = r.league;
        if (l.players[id]?.teamId !== null) return null;
        if (r.walkedAway.includes(id)) return { l, last: r.message };
      }
      return null;
    };
    const candidates = faPoolRows(opened, user).filter((r) => !bidOn.has(r.id) && r.overall >= 50).slice(0, 12);
    let found: { id: PlayerId; l: League; last: string } | null = null;
    for (const c of candidates) {
      const got = lowballUntilGone(c.id);
      if (got) { found = { id: c.id, ...got }; break; }
    }
    if (!found) throw new Error('no free agent walked away after three rock-bottom offers');
    const { l, last } = found;
    const target = l.players[found.id]!;
    expect(last).toContain('walked away');
    expect(faPoolRows(l, user).find((r) => r.id === target.id)?.offerText).toEqual({ text: 'Walked away', tone: 'danger' });
    const player = l.players[target.id]!;
    expect(offerProblem(l, user, player, preferenceView(l, player, user).ask)).toContain('walked away');
    expect(() => placeOffer(l, user, target.id, preferenceView(l, player, user).ask)).toThrow(/walked away/);
    const view = preferenceView(l, player, user);
    expect(view.read.band).toBe('walkedAway');
    expect(view.talks.walkedAway).toBe(true);
    expect(view.talks.text.text).toContain('Walked away');
  });
});

describe('FreeAgencyScreen', () => {
  it('filters with chip taps and makes offers through the stepper dialog', () => {
    const fc = contextFor(opened);
    const screen = mount(fc, new FreeAgencyScreen(fc));
    const chip = screen.chips.find((c) => c.key === 'position');
    if (!chip) throw new Error('no chip');
    tap((i) => screen.update(1 / 60, i), ...centre(chip.rect));
    expect(screen.filters.position).toBe('QB');
    expect(screen.pool.rows.every((r) => r.position === 'QB')).toBe(true);
    screen.render(rcFor(fc));
    const clear = screen.chips.find((c) => c.key === 'clear');
    if (!clear) throw new Error('no clear chip');
    tap((i) => screen.update(1 / 60, i), ...centre(clear.rect), 'mouse');
    expect(screen.filters).toEqual(DEFAULT_FA_FILTERS);
    screen.update(1 / 60, press('pause'));
    const menu = fc.stack.top as ChoiceDialog;
    expect(menu.list.items.map((i) => i.id)).toEqual(expect.arrayContaining(['offer', 'round', 'finish', 'filter:position']));
    const target = screen.pool.selected;
    if (!target) throw new Error('no selection');
    menu.choose('offer');
    const stepper = fc.stack.top as StepperDialog;
    expect(stepper).toBeInstanceOf(StepperDialog);
    // The live summary is the staff's read, with no percentages that would pin down his bar.
    expect(stepper.summary).toMatch(/staff read: (Likely to sign|Close|Far apart)/);
    expect(stepper.summary).not.toMatch(/%|bar/);
    expect(stepper.submit()).toBe(true);
    expect(fc.toasts.at(-1)).toContain('Offer made');
    expect(screen.pool.rows.find((r) => r.id === target.id)?.offer).toBe('pending');
    expect(screen.bar.tabs.find((t) => t.id === 'offers')?.badge).toBe('1');
  });

  it('autosaves an offer that opened the market on the way (expired deals released)', () => {
    const fc = contextFor(before);
    const screen = mount(fc, new FreeAgencyScreen(fc));
    expect(screen.marketStatus.started).toBe(false);
    const target = screen.pool.selected;
    if (!target) throw new Error('no selection');
    screen.runAction('offer');
    expect((fc.stack.top as StepperDialog).submit()).toBe(true);
    expect(fc.commits.at(-1)?.reason).toBe('signing');
    expect(fc.league().freeAgency?.round).toBe(1);
    screen.update(1 / 60, press());
    expect(screen.marketStatus.started).toBe(true);
    screen.runAction('offer');
    expect((fc.stack.top as StepperDialog).submit()).toBe(true);
    expect(fc.commits.at(-1)?.reason).toBe('edit');
  });

  it('opens the player detail on Confirm, with his values and an offer action', () => {
    const fc = contextFor(opened);
    const screen = mount(fc, new FreeAgencyScreen(fc));
    screen.update(1 / 60, press('confirm'));
    const detail = fc.stack.top as FaDetailScreen;
    expect(detail).toBeInstanceOf(FaDetailScreen);
    detail.render(rcFor(fc));
    expect(detail.info.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['offer', 'card', 'ask', 'read', 'talks', 'patience']));
    expect(detail.info.rows.some((r) => r.id === 'appeal')).toBe(false);
    detail.showSection('values');
    expect(detail.info.rows.filter((r) => r.id.startsWith('w:'))).toHaveLength(7);
    expect(detail.info.rows.filter((r) => r.id.startsWith('a:'))).toHaveLength(7);
    detail.showSection('overview');
    fc.tick(press('confirm'));
    expect(fc.stack.top).toBeInstanceOf(StepperDialog);
    (fc.stack.top as StepperDialog).cancel();
    fc.tick(press('back'));
    expect(fc.stack.size).toBe(0);
    expect(fc.pops()).toBe(1);
  });

  it('runs a round and finishes the market from the menu; large text keeps it readable', () => {
    const fc = contextFor(generous(opened, 2).league, true);
    const screen = mount(fc, new FreeAgencyScreen(fc));
    expect(screen.pool.columns.map((c) => c.key)).toEqual(['name', 'pos', 'ovr', 'ask']);
    const offered = screen.pool.rows.find((r) => r.offer === 'pending');
    if (!offered) throw new Error('no offered row');
    expect(screen.pool.toneOf(offered)).toBe('info');
    const body = screen.frameLayout?.body;
    for (const c of screen.chips) expect(c.rect.x + c.rect.w).toBeLessThanOrEqual((body?.x ?? 0) + (body?.w ?? 0));
    screen.runAction('round');
    expect(fc.commits.at(-1)?.reason).toBe('signing');
    expect(fc.toasts.at(-1)).toContain('Round 1');
    screen.runAction('finish');
    (fc.stack.top as ConfirmDialog).choose(true);
    expect(fc.commits.at(-1)?.reason).toBe('phaseChange');
    expect(screen.marketStatus.finished).toBe(true);
    expect(screen.actions().find((a) => a.id === 'round')?.disabledReason).toBe('market closed');
    screen.showSection('signings');
    screen.render(rcFor(fc));
    expect(screen.signings.rows.length).toBeGreaterThan(0);
  });
});
