import { describe, expect, it } from 'vitest';
import { createRng, restoreRng } from '@/core/rng';

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('accepts string seeds deterministically', () => {
    expect(createRng('season-2026').next()).toBe(createRng('season-2026').next());
    expect(createRng('a').next()).not.toBe(createRng('b').next());
  });

  it('next() stays within [0,1) and int() within bounds', () => {
    const r = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = r.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
    }
  });

  it('int() covers the full inclusive range', () => {
    const r = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(r.int(0, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('weighted() respects weights roughly', () => {
    const r = createRng(5);
    let heavy = 0;
    for (let i = 0; i < 10000; i++) if (r.weighted(['a', 'b'], [9, 1]) === 'a') heavy++;
    expect(heavy / 10000).toBeGreaterThan(0.85);
    expect(heavy / 10000).toBeLessThan(0.95);
  });

  it('gaussian() has roughly the requested mean and spread', () => {
    const r = createRng(11);
    const xs = Array.from({ length: 20000 }, () => r.gaussian(50, 10));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(mean).toBeGreaterThan(49);
    expect(mean).toBeLessThan(51);
    expect(sd).toBeGreaterThan(9.5);
    expect(sd).toBeLessThan(10.5);
  });

  it('shuffle() is a permutation and does not mutate input', () => {
    const r = createRng(3);
    const input = [1, 2, 3, 4, 5, 6];
    const out = r.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...out].sort()).toEqual(input);
  });

  it('fork() is deterministic and label-sensitive', () => {
    const a = createRng(8).fork('plays');
    const b = createRng(8).fork('plays');
    const c = createRng(8).fork('draft');
    expect(a.next()).toBe(b.next());
    expect(createRng(8).fork('plays').next()).not.toBe(c.next());
  });

  it('state can be saved and restored', () => {
    const r = createRng(123);
    r.next();
    r.next();
    const state = r.getState();
    const expected = [r.next(), r.next(), r.next()];
    const restored = restoreRng(123, state);
    expect([restored.next(), restored.next(), restored.next()]).toEqual(expected);
  });

  it('pick() throws on empty arrays', () => {
    expect(() => createRng(1).pick([])).toThrow();
  });
});
