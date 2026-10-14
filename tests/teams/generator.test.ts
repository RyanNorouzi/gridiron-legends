import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { OFFENSIVE_POSITIONS, DEFENSIVE_POSITIONS, POSITIONS } from '@/players/types';
import type { Player, Position } from '@/players/types';
import { QUALITY_OVERALL_BANDS } from '@/players/generator';
import { ROSTER_COMPOSITION, ROSTER_SIZE, STARTER_COUNTS, rosterPositionCounts } from '@/teams/depth-chart';
import {
  DEPTH_DROPOFF, MARKET_DEFAULTS, STARTER_OVERALL_RANGE, defaultFacilities, defaultFans, emptyTeamFinances,
  ensureUniqueJerseys, generateRoster, playersByGroup, qualityTierFor, targetOverallFor, topOverallMean,
} from '@/teams/generator';
import type { GenerateRosterOptions } from '@/teams/generator';
import { COLLEGES, REGIONS, makePlayer, mean, testNames } from '../players/helpers';

const opts = (quality: number, extra: Partial<GenerateRosterOptions> = {}): GenerateRosterOptions => ({
  quality, names: testNames, regions: REGIONS, colleges: COLLEGES, year: 2030, ...extra,
});
const roster = (seed: number, quality: number, extra: Partial<GenerateRosterOptions> = {}): Player[] =>
  generateRoster(createRng(seed), opts(quality, extra));

/** Mean overall of the players at `rank` within each position (skipping positions without that depth). */
const rankMean = (players: readonly Player[], rank: number): number => {
  const values: number[] = [];
  for (const pos of POSITIONS) {
    const group = players.filter((p) => p.position === pos);
    const p = group[rank];
    if (p) values.push(p.overall);
  }
  return mean(values);
};
const starterMean = (players: readonly Player[]): number =>
  mean(POSITIONS.flatMap((pos) => players.filter((p) => p.position === pos).slice(0, STARTER_COUNTS[pos]).map((p) => p.overall)));

