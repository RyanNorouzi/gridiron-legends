import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import {
  assertValidLeague, careerOf, createLeague, generateFreeAgents, leagueRng, lookupPlayer, teamOf, userTeam, validateLeague, withRngState,
} from '@/franchise/league';
import { validateSchedule } from '@/franchise/schedule';
import { advanceWeek } from '@/franchise/week';
import { createRng } from '@/core/rng';
import { deserializeLeague, serializeLeague } from '@/save/serialize';
import { byAbbr, makeLeague } from './helpers';

const league = makeLeague(7);

describe('createLeague', () => {
  it('builds 32 teams with full rosters plus an unsigned free-agent pool', () => {
    expect(Object.keys(league.teams)).toHaveLength(32);
    expect(Object.values(league.teams).every((t) => t.rosterIds.length === 53)).toBe(true);
    expect(league.freeAgentIds).toHaveLength(120);
    expect(Object.keys(league.players)).toHaveLength(32 * 53 + 120);
    for (const id of league.freeAgentIds) {
      const p = league.players[id];
      expect(p?.teamId).toBeNull();
      expect(p?.contract).toBeNull();
    }
    const overalls = league.freeAgentIds.map((id) => league.players[id]?.overall ?? 0);
    expect(Math.max(...overalls) - Math.min(...overalls)).toBeGreaterThan(20);
    expect(new Set(league.freeAgentIds.map((id) => league.players[id]?.position)).size).toBeGreaterThan(10);
  });

  it('starts a fresh season and empty books', () => {
    const s = league.season;
    expect(s).toMatchObject({ year: 2026, phase: 'preseason', week: 1, bracket: null, champion: null, awards: [], stats: {}, playoffStats: {} });
    expect(validateSchedule(s.schedule, league.teams, league.settings)).toEqual([]);
    expect(Object.keys(s.standings)).toHaveLength(32);
    expect(Object.keys(s.teamStats)).toHaveLength(32);
    expect(league).toMatchObject({ year: 2026, records: [], hallOfFame: [], events: [], history: [], pendingTrades: [], draft: null, freeAgency: null, playLogs: {}, version: 1 });
    expect(Object.keys(league.careerStats)).toHaveLength(Object.keys(league.players).length);
    expect(Object.values(league.careerStats).every((c) => c.seasons.length === 0)).toBe(true);
    expect(league.rngState).toHaveLength(4);
    expect(league.rngSeed).toBe(7);
    expect(league.id).toMatch(/^lg_/);
  });

  it('marks the user team', () => {
    const bos = byAbbr(league, 'BOS');
    expect(league.userTeamId).toBe(bos.id);
    expect(userTeam(league)?.abbr).toBe('BOS');
    expect(Object.values(league.teams).filter((t) => t.isUserControlled)).toHaveLength(1);
    expect(createLeague({ seed: 7 }).userTeamId).toBeNull();
  });

  it('is deterministic by seed', () => {
    expect(makeLeague(7)).toEqual(league);
    const other = makeLeague(8);
    expect(Object.keys(other.players)).not.toEqual(Object.keys(league.players));
  });

  it('applies settings overrides and validates them', () => {
    const noPre = createLeague({ seed: 1, settings: { preseasonWeeks: 0, weatherEnabled: false } });
    expect(noPre.season.week).toBe(0);
    expect(noPre.season.schedule.some((g) => g.isPreseason)).toBe(false);
    const started = advanceWeek(noPre);
    expect(started.season.phase).toBe('regularSeason');
    expect(started.season.week).toBe(1);
    expect(() => createLeague({ seed: 1, settings: { teamCount: 31 } })).toThrow(/Invalid league settings/);
    expect(() => createLeague({ seed: 1, settings: { divisionsPerConference: 2, teamCount: 32 } })).toThrow(/divisions/);
    expect(() => createLeague({ seed: 1, userTeamAbbr: 'ZZZ' })).toThrow(/unknown user team/);
  });

  it('builds a custom team in place of a bundled one', () => {
    const custom = createLeague({ seed: 3, customTeam: { replaces: 'DEN', city: 'Aurora', name: 'Comets', abbr: 'aur', colors: { primary: '#123456' }, stadiumName: 'Comet Field' } });
    const team = byAbbr(custom, 'AUR');
    expect(custom.userTeamId).toBe(team.id);
    expect(team).toMatchObject({ city: 'Aurora', name: 'Comets', isUserControlled: true });
    expect(team.colors.primary).toBe('#123456');
    expect(custom.stadiums[team.stadiumId]).toMatchObject({ name: 'Comet Field', city: 'Aurora' });
    expect(Object.values(custom.teams).filter((t) => t.isUserControlled)).toHaveLength(1);
    expect(validateLeague(custom)).toEqual([]);
    expect(() => createLeague({ seed: 3, customTeam: { replaces: 'DEN', city: 'X', name: 'Y', abbr: 'BOS' } })).toThrow(/already taken/);
    expect(() => createLeague({ seed: 3, customTeam: { replaces: 'DEN', city: 'X', name: 'Y', abbr: 'TOOLONG' } })).toThrow(/2-4 letters/);
    expect(() => createLeague({ seed: 3, customTeam: { replaces: 'NOPE', city: 'X', name: 'Y', abbr: 'XY' } })).toThrow(/NOPE/);
  });

  it('round-trips through the save serializer', () => {
    const restored = deserializeLeague(serializeLeague(league));
    expect(restored).toEqual(league);
    expect(validateLeague(restored)).toEqual([]);
  });
});

