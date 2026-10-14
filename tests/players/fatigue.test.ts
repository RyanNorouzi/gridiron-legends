import { describe, expect, it } from 'vitest';
import {
  FATIGUE_TUNING, applyFatigue, fatigueAttrMultiplier, fatigueCostFactor, fatigueFromPlay, halftimeRecovery, recoverOnBench,
  recoverOnField, recoveryRateFactor, weeklyRecovery,
} from '@/players/fatigue';
import { emptyAttrs } from '@/players/attributes';

const attrs = (stamina: number) => ({ ...emptyAttrs(50), stamina });
const typicalPlay = { distanceYards: 30, sprintSeconds: 3, contacts: 1 };

describe('fatigueFromPlay', () => {
  it('is positive for effort, zero for none, and ignores negative effort', () => {
    expect(fatigueFromPlay(attrs(70), typicalPlay)).toBeGreaterThan(0);
    expect(fatigueFromPlay(attrs(70), { distanceYards: 0, sprintSeconds: 0, contacts: 0 })).toBe(0);
    expect(fatigueFromPlay(attrs(70), { distanceYards: -50, sprintSeconds: -3, contacts: -2 })).toBe(0);
  });
  it('scales with each effort component', () => {
    const base = fatigueFromPlay(attrs(70), typicalPlay);
    expect(fatigueFromPlay(attrs(70), { ...typicalPlay, distanceYards: 60 })).toBeGreaterThan(base);
    expect(fatigueFromPlay(attrs(70), { ...typicalPlay, sprintSeconds: 6 })).toBeGreaterThan(base);
    expect(fatigueFromPlay(attrs(70), { ...typicalPlay, contacts: 4 })).toBeGreaterThan(base);
  });
  it('high-stamina players tire less; a full drive stays within 0..1', () => {
    expect(fatigueFromPlay(attrs(99), typicalPlay)).toBeLessThan(fatigueFromPlay(attrs(30), typicalPlay) * 0.6);
    expect(fatigueCostFactor(1)).toBeCloseTo(FATIGUE_TUNING.costAtLowStamina, 6);
    expect(fatigueCostFactor(99)).toBeCloseTo(FATIGUE_TUNING.costAtHighStamina, 6);
    let f = 0;
    for (let i = 0; i < 12; i++) f = applyFatigue(f, fatigueFromPlay(attrs(50), typicalPlay));
    expect(f).toBeGreaterThan(0.2);
    expect(f).toBeLessThan(1);
    expect(applyFatigue(0.95, 0.5)).toBe(1);
    expect(applyFatigue(0.1, -0.5)).toBe(0);
  });
});

describe('recovery', () => {
  it('bench recovery is monotonic, clamps at 0 and is faster for high stamina', () => {
    expect(recoverOnBench(0.6, 30, 70)).toBeLessThan(0.6);
    expect(recoverOnBench(0.6, 60, 70)).toBeLessThan(recoverOnBench(0.6, 30, 70));
    expect(recoverOnBench(0.1, 600, 70)).toBe(0);
    expect(recoverOnBench(0.6, 30, 99)).toBeLessThan(recoverOnBench(0.6, 30, 1));
    expect(recoverOnBench(0.6, -30, 70)).toBe(0.6);
    expect(recoveryRateFactor(99)).toBeGreaterThan(recoveryRateFactor(1));
  });
  it('standing on the field recovers slower than sitting on the bench', () => {
    const bench = recoverOnBench(0.8, 35, 70);
    const field = recoverOnField(0.8, 35, 70);
    expect(field).toBeGreaterThan(bench);
    expect(field).toBeLessThan(0.8);
    expect(0.8 - field).toBeCloseTo((0.8 - bench) * FATIGUE_TUNING.fieldRecoveryFraction, 6);
  });
  it('halftime sheds most fatigue, more for fit players', () => {
    const low = halftimeRecovery(1, 1);
    const high = halftimeRecovery(1, 99);
    expect(low).toBeCloseTo(FATIGUE_TUNING.halftimeRetainLow, 6);
    expect(high).toBeCloseTo(FATIGUE_TUNING.halftimeRetainHigh, 6);
    expect(high).toBeLessThan(low);
    expect(halftimeRecovery(0, 50)).toBe(0);
    expect(halftimeRecovery(0.5, 50)).toBeLessThan(0.5);
  });
  it('a full week resets fatigue; short weeks leave low-stamina players tired', () => {
    expect(weeklyRecovery(1, 1)).toBe(0);
    expect(weeklyRecovery(1, 99)).toBe(0);
    expect(weeklyRecovery(1, 1, 4)).toBeGreaterThan(0.3);
    expect(weeklyRecovery(1, 99, 4)).toBeLessThan(0.05);
    expect(weeklyRecovery(1, 99, 4)).toBeLessThan(weeklyRecovery(1, 1, 4));
    expect(weeklyRecovery(0.5, 50, 0)).toBe(0.5);
  });
});

describe('fatigueAttrMultiplier', () => {
  it('is 1 when fresh, bottoms out at the tuned loss, and decreases monotonically', () => {
    expect(fatigueAttrMultiplier(0)).toBe(1);
    expect(fatigueAttrMultiplier(1)).toBeCloseTo(1 - FATIGUE_TUNING.maxPerformanceLoss, 6);
    expect(fatigueAttrMultiplier(2)).toBeCloseTo(1 - FATIGUE_TUNING.maxPerformanceLoss, 6);
    let prev = 1;
    for (let f = 0.1; f <= 1; f += 0.1) {
      const m = fatigueAttrMultiplier(f);
      expect(m).toBeLessThan(prev);
      prev = m;
    }
    expect(fatigueAttrMultiplier(0.5)).toBeGreaterThan(0.9);
  });
});
