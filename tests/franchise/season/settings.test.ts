import { describe, expect, it } from 'vitest';
import {
  SEASON_CONFIG, assertValidSettings, conferenceRoundCount, defaultLeagueSettings, leagueRuleset, playoffRoundCount, projectedCap,
  requiredByes, scheduleWeekCount, teamsPerDivision, validateSettings,
} from '@/franchise/settings';
import { getRuleset } from '@/game/rulesets';

describe('defaultLeagueSettings', () => {
  const s = defaultLeagueSettings();
  it('matches the documented defaults', () => {
    expect(s.teamCount).toBe(32);
    expect(s.regularSeasonWeeks).toBe(17);
    expect(s.byeWeeks).toBe(true);
    expect(s.preseasonWeeks).toBe(3);
    expect(s.playoff).toEqual({ teamsPerConference: 7, byesPerConference: 1, roundNames: ['Wild Card', 'Divisional', 'Conference Championship', 'Championship'] });
    expect(s.salaryCap).toBe(225_000_000);
    expect(s.capGrowthRate).toBe(0.05);
    expect(s.minimumSalary).toBeGreaterThan(0);
    expect([s.rosterSize, s.activeRosterSize, s.draftRounds, s.tradeDeadlineWeek]).toEqual([53, 46, 7, 9]);
    expect(s.ruleset.id).toBe('simulation');
    expect(s.difficulty.id).toBe('pro');
    expect([s.injuriesEnabled, s.fatigueEnabled, s.weatherEnabled]).toEqual([true, true, true]);
    expect(s.conferences).toEqual(['Liberty', 'Frontier']);
    expect(s.divisionsPerConference).toBe(4);
    expect(validateSettings(s)).toEqual([]);
  });

  it('copies the injury/fatigue toggles into the ruleset', () => {
    const off = defaultLeagueSettings({ injuriesEnabled: false, fatigueEnabled: false });
    expect(off.ruleset.injuries).toBe(false);
    expect(off.ruleset.fatigue).toBe(false);
    expect(validateSettings(off)).toEqual([]);
    expect(leagueRuleset({ ...s, injuriesEnabled: false }).injuries).toBe(false);
  });

  it('merges overrides without letting undefined erase defaults', () => {
    const o = defaultLeagueSettings({ salaryCap: undefined, preseasonWeeks: 0, playoff: { roundNames: ['A', 'B', 'C', 'D'] }, rulesetId: 'arcade', difficultyId: 'legend' });
    expect(o.salaryCap).toBe(225_000_000);
    expect(o.preseasonWeeks).toBe(0);
    expect(o.playoff).toEqual({ teamsPerConference: 7, byesPerConference: 1, roundNames: ['A', 'B', 'C', 'D'] });
    expect(o.ruleset.id).toBe('arcade');
    expect(o.ruleset.injuries).toBe(true);
    expect(o.difficulty.id).toBe('legend');
  });

  it('returns independent copies', () => {
    const a = defaultLeagueSettings();
    a.playoff.roundNames.push('x');
    a.conferences.push('y');
    expect(defaultLeagueSettings().playoff.roundNames).toHaveLength(4);
    expect(defaultLeagueSettings().conferences).toHaveLength(2);
  });
});

describe('derived quantities', () => {
  it('computes schedule weeks, rounds and byes', () => {
    const s = defaultLeagueSettings();
    expect(scheduleWeekCount(s)).toBe(18);
    expect(scheduleWeekCount({ ...s, byeWeeks: false })).toBe(17);
    expect([1, 2, 4, 6, 7, 8, 12].map(conferenceRoundCount)).toEqual([0, 1, 2, 3, 3, 3, 4]);
    expect([1, 2, 4, 5, 6, 7, 12].map(requiredByes)).toEqual([0, 0, 0, 3, 2, 1, 4]);
    expect(playoffRoundCount(s)).toBe(4);
    expect(playoffRoundCount({ ...s, conferences: ['One'] })).toBe(3);
    expect(teamsPerDivision(s)).toBe(4);
    expect(projectedCap(s, 0)).toBe(225_000_000);
    expect(projectedCap(s, 2)).toBe(Math.round(225_000_000 * 1.05 ** 2));
  });

  it('exposes the season config from the data file', () => {
    expect(SEASON_CONFIG.byeWindow).toEqual([5, 14]);
    expect(SEASON_CONFIG.freeAgentPoolSize).toBe(120);
  });
});

describe('validateSettings', () => {
  const s = defaultLeagueSettings();
  const issuesFor = (patch: Partial<typeof s>): string[] => validateSettings({ ...s, ...patch });

  it('rejects impossible structures', () => {
    expect(issuesFor({ teamCount: 31 }).join()).toMatch(/even/);
    expect(issuesFor({ teamCount: 30 }).join()).toMatch(/split evenly/);
    expect(issuesFor({ conferences: ['A', 'B', 'C'] }).join()).toMatch(/one or two conferences/);
    expect(issuesFor({ conferences: ['A', 'A'] }).join()).toMatch(/unique/);
    expect(issuesFor({ regularSeasonWeeks: 0 }).join()).toMatch(/regularSeasonWeeks/);
  });

  it('rejects playoff formats a bracket cannot realise', () => {
    expect(issuesFor({ playoff: { ...s.playoff, byesPerConference: 0 } }).join()).toMatch(/byesPerConference must be 1/);
    expect(issuesFor({ playoff: { ...s.playoff, roundNames: ['Only'] } }).join()).toMatch(/exactly 4 round/);
    expect(issuesFor({ playoff: { teamsPerConference: 6, byesPerConference: 2, roundNames: ['a', 'b', 'c', 'd'] } })).toEqual([]);
    expect(issuesFor({ playoff: { teamsPerConference: 17, byesPerConference: 15, roundNames: ['a', 'b', 'c', 'd', 'e', 'f'] } }).join()).toMatch(/teamsPerConference/);
  });

  it('rejects money, roster and toggle problems', () => {
    expect(issuesFor({ salaryCap: 0 }).join()).toMatch(/salaryCap/);
    expect(issuesFor({ minimumSalary: 300_000_000 }).join()).toMatch(/minimumSalary/);
    expect(issuesFor({ activeRosterSize: 60 }).join()).toMatch(/roster sizes/);
    expect(issuesFor({ tradeDeadlineWeek: 40 }).join()).toMatch(/tradeDeadlineWeek/);
    expect(issuesFor({ ruleset: { ...getRuleset('simulation'), injuries: false } }).join()).toMatch(/mirror/);
  });

  it('assertValidSettings throws with every issue listed', () => {
    expect(() => assertValidSettings({ ...s, teamCount: 3, salaryCap: -1 })).toThrow(/teamCount[\s\S]*salaryCap/);
    expect(assertValidSettings(s)).toBe(s);
  });
});
