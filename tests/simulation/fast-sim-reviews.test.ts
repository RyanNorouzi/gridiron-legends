import { describe, expect, it } from 'vitest';
import { assertValidOutcome } from '@/game/outcome-factory';
import { simulatePlay } from '@/simulation/fast-sim';
import { DEF_PLAYS, makeCtx, PASS_PLAYS, RUN_PLAYS, variantOf } from './helpers';

describe('fast-sim close-call reviews', () => {
  it('produces first-down spot reviews whose alternate flips the first down', () => {
    let found = 0;
    const plays = [...RUN_PLAYS, ...PASS_PLAYS];
    plays.forEach((p, pi) => DEF_PLAYS.slice(0, 6).forEach((d, di) => {
      const base = makeCtx({ offensePlayId: p, defensePlayId: d, seed: pi * 17 + di });
      for (let v = 0; v < 8; v++) {
        const o = simulatePlay(variantOf(base, v, { down: 3, distance: 3.5, ballOn: 40 }));
        if (o.review?.call.kind !== 'firstDown') continue;
        found++;
        const alt = o.review.ifOverturned;
        assertValidOutcome(alt);
        expect(alt.firstDown).toBe(!o.firstDown);
        expect(o.review.call.confidence).toBeGreaterThanOrEqual(0.55);
        expect(Math.abs(alt.yards - o.yards)).toBe(1);
      }
    }));
    expect(found).toBeGreaterThan(3);
  });

  it('a safety can be reviewed as a spot of the ball; overturned, the carrier is down outside the end zone', () => {
    let found = 0;
    RUN_PLAYS.forEach((p, pi) => DEF_PLAYS.forEach((d, di) => {
      const base = makeCtx({ offensePlayId: p, defensePlayId: d, seed: pi * 13 + di });
      for (let v = 0; v < 12; v++) {
        const o = simulatePlay(variantOf(base, v, { down: 1, distance: 10, ballOn: 1.5 }));
        if (o.review?.call.kind !== 'spot') continue;
        found++;
        expect(o.safety).toBe(true);
        const alt = o.review.ifOverturned;
        assertValidOutcome(alt);
        expect(alt.safety).toBe(false);
        expect(alt.endBallOn).toBeGreaterThan(0);
      }
    }));
    expect(found).toBeGreaterThan(0);
  });
});
