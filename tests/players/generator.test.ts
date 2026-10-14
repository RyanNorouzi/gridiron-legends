import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import {
  JERSEY_RANGES, PHYSIQUE, PROSPECT_ROUND_BANDS, QUALITY_OVERALL_BANDS, generateAttributes, generatePlayer, generateProspect,
} from '@/players/generator';
import type { GeneratePlayerOptions, PlayerQuality } from '@/players/generator';
import { computeOverall } from '@/players/attributes';
import { ATTRIBUTE_KEYS, PERSONALITY_TRAITS, POSITIONS, POSITION_GROUP } from '@/players/types';
import type { AttributeKey, Player, Position } from '@/players/types';
import { COLLEGES, REGIONS, mean, testNames } from './helpers';

const baseOpts = (position: Position, extra: Partial<GeneratePlayerOptions> = {}): GeneratePlayerOptions => ({
  position, names: testNames, regions: REGIONS, colleges: COLLEGES, year: 2030, ...extra,
});

const sample = (position: Position, n: number, extra: Partial<GeneratePlayerOptions> = {}, seed = 1): Player[] => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => generatePlayer(rng, baseOpts(position, extra)));
};

const meanAttr = (players: Player[], key: AttributeKey): number => mean(players.map((p) => p.attrs[key]));

