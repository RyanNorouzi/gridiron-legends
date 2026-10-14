import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import type { Contract, Player } from '@/players/types';
import { DEVELOPMENT } from '@/players/development';
import { loadTeamData } from '@/teams/data';
import type { Team } from '@/teams/types';
import { ROSTER_SIZE, validateDepthChart } from '@/teams/depth-chart';
import { STAFF_ROLES } from '@/teams/coach-generator';
import {
  DEFAULT_CAP_USAGE, DEFAULT_PLAYBOOK_ID, MAX_CONTRACT_SCALE_UP, contractCapHit, contractRoleFor, draftContract,
  fitContractsToCap, generateLeagueEntities, rollContractYears, rosterCapHit, teamStrengths,
} from '@/teams/league-generator';
import type { GenerateLeagueOptions, LeagueEntities } from '@/teams/league-generator';
import { makePlayer, testNames } from '../players/helpers';

const CAP = 225_000_000;
const YEAR = 2030;
const baseOpts: GenerateLeagueOptions = { year: YEAR, salaryCap: CAP, userTeamAbbr: 'BOS', names: testNames };
const league: LeagueEntities = generateLeagueEntities(7, baseOpts);
const teams = Object.values(league.teams);
const rosterOf = (team: Team): Player[] => team.rosterIds.map((id) => league.players[id]!);
const templates = loadTeamData();

describe('generateLeagueEntities determinism', () => {
  it('reproduces the same league from the same seed and options', () => {
    expect(generateLeagueEntities(7, baseOpts)).toEqual(league);
  });
  it('produces a different league from a different seed', () => {
    const other = generateLeagueEntities(8, baseOpts);
    expect(Object.keys(other.teams)).not.toEqual(Object.keys(league.teams));
    expect(Object.keys(other.players)).not.toEqual(Object.keys(league.players));
  });
  it('accepts an Rng instance in place of a seed', () => {
    expect(generateLeagueEntities(createRng(7), baseOpts)).toEqual(league);
  });
});

describe('league structure', () => {
  it('creates 32 teams with 53 players each and every player attached to exactly one team', () => {
    expect(teams).toHaveLength(32);
    expect(Object.keys(league.players)).toHaveLength(32 * ROSTER_SIZE);
    const seen = new Set<PlayerId>();
    for (const team of teams) {
      expect(team.rosterIds).toHaveLength(ROSTER_SIZE);
      for (const id of team.rosterIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        const p = league.players[id];
        expect(p).toBeDefined();
        expect(p?.teamId).toBe(team.id);
        expect(p?.contract).not.toBeNull();
      }
    }
    expect(seen.size).toBe(Object.keys(league.players).length);
  });
  it('carries every template over: identity, colours, region, market and rivals in the same division', () => {
    for (const template of templates) {
      const team = teams.find((t) => t.abbr === template.abbr)!;
      expect(team).toBeDefined();
      expect(team).toMatchObject({
        city: template.city, name: template.name, conference: template.conference, division: template.division,
        colors: template.colors, logoSeed: template.logoSeed, region: template.region, marketSize: template.marketSize,
      });
      expect(team.rivalIds).toHaveLength(template.rivalAbbrs.length);
      for (const rivalId of team.rivalIds) {
        const rival = league.teams[rivalId];
        expect(rival).toBeDefined();
        expect(rival?.id).not.toBe(team.id);
        expect(rival?.division).toBe(team.division);
        expect(template.rivalAbbrs).toContain(rival?.abbr);
      }
    }
  });
  it('every depth chart is valid with no errors and no warnings', () => {
    for (const team of teams) expect(validateDepthChart(team.depthChart, rosterOf(team))).toEqual([]);
  });
  it('team ratings are cached, within 40..90 and spread across the league', () => {
    const overalls = teams.map((t) => t.overall);
    for (const team of teams) {
      for (const v of [team.overall, team.offenseRating, team.defenseRating]) {
        expect(v).toBeGreaterThanOrEqual(40);
        expect(v).toBeLessThanOrEqual(90);
      }
      expect(team.chemistry).toBeGreaterThanOrEqual(0);
      expect(team.chemistry).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...overalls) - Math.min(...overalls)).toBeGreaterThanOrEqual(12);
    expect(new Set(overalls).size).toBeGreaterThan(6);
  });
  it('no two teams are identical', () => {
    for (let a = 0; a < teams.length; a++) {
      for (let b = a + 1; b < teams.length; b++) {
        const ta = teams[a]!;
        const tb = teams[b]!;
        expect(ta.abbr).not.toBe(tb.abbr);
        expect(ta.rosterIds.some((id) => tb.rosterIds.includes(id))).toBe(false);
        expect(ta.staffIds.some((id) => tb.staffIds.includes(id))).toBe(false);
        expect(ta.stadiumId).not.toBe(tb.stadiumId);
      }
    }
  });
  it('flags exactly the user team and rejects unknown abbreviations', () => {
    expect(teams.filter((t) => t.isUserControlled).map((t) => t.abbr)).toEqual(['BOS']);
    const noUser = generateLeagueEntities(1, { ...baseOpts, userTeamAbbr: undefined });
    expect(Object.values(noUser.teams).some((t) => t.isUserControlled)).toBe(false);
    const lower = generateLeagueEntities(1, { ...baseOpts, userTeamAbbr: 'sea' });
    expect(Object.values(lower.teams).filter((t) => t.isUserControlled).map((t) => t.abbr)).toEqual(['SEA']);
    expect(() => generateLeagueEntities(1, { ...baseOpts, userTeamAbbr: 'ZZZ' })).toThrow(/unknown user team/);
  });
  it('validates options', () => {
    expect(() => generateLeagueEntities(1, { ...baseOpts, year: 2030.5 })).toThrow(/year/);
    expect(() => generateLeagueEntities(1, { ...baseOpts, salaryCap: 0 })).toThrow(/salaryCap/);
    expect(() => generateLeagueEntities(1, { ...baseOpts, pickYears: -1 })).toThrow(/pickYears/);
    expect(() => generateLeagueEntities(1, { ...baseOpts, draftRounds: 0 })).toThrow(/draftRounds/);
    expect(() => generateLeagueEntities(1, { ...baseOpts, capUsage: [0.99, 0.9] })).toThrow(/capUsage/);
  });
});

