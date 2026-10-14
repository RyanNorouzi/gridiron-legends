import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import type { BallState } from '@/game/play-types';
import type { ThrowType } from '@/game/play-events';
import {
  BACK_SHOULDER_SHORTEN, CARRY_HEIGHT, GRAVITY, MAX_BOUNCE_VZ, RELEASE_HEIGHT, armSpeed, ballHeightAt, createBall, deadBall, fumbleBall,
  handoffBall, holdBall, integrateBall, launchPass, lateralBall, pitchBall, predictLanding, snapBall, throwBall, tipBall, timeToHeight,
} from '@/physics/ball';
import { applyKick, kickBall } from '@/physics/kick';
import { clearWeather } from './helpers';

const FROM = { x: 26, y: 20 };

/** Fly a launched pass until it descends through its landing height; returns the position and ticks used. */
const flyToLanding = (ball: BallState, landingZ: number, weather = clearWeather()): { pos: { x: number; y: number }; ticks: number } => {
  let ticks = 0;
  while (ticks < 600) {
    integrateBall(ball, TICK_DT, weather);
    ticks++;
    if (ball.vz < 0 && ball.z <= landingZ) break;
  }
  return { pos: { ...ball.pos }, ticks };
};

const thrown = (to: { x: number; y: number }, type: ThrowType, power = 80): { ball: BallState; landingZ: number; flightTicks: number; apex: number; capped: boolean } => {
  const launch = launchPass(FROM, to, type, power);
  const ball = throwBall(createBall(FROM), { id: 'off:QB', pos: FROM }, launch, { id: 'off:WR1', pos: to }, type, 100);
  return { ball, landingZ: launch.landingZ, flightTicks: launch.flightTicks, apex: launch.apex, capped: launch.capped };
};

