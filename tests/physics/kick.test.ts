import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import type { BallState } from '@/game/play-types';
import type { KickKind } from '@/game/play-events';
import { createBall, integrateBall } from '@/physics/ball';
import {
  CROSSBAR_HEIGHT, POST_HALF_WIDTH, aiKickMeter, applyKick, fieldGoalRange, fieldGoalResult, kickBall, kickoffDistance, maxAngleError,
  puntDistance, windComponents,
} from '@/physics/kick';
import { clearWeather } from './helpers';

const UP = { x: 0, y: 1 };
const SPOT = { x: 26.67, y: 45 };
const NO_WIND = { along: 0, cross: 0 };

const kick = (kind: KickKind, power: number, accuracy: number, aim: number, kp: number, ka: number, seed = 1): ReturnType<typeof kickBall> =>
  kickBall(SPOT, UP, kind, power, accuracy, aim, kp, ka, clearWeather(), createRng(seed));

/** Fly a kicked ball to its first ground contact. */
const flyKick = (launch: ReturnType<typeof kickBall>, kind: KickKind, weather = clearWeather()): { ball: BallState; ticks: number } => {
  const ball = applyKick(createBall(SPOT), SPOT, launch, 'off:K', kind, 0);
  let ticks = 0;
  while (ticks < 900) {
    const r = integrateBall(ball, TICK_DT, weather);
    ticks++;
    if (r.hitGround) break;
  }
  return { ball, ticks };
};

