import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { leagueCapYear } from '@/franchise/contracts';
import { applyMoraleEffects, isBenchedStarter, moraleEffects, rosterChanges, syncRosterMoves, teamChemistry, teamStarters, weeklyMorale } from '@/franchise/morale';
import { withClub } from '@/franchise/rivalries';
import { assignPlayer } from '@/franchise/roster';
import type { League } from '@/franchise/types';
import type { Morale, Player } from '@/players/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import type { Team } from '@/teams/types';
import { aiTeam, atDepth, clubLeague, divisionPair, finishedGame, patchPlayer, patchTeam, rosterOf, userTeamOf, withPhase } from './helpers';

const league = withPhase(clubLeague(), 'regularSeason', 3);
const team = userTeamOf(league);
const opp = divisionPair(league).far.id === team.id ? aiTeam(league, 5) : divisionPair(league).far;
const neutral: Morale = { morale: 55, confidence: 55, coachRelationship: 55 };

/** Every roster player at a neutral mood, no traits: isolates one effect at a time. */
const calm = (l: League, t: Team): League => {
  const players = { ...l.players };
  for (const p of rosterOf(l, t.id)) players[p.id] = { ...p, morale: { ...neutral }, traits: [] };
  return { ...l, players };
};
const moraleOf = (l: League, id: PlayerId): number => l.players[id]?.morale.morale ?? -1;

describe('weeklyMorale', () => {
  const base = calm(league, team);
  const qb2 = atDepth(base, team, 'QB', 1);
  const qb1 = atDepth(base, team, 'QB', 0);

  it('winning lifts the roster and losing drags it down', () => {
    const won = weeklyMorale(base, team.id, 3, { game: finishedGame(team.id, opp.id, 31, 10, { week: 3 }) });
    const lost = weeklyMorale(base, team.id, 3, { game: finishedGame(team.id, opp.id, 10, 31, { week: 3 }) });
    const wr = atDepth(base, team, 'WR', 0).id;
    expect(moraleOf(won, wr)).toBeGreaterThan(55);
    expect(moraleOf(lost, wr)).toBeLessThan(55);
    const avg = (l: League): number => rosterOf(l, team.id).reduce((s, p) => s + p.morale.morale, 0) / team.rosterIds.length;
    expect(avg(won)).toBeGreaterThan(avg(lost) + 2);
  });

  it('a benched starter loses morale while an active starter does not', () => {
    const benched = patchPlayer(base, qb2.id, { overall: qb1.overall + 10 });
    const bt = benched.teams[team.id] as Team;
    expect(isBenchedStarter(bt, rosterOf(benched, team.id), benched.players[qb2.id] as Player)).toBe(true);
    const after = weeklyMorale(benched, team.id, 3, { game: null });
    expect(moraleOf(after, qb2.id)).toBeLessThan(55);
    const promoted = patchTeam(benched, team.id, (t) => ({ ...t, depthChart: { ...t.depthChart, QB: [qb2.id, qb1.id, ...t.depthChart.QB.slice(2)] } }));
    const fine = weeklyMorale(promoted, team.id, 3, { game: null });
    expect(moraleOf(fine, qb2.id)).toBeGreaterThanOrEqual(55);
    expect(moraleOf(fine, qb2.id)).toBeGreaterThan(moraleOf(after, qb2.id));
  });

  it('an injured starter does not make his healthy backup "benched"', () => {
    const hurt = patchPlayer(base, qb1.id, { injury: { bodyArea: 'lowerBody', severity: 'moderate', weeksRemaining: 4, permanentPenalty: null, occurredYear: base.season.year, occurredWeek: 3 } });
    expect(isBenchedStarter(hurt.teams[team.id] as Team, rosterOf(hurt, team.id), hurt.players[qb2.id] as Player)).toBe(false);
    const after = weeklyMorale(hurt, team.id, 3, { game: finishedGame(team.id, opp.id, 20, 17, { week: 3 }) });
    expect(moraleOf(after, qb1.id)).toBeLessThan(moraleOf(after, qb2.id));
  });

  it('a hot head takes the same bad week harder', () => {
    const hot = patchPlayer(base, qb1.id, { traits: ['hotHeaded'] });
    const loss = finishedGame(team.id, opp.id, 3, 38, { week: 3 });
    const plain = weeklyMorale(base, team.id, 3, { game: loss });
    const heated = weeklyMorale(hot, team.id, 3, { game: loss });
    expect(55 - moraleOf(heated, qb1.id)).toBeGreaterThan(55 - moraleOf(plain, qb1.id));
    const benchedHot = patchPlayer(patchPlayer(base, qb2.id, { overall: qb1.overall + 10, traits: ['hotHeaded'] }), qb1.id, {});
    const benchedPlain = patchPlayer(base, qb2.id, { overall: qb1.overall + 10 });
    expect(moraleOf(weeklyMorale(benchedHot, team.id, 3, { game: null }), qb2.id)).toBeLessThan(moraleOf(weeklyMorale(benchedPlain, team.id, 3, { game: null }), qb2.id));
  });

  it('a starter who barely plays counts as benched; contract-year underpay and disgruntlement weigh on morale', () => {
    const rb = atDepth(base, team, 'RB', 0);
    const withStats: League = {
      ...patchPlayer(base, rb.id, { askingSalary: (rb.contract?.salary ?? 1_000_000) * 3, contract: rb.contract ? { ...rb.contract, yearsRemaining: 1 } : null }),
      season: {
        ...base.season,
        stats: { ...base.season.stats, [rb.id]: { ...(base.season.stats[rb.id] ?? emptyPlayerStatLine()), snaps: 6, gamesPlayed: 3 } },
        standings: { ...base.season.standings, [team.id]: { ...(base.season.standings[team.id] as League['season']['standings'][Team['id']]), results: ['W', 'L', 'W'], wins: 2, losses: 1 } },
      },
    };
    const after = weeklyMorale(withStats, team.id, 3, { game: null });
    expect(moraleOf(after, rb.id)).toBeLessThan(55);
    const sour = withClub(base, { playerFlags: { [rb.id]: ['disgruntled'] } });
    expect(moraleOf(weeklyMorale(sour, team.id, 3, { game: null }), rb.id)).toBeLessThan(moraleOf(weeklyMorale(base, team.id, 3, { game: null }), rb.id));
  });

  it('refreshes team chemistry and records tenure', () => {
    const after = weeklyMorale(base, team.id, 3, { game: null });
    expect(after.teams[team.id]?.chemistry).toBe(teamChemistry(after, after.teams[team.id] as Team));
    expect(Object.keys(after.club?.tenure ?? {}).length).toBe(team.rosterIds.length);
    // Lazily seeded tenure counts the roster as established, so chemistry does not collapse.
    expect(after.teams[team.id]?.chemistry).toBeGreaterThanOrEqual(teamChemistry(base, team) - 1);
    expect(base.club).toBeUndefined();
  });
});

