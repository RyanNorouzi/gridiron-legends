import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import {
  accumulateSeason, addInto, addLines, careerTotals, clonePlayerStatLine, emptyCareer, hasActivity, seasonToCareer, teamGameSummary,
} from '@/statistics/aggregate';
import { STAT_PATHS, applyDelta, isMaxStat, readStat } from '@/statistics/apply';
import { emptyGameStats, emptyPlayerStatLine } from '@/statistics/empty';
import type { PlayerStatLine, TeamStatLine } from '@/statistics/types';

const pid = (s: string): PlayerId => s as PlayerId;
const tid = (s: string): TeamId => s as TeamId;

const randomLine = (seed: number): PlayerStatLine => {
  const rng = createRng(seed);
  const line = emptyPlayerStatLine();
  for (const path of STAT_PATHS) applyDelta(line, path, rng.int(0, 60));
  return line;
};

describe('addLines', () => {
  it('sums counts, keeps max for longest fields and sums gamesPlayed', () => {
    const a = emptyPlayerStatLine();
    const b = emptyPlayerStatLine();
    a.passing.yards = 250; a.passing.longest = 45; a.gamesPlayed = 1; a.gamesStarted = 1; a.kicking.fgLong = 52;
    b.passing.yards = 180; b.passing.longest = 61; b.gamesPlayed = 1; b.kicking.fgLong = 38; b.returns.longest = 30;
    const sum = addLines(a, b);
    expect(sum.passing.yards).toBe(430);
    expect(sum.passing.longest).toBe(61);
    expect(sum.kicking.fgLong).toBe(52);
    expect(sum.returns.longest).toBe(30);
    expect(sum.gamesPlayed).toBe(2);
    expect(sum.gamesStarted).toBe(1);
  });

  it('is pure and commutative for random lines (seeded)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const a = randomLine(seed);
      const b = randomLine(seed + 100);
      const aCopy = clonePlayerStatLine(a);
      const ab = addLines(a, b);
      const ba = addLines(b, a);
      expect(a).toEqual(aCopy);
      expect(ab).toEqual(ba);
      for (const path of STAT_PATHS) {
        const expected = isMaxStat(path) ? Math.max(readStat(a, path), readStat(b, path)) : readStat(a, path) + readStat(b, path);
        expect(readStat(ab, path)).toBe(expected);
      }
    }
  });

  it('adding an empty line is the identity', () => {
    const a = randomLine(7);
    expect(addLines(a, emptyPlayerStatLine())).toEqual(a);
    expect(addLines(emptyPlayerStatLine(), a)).toEqual(a);
  });

  it('addInto mutates the target and returns it', () => {
    const target = emptyPlayerStatLine();
    const src = emptyPlayerStatLine();
    src.rushing.yards = 12;
    expect(addInto(target, src)).toBe(target);
    expect(target.rushing.yards).toBe(12);
  });
});

describe('accumulateSeason', () => {
  const teamOf = { home: tid('HOU'), away: tid('AWY') };

  it('creates season lines on demand, credits one game per appearance and keys team stats by teamOf', () => {
    const season = { stats: {} as Record<PlayerId, PlayerStatLine>, teamStats: {} as Record<TeamId, TeamStatLine> };
    const g1 = emptyGameStats();
    g1.players[pid('qb')] = emptyPlayerStatLine();
    g1.players[pid('qb')]!.snaps = 60;
    g1.players[pid('qb')]!.passing.yards = 300;
    g1.players[pid('qb')]!.passing.longest = 40;
    g1.players[pid('bench')] = emptyPlayerStatLine(); // dressed, no snaps: no game credited
    g1.teams.home.points = 24; g1.teams.away.points = 17; g1.teams.home.totalYards = 400;
    accumulateSeason(season, g1, teamOf);
    expect(season.stats[pid('qb')]?.gamesPlayed).toBe(1);
    expect(season.stats[pid('qb')]?.passing.yards).toBe(300);
    expect(season.stats[pid('bench')]?.gamesPlayed).toBe(0);
    expect(season.teamStats[tid('HOU')]?.points).toBe(24);
    expect(season.teamStats[tid('AWY')]?.points).toBe(17);

    const g2 = emptyGameStats();
    g2.players[pid('qb')] = emptyPlayerStatLine();
    g2.players[pid('qb')]!.snaps = 55;
    g2.players[pid('qb')]!.gamesPlayed = 1; // producer recorded it explicitly: not double counted
    g2.players[pid('qb')]!.passing.yards = 150;
    g2.players[pid('qb')]!.passing.longest = 25;
    g2.teams.home.points = 3; g2.teams.away.points = 30;
    accumulateSeason(season, g2, teamOf);
    expect(season.stats[pid('qb')]?.gamesPlayed).toBe(2);
    expect(season.stats[pid('qb')]?.passing.yards).toBe(450);
    expect(season.stats[pid('qb')]?.passing.longest).toBe(40);
    expect(season.teamStats[tid('HOU')]?.points).toBe(27);
    expect(season.teamStats[tid('AWY')]?.points).toBe(47);
    expect(season.teamStats[tid('HOU')]?.totalYards).toBe(400);
    // The game's own stats are untouched.
    expect(g1.players[pid('qb')]?.gamesPlayed).toBe(0);
  });

  it('credits a game to a kicker whose producer recorded no snaps but did record a kick', () => {
    const season = { stats: {} as Record<PlayerId, PlayerStatLine>, teamStats: {} as Record<TeamId, TeamStatLine> };
    const g = emptyGameStats();
    g.players[pid('k')] = emptyPlayerStatLine();
    g.players[pid('k')]!.kicking.fgAttempts = 2;
    g.players[pid('k')]!.kicking.fgMade = 1;
    g.players[pid('k')]!.kicking.fgLong = 44;
    g.players[pid('idle')] = emptyPlayerStatLine();
    expect(hasActivity(g.players[pid('k')]!)).toBe(true);
    expect(hasActivity(g.players[pid('idle')]!)).toBe(false);
    accumulateSeason(season, g, teamOf);
    expect(season.stats[pid('k')]?.gamesPlayed).toBe(1);
    expect(season.stats[pid('k')]?.kicking.fgLong).toBe(44);
    expect(season.stats[pid('idle')]?.gamesPlayed).toBe(0);
    accumulateSeason(season, g, teamOf);
    expect(season.stats[pid('k')]?.gamesPlayed).toBe(2);
    expect(season.stats[pid('k')]?.kicking.fgAttempts).toBe(4);
  });
});

