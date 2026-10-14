/**
 * Season-level calibration of the whole-game simulator: a full 32-team, 17-game regular season played snap by snap
 * through simulateGame (the executor behind every franchise game), the way the app sims league games (15-minute
 * quarters, both clubs' staffs calling the plays: see season-measure), must produce NFL-shaped leaders, scoring, parity
 * and a whole-yards stat sheet. Bands are deliberately loose (one season is one sample); per-play agreement with the
 * live engine is enforced separately by tests/integration/balance.test.ts. Takes ~2-4 minutes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { formatSeason, simulateSeason, type SeasonSummary } from './season-measure';

const SEASON_TIMEOUT_MS = 900_000;
let season: SeasonSummary;

beforeAll(async () => {
  season = await simulateSeason(2026, 17);
  console.log(formatSeason(season));
}, SEASON_TIMEOUT_MS);

describe('season calibration (32 teams x 17 games through simulateGame)', () => {
  it('plays the whole schedule', () => {
    expect(season.games).toBe(272);
  });

  it('passing leader throws for 4,000-5,500 yards', () => {
    expect(season.passLeader.value).toBeGreaterThanOrEqual(4000);
    expect(season.passLeader.value).toBeLessThanOrEqual(5500);
  });

  it('receiving leader has 1,300-2,000 yards on at most 150 catches, and no one sees half his team\'s targets', () => {
    expect(season.recLeader.value).toBeGreaterThanOrEqual(1300);
    expect(season.recLeader.value).toBeLessThanOrEqual(2000);
    expect(season.receptionsLeader.value).toBeLessThanOrEqual(150);
    expect(season.maxTargetShare).toBeLessThan(0.45);
    expect(season.meanTopTargetShare).toBeGreaterThanOrEqual(0.22);
    expect(season.meanTopTargetShare).toBeLessThanOrEqual(0.34);
  });

  it('rushing leader runs for 1,300-1,850 yards', () => {
    expect(season.rushLeader.value).toBeGreaterThanOrEqual(1300);
    expect(season.rushLeader.value).toBeLessThanOrEqual(1850);
  });

  // League completion was ~58% (the NFL's is ~64-65%) while the scrimmage table matched the live engine.
  it('the league completes 61-68% of its passes', () => {
    const p = season.perTeamGame;
    expect(p.passCmp / p.passAtt).toBeGreaterThanOrEqual(0.61);
    expect(p.passCmp / p.passAtt).toBeLessThanOrEqual(0.68);
  });

  it('sack leader has 12-22 sacks', () => {
    expect(season.sackLeader.value).toBeGreaterThanOrEqual(12);
    expect(season.sackLeader.value).toBeLessThanOrEqual(22);
  });

  it('teams score 19-26 points a game', () => {
    expect(season.pointsPerTeamGame).toBeGreaterThanOrEqual(19);
    expect(season.pointsPerTeamGame).toBeLessThanOrEqual(26);
  });

  it('has NFL-like parity: best record at most 15 wins, worst at least 1, win SD 2.3-3.8', () => {
    expect(season.bestWins).toBeLessThanOrEqual(15);
    expect(season.worstWins).toBeGreaterThanOrEqual(1);
    expect(season.winSd).toBeGreaterThanOrEqual(2.3);
    expect(season.winSd).toBeLessThanOrEqual(3.8);
  });

  // The compressed field near the goal line: red-zone trips end in touchdowns about 55-65% of the time (it was 73%),
  // the rest largely in field goals, and no passer throws 50 touchdowns.
  it('red-zone scoring is NFL-shaped: TD rate 50-66%, at least 1.1 field goals a game, pass TD leader at most 45', () => {
    const p = season.perTeamGame;
    expect(p.rzTd / p.rzTrips).toBeGreaterThanOrEqual(0.5);
    expect(p.rzTd / p.rzTrips).toBeLessThanOrEqual(0.66);
    expect(p.fgMade).toBeGreaterThanOrEqual(1.1);
    expect(season.passTdLeader.value).toBeLessThanOrEqual(45);
  });

  // Game script (a big lead runs the ball, a defense up big in the second half sits back) keeps blowouts in check: the
  // NFL's mean margin is ~11-12 with roughly one game in ten decided by 28+.
  it('margins: mean at most 13, at most 10% of games decided by 28+, at least a third by 7 or fewer', () => {
    expect(season.margins.mean).toBeLessThanOrEqual(13);
    expect(season.margins.blowoutShare).toBeLessThanOrEqual(0.1);
    expect(season.margins.closeShare).toBeGreaterThanOrEqual(0.33);
  });

  it('keeps every yardage total on the stat sheet a whole number', () => {
    expect(season.fractional.slice(0, 10)).toEqual([]);
  });
});
