import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { ahead, build, chaseBall, pursue, scripted } from './helpers';

const boost = (power: number, accuracy: number) => (ctx: PlayContext): void => {
  const p = ctx.offenseLineup.K!;
  p.attrs.kickPower = power;
  p.attrs.kickAccuracy = accuracy;
};
const lastLine = (o: PlayOutcome): string => o.playByPlay[o.playByPlay.length - 1] ?? '';
const returnStats = (o: PlayOutcome): number => o.stats.filter((d) => d.stat === 'returns.kickReturns').length;

describe('kickoff play-by-play agrees with the outcome facts', () => {
  it('a returner who fields it deep and runs out the back of his end zone: touchback, no return yards, no return stat', () => {
    const b = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 10, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
      decider: scripted({ 'def:KR': (a, s) => (a.hasBall ? ahead(s, 'offense') : s.ball.phase === 'inAir' ? chaseBall(a, s) : idleIntent('wait')) }),
    }, boost(99, 99));
    const o = b.engine.run();
    assertValidOutcome(o);
    expect(b.engine.state.deadReason).toBe('touchback');
    expect(o.returnYards).toBe(0);
    expect(returnStats(o)).toBe(0);
    expect(lastLine(o)).toMatch(/^Touchback/);
    expect(lastLine(o)).not.toMatch(/gain|return of/);
  });

  it('an unfielded deep kick is a touchback with no return', () => {
    const b = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 10, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, { decider: scripted({}) }, boost(99, 99));
    const o = b.engine.run();
    expect(o.returnYards).toBe(0);
    expect(lastLine(o)).toBe('Touchback, no return.');
  });

  it('a returned kick reports the same return yards in the result line as in the outcome', () => {
    const b = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 9, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
      decider: scripted({
        'def:KR': (a, s) => (a.hasBall ? ahead(s, 'defense') : s.ball.phase === 'inAir' ? chaseBall(a, s) : idleIntent('wait')),
        'off:KC5': (a, s) => (s.phase === 'live' ? pursue(a, s) : idleIntent('set')),
        'off:KC6': (a, s) => (s.phase === 'live' ? pursue(a, s) : idleIntent('set')),
      }),
    }, boost(40, 70));
    const o = b.engine.run();
    expect(o.returnYards).toBeGreaterThan(0);
    expect(lastLine(o)).toContain(`return of ${o.returnYards}`);
    expect(lastLine(o)).not.toMatch(/no gain/);
  });
});

describe('every kick result line matches its outcome (AI on both sides)', () => {
  it('kickoffs, squibs, onside kicks and punts: touchbacks and fair catches carry no return, returns quote their yards', async () => {
    const { decideIntent } = await import('@/ai/index');
    const { registerAll } = await import('@/ai/register');
    registerAll();
    const cases: [string, string, 'kickoff' | 'onside' | 'punt', number][] = [
      ['kickoff-deep', 'kickReturn-middle', 'kickoff', 35], ['kickoff-squib', 'kickReturn-middle', 'kickoff', 35],
      ['kickoff-onside', 'kickReturn-hands', 'onside', 35], ['punt-standard', 'puntReturn-middle', 'punt', 30],
      ['punt-pooch', 'puntReturn-middle', 'punt', 55],
    ];
    const seen = new Set<string>();
    for (const [off, def, special, ballOn] of cases) {
      for (let seed = 1; seed <= 6; seed++) {
        const b = build({ offensePlayId: off, defensePlayId: def, seed, ballOn, ruleset: 'simulation' }, { special }, { decider: decideIntent });
        const o = b.engine.run();
        assertValidOutcome(o);
        const line = lastLine(o);
        const why = `${off} seed ${seed}: ${line} (returnYards ${o.returnYards}, dead ${b.engine.state.deadReason})`;
        expect(line, why).not.toMatch(/gain/);
        if (o.result === 'penalty' || o.safety) continue;
        const reason = b.engine.state.deadReason;
        seen.add(o.touchdown ? 'touchdown' : reason ?? 'none');
        if (o.touchdown) continue;
        if (reason === 'touchback' || reason === 'fairCatch') {
          expect(o.returnYards, why).toBe(0);
          expect(returnStats(o), why).toBe(0);
          expect(line, why).toMatch(reason === 'touchback' ? /^Touchback, no return\.$/ : /^Fair catch at .*, no return\.$/);
        } else if (reason === 'onsideRecovered') {
          expect(line, why).toMatch(/^Onside kick recovered by the kicking team/);
        } else if (o.returnYards !== 0) {
          expect(line, why).toContain(o.returnYards > 0 ? `return of ${o.returnYards}` : `return for a loss of ${-o.returnYards}`);
        }
      }
    }
    // The sample must actually exercise the kinds of result this guards.
    expect([...seen].filter((k) => ['touchback', 'fairCatch', 'tackle'].includes(k)).length, [...seen].join(',')).toBe(3);
  }, 60_000);
});
