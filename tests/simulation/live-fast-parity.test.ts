/**
 * The live engine and the fast sim must play on the same game clock: the same scrimmage calls, run through both
 * executors, charge similar seconds per down (overall and by result) and the same huddle tempo, so skipping a play,
 * watching a game or simming the rest of it never changes a game's pace. Turnover rates stay in the same range.
 */
import { describe, expect, it } from 'vitest';
import type { PlayOutcome } from '@/game/play-types';
import { simulatePlay } from '@/simulation/fast-sim';
import { buildCtx, createMeasureEnv, runLive, scrimmageCalls } from '../integration/measure';

const env = createMeasureEnv(2026);
const calls = scrimmageCalls(1);
const live: PlayOutcome[] = [];
const fast: PlayOutcome[] = [];
for (const c of calls) {
  const l = runLive(env, buildCtx(env, c)).outcome;
  if (l) live.push(l);
  fast.push(simulatePlay(buildCtx(env, c)));
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const kind = (o: PlayOutcome): string => (o.turnover ? 'turnover' : o.incomplete ? 'incomplete' : o.result);
const secs = (os: readonly PlayOutcome[], k?: string): number => mean(os.filter((o) => !k || kind(o) === k).map((o) => o.timeElapsed));
const within = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol * Math.max(a, b);

describe('live engine vs fast sim: one game clock', () => {
  it('runs every call through both executors', () => {
    expect(live.length).toBeGreaterThanOrEqual(300);
    expect(fast.length).toBe(calls.length);
  });

  it('charges seconds per down within 25% overall and for runs, completions and incompletions', () => {
    for (const k of [undefined, 'run', 'pass', 'incomplete']) {
      const l = secs(live, k);
      const f = secs(fast, k);
      expect(within(l, f, 0.25), `${k ?? 'all'}: live ${l.toFixed(2)} s vs fast ${f.toFixed(2)} s`).toBe(true);
    }
  });

  it('huddles at the same tempo between running-clock snaps', () => {
    const l = mean(live.map((o) => o.presnapElapsed));
    const f = mean(fast.map((o) => o.presnapElapsed));
    expect(within(l, f, 0.15), `live ${l.toFixed(1)} s vs fast ${f.toFixed(1)} s`).toBe(true);
  });

  it('turns the ball over at a similar rate', () => {
    const rate = (os: readonly PlayOutcome[]): number => os.filter((o) => o.turnover).length / Math.max(1, os.length);
    expect(Math.abs(rate(live) - rate(fast))).toBeLessThanOrEqual(0.03);
  });
});