describe('lookups', () => {
  const bos = byAbbr(league, 'BOS');
  const pid = bos.rosterIds[0] as PlayerId;
  it('finds players and their teams', () => {
    expect(lookupPlayer(league, pid)?.id).toBe(pid);
    expect(teamOf(league, pid)?.id).toBe(bos.id);
    expect(teamOf(league, league.freeAgentIds[0] as PlayerId)).toBeNull();
    expect(lookupPlayer(league, 'p_missing' as PlayerId)).toBeUndefined();
    const retiredPlayer = { ...(league.players[pid] as NonNullable<(typeof league.players)[PlayerId]>), retired: true, teamId: null };
    const withRetired = { ...league, retiredPlayers: { [pid]: retiredPlayer } };
    expect(lookupPlayer({ ...withRetired, players: {} }, pid)?.retired).toBe(true);
    expect(careerOf(league, pid)).toEqual({ playerId: pid, seasons: [], totals: league.careerStats[pid]?.totals });
    expect(careerOf(league, 'p_new' as PlayerId).seasons).toEqual([]);
  });

  it('restores and commits the league rng', () => {
    const rng = leagueRng(league);
    const a = rng.next();
    expect(leagueRng(league).next()).toBe(a);
    const moved = withRngState(league, rng);
    expect(leagueRng(moved).next()).not.toBe(a);
  });

  it('generates free agents without id clashes', () => {
    const taken = new Set(Object.keys(league.players) as PlayerId[]);
    const fas = generateFreeAgents(createRng(5), 30, 2026, taken);
    expect(fas).toHaveLength(30);
    expect(fas.every((p) => !taken.has(p.id) && p.teamId === null)).toBe(true);
  });
});

describe('validateLeague', () => {
  it('accepts a fresh league', () => {
    expect(validateLeague(league)).toEqual([]);
    expect(assertValidLeague(league)).toBe(league);
  });

  it('reports broken roster mirrors, depth charts and dangling ids', () => {
    const bos = byAbbr(league, 'BOS');
    const pid = bos.rosterIds[0] as PlayerId;
    const fa = league.freeAgentIds[0] as PlayerId;
    const other = Object.values(league.teams).find((t) => t.id !== bos.id)?.id as TeamId;
    const broken = {
      ...league,
      players: { ...league.players, [pid]: { ...(league.players[pid] as NonNullable<(typeof league.players)[PlayerId]>), teamId: other } },
      teams: { ...league.teams, [bos.id]: { ...bos, depthChart: { ...bos.depthChart, QB: [fa, ...bos.depthChart.QB] }, headCoachId: 'c_ghost' as NonNullable<typeof bos.headCoachId> } },
      freeAgentIds: [...league.freeAgentIds, pid],
      userTeamId: 't_ghost' as TeamId,
    };
    const issues = validateLeague(broken).join('\n');
    expect(issues).toMatch(/roster player .* has teamId/);
    expect(issues).toMatch(/is not on the roster/);
    expect(issues).toMatch(/unknown head coach/);
    expect(issues).toMatch(/free agent .* attached/);
    expect(issues).toMatch(/unknown user team/);
    expect(() => assertValidLeague(broken)).toThrow(/Invalid league/);
  });
});
