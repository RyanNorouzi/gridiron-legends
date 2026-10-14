import { describe, expect, it } from 'vitest';
import { dist } from '@/core/vec2';
import { athletesWithin, circleHit, findOverlaps, interceptPoint, pointSegmentDistance, predictClosest, separate } from '@/physics/collision';
import { makeAthlete } from './helpers';

describe('collision', () => {
  it('circleHit detects intersection but not touching', () => {
    expect(circleHit({ x: 0, y: 0 }, 0.5, { x: 0.9, y: 0 }, 0.5)).toBe(true);
    expect(circleHit({ x: 0, y: 0 }, 0.5, { x: 1, y: 0 }, 0.5)).toBe(false);
    expect(circleHit({ x: 0, y: 0 }, 0.5, { x: 3, y: 4 }, 0.5)).toBe(false);
  });

  it('findOverlaps reports penetration and skips inactive athletes', () => {
    const a = makeAthlete({ pos: { x: 10, y: 10 } });
    const b = makeAthlete({ pos: { x: 10.6, y: 10 } });
    const c = makeAthlete({ pos: { x: 10.3, y: 10.2 }, active: false });
    const far = makeAthlete({ pos: { x: 30, y: 30 } });
    const overlaps = findOverlaps([a, b, c, far]);
    expect(overlaps).toHaveLength(1);
    const o = overlaps[0]!;
    expect(o.a).toBe(a);
    expect(o.b).toBe(b);
    expect(o.penetration).toBeCloseTo(0.4, 6);
    expect(o.normal.x).toBeCloseTo(1, 6);
    expect(o.normal.y).toBeCloseTo(0, 6);
  });

  it('separate splits the correction by mass and removes the overlap', () => {
    const light = makeAthlete({ pos: { x: 10, y: 10 }, massLb: 180 });
    const heavy = makeAthlete({ pos: { x: 10.5, y: 10 }, massLb: 320 });
    const [o] = findOverlaps([light, heavy]);
    separate(light, heavy, o!.penetration, o!.normal);
    expect(dist(light.pos, heavy.pos)).toBeCloseTo(1, 6);
    expect(10 - light.pos.x).toBeGreaterThan(heavy.pos.x - 10.5);
    expect(10 - light.pos.x).toBeCloseTo(0.5 * (320 / 500), 6);
    expect(findOverlaps([light, heavy])).toHaveLength(0);
  });

  it('separate handles coincident centres deterministically and ignores non-positive penetration', () => {
    const a = makeAthlete({ pos: { x: 5, y: 5 } });
    const b = makeAthlete({ pos: { x: 5, y: 5 } });
    separate(a, b, 1);
    expect(dist(a.pos, b.pos)).toBeCloseTo(1, 6);
    const c = makeAthlete({ pos: { x: 1, y: 1 } });
    separate(c, a, 0);
    expect(c.pos).toEqual({ x: 1, y: 1 });
  });

  it('predictClosest finds the meeting time for converging movers and clamps otherwise', () => {
    const a = { pos: { x: 0, y: 0 }, vel: { x: 5, y: 0 } };
    const b = { pos: { x: 10, y: 0 }, vel: { x: -5, y: 0 } };
    const r = predictClosest(a, b, 5);
    expect(r.time).toBeCloseTo(1, 6);
    expect(r.distance).toBeCloseTo(0, 6);
    expect(r.posA.x).toBeCloseTo(5);
    const diverging = predictClosest(a, { pos: { x: 10, y: 0 }, vel: { x: 5, y: 0 } }, 5);
    expect(diverging.time).toBe(0);
    expect(diverging.distance).toBeCloseTo(10);
    const clamped = predictClosest({ pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 } }, { pos: { x: 100, y: 0 }, vel: { x: 0, y: 0 } }, 2);
    expect(clamped.time).toBe(2);
    expect(clamped.distance).toBeCloseTo(98);
  });

  it('interceptPoint solves the pursuit triangle', () => {
    const still = interceptPoint({ pos: { x: 0, y: 0 }, speed: 8 }, { pos: { x: 16, y: 0 }, vel: { x: 0, y: 0 } });
    expect(still).not.toBeNull();
    expect(still!.time).toBeCloseTo(2, 6);
    expect(still!.pos).toEqual({ x: 16, y: 0 });
    const target = { pos: { x: 10, y: 0 }, vel: { x: 0, y: 6 } };
    const hit = interceptPoint({ pos: { x: 0, y: 0 }, speed: 10 }, target);
    expect(hit).not.toBeNull();
    // The chaser covers speed*time and arrives where the target will be.
    expect(dist({ x: 0, y: 0 }, hit!.pos)).toBeCloseTo(10 * hit!.time, 6);
    expect(hit!.pos.x).toBeCloseTo(10);
    expect(hit!.pos.y).toBeCloseTo(6 * hit!.time);
  });

  it('interceptPoint returns null when the target is pulling away faster than the chaser', () => {
    expect(interceptPoint({ pos: { x: 0, y: 0 }, speed: 7 }, { pos: { x: 5, y: 0 }, vel: { x: 9, y: 0 } })).toBeNull();
    // Same speed, moving away: unreachable; same speed, moving toward: reachable.
    expect(interceptPoint({ pos: { x: 0, y: 0 }, speed: 8 }, { pos: { x: 5, y: 0 }, vel: { x: 8, y: 0 } })).toBeNull();
    const toward = interceptPoint({ pos: { x: 0, y: 0 }, speed: 8 }, { pos: { x: 16, y: 0 }, vel: { x: -8, y: 0 } });
    expect(toward!.time).toBeCloseTo(1);
    // A faster target that is still ahead of the chaser can be caught if it runs toward them.
    const cross = interceptPoint({ pos: { x: 0, y: 0 }, speed: 6 }, { pos: { x: 20, y: 0 }, vel: { x: -10, y: 0 } });
    expect(cross!.time).toBeCloseTo(20 / 16);
    expect(interceptPoint({ pos: { x: 0, y: 0 }, speed: 0 }, { pos: { x: 1, y: 0 }, vel: { x: 0, y: 0 } })).toBeNull();
  });

  it('pointSegmentDistance and athletesWithin', () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
    expect(pointSegmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    expect(pointSegmentDistance({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(Math.SQRT2);
    const near = makeAthlete({ pos: { x: 1, y: 0 } });
    const nearer = makeAthlete({ pos: { x: 0.5, y: 0 } });
    const gone = makeAthlete({ pos: { x: 0.2, y: 0 }, active: false });
    const far = makeAthlete({ pos: { x: 9, y: 0 } });
    expect(athletesWithin([near, far, nearer, gone], { x: 0, y: 0 }, 3)).toEqual([nearer, near]);
  });
});