describe('launchPass', () => {
  it.each(['bullet', 'touch', 'lob', 'highPoint'] as const)('%s lands within a yard of the target with no error term', (type) => {
    const to = { x: 30, y: 52 };
    const { ball, landingZ, flightTicks } = thrown(to, type);
    expect(ball.phase).toBe('inAir');
    expect(ball.kind).toBe('pass');
    expect(ball.z).toBe(RELEASE_HEIGHT);
    expect(ball.landingTick).toBe(100 + flightTicks);
    const { pos, ticks } = flyToLanding(ball, landingZ);
    expect(dist(pos, to)).toBeLessThan(1);
    expect(Math.abs(ticks - flightTicks)).toBeLessThanOrEqual(2);
  });

  it('short and long throws both arrive on target', () => {
    for (const to of [{ x: 27, y: 24 }, { x: 40, y: 45 }, { x: 10, y: 70 }]) {
      const { ball, landingZ } = thrown(to, 'bullet', 90);
      expect(dist(flyToLanding(ball, landingZ).pos, to)).toBeLessThan(1);
    }
  });

  it('lob has a higher apex and longer flight than touch, which is higher than a bullet', () => {
    const to = { x: 26, y: 50 };
    const bullet = launchPass(FROM, to, 'bullet', 80);
    const touch = launchPass(FROM, to, 'touch', 80);
    const lob = launchPass(FROM, to, 'lob', 80);
    expect(lob.apex).toBeGreaterThan(touch.apex);
    expect(touch.apex).toBeGreaterThan(bullet.apex);
    expect(lob.flightTicks).toBeGreaterThan(touch.flightTicks);
    expect(touch.flightTicks).toBeGreaterThan(bullet.flightTicks);
    expect(bullet.launchSpeed).toBeLessThanOrEqual(armSpeed(80) * 1.005);
    expect(bullet.launchSpeed).toBeGreaterThan(armSpeed(80) * 0.98);
    expect(bullet.capped).toBe(false);
  });

  it('highPoint arrives high; backShoulder arrives short and low', () => {
    const to = { x: 26, y: 50 };
    const high = launchPass(FROM, to, 'highPoint', 80);
    const back = launchPass(FROM, to, 'backShoulder', 80);
    const bullet = launchPass(FROM, to, 'bullet', 80);
    expect(high.landingZ).toBeGreaterThan(bullet.landingZ);
    expect(back.landingZ).toBeLessThan(bullet.landingZ);
    expect(dist(back.aimPoint, to)).toBeCloseTo(BACK_SHOULDER_SHORTEN, 6);
    const { ball, landingZ } = thrown(to, 'backShoulder');
    const landed = flyToLanding(ball, landingZ).pos;
    expect(dist(landed, back.aimPoint)).toBeLessThan(1);
    expect(landed.y).toBeLessThan(to.y - 0.5);
  });

  it('caps the launch at arm strength so a weak arm falls short of a bomb', () => {
    const to = { x: 26, y: 85 };
    const weak = launchPass(FROM, to, 'bullet', 1);
    expect(weak.capped).toBe(true);
    expect(weak.launchSpeed).toBeCloseTo(armSpeed(1), 6);
    const { ball, landingZ } = thrown(to, 'bullet', 1);
    const landed = flyToLanding(ball, landingZ).pos;
    expect(landed.y).toBeLessThan(to.y - 10);
    const cannon = launchPass(FROM, { x: 26, y: 84 }, 'bullet', 99);
    expect(cannon.capped).toBe(false);
    expect(launchPass(FROM, { x: 26, y: 95 }, 'bullet', 99).capped).toBe(true);
  });

  it('honours a custom release height end to end and resets crossedLos on the throw', () => {
    const to = { x: 26, y: 55 };
    const launch = launchPass(FROM, to, 'bullet', 80, { releaseHeight: 3 });
    expect(launch.releaseZ).toBe(3);
    const stale = { ...createBall(FROM), crossedLos: true };
    const ball = throwBall(stale, { id: 'off:QB', pos: FROM }, launch, { id: 'off:WR1', pos: to }, 'bullet', 5);
    expect(ball.z).toBe(3);
    expect(ball.crossedLos).toBe(false);
    expect(dist(flyToLanding(ball, launch.landingZ).pos, to)).toBeLessThan(1);
    // The default profile still releases at RELEASE_HEIGHT.
    expect(launchPass(FROM, to, 'lob', 80).releaseZ).toBe(RELEASE_HEIGHT);
  });

  it('wind shifts the landing spot downwind', () => {
    const to = { x: 26, y: 55 };
    const calm = thrown(to, 'lob');
    const windy = thrown(to, 'lob');
    const calmLanding = flyToLanding(calm.ball, calm.landingZ).pos;
    const windyLanding = flyToLanding(windy.ball, windy.landingZ, clearWeather({ type: 'wind', windMph: 15, windDir: 0 })).pos;
    expect(windyLanding.x - calmLanding.x).toBeGreaterThan(0.5);
    expect(Math.abs(windyLanding.y - calmLanding.y)).toBeLessThan(0.3);
  });

  it('predictLanding and ballHeightAt agree with the integrator', () => {
    const to = { x: 32, y: 60 };
    const weather = clearWeather({ type: 'wind', windMph: 12, windDir: Math.PI / 3 });
    const { ball, landingZ, flightTicks } = thrown(to, 'touch');
    const prediction = predictLanding(ball, weather, landingZ);
    expect(prediction.reaches).toBe(true);
    expect(Math.abs(prediction.ticks - flightTicks)).toBeLessThanOrEqual(2);
    const h5 = ballHeightAt(ball, 5);
    expect(ballHeightAt(ball, 0)).toBe(RELEASE_HEIGHT);
    const actual = flyToLanding(ball, landingZ, weather);
    expect(dist(prediction.pos, actual.pos)).toBeLessThan(0.05);
    expect(prediction.ticks).toBe(actual.ticks);
    expect(h5).toBeGreaterThan(RELEASE_HEIGHT);
    const resting = createBall({ x: 1, y: 1 });
    expect(predictLanding(resting).ticks).toBe(0);
    expect(ballHeightAt(resting, 30)).toBe(0);
    expect(timeToHeight(2, 5, 1)).toBeGreaterThan(0);
    expect(timeToHeight(0, 1, 10)).toBeNull();
  });
});

