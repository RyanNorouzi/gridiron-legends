import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { validateLeague } from '@/save/serialize';
import { capSpace, leagueCapYear } from '@/franchise/contracts';
import { beginRosterEdit, cutPlayer, isUserTeam, rosterErrors } from '@/franchise/roster';
import { minKeep } from '@/franchise/gm/roster-ai';
import { aiFinalCuts, fillRosterHolesInPlace, rosterHoles, settleRosterInPlace } from '@/franchise/gm/roster-fill';
import type { League } from '@/franchise/types';
import { atPhase, buildLeague, rosterOf, teamByAbbr, teamsSorted } from './helpers';

/** Post-draft league with one AI team's punters and fullbacks cut (they land in the free-agent pool). */
const withoutSpecialists = (): { league: League; teamId: TeamId; cutIds: PlayerId[] } => {
  let league = atPhase(buildLeague({ seed: 17, userTeamAbbr: 'BOS' }), 'postDraft');
  const team = teamsSorted(league).find((t) => !isUserTeam(league, t))!;
  const cutIds = rosterOf(league, team.id).filter((p) => p.position === 'P' || p.position === 'FB').map((p) => p.id);
  for (const id of cutIds) league = cutPlayer(league, team.id, id);
  return { league, teamId: team.id, cutIds };
};

describe('roster fill', () => {
  it('finds empty required positions and signs the best free agent there on a minimum deal', () => {
    const { league, teamId, cutIds } = withoutSpecialists();
    expect(rosterHoles(league, teamId)).toEqual(expect.arrayContaining(['FB', 'P']));
    const work = beginRosterEdit(league);
    const signed = fillRosterHolesInPlace(work, teamId);
    expect(rosterHoles(work, teamId)).toEqual([]);
    expect(new Set(signed)).toEqual(new Set(cutIds));
    for (const id of signed) expect(work.players[id]!.contract!.salary).toBeLessThanOrEqual(league.settings.minimumSalary * 2);
    expect(rosterErrors(work)).toEqual([]);
  });

  it('generates a street free agent when the pool has nobody at the position (deterministically)', () => {
    const { league, teamId, cutIds } = withoutSpecialists();
    // the released players retire, so the pool holds no punter or fullback at all
    const players = { ...league.players };
    for (const id of cutIds) delete players[id];
    const emptied: League = { ...league, players, freeAgentIds: league.freeAgentIds.filter((id) => !cutIds.includes(id)) };
    const run = (): League => {
      const work = beginRosterEdit(emptied);
      fillRosterHolesInPlace(work, teamId);
      return work;
    };
    const a = run();
    const b = run();
    const fresh = a.teams[teamId]!.rosterIds.filter((id) => !emptied.players[id]);
    expect(fresh.map((id) => a.players[id]!.position).sort()).toEqual(['FB', 'P']);
    for (const id of fresh) {
      expect(a.players[id]!.teamId).toBe(teamId);
      expect(a.freeAgentIds).not.toContain(id);
    }
    expect(b.teams[teamId]!.rosterIds).toEqual(a.teams[teamId]!.rosterIds);
    expect(rosterErrors(a)).toEqual([]);
  });

  it('settles a roster at the roster size, with every position at its floor and the team under the cap', () => {
    const { league, teamId } = withoutSpecialists();
    const work = beginRosterEdit(league);
    settleRosterInPlace(work, teamId);
    const team = work.teams[teamId]!;
    expect(team.rosterIds).toHaveLength(53);
    expect(rosterHoles(work, teamId)).toEqual([]);
    for (const pos of ['K', 'P', 'FB', 'QB'] as const) expect(rosterOf(work, teamId).filter((p) => p.position === pos).length).toBeGreaterThanOrEqual(minKeep(pos));
    expect(capSpace(team, work.players, work.settings, leagueCapYear(work))).toBeGreaterThanOrEqual(0);
    expect(rosterErrors(work)).toEqual([]);
  });

  it('final cuts settle every AI team and leave the user roster alone unless asked', () => {
    let league = atPhase(buildLeague({ seed: 23, userTeamAbbr: 'BOS' }), 'postDraft');
    const userId = teamByAbbr(league, 'BOS').id;
    const userP = rosterOf(league, userId).find((p) => p.position === 'P')!;
    league = cutPlayer(league, userId, userP.id);
    const ai = aiFinalCuts(league);
    expect(ai.teams[userId]).toBe(league.teams[userId]);
    for (const t of teamsSorted(ai)) if (t.id !== userId) expect(t.rosterIds).toHaveLength(53);
    const all = aiFinalCuts(league, { includeUser: true });
    expect(all.teams[userId]!.rosterIds).toHaveLength(53);
    expect(rosterHoles(all, userId)).toEqual([]);
    expect(rosterErrors(all)).toEqual([]);
    expect(() => validateLeague(all)).not.toThrow();
  });
});
