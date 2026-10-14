import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { POSITIONS } from '@/players/types';
import { validateLeague } from '@/save/serialize';
import { applySubstitution } from '@/teams/depth-chart';
import { capHit, capSpace, createContract, deadMoney, leagueCapYear } from '@/franchise/contracts';
import {
  assignPlayer, canSign, cutPlayer, cutPreview, needsCutsTo, positionDepth, rosterCount, rosterErrors, rosterLimitFor, signPlayer,
  validateRosterConsistency,
} from '@/franchise/roster';
import { atPhase, bestAt, buildLeague, rosterOf, teamByAbbr, teamsSorted, withPlayer, withTeam } from './helpers';

const kinds = (league: Parameters<typeof validateRosterConsistency>[0]): string[] =>
  validateRosterConsistency(league).filter((i) => i.severity === 'error').map((i) => i.kind);

describe('assignPlayer', () => {
  it('moves a player between rosters, charts and free agency consistently and purely', () => {
    const league = buildLeague();
    const [a, b] = teamsSorted(league) as [NonNullable<ReturnType<typeof teamsSorted>[number]>, NonNullable<ReturnType<typeof teamsSorted>[number]>];
    const wr = bestAt(league, a.id, 'WR');
    const moved = assignPlayer(league, wr.id, b.id);
    expect(moved.players[wr.id]!.teamId).toBe(b.id);
    expect(moved.teams[a.id]!.rosterIds).not.toContain(wr.id);
    expect(moved.teams[b.id]!.rosterIds).toContain(wr.id);
    expect(moved.teams[b.id]!.depthChart.WR).toContain(wr.id);
    expect(Object.values(moved.teams[a.id]!.depthChart).some((ids) => ids.includes(wr.id))).toBe(false);
    expect(rosterErrors(moved)).toEqual([]);
    // input untouched; untouched teams keep identity
    expect(league.players[wr.id]!.teamId).toBe(a.id);
    expect(league.teams[a.id]!.rosterIds).toContain(wr.id);
    expect(moved.teams[teamsSorted(league)[5]!.id]).toBe(league.teams[teamsSorted(league)[5]!.id]);

    const released = assignPlayer(moved, wr.id, null);
    expect(released.freeAgentIds).toContain(wr.id);
    expect(released.players[wr.id]!.teamId).toBeNull();
    expect(released.teams[b.id]!.rosterIds).not.toContain(wr.id);
    const back = assignPlayer(released, wr.id, a.id);
    expect(back.freeAgentIds).not.toContain(wr.id);
    expect(rosterErrors(back)).toEqual([]);
    expect(assignPlayer(back, wr.id, a.id).teams[a.id]).toBe(back.teams[a.id]);
    expect(() => assignPlayer(league, 'p_nope' as PlayerId, a.id)).toThrow(/unknown player/);
    expect(() => assignPlayer(league, wr.id, 't_nope' as TeamId)).toThrow(/unknown team/);
    expect(() => validateLeague(back)).not.toThrow();
  });

  it("keeps the user's manual depth order and inserts arrivals by overall", () => {
    const league = buildLeague({ userTeamAbbr: 'BOS' });
    const user = teamByAbbr(league, 'BOS');
    const qbs = user.depthChart.QB;
    const manual = applySubstitution(user.depthChart, 'QB', qbs[2]!, 0);
    const custom = withTeam(league, { ...user, depthChart: manual });
    const other = teamsSorted(custom).find((t) => t.id !== user.id)!;
    const star = { ...bestAt(custom, other.id, 'QB'), overall: 99 };
    const signedAway = assignPlayer(withPlayer(custom, star), star.id, user.id);
    const chart = signedAway.teams[user.id]!.depthChart.QB;
    expect(chart[0]).toBe(star.id);
    expect(chart.slice(1)).toEqual(manual.QB);
    const released = assignPlayer(signedAway, qbs[2]!, null);
    expect(released.teams[user.id]!.depthChart.QB).toEqual([star.id, ...manual.QB.filter((id) => id !== qbs[2])]);
    // AI teams are re-sorted automatically
    const aiChart = signedAway.teams[other.id]!.depthChart.QB;
    const ovrs = aiChart.map((id) => signedAway.players[id]!.overall);
    expect([...ovrs].sort((x, y) => y - x)).toEqual(ovrs);
  });
});

