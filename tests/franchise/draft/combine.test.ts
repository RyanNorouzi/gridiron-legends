import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { POSITIONS } from '@/players/types';
import type { Player } from '@/players/types';
import { createNamePool } from '@/players/names';
import { generateProspect } from '@/players/generator';
import type { CombineResults } from '@/franchise/types';
import {
  DRILL_BOUNDS, bestDrillResults, benchModel, combineImpliedAttrs, combineResults, drillHighlights, fortyYardModel,
  runProDay, shuttleModel, threeConeModel, verticalModel, broadJumpModel,
} from '@/franchise/combine';

const names = createNamePool();
const samplePlayers = (seed: number, n: number): Player[] => {
  const rng = createRng(seed);
  return Array.from({ length: n }, (_, i) =>
    generateProspect(rng.fork(`p${i}`), { position: POSITIONS[i % POSITIONS.length]!, names, regions: ['northeast'], year: 2027, projectedRound: (i % 7) + 1 }));
};

const pearson = (xs: readonly number[], ys: readonly number[]): number => {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
};

describe('combine drills', () => {
  const players = samplePlayers(7, 200);
  const results = players.map((p, i) => combineResults(createRng(1000 + i), p));

  it('fast players run faster 40s (200 samples)', () => {
    const r = pearson(players.map((p) => p.attrs.speed), results.map((c) => c.fortyYard));
    expect(r).toBeLessThan(-0.8);
    const bySpeed = players.map((p, i) => ({ speed: p.attrs.speed, forty: results[i]!.fortyYard })).sort((a, b) => b.speed - a.speed);
    const mean = (xs: readonly { forty: number }[]): number => xs.reduce((s, v) => s + v.forty, 0) / xs.length;
    const fastest = bySpeed.slice(0, 50);
    const slowest = bySpeed.slice(-50);
    expect(fastest[fastest.length - 1]!.speed).toBeGreaterThan(slowest[0]!.speed);
    expect(mean(slowest) - mean(fastest)).toBeGreaterThan(0.4);
  });

  it('bench tracks strength, jumps track jumping, agility drills track agility', () => {
    expect(pearson(players.map((p) => p.attrs.strength), results.map((c) => c.benchReps))).toBeGreaterThan(0.75);
    expect(pearson(players.map((p) => p.attrs.jumping), results.map((c) => c.vertical))).toBeGreaterThan(0.85);
    expect(pearson(players.map((p) => p.attrs.jumping), results.map((c) => c.broadJump))).toBeGreaterThan(0.8);
    expect(pearson(players.map((p) => p.attrs.agility), results.map((c) => c.shuttle))).toBeLessThan(-0.85);
    expect(pearson(players.map((p) => p.attrs.agility), results.map((c) => c.threeCone))).toBeLessThan(-0.8);
  });

  it('keeps every number inside the drill bounds and is deterministic', () => {
    for (const c of results) {
      for (const key of Object.keys(DRILL_BOUNDS) as (keyof CombineResults)[]) {
        const [lo, hi] = DRILL_BOUNDS[key];
        expect(c[key]).toBeGreaterThanOrEqual(lo);
        expect(c[key]).toBeLessThanOrEqual(hi);
      }
    }
    expect(combineResults(createRng(1000), players[0]!)).toEqual(results[0]);
  });

  it('models are monotonic and physically plausible (99 speed ≈ 4.3, heavy linemen slower)', () => {
    expect(fortyYardModel(99, 99)).toBeCloseTo(4.31, 1);
    expect(fortyYardModel(50, 50)).toBeGreaterThan(fortyYardModel(80, 80));
    expect(fortyYardModel(70, 70, 320)).toBeGreaterThan(fortyYardModel(70, 70, 200));
    expect(benchModel(90)).toBeGreaterThan(benchModel(60));
    expect(verticalModel(90)).toBeGreaterThan(verticalModel(60));
    expect(broadJumpModel(90, 70)).toBeGreaterThan(broadJumpModel(60, 70));
    expect(shuttleModel(90)).toBeLessThan(shuttleModel(60));
    expect(threeConeModel(90, 70)).toBeLessThan(threeConeModel(60, 70));
  });
});

