import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { byeWeeksOf, circleRounds, divisionKey, gamesInWeek, generateSchedule, regularSeasonGames, validateSchedule } from '@/franchise/schedule';
import { defaultLeagueSettings, scheduleWeekCount } from '@/franchise/settings';
import type { ScheduledGame } from '@/franchise/types';
import type { Team } from '@/teams/types';
import { makeLeague } from './helpers';

const league = makeLeague(7);
const teams = league.teams;
const settings = league.settings;
const schedule = generateSchedule(createRng(99), teams, settings, 2026);
const regular = regularSeasonGames(schedule);
const gamesOf = (id: TeamId, games: readonly ScheduledGame[] = regular): ScheduledGame[] => games.filter((g) => g.home === id || g.away === id);
const opponent = (g: ScheduledGame, id: TeamId): TeamId => (g.home === id ? g.away : g.home);

describe('generateSchedule (32 teams, standard structure)', () => {
  it('is valid', () => {
    expect(validateSchedule(schedule, teams, settings)).toEqual([]);
    expect(regular).toHaveLength(272);
    expect(new Set(schedule.map((g) => g.id)).size).toBe(schedule.length);
  });

  it('gives every team 17 games: 6 division, 13 in-conference, 4 vs one other-conference division', () => {
    for (const t of Object.values(teams)) {
      const mine = gamesOf(t.id);
      expect(mine).toHaveLength(17);
      const opps = mine.map((g) => teams[opponent(g, t.id)] as Team);
      expect(opps.filter((o) => divisionKey(o) === divisionKey(t))).toHaveLength(6);
      expect(opps.filter((o) => o.conference === t.conference)).toHaveLength(13);
      const cross = opps.filter((o) => o.conference !== t.conference);
      expect(cross).toHaveLength(4);
      expect(new Set(cross.map(divisionKey)).size).toBe(1);
      const inConfOther = opps.filter((o) => o.conference === t.conference && divisionKey(o) !== divisionKey(t));
      expect(inConfOther).toHaveLength(7);
      expect(new Set(opps.filter((o) => divisionKey(o) !== divisionKey(t)).map((o) => o.id)).size).toBe(11);
    }
  });

  it('plays each division rival once at home and once away', () => {
    for (const t of Object.values(teams)) {
      for (const r of Object.values(teams).filter((o) => o.id !== t.id && divisionKey(o) === divisionKey(t))) {
        expect(regular.filter((g) => g.home === t.id && g.away === r.id)).toHaveLength(1);
        expect(regular.filter((g) => g.home === r.id && g.away === t.id)).toHaveLength(1);
      }
    }
  });

  it('balances home and away 8/9', () => {
    for (const t of Object.values(teams)) {
      const home = regular.filter((g) => g.home === t.id).length;
      expect([8, 9]).toContain(home);
    }
  });

  it('spreads exactly one bye per team over weeks 5-14 with 18 calendar weeks', () => {
    expect(scheduleWeekCount(settings)).toBe(18);
    expect(Math.max(...regular.map((g) => g.week))).toBe(18);
    const byeCount = new Map<number, number>();
    for (const t of Object.values(teams)) {
      const byes = byeWeeksOf(schedule, t.id, settings);
      expect(byes).toHaveLength(1);
      const w = byes[0] as number;
      expect(w).toBeGreaterThanOrEqual(5);
      expect(w).toBeLessThanOrEqual(14);
      byeCount.set(w, (byeCount.get(w) ?? 0) + 1);
    }
    expect(Math.max(...byeCount.values())).toBeLessThanOrEqual(6);
    expect(byeCount.size).toBeGreaterThanOrEqual(6);
  });

  it('never schedules a team twice in one week and never repeats an opponent in consecutive weeks', () => {
    for (let w = 1; w <= 18; w++) {
      const week = gamesInWeek(schedule, 'regularSeason', w);
      const ids = week.flatMap((g) => [g.home, g.away]);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const t of Object.values(teams)) {
      const byWeek = new Map(gamesOf(t.id).map((g) => [g.week, opponent(g, t.id)]));
      for (let w = 2; w <= 18; w++) if (byWeek.has(w) && byWeek.has(w - 1)) expect(byWeek.get(w)).not.toBe(byWeek.get(w - 1));
    }
  });

  it('adds preseason weeks where every team plays once per week', () => {
    for (let w = 1; w <= settings.preseasonWeeks; w++) {
      const week = gamesInWeek(schedule, 'preseason', w);
      expect(week).toHaveLength(16);
      expect(week.every((g) => g.isPreseason && !g.isPlayoff && g.result === null)).toBe(true);
      expect(new Set(week.flatMap((g) => [g.home, g.away])).size).toBe(32);
    }
    expect(schedule.filter((g) => g.isPreseason)).toHaveLength(48);
  });

  it('is deterministic and varies by seed and year', () => {
    expect(generateSchedule(createRng(99), teams, settings, 2026)).toEqual(schedule);
    expect(generateSchedule(createRng(100), teams, settings, 2026)).not.toEqual(schedule);
    const next = regularSeasonGames(generateSchedule(createRng(99), teams, settings, 2027));
    expect(validateSchedule(next, teams, settings)).toEqual([]);
    const t = Object.values(teams)[0] as Team;
    const crossDivs = (games: readonly ScheduledGame[]): string[] =>
      [...new Set(gamesOf(t.id, games).map((g) => teams[opponent(g, t.id)] as Team).filter((o) => o.conference !== t.conference).map(divisionKey))];
    expect(crossDivs(next)).not.toEqual(crossDivs(regular));
  });

  it('uses last season division ranks for same-place games and stays valid', () => {
    const rank: Record<TeamId, number> = {};
    for (const t of Object.values(teams)) rank[t.id] = t.abbr.charCodeAt(0) % 4;
    const ranked = generateSchedule(createRng(5), teams, settings, 2028, { divisionRank: rank });
    expect(validateSchedule(ranked, teams, settings)).toEqual([]);
  });

  it('works without byes', () => {
    const noBye = { ...settings, byeWeeks: false };
    const s = generateSchedule(createRng(3), teams, noBye, 2026);
    expect(validateSchedule(s, teams, noBye)).toEqual([]);
    expect(Math.max(...regularSeasonGames(s).map((g) => g.week))).toBe(17);
  });
});

