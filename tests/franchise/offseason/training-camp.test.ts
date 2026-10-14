import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { SEASON_CONFIG } from '@/franchise/settings';
import { rosterErrors } from '@/franchise/roster';
import { campDepthChart, runTrainingCamp, type CampIntensity, type CampReport } from '@/franchise/training-camp';
import type { League } from '@/franchise/types';
import { atPhase, makeLeague, rostered, teamIds, withPlayer } from './helpers';

const campLeague = (seed = 71): League => atPhase(makeLeague(seed), 'trainingCamp');

const userReport = (league: League, reports: readonly CampReport[]): CampReport => reports.find((r) => r.teamId === league.userTeamId)!;

const pointsGained = (r: CampReport): number => r.gains.reduce((s, g) => s + Object.values(g.deltas).reduce((a, b) => a + (b ?? 0), 0), 0);

describe('runTrainingCamp', () => {
  it('hard camps yield more gains and more injuries than light camps across seeds', () => {
    const league = campLeague();
    const totals: Record<CampIntensity, { points: number; injuries: number }> = { light: { points: 0, injuries: 0 }, normal: { points: 0, injuries: 0 }, hard: { points: 0, injuries: 0 } };
    for (let seed = 1; seed <= 25; seed++) {
      for (const intensity of ['light', 'normal', 'hard'] as const) {
        const r = userReport(league, runTrainingCamp(league, createRng(seed), { intensity }).reports);
        totals[intensity].points += pointsGained(r);
        totals[intensity].injuries += r.injuries.length;
      }
    }
    expect(totals.hard.points).toBeGreaterThan(totals.normal.points);
    expect(totals.normal.points).toBeGreaterThan(totals.light.points);
    expect(totals.hard.injuries).toBeGreaterThan(totals.light.injuries * 1.5);
    expect(totals.hard.injuries).toBeGreaterThan(0);
  });

  it('attaches camp injuries so they survive the rollover countdown with the reported weeks', () => {
    const league = campLeague(72);
    const { league: out, reports } = runTrainingCamp(league, createRng(4), { intensity: 'hard', aiIntensity: 'hard' });
    const injuries = reports.flatMap((r) => r.injuries);
    expect(injuries.length).toBeGreaterThan(0);
    for (const i of injuries) {
      const p = out.players[i.playerId]!;
      expect(p.injury?.weeksRemaining).toBe(i.weeksOut + SEASON_CONFIG.offseasonRecoveryWeeks);
      expect(p.injury?.occurredYear).toBe(league.season.year + 1);
    }
    const quiet = runTrainingCamp({ ...league, settings: { ...league.settings, injuriesEnabled: false } }, createRng(4), { intensity: 'hard', aiIntensity: 'hard' });
    expect(quiet.reports.flatMap((r) => r.injuries)).toEqual([]);
  });

  it('never pushes a player past his potential and keeps rosters consistent', () => {
    const league = campLeague(73);
    const { league: out, reports } = runTrainingCamp(league, createRng(5), { intensity: 'hard' });
    for (const r of reports) for (const g of r.gains) expect(g.overallAfter).toBeLessThanOrEqual(out.players[g.playerId]!.potential);
    expect(rosterErrors(out)).toEqual([]);
    expect(reports).toHaveLength(Object.keys(league.teams).length);
  });

  it('settles incoming rookies within +-3 of their draft-day overall', () => {
    let league = campLeague(74);
    const rookies = teamIds(league).slice(0, 8).map((t) => rostered(league, t, 'WR', 3));
    for (const p of rookies) league = withPlayer(league, { ...p, rookieYear: league.season.year + 1, experience: 0 });
    let moved = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { reports } = runTrainingCamp(league, createRng(seed));
      const reveals = reports.flatMap((r) => r.rookies);
      expect(reveals.map((r) => r.playerId).sort()).toEqual(rookies.map((p) => p.id).sort());
      for (const r of reveals) {
        expect(Math.abs(r.after - r.before)).toBeLessThanOrEqual(3);
        if (r.after !== r.before) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('applies and persists the user focus', () => {
    const league = campLeague(75);
    const qb = rostered(league, league.userTeamId as TeamId, 'QB');
    let focusPoints = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { league: out } = runTrainingCamp(league, createRng(seed), { intensity: 'hard', focus: { [qb.id]: 'throwAccuracy' } });
      expect(out.players[qb.id]!.trainingFocus).toBe('throwAccuracy');
      focusPoints += out.players[qb.id]!.attrs.throwAccuracy - qb.attrs.throwAccuracy;
    }
    expect(focusPoints).toBeGreaterThan(0);
  });

  it('resolves position battles into AI depth charts with morale breaking exact ties', () => {
    const league = campLeague(76);
    const { league: out, reports } = runTrainingCamp(league, createRng(6));
    const ai = reports.filter((r) => r.teamId !== league.userTeamId);
    const battles = ai.flatMap((r) => r.battles.map((b) => ({ ...b, teamId: r.teamId })));
    expect(battles.length).toBeGreaterThan(0);
    for (const b of battles) {
      const chart = out.teams[b.teamId]!.depthChart[b.position];
      expect(chart.indexOf(b.winner)).toBeLessThan(chart.indexOf(b.loser));
    }
    const [t1] = teamIds(league) as [TeamId];
    const a = rostered(league, t1, 'CB', 0), b = rostered(league, t1, 'CB', 1);
    const tieA = { ...a, overall: 80, morale: { morale: 20, confidence: 20, coachRelationship: 50 } };
    const tieB = { ...b, overall: 80, morale: { morale: 90, confidence: 90, coachRelationship: 50 } };
    expect(campDepthChart([tieA, tieB]).CB).toEqual([tieB.id, tieA.id]);
  });

  it('keeps the user depth chart unless asked, stores the preseason rating snapshot and runs once', () => {
    const league = campLeague(77);
    const user = league.userTeamId as TeamId;
    const { league: out } = runTrainingCamp(league, createRng(7));
    expect(out.teams[user]!.depthChart).toEqual(league.teams[user]!.depthChart);
    expect(out.offseasonFlags?.preseasonRatings?.year).toBe(league.season.year + 1);
    expect(out.offseasonFlags?.preseasonRatings?.ratings[user]).toBe(out.teams[user]!.overall);
    const again = runTrainingCamp(out, createRng(8));
    expect(again.league).toBe(out);
    expect(again.reports).toEqual([]);
    const auto = runTrainingCamp(league, createRng(7), { autoDepthChart: true }).league;
    const roster = auto.teams[user]!.rosterIds.map((id) => auto.players[id]!);
    expect(auto.teams[user]!.depthChart).toEqual(campDepthChart(roster));
  });
});