describe('generateRoster', () => {
  it('is deterministic per seed and differs across seeds', () => {
    expect(roster(5, 0.5)).toEqual(roster(5, 0.5));
    const a = roster(5, 0.5).map((p) => p.id);
    const b = roster(6, 0.5).map((p) => p.id);
    expect(a).not.toEqual(b);
  });
  it('builds a 53-man roster matching the composition, in position order with the best first', () => {
    const players = roster(1, 0.5);
    expect(players).toHaveLength(ROSTER_SIZE);
    expect(rosterPositionCounts(players)).toEqual(ROSTER_COMPOSITION);
    let cursor = 0;
    for (const pos of POSITIONS) {
      const group = players.slice(cursor, cursor + ROSTER_COMPOSITION[pos]);
      cursor += ROSTER_COMPOSITION[pos];
      for (const p of group) expect(p.position).toBe(pos);
      for (let i = 1; i < group.length; i++) expect(group[i - 1]!.overall).toBeGreaterThanOrEqual(group[i]!.overall);
    }
    for (const p of players) {
      expect(p.teamId).toBeNull();
      expect(p.contract).toBeNull();
      expect(p.draft).toBeNull();
      expect(p.overall).toBeGreaterThanOrEqual(35);
      expect(p.overall).toBeLessThanOrEqual(99);
      expect(REGIONS).toContain(p.homeRegion);
    }
  });
  it('has unique jersey numbers and a spread of ages including young depth players', () => {
    const players = roster(2, 0.5);
    expect(new Set(players.map((p) => p.jerseyNumber)).size).toBe(players.length);
    const ages = players.map((p) => p.age);
    expect(Math.min(...ages)).toBeLessThanOrEqual(24);
    expect(Math.max(...ages)).toBeGreaterThanOrEqual(30);
    expect(players.some((p) => p.experience <= 2)).toBe(true);
  });
  it('team strength drives starter quality and the league-wide talent spread', () => {
    const strong = [roster(11, 0.95), roster(12, 0.95), roster(13, 0.95)];
    const weak = [roster(21, 0.05), roster(22, 0.05), roster(23, 0.05)];
    const strongStarters = mean(strong.map(starterMean));
    const weakStarters = mean(weak.map(starterMean));
    expect(strongStarters - weakStarters).toBeGreaterThan(14);
    expect(strongStarters).toBeGreaterThan(STARTER_OVERALL_RANGE[1] - 6);
    expect(weakStarters).toBeLessThan(STARTER_OVERALL_RANGE[0] + 6);
    // Strong teams field several elite players; weak teams almost none.
    const elite = (ps: Player[]): number => ps.filter((p) => p.overall >= QUALITY_OVERALL_BANDS.elite[0]).length;
    expect(mean(strong.map(elite))).toBeGreaterThan(4);
    expect(mean(weak.map(elite))).toBeLessThan(1);
  });
  it('depth drops off by rank: starters > second string > third string', () => {
    const seeds = [31, 32, 33, 34];
    const r0 = mean(seeds.map((s) => rankMean(roster(s, 0.5), 0)));
    const r1 = mean(seeds.map((s) => rankMean(roster(s, 0.5), 1)));
    const r2 = mean(seeds.map((s) => rankMean(roster(s, 0.5), 2)));
    expect(r0 - r1).toBeGreaterThan(DEPTH_DROPOFF[1]! - 4);
    expect(r1 - r2).toBeGreaterThan(2);
  });
  it('unit tilt shifts offense against defense', () => {
    const unitMean = (ps: Player[], positions: readonly Position[]): number =>
      mean(positions.flatMap((pos) => ps.filter((p) => p.position === pos).slice(0, STARTER_COUNTS[pos]).map((p) => p.overall)));
    const offHeavy = roster(41, 0.5, { unitTilt: 0.3 });
    const defHeavy = roster(41, 0.5, { unitTilt: -0.3 });
    expect(unitMean(offHeavy, OFFENSIVE_POSITIONS) - unitMean(offHeavy, DEFENSIVE_POSITIONS)).toBeGreaterThan(6);
    expect(unitMean(defHeavy, DEFENSIVE_POSITIONS) - unitMean(defHeavy, OFFENSIVE_POSITIONS)).toBeGreaterThan(6);
  });
  it('honours a custom composition', () => {
    const composition = { ...ROSTER_COMPOSITION };
    for (const pos of POSITIONS) composition[pos] = 0;
    composition.QB = 2;
    composition.K = 1;
    const players = roster(3, 0.5, { composition });
    expect(players.map((p) => p.position)).toEqual(['QB', 'QB', 'K']);
  });
  it('validates its options', () => {
    expect(() => roster(1, 1.2)).toThrow(/quality/);
    expect(() => roster(1, -0.1)).toThrow(/quality/);
    expect(() => generateRoster(createRng(1), opts(0.5, { regions: [] }))).toThrow(/regions/);
    expect(() => generateRoster(createRng(1), opts(0.5, { year: 2030.5 }))).toThrow(/year/);
    expect(() => generateRoster(createRng(1), opts(0.5, { composition: { ...ROSTER_COMPOSITION, QB: -1 } }))).toThrow(/composition\.QB/);
  });
});