describe('coaches and stadiums', () => {
  it('gives every team a full 11-role staff led by its head coach', () => {
    expect(Object.keys(league.coaches)).toHaveLength(32 * STAFF_ROLES.length);
    for (const team of teams) {
      expect(team.staffIds).toHaveLength(STAFF_ROLES.length);
      const staff = team.staffIds.map((id) => league.coaches[id]!);
      expect(staff.map((c) => c.role).sort()).toEqual([...STAFF_ROLES].sort());
      for (const c of staff) expect(c.teamId).toBe(team.id);
      expect(team.headCoachId).not.toBeNull();
      expect(team.staffIds).toContain(team.headCoachId);
      expect(league.coaches[team.headCoachId!]?.role).toBe('HC');
    }
  });
  it('builds one stadium per team from its template', () => {
    expect(Object.keys(league.stadiums)).toHaveLength(32);
    for (const team of teams) {
      const stadium = league.stadiums[team.stadiumId];
      const template = templates.find((t) => t.abbr === team.abbr)!;
      expect(stadium).toBeDefined();
      expect(stadium).toMatchObject({ name: template.stadium.name, city: template.city, capacity: template.stadium.capacity, climate: template.stadium.climate });
      expect(stadium!.level).toBeGreaterThanOrEqual(1);
      expect(stadium!.level).toBeLessThanOrEqual(5);
    }
  });
});

