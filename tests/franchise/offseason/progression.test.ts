import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { computeOverall } from '@/players/attributes';
import { generateAttributes } from '@/players/generator';
import type { Player } from '@/players/types';
import {
  advanceAges, coachDevelopmentFor, facilityLevelFor, isIncomingRookie, offseasonProgression, snapsFor, teamSuccessFor, weeklyDevelopment,
} from '@/franchise/progression';
import { progressionFacilityLevel } from '@/franchise/facilities';
import { coachDevelopmentFor as staffDevelopmentFor } from '@/franchise/staff';
import type { League } from '@/franchise/types';
import { atPhase, bumpYear, makeLeague, rostered, standing, statLine, teamIds, withPlayer } from './helpers';

/** Sets every staff member's development rating and both development facilities of a team. */
const setClub = (league: League, teamId: TeamId, rating: number, facility: number): League => {
  const team = league.teams[teamId]!;
  const coaches = { ...league.coaches };
  for (const id of team.staffIds) coaches[id] = { ...coaches[id]!, ratings: { ...coaches[id]!.ratings, playerDevelopment: rating } };
  return { ...league, coaches, teams: { ...league.teams, [teamId]: { ...team, facilities: { ...team.facilities, development: facility, training: facility } } } };
};

/** A 21-year-old 70/90 quarterback on the first team with a given club quality. */
const prospectLeague = (rating: number, facility: number): { league: League; id: PlayerId } => {
  let league = atPhase(makeLeague(61), 'trainingCamp');
  const [t1] = teamIds(league) as [TeamId];
  league = setClub(league, t1, rating, facility);
  const base = rostered(league, t1, 'QB');
  const attrs = generateAttributes(createRng(5), 'QB', 70);
  const qb: Player = {
    ...base, age: 21, experience: 1, rookieYear: league.season.year - 1, devTrait: 'normal', traits: [], attrs, overall: computeOverall(attrs, 'QB'),
    potential: 90, injury: null, injuryHistory: [], progressionLog: [], trainingFocus: null, morale: { morale: 60, confidence: 60, coachRelationship: 60 },
  };
  league = withPlayer(league, qb);
  league = { ...league, season: { ...league.season, stats: { [qb.id]: statLine({ snaps: 200 }) } } };
  return { league, id: qb.id };
};

/** Runs `years` offseasons (aging then progression), returning the player's history. */
const develop = (league0: League, id: PlayerId, years: number, seed: number): Player[] => {
  let league = league0;
  const out: Player[] = [];
  for (let i = 0; i < years; i++) {
    league = advanceAges(league);
    league = offseasonProgression(league, createRng(seed * 1000 + i)).league;
    out.push(league.players[id]!);
    league = bumpYear(league);
  }
  return out;
};

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('offseasonProgression over a career', () => {
  it('a 21-year-old 70/90 reaches the high 80s with a good coach and facility, less with bad ones; potential respected', () => {
    const good = prospectLeague(95, 5);
    const bad = prospectLeague(5, 1);
    expect(good.league.players[good.id]!.overall).toBeGreaterThanOrEqual(68);
    const goodFinal: number[] = [], badFinal: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      for (const [ctx, sink] of [[good, goodFinal], [bad, badFinal]] as const) {
        const hist = develop(ctx.league, ctx.id, 8, seed);
        for (const p of hist) expect(p.overall).toBeLessThanOrEqual(p.potential);
        const last = hist[hist.length - 1]!;
        expect(last.age).toBe(29);
        expect(last.progressionLog).toHaveLength(8);
        sink.push(last.overall);
      }
    }
    expect(mean(goodFinal)).toBeGreaterThanOrEqual(86);
    expect(Math.max(...goodFinal)).toBeLessThanOrEqual(99);
    expect(mean(badFinal)).toBeLessThan(mean(goodFinal) - 2);
  }, 30_000);

  it('a 33-year-old receiver declines', () => {
    let league = atPhase(makeLeague(62), 'trainingCamp');
    const [t1] = teamIds(league) as [TeamId];
    const wr = { ...rostered(league, t1, 'WR'), age: 33, traits: [], injury: null, injuryHistory: [] };
    league = withPlayer(league, wr);
    let declined = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const hist = develop(league, wr.id, 3, seed);
      if (hist[2]!.overall < wr.overall) declined++;
      expect(hist[2]!.potential).toBeLessThanOrEqual(Math.max(wr.potential, wr.overall) + 2);
    }
    expect(declined).toBeGreaterThanOrEqual(9);
  });
});