describe('careers', () => {
  it('emptyCareer has no seasons and zero totals', () => {
    const c = emptyCareer(pid('p1'));
    expect(c.playerId).toBe('p1');
    expect(c.seasons).toEqual([]);
    expect(c.totals).toEqual(emptyPlayerStatLine());
  });

  it('seasonToCareer appends seasons sorted by year, totals regular season only, and is pure', () => {
    const s1 = emptyPlayerStatLine(); s1.rushing.yards = 1000; s1.rushing.longest = 60; s1.gamesPlayed = 16;
    const s2 = emptyPlayerStatLine(); s2.rushing.yards = 1200; s2.rushing.longest = 45; s2.gamesPlayed = 17;
    const po = emptyPlayerStatLine(); po.rushing.yards = 150; po.gamesPlayed = 2;
    const c0 = emptyCareer(pid('rb'));
    const c2 = seasonToCareer(c0, 2027, tid('B'), s2, po);
    const c1 = seasonToCareer(c2, 2026, tid('A'), s1, null);
    expect(c0.seasons).toHaveLength(0);
    expect(c1.seasons.map((s) => s.year)).toEqual([2026, 2027]);
    expect(c1.seasons[0]?.teamId).toBe('A');
    expect(c1.seasons[1]?.playoffLine?.rushing.yards).toBe(150);
    expect(c1.totals.rushing.yards).toBe(2200);
    expect(c1.totals.rushing.longest).toBe(60);
    expect(c1.totals.gamesPlayed).toBe(33);
    expect(careerTotals(c1.seasons, true).rushing.yards).toBe(150);
    // Stored lines are copies.
    s1.rushing.yards = 0;
    expect(c1.seasons[0]?.line.rushing.yards).toBe(1000);
  });

  it('re-adding the same year replaces the entry (idempotent offseason step)', () => {
    const s = emptyPlayerStatLine(); s.receiving.yards = 900;
    const c1 = seasonToCareer(emptyCareer(pid('wr')), 2026, tid('A'), s, null);
    const s2 = emptyPlayerStatLine(); s2.receiving.yards = 950;
    const c2 = seasonToCareer(c1, 2026, tid('A'), s2, null);
    expect(c2.seasons).toHaveLength(1);
    expect(c2.totals.receiving.yards).toBe(950);
  });
});

describe('teamGameSummary', () => {
  it('computes box-score rates and the winner', () => {
    const g = emptyGameStats();
    Object.assign(g.teams.home, { points: 27, pointsAgainst: 20, totalYards: 380, plays: 60, thirdDownAttempts: 12, thirdDownConversions: 6, redZoneTrips: 4, redZoneTouchdowns: 3, turnovers: 1, takeaways: 2, successfulPlays: 30, epa: 6 });
    Object.assign(g.teams.away, { points: 20, pointsAgainst: 27, totalYards: 300, plays: 50, turnovers: 2, takeaways: 1 });
    const s = teamGameSummary(g);
    expect(s.winner).toBe('home');
    expect(s.home.yardsPerPlay).toBeCloseTo(380 / 60, 10);
    expect(s.home.thirdDownPct).toBeCloseTo(50, 10);
    expect(s.home.redZonePct).toBeCloseTo(75, 10);
    expect(s.home.turnoverMargin).toBe(1);
    expect(s.away.turnoverMargin).toBe(-1);
    expect(s.home.successRate).toBeCloseTo(0.5, 10);
    expect(s.home.epaPerPlay).toBeCloseTo(0.1, 10);
    expect(s.away.thirdDownPct).toBe(0);
    expect(s.away.fourthDownPct).toBe(0);
    g.teams.away.points = 27;
    expect(teamGameSummary(g).winner).toBeNull();
  });
});