describe('sign and cut', () => {
  it('cutPlayer books dead money, clears the contract and releases him', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const team = teamsSorted(league)[2]!;
    const year = leagueCapYear(league);
    const victim = rosterOf(league, team.id).find((p) => p.contract && deadMoney(p.contract, year) > 0)!;
    const dead = deadMoney(victim.contract, year);
    const before = capSpace(team, league.players, league.settings, year);
    const preview = cutPreview(league, team.id, victim.id);
    const after = cutPlayer(league, team.id, victim.id);
    expect(after.players[victim.id]!.contract).toBeNull();
    expect(after.freeAgentIds).toContain(victim.id);
    expect(after.teams[team.id]!.finances.deadMoney[year]).toBe(dead);
    expect(preview.deadThisYear).toBe(dead);
    expect(capSpace(after.teams[team.id]!, after.players, after.settings, year) - before).toBe(capHit(victim.contract, year) - dead);
    expect(rosterErrors(after)).toEqual([]);
    expect(() => cutPlayer(league, teamsSorted(league)[0]!.id, victim.id)).toThrow(/not on/);
  });

  it('post-cutoff cuts split the bonus over two seasons', () => {
    const league = buildLeague({ phase: 'regularSeason', week: 3 });
    const team = teamsSorted(league)[4]!;
    const victim = rosterOf(league, team.id).find((p) => p.contract && p.contract.signingBonus > 0 && p.contract.yearsRemaining >= 2)!;
    const after = cutPlayer(league, team.id, victim.id);
    expect(after.teams[team.id]!.finances.deadMoney[2027]).toBeGreaterThan(0);
    expect((after.teams[team.id]!.finances.deadMoney[2026] ?? 0) + (after.teams[team.id]!.finances.deadMoney[2027] ?? 0)).toBe(deadMoney(victim.contract, 2026));
  });

  it('signPlayer attaches the contract and enforces free-agent status and the cap', () => {
    const base = atPhase(buildLeague(), 'freeAgency');
    const team = teamsSorted(base)[1]!;
    const donor = teamsSorted(base)[6]!;
    const fa = bestAt(base, donor.id, 'CB');
    const league = cutPlayer(base, donor.id, fa.id);
    const year = leagueCapYear(league);
    const contract = createContract({ salary: 3_000_000, years: 2, guaranteed: 1_000_000, signingBonus: 1_000_000, role: 'rotation', year });
    const signed = signPlayer(league, team.id, fa.id, contract);
    expect(signed.players[fa.id]!.contract).toEqual(contract);
    expect(signed.players[fa.id]!.teamId).toBe(team.id);
    expect(signed.teams[team.id]!.depthChart.CB).toContain(fa.id);
    expect(signed.freeAgentIds).not.toContain(fa.id);
    expect(signed.players[fa.id]!.morale.morale).toBeGreaterThanOrEqual(league.players[fa.id]!.morale.morale);
    expect(rosterErrors(signed)).toEqual([]);
    expect(() => signPlayer(signed, donor.id, fa.id, contract)).toThrow(/not a free agent/);
    const huge = createContract({ salary: 400_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'franchise', year });
    const check = canSign(league, team.id, fa.id, huge);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/cap space/);
    expect(() => signPlayer(league, team.id, fa.id, huge)).toThrow(/cap space/);
    expect(() => signPlayer(league, team.id, fa.id, huge, { allowOverCap: true })).not.toThrow();
    expect(canSign(league, team.id, fa.id, contract, { rosterLimit: league.teams[team.id]!.rosterIds.length }).ok).toBe(false);
    expect(() => validateLeague(signed)).not.toThrow();
  });
});

describe('roster queries and validation', () => {
  it('counts, limits and position depth', () => {
    const league = buildLeague();
    const team = teamsSorted(league)[0]!;
    expect(rosterCount(league, team.id)).toBe(53);
    expect(needsCutsTo(league, team.id)).toBe(0);
    expect(needsCutsTo(league, team.id, 50)).toBe(3);
    expect(rosterLimitFor(league)).toBe(53);
    expect(rosterLimitFor(atPhase(league, 'draft'))).toBeGreaterThan(53);
    const depth = positionDepth(league, team);
    expect(POSITIONS.reduce((s, pos) => s + depth[pos].length, 0)).toBe(53);
    for (const pos of POSITIONS) {
      const o = depth[pos].map((p) => p.overall);
      expect([...o].sort((x, y) => y - x)).toEqual(o);
    }
  });

  it('validateRosterConsistency catches every kind of corruption', () => {
    const league = buildLeague();
    expect(validateRosterConsistency(league).filter((i) => i.severity === 'error')).toEqual([]);
    const [a, b] = teamsSorted(league);
    const p = rosterOf(league, a!.id)[10]!;
    expect(kinds(withPlayer(league, { ...p, teamId: b!.id }))).toEqual(expect.arrayContaining(['teamMismatch']));
    expect(kinds(withTeam(league, { ...b!, rosterIds: [...b!.rosterIds, p.id] }))).toEqual(expect.arrayContaining(['duplicateRoster']));
    expect(kinds({ ...league, freeAgentIds: [p.id] })).toEqual(['freeAgentAttached']);
    expect(kinds(withTeam(league, { ...a!, rosterIds: a!.rosterIds.filter((id) => id !== p.id) }))).toEqual(expect.arrayContaining(['notOnRoster', 'depthStranger']));
    const loose = withPlayer(withTeam(league, { ...a!, rosterIds: a!.rosterIds.filter((id) => id !== p.id), depthChart: a!.depthChart }), { ...p, teamId: null });
    expect(kinds(loose)).toEqual(expect.arrayContaining(['freeAgentMissing']));
    expect(kinds({ ...league, freeAgentIds: ['p_ghost' as PlayerId] })).toEqual(['freeAgentUnknown']);
    expect(kinds(withTeam(league, { ...a!, rosterIds: [...a!.rosterIds, 'p_ghost' as PlayerId] }))).toEqual(['missingPlayer']);
    const warn = validateRosterConsistency(withPlayer(league, { ...p, contract: null }));
    expect(warn.some((i) => i.kind === 'noContract' && i.severity === 'warning')).toBe(true);
  });
});
