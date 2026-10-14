import { describe, expect, it } from 'vitest';
import { add, angleDiff, clampLen, dist, fromAngle, len, normalize, rotate, sub, vec2 } from '@/core/vec2';

describe('vec2', () => {
  it('basic arithmetic', () => {
    expect(add(vec2(1, 2), vec2(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(vec2(1, 2), vec2(3, 4))).toEqual({ x: -2, y: -2 });
    expect(len(vec2(3, 4))).toBe(5);
    expect(dist(vec2(0, 0), vec2(3, 4))).toBe(5);
  });
  it('normalize handles zero vectors', () => {
    expect(normalize(vec2(0, 0))).toEqual({ x: 0, y: 0 });
    const n = normalize(vec2(0, 5));
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(1);
  });
  it('clampLen limits magnitude', () => {
    expect(len(clampLen(vec2(30, 40), 5))).toBeCloseTo(5);
    expect(clampLen(vec2(1, 0), 5)).toEqual({ x: 1, y: 0 });
  });
  it('rotate and fromAngle agree', () => {
    const r = rotate(vec2(1, 0), Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
    const f = fromAngle(Math.PI, 2);
    expect(f.x).toBeCloseTo(-2);
    expect(f.y).toBeCloseTo(0);
  });
  it('angleDiff wraps correctly', () => {
    expect(angleDiff(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDiff(Math.PI * 0.9, -Math.PI * 0.9)).toBeCloseTo(Math.PI * 0.2);
    expect(angleDiff(-Math.PI * 0.9, Math.PI * 0.9)).toBeCloseTo(-Math.PI * 0.2);
  });
});
