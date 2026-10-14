import { describe, expect, it } from 'vitest';
import type { PlayOutcome } from '@/game/play-types';
import { buildCtx, createMeasureEnv, runLive, type MeasureEnv } from '../../integration/measure';

/**
 * League-wide kick-return rates on two generated leagues, with loose bands: real football has a kickoff return
 * touchdown on well under 1% of returns (and ~22-26 yd a return), a punt return touchdown on about 1% (7-11 yd a return).
 * Coverage that let returners through (dives from two yards, hit sticks in space, coverage men who never fought off a
 * return block, a starting tight end and tailback on the kickoff unit) put ~4% of kickoff returns in the end zone.
 */
interface Rates { koReturns: number; koYards: number; koTds: number; ptReturns: number; ptYards: number; ptTds: number }

const measure = (env: MeasureEnv, league: number, n: number): Rates => {
  const r: Rates = { koReturns: 0, koYards: 0, koTds: 0, ptReturns: 0, ptYards: 0, ptTds: 0 };
  for (let i = 0; i < n; i++) {
    const ko = buildCtx(env, { off: 'kickoff-deep', def: 'kickReturn-middle', special: 'kickoff', ballOn: 35, teamIndex: i % env.teams.length, seed: `ko-rates:${league}:${i}` });
    const o = runLive(env, ko).outcome as PlayOutcome;
    if (!o.events.some((e) => e.type === 'touchback' || e.type === 'fairCatch') && !o.turnover) {
      r.koReturns += 1;
      r.koYards += o.returnYards;
      if (o.touchdown) r.koTds += 1;
    }
    const pc = buildCtx(env, { off: 'punt-standard', def: 'puntReturn-middle', special: 'punt', ballOn: 25 + (i % 4) * 5, down: 4, teamIndex: (i * 7) % env.teams.length, seed: `pt-rates:${league}:${i}` });
    const po = runLive(env, pc).outcome as PlayOutcome;
    const returned = !po.turnover && !po.events.some((e) => e.type === 'touchback' || e.type === 'fairCatch' || e.type === 'downed')
      && po.events.some((e) => e.type === 'tackle' || e.type === 'outOfBounds' || e.type === 'touchdown');
    if (returned) {
      r.ptReturns += 1;
      r.ptYards += po.returnYards;
      if (po.touchdown) r.ptTds += 1;
    }
  }
  return r;
};

describe('kick return rates (two leagues)', () => {
  it('kickoff and punt return touchdowns are rare and return averages stay realistic', () => {
    const total: Rates = { koReturns: 0, koYards: 0, koTds: 0, ptReturns: 0, ptYards: 0, ptTds: 0 };
    for (const league of [2026, 7]) {
      const r = measure(createMeasureEnv(league), league, 240);
      console.log(`league ${league}: KO ${r.koReturns} ret avg ${(r.koYards / Math.max(1, r.koReturns)).toFixed(1)} TD ${r.koTds} | punt ${r.ptReturns} ret avg ${(r.ptYards / Math.max(1, r.ptReturns)).toFixed(1)} TD ${r.ptTds}`);
      for (const k of Object.keys(total) as (keyof Rates)[]) total[k] += r[k];
    }
    expect(total.koReturns).toBeGreaterThanOrEqual(150);
    expect(total.ptReturns).toBeGreaterThanOrEqual(120);
    const koAvg = total.koYards / total.koReturns;
    const ptAvg = total.ptYards / total.ptReturns;
    // Loose bands (a few hundred returns): the old coverage ran ~4% kickoff-return touchdowns.
    expect(total.koTds / total.koReturns).toBeLessThanOrEqual(0.025);
    expect(koAvg).toBeGreaterThanOrEqual(19);
    expect(koAvg).toBeLessThanOrEqual(28);
    expect(total.ptTds / total.ptReturns).toBeLessThanOrEqual(0.03);
    expect(ptAvg).toBeGreaterThanOrEqual(5);
    expect(ptAvg).toBeLessThanOrEqual(12);
  }, 300_000);
});
