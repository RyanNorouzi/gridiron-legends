import { describe, expect, it } from 'vitest';
import type { CoachId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { leagueCapYear } from '@/franchise/contracts';
import {
  STAFF_TUNING, advanceStaffYear, availableCoaches, coachAsk, coachDevelopmentFor, coachMarket, coachOfYearInputs, coachRecord, fireCoach,
  hireCoach, recordCoachPlayoffResults, retirementChance, staffEffects, staffPayroll, teamStaff,
} from '@/franchise/staff';
import type { League } from '@/franchise/types';
import { STAFF_ROLES } from '@/teams/coach-generator';
import type { Coach, CoachRatings, StaffRole, Team } from '@/teams/types';
import { aiTeam, clubLeague, finishedGame, patchStanding, patchTeam, userTeamOf, withPhase } from './helpers';

const league = clubLeague();
const team = userTeamOf(league);

const ratingsOf = (v: number): CoachRatings => ({ offense: v, defense: v, playerDevelopment: v, motivation: v, gameManagement: v, scouting: v, conditioning: v });
const withStaffRatings = (l: League, t: Team, v: number): League => {
  const coaches = { ...l.coaches };
  for (const id of t.staffIds) {
    const c = coaches[id];
    if (c) coaches[id] = { ...c, ratings: ratingsOf(v), traits: [] };
  }
  return { ...l, coaches };
};
const coachIn = (l: League, t: Team, role: StaffRole): Coach => {
  const c = teamStaff(l, t)[role];
  if (!c) throw new Error(`no ${role}`);
  return c;
};
const patchCoach = (l: League, id: CoachId, patch: Partial<Coach>): League => ({ ...l, coaches: { ...l.coaches, [id]: { ...(l.coaches[id] as Coach), ...patch } } });

describe('staffEffects', () => {
  it('scale with the coaches ratings', () => {
    const hi = staffEffects(withStaffRatings(league, team, 90), team);
    const lo = staffEffects(withStaffRatings(league, team, 30), team);
    expect(hi.developmentBonus).toBeGreaterThan(0);
    expect(lo.developmentBonus).toBeLessThan(0);
    expect(hi.developmentRating).toBeGreaterThan(lo.developmentRating);
    expect(hi.injuryRecoveryBonus).toBeGreaterThan(lo.injuryRecoveryBonus);
    expect(hi.injuryRecoveryBonus).toBeLessThanOrEqual(STAFF_TUNING.injuryRecoveryMax);
    expect(hi.scoutingBonus).toBeGreaterThan(lo.scoutingBonus);
    expect(hi.gameManagement).toBe(90);
    expect(hi.motivation).toBeGreaterThan(lo.motivation);
    expect(hi.conditioning).toBeGreaterThan(lo.conditioning);
    for (const g of Object.keys(hi.positionCoachBonus) as (keyof typeof hi.positionCoachBonus)[]) {
      expect(hi.positionCoachBonus[g]).toBeGreaterThan(lo.positionCoachBonus[g]);
    }
  });

  it('a vacant role counts as replacement level and traits add a bonus', () => {
    const l = withStaffRatings(league, team, 80);
    const qbCoach = coachIn(l, team, 'QBCoach');
    const vacant = { ...team, staffIds: team.staffIds.filter((id) => id !== qbCoach.id) };
    expect(staffEffects(l, vacant).positionCoachBonus.QB).toBeLessThan(staffEffects(l, team).positionCoachBonus.QB);
    expect(staffEffects(l, vacant).positionCoachBonus.RB).toBeCloseTo(staffEffects(l, team).positionCoachBonus.RB);
    const hc = coachIn(l, team, 'HC');
    const clock = patchCoach(l, hc.id, { traits: ['clockManager', 'developer'] });
    expect(staffEffects(clock, team).gameManagement).toBe(80 + STAFF_TUNING.traitBonus);
    expect(staffEffects(clock, team).developmentRating).toBeGreaterThan(staffEffects(l, team).developmentRating);
  });

  it('coachDevelopmentFor follows the position coach of the player', () => {
    const l = withStaffRatings(league, team, 50);
    const qbCoach = coachIn(l, team, 'QBCoach');
    const great = patchCoach(l, qbCoach.id, { ratings: { ...qbCoach.ratings, playerDevelopment: 95 } });
    expect(coachDevelopmentFor(great, team, 'QB')).toBeGreaterThan(coachDevelopmentFor(l, team, 'QB'));
    expect(coachDevelopmentFor(great, team, 'CB')).toBe(coachDevelopmentFor(l, team, 'CB'));
  });
});

describe('hiring and firing', () => {
  it('firing frees the coach and books dead money over his remaining years', () => {
    const oc = coachIn(league, team, 'OC');
    const l = patchCoach(league, oc.id, { salary: 2_000_000, contractYears: 3 });
    const before = staffPayroll(l, team.id);
    const r = fireCoach(l, team.id, oc.id);
    expect(r.ok).toBe(true);
    expect(r.league.coaches[oc.id]?.teamId).toBeNull();
    expect(r.league.teams[team.id]?.staffIds).not.toContain(oc.id);
    const year = leagueCapYear(l);
    const owed = r.league.club?.staffDeadMoney[team.id] ?? {};
    expect(owed[year]).toBe(1_200_000);
    expect(owed[year + 1]).toBe(1_200_000);
    expect(owed[year + 2]).toBe(1_200_000);
    expect(owed[year + 3]).toBeUndefined();
    expect(r.deadMoney).toBe(3_600_000);
    const after = staffPayroll(r.league, team.id);
    expect(after.active).toBe(before.active - 2_000_000);
    expect(after.dead).toBe(1_200_000);
    expect(after.total).toBe(after.active + after.dead);
    expect(fireCoach(r.league, team.id, oc.id).ok).toBe(false);
  });

  it('hiring needs a vacancy, a fair offer and cash for the fee', () => {
    const oc = coachIn(league, team, 'OC');
    const market = coachMarket(league, createRng(4)).league;
    const candidate = availableCoaches(market, 'OC')[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(hireCoach(market, team.id, candidate.id).ok).toBe(false);
    const fired = fireCoach(market, team.id, oc.id).league;
    const ask = coachAsk(fired, candidate);
    const lowball = hireCoach(fired, team.id, candidate.id, { salary: Math.round(ask * 0.5) });
    expect(lowball.ok).toBe(false);
    expect(lowball.league).toBe(fired);
    const broke = patchTeam(fired, team.id, (t) => ({ ...t, finances: { ...t.finances, cash: 0 } }));
    expect(hireCoach(broke, team.id, candidate.id).ok).toBe(false);
    expect(hireCoach(fired, team.id, candidate.id, { years: 9 }).ok).toBe(false);
    const hired = hireCoach(fired, team.id, candidate.id, { years: 3 });
    expect(hired.ok).toBe(true);
    expect(hired.cashPaid).toBe(Math.round((ask * STAFF_TUNING.hiringFeeShare) / 10_000) * 10_000);
    expect(hired.league.teams[team.id]?.finances.cash).toBe((fired.teams[team.id]?.finances.cash ?? 0) - hired.cashPaid);
    expect(hired.league.coaches[candidate.id]).toMatchObject({ teamId: team.id, salary: ask, contractYears: 3 });
    expect(teamStaff(hired.league, hired.league.teams[team.id] as Team).OC?.id).toBe(candidate.id);
    expect(hireCoach(hired.league, team.id, candidate.id).ok).toBe(false);
  });

  it('replace fires the incumbent and a new head coach resets the players toward a neutral relationship', () => {
    const hc = coachIn(league, team, 'HC');
    const market = coachMarket(league, createRng(5)).league;
    const candidate = availableCoaches(market, 'HC')[0];
    if (!candidate) throw new Error('no HC on the market');
    const pid = team.rosterIds[0];
    if (!pid) throw new Error('empty roster');
    const tuned: League = { ...market, players: { ...market.players, [pid]: { ...market.players[pid]!, morale: { morale: 60, confidence: 60, coachRelationship: 98 } } } };
    const r = hireCoach(tuned, team.id, candidate.id, { replace: true });
    expect(r.ok).toBe(true);
    expect(r.deadMoney).toBeGreaterThan(0);
    expect(r.league.teams[team.id]?.headCoachId).toBe(candidate.id);
    expect(r.league.coaches[hc.id]?.teamId).toBeNull();
    expect(r.league.players[pid]?.morale.coachRelationship).toBeLessThan(98);
  });
});

describe('coach market and yearly turnover', () => {
  it('coachMarket tops up every role deterministically with unattached coaches', () => {
    const a = coachMarket(league, createRng(9));
    const b = coachMarket(league, createRng(9));
    expect(a.market.map((c) => c.id)).toEqual(b.market.map((c) => c.id));
    for (const role of STAFF_ROLES) expect(availableCoaches(a.league, role).length).toBeGreaterThanOrEqual(3);
    expect(availableCoaches(a.league, 'HC').length).toBeGreaterThanOrEqual(STAFF_TUNING.marketSize.HC);
    for (const c of a.market) {
      expect(c.teamId).toBeNull();
      expect(c.salary).toBe(coachAsk(a.league, c));
    }
  });

  it('retirement becomes likely with age and certain at the forced age', () => {
    expect(retirementChance(50)).toBe(0);
    expect(retirementChance(66)).toBeGreaterThan(retirementChance(63));
    expect(retirementChance(STAFF_TUNING.forcedRetirementAge)).toBe(1);
  });

  it('advanceStaffYear ages coaches, retires the old, and AI teams fill their vacancies', () => {
    const ai = aiTeam(league, 2);
    const hc = coachIn(league, ai, 'HC');
    const scout = coachIn(league, ai, 'Scout');
    let l = withPhase(league, 'offseason', 0);
    l = patchCoach(l, hc.id, { age: 90 });
    l = patchCoach(l, scout.id, { contractYears: 1, ratings: ratingsOf(20) });
    const otherCoach = coachIn(l, userTeamOf(l), 'OC');
    const r = advanceStaffYear(l, createRng(12));
    expect(r.report.retired).toContain(hc.id);
    expect(r.report.released).toContain(scout.id);
    expect(r.league.coaches[hc.id]).toBeUndefined();
    const newHc = r.league.teams[ai.id]?.headCoachId;
    expect(newHc).toBeTruthy();
    expect(newHc).not.toBe(hc.id);
    expect(r.league.coaches[newHc as CoachId]?.teamId).toBe(ai.id);
    expect(teamStaff(r.league, r.league.teams[ai.id] as Team).Scout?.id).not.toBe(scout.id);
    expect(r.report.hired.some((h) => h.teamId === ai.id)).toBe(true);
    expect(r.league.coaches[otherCoach.id]?.age).toBe(otherCoach.age + 1);
    for (const t of Object.values(r.league.teams)) {
      for (const id of t.staffIds) expect(r.league.coaches[id]?.teamId).toBe(t.id);
    }
  });
});

describe('coach records', () => {
  it('playoff results credit the head coaches', () => {
    const other = aiTeam(league, 0);
    const g = finishedGame(team.id, other.id, 27, 20, { isPlayoff: true, playoffRound: 1 });
    const l = recordCoachPlayoffResults(league, [g, finishedGame(team.id, other.id, 10, 3)]);
    const winner = coachRecord(l, team.headCoachId as CoachId);
    const loser = coachRecord(l, other.headCoachId as CoachId);
    expect(winner?.playoffWins).toBe(1);
    expect(winner?.playoffLosses).toBe(0);
    expect(loser?.playoffLosses).toBe(1);
  });

  it('coachRecord includes the season in progress', () => {
    const hc = coachIn(league, team, 'HC');
    const l = patchStanding(league, team.id, { wins: 5, losses: 2 });
    const rec = coachRecord(l, hc.id);
    expect(rec?.wins).toBe(hc.careerWins + 5);
    expect(rec?.losses).toBe(hc.careerLosses + 2);
    expect(rec?.seasonWins).toBe(5);
  });

  it('Coach of the Year inputs rank over-performers first', () => {
    const teams = Object.values(league.teams).sort((a, b) => a.overall - b.overall);
    const weakest = teams[0] as Team;
    const strongest = teams[teams.length - 1] as Team;
    let l = league;
    for (const t of teams) l = patchStanding(l, t.id, { wins: 7, losses: 7 });
    l = patchStanding(l, weakest.id, { wins: 13, losses: 1 });
    l = patchStanding(l, strongest.id, { wins: 2, losses: 12 });
    const inputs = coachOfYearInputs(l);
    expect(inputs[0]?.teamId).toBe(weakest.id);
    expect(inputs[0]?.overPerformance).toBeGreaterThan(0.3);
    expect(inputs[inputs.length - 1]?.teamId).toBe(strongest.id);
  });
});