describe('targeting helpers', () => {
  it('qualityTierFor maps overalls onto the generator bands', () => {
    expect(qualityTierFor(90)).toBe('elite');
    expect(qualityTierFor(QUALITY_OVERALL_BANDS.elite[0])).toBe('elite');
    expect(qualityTierFor(QUALITY_OVERALL_BANDS.elite[0] - 1)).toBe('starter');
    expect(qualityTierFor(QUALITY_OVERALL_BANDS.rotation[0])).toBe('rotation');
    expect(qualityTierFor(QUALITY_OVERALL_BANDS.backup[0])).toBe('backup');
    expect(qualityTierFor(50)).toBe('fringe');
    expect(qualityTierFor(1)).toBe('fringe');
  });
  it('targetOverallFor drops with rank, rises with strength and stays in bounds', () => {
    const rng = createRng(9);
    const sample = (quality: number, position: Position, rank: number): number =>
      mean(Array.from({ length: 200 }, () => targetOverallFor(rng, quality, position, rank)));
    expect(sample(0.5, 'WR', 0)).toBeGreaterThan(sample(0.5, 'WR', 3) + 12);
    expect(sample(0.9, 'CB', 0)).toBeGreaterThan(sample(0.1, 'CB', 0) + 12);
    expect(sample(0.5, 'WR', 1)).toBeGreaterThan(sample(0.5, 'QB', 1) + 2);
    for (let i = 0; i < 300; i++) {
      const t = targetOverallFor(rng, i % 2 ? 1 : 0, 'QB', i % 5);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(40);
      expect(t).toBeLessThanOrEqual(97);
    }
  });
  it('ensureUniqueJerseys re-rolls clashes while keeping the first holder', () => {
    const a = makePlayer({ id: 'p_a' as Player['id'], position: 'WR', jerseyNumber: 11 });
    const b = makePlayer({ id: 'p_b' as Player['id'], position: 'WR', jerseyNumber: 11 });
    const c = makePlayer({ id: 'p_c' as Player['id'], position: 'WR', jerseyNumber: 11 });
    const out = ensureUniqueJerseys(createRng(4), [a, b, c]);
    expect(out[0]).toBe(a);
    expect(new Set(out.map((p) => p.jerseyNumber)).size).toBe(3);
    expect(out.map((p) => p.id)).toEqual(['p_a', 'p_b', 'p_c']);
  });
  it('topOverallMean and playersByGroup summarise a roster', () => {
    const players = roster(7, 0.5);
    const qbs = players.filter((p) => p.position === 'QB');
    expect(topOverallMean(players, 'QB', 1)).toBe(Math.max(...qbs.map((p) => p.overall)));
    expect(topOverallMean([], 'QB', 1)).toBe(0);
    const groups = playersByGroup(players);
    expect(groups['OL']).toHaveLength(ROSTER_COMPOSITION.OT + ROSTER_COMPOSITION.OG + ROSTER_COMPOSITION.C);
    expect(groups['ST']).toHaveLength(2);
  });
});

describe('default team records', () => {
  it('emptyTeamFinances starts clean with cash from the cap unless overridden', () => {
    const f = emptyTeamFinances(200_000_000);
    expect(f.cash).toBe(40_000_000);
    expect(f.seasonRevenue).toEqual({ tickets: 0, merchandise: 0, sponsors: 0, concessions: 0 });
    expect(f.seasonExpenses).toEqual({ playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 });
    expect(f.deadMoney).toEqual({});
    expect(f.capCarryover).toBe(0);
    expect(emptyTeamFinances(200_000_000, { cash: 5, ticketPrice: 99 })).toMatchObject({ cash: 5, ticketPrice: 99 });
    expect(() => emptyTeamFinances(0)).toThrow(/cap/);
  });
  it('defaultFacilities clamps into 1..5 and defaultFans scales support by market', () => {
    expect(defaultFacilities()).toEqual({ training: 2, medical: 2, scouting: 2, stadium: 2, development: 2, analytics: 2 });
    expect(defaultFacilities(9).training).toBe(5);
    expect(defaultFacilities(-3).medical).toBe(1);
    expect(defaultFans('large').support).toBeGreaterThan(defaultFans('small').support);
    expect(defaultFans().support).toBe(MARKET_DEFAULTS.medium.support);
    expect(defaultFans('medium').attendancePct).toBeGreaterThan(0);
    expect(defaultFans('medium').attendancePct).toBeLessThanOrEqual(1);
  });
});