describe('generic structures', () => {
  it('schedules a one-conference, eight-team league with byes and a 10-game season', () => {
    const conf = Object.values(teams).filter((t) => t.conference === 'Liberty');
    const divs = [...new Set(conf.map((t) => t.division))].sort().slice(0, 2);
    const eight = Object.fromEntries(conf.filter((t) => divs.includes(t.division)).map((t) => [t.id, t])) as Record<TeamId, Team>;
    const small = defaultLeagueSettings({
      teamCount: 8, conferences: ['Liberty'], divisionsPerConference: 2, regularSeasonWeeks: 10, preseasonWeeks: 1,
      playoff: { teamsPerConference: 4, byesPerConference: 0, roundNames: ['Semifinal', 'Final'] }, tradeDeadlineWeek: 5,
    });
    const s = generateSchedule(createRng(1), eight, small, 2026);
    expect(validateSchedule(s, eight, small)).toEqual([]);
    for (const t of Object.values(eight)) expect(gamesOf(t.id, regularSeasonGames(s))).toHaveLength(10);
  });

  it('schedules two teams meeting home and away', () => {
    const two = Object.fromEntries(Object.values(teams).slice(0, 2).map((t) => [t.id, t])) as Record<TeamId, Team>;
    const tiny = { ...settings, teamCount: 2, regularSeasonWeeks: 2, byeWeeks: false, preseasonWeeks: 0 };
    const s = generateSchedule(createRng(1), two, tiny, 2026);
    expect(s).toHaveLength(2);
    expect(new Set(s.map((g) => g.home)).size).toBe(2);
  });

  it('rejects odd or mismatched team counts', () => {
    const three = Object.fromEntries(Object.values(teams).slice(0, 3).map((t) => [t.id, t])) as Record<TeamId, Team>;
    expect(() => generateSchedule(createRng(1), three, { ...settings, teamCount: 3 }, 2026)).toThrow(/even/);
    expect(() => generateSchedule(createRng(1), three, settings, 2026)).toThrow(/teamCount/);
  });

  it('circleRounds pairs everyone exactly once per cycle', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `t${i}` as TeamId);
    const rounds = circleRounds(ids, 5);
    const pairs = new Set<string>();
    for (const r of rounds) {
      expect(new Set(r.flatMap((f) => [f.home, f.away])).size).toBe(6);
      for (const f of r) pairs.add([f.home, f.away].sort().join('|'));
    }
    expect(pairs.size).toBe(15);
  });
});

describe('validateSchedule', () => {
  it('reports duplicates, double bookings and count problems', () => {
    const [g0, g1] = regular as [ScheduledGame, ScheduledGame];
    const broken = [...schedule, { ...g0, id: g1.id }, { ...g0, id: 'g_extra' as ScheduledGame['id'] }];
    const issues = validateSchedule(broken, teams, settings);
    expect(issues.some((i) => i.includes('duplicate game id'))).toBe(true);
    expect(issues.some((i) => i.includes('plays twice'))).toBe(true);
    expect(issues.some((i) => i.includes('expected 17'))).toBe(true);
    expect(validateSchedule(schedule.filter((g) => g !== g0), teams, settings).some((i) => i.includes('games, expected'))).toBe(true);
  });
});
