/**
 * Regression tests from the club-layer review: once-per-week club advance, the yearly flag reset, coach aging
 * exactly once per offseason whichever carousel runs, the owner covering event payments, ticket-price effects
 * within the allowed range, preseason injury morale, stale progression news and coach contract years around the
 * offseason turnover.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { applyEventEffects } from '@/franchise/events-catalog';
import { advanceClubWeek, closeClubSeason, generateEvents } from '@/franchise/events';
import { economyScale } from '@/franchise/facilities';
import { ticketPriceRange } from '@/franchise/fans';
import { weeklyMorale } from '@/franchise/morale';
import { runOffseasonPhase } from '@/franchise/offseason';
import { runCoachCarousel } from '@/franchise/retirement';
import { advanceStaffYear, fireCoach, hireCoach, availableCoaches, coachMarket, teamStaff, turnoverPending } from '@/franchise/staff';
import type { FranchiseEvent, League } from '@/franchise/types';
import { advanceWeekDetailed } from '@/franchise/week';
import type { Coach } from '@/teams/types';
import { aiTeam, atDepth, clubLeague, finishedGame, patchPlayer, patchTeam, userTeamOf, withPhase } from './helpers';

const base = clubLeague(33);
const team = userTeamOf(base);
const other = aiTeam(base, 0);

const withCash = (l: League, cash: number): League => patchTeam(l, team.id, (t) => ({ ...t, finances: { ...t.finances, cash } }));
const event = (type: FranchiseEvent['type'], playerId: PlayerId | null = null): FranchiseEvent => ({
  id: `ev_test_${type}`, year: base.season.year, week: 1, type, teamId: team.id, playerId, coachId: null, title: 't', description: 'd',
  choices: [], resolvedChoice: null, read: false, data: {},
});
const coachAges = (l: League): Map<string, number> => new Map(Object.values(l.coaches).map((c) => [c.id, c.age]));

describe('advanceClubWeek runs once per week', () => {
  it('a repeated call for the same week (no new games) changes nothing', () => {
    const { phase, week } = base.season;
    const r = advanceWeekDetailed(base);
    const once = advanceClubWeek(r.league, { games: r.games, phase, week, rng: createRng(1) });
    const twice = advanceClubWeek(once.league, { games: r.games, phase, week, rng: createRng(1) });
    expect(twice.league).toBe(once.league);
    expect(twice.events).toEqual([]);
  });

  it('the game-less preseason transition week of week.ts is not a club week', () => {
    const l = withPhase(base, 'preseason', base.settings.preseasonWeeks + 1);
    expect(advanceClubWeek(l, { games: [], phase: 'preseason', week: base.settings.preseasonWeeks + 1, rng: createRng(2) }).league).toBe(l);
  });
});

describe('closeClubSeason', () => {
  const offseason = withPhase(base, 'offseason', 0);
  const [p1, p2] = team.rosterIds as [PlayerId, PlayerId];

  it('clears the seasonal event flags, keeps retirement announcements and drops departed players', () => {
    const flagged: League = { ...offseason, club: { rivalries: {}, staffDeadMoney: {}, facilityUpgrades: {}, ownerSubsidy: {},
      playerFlags: { [p1]: ['disgruntled', 'retiring'], [p2]: ['holdout', 'extensionTalks', 'tradeBlock', 'targetsPromised'], ghost_player: ['retiring'] } } };
    const closed = closeClubSeason(flagged, createRng(3)).league;
    expect(closed.club?.playerFlags).toEqual({ [p1]: ['retiring'] });
  });

  it('ages coaches once whichever carousel runs, in either order', () => {
    const before = coachAges(offseason);
    const kept = (l: League): Coach[] => Object.values(offseason.coaches).filter((c) => l.coaches[c.id] && !l.club?.retiredCoachIds?.includes(c.id));
    const check = (l: League): void => {
      const list = kept(l);
      expect(list.length).toBeGreaterThan(100);
      for (const c of list) expect(l.coaches[c.id]!.age).toBe(before.get(c.id)! + 1);
    };
    check(closeClubSeason(runCoachCarousel(offseason, createRng(4)).league, createRng(5)).league);
    check(runCoachCarousel(closeClubSeason(offseason, createRng(5)).league, createRng(4)).league);
    const viaOrchestrator = runOffseasonPhase(offseason, createRng(6), { coachCarousel: (l, rng) => runCoachCarousel(l, rng) }).league;
    check(viaOrchestrator);
    check(closeClubSeason(viaOrchestrator, createRng(7)).league);
    // The injected carousel still closes the club year.
    expect(viaOrchestrator.club?.financeHistory?.[team.id]?.some((r) => r.year === offseason.season.year)).toBe(true);
  });
});

describe('event effects', () => {
  it('a payment the club cannot afford is covered by the owner', () => {
    const qb = atDepth(base, team, 'QB', 0);
    const out = applyEventEffects(withCash(base, 0), event('playerSlump', qb.id), 'extraWork', createRng(1));
    expect(out.teams[team.id]!.finances.cash).toBeGreaterThanOrEqual(0);
    expect(out.club?.ownerSubsidy[team.id]).toBeGreaterThan(0);
  });

  it('a ticket discount never leaves the allowed price range', () => {
    const [lo] = ticketPriceRange(economyScale(base.settings));
    const cheap = patchTeam(base, team.id, (t) => ({ ...t, finances: { ...t.finances, ticketPrice: lo } }));
    const out = applyEventEffects(cheap, event('fanUnrest'), 'discount', createRng(1));
    expect(out.teams[team.id]!.finances.ticketPrice).toBe(lo);
  });
});

describe('morale', () => {
  it('a preseason injury hurts morale only in the week it happened', () => {
    const rb = atDepth(base, team, 'RB', 0);
    const l = patchPlayer(base, rb.id, { injury: { bodyArea: 'lowerBody', severity: 'moderate', weeksRemaining: 4, permanentPenalty: null, occurredYear: base.season.year, occurredWeek: 0 } });
    const g = finishedGame(team.id, other.id, 20, 17, { week: 2, isPreseason: true });
    const hurtNow = { ...g, result: { ...g.result!, injuries: [{ playerId: rb.id, severity: 'moderate' as const, quarter: 1, playIndex: 3 }] } };
    const thisWeek = weeklyMorale(l, team.id, 2, { phase: 'preseason', game: hurtNow }).players[rb.id]!.morale.morale;
    const laterWeek = weeklyMorale(l, team.id, 2, { phase: 'preseason', game: g }).players[rb.id]!.morale.morale;
    expect(thisWeek).toBeLessThan(laterWeek);
  });
});

describe('progression news', () => {
  it('last year\'s progression entry is not news in this year\'s offseason, but the latest one is in the preseason', () => {
    const rb = atDepth(base, team, 'RB', 1);
    const entry = (year: number) => ({ year, overallBefore: 60, overallAfter: 70, deltas: {}, kind: 'breakout' as const });
    const year = base.season.year;
    // Only this player on the roster, so no other news competes for the weekly slots.
    const alone = patchTeam(patchPlayer(base, rb.id, { experience: 1, progressionLog: [entry(year - 1)] }), team.id, { rosterIds: [rb.id] });
    const stale = withPhase(alone, 'offseason', 0);
    expect(generateEvents(stale, 0, createRng(1), { teamIds: [team.id] }).some((e) => e.type === 'rookieBreakout')).toBe(false);
    const fresh = withPhase(alone, 'preseason', 1);
    expect(generateEvents(fresh, 1, createRng(1), { teamIds: [team.id] }).some((e) => e.type === 'rookieBreakout' && e.playerId === rb.id)).toBe(true);
  });
});

describe('coach contracts around the offseason turnover', () => {
  const offseason = withPhase(base, 'offseason', 0);

  it('a hire before the turnover keeps its full length', () => {
    expect(turnoverPending(offseason)).toBe(true);
    const oc = teamStaff(offseason, team).OC!;
    const market = coachMarket(fireCoach(offseason, team.id, oc.id).league, createRng(8)).league;
    const candidate = availableCoaches(market, 'OC').find((c) => c.age < 55)!;
    const hired = hireCoach(market, team.id, candidate.id, { years: 3 });
    expect(hired.ok).toBe(true);
    const after = advanceStaffYear(hired.league, createRng(9)).league;
    expect(turnoverPending(after)).toBe(false);
    expect(after.coaches[candidate.id]).toMatchObject({ teamId: team.id, contractYears: 3 });
  });

  it('a firing before the turnover owes only the seasons after the finished one', () => {
    const oc = teamStaff(offseason, team).OC!;
    const year = offseason.season.year;
    const ending = fireCoach({ ...offseason, coaches: { ...offseason.coaches, [oc.id]: { ...oc, contractYears: 1, salary: 2_000_000 } } }, team.id, oc.id);
    expect(ending.deadMoney).toBe(0);
    const longer = fireCoach({ ...offseason, coaches: { ...offseason.coaches, [oc.id]: { ...oc, contractYears: 3, salary: 2_000_000 } } }, team.id, oc.id);
    const owed = longer.league.club?.staffDeadMoney[team.id] ?? {};
    expect(Object.keys(owed).map(Number).sort()).toEqual([year + 1, year + 2]);
    expect(longer.deadMoney).toBe(2_400_000);
  });
});
