import { describe, expect, it } from 'vitest';
import {
  FAN_DATA, applyFanEvent, applyGamesToFans, attendancePct, decayAllFans, fanBaseline, gameFanEvents, seasonFanReset, updateFans, weeklyFanDecay,
} from '@/franchise/fans';
import { MARKET_DEFAULTS } from '@/teams/generator';
import type { FanBase, Team } from '@/teams/types';
import { clubLeague, divisionPair, finishedGame, patchStanding } from './helpers';

const fans = (support: number, excitement: number): FanBase => ({ support, excitement, attendancePct: 0.9 });
const club = (market: Team['marketSize'], f: FanBase = fans(50, 50)): Pick<Team, 'fans' | 'marketSize' | 'championships' | 'history'> =>
  ({ fans: f, marketSize: market, championships: 0, history: [] });

describe('updateFans', () => {
  it('wins lift and losses lower support and excitement', () => {
    const win = updateFans(club('medium'), 'win');
    const loss = updateFans(club('medium'), 'loss');
    expect(win.support).toBeGreaterThan(50);
    expect(win.excitement).toBeGreaterThan(50);
    expect(loss.support).toBeLessThan(50);
    expect(loss.excitement).toBeLessThan(50);
  });

  it('a championship is the biggest boost; a star trade hurts', () => {
    const title = updateFans(club('medium'), 'championship');
    const playoffs = updateFans(club('medium'), 'playoffs');
    const star = updateFans(club('medium'), 'starTraded');
    expect(title.support - 50).toBeGreaterThan(playoffs.support - 50);
    expect(title.excitement).toBeGreaterThan(70);
    expect(star.support).toBeLessThan(50);
    expect(star.excitement).toBeLessThan(45);
  });

  it('big markets are damped and small markets swing more', () => {
    const small = updateFans(club('small'), 'championship');
    const large = updateFans(club('large'), 'championship');
    expect(small.support - 50).toBeGreaterThan(large.support - 50);
    const smallTrade = updateFans(club('small'), 'starTraded');
    const largeTrade = updateFans(club('large'), 'starTraded');
    expect(50 - smallTrade.support).toBeGreaterThan(50 - largeTrade.support);
    expect(FAN_DATA.damping.large).toBeLessThan(FAN_DATA.damping.small);
  });

  it('magnitude scales the effect, headroom slows gains near the top, values stay in 0..100', () => {
    const one = updateFans(club('medium'), 'ticketHike', 1);
    const three = updateFans(club('medium'), 'ticketHike', 3);
    expect(50 - three.support).toBeCloseTo((50 - one.support) * 3, 0);
    const nearTop = updateFans(club('medium', fans(95, 95)), 'championship');
    expect(nearTop.support).toBeLessThanOrEqual(100);
    expect(nearTop.support - 95).toBeLessThan(12);
    const floor = updateFans(club('small', fans(1, 1)), 'starTraded', 5);
    expect(floor.support).toBeGreaterThanOrEqual(0);
    expect(updateFans(club('medium'), 'win', Number.NaN).support).toBe(50);
  });
});

describe('drift and season reset', () => {
  it('support drifts toward the market baseline and excitement toward neutral', () => {
    const t = club('medium', fans(90, 90));
    const base = fanBaseline(t);
    expect(base).toBe(MARKET_DEFAULTS.medium.support);
    const next = weeklyFanDecay(t);
    expect(next.support).toBeLessThan(90);
    expect(next.support).toBeGreaterThan(base);
    expect(next.excitement).toBeLessThan(90);
    const low = weeklyFanDecay(club('medium', fans(20, 10)));
    expect(low.support).toBeGreaterThan(20);
    expect(low.excitement).toBeGreaterThan(10);
  });

  it('titles and winning seasons raise the baseline', () => {
    const plain = fanBaseline(club('small'));
    const decorated = fanBaseline({ ...club('small'), championships: 3, history: [1, 2, 3].map((i) => ({ year: 2020 + i, wins: 13, losses: 4, ties: 0, madePlayoffs: true, playoffResult: null, champion: false })) });
    expect(decorated).toBeGreaterThan(plain + 8);
  });

  it('excitement resets from last season: winners and champions start hyped, losers flat', () => {
    const champ = seasonFanReset({ fans: fans(60, 30) }, { wins: 14, losses: 3, ties: 0, madePlayoffs: true, champion: true });
    const loser = seasonFanReset({ fans: fans(60, 80) }, { wins: 3, losses: 14, ties: 0, madePlayoffs: false, champion: false });
    const none = seasonFanReset({ fans: fans(50, 90) }, null);
    expect(champ.excitement).toBeGreaterThan(80);
    expect(loser.excitement).toBeLessThan(40);
    expect(none.excitement).toBe(FAN_DATA.excitementBaseline);
    expect(champ.support).toBe(60);
  });
});

