import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { GameId, TeamId } from '@/core/ids';
import { emptyGameStats } from '@/statistics/empty';
import { clearWeather } from '@/game/weather';
import type { League, ScheduledGame } from '@/franchise/types';
import {
  applyPickNumbers, currentOwner, draftOrder, indexPicks, pickId, playoffExitRound, removePick, rollPickWindow,
  strengthOfSchedule, teamDraftOrder, winPct,
} from '@/franchise/draft-order';
import { YEAR, emptyStanding, makeLeague, teamIds, withPlayoffs, withRecords } from './helpers';

const base = makeLeague(21);

const tradePick = (league: League, id: string, to: TeamId): League => {
  const from = currentOwner(league.teams, { id, ownerTeamId: to });
  const pick = league.teams[from]!.picks.find((p) => p.id === id)!;
  return {
    ...league,
    teams: {
      ...league.teams,
      [from]: { ...league.teams[from]!, picks: league.teams[from]!.picks.filter((p) => p.id !== id) },
      [to]: { ...league.teams[to]!, picks: [...league.teams[to]!.picks, { ...pick, ownerTeamId: to }] },
    },
  };
};

describe('record helpers', () => {
  it('winPct counts ties as halves and defaults to .500', () => {
    expect(winPct(undefined)).toBe(0.5);
    expect(winPct({ wins: 0, losses: 0, ties: 0 })).toBe(0.5);
    expect(winPct({ wins: 10, losses: 6, ties: 1 })).toBeCloseTo(10.5 / 17);
  });

  it('strength of schedule averages the opponents faced', () => {
    const [a, b, c] = teamIds(base) as [TeamId, TeamId, TeamId];
    const game = (id: string, home: TeamId, away: TeamId, played: boolean): ScheduledGame => ({
      id: id as GameId, week: 1, home, away, isPlayoff: false, playoffRound: null, isPreseason: false,
      result: played ? { homeScore: 21, awayScore: 14, overtime: false, stats: emptyGameStats(), weather: clearWeather(), injuries: [], playLogId: null } : null,
    });
    const standings = { [b]: { ...emptyStanding(b), wins: 12, losses: 5 }, [c]: { ...emptyStanding(c), wins: 3, losses: 14 } };
    const season = { schedule: [game('g1', a, b, true), game('g2', c, a, true), game('g3', a, c, false)], standings };
    expect(strengthOfSchedule(season, a)).toBeCloseTo((12 / 17 + 3 / 17) / 2);
    expect(strengthOfSchedule({ schedule: [], standings: {} }, a)).toBe(0.5);
  });
});

