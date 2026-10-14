import { describe, expect, it } from 'vitest';
import draftClassesJson from '@/data/draft-classes.json';
import { createRng } from '@/core/rng';
import { POSITIONS, isSpecialist } from '@/players/types';
import { createNamePool } from '@/players/names';
import { loadColleges, loadRegions } from '@/teams/data';
import type { Prospect } from '@/franchise/types';
import { DRAFT_CONFIG, draftClassSize, generateDraftClass, trueProspectValue, validateDraftConfig } from '@/franchise/prospects';

const SETTINGS = { teamCount: 32, draftRounds: 7 };
const YEAR = 2026;
const sources = () => ({ colleges: loadColleges(), regions: loadRegions(), names: createNamePool() });
const makeClass = (seed: number): Prospect[] => generateDraftClass(createRng(seed), YEAR, SETTINGS, sources());

/** Spearman rank correlation of two equally long score lists. */
const spearman = (a: readonly number[], b: readonly number[]): number => {
  const ranks = (xs: readonly number[]): number[] => {
    const order = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array<number>(xs.length);
    order.forEach((o, rank) => { r[o.i] = rank; });
    return r;
  };
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const d2 = ra.reduce((s, r, i) => s + (r - (rb[i] ?? 0)) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
};

describe('draft class generation', () => {
  const cls = makeClass(101);

  it('sizes the class from the league: every pick plus an undrafted surplus', () => {
    expect(draftClassSize(SETTINGS)).toBe(32 * 7 + DRAFT_CONFIG.undraftedExtra);
    expect(cls).toHaveLength(260);
    expect(generateDraftClass(createRng(1), YEAR, SETTINGS, { ...sources(), size: 50 })).toHaveLength(50);
  });

  it('follows the JSON position distribution (stratified within one player of expectation)', () => {
    const total = POSITIONS.reduce((s, p) => s + DRAFT_CONFIG.positionWeights[p], 0);
    for (const pos of POSITIONS) {
      const expected = (DRAFT_CONFIG.positionWeights[pos] / total) * cls.length;
      const count = cls.filter((p) => p.player.position === pos).length;
      expect(Math.abs(count - expected), pos).toBeLessThanOrEqual(1);
    }
  });

  it('draws ages 20..23 with every age represented, rookieYear the following season', () => {
    const ages = new Set(cls.map((p) => p.player.age));
    expect([...ages].sort()).toEqual([20, 21, 22, 23]);
    for (const p of cls) {
      expect(p.player.rookieYear).toBe(YEAR + 1);
      expect(p.player.experience).toBe(0);
      expect(p.player.teamId).toBeNull();
      expect(p.player.contract).toBeNull();
      expect(p.player.draft).toBeNull();
    }
  });

  it('is potential-heavy with a few stars and an undraftable tail', () => {
    const byValue = [...cls].sort((a, b) => trueProspectValue(b.player) - trueProspectValue(a.player));
    const stars = cls.filter((p) => p.player.potential >= 88);
    expect(stars.length).toBeGreaterThanOrEqual(2);
    expect(stars.length).toBeLessThanOrEqual(40);
    const top = byValue.slice(0, 32);
    const tail = byValue.slice(-36);
    const mean = (xs: readonly Prospect[], f: (p: Prospect) => number): number => xs.reduce((s, p) => s + f(p), 0) / xs.length;
    expect(mean(top, (p) => p.player.potential)).toBeGreaterThan(80);
    expect(mean(tail, (p) => p.player.potential)).toBeLessThan(62);
    expect(mean(cls, (p) => p.player.potential - p.player.overall)).toBeGreaterThan(7);
    for (const p of cls) expect(p.player.potential).toBeGreaterThanOrEqual(p.player.overall);
  });

  it('younger prospects are rawer with more upside than older ones', () => {
    const gap = (age: number): number => {
      const g = cls.filter((p) => p.player.age === age);
      return g.reduce((s, p) => s + p.player.potential - p.player.overall, 0) / g.length;
    };
    expect(gap(21)).toBeGreaterThan(gap(23));
  });

  it('gives every prospect a college (mostly local), combine numbers and no pro day yet', () => {
    const names = new Set(loadColleges().map((c) => c.name));
    const regionOf = new Map(loadColleges().map((c) => [c.name, c.region]));
    let local = 0;
    for (const p of cls) {
      expect(names.has(p.college)).toBe(true);
      expect(p.player.college).toBe(p.college);
      expect(p.proDay).toBeNull();
      expect(p.combine.fortyYard).toBeGreaterThan(4);
      if (regionOf.get(p.college) === p.player.homeRegion) local += 1;
    }
    expect(local / cls.length).toBeGreaterThan(0.5);
  });

  it('builds an imperfect public consensus: ranks 1..N, rounds by rank, specialists never early', () => {
    const ranks = cls.map((p) => p.consensusRank);
    expect(ranks).toEqual(cls.map((_, i) => i + 1));
    for (const p of cls) {
      if (isSpecialist(p.player.position)) expect(p.projectedRound).toBeGreaterThanOrEqual(DRAFT_CONFIG.specialistMinRound);
      else expect(p.projectedRound).toBe(Math.min(8, Math.floor(((p.consensusRank ?? 1) - 1) / 32) + 1));
    }
    const undrafted = cls.filter((p) => p.projectedRound > 7).length;
    expect(undrafted).toBeGreaterThanOrEqual(36);
    const truth = cls.map((p) => trueProspectValue(p.player));
    const consensus = cls.map((p) => -(p.consensusRank ?? 0));
    const rho = spearman(truth, consensus);
    expect(rho).toBeGreaterThan(0.8);
    expect(rho).toBeLessThan(0.995);
  });

  it('is deterministic per seed and differs across seeds; ids avoid existing league ids', () => {
    expect(makeClass(101)).toEqual(cls);
    expect(makeClass(102).map((p) => p.player.id)).not.toEqual(cls.map((p) => p.player.id));
    expect(new Set(cls.map((p) => p.player.id)).size).toBe(cls.length);
    const existingIds = new Set(cls.slice(0, 10).map((p) => p.player.id));
    const again = generateDraftClass(createRng(101), YEAR, SETTINGS, { ...sources(), existingIds });
    for (const p of again) expect(existingIds.has(p.player.id)).toBe(false);
  });

  it('rejects bad inputs', () => {
    expect(() => generateDraftClass(createRng(1), 2026.5, SETTINGS, sources())).toThrow(/year/);
    expect(() => generateDraftClass(createRng(1), YEAR, SETTINGS, { ...sources(), regions: [] })).toThrow(/regions/);
    expect(() => generateDraftClass(createRng(1), YEAR, SETTINGS, { ...sources(), colleges: [] })).toThrow(/colleges/);
  });
});

describe('draft config validation', () => {
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(draftClassesJson)) as Record<string, unknown>;

  it('accepts the shipped data', () => {
    expect(validateDraftConfig(draftClassesJson).tiers.length).toBeGreaterThan(3);
  });

  it('rejects tier shares that do not sum to one', () => {
    const raw = clone();
    (raw.tiers as { share: number }[])[0]!.share = 0.5;
    expect(() => validateDraftConfig(raw)).toThrow(/shares must sum to 1/);
  });

  it('rejects a grade table without an F floor and a missing position weight', () => {
    const raw = clone();
    raw.grades = [{ grade: 'A', min: 70 }];
    expect(() => validateDraftConfig(raw)).toThrow(/floor/);
    const raw2 = clone();
    delete (raw2.positionWeights as Record<string, number>).QB;
    expect(() => validateDraftConfig(raw2)).toThrow(/positionWeights\.QB/);
  });

  it('rejects out-of-range scouting knobs', () => {
    const raw = clone();
    (raw.scouting as Record<string, unknown>).qualityFactor = [1];
    expect(() => validateDraftConfig(raw)).toThrow(/qualityFactor/);
    const zero = clone();
    (zero.scouting as Record<string, unknown>).sigmaDecay = 0;
    expect(() => validateDraftConfig(zero)).toThrow(/sigmaDecay must be positive/);
  });
});