describe('integrateBall on the ground', () => {
  it('a dropped ball bounces erratically with the rng, then settles and rolls to a stop', () => {
    const rng = createRng(11);
    const ball: BallState = { ...createBall({ x: 20, y: 40 }), phase: 'loose', kind: 'fumble', z: 2, vel: { x: 3, y: 1 }, vz: 0 };
    let hits = 0;
    let bounces = 0;
    let settledTick = -1;
    for (let i = 0; i < 600; i++) {
      const r = integrateBall(ball, TICK_DT, clearWeather(), rng);
      if (r.hitGround) hits++;
      if (r.bounced) bounces++;
      if (r.settled) { settledTick = i; break; }
    }
    expect(hits).toBeGreaterThanOrEqual(1);
    expect(bounces).toBeGreaterThanOrEqual(1);
    expect(settledTick).toBeGreaterThan(0);
    expect(ball.vel).toEqual({ x: 0, y: 0 });
    expect(ball.z).toBe(0);
    expect(ball.pos.x).toBeGreaterThan(20);
  });

  it('a punt hops a few yards at most and settles within a realistic roll, across many seeds', () => {
    const spot = { x: 26.67, y: 30 };
    const maxApex = (MAX_BOUNCE_VZ * MAX_BOUNCE_VZ) / (2 * GRAVITY);
    let worstApex = 0;
    let worstRoll = 0;
    let settledAll = true;
    for (let seed = 0; seed < 60; seed++) {
      const rng = createRng(seed);
      const launch = kickBall(spot, { x: 0, y: 1 }, 'punt', 1, 1, 0, 90, 90, clearWeather(), rng);
      const ball = applyKick(createBall(spot), spot, launch, 'off:P', 'punt', 0);
      let landed = false;
      let landY = 0;
      let apex = 0;
      let settled = false;
      for (let i = 0; i < 1500 && !settled; i++) {
        const r = integrateBall(ball, TICK_DT, clearWeather(), rng);
        if (r.hitGround && !landed) { landed = true; landY = ball.pos.y; }
        if (landed) apex = Math.max(apex, ball.z);
        settled = r.settled;
      }
      settledAll &&= settled;
      worstApex = Math.max(worstApex, apex);
      worstRoll = Math.max(worstRoll, Math.abs(ball.pos.y - landY));
    }
    expect(settledAll).toBe(true);
    expect(worstApex).toBeLessThanOrEqual(maxApex + 0.05);
    expect(worstApex).toBeGreaterThan(1);
    expect(worstRoll).toBeLessThan(25);
  });

  it('bounces are deterministic per seed and differ across seeds', () => {
    const roll = (seed: number): { x: number; y: number } => {
      const rng = createRng(seed);
      const ball: BallState = { ...createBall({ x: 20, y: 40 }), phase: 'loose', kind: 'punt', z: 3, vel: { x: 0, y: 8 }, vz: 0 };
      for (let i = 0; i < 400; i++) integrateBall(ball, TICK_DT, clearWeather(), rng);
      return { ...ball.pos };
    };
    expect(roll(5)).toEqual(roll(5));
    expect(roll(5)).not.toEqual(roll(6));
  });

  it('a rolling ball decelerates under friction and reports settled once', () => {
    const ball: BallState = { ...createBall({ x: 10, y: 10 }), phase: 'loose', kind: 'fumble', vel: { x: 5, y: 0 } };
    let settled = 0;
    for (let i = 0; i < 120; i++) if (integrateBall(ball, TICK_DT, clearWeather()).settled) settled++;
    expect(settled).toBe(1);
    expect(ball.vel.x).toBe(0);
    expect(ball.pos.x).toBeGreaterThan(12);
    expect(ball.pos.x).toBeLessThan(13);
  });

  it('a pass that reaches the turf becomes loose and reports hitGround once', () => {
    const { ball } = thrown({ x: 26, y: 40 }, 'bullet');
    let hit = 0;
    for (let i = 0; i < 200; i++) if (integrateBall(ball, TICK_DT, clearWeather()).hitGround) hit++;
    expect(hit).toBeGreaterThanOrEqual(1);
    expect(ball.phase).toBe('loose');
    expect(ball.kind).toBe('pass');
  });

  it('leaves held, presnap and dead balls untouched', () => {
    for (const phase of ['held', 'presnap', 'dead'] as const) {
      const ball: BallState = { ...createBall({ x: 10, y: 10 }), phase, vel: { x: 5, y: 5 }, vz: 3 };
      const r = integrateBall(ball, TICK_DT, clearWeather(), createRng(1));
      expect(r).toEqual({ hitGround: false, bounced: false, settled: false });
      expect(ball.pos).toEqual({ x: 10, y: 10 });
    }
  });
});