describe('kickBall', () => {
  it('kickoffs by a good kicker carry 60-75 yards with realistic hang time', () => {
    for (const rating of [75, 85, 95]) {
      const launch = kick('kickoff', 1, 0.9, 0, rating, 70);
      expect(launch.distance).toBeGreaterThanOrEqual(60);
      expect(launch.distance).toBeLessThanOrEqual(76);
      expect(launch.hangTime).toBeGreaterThan(3.5);
      expect(launch.hangTime).toBeLessThan(4.5);
      const { ball, ticks } = flyKick(launch, 'kickoff');
      expect(ball.kind).toBe('kickoff');
      expect(Math.abs(dist(ball.pos, SPOT) - launch.distance)).toBeLessThan(2);
      expect(Math.abs(ticks - launch.hangTicks)).toBeLessThanOrEqual(2);
    }
    expect(kickoffDistance(99, 1)).toBeCloseTo(76);
    expect(kickoffDistance(1, 0)).toBeCloseTo(52 * 0.6);
    expect(kickoffDistance(80, 0.5)).toBeLessThan(kickoffDistance(80, 1));
  });

  it('punts hang 4-5 s at 45-55 yards and land where they say', () => {
    const launch = kick('punt', 0.9, 0.9, 0, 75, 75);
    expect(launch.distance).toBeGreaterThanOrEqual(45);
    expect(launch.distance).toBeLessThanOrEqual(56);
    expect(launch.hangTime).toBeGreaterThanOrEqual(4);
    expect(launch.hangTime).toBeLessThanOrEqual(5);
    expect(launch.launchZ).toBe(1);
    const { ball } = flyKick(launch, 'punt');
    expect(ball.kind).toBe('punt');
    expect(Math.abs(dist(ball.pos, SPOT) - launch.distance)).toBeLessThan(2);
    expect(puntDistance(99, 1)).toBeCloseTo(60);
  });

  it('shanks a punt when the accuracy meter is badly missed', () => {
    const good = kick('punt', 0.9, 0.9, 0, 75, 75, 4);
    const bad = kick('punt', 0.9, 0.1, 0, 75, 75, 4);
    expect(bad.shanked).toBe(true);
    expect(good.shanked).toBe(false);
    expect(bad.distance).toBeLessThan(good.distance * 0.7);
    expect(bad.hangTime).toBeLessThan(good.hangTime);
    expect(Math.abs(bad.angle)).toBeGreaterThan(Math.abs(good.angle));
  });

  it('onside kicks are short, quick and bounce', () => {
    const launch = kick('onside', 0.8, 0.8, 0, 70, 70);
    expect(launch.distance).toBeGreaterThanOrEqual(12);
    expect(launch.distance).toBeLessThanOrEqual(18);
    expect(launch.hangTime).toBeLessThan(1.5);
    const ball = applyKick(createBall(SPOT), SPOT, launch, 'off:K', 'onside', 0);
    expect(ball.kind).toBe('kickoff');
    const rng = createRng(9);
    let bounced = false;
    for (let i = 0; i < 300; i++) if (integrateBall(ball, TICK_DT, clearWeather(), rng).bounced) bounced = true;
    expect(bounced).toBe(true);
    expect(ball.phase).toBe('loose');
  });

  it.each([30, 50, 70, 99])('field goal launches (power %i) clear the crossbar at the kicker\'s range and not well beyond', (kp) => {
    const launch = kick('fieldGoal', 1, 1, 0, kp, 99);
    const range = fieldGoalRange(kp, 1);
    const ball = applyKick(createBall(SPOT), SPOT, launch, 'off:K', 'fieldGoal', 0);
    expect(ball.crossedLos).toBe(false);
    let zAtRange = -1;
    let zBeyond = -1;
    for (let i = 0; i < 600; i++) {
      integrateBall(ball, TICK_DT, clearWeather());
      const travelled = ball.pos.y - SPOT.y;
      if (zAtRange < 0 && travelled >= range) zAtRange = ball.z;
      if (zBeyond < 0 && travelled >= range + 6) zBeyond = ball.z;
      if (ball.z <= 0) break;
    }
    // The dragged flight must still be above the bar exactly at range (the closed-form verdict says "made" there).
    expect(zAtRange).toBeGreaterThanOrEqual(CROSSBAR_HEIGHT);
    expect(zAtRange).toBeLessThan(CROSSBAR_HEIGHT + 1.5);
    expect(zBeyond).toBeLessThan(CROSSBAR_HEIGHT);
    expect(ball.kind).toBe('fieldGoal');
  });

  it('aim steers the ball and mistimed accuracy adds a bounded lateral error', () => {
    const straight = kick('kickoff', 1, 1, 0, 80, 99, 2);
    const right = kick('kickoff', 1, 1, 1, 80, 99, 2);
    const left = kick('kickoff', 1, 1, -1, 80, 99, 2);
    expect(right.vel.x).toBeGreaterThan(straight.vel.x + 1);
    expect(left.vel.x).toBeLessThan(straight.vel.x - 1);
    expect(Math.abs(straight.lateralError)).toBeLessThan(2);
    for (let seed = 0; seed < 20; seed++) {
      const wild = kick('fieldGoal', 1, 0, 0, 80, 40, seed);
      expect(Math.abs(wild.lateralError)).toBeLessThanOrEqual(Math.tan(maxAngleError(40) + 0.15) * wild.distance);
      expect(Math.abs(wild.lateralError)).toBeGreaterThan(1);
    }
  });

  it('windComponents splits wind into along and cross (+ = kicker\'s right)', () => {
    expect(windComponents(clearWeather({ windMph: 10, windDir: 0 }), UP)).toEqual({ along: expect.closeTo(0, 6), cross: expect.closeTo(10, 6) });
    expect(windComponents(clearWeather({ windMph: 10, windDir: Math.PI / 2 }), UP).along).toBeCloseTo(10);
    expect(windComponents(clearWeather({ windMph: 10, windDir: -Math.PI / 2 }), UP).along).toBeCloseTo(-10);
    const landing = kickBall(SPOT, UP, 'punt', 1, 1, 0, 80, 99, clearWeather({ windMph: 15, windDir: 0 }), createRng(1)).landing;
    expect(landing.x).toBeGreaterThan(SPOT.x + 3);
  });
});