describe('progression context and guards', () => {
  it('derives development context from staff, facilities, snaps and standings', () => {
    const { league } = prospectLeague(90, 4);
    const [t1] = teamIds(league) as [TeamId];
    const team = league.teams[t1]!;
    // Delegates to the club layer (staff.ts): all development ratings at 90, plus the head coach's developer bonus if any.
    expect(coachDevelopmentFor(league, team, 'QB')).toBe(staffDevelopmentFor(league, team, 'QB'));
    expect(coachDevelopmentFor(league, team, 'QB')).toBeGreaterThanOrEqual(90);
    expect(coachDevelopmentFor(setClub(league, t1, 20, 4), team, 'QB')).toBeLessThan(40);
    expect(coachDevelopmentFor(league, null, 'QB')).toBe(35);
    expect(facilityLevelFor(team)).toBeCloseTo(4);
    const lopsided = { ...team, facilities: { ...team.facilities, development: 5, training: 1 } };
    expect(facilityLevelFor(lopsided, undefined, { age: 21 })).toBe(progressionFacilityLevel(lopsided, { age: 21 }));
    expect(facilityLevelFor(lopsided, undefined, { age: 21 })).toBeGreaterThan(facilityLevelFor(lopsided, undefined, { age: 31 }));
    expect(facilityLevelFor(null)).toBe(1);
    const p = rostered(league, t1, 'WR');
    const withStats = { ...league, season: { ...league.season, stats: { [p.id]: statLine({ snaps: 0, gamesStarted: 10, gamesPlayed: 16 }) } } };
    expect(snapsFor(withStats, p.id)).toBe(10 * 55 + 6 * 20);
    const standings = { ...league.season.standings, [t1]: standing(t1, 12, 5) };
    const champs = { ...league, season: { ...league.season, standings, champion: t1 } };
    expect(teamSuccessFor(champs, t1)).toBeCloseTo(12 / 17 + 0.15);
    expect(teamSuccessFor(champs, null)).toBe(0.4);
  });

  it('is a no-op the second time in a season, skips incoming rookies and reports notable changes', () => {
    let league = atPhase(makeLeague(63), 'trainingCamp');
    const [t1] = teamIds(league) as [TeamId];
    const rookie = { ...rostered(league, t1, 'CB'), rookieYear: league.season.year + 1, experience: 0 };
    league = withPlayer(league, rookie);
    expect(isIncomingRookie(league, rookie)).toBe(true);
    const first = offseasonProgression(league, createRng(1));
    expect(first.entries.length).toBeGreaterThan(1000);
    expect(first.entries.some((e) => e.playerId === rookie.id)).toBe(false);
    expect(first.league.players[rookie.id]).toBe(league.players[rookie.id]);
    const second = offseasonProgression(first.league, createRng(2));
    expect(second.entries).toEqual([]);
    expect(second.league.players).toEqual(first.league.players);
    const moved = first.entries.filter((e) => e.overallAfter !== e.overallBefore);
    expect(moved.length).toBeGreaterThan(100);
    const t = first.league.teams[t1]!;
    const roster = t.rosterIds.map((id) => first.league.players[id]!);
    expect(roster.every((p) => p.progressionLog.length > 0 || p.id === rookie.id)).toBe(true);
  });

  it('ages everyone but incoming rookies exactly once per offseason', () => {
    let league = atPhase(makeLeague(64), 'offseason');
    const [t1] = teamIds(league) as [TeamId];
    const vet = rostered(league, t1, 'QB');
    const rookie = { ...rostered(league, t1, 'RB'), rookieYear: league.season.year + 1, experience: 0 };
    league = withPlayer(league, rookie);
    const once = advanceAges(league);
    expect(once.players[vet.id]).toMatchObject({ age: vet.age + 1, experience: vet.experience + 1 });
    expect(once.players[rookie.id]).toMatchObject({ age: rookie.age, experience: 0 });
    expect(advanceAges(once)).toBe(once);
  });
});

describe('weeklyDevelopment', () => {
  it('gives young players with snaps small gains, never past potential, once per week', () => {
    let league = atPhase(makeLeague(65), 'regularSeason');
    const young = Object.values(league.players).filter((p) => p.teamId !== null && p.age <= 23);
    const stats = Object.fromEntries(young.map((p) => [p.id, statLine({ snaps: 600 })]));
    league = { ...league, season: { ...league.season, week: 10, stats } };
    let cur = league;
    for (let week = 1; week <= 10; week++) cur = weeklyDevelopment(cur, week, createRng(week));
    const gained = young.filter((p) => cur.players[p.id]!.overall > p.overall || computeOverall(cur.players[p.id]!.attrs, p.position) !== computeOverall(p.attrs, p.position));
    expect(gained.length).toBeGreaterThan(0);
    for (const p of young) {
      const now = cur.players[p.id]!;
      expect(now.overall).toBeLessThanOrEqual(Math.max(p.potential, p.overall));
      expect(now.overall - p.overall).toBeLessThanOrEqual(3);
    }
    const old = Object.values(league.players).find((p) => p.teamId !== null && p.age >= 30)!;
    expect(cur.players[old.id]).toBe(league.players[old.id]);
    expect(weeklyDevelopment(cur, 10, createRng(99))).toBe(cur);
  });

  it('estimates snaps from games started when the simulator does not track snaps', () => {
    let league = atPhase(makeLeague(66), 'regularSeason');
    const young = Object.values(league.players).filter((p) => p.teamId !== null && p.age <= 23 && p.overall < p.potential);
    const stats = Object.fromEntries(young.map((p) => [p.id, statLine({ snaps: 0, gamesPlayed: 10, gamesStarted: 10 })]));
    league = { ...league, season: { ...league.season, week: 10, stats } };
    let cur = league;
    for (let week = 1; week <= 10; week++) cur = weeklyDevelopment(cur, week, createRng(100 + week));
    expect(young.some((p) => cur.players[p.id]!.attrs !== p.attrs)).toBe(true);
  });
});
