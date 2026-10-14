/**
 * The stat sheet counts whole yards even when the ball is spotted on a fraction (half-distance penalties, live-engine
 * spots): a touchdown from the 98.5 is a 2-yard play, never 1.5.
 */
import { describe, expect, it } from 'vitest';
import { simulatePlay } from '@/simulation/fast-sim';
import { buildPlayState } from '../fixtures/play-state';
import { makeCtx, variantOf } from './helpers';

/** Stats that are legitimately fractional. */
const FRACTIONAL = new Set(['epa', 'receiving.separationTotal', 'defense.sacks']);

describe('fast sim credits whole yards from fractional spots', () => {
  const plays = [
    ['shotgun-slants', '43-cover3-zone'], ['iform-dive-right', '43-cover3-zone'], ['shotgun-fourVerts', 'nickel-cover2-zone'],
    ['singleback-draw', '43-cover1-man'], ['goalLine-qbSneak', 'goalLine-runStop'],
  ] as const;
  for (const ballOn of [98.5, 97.5, 1.5, 50.5]) {
    it(`from the ${ballOn}`, () => {
      const bad: string[] = [];
      for (const [off, def] of plays) {
        for (let seed = 1; seed <= 40; seed++) {
          let ctx;
          try {
            ctx = buildPlayState({ offensePlayId: off, defensePlayId: def, ballOn, seed, ruleset: 'simulation' }).state.ctx;
          } catch {
            continue; // a play id not in this data set
          }
          const o = simulatePlay(ctx);
          if (!Number.isInteger(o.yards)) bad.push(`${off} seed ${seed}: yards ${o.yards}`);
          for (const d of o.stats) if (!FRACTIONAL.has(d.stat) && !Number.isInteger(d.value)) bad.push(`${off} seed ${seed}: ${d.stat} ${d.value}`);
        }
      }
      expect(bad.slice(0, 8)).toEqual([]);
    });
  }
});

describe('special teams credit whole yards from fractional spots', () => {
  const kicks = [
    ['punt-standard', 'puntReturn-middle', 'punt', [20.5, 35.5, 44.5, 64.5]],
    ['punt-pooch', 'puntReturn-middle', 'punt', [56.5, 62.5]],
    ['kickoff-deep', 'kickReturn-middle', 'kickoff', [35, 42.5, 27.5]],
    ['kickoff-squib', 'kickReturn-middle', 'kickoff', [35.5]],
  ] as const;
  for (const [off, def, special, spots] of kicks) {
    it(`${off} from ${spots.join(', ')}`, () => {
      const bad: string[] = [];
      for (const ballOn of spots) {
        const base = makeCtx({ offensePlayId: off, defensePlayId: def, ballOn, down: 4, distance: 8, special, seed: 3 });
        for (let v = 0; v < 150; v++) {
          const o = simulatePlay(variantOf(base, v));
          if (o.kickDistance !== null && !Number.isInteger(o.kickDistance)) bad.push(`${off} @${ballOn} v${v}: kickDistance ${o.kickDistance}`);
          if (!Number.isInteger(o.returnYards)) bad.push(`${off} @${ballOn} v${v}: returnYards ${o.returnYards}`);
          for (const d of o.stats) if (!FRACTIONAL.has(d.stat) && !Number.isInteger(d.value)) bad.push(`${off} @${ballOn} v${v}: ${d.stat} ${d.value}`);
          for (const line of o.playByPlay) if (/\d\.\d/.test(line)) bad.push(`${off} @${ballOn} v${v}: "${line}"`);
        }
      }
      expect(bad.slice(0, 8)).toEqual([]);
    });
  }
});

describe('overturned touchdowns credit whole yards', () => {
  it('the review alternate of a score from a fractional spot is a whole-yard gain', () => {
    const bad: string[] = [];
    let alternates = 0;
    for (const [off, def] of [['iform-dive-right', '43-cover3-zone'], ['shotgun-slants', '43-cover1-man']] as const) {
      const base = makeCtx({ offensePlayId: off, defensePlayId: def, ballOn: 96.5, seed: 9 });
      for (let v = 0; v < 800; v++) {
        const alt = simulatePlay(variantOf(base, v)).review?.ifOverturned;
        if (!alt) continue;
        alternates += 1;
        if (!Number.isInteger(alt.yards)) bad.push(`${off} v${v}: yards ${alt.yards}`);
        for (const d of alt.stats) if (!FRACTIONAL.has(d.stat) && !Number.isInteger(d.value)) bad.push(`${off} v${v}: ${d.stat} ${d.value}`);
      }
    }
    expect(alternates).toBeGreaterThan(0);
    expect(bad.slice(0, 8)).toEqual([]);
  });
});
