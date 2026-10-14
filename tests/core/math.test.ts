import { describe, expect, it } from 'vitest';
import { approach, clamp, ratingToFactor, remap, logistic } from '@/core/math';

describe('math', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
  it('remap clamps into output range', () => {
    expect(remap(50, 0, 100, 0, 10)).toBe(5);
    expect(remap(500, 0, 100, 0, 10)).toBe(10);
  });
  it('approach never overshoots', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(10, 0, 4)).toBe(6);
  });
  it('ratingToFactor maps 1..99 to 0..1', () => {
    expect(ratingToFactor(1)).toBe(0);
    expect(ratingToFactor(99)).toBe(1);
    expect(ratingToFactor(50)).toBeCloseTo(0.5);
    expect(ratingToFactor(50, 2)).toBeCloseTo(0.25);
  });
  it('logistic is 0.5 at midpoint', () => {
    expect(logistic(0)).toBeCloseTo(0.5);
    expect(logistic(10, 0, 1)).toBeGreaterThan(0.99);
  });
});
