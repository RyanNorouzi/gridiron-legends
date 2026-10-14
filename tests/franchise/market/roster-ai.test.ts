import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { POSITIONS } from '@/players/types';
import { STARTER_COUNTS, applySubstitution } from '@/teams/depth-chart';
import type { League } from '@/franchise/types';
import { capSpace, contractEndYear, createContract, leagueCapYear } from '@/franchise/contracts';
import { beginRosterEdit, positionDepth, rosterErrors, signPlayerInPlace } from '@/franchise/roster';
import {
  aiCapCompliance, aiCutsToLimit, aiDepthChartRefresh, aiResignDecisions, applyResignDecisions, buildPackage, maxResignAge, minKeep,
  runAiResigning, tradeableAssets,
} from '@/franchise/gm/roster-ai';
import { teamNeeds } from '@/franchise/gm/needs';
import { generatePlayer } from '@/players/generator';
import { testNames } from '../../players/helpers';
import { atPhase, buildLeague, rosterOf, teamsSorted, withPlayer, withTeam } from './helpers';

describe('re-signing', () => {
  it('keeps core players, lets aging or surplus ones walk, and starts new deals next season', () => {
    const league = atPhase(buildLeague({ seed: 9 }), 'resigning');
    const team = teamsSorted(league)[7]!;
    const decisions = aiResignDecisions(league, team, 2026, createRng(1));
    const expiringIds = rosterOf(league, team.id).filter((p) => p.contract && contractEndYear(p.contract) <= 2026).map((p) => p.id);
    expect(decisions.map((d) => d.playerId).sort()).toEqual([...expiringIds].sort());
    const extended = decisions.filter((d) => d.action === 'extend');
    expect(extended.length).toBeGreaterThan(0);
    expect(decisions.some((d) => d.action !== 'extend')).toBe(true);
    for (const d of decisions) {
      const p = league.players[d.playerId]!;
      if (p.age > maxResignAge(p.position)) expect(d.action).toBe('decline');
      if (d.action === 'extend') expect(d.terms).not.toBeNull();
    }
    const after = applyResignDecisions(league, team.id, decisions);
    for (const d of extended) {
      const c = after.players[d.playerId]!.contract!;
      expect(c.signedYear).toBe(2027);
      expect(contractEndYear(c)).toBeGreaterThanOrEqual(2027);
    }
    const reserve = capSpace(after.teams[team.id]!, after.players, after.settings, 2027);
    expect(reserve).toBeGreaterThan(0);
    expect(() => applyResignDecisions(league, teamsSorted(league)[0]!.id, extended)).toThrow(/is not on/);
  });

  it('runAiResigning skips the user team and is deterministic', () => {
    const league = atPhase(buildLeague({ seed: 9, userTeamAbbr: 'BOS' }), 'resigning');
    const a = runAiResigning(league, createRng(3));
    const b = runAiResigning(league, createRng(3));
    expect(a.players).toEqual(b.players);
    const user = league.userTeamId!;
    for (const id of league.teams[user]!.rosterIds) expect(a.players[id]).toBe(league.players[id]);
    const extendedElsewhere = Object.keys(a.players).filter((id) => a.players[id as PlayerId] !== league.players[id as PlayerId]);
    expect(extendedElsewhere.length).toBeGreaterThan(100);
  });
});

/** Adds `n` generated free agents to a team (over the roster limit) in the draft phase. */
const overstaff = (league: League, teamIndex: number, n: number): League => {
  const work = beginRosterEdit(league);
  const team = teamsSorted(league)[teamIndex]!;
  const rng = createRng(42);
  for (let i = 0; i < n; i++) {
    const p = generatePlayer(rng, { position: POSITIONS[i % POSITIONS.length]!, names: testNames, regions: ['north'], year: 2026, targetOverall: 50 + i });
    work.players[p.id] = p;
    work.freeAgentIds = [...work.freeAgentIds, p.id];
    signPlayerInPlace(work, team.id, p.id, createContract({ salary: 800_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'backup', year: 2027 }), { allowOverCap: true });
  }
  return work;
};