describe('generatePlayer determinism', () => {
  it('same seed and options produce identical players; different seeds differ', () => {
    const a = generatePlayer(createRng(42), baseOpts('QB'));
    const b = generatePlayer(createRng(42), baseOpts('QB'));
    const c = generatePlayer(createRng(43), baseOpts('QB'));
    expect(a).toEqual(b);
    expect(a.id).not.toBe(c.id);
    expect(a.attrs).not.toEqual(c.attrs);
  });
  it('a stream of players from one rng is reproducible', () => {
    const first = sample('WR', 20, {}, 7).map((p) => p.id);
    const second = sample('WR', 20, {}, 7).map((p) => p.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(20);
  });
});

describe('generatePlayer shape and ranges', () => {
  it('produces well-formed players for every position', () => {
    const rng = createRng(3);
    for (const pos of POSITIONS) {
      for (let i = 0; i < 8; i++) {
        const p = generatePlayer(rng, baseOpts(pos));
        expect(p.position).toBe(pos);
        expect(p.overall).toBe(computeOverall(p.attrs, pos));
        expect(p.overall).toBeGreaterThanOrEqual(1);
        expect(p.overall).toBeLessThanOrEqual(99);
        expect(p.potential).toBeGreaterThanOrEqual(p.overall);
        expect(p.potential).toBeLessThanOrEqual(99);
        for (const k of ATTRIBUTE_KEYS) {
          expect(Number.isInteger(p.attrs[k])).toBe(true);
          expect(p.attrs[k]).toBeGreaterThanOrEqual(1);
          expect(p.attrs[k]).toBeLessThanOrEqual(99);
        }
        const [hMin, hMax, wMin, wMax] = PHYSIQUE[pos];
        expect(p.heightIn).toBeGreaterThanOrEqual(hMin);
        expect(p.heightIn).toBeLessThanOrEqual(hMax);
        expect(p.weightLb).toBeGreaterThanOrEqual(wMin);
        expect(p.weightLb).toBeLessThanOrEqual(wMax);
        const ranges = JERSEY_RANGES[POSITION_GROUP[pos]];
        expect(ranges.some(([lo, hi]) => p.jerseyNumber >= lo && p.jerseyNumber <= hi)).toBe(true);
        expect(p.traits.length).toBeLessThanOrEqual(3);
        expect(new Set(p.traits).size).toBe(p.traits.length);
        for (const t of p.traits) expect(PERSONALITY_TRAITS).toContain(t);
        for (const v of Object.values(p.preferences)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(p.morale.morale).toBeGreaterThanOrEqual(60);
        expect(p.morale.morale).toBeLessThanOrEqual(80);
        expect(p.teamId).toBeNull();
        expect(p.contract).toBeNull();
        expect(p.injury).toBeNull();
        expect(p.retired).toBe(false);
        expect(p.rookieYear).toBe(2030 - p.experience);
        expect(p.experience).toBeGreaterThanOrEqual(0);
        expect(REGIONS).toContain(p.homeRegion);
        expect(COLLEGES).toContain(p.college);
        expect(p.firstName.length).toBeGreaterThan(0);
        expect(p.lastName.length).toBeGreaterThan(0);
        expect(p.askingSalary).toBeGreaterThanOrEqual(800_000);
        expect(p.progressionLog).toEqual([]);
      }
    }
  });
  it('respects the quality overall bands', () => {
    for (const q of ['elite', 'starter', 'rotation', 'backup', 'fringe'] as PlayerQuality[]) {
      const [lo, hi] = QUALITY_OVERALL_BANDS[q];
      for (const p of sample('MLB', 40, { quality: q }, 11)) {
        expect(p.overall).toBeGreaterThanOrEqual(lo - 1);
        expect(p.overall).toBeLessThanOrEqual(hi + 1);
      }
    }
  });
  it('honours explicit age and targetOverall, and colleges are optional', () => {
    const p = generatePlayer(createRng(5), { position: 'TE', names: testNames, regions: REGIONS, year: 2031, age: 29, targetOverall: 81 });
    expect(p.age).toBe(29);
    expect(Math.abs(p.overall - 81)).toBeLessThanOrEqual(1);
    expect(p.college).toBeNull();
  });
  it('validates options', () => {
    expect(() => generatePlayer(createRng(1), { position: 'QB', names: testNames, regions: [], year: 2030 })).toThrow(/regions/);
    expect(() => generatePlayer(createRng(1), baseOpts('QB', { age: 50 }))).toThrow(/age/);
    expect(() => generatePlayer(createRng(1), baseOpts('QB', { targetOverall: 120 }))).toThrow(/targetOverall/);
    expect(() => generatePlayer(createRng(1), baseOpts('QB', { year: 2030.5 }))).toThrow(/year/);
  });
});

describe('attribute correlations by position (200 samples each)', () => {
  const N = 200;
  const cb = sample('CB', N, { quality: 'starter' }, 21);
  const og = sample('OG', N, { quality: 'starter' }, 22);
  const qb = sample('QB', N, { quality: 'starter' }, 23);
  const rb = sample('RB', N, { quality: 'starter' }, 24);
  const wr = sample('WR', N, { quality: 'starter' }, 25);
  const k = sample('K', N, { quality: 'starter' }, 26);
  const ot = sample('OT', N, { quality: 'starter' }, 27);

  it('corners are much faster than guards; guards are much stronger', () => {
    expect(meanAttr(cb, 'speed')).toBeGreaterThan(meanAttr(og, 'speed') + 25);
    expect(meanAttr(og, 'strength')).toBeGreaterThan(meanAttr(cb, 'strength') + 20);
  });
  it('quarterbacks throw, kickers kick, linemen block', () => {
    expect(meanAttr(qb, 'throwAccuracy')).toBeGreaterThan(meanAttr(rb, 'throwAccuracy') + 30);
    expect(meanAttr(qb, 'throwPower')).toBeGreaterThan(meanAttr(wr, 'throwPower') + 30);
    expect(meanAttr(k, 'kickAccuracy')).toBeGreaterThan(meanAttr(wr, 'kickAccuracy') + 40);
    expect(meanAttr(ot, 'blocking')).toBeGreaterThan(meanAttr(wr, 'blocking') + 30);
    expect(meanAttr(wr, 'catching')).toBeGreaterThan(meanAttr(ot, 'catching') + 30);
  });
  it('irrelevant attributes are low but present (never floored at 1 on average)', () => {
    expect(meanAttr(og, 'throwAccuracy')).toBeGreaterThan(10);
    expect(meanAttr(og, 'throwAccuracy')).toBeLessThan(45);
    expect(meanAttr(qb, 'kickPower')).toBeLessThan(45);
  });
  it('generateAttributes hits the requested overall within rounding', () => {
    const rng = createRng(9);
    for (const target of [40, 60, 75, 90, 99]) {
      for (const pos of ['QB', 'CB', 'OT', 'K'] as Position[]) {
        const attrs = generateAttributes(rng, pos, target);
        expect(Math.abs(computeOverall(attrs, pos) - target)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('potential, dev traits and salary', () => {
  it('potential gap shrinks with age', () => {
    const gap = (age: number): number => mean(sample('WR', 150, { age, quality: 'rotation' }, 31 + age).map((p) => p.potential - p.overall));
    expect(gap(22)).toBeGreaterThan(gap(26) + 3);
    expect(gap(26)).toBeGreaterThan(gap(31));
    expect(gap(33)).toBeLessThan(1.5);
  });
  it('elite players draw star/superstar traits far more often than fringe players', () => {
    const share = (q: PlayerQuality): number => {
      const ps = sample('DE', 300, { quality: q }, 41);
      return ps.filter((p) => p.devTrait === 'star' || p.devTrait === 'superstar').length / ps.length;
    };
    expect(share('elite')).toBeGreaterThan(share('fringe') + 0.15);
  });
  it('asking salary rises with overall and follows position scarcity', () => {
    const elite = mean(sample('QB', 50, { quality: 'elite', age: 27 }, 51).map((p) => p.askingSalary));
    const fringe = mean(sample('QB', 50, { quality: 'fringe', age: 27 }, 52).map((p) => p.askingSalary));
    expect(elite).toBeGreaterThan(fringe * 5);
    const kicker = mean(sample('K', 50, { quality: 'elite', age: 27 }, 53).map((p) => p.askingSalary));
    expect(elite).toBeGreaterThan(kicker * 3);
    for (const p of sample('P', 20, { quality: 'fringe' }, 54)) expect(p.askingSalary % 10_000).toBe(0);
  });
});

describe('generateProspect', () => {
  it('prospects are 20..23, inexperienced, and carry upside', () => {
    const rng = createRng(77);
    const prospects = Array.from({ length: 120 }, () => generateProspect(rng, { position: 'CB', names: testNames, regions: REGIONS, year: 2032 }));
    for (const p of prospects) {
      expect(p.age).toBeGreaterThanOrEqual(20);
      expect(p.age).toBeLessThanOrEqual(23);
      expect(p.experience).toBe(0);
      expect(p.rookieYear).toBe(2032);
      expect(p.overall).toBeGreaterThanOrEqual(43);
      expect(p.overall).toBeLessThanOrEqual(73);
    }
    expect(mean(prospects.map((p) => p.potential - p.overall))).toBeGreaterThan(8);
  });
  it('projected round drives the overall band and the potential gap', () => {
    const rng = createRng(78);
    const r1 = Array.from({ length: 60 }, () => generateProspect(rng, { position: 'QB', names: testNames, regions: REGIONS, year: 2032, projectedRound: 1 }));
    const r7 = Array.from({ length: 60 }, () => generateProspect(rng, { position: 'QB', names: testNames, regions: REGIONS, year: 2032, projectedRound: 7 }));
    const [lo1, hi1] = PROSPECT_ROUND_BANDS[0] ?? [0, 99];
    for (const p of r1) {
      expect(p.overall).toBeGreaterThanOrEqual(lo1 - 1);
      expect(p.overall).toBeLessThanOrEqual(hi1 + 1);
    }
    expect(mean(r1.map((p) => p.overall))).toBeGreaterThan(mean(r7.map((p) => p.overall)) + 8);
    expect(mean(r1.map((p) => p.potential))).toBeGreaterThan(mean(r7.map((p) => p.potential)) + 12);
    expect(() => generateProspect(createRng(1), { position: 'QB', names: testNames, regions: REGIONS, year: 2032, projectedRound: 8 })).toThrow(/projectedRound/);
  });
});