describe('fieldGoalResult', () => {
  const rate = (distance: number, kp: number, ka: number, seed: number, wind = NO_WIND): number => {
    const rng = createRng(seed);
    let made = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const m = aiKickMeter(kp, ka, rng);
      if (fieldGoalResult(distance, m.power, m.accuracy, kp, ka, wind, { hookSign: rng.chance(0.5) ? 1 : -1 }).made) made++;
    }
    return made / n;
  };

  it('an average kicker is automatic from 25, decent from 45 and hopeless from 60', () => {
    expect(rate(25, 50, 50, 1)).toBeGreaterThan(0.9);
    const mid = rate(45, 50, 50, 2);
    expect(mid).toBeGreaterThan(0.55);
    expect(mid).toBeLessThan(0.95);
    expect(rate(60, 50, 50, 3)).toBeLessThan(0.1);
  });

  it('elite kickers extend the range and are more accurate', () => {
    expect(rate(55, 99, 99, 4)).toBeGreaterThan(0.7);
    expect(rate(45, 99, 99, 5)).toBeGreaterThan(rate(45, 50, 50, 5));
    expect(rate(45, 20, 20, 6)).toBeLessThan(rate(45, 50, 50, 6));
  });

  it('classifies misses and reports margins', () => {
    const short = fieldGoalResult(65, 1, 1, 50, 50, NO_WIND);
    expect(short.made).toBe(false);
    expect(short.missReason).toBe('short');
    expect(short.margin).toBeLessThan(0);
    const wideRight = fieldGoalResult(45, 1, 0, 50, 50, NO_WIND, { hookSign: 1 });
    expect(wideRight.missReason).toBe('wideRight');
    expect(wideRight.lateral).toBeGreaterThan(POST_HALF_WIDTH);
    const wideLeft = fieldGoalResult(45, 1, 0, 50, 50, NO_WIND, { hookSign: -1 });
    expect(wideLeft.missReason).toBe('wideLeft');
    const good = fieldGoalResult(30, 1, 1, 50, 50, NO_WIND);
    expect(good.made).toBe(true);
    expect(good.missReason).toBeNull();
    expect(good.margin).toBeGreaterThan(0);
    expect(good.lateral).toBeCloseTo(0);
    // Aim can pull a perfect kick wide, or compensate a hook.
    expect(fieldGoalResult(45, 1, 1, 50, 50, NO_WIND, { aim: 1 }).lateral).toBeGreaterThan(3);
    const hooked = fieldGoalResult(45, 1, 0.6, 50, 50, NO_WIND, { hookSign: 1 });
    const compensated = fieldGoalResult(45, 1, 0.6, 50, 50, NO_WIND, { hookSign: 1, aim: -0.6 });
    expect(Math.abs(compensated.lateral)).toBeLessThan(Math.abs(hooked.lateral));
  });

  it('wind lengthens or shortens the range and pushes the ball sideways', () => {
    const calm = fieldGoalResult(50, 1, 1, 60, 60, NO_WIND);
    const tail = fieldGoalResult(50, 1, 1, 60, 60, { along: 15, cross: 0 });
    const head = fieldGoalResult(50, 1, 1, 60, 60, { along: -15, cross: 0 });
    expect(tail.range).toBeGreaterThan(calm.range);
    expect(head.range).toBeLessThan(calm.range);
    const cross = fieldGoalResult(50, 1, 1, 60, 60, { along: 0, cross: 20 });
    expect(cross.lateral).toBeGreaterThan(0.5);
    expect(rate(50, 60, 60, 7, { along: -20, cross: 0 })).toBeLessThan(rate(50, 60, 60, 7, { along: 20, cross: 0 }));
  });

  it('aiKickMeter stays in range and tightens with rating', () => {
    const rng = createRng(8);
    let accLow = 0;
    let accHigh = 0;
    for (let i = 0; i < 500; i++) {
      const lo = aiKickMeter(20, 20, rng);
      const hi = aiKickMeter(99, 99, rng);
      for (const m of [lo, hi]) {
        expect(m.power).toBeGreaterThanOrEqual(0.4);
        expect(m.power).toBeLessThanOrEqual(1);
        expect(m.accuracy).toBeGreaterThanOrEqual(0);
        expect(m.accuracy).toBeLessThanOrEqual(1);
      }
      accLow += lo.accuracy;
      accHigh += hi.accuracy;
    }
    expect(accHigh).toBeGreaterThan(accLow);
  });
});