describe('teamChemistry', () => {
  it('leaders among the starters raise it', () => {
    const base = calm(league, team);
    let led = base;
    for (const p of teamStarters(base, team).slice(0, 6)) led = patchPlayer(led, p.id, { traits: ['leader'] });
    expect(teamChemistry(led, team)).toBeGreaterThan(teamChemistry(base, team) + 3);
  });

  it('roster turnover and disgruntled players lower it; event bonuses raise it', () => {
    const base = calm(league, team);
    const synced = syncRosterMoves(base).league;
    const tenure = { ...(synced.club?.tenure ?? {}) };
    for (const id of team.rosterIds.slice(0, 30)) tenure[id] = { teamId: team.id, since: leagueCapYear(synced) };
    const churned = withClub(synced, { tenure });
    expect(teamChemistry(churned, team)).toBeLessThan(teamChemistry(synced, team));
    const flags = Object.fromEntries(team.rosterIds.slice(0, 4).map((id) => [id, ['disgruntled' as const]]));
    expect(teamChemistry(withClub(synced, { playerFlags: flags }), team)).toBeLessThan(teamChemistry(synced, team));
    expect(teamChemistry(withClub(synced, { chemistryBonus: { [team.id]: 5 } }), team)).toBe(Math.min(100, teamChemistry(synced, team) + 5));
  });
});

describe('game-day morale effects', () => {
  it('happy players get a boost, miserable ones a penalty, applied to attributes', () => {
    const qb = atDepth(league, team, 'QB', 0);
    const rb = atDepth(league, team, 'RB', 0);
    let l = patchPlayer(league, qb.id, { morale: { morale: 100, confidence: 100, coachRelationship: 80 } });
    l = patchPlayer(l, rb.id, { morale: { morale: 0, confidence: 0, coachRelationship: 20 } });
    const fx = moraleEffects(l, team.id);
    expect(fx[qb.id]).toBeGreaterThan(1);
    expect(fx[rb.id]).toBeLessThan(1);
    const scaled = applyMoraleEffects({ [qb.id]: l.players[qb.id] as Player, [rb.id]: l.players[rb.id] as Player }, fx);
    expect(scaled[qb.id]?.attrs.throwAccuracy).toBeGreaterThanOrEqual(qb.attrs.throwAccuracy);
    expect(scaled[rb.id]?.attrs.speed).toBeLessThanOrEqual(rb.attrs.speed);
    expect(scaled[rb.id]?.attrs.injuryResistance).toBe(rb.attrs.injuryResistance);
    expect(moraleEffects(league, 'nope' as Team['id'])).toEqual({});
  });
});

describe('syncRosterMoves', () => {
  it('seeds the ledger first, then reacts to a star changing teams', () => {
    const seeded = syncRosterMoves(league);
    expect(seeded.changes).toEqual([]);
    expect(rosterChanges(seeded.league)).toEqual([]);
    const from = aiTeam(league, 0);
    const to = aiTeam(league, 1);
    const star = rosterOf(league, from.id).sort((a, b) => b.overall - a.overall)[0] as Player;
    let l = patchPlayer(seeded.league, star.id, { overall: 90 });
    l = withClub(l, { playerFlags: { [star.id]: ['tradeBlock', 'retiring'] } });
    l = assignPlayer(l, star.id, to.id);
    const moved = syncRosterMoves(l);
    expect(moved.changes).toEqual([{ playerId: star.id, from: from.id, to: to.id, overall: 90, newcomer: false }]);
    expect(moved.league.teams[from.id]?.fans.support).toBeLessThan(l.teams[from.id]?.fans.support ?? 0);
    expect(moved.league.teams[to.id]?.fans.excitement).toBeGreaterThan(l.teams[to.id]?.fans.excitement ?? 0);
    expect(moraleOf(moved.league, star.id)).toBeLessThan(moraleOf(l, star.id));
    expect(moved.league.club?.playerFlags[star.id]).toEqual(['retiring']);
    expect(moved.league.club?.tenure?.[star.id]).toEqual({ teamId: to.id, since: leagueCapYear(l) });
    expect(syncRosterMoves(moved.league).changes).toEqual([]);
  });
});
