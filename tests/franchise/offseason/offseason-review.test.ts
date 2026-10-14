/**
 * Regression tests from the offseason review: honoured retirement announcements retire the player, in-season
 * development responds to the staff and facilities, the medical center softens camp injuries, and Coach of the
 * Year goes to a coach with a non-losing season when there is one.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { computeAwards } from '@/franchise/awards';
import { weeklyClubFactor } from '@/franchise/progression';
import { runRetirements } from '@/franchise/retirement';
import { runTrainingCamp } from '@/franchise/training-camp';
import type { League } from '@/franchise/types';
import type { CoachRatings, Team } from '@/teams/types';
import { atPhase, flatStandings, makeLeague, rostered, standing, teamIds } from './helpers';

const withFacilities = (league: League, level: number): League => {
  const teams: League['teams'] = { ...league.teams };
  for (const t of Object.values(league.teams)) teams[t.id] = { ...t, facilities: { ...t.facilities, medical: level, training: level, development: level } };
  return { ...league, teams };
};
const withStaffRating = (league: League, team: Team, v: number): League => {
  const ratings: CoachRatings = { offense: v, defense: v, playerDevelopment: v, motivation: v, gameManagement: v, scouting: v, conditioning: v };
  const coaches = { ...league.coaches };
  for (const id of team.staffIds) if (coaches[id]) coaches[id] = { ...coaches[id]!, ratings, traits: [] };
  return { ...league, coaches };
};

describe('retirement announcements', () => {
  it('a player the club flagged as retiring retires at the next pass, whatever his age', () => {
    const league = atPhase(makeLeague(12), 'offseason');
    const [t1] = teamIds(league);
    const young = rostered(league, t1!, 'WR', 0);
    const flagged: League = { ...league, club: { rivalries: {}, staffDeadMoney: {}, facilityUpgrades: {}, ownerSubsidy: {}, playerFlags: { [young.id]: ['retiring'] } } };
    const r = runRetirements(flagged, createRng(3));
    expect(r.retired.map((x) => x.playerId)).toContain(young.id);
    expect(r.league.players[young.id]).toBeUndefined();
    expect(r.league.retiredPlayers[young.id]).toBeDefined();
    expect(runRetirements(league, createRng(3)).retired.map((x) => x.playerId)).not.toContain(young.id);
  });
});

describe('in-season development', () => {
  it('good staff and facilities raise the weekly growth chance', () => {
    const league = makeLeague(13);
    const team = league.teams[teamIds(league)[0]!]!;
    const young = { age: 22, position: 'QB' as const };
    const poor = withFacilities(withStaffRating(league, team, 20), 1);
    const great = withFacilities(withStaffRating(league, team, 95), 5);
    const lo = weeklyClubFactor(poor, poor.teams[team.id]!, young);
    const hi = weeklyClubFactor(great, great.teams[team.id]!, young);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0.75);
    expect(hi).toBeLessThan(1.25 * 1.12 * 1.16 + 1e-9);
  });
});

describe('camp injuries and the medical center', () => {
  it('a top medical center means fewer weeks lost at a hard camp', () => {
    const league = atPhase(makeLeague(71), 'trainingCamp');
    const weeksLost = (l: League): number =>
      runTrainingCamp(l, createRng(9), { intensity: 'hard', aiIntensity: 'hard' }).reports.reduce((s, r) => s + r.injuries.reduce((a, i) => a + i.weeksOut, 0), 0);
    const basic = weeksLost(withFacilities(league, 1));
    const top = weeksLost(withFacilities(league, 5));
    expect(basic).toBeGreaterThan(0);
    expect(top).toBeLessThan(basic);
  });
});

describe('Coach of the Year', () => {
  it('prefers a non-losing season over a bigger over-performance in a losing one', () => {
    const league = atPhase(makeLeague(14), 'awards');
    const byRating = Object.values(league.teams).sort((a, b) => a.overall - b.overall || (a.id < b.id ? -1 : 1));
    const weakest = byRating[0]!;
    const strongest = byRating[byRating.length - 1]!;
    const standings = { ...flatStandings(league, 7, 10), [weakest.id]: standing(weakest.id, 8, 9), [strongest.id]: standing(strongest.id, 9, 8) };
    const coy = computeAwards({ ...league, season: { ...league.season, standings } }).find((a) => a.award === 'COY');
    expect(coy?.teamId).toBe(strongest.id);
    const allLosing = { ...standings, [strongest.id]: standing(strongest.id, 7, 10) };
    expect(computeAwards({ ...league, season: { ...league.season, standings: allLosing } }).find((a) => a.award === 'COY')?.teamId).toBe(weakest.id);
  });
});
