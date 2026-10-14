/**
 * Spec rule for the fast sim: difficulty changes AI DECISIONS, never the dice. Two halves, mirroring the live engine's
 * difficulty-dice test:
 *  - difficulty reaches the model only through the decision knobs: hold the knobs at pro and move the difficulty the
 *    context carries, and every play (scrimmage and kicks) comes out identical;
 *  - the decision stand-ins (the QB's progression read, the RPO read, the tackler's approach) draw the same dice at
 *    every difficulty: the knob only moves thresholds and scales noise, never how many rolls are taken or in what order.
 */
import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@/core/rng';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId } from '@/game/types';
import { createFastSim } from '@/simulation/fast-sim';
import { buildMatchups } from '@/simulation/matchups';
import { chooseTarget } from '@/simulation/pass-model';
import { knobsFor, rpoThrows } from '@/simulation/play-model';
import { approachFactor } from '@/simulation/sim-random';
import { DEF_PLAYS, makeCtx, PASS_PLAYS, RUN_PLAYS } from './helpers';

const IDS: readonly DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];

/** A seeded rng that logs every call made on it (the method name), so two runs can be compared draw for draw. */
const recording = (seed: string): { rng: Rng; log: string[] } => {
  const inner = createRng(seed);
  const log: string[] = [];
  const rng: Rng = {
    next: () => { log.push('next'); return inner.next(); },
    range: (lo, hi) => { log.push('range'); return inner.range(lo, hi); },
    int: (lo, hi) => { log.push('int'); return inner.int(lo, hi); },
    chance: (p) => { log.push('chance'); return inner.chance(p); },
    pick: (items) => { log.push('pick'); return inner.pick(items); },
    weighted: (items, weights) => { log.push('weighted'); return inner.weighted(items, weights); },
    gaussian: (mean, sd) => { log.push('gaussian'); return inner.gaussian(mean, sd); },
    shuffle: (items) => { log.push('shuffle'); return inner.shuffle(items); },
    fork: (label) => { log.push('fork'); return inner.fork(label); },
    getState: () => inner.getState(),
    setState: (s) => inner.setState(s),
    get seed() { return inner.seed; },
  };
  return { rng, log };
};

const ctxAt = (id: DifficultyId, off: string, def: string, variant: number): PlayContext =>
  makeCtx({ offensePlayId: off, defensePlayId: def, seed: 5, difficulty: id }, variant);

const fingerprint = (o: PlayOutcome): string =>
  JSON.stringify([o.result, o.yards, o.turnover, o.touchdown, o.timeElapsed, o.endBallX, o.events.map((e) => `${e.type}@${e.tick}`), o.penalties.map((p) => p.foul)]);

describe('fast sim: difficulty never touches the dice', () => {
  it('with the decision knobs held at pro every play resolves identically whatever difficulty the context carries', () => {
    const proKnobs = (ctx: PlayContext) => knobsFor({ ...ctx, difficulty: getDifficulty('pro') });
    const sim = createFastSim(null, proKnobs);
    const specials: [string, string, PlayContext['special']][] = [['kickoff-deep', 'kickReturn-middle', 'kickoff'], ['punt-standard', 'puntReturn-middle', 'punt'], ['fieldGoal-standard', 'fgBlock-middle', 'fieldGoal']];
    let compared = 0;
    const plays: [string, string, PlayContext['special'] | undefined][] = [
      ...PASS_PLAYS.slice(0, 8).map((p, i) => [p, DEF_PLAYS[i % DEF_PLAYS.length] as string, undefined] as [string, string, undefined]),
      ...RUN_PLAYS.slice(0, 6).map((p, i) => [p, DEF_PLAYS[(i + 3) % DEF_PLAYS.length] as string, undefined] as [string, string, undefined]),
      ...specials,
    ];
    for (const [off, def, special] of plays) {
      for (let v = 0; v < 6; v++) {
        const run = (id: DifficultyId): string => {
          const ctx = makeCtx({ offensePlayId: off, defensePlayId: def, seed: 9, difficulty: id, ...(special ? { special } : {}) }, v);
          return fingerprint(sim(ctx));
        };
        expect(run('legend'), `${off} vs ${def} #${v}`).toBe(run('rookie'));
        compared += 1;
      }
    }
    expect(compared).toBe(plays.length * 6);
  });

  it('the QB progression read draws one normal per receiver plus two rolls at every difficulty', () => {
    for (const off of PASS_PLAYS) {
      for (const def of DEF_PLAYS.slice(0, 6)) {
        for (let v = 0; v < 4; v++) {
          for (const pressure of [false, true]) {
            const logs = IDS.map((id) => {
              const ctx = ctxAt(id, off, def, v);
              const m = buildMatchups(ctx, knobsFor(ctx));
              const r = recording(`${off}:${def}:${v}`);
              chooseTarget(ctx, m, r.rng, pressure, { playAction: false, screen: false, rpo: false });
              return { log: r.log.join(','), receivers: m.receivers.length };
            });
            const first = logs[0] as (typeof logs)[number];
            for (const l of logs) expect(l.log, `${off} vs ${def} #${v}`).toBe(first.log);
            expect(first.log.split(',')).toEqual([...Array.from({ length: first.receivers }, () => 'gaussian'), 'next', 'next']);
          }
        }
      }
    }
  });

  it('the RPO read and the tackler approach roll one die whatever the knob', () => {
    const ctx = ctxAt('pro', 'shotgun-rpoSlant', '43-cover3-zone', 0);
    const base = buildMatchups(ctx, knobsFor(ctx));
    const tackler = base.defense[0];
    if (!tackler) throw new Error('no defender');
    for (const iq of [0.3, 0.5, 0.92, null]) {
      const r = recording('rpo');
      rpoThrows({ ...base, qbDecision: iq ?? 0.5 }, r.rng);
      approachFactor(r.rng, tackler, iq);
      expect(r.log).toEqual(['chance', 'chance']);
    }
  });

  it('decisions still differ: a legend QB and a legend coverage change the numbers the same dice produce', () => {
    const sample = (id: DifficultyId): number => {
      let open = 0;
      for (const off of PASS_PLAYS) {
        for (let v = 0; v < 10; v++) {
          const ctx = ctxAt(id, off, '43-cover3-zone', v);
          const m = buildMatchups(ctx, knobsFor(ctx));
          const pick = chooseTarget(ctx, m, createRng(`${off}:${v}`), false, { playAction: false, screen: false, rpo: false });
          open += pick ? pick.openness : 0;
        }
      }
      return open;
    };
    expect(sample('legend')).not.toBe(sample('rookie'));
  });
});
