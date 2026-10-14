import { describe, expect, it } from 'vitest';
import {
  BURST_BONUS, LAUNCH_ACCEL, TOP_END_ACCEL, accelAt, accelRate, burstMultiplier, distanceAfter, drainBurst, fortyTime, locomotionFactor, maxSpeed, rechargeBurst, turnRate,
} from '@/physics/speed';

describe('speed model', () => {
  it('hits the top-speed anchors', () => {
    expect(maxSpeed(99)).toBeCloseTo(10.5, 6);
    expect(maxSpeed(50)).toBeCloseTo(7.8, 6);
    expect(maxSpeed(1)).toBeCloseTo(5.5, 6);
  });

  it('is strictly monotone across the rating scale and clamps outside it', () => {
    for (let r = 1; r < 99; r++) expect(maxSpeed(r + 1)).toBeGreaterThan(maxSpeed(r));
    for (let r = 1; r < 99; r++) expect(accelRate(r + 1)).toBeGreaterThan(accelRate(r));
    for (let r = 1; r < 99; r++) expect(turnRate(r + 1)).toBeGreaterThan(turnRate(r));
    expect(maxSpeed(150)).toBe(maxSpeed(99));
    expect(maxSpeed(-5)).toBe(maxSpeed(1));
  });

  it('produces combine-realistic 40 times', () => {
    const elite = fortyTime(99, 99);
    const average = fortyTime(60, 60);
    // Snappier launch (owner request: faster players): elite speed now runs a record-pace ~4.25 s.
    expect(elite).toBeGreaterThanOrEqual(4.2);
    expect(elite).toBeLessThanOrEqual(4.4);
    expect(average).toBeGreaterThanOrEqual(5.0);
    expect(average).toBeLessThanOrEqual(5.3);
    expect(fortyTime(1, 1)).toBeGreaterThan(average);
    // Faster acceleration alone shaves time.
    expect(fortyTime(80, 99)).toBeLessThan(fortyTime(80, 30));
  });

  it('launches explosively and tapers toward top speed', () => {
    expect(accelAt(70, 0, 9)).toBeCloseTo(accelRate(70) * LAUNCH_ACCEL, 6);
    expect(accelAt(70, 9, 9)).toBeCloseTo(accelRate(70) * TOP_END_ACCEL, 6);
    expect(accelAt(70, 4.5, 9)).toBeLessThan(accelAt(70, 1, 9));
    expect(accelAt(99, 3, 9)).toBeGreaterThan(accelAt(40, 3, 9));
    // 10 yards (a burst through the hole) comes quickly for the explosive.
    expect(distanceAfter(90, 99, 1.4)).toBeGreaterThan(distanceAfter(90, 40, 1.4));
    expect(distanceAfter(90, 99, 1.4)).toBeGreaterThan(9);
  });

  it('distanceAfter agrees with fortyTime', () => {
    const t = fortyTime(85, 70);
    expect(distanceAfter(85, 70, t)).toBeCloseTo(40, 6);
    expect(distanceAfter(85, 70, 0)).toBe(0);
    expect(distanceAfter(85, 70, 0.5)).toBeLessThan(distanceAfter(85, 70, 1));
  });

  it('applies locomotion and burst factors', () => {
    expect(locomotionFactor('run')).toBe(1);
    expect(locomotionFactor('strafe')).toBe(0.75);
    expect(locomotionFactor('backpedal')).toBe(0.55);
    expect(burstMultiplier(true, 0.5)).toBeCloseTo(1 + BURST_BONUS);
    expect(burstMultiplier(true, 0)).toBe(1);
    expect(burstMultiplier(false, 1)).toBe(1);
  });

  it('drains a full meter in 1.5 s and refills it in 4 s', () => {
    let b = 1;
    for (let i = 0; i < 90; i++) b = drainBurst(b, 1 / 60);
    expect(b).toBeCloseTo(0, 6);
    for (let i = 0; i < 240; i++) b = rechargeBurst(b, 1 / 60);
    expect(b).toBeCloseTo(1, 6);
    expect(drainBurst(0, 1)).toBe(0);
    expect(rechargeBurst(1, 1)).toBe(1);
  });
});