describe('ball transitions', () => {
  const c = { id: 'off:C', pos: { x: 26, y: 30 } };
  const qb = { id: 'off:QB', pos: { x: 26, y: 29 } };
  const gun = { id: 'off:QB', pos: { x: 26, y: 25 } };

  it('snapBall: under centre is immediate, shotgun is a quick low toss that arrives at the QB', () => {
    const under = snapBall(createBall(c.pos), c, qb, 3);
    expect(under.phase).toBe('held');
    expect(under.carrierId).toBe('off:QB');
    expect(under.kind).toBe('snap');
    expect(under.pos).toEqual(qb.pos);
    const shot = snapBall(createBall(c.pos), c, gun, 3);
    expect(shot.phase).toBe('inAir');
    expect(shot.targetId).toBe('off:QB');
    expect(shot.landingTick).toBeGreaterThan(3);
    const landed = flyToLanding(shot, 1.4).pos;
    expect(dist(landed, gun.pos)).toBeLessThan(0.5);
  });

  it('handoffBall and holdBall put the ball in the carrier\'s hands', () => {
    const rb = { id: 'off:RB', pos: { x: 25, y: 28 } };
    const h = handoffBall(createBall(c.pos), qb, rb, 40);
    expect(h.phase).toBe('held');
    expect(h.kind).toBe('handoff');
    expect(h.carrierId).toBe('off:RB');
    expect(h.throwerId).toBe('off:QB');
    expect(h.pos).toEqual(rb.pos);
    expect(h.z).toBe(CARRY_HEIGHT);
    const held = holdBall({ ...createBall(c.pos), phase: 'inAir', kind: 'pass', vel: { x: 3, y: 3 } }, 'def:CB1', 50);
    expect(held.vel).toEqual({ x: 0, y: 0 });
    expect(held.lastTouchedId).toBe('def:CB1');
  });

  it('pitchBall leads a moving back and arrives in his hands', () => {
    const rb = { id: 'off:RB', pos: { x: 30, y: 28 }, vel: { x: 6, y: 0 } };
    const p = pitchBall(createBall(qb.pos), qb, rb, 10);
    expect(p.kind).toBe('pitch');
    expect(p.phase).toBe('inAir');
    const flightTicks = p.landingTick - p.launchTick;
    const t = flightTicks * TICK_DT;
    const expected = { x: rb.pos.x + rb.vel.x * t, y: rb.pos.y };
    const landed = flyToLanding(p, 1.2).pos;
    expect(dist(landed, expected)).toBeLessThan(0.6);
    expect(lateralBall(createBall(qb.pos), qb, rb, 10).kind).toBe('lateral');
  });

  it('fumbleBall pops the ball loose with a hop; tipBall deflects; deadBall freezes', () => {
    const rng = createRng(3);
    const carrier = { id: 'off:RB', pos: { x: 30, y: 50 }, vel: { x: 0, y: 8 } };
    const f = fumbleBall(createBall(carrier.pos), carrier, rng, 77);
    expect(f.phase).toBe('loose');
    expect(f.kind).toBe('fumble');
    expect(f.carrierId).toBeNull();
    expect(f.vz).toBeGreaterThan(0);
    expect(f.lastTouchedId).toBe('off:RB');
    const forced = fumbleBall(createBall(carrier.pos), carrier, rng, 77, { forcedDir: { x: 0, y: -1 }, popSpeed: 6 });
    expect(forced.vel.y).toBeLessThan(carrier.vel.y * 0.5);
    const { ball } = thrown({ x: 26, y: 50 }, 'bullet');
    const speedBefore = Math.hypot(ball.vel.x, ball.vel.y);
    tipBall(ball, 'def:LB', rng);
    expect(ball.isTipped).toBe(true);
    expect(ball.kind).toBe('tip');
    expect(Math.hypot(ball.vel.x, ball.vel.y)).toBeLessThan(speedBefore);
    const d = deadBall(ball);
    expect(d.phase).toBe('dead');
    expect(d.vel).toEqual({ x: 0, y: 0 });
  });
});
