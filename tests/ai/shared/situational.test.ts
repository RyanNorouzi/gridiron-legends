import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import { loadPlaybookData } from '@/playbook/loader';
import type { OffensivePlay } from '@/playbook/types';
import { fourthDownRegret, fourthDownValues, puntLandingBallOn, shouldHurryUp } from '@/ai/coaching';
import { callOffensivePlay, packageMultiplier, type OffensiveCallState } from '@/ai/playcalling-offense';
import { formationPersonnel } from '@/ai/scouting';
import { ratingToFactor } from '@/core/math';
import { isHurryUp, progressionInterval, rollCadence } from '@/ai/qb';
import { buildPlayState } from '../../fixtures/play-state';
import { share } from './helpers';

const OFF: OffensivePlay[] = Object.values(loadPlaybookData().offensePlays);

describe('no-huddle', () => {
  it('runs the two-minute drill at the end of either half, never to protect a fourth-quarter lead', () => {
    expect(shouldHurryUp({ quarter: 2, secondsRemaining: 100, scoreDiff: 7 })).toBe(true);
    expect(shouldHurryUp({ quarter: 2, secondsRemaining: 400, scoreDiff: -7 })).toBe(false);
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 100, scoreDiff: -3 })).toBe(true);
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 100, scoreDiff: 0 })).toBe(true);
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 100, scoreDiff: 4 })).toBe(false);
    expect(shouldHurryUp({ quarter: 1, secondsRemaining: 60, scoreDiff: -14 })).toBe(false);
    // Two scores down: hurry from five minutes out; one score down, not yet.
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 280, scoreDiff: -10 })).toBe(true);
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 280, scoreDiff: -4 })).toBe(false);
    // A clock-managing coach starts the drill earlier.
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 140, scoreDiff: -3 }, 0)).toBe(false);
    expect(shouldHurryUp({ quarter: 4, secondsRemaining: 140, scoreDiff: -3 }, 1)).toBe(true);
  });
});

describe('fourth-down model', () => {
  it('punts net about 41 yards, pooching (and losing some to touchbacks) from a short field', () => {
    expect(puntLandingBallOn(30)).toBe(71);
    expect(puntLandingBallOn(45)).toBe(86);
    expect(puntLandingBallOn(60)).toBeLessThan(puntLandingBallOn(50));
    expect(puntLandingBallOn(75)).toBeGreaterThanOrEqual(80);
  });

  it('values each option in expected points: punt deep, field goal in range, go on short yardage past midfield', () => {
    const best = (distance: number, ballOn: number): string => {
      const v = fourthDownValues({ distance, ballOn, scoreDiff: 0, quarter: 2, secondsRemaining: 600 });
      return (Object.keys(v) as (keyof typeof v)[]).reduce((a, b) => (v[b] > v[a] ? b : a));
    };
    expect(best(8, 25)).toBe('punt');
    expect(best(8, 72)).toBe('fieldGoal');
    expect(best(1, 55)).toBe('go');
    const sit = { distance: 8, ballOn: 25, scoreDiff: 0, quarter: 2, secondsRemaining: 600 };
    expect(fourthDownRegret(sit, 'punt')).toBe(0);
    expect(fourthDownRegret(sit, 'go')).toBeGreaterThan(0.5);
  });
});

describe('packages', () => {
  const heavy = (p: OffensivePlay): boolean => ['13', '22', '23', '21'].includes(formationPersonnel(p.formation) ?? '');
  const at = (o: Partial<OffensiveCallState>): OffensiveCallState => ({ down: 1, distance: 10, ballOn: 40, clock: { quarter: 2, secondsRemaining: 700 }, scoreDiff: 0, timeouts: 3, ...o });
  it('goal line and short yardage bring heavy personnel', () => {
    const goal = share(300, (i) => callOffensivePlay({ plays: OFF, state: at({ down: 1, distance: 2, ballOn: 98 }), coach: null, difficulty: getDifficulty('pro'), rng: createRng(i) }), heavy);
    const open = share(300, (i) => callOffensivePlay({ plays: OFF, state: at({}), coach: null, difficulty: getDifficulty('pro'), rng: createRng(i) }), heavy);
    expect(goal).toBeGreaterThan(open + 0.15);
    const spread = OFF.find((p) => formationPersonnel(p.formation) === '00') as OffensivePlay;
    expect(packageMultiplier(spread, { distance: 1, ballOn: 98 })).toBeLessThan(1);
    expect(packageMultiplier(spread, { distance: 10, ballOn: 40 })).toBe(1);
  });
});

describe('quarterback tempo and processing', () => {
  it('a no-huddle call speeds up the cadence', () => {
    const fx = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3 });
    const qb = fx.byRole('offense', 'QB');
    expect(isHurryUp(fx.state)).toBe(false);
    fx.state.ctx = { ...fx.state.ctx, hurryUp: true };
    expect(isHurryUp(fx.state)).toBe(true);
    for (let i = 0; i < 20; i++) expect(rollCadence(qb, fx.state)).toBeLessThanOrEqual(0.7);
  });

  it('progression speed comes from awareness and the difficulty, anchored at pro', () => {
    const q = (id: 'rookie' | 'pro' | 'allPro' | 'legend'): number => getDifficulty(id).qbDecisionQuality;
    expect(progressionInterval(70, q('pro'))).toBeCloseTo(0.35 * (1.3 - 0.6 * ratingToFactor(70)), 6);
    expect(progressionInterval(70, q('legend'))).toBeLessThan(progressionInterval(70, q('allPro')));
    expect(progressionInterval(70, q('allPro'))).toBeLessThan(progressionInterval(70, q('pro')));
    expect(progressionInterval(70, q('pro'))).toBeLessThan(progressionInterval(70, q('rookie')));
    expect(progressionInterval(95, q('pro'))).toBeLessThan(progressionInterval(50, q('pro')));
  });
});
