import { describe, expect, it } from 'vitest';
import {
  ballHawkShift, ballReachBonus, breakAngleError, coverageEdge, deepCushionLoss, disguiseHoldScale, disguiseReadShift, dropDepthScale, helpRotation,
  landmarkDrift, manCushionShift, manUndercutLead, sinkReach, squatOffset, throwReadSeconds,
} from '@/ai/coverage-iq';
import { disguisePlan, peekDisguise, rotationReadDelay, ROTATION_READ_DELAY } from '@/ai/disguise';
import { registerAll } from '@/ai/register';
import type { PlayerId } from '@/core/ids';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId } from '@/game/types';
import { buildPlayState } from '../../fixtures/play-state';

registerAll();
const edge = (id: DifficultyId): number => coverageEdge(getDifficulty(id));
const who = { playerId: 'p_cov' as PlayerId };

describe('coverage decision levers by difficulty', () => {
  it('the edge is -1 at rookie, exactly 0 at pro and rises to +1 at legend', () => {
    expect(edge('rookie')).toBe(-1);
    expect(edge('pro')).toBe(0);
    expect(edge('allPro')).toBeGreaterThan(0);
    expect(edge('legend')).toBeCloseTo(1, 5);
  });

  it('every lever is the baseline behaviour at pro (the balance tables are measured there)', () => {
    expect(throwReadSeconds(who, 0.3, 0)).toBeCloseTo(0.24, 10);
    expect(breakAngleError(who, 0) === 0).toBe(true);
    expect(ballHawkShift(0) === 0).toBe(true);
    expect(dropDepthScale(0)).toBe(1);
    expect(landmarkDrift(who, 0) === 0).toBe(true);
    expect(sinkReach(0) === 0).toBe(true);
    expect(squatOffset(0)).toBe(1.5);
    expect(manCushionShift(0) === 0).toBe(true);
    expect(manUndercutLead(0) === 0).toBe(true);
    expect(helpRotation(0) === 0).toBe(true);
    expect(deepCushionLoss(0) === 0).toBe(true);
    expect(disguiseHoldScale(0)).toBe(1);
    expect(disguiseReadShift(0) === 0).toBe(true);
    expect(ballReachBonus(0) === 0).toBe(true);
  });

  it('rookie coverage decides worse and legend better on every lever', () => {
    const [r, l] = [edge('rookie'), edge('legend')];
    expect(throwReadSeconds(who, 0.3, r)).toBeGreaterThan(throwReadSeconds(who, 0.3, 0));
    expect(throwReadSeconds(who, 0.3, l)).toBeLessThan(throwReadSeconds(who, 0.3, 0));
    expect(breakAngleError(who, r)).toBeGreaterThan(0.2);
    expect(ballHawkShift(l)).toBeGreaterThan(ballHawkShift(r));
    expect(squatOffset(r)).toBeGreaterThan(squatOffset(l));
    expect(manCushionShift(r)).toBeGreaterThan(0);
    expect(manUndercutLead(l)).toBeGreaterThan(manUndercutLead(r));
    expect(helpRotation(l)).toBeGreaterThan(0);
    expect(helpRotation(r)).toBe(0);
    expect(deepCushionLoss(r)).toBeGreaterThan(0);
    expect(disguiseHoldScale(l)).toBeGreaterThan(disguiseHoldScale(r));
    expect(disguiseReadShift(l)).toBeLessThan(0);
  });

  it('a legend defense\'s disguise stays hidden longer than a pro one (the plan carries the quality)', () => {
    let seen = 0;
    for (let seed = 1; seed <= 40 && seen < 3; seed++) {
      const at = (id: DifficultyId) => {
        const s = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover2-zone', seed, difficulty: 'legend' }).state;
        s.ctx = { ...s.ctx, difficulty: { ...getDifficulty(id), playcallingIq: getDifficulty('legend').playcallingIq } };
        return { plan: disguisePlan(s), state: s };
      };
      const legend = at('legend');
      if (!legend.plan.disguised) continue;
      seen++;
      const pro = at('pro');
      expect(peekDisguise(legend.state)).toBe(legend.plan);
      expect(rotationReadDelay(pro.state)).toBeCloseTo(ROTATION_READ_DELAY, 10);
      expect(rotationReadDelay(legend.state)).toBeGreaterThan(ROTATION_READ_DELAY);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