describe('contracts and the cap', () => {
  it('keeps every team under the cap and fills it when the roster is worth it', () => {
    let filled = 0;
    for (const team of teams) {
      const hit = rosterCapHit(team, league.players);
      expect(hit).toBeLessThanOrEqual(CAP);
      const asking = rosterOf(team).reduce((s, p) => s + p.askingSalary, 0);
      if (asking >= CAP * DEFAULT_CAP_USAGE[1]) {
        expect(hit / CAP).toBeGreaterThanOrEqual(DEFAULT_CAP_USAGE[0] - 0.01);
        expect(hit / CAP).toBeLessThanOrEqual(DEFAULT_CAP_USAGE[1] + 0.005);
        filled++;
      }
    }
    expect(filled).toBeGreaterThan(5);
    const usage = teams.map((t) => rosterCapHit(t, league.players) / CAP);
    expect(Math.max(...usage)).toBeGreaterThan(0.9);
  });
  it('gives every player a well-formed contract at or above the minimum, dated consistently', () => {
    let expiring = 0;
    for (const p of Object.values(league.players)) {
      const c = p.contract!;
      expect(c.salary).toBeGreaterThanOrEqual(DEVELOPMENT.salary.minimum);
      expect(c.salary % 10_000).toBe(0);
      expect(c.years).toBeGreaterThanOrEqual(1);
      expect(c.years).toBeLessThanOrEqual(4);
      expect(c.yearsRemaining).toBeGreaterThanOrEqual(1);
      expect(c.yearsRemaining).toBeLessThanOrEqual(c.years);
      expect(c.signedYear + c.years - c.yearsRemaining).toBe(YEAR);
      expect(c.guaranteed).toBeGreaterThanOrEqual(0);
      expect(c.guaranteed).toBeLessThanOrEqual(c.salary * c.years);
      expect(c.signingBonus).toBeGreaterThanOrEqual(0);
      expect(c.restructured).toBe(false);
      expect(c.tag).toBeNull();
      if (p.age >= 32) expect(c.years).toBeLessThanOrEqual(2);
      if (c.yearsRemaining === 1) expiring++;
    }
    const share = expiring / Object.keys(league.players).length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.55);
  });
  it('assigns roles by talent and depth: stars are franchise players, starters start', () => {
    const roles = new Set(Object.values(league.players).map((p) => p.contract!.role));
    expect(roles).toEqual(new Set(['franchise', 'starter', 'rotation', 'backup', 'developmental']));
    for (const p of Object.values(league.players)) {
      if (p.overall >= 86) expect(p.contract!.role).toBe('franchise');
      if (p.contract!.role === 'developmental') expect(p.age).toBeLessThanOrEqual(24);
    }
    expect(contractRoleFor(makePlayer({ position: 'QB', attrValue: 90 }), 0)).toBe('franchise');
    expect(contractRoleFor(makePlayer({ position: 'WR', attrValue: 75 }), 2)).toBe('starter');
    expect(contractRoleFor(makePlayer({ position: 'WR', attrValue: 70 }), 3)).toBe('rotation');
    expect(contractRoleFor(makePlayer({ position: 'WR', attrValue: 60, age: 23, experience: 1 }), 5)).toBe('developmental');
    expect(contractRoleFor(makePlayer({ position: 'WR', attrValue: 60, age: 29 }), 5)).toBe('backup');
  });
  it('rollContractYears caps veterans at two years', () => {
    const rng = createRng(3);
    for (let i = 0; i < 100; i++) {
      expect(rollContractYears(rng, { age: 33 }, 'franchise')).toBeLessThanOrEqual(2);
      const y = rollContractYears(rng, { age: 25 }, 'starter');
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(4);
    }
  });
  it('draftContract prices at the asking salary with role-based guarantees and bonus', () => {
    const p = makePlayer({ position: 'QB', attrValue: 90, askingSalary: 30_000_000, age: 27 });
    const c = draftContract(createRng(1), p, 0, YEAR);
    expect(c.salary).toBe(30_000_000);
    expect(c.role).toBe('franchise');
    expect(c.guaranteed).toBe(Math.round((30_000_000 * c.years * 0.7) / 10_000) * 10_000);
    expect(c.signingBonus).toBe(Math.round((30_000_000 * c.years * 0.3) / 10_000) * 10_000);
    expect(contractCapHit(c)).toBe(c.salary + c.signingBonus / c.years);
  });
});

describe('fitContractsToCap', () => {
  const contract = (salary: number, years = 2, bonus = 0): Contract => ({
    salary, years, yearsRemaining: years, guaranteed: salary, signingBonus: bonus, role: 'starter', signedYear: YEAR, restructured: false, tag: null,
  });
  const total = (cs: readonly Contract[]): number => cs.reduce((s, c) => s + contractCapHit(c), 0);

  it('scales an expensive roster down to the target usage proportionally', () => {
    const contracts = [contract(100_000_000, 4, 40_000_000), contract(60_000_000), contract(40_000_000)];
    const fitted = fitContractsToCap(contracts, 100_000_000, 0.95);
    expect(total(fitted)).toBeLessThanOrEqual(100_000_000);
    expect(total(fitted)).toBeGreaterThan(93_000_000);
    const ratio = fitted[0]!.salary / fitted[1]!.salary;
    expect(Math.abs(ratio - 100 / 60)).toBeLessThan(0.02);
    expect(fitted[0]!.signingBonus / fitted[0]!.salary).toBeCloseTo(0.4, 1);
    expect(fitted[0]!.guaranteed).toBeLessThan(contracts[0]!.guaranteed);
  });
  it('scales a cheap roster up, but never beyond the scale-up cap', () => {
    const contracts = [contract(10_000_000), contract(5_000_000)];
    const fitted = fitContractsToCap(contracts, 100_000_000, 0.95);
    expect(fitted[0]!.salary).toBe(10_000_000 * MAX_CONTRACT_SCALE_UP);
    expect(fitted[1]!.salary).toBe(5_000_000 * MAX_CONTRACT_SCALE_UP);
    const mild = fitContractsToCap([contract(40_000_000), contract(40_000_000)], 100_000_000, 0.9);
    expect(total(mild)).toBeCloseTo(90_000_000, -5);
  });
  it('respects the league minimum and pushes the excess onto the flexible contracts', () => {
    const min = DEVELOPMENT.salary.minimum;
    const contracts = [contract(50_000_000), ...Array.from({ length: 10 }, () => contract(min))];
    const cap = 20_000_000;
    const fitted = fitContractsToCap(contracts, cap, 0.95);
    for (const c of fitted) expect(c.salary).toBeGreaterThanOrEqual(min);
    expect(total(fitted)).toBeLessThanOrEqual(cap);
    for (let i = 1; i < fitted.length; i++) expect(fitted[i]!.salary).toBe(min);
    expect(fitted[0]!.salary).toBeLessThan(50_000_000);
  });
  it('leaves an empty list alone', () => {
    expect(fitContractsToCap([], 1_000, 0.9)).toEqual([]);
  });
});

