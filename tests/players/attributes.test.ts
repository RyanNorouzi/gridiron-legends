import { describe, expect, it } from 'vitest';
import {
  POSITION_WEIGHTS, applyAttrDeltas, attributeWeight, averageAttrs, clampAttrs, computeOverall, diffAttrs,
  emptyAttrs, positionAttributeProfile, validatePositionWeights,
} from '@/players/attributes';
import { ATTRIBUTE_KEYS, POSITIONS } from '@/players/types';
import type { AttributeKey } from '@/players/types';

describe('position weights', () => {
  it('every position has weights over known attributes that sum to 1', () => {
    for (const pos of POSITIONS) {
      const weights = POSITION_WEIGHTS[pos];
      const keys = Object.keys(weights) as AttributeKey[];
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(ATTRIBUTE_KEYS).toContain(k);
      const sum = keys.reduce((a, k) => a + (weights[k] ?? 0), 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
  it('validatePositionWeights rejects bad tables', () => {
    expect(() => validatePositionWeights({ QB: { speed: 1 } })).toThrow(/missing position/);
    const full: Record<string, Record<string, number>> = {};
    for (const pos of POSITIONS) full[pos] = { speed: 1 };
    expect(validatePositionWeights(full)).toBeTruthy();
    full.QB = { speed: 0.5 };
    expect(() => validatePositionWeights(full)).toThrow(/sum/);
    full.QB = { speed: 0.5, notAnAttribute: 0.5 };
    expect(() => validatePositionWeights(full)).toThrow(/unknown attribute/);
    full.QB = { speed: 1.5, agility: -0.5 };
    expect(() => validatePositionWeights(full)).toThrow(/must be a number/);
  });
  it('attributeWeight is 0 for unweighted attributes', () => {
    expect(attributeWeight('QB', 'throwAccuracy')).toBeGreaterThan(0.2);
    expect(attributeWeight('QB', 'kickPower')).toBe(0);
    expect(attributeWeight('OT', 'speed')).toBe(0);
  });
});

describe('computeOverall', () => {
  it('flat attribute sets map to themselves for every position', () => {
    for (const pos of POSITIONS) {
      expect(computeOverall(emptyAttrs(50), pos)).toBe(50);
      expect(computeOverall(emptyAttrs(99), pos)).toBe(99);
      expect(computeOverall(emptyAttrs(1), pos)).toBe(1);
    }
  });
  it('is position-sensitive: a passer profile rates far higher at QB than at OT', () => {
    const attrs = emptyAttrs(40);
    attrs.throwAccuracy = 95;
    attrs.throwPower = 92;
    attrs.awareness = 90;
    attrs.vision = 90;
    const qb = computeOverall(attrs, 'QB');
    const ot = computeOverall(attrs, 'OT');
    expect(qb).toBeGreaterThan(80);
    expect(ot).toBeLessThan(55);
    expect(qb - ot).toBeGreaterThan(25);
  });
  it('a blocker profile rates higher at OG than at CB', () => {
    const attrs = emptyAttrs(45);
    attrs.blocking = 96;
    attrs.strength = 94;
    attrs.awareness = 80;
    expect(computeOverall(attrs, 'OG')).toBeGreaterThan(computeOverall(attrs, 'CB') + 25);
  });
  it('always returns an integer in 1..99', () => {
    const attrs = emptyAttrs(1);
    attrs.speed = 99;
    for (const pos of POSITIONS) {
      const o = computeOverall(attrs, pos);
      expect(Number.isInteger(o)).toBe(true);
      expect(o).toBeGreaterThanOrEqual(1);
      expect(o).toBeLessThanOrEqual(99);
    }
  });
});

describe('clampAttrs / emptyAttrs / averageAttrs', () => {
  it('clampAttrs rounds and clamps into 1..99 and returns a new object', () => {
    const attrs = emptyAttrs(50);
    attrs.speed = 120;
    attrs.agility = -5;
    attrs.hands = 55.6;
    const out = clampAttrs(attrs);
    expect(out).not.toBe(attrs);
    expect(out.speed).toBe(99);
    expect(out.agility).toBe(1);
    expect(out.hands).toBe(56);
    expect(out.strength).toBe(50);
  });
  it('emptyAttrs fills every key and clamps the value', () => {
    const one = emptyAttrs();
    for (const k of ATTRIBUTE_KEYS) expect(one[k]).toBe(1);
    expect(emptyAttrs(500).speed).toBe(99);
    expect(Object.keys(emptyAttrs(30))).toHaveLength(ATTRIBUTE_KEYS.length);
  });
  it('averageAttrs averages per key and yields zeros for an empty list', () => {
    const avg = averageAttrs([emptyAttrs(50), emptyAttrs(70)]);
    for (const k of ATTRIBUTE_KEYS) expect(avg[k]).toBe(60);
    const a = emptyAttrs(10);
    a.speed = 40;
    const avg2 = averageAttrs([a, emptyAttrs(10), emptyAttrs(10)]);
    expect(avg2.speed).toBe(20);
    expect(avg2.agility).toBe(10);
    for (const k of ATTRIBUTE_KEYS) expect(averageAttrs([])[k]).toBe(0);
  });
  it('applyAttrDeltas and diffAttrs round-trip', () => {
    const base = emptyAttrs(50);
    const next = applyAttrDeltas(base, { speed: 5, hands: -60, vision: 0 });
    expect(next.speed).toBe(55);
    expect(next.hands).toBe(1);
    expect(base.speed).toBe(50);
    expect(diffAttrs(base, next)).toEqual({ speed: 5, hands: -49 });
  });
});

describe('positionAttributeProfile', () => {
  it('partitions every attribute exactly once', () => {
    for (const pos of POSITIONS) {
      const p = positionAttributeProfile(pos);
      const all = [...p.primary, ...p.secondary, ...p.irrelevant];
      expect(all).toHaveLength(ATTRIBUTE_KEYS.length);
      expect(new Set(all).size).toBe(ATTRIBUTE_KEYS.length);
    }
  });
  it('QB primary is passing-driven; kicking is irrelevant; primary sorted by weight', () => {
    const p = positionAttributeProfile('QB');
    expect(p.primary[0]).toBe('throwAccuracy');
    expect(p.primary).toEqual(expect.arrayContaining(['throwPower', 'awareness', 'vision']));
    expect(p.irrelevant).toEqual(expect.arrayContaining(['kickPower', 'kickAccuracy', 'coverage']));
    for (let i = 1; i < p.primary.length; i++) {
      expect(attributeWeight('QB', p.primary[i - 1] as AttributeKey)).toBeGreaterThanOrEqual(attributeWeight('QB', p.primary[i] as AttributeKey));
    }
    for (const k of p.secondary) expect(attributeWeight('QB', k)).toBeLessThan(0.1);
    for (const k of p.secondary) expect(attributeWeight('QB', k)).toBeGreaterThan(0);
  });
  it('returns fresh copies so callers cannot corrupt the cache', () => {
    const p = positionAttributeProfile('CB');
    p.primary.length = 0;
    expect(positionAttributeProfile('CB').primary.length).toBeGreaterThan(0);
  });
  it('kickers only care about kicking', () => {
    const p = positionAttributeProfile('K');
    expect(p.primary).toEqual(['kickAccuracy', 'kickPower']);
    expect(p.irrelevant).toContain('speed');
  });
});