describe('attendance model', () => {
  it('falls with price and rises with support and excitement, capped at a sell-out', () => {
    const base = { fans: fans(55, 50), ticketPrice: 85, referencePrice: 85 };
    expect(attendancePct({ ...base, ticketPrice: 120 })).toBeLessThan(attendancePct(base));
    expect(attendancePct({ ...base, fans: fans(85, 80) })).toBeGreaterThan(attendancePct(base));
    expect(attendancePct({ ...base, ticketPrice: 20 })).toBe(1);
    expect(attendancePct({ ...base, ticketPrice: 5000 })).toBeGreaterThan(0);
    expect(attendancePct({ ...base, isPlayoff: true })).toBeGreaterThan(attendancePct(base));
    expect(attendancePct({ ...base, rivalryBoost: 0.08 })).toBeGreaterThan(attendancePct(base));
    expect(attendancePct({ ...base, isPreseason: true })).toBeLessThan(attendancePct(base));
  });
});

describe('league helpers', () => {
  const league = clubLeague();
  const { a, b, far } = divisionPair(league);

  it('rivalry results count more than ordinary ones', () => {
    const rivalry = gameFanEvents(league, finishedGame(a.id, b.id, 24, 10));
    const ordinary = gameFanEvents(league, finishedGame(a.id, far.id, 24, 10));
    expect(rivalry.map((e) => e.event)).toEqual(['rivalryWin', 'rivalryLoss']);
    expect(ordinary.map((e) => e.event)).toEqual(['win', 'loss']);
    const afterRivalry = applyGamesToFans(league, [finishedGame(a.id, b.id, 24, 10)]);
    const afterOrdinary = applyGamesToFans(league, [finishedGame(a.id, far.id, 24, 10)]);
    expect((afterRivalry.teams[a.id]?.fans.support ?? 0)).toBeGreaterThan(afterOrdinary.teams[a.id]?.fans.support ?? 0);
  });

  it('losing streaks and titles show up; preseason and ties do not', () => {
    const skid = patchStanding(league, far.id, { wins: 1, losses: 4, streak: -4 });
    expect(gameFanEvents(skid, finishedGame(a.id, far.id, 30, 3)).map((e) => e.event)).toContain('losingStreak');
    const rounds = league.settings.playoff.roundNames.length;
    const final = finishedGame(a.id, far.id, 20, 17, { isPlayoff: true, playoffRound: rounds, week: rounds });
    expect(gameFanEvents(league, final).filter((e) => e.teamId === a.id).map((e) => e.event)).toContain('championship');
    expect(gameFanEvents(league, finishedGame(a.id, b.id, 20, 17, { isPreseason: true }))).toEqual([]);
    expect(gameFanEvents(league, finishedGame(a.id, b.id, 17, 17))).toEqual([]);
  });

  it('applyFanEvent and decayAllFans return new leagues without touching the input', () => {
    const before = league.teams[a.id]?.fans;
    const hyped = applyFanEvent(league, a.id, 'bigSigning', 2);
    expect(hyped.teams[a.id]?.fans.excitement).toBeGreaterThan(before?.excitement ?? 0);
    expect(league.teams[a.id]?.fans).toBe(before);
    const decayed = decayAllFans(hyped);
    expect(decayed.teams[a.id]?.fans.excitement).toBeLessThan(hyped.teams[a.id]?.fans.excitement ?? 0);
    expect(applyFanEvent(league, 'nope' as Team['id'], 'win')).toBe(league);
  });
});