describe('picks, finances, fans and facilities', () => {
  it('gives each team three drafts of picks in every round with canonical ids', () => {
    for (const team of teams) {
      expect(team.picks).toHaveLength(21);
      for (const pick of team.picks) {
        expect(pick.id).toBe(`${pick.year}-r${pick.round}-${team.id}`);
        expect(pick.originalTeamId).toBe(team.id);
        expect(pick.ownerTeamId).toBe(team.id);
        expect(pick.overall).toBeNull();
        expect(pick.year).toBeGreaterThanOrEqual(YEAR);
        expect(pick.year).toBeLessThan(YEAR + 3);
      }
      expect(new Set(team.picks.map((p) => p.id)).size).toBe(21);
    }
    const custom = generateLeagueEntities(2, { ...baseOpts, firstPickYear: YEAR + 1, pickYears: 1, draftRounds: 3 });
    const picks = Object.values(custom.teams)[0]!.picks;
    expect(picks.map((p) => [p.year, p.round])).toEqual([[YEAR + 1, 1], [YEAR + 1, 2], [YEAR + 1, 3]]);
  });
  it('starts every team with clean books, market-sized cash, facilities 1..5 and plausible fans', () => {
    for (const team of teams) {
      expect(team.finances.seasonRevenue.tickets).toBe(0);
      expect(team.finances.deadMoney).toEqual({});
      expect(team.finances.cash).toBeGreaterThan(0);
      for (const level of Object.values(team.facilities)) {
        expect(level).toBeGreaterThanOrEqual(1);
        expect(level).toBeLessThanOrEqual(5);
      }
      expect(team.fans.support).toBeGreaterThanOrEqual(0);
      expect(team.fans.support).toBeLessThanOrEqual(100);
      expect(team.fans.attendancePct).toBeGreaterThanOrEqual(0.5);
      expect(team.fans.attendancePct).toBeLessThanOrEqual(1);
      expect(team.history).toEqual([]);
      expect(team.championships).toBe(0);
      expect(team.playbookId).toBe(DEFAULT_PLAYBOOK_ID);
    }
    const large = teams.filter((t) => t.marketSize === 'large').map((t) => t.finances.cash);
    const small = teams.filter((t) => t.marketSize === 'small').map((t) => t.finances.cash);
    expect(Math.min(...large)).toBeGreaterThan(Math.max(...small));
    const custom = generateLeagueEntities(3, { ...baseOpts, playbookId: 'spread' });
    for (const t of Object.values(custom.teams)) expect(t.playbookId).toBe('spread');
  });
  it('biases player home regions toward the team region', () => {
    const local = teams.map((t) => rosterOf(t).filter((p) => p.homeRegion === t.region).length / ROSTER_SIZE);
    expect(local.reduce((a, b) => a + b, 0) / local.length).toBeGreaterThan(0.15);
  });
});

describe('teamStrengths', () => {
  it('spreads strengths across the range, shuffled, inside 0..1', () => {
    const s = teamStrengths(createRng(9), 32);
    expect(s).toHaveLength(32);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const sorted = [...s].sort((a, b) => a - b);
    expect(sorted).not.toEqual(s);
    expect(sorted[0]).toBeLessThan(0.2);
    expect(sorted[31]).toBeGreaterThan(0.8);
    expect(teamStrengths(createRng(1), 1)).toHaveLength(1);
    const narrow = teamStrengths(createRng(2), 4, [0.4, 0.6]);
    for (const v of narrow) {
      expect(v).toBeGreaterThan(0.3);
      expect(v).toBeLessThan(0.7);
    }
  });
});

describe('teamId typing', () => {
  it('keys the record by the branded team id', () => {
    const id = teams[0]!.id as TeamId;
    expect(league.teams[id]).toBe(teams[0]);
  });
});