describe('cuts, cap compliance, depth charts', () => {
  it('cuts to the limit without gutting any position', () => {
    const league = overstaff(atPhase(buildLeague(), 'draft'), 3, 9);
    const team = teamsSorted(league)[3]!;
    expect(team.rosterIds.length).toBe(62);
    const after = aiCutsToLimit(league, team.id);
    const t = after.teams[team.id]!;
    expect(t.rosterIds.length).toBe(53);
    const depth = positionDepth(after, t);
    for (const pos of POSITIONS) expect(depth[pos].length).toBeGreaterThanOrEqual(minKeep(pos));
    expect(after.freeAgentIds.length).toBe(league.freeAgentIds.length + 9);
    const bestBefore = rosterOf(league, team.id)[0]!;
    expect(t.rosterIds).toContain(bestBefore.id);
    expect(rosterErrors(after)).toEqual([]);
  });

  it('restores cap compliance with restructures, then cuts', () => {
    const base = atPhase(buildLeague({ seed: 4 }), 'regularSeason', 3);
    const team = teamsSorted(base)[5]!;
    const year = leagueCapYear(base);
    const space = capSpace(team, base.players, base.settings, year);
    const league = withTeam(base, { ...team, finances: { ...team.finances, deadMoney: { [year]: space + 12_000_000 } } });
    expect(capSpace(league.teams[team.id]!, league.players, league.settings, year)).toBeLessThan(0);
    const after = aiCapCompliance(league, team.id);
    expect(capSpace(after.teams[team.id]!, after.players, after.settings, year)).toBeGreaterThanOrEqual(0);
    const restructured = after.teams[team.id]!.rosterIds.filter((id) => after.players[id]!.contract?.restructured);
    expect(restructured.length).toBeGreaterThan(0);
    expect(rosterErrors(after)).toEqual([]);
    expect(aiCapCompliance(base, team.id).players).toEqual(base.players);
  });

  it('refreshes a scrambled depth chart back to availability/overall order', () => {
    const league = buildLeague();
    const team = teamsSorted(league)[2]!;
    const worstQb = team.depthChart.QB[team.depthChart.QB.length - 1]!;
    const scrambled = withTeam(league, { ...team, depthChart: applySubstitution(team.depthChart, 'QB', worstQb, 0) });
    expect(scrambled.teams[team.id]!.depthChart.QB[0]).toBe(worstQb);
    const fixed = aiDepthChartRefresh(scrambled, team.id);
    expect(fixed.teams[team.id]!.depthChart.QB).toEqual(team.depthChart.QB);
  });
});

describe('trade building blocks', () => {
  it('tradeableAssets never offers untouchables or starters at a need', () => {
    const league = buildLeague({ seed: 17 });
    const team = teamsSorted(league)[1]!;
    const needs = teamNeeds(league, team);
    const pool = tradeableAssets(league, team, needs);
    expect(pool.some((a) => a.asset.kind === 'pick')).toBe(true);
    for (let i = 1; i < pool.length; i++) expect(pool[i - 1]!.value).toBeGreaterThanOrEqual(pool[i]!.value);
    const offered = new Set(pool.flatMap((a) => (a.asset.kind === 'player' ? [a.asset.playerId] : [])));
    const depth = positionDepth(league, team);
    let checked = 0;
    for (const pos of POSITIONS) {
      if (needs.positions[pos].need < 0.27) continue;
      for (const p of depth[pos].slice(0, STARTER_COUNTS[pos])) {
        expect(offered.has(p.id)).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
    const star = { ...rosterOf(league, team.id)[0]!, overall: 94, age: 25 };
    const withStar = withPlayer(league, star);
    expect(tradeableAssets(withStar, withStar.teams[team.id]!).some((a) => a.asset.kind === 'player' && a.asset.playerId === star.id)).toBe(false);
  });

  it('buildPackage reaches the aim cheaply or reports failure', () => {
    const mk = (id: string, value: number) => ({ asset: { kind: 'player' as const, playerId: id as PlayerId }, value });
    const pool = [mk('a', 900), mk('b', 400), mk('c', 300), mk('d', 50)];
    expect(buildPackage(pool, 350)!.map((x) => x.value)).toEqual([400]);
    const combo = buildPackage(pool, 1200)!;
    expect(combo.reduce((s, x) => s + x.value, 0)).toBeGreaterThanOrEqual(1200);
    expect(buildPackage(pool, 5000)).toBeNull();
  });
});