describe('combine scale', () => {
  it('reads like real combine numbers across a class: no pile-up at the drill bounds, linemen slower than DBs', () => {
    const players = samplePlayers(13, 340);
    const results = players.map((p, i) => combineResults(createRng(5000 + i), p));
    for (const key of Object.keys(DRILL_BOUNDS) as (keyof CombineResults)[]) {
      const [lo, hi] = DRILL_BOUNDS[key];
      const pinned = results.filter((c) => c[key] <= lo || c[key] >= hi).length;
      expect(pinned / results.length).toBeLessThan(0.02);
    }
    const median = (pos: readonly string[]): number => {
      const xs = players.map((p, i) => ({ p, f: results[i]!.fortyYard })).filter((x) => pos.includes(x.p.position)).map((x) => x.f).sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)]!;
    };
    const ol = median(['OT', 'OG', 'C']);
    const db = median(['CB', 'FS', 'SS', 'WR']);
    expect(ol).toBeGreaterThan(db + 0.25);
    expect(ol).toBeLessThan(5.6);
    expect(db).toBeGreaterThan(4.35);
    expect(db).toBeLessThan(4.95);
  });
});

describe('combine-implied attributes', () => {
  it('inverts the noise-free models closely for a balanced sprinter', () => {
    const exact: CombineResults = {
      fortyYard: fortyYardModel(84, 84, 215), benchReps: benchModel(70, 215), vertical: verticalModel(77),
      broadJump: broadJumpModel(77, 84), shuttle: shuttleModel(81), threeCone: threeConeModel(81, 84),
    };
    const implied = combineImpliedAttrs(exact, 215);
    expect(Math.abs((implied.speed ?? 0) - 84)).toBeLessThanOrEqual(1);
    expect(Math.abs((implied.strength ?? 0) - 70)).toBeLessThanOrEqual(1);
    expect(Math.abs((implied.jumping ?? 0) - 77)).toBeLessThanOrEqual(1);
    expect(Math.abs((implied.agility ?? 0) - 81)).toBeLessThanOrEqual(2);
  });

  it('recovers true speed within a few points from real (noisy) 40 times most of the time', () => {
    const players = samplePlayers(9, 200).filter((p) => Math.abs(p.attrs.speed - p.attrs.acceleration) <= 4);
    let close = 0;
    players.forEach((p, i) => {
      const implied = combineImpliedAttrs(combineResults(createRng(i), p), p.weightLb);
      if (Math.abs((implied.speed ?? 0) - p.attrs.speed) <= 6) close += 1;
    });
    expect(players.length).toBeGreaterThan(20);
    expect(close / players.length).toBeGreaterThan(0.75);
  });
});

describe('pro day', () => {
  const players = samplePlayers(11, 60);

  it('publishes only improvements over the combine, deterministically', () => {
    let improvedDrills = 0;
    players.forEach((player, i) => {
      const combine = combineResults(createRng(i), player);
      const prospect = { player, combine };
      const day = runProDay(createRng(500 + i), prospect);
      expect(runProDay(createRng(500 + i), prospect)).toEqual(day);
      for (const key of Object.keys(day) as (keyof CombineResults)[]) {
        const v = day[key] as number;
        improvedDrills += 1;
        if (key === 'fortyYard' || key === 'shuttle' || key === 'threeCone') expect(v).toBeLessThan(combine[key]);
        else expect(v).toBeGreaterThan(combine[key]);
      }
      const best = bestDrillResults({ combine, proDay: day });
      expect(best.fortyYard).toBeLessThanOrEqual(combine.fortyYard);
      expect(best.benchReps).toBeGreaterThanOrEqual(combine.benchReps);
    });
    expect(improvedDrills).toBeGreaterThan(players.length * 0.5);
  });

  it('bestDrillResults without a pro day is the combine', () => {
    const combine = combineResults(createRng(3), players[0]!);
    expect(bestDrillResults({ combine, proDay: null })).toEqual(combine);
  });

  it('highlights standout numbers for report notes', () => {
    const notes = drillHighlights({ fortyYard: 4.31, benchReps: 30, vertical: 41, broadJump: 130, shuttle: 4.0, threeCone: 6.7 });
    expect(notes.join(' ')).toMatch(/Blazing 40/);
    expect(notes.join(' ')).toMatch(/strength/);
    expect(notes.join(' ')).toMatch(/leaper/);
    expect(notes.join(' ')).toMatch(/change of direction/);
    expect(drillHighlights({ fortyYard: 5.5, benchReps: 5, vertical: 25, broadJump: 95, shuttle: 4.8, threeCone: 7.8 }).join(' ')).toMatch(/Sluggish/);
  });
});