describe('draft order', () => {
  it('covers every pick of every round with overall numbers 1..224 and a fixed team order', () => {
    const order = draftOrder(base, YEAR);
    expect(order).toHaveLength(224);
    expect(order.map((p) => p.overall)).toEqual(order.map((_, i) => i + 1));
    const round1 = order.filter((p) => p.round === 1).map((p) => p.originalTeamId);
    for (let r = 2; r <= 7; r++) expect(order.filter((p) => p.round === r).map((p) => p.originalTeamId)).toEqual(round1);
    expect(new Set(round1).size).toBe(32);
    expect(draftOrder(base, YEAR)).toEqual(order);
  });

  it('puts the worst record first and orders non-playoff teams by record', () => {
    const league = withRecords(base, createRng(3));
    const order = draftOrder(league, YEAR).filter((p) => p.round === 1);
    const wins = order.map((p) => league.season.standings[p.originalTeamId]!.wins);
    expect(wins[0]).toBe(Math.min(...wins));
    for (let i = 1; i < wins.length; i++) expect(wins[i]!).toBeGreaterThanOrEqual(wins[i - 1]!);
  });

  it('puts playoff teams after non-playoff teams by exit round, runner-up 31st and champion last', () => {
    const { league, champion, runnerUp, qualifiers } = withPlayoffs(withRecords(base, createRng(3)));
    const order = teamDraftOrder(league);
    expect(order[31]).toBe(champion);
    expect(order[30]).toBe(runnerUp);
    const firstPlayoffIndex = order.findIndex((t) => qualifiers.includes(t));
    expect(firstPlayoffIndex).toBe(32 - qualifiers.length);
    const exits = order.slice(firstPlayoffIndex).map((t) => playoffExitRound(league.season.bracket, t));
    for (let i = 1; i < exits.length; i++) expect(exits[i]!).toBeGreaterThanOrEqual(exits[i - 1]!);
    expect(exits[0]).toBe(1);
    const allPicks = draftOrder(league, YEAR);
    const lastEach = [1, 2, 3, 4, 5, 6, 7].map((r) => allPicks.filter((p) => p.round === r).at(-1)!.originalTeamId);
    expect(new Set(lastEach)).toEqual(new Set([champion]));
  });

  it('breaks record ties by the weaker strength of schedule', () => {
    const [a, b, c, d] = teamIds(base) as [TeamId, TeamId, TeamId, TeamId];
    const standings = { ...base.season.standings };
    for (const id of teamIds(base)) standings[id] = { ...emptyStanding(id), wins: 10, losses: 7 };
    standings[a] = { ...emptyStanding(a), wins: 5, losses: 12 };
    standings[b] = { ...emptyStanding(b), wins: 5, losses: 12 };
    standings[c] = { ...emptyStanding(c), wins: 16, losses: 1 };
    standings[d] = { ...emptyStanding(d), wins: 1, losses: 16 };
    const g = (id: string, home: TeamId, away: TeamId): ScheduledGame => ({
      id: id as GameId, week: 1, home, away, isPlayoff: false, playoffRound: null, isPreseason: false,
      result: { homeScore: 10, awayScore: 7, overtime: false, stats: emptyGameStats(), weather: clearWeather(), injuries: [], playLogId: null },
    });
    const league = { ...base, season: { ...base.season, standings, schedule: [g('g1', a, c), g('g2', b, d)] } };
    const order = teamDraftOrder(league);
    // d (1-16) is worst; a and b tie at 5-12 and b faced the weaker schedule (d vs c), so b picks before a.
    expect(order.slice(0, 3)).toEqual([d, b, a]);
  });

  it('keeps a traded pick in its original slot under its new owner', () => {
    const league = withRecords(base, createRng(3));
    const worst = teamDraftOrder(league)[0]!;
    const best = teamDraftOrder(league)[31]!;
    const traded = tradePick(league, pickId(YEAR, 1, worst), best);
    const order = draftOrder(traded, YEAR);
    expect(order[0]!.originalTeamId).toBe(worst);
    expect(order[0]!.ownerTeamId).toBe(best);
    expect(order[0]!.overall).toBe(1);
    expect(order.filter((p) => p.round === 1 && p.ownerTeamId === best)).toHaveLength(2);
    expect(order.filter((p) => p.round === 1 && p.ownerTeamId === worst)).toHaveLength(0);
    expect(currentOwner(traded.teams, order[0]!)).toBe(best);
  });

  it('skips picks nobody holds', () => {
    const [a] = teamIds(base) as [TeamId];
    const forfeited = { ...base, teams: removePick(base.teams, pickId(YEAR, 2, a)) };
    const order = draftOrder(forfeited, YEAR);
    expect(order).toHaveLength(223);
    expect(order.some((p) => p.id === pickId(YEAR, 2, a))).toBe(false);
    expect(order.map((p) => p.overall)).toEqual(order.map((_, i) => i + 1));
  });
});

describe('playoff exits', () => {
  it('reports null for non-qualifiers, the losing round for others, rounds+1 for the champion', () => {
    const { league, champion, qualifiers } = withPlayoffs(withRecords(base, createRng(3)));
    const out = teamIds(league).find((t) => !qualifiers.includes(t))!;
    expect(playoffExitRound(league.season.bracket, out)).toBeNull();
    expect(playoffExitRound(league.season.bracket, champion)).toBe(5);
    expect(playoffExitRound(league.season.bracket, qualifiers[13]!)).toBe(1);
    expect(playoffExitRound(null, champion, champion)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('pick bookkeeping', () => {
  it('applyPickNumbers writes overall numbers onto the canonical Team.picks', () => {
    const order = draftOrder(base, YEAR);
    const teams = applyPickNumbers(base.teams, order);
    const idx = indexPicks(teams);
    for (const p of order) expect(idx.get(p.id)!.pick.overall).toBe(p.overall);
    const future = Object.values(teams).flatMap((t) => t.picks).filter((p) => p.year > YEAR);
    for (const p of future) expect(p.overall).toBeNull();
  });

  it('rollPickWindow drops used years, adds the next window once, and respects traded future picks', () => {
    const [a, b] = teamIds(base) as [TeamId, TeamId];
    const traded = tradePick(base, pickId(YEAR + 1, 1, a), b);
    const rolled = rollPickWindow(traded.teams, YEAR, 3, 7);
    const all = Object.values(rolled).flatMap((t) => t.picks);
    expect(all.some((p) => p.year <= YEAR)).toBe(false);
    expect(new Set(all.map((p) => p.year))).toEqual(new Set([YEAR + 1, YEAR + 2, YEAR + 3]));
    expect(all).toHaveLength(32 * 7 * 3);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    expect(rolled[b]!.picks.some((p) => p.id === pickId(YEAR + 1, 1, a))).toBe(true);
    expect(rolled[a]!.picks.some((p) => p.id === pickId(YEAR + 1, 1, a))).toBe(false);
    expect(rollPickWindow(rolled, YEAR, 3, 7)).toEqual(rolled);
  });
});
