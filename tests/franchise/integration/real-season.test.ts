/**
 * The franchise loop on the REAL whole-game simulator (sim-real.ts over simulation/game-sim.ts): six regular-season
 * weeks of snap-by-snap games through advanceLeagueWeek's default simulator (the preseason is skipped with the
 * fallback model to save time). Checks the seam mapping (scores, box scores, weather, injuries, play logs kept only
 * for user-team games) and that season stat leaders extrapolate to plausible 17-game totals.
 *
 * Calibration (full 17-week run, seed 5): passing leader ~3,550 yds (top six 3,100-3,560), rushing leaders
 * ~1,880-2,090 yds (every team's RB1 takes nearly all carries), receiving leader ~1,680 yds, sack leader 18.
 * Six-week samples are noisier, so the bands below leave room for it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { createLeague } from '@/franchise';
import { gameWeather } from '@/franchise/game-setup';
import { advanceLeagueWeek, simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { realGameSimulator } from '@/franchise/sim-real';
import type { League, ScheduledGame } from '@/franchise/types';
import type { PlayerStatLine } from '@/statistics/types';

const WEEKS = 6;
let before: League;
let league: League;
let games: ScheduledGame[] = [];

const perSeason = (total: number, gp: number): number => (total / Math.max(1, gp)) * 17;
const leaders = (l: League, pos: readonly string[], stat: (s: PlayerStatLine) => number): number[] =>
  (Object.entries(l.season.stats) as [PlayerId, PlayerStatLine][])
    .filter(([id, s]) => pos.includes(l.players[id]?.position ?? '') && s.gamesPlayed >= WEEKS - 2)
    .map(([, s]) => perSeason(stat(s), s.gamesPlayed))
    .sort((a, b) => b - a);

describe('a regular season on the real game simulator', () => {
  beforeAll(() => {
    before = simulateToPhase(createLeague({ seed: 5, userTeamAbbr: 'BOS' }), 'regularSeason', { simulator: fallbackSimulator, rng: createRng(1) }).league;
    league = before;
    for (let w = 0; w < WEEKS; w++) {
      const r = advanceLeagueWeek(league, { rng: createRng(100 + w) });
      league = r.league;
      games.push(...r.games);
    }
  }, 90_000);

  it('plays every scheduled game with plausible scores', () => {
    expect(league.season.week).toBe(WEEKS + 1);
    expect(games.length).toBeGreaterThan(WEEKS * 13);
    const points = games.flatMap((g) => [g.result!.homeScore, g.result!.awayScore]);
    const avg = points.reduce((a, b) => a + b, 0) / points.length;
    expect(avg).toBeGreaterThan(14);
    expect(avg).toBeLessThan(32);
    expect(games.filter((g) => g.result!.homeScore === g.result!.awayScore).length).toBeLessThanOrEqual(2);
  });

  it('maps box scores, weather, injuries and play logs through the seam', () => {
    for (const g of games) {
      const r = g.result!;
      expect(r.stats.teams.home.points).toBe(r.homeScore);
      expect(r.stats.teams.away.points).toBe(r.awayScore);
      const lines = Object.values(r.stats.players);
      const sum = (f: (s: PlayerStatLine) => number): number => lines.reduce((a, s) => a + f(s), 0);
      expect(sum((s) => s.passing.completions)).toBe(sum((s) => s.receiving.receptions));
      expect(sum((s) => s.passing.touchdowns)).toBe(sum((s) => s.receiving.touchdowns));
      expect(r.weather).toEqual(gameWeather(before, g));
      // Week-1 rosters are `before`'s (later weeks see trades and signings; the seam checks those games itself).
      const dressed = new Set([...before.teams[g.home]!.rosterIds, ...before.teams[g.away]!.rosterIds]);
      if (g.week === 1) for (const inj of r.injuries) expect(dressed.has(inj.playerId)).toBe(true);
      const userGame = g.home === league.userTeamId || g.away === league.userTeamId;
      expect(r.playLogId).toBe(userGame ? g.id : null);
      if (userGame) expect(league.playLogs[g.id]!.length).toBeGreaterThan(100);
    }
    expect(games.some((g) => g.result!.injuries.length > 0)).toBe(true);
  });

  it('produces plausible 17-game-equivalent stat leaders', () => {
    const pass = leaders(league, ['QB'], (s) => s.passing.yards);
    expect(pass[0]).toBeGreaterThanOrEqual(3000);
    expect(pass[0]).toBeLessThanOrEqual(5500);
    const rush = leaders(league, ['RB', 'FB', 'QB'], (s) => s.rushing.yards);
    expect(rush[0]).toBeGreaterThanOrEqual(900);
    expect(rush[0]).toBeLessThanOrEqual(3000);
    // The leader of a six-week sample runs hot; the fifth-best back is the stable read of the rushing leaders.
    expect(rush[4]).toBeGreaterThanOrEqual(900);
    expect(rush[4]).toBeLessThanOrEqual(2300);
    const rec = leaders(league, ['WR', 'TE', 'RB'], (s) => s.receiving.yards);
    expect(rec[0]).toBeGreaterThanOrEqual(900);
    expect(rec[0]).toBeLessThanOrEqual(3000);
    expect(rec[4]).toBeGreaterThanOrEqual(800);
    expect(rec[4]).toBeLessThanOrEqual(2000);
  });

  it('is deterministic per setup seed', () => {
    const rerun = advanceLeagueWeek(before, { rng: createRng(100) });
    const week1 = games.filter((g) => g.week === 1 && !g.isPreseason);
    expect(rerun.games.map((g) => g.id)).toEqual(week1.map((g) => g.id));
    expect(rerun.games.map((g) => g.result)).toEqual(week1.map((g) => g.result));
    expect(realGameSimulator).toBe(realGameSimulator);
  }, 60_000);
});
