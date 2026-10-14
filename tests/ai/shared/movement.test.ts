import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist, dot, len, normalize, sub } from '@/core/vec2';
import { idleIntent, moveIntent } from '@/game/engine-api';
import { arrive, avoid, faceAndBackpedal, holdPosition, intercept, interceptSolution, seek, toward } from '@/ai/movement';
import { makeAthlete } from '../../physics/helpers';
import { step } from './helpers';

describe('movement intents', () => {
  it('seek moves straight at the target and idles once there', () => {
    const a = makeAthlete({ pos: { x: 10, y: 10 } });
    const i = seek(a, { x: 10, y: 30 });
    expect(i.move).toEqual({ x: 0, y: 1 });
    expect(i.sprint).toBe(true);
    expect(seek(a, { x: 10, y: 10.05 }).move).toEqual({ x: 0, y: 0 });
  });

  it('arrive eases the effort inside the slow radius', () => {
    const a = makeAthlete({ pos: { x: 10, y: 10 } });
    expect(len(arrive(a, { x: 10, y: 40 }, 3).move)).toBeCloseTo(1, 6);
    const near = arrive(a, { x: 10, y: 11 }, 4);
    expect(len(near.move)).toBeLessThan(0.5);
    expect(near.sprint).toBe(false);
  });

  it('intercept picks a point ahead of a moving target and the chaser actually meets it', () => {
    const chaser = makeAthlete({ pos: { x: 20, y: 50 }, attrs: { speed: 85, acceleration: 85 } });
    const target = { pos: { x: 30, y: 40 }, vel: { x: 0, y: 7 } };
    const sol = interceptSolution(chaser, target, 1);
    expect(sol.reachable).toBe(true);
    expect(sol.point.y).toBeGreaterThan(target.pos.y + 2);
    const first = intercept(chaser, target, 1);
    const direct = toward(chaser.pos, target.pos);
    // The heading leads the target along its velocity.
    expect(dot(first.move, normalize(target.vel))).toBeGreaterThan(dot(direct, normalize(target.vel)));
    // Emergent: integrate both; the chaser gets within a yard of the target.
    let closest = Infinity;
    for (let t = 0; t < 300; t++) {
      step(chaser, intercept(chaser, target, 1));
      target.pos = { x: target.pos.x + target.vel.x * TICK_DT, y: target.pos.y + target.vel.y * TICK_DT };
      closest = Math.min(closest, dist(chaser.pos, target.pos));
      if (closest < 1) break;
    }
    expect(closest).toBeLessThan(1);
  });

  it('low quality chases the current position instead of the intercept', () => {
    const chaser = makeAthlete({ pos: { x: 20, y: 50 } });
    const target = { pos: { x: 30, y: 40 }, vel: { x: 0, y: 7 } };
    const q0 = interceptSolution(chaser, target, 0).point;
    const q1 = interceptSolution(chaser, target, 1).point;
    expect(q0.y).toBeCloseTo(target.pos.y, 6);
    expect(q1.y).toBeGreaterThan(q0.y);
  });

  it('avoid steers around a teammate in the path and leaves clear paths alone', () => {
    const a = makeAthlete({ pos: { x: 20, y: 20 } });
    const mate = makeAthlete({ pos: { x: 20.6, y: 21.5 } });
    const clear = makeAthlete({ pos: { x: 30, y: 20 } });
    const intent = moveIntent({ x: 0, y: 1 }, true, 'go');
    const steered = avoid(a, [mate], intent);
    expect(steered.move.x).toBeLessThan(-0.1);
    expect(steered.debug).toContain('avoid');
    expect(len(steered.move)).toBeCloseTo(1, 6);
    expect(avoid(a, [clear], intent)).toBe(intent);
    expect(avoid(a, [mate], idleIntent())).toEqual(idleIntent());
  });

  it('faceAndBackpedal keeps the eyes on the target and picks backpedal vs strafe', () => {
    const a = makeAthlete({ pos: { x: 20, y: 20 } });
    const back = faceAndBackpedal(a, { x: 20, y: 10 }, { x: 0, y: 1 });
    expect(back.locomotion).toBe('backpedal');
    expect(back.face).toBeCloseTo(-Math.PI / 2, 6);
    const side = faceAndBackpedal(a, { x: 20, y: 10 }, { x: 1, y: 0 });
    expect(side.locomotion).toBe('strafe');
    expect(len(faceAndBackpedal(a, { x: 20, y: 10 }, { x: 0, y: 0 }).move)).toBe(0);
    expect(holdPosition(a, 1.2).face).toBe(1.2);
    expect(sub(a.pos, a.pos)).toEqual({ x: 0, y: 0 });
  });
});
