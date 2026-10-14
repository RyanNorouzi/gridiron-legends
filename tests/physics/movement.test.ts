import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { len } from '@/core/vec2';
import { idleIntent, moveIntent, type AthleteIntent } from '@/game/engine-api';
import { OUT_OF_BOUNDS_MARGIN, haltAthlete, integrateMovement, stateProfile, tractionFromWeather, turnToward } from '@/physics/movement';
import { fortyTime, maxSpeed, turnRate } from '@/physics/speed';
import { clearWeather, makeAthlete } from './helpers';

const run = (athlete: ReturnType<typeof makeAthlete>, intent: AthleteIntent, seconds: number, weather = clearWeather()): void => {
  const n = Math.round(seconds / TICK_DT);
  for (let i = 0; i < n; i++) integrateMovement(athlete, intent, TICK_DT, weather);
};

describe('integrateMovement', () => {
  it('runs a 40-yard dash in the fortyTime window without sprint', () => {
    const a = makeAthlete({ attrs: { speed: 99, acceleration: 99 }, pos: { x: 26, y: 10 } });
    const intent = moveIntent({ x: 0, y: 1 });
    let ticks = 0;
    while (a.pos.y < 50 && ticks < 1000) { integrateMovement(a, intent, TICK_DT, clearWeather()); ticks++; }
    const t = ticks * TICK_DT;
    // Snappier launch (owner request: faster players): the elite 40 sits at the real-world record pace (~4.25 s).
    expect(t).toBeGreaterThanOrEqual(4.2);
    expect(t).toBeLessThanOrEqual(4.4);
    expect(Math.abs(t - fortyTime(99, 99))).toBeLessThan(0.05);
    expect(len(a.vel)).toBeCloseTo(maxSpeed(99), 3);
    expect(a.state).toBe('moving');
  });

  it('launches explosively: the first steps reach 5 yd/s quickly, a slow starter lags, top speed is unchanged', () => {
    const time0to5 = (accel: number): number => {
      const a = makeAthlete({ attrs: { speed: 90, acceleration: accel }, pos: { x: 26, y: 10 } });
      let ticks = 0;
      while (len(a.vel) < 5 && ticks < 600) { integrateMovement(a, moveIntent({ x: 0, y: 1 }), TICK_DT, clearWeather()); ticks++; }
      return ticks * TICK_DT;
    };
    // The old constant-acceleration model took 0.50 s (rating 99) and 0.61 s (rating 40).
    expect(time0to5(99)).toBeLessThan(0.45);
    expect(time0to5(40)).toBeGreaterThan(time0to5(99));
    expect(time0to5(40)).toBeLessThan(0.56);
    const a = makeAthlete({ attrs: { speed: 90, acceleration: 70 }, pos: { x: 26, y: 10 } });
    run(a, moveIntent({ x: 0, y: 1 }), 3);
    expect(len(a.vel)).toBeCloseTo(maxSpeed(90), 3);
  });

  it('sprint burst is faster over 1.5 s and drains the meter, which then refills at rest', () => {
    const calm = makeAthlete({ attrs: { speed: 80 }, pos: { x: 26, y: 10 } });
    const sprinter = makeAthlete({ attrs: { speed: 80 }, pos: { x: 26, y: 10 } });
    run(calm, moveIntent({ x: 0, y: 1 }), 1.5);
    run(sprinter, moveIntent({ x: 0, y: 1 }, true), 1.5);
    expect(sprinter.pos.y).toBeGreaterThan(calm.pos.y);
    expect(len(sprinter.vel)).toBeGreaterThan(len(calm.vel));
    expect(sprinter.burst).toBeCloseTo(0, 5);
    // Empty meter: sprint no longer helps; resting refills.
    run(sprinter, idleIntent(), 4);
    expect(sprinter.burst).toBeCloseTo(1, 5);
    expect(len(sprinter.vel)).toBe(0);
    expect(sprinter.state).toBe('idle');
  });

  it('never reverses instantly: a 180 takes real time and the facing turns at the agility rate', () => {
    const a = makeAthlete({ attrs: { agility: 99 }, facing: 0, vel: { x: maxSpeed(70), y: 0 }, state: 'moving' });
    const before = a.vel.x;
    integrateMovement(a, moveIntent({ x: -1, y: 0 }), TICK_DT, clearWeather());
    expect(a.vel.x).toBeGreaterThan(before * 0.9);
    // Facing moved by at most turnRate * dt (times the standing-pivot boost, which is 1 at full speed).
    expect(Math.abs(a.facing)).toBeLessThanOrEqual(turnRate(99) * TICK_DT + 1e-9);
    expect(Math.abs(a.facing)).toBeGreaterThan(0);
    let ticks = 1;
    while (a.vel.x > 0 && ticks < 600) { integrateMovement(a, moveIntent({ x: -1, y: 0 }), TICK_DT, clearWeather()); ticks++; }
    expect(ticks * TICK_DT).toBeGreaterThan(0.25);
    expect(ticks * TICK_DT).toBeLessThan(1.5);
    run(a, moveIntent({ x: -1, y: 0 }), 2);
    expect(a.vel.x).toBeLessThan(-maxSpeed(70) * 0.95);
    expect(Math.abs(Math.abs(a.facing) - Math.PI)).toBeLessThan(1e-6);
  });

  it('a 90-degree cut scrubs speed before rebuilding it', () => {
    const a = makeAthlete({ facing: Math.PI / 2, vel: { x: 0, y: maxSpeed(70) }, state: 'moving' });
    let minSpeed = Infinity;
    for (let i = 0; i < 90; i++) {
      integrateMovement(a, moveIntent({ x: 1, y: 0 }), TICK_DT, clearWeather());
      minSpeed = Math.min(minSpeed, len(a.vel));
    }
    expect(minSpeed).toBeLessThan(maxSpeed(70) * 0.9);
    expect(a.vel.x).toBeGreaterThan(a.vel.y);
  });

  it('backpedal is slower than strafe which is slower than running, and both keep the requested facing', () => {
    const mk = (): ReturnType<typeof makeAthlete> => makeAthlete({ pos: { x: 26, y: 40 }, facing: Math.PI / 2 });
    const runner = mk();
    const strafer = mk();
    const backpedaler = mk();
    run(runner, moveIntent({ x: 0, y: -1 }), 2);
    run(strafer, { ...moveIntent({ x: 0, y: -1 }), locomotion: 'strafe', face: Math.PI / 2 }, 2);
    run(backpedaler, { ...moveIntent({ x: 0, y: -1 }), locomotion: 'backpedal', face: Math.PI / 2 }, 2);
    const d = (a: ReturnType<typeof makeAthlete>): number => 40 - a.pos.y;
    expect(d(backpedaler)).toBeLessThan(d(strafer));
    expect(d(strafer)).toBeLessThan(d(runner));
    expect(len(backpedaler.vel)).toBeCloseTo(maxSpeed(70) * 0.55, 3);
    expect(len(strafer.vel)).toBeCloseTo(maxSpeed(70) * 0.75, 3);
    expect(backpedaler.facing).toBeCloseTo(Math.PI / 2, 6);
    expect(strafer.facing).toBeCloseTo(Math.PI / 2, 6);
    expect(runner.facing).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('effort scales the desired speed', () => {
    const a = makeAthlete();
    run(a, moveIntent({ x: 0, y: 0.5 }), 3);
    expect(len(a.vel)).toBeCloseTo(maxSpeed(70) * 0.5, 3);
  });

  it('does not move while tackled, down, throwing, kicking or engaged (unless shedding)', () => {
    for (const state of ['tackled', 'down', 'throwing', 'kicking', 'engaged'] as const) {
      const a = makeAthlete({ state, pos: { x: 20, y: 20 } });
      run(a, moveIntent({ x: 1, y: 0 }, true), 1);
      expect(a.pos).toEqual({ x: 20, y: 20 });
      expect(len(a.vel)).toBe(0);
      expect(a.state).toBe(state);
    }
    const shedder = makeAthlete({ state: 'engaged', pos: { x: 20, y: 20 } });
    run(shedder, { ...moveIntent({ x: 1, y: 0 }), action: 'shed' }, 1);
    expect(shedder.pos.x).toBeGreaterThan(20);
    expect(len(shedder.vel)).toBeLessThan(maxSpeed(70) * 0.5);
    expect(stateProfile('engaged', idleIntent()).frozen).toBe(true);
    expect(stateProfile('engaged', { ...idleIntent(), action: 'shed' }).frozen).toBe(false);
  });

  it('a diving athlete coasts to a stop under ground friction and cannot steer', () => {
    const a = makeAthlete({ state: 'diving', vel: { x: 6, y: 0 }, pos: { x: 20, y: 20 } });
    run(a, moveIntent({ x: 0, y: 1 }), 1);
    expect(a.vel.y).toBe(0);
    expect(a.vel.x).toBe(0);
    expect(a.pos.x).toBeGreaterThan(20);
    expect(a.pos.y).toBe(20);
  });

  it('a slick field cuts acceleration and turning', () => {
    const dry = makeAthlete({ pos: { x: 26, y: 10 } });
    const wet = makeAthlete({ pos: { x: 26, y: 10 } });
    run(dry, moveIntent({ x: 0, y: 1 }), 0.5);
    run(wet, moveIntent({ x: 0, y: 1 }), 0.5, clearWeather({ fieldSlick: 1 }));
    expect(len(wet.vel)).toBeLessThan(len(dry.vel));
    expect(tractionFromWeather(clearWeather({ fieldSlick: 1 }))).toBeLessThan(tractionFromWeather(clearWeather()));
    const dryTurn = makeAthlete({ facing: 0 });
    const wetTurn = makeAthlete({ facing: 0 });
    integrateMovement(dryTurn, moveIntent({ x: 0, y: 1 }), TICK_DT, clearWeather());
    integrateMovement(wetTurn, moveIntent({ x: 0, y: 1 }), TICK_DT, clearWeather({ fieldSlick: 1 }));
    expect(wetTurn.facing).toBeLessThan(dryTurn.facing);
  });

  it('keeps athletes within the out-of-bounds margin', () => {
    const a = makeAthlete({ pos: { x: 1, y: 60 }, facing: Math.PI });
    run(a, moveIntent({ x: -1, y: 0 }, true), 3);
    expect(a.pos.x).toBe(-OUT_OF_BOUNDS_MARGIN);
    expect(a.vel.x).toBe(0);
    const b = makeAthlete({ pos: { x: 26, y: 118 } });
    run(b, moveIntent({ x: 0, y: 1 }), 3);
    expect(b.pos.y).toBe(120 + OUT_OF_BOUNDS_MARGIN);
  });

  it('honours the speedScale and traction overrides', () => {
    const slow = makeAthlete({ pos: { x: 26, y: 10 } });
    const fast = makeAthlete({ pos: { x: 26, y: 10 } });
    run(slow, moveIntent({ x: 0, y: 1 }), 3);
    for (let i = 0; i < 180; i++) integrateMovement(fast, moveIntent({ x: 0, y: 1 }), TICK_DT, clearWeather(), { speedScale: 1.5 });
    expect(len(fast.vel)).toBeCloseTo(len(slow.vel) * 1.5, 3);
  });

  it('turnToward never overshoots and takes the short way round', () => {
    expect(turnToward(0, 0.5, 0.2)).toBeCloseTo(0.2);
    expect(turnToward(0, 0.1, 0.2)).toBeCloseTo(0.1);
    expect(turnToward(0, -3, 0.2)).toBeCloseTo(-0.2);
    expect(turnToward(3, -3, 0.2)).toBeCloseTo(3.2);
  });

  it('haltAthlete zeroes velocity and settles the state', () => {
    const a = makeAthlete({ state: 'moving', vel: { x: 4, y: 4 } });
    haltAthlete(a);
    expect(a.vel).toEqual({ x: 0, y: 0 });
    expect(a.state).toBe('idle');
  });
});
