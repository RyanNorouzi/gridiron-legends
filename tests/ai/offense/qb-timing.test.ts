/**
 * AI quarterback timing through the real PlayEngine, AI vs AI: behind a pocket that holds, dropback concepts come out
 * off the top of the drop (5-step ~2.4 s, 7-step ~3 s after the snap) instead of the instant a receiver breaks,
 * the quick game on the break (~1.5 s), and against a four-man rush he is rarely sacked (he gets the ball out).
 */
import { describe, expect, it } from 'vitest';
import { perceivedDefense, throwClock } from '@/ai/qb';
import { hotRead } from '@/ai/qb-reads';
import { createPlayEngine } from '@/game/play-engine';
import { buildCtx, createMeasureEnv, runLive } from '../../integration/measure';

const env = createMeasureEnv(2026);
const FOUR_MAN = ['43-cover3-zone', '43-cover2-zone', '43-cover4-zone', 'nickel-cover3-match', '43-cover1-man'];

interface Timing { throwTimes: number[]; sacks: number; dropbacks: number }

const measure = (offs: readonly string[], seeds: number, defs: readonly string[] = FOUR_MAN): Timing => {
  const out: Timing = { throwTimes: [], sacks: 0, dropbacks: 0 };
  offs.forEach((off, oi) => defs.forEach((def, di) => {
    for (let v = 0; v < seeds; v++) {
      const ctx = buildCtx(env, { off, def, teamIndex: (oi + di + v) % 8, seed: `ttt:${v}` });
      const o = runLive(env, ctx).outcome;
      if (!o || o.result === 'penalty') continue;
      out.dropbacks += 1;
      if (o.result === 'sack') out.sacks += 1;
      const snap = o.events.find((e) => e.type === 'snap');
      const thrown = o.events.find((e) => e.type === 'throw');
      if (snap && thrown) out.throwTimes.push((thrown.tick - snap.tick) / 60);
    }
  }));
  return out;
};

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('AI quarterback timing behind a real pocket', () => {
  it('drops deeper for longer concepts: the throw clock grows with the drop', () => {
    expect(throwClock(3)).toBeLessThan(throwClock(5));
    expect(throwClock(5)).toBeLessThan(throwClock(7));
  });

  it('throws dropback concepts off the top of the drop (~2.3-3.2 s) and is rarely sacked by four rushers', () => {
    const t = measure(['shotgun-mesh', 'shotgun-curls', 'shotgun-dragDig', 'singleback-curlFlat', 'shotgun-deepCross', 'shotgun-fourVerts'], 2);
    const avg = mean(t.throwTimes);
    expect(avg).toBeGreaterThanOrEqual(2.2);
    expect(avg).toBeLessThanOrEqual(3.3);
    expect(t.sacks / t.dropbacks).toBeLessThan(0.08);
  });

  it('gets the quick game out on the break, well before the dropback concepts', () => {
    const t = measure(['shotgun-slants', 'singleback-slantFlat', 'shotgun-quickOuts'], 2);
    const avg = mean(t.throwTimes);
    // A real 3-step / gun quick throw takes ~1.4-1.8 s from the snap (catch the snap, set, let it go on the break).
    expect(avg).toBeGreaterThanOrEqual(1.3);
    expect(avg).toBeLessThanOrEqual(1.9);
  });

  it('reads an overload blitz (more rushers than protectors) and gets the ball out hot instead of eating the sack', () => {
    const qbOf = (def: string): boolean => {
      const ctx = buildCtx(env, { off: 'shotgun-mesh', def, seed: 'hotread' });
      const play = createPlayEngine(ctx, { registries: env.registries });
      const qb = play.state.athletes.find((a) => a.assignment.type === 'qb')!;
      return hotRead(perceivedDefense(qb, play.state), play.state);
    };
    expect(qbOf('43-cover0-lbBlitz')).toBe(true);
    expect(qbOf('43-cover3-zone')).toBe(false);
    expect(qbOf('43-cover3-edgeBlitz')).toBe(false);
    const drops = ['shotgun-mesh', 'shotgun-curls', 'shotgun-dragDig', 'singleback-curlFlat', 'shotgun-deepCross', 'trips-smash'];
    const zone = measure(drops, 3, ['43-cover3-zone']);
    const blitz = measure(drops, 3, ['43-cover0-lbBlitz']);
    // Without the hot read he held the ball as long as against the zone (~2.8 s) and was sacked ~35% of the time.
    expect(mean(blitz.throwTimes)).toBeLessThan(mean(zone.throwTimes) - 0.3);
    expect(blitz.sacks / blitz.dropbacks).toBeLessThan(0.25);
  });
});
