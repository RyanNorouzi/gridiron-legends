import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import { loadPlaybookData } from '@/playbook/loader';
import type { OffensivePlay } from '@/playbook/types';
import { callOffensivePlay, isDeepShot, isRunPlay, isSidelinePlay, weighOffensivePlays, type OffensiveCallArgs, type OffensiveCallState } from '@/ai/playcalling-offense';
import { makeCoach, share } from './helpers';

const plays: OffensivePlay[] = Object.values(loadPlaybookData().offensePlays);
const pro = getDifficulty('pro');

const state = (o: Partial<OffensiveCallState> = {}): OffensiveCallState => ({
  down: 1, distance: 10, ballOn: 30, clock: { quarter: 1, secondsRemaining: 600, running: false, quarterLengthSec: 900 }, scoreDiff: 0, timeouts: 3, opponentTimeouts: 3, ...o,
});

const call = (args: Partial<OffensiveCallArgs>, seed: number): OffensivePlay =>
  callOffensivePlay({ plays, state: state(), coach: null, difficulty: pro, rng: createRng(seed), ...args });

const N = 250;

describe('callOffensivePlay', () => {
  it('3rd & 1 favours runs for a ground-and-pound coach; 3rd & 12 favours passes', () => {
    const gp = makeCoach({ offensiveScheme: 'groundAndPound' });
    const runShare = share(N, (i) => call({ coach: gp, state: state({ down: 3, distance: 1 }) }, i), isRunPlay);
    expect(runShare).toBeGreaterThan(0.6);
    const passShare = share(N, (i) => call({ state: state({ down: 3, distance: 12 }) }, i), (p) => !isRunPlay(p) && p.type !== 'rpo');
    expect(passShare).toBeGreaterThan(0.75);
    const air = makeCoach({ offensiveScheme: 'airRaid' });
    const airRuns = share(N, (i) => call({ coach: air, state: state({ down: 1, distance: 10 }) }, i), isRunPlay);
    const gpRuns = share(N, (i) => call({ coach: gp, state: state({ down: 1, distance: 10 }) }, i), isRunPlay);
    expect(gpRuns).toBeGreaterThan(airRuns + 0.2);
  });

  it('the red zone avoids deep shots and two-minute drills prefer the sideline', () => {
    const deepOpen = share(N, (i) => call({ state: state({ down: 1, distance: 10, ballOn: 40 }) }, i), isDeepShot);
    const deepRedZone = share(N, (i) => call({ state: state({ down: 1, distance: 10, ballOn: 85 }) }, i), isDeepShot);
    expect(deepRedZone).toBeLessThan(0.1);
    expect(deepRedZone).toBeLessThan(deepOpen);
    const base = share(N, (i) => call({ state: state({ down: 1, distance: 10 }) }, i), isSidelinePlay);
    const drill = share(N, (i) => call({ state: state({ down: 1, distance: 10, scoreDiff: -4, clock: { quarter: 4, secondsRemaining: 75, running: false, quarterLengthSec: 900 } }) }, i), isSidelinePlay);
    expect(drill).toBeGreaterThan(base + 0.15);
    const drillRuns = share(N, (i) => call({ state: state({ down: 1, distance: 10, scoreDiff: -4, clock: { quarter: 4, secondsRemaining: 75, running: false, quarterLengthSec: 900 } }) }, i), isRunPlay);
    expect(drillRuns).toBeLessThan(0.15);
  });

  it('avoids repeating the last two calls', () => {
    const recent = ['shotgun-mesh', 'shotgun-slants'];
    const repeats = share(N, (i) => call({ state: state({ down: 2, distance: 6 }), recentPlayIds: recent }, i), (p) => p.id === 'shotgun-mesh');
    expect(repeats).toBeLessThan(0.02);
  });

  it('special situations return the special plays', () => {
    expect(call({ state: state({ down: 4, distance: 9, ballOn: 30 }) }, 1).concept).toBe('punt');
    expect(call({ state: state({ down: 4, distance: 8, ballOn: 70 }) }, 1).concept).toBe('fieldGoal');
    expect(call({ state: state({ situation: 'kickoff' }) }, 1).concept).toBe('kickoff');
    const onside = call({ state: state({ situation: 'kickoff', scoreDiff: -10, clock: { quarter: 4, secondsRemaining: 90, running: false } }) }, 1);
    expect(onside.concept).toBe('onside');
    expect(call({ state: state({ situation: 'pat' }) }, 1).concept).toBe('extraPoint');
    const two = call({ state: state({ situation: 'pat', scoreDiff: -2, clock: { quarter: 4, secondsRemaining: 200, running: false } }) }, 1);
    expect(two.tags).toContain('twoPoint');
    // Four kneels with a huddle runoff before each (default 14 s) burn about a minute; with 100 s left they would hand
    // the ball back, so the offense keeps playing.
    const kneel = call({ state: state({ down: 1, distance: 10, scoreDiff: 3, clock: { quarter: 4, secondsRemaining: 55, running: true }, opponentTimeouts: 0 }) }, 1);
    expect(kneel.type).toBe('kneel');
    const tooEarly = call({ state: state({ down: 1, distance: 10, scoreDiff: 3, clock: { quarter: 4, secondsRemaining: 100, running: true }, opponentTimeouts: 0 }) }, 1);
    expect(tooEarly.type).not.toBe('kneel');
    const spike = call({ state: state({ down: 2, distance: 6, ballOn: 40, scoreDiff: -3, timeouts: 0, clock: { quarter: 4, secondsRemaining: 30, running: true } }) }, 1);
    expect(spike.type).toBe('spike');
    const fg = call({ state: state({ down: 2, distance: 6, ballOn: 75, scoreDiff: -3, timeouts: 0, clock: { quarter: 4, secondsRemaining: 5, running: true } }) }, 1);
    expect(fg.concept).toBe('fieldGoal');
  });

  it('low playcalling IQ flattens the choice toward random', () => {
    const rookie = getDifficulty('rookie');
    const legend = getDifficulty('legend');
    const top = (d: typeof rookie): number => {
      const w = weighOffensivePlays({ plays, state: state({ down: 3, distance: 1 }), coach: makeCoach({ offensiveScheme: 'groundAndPound' }), difficulty: d, rng: createRng(1) });
      const total = w.reduce((s, x) => s + x.weight, 0);
      return Math.max(...w.map((x) => x.weight)) / total;
    };
    expect(top(legend)).toBeGreaterThan(top(rookie));
  });

  it('throws on an empty play list', () => {
    expect(() => callOffensivePlay({ plays: [], state: state(), coach: null, difficulty: pro, rng: createRng(1) })).toThrow(/empty/);
  });
});
