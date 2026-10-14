import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { looseBallFrom } from '@/game/systems/fumble';
import { ahead, build, chaseBall, scripted } from './helpers';

/** Kickoff with the returner fielding it and heading upfield; everyone else stands still. */
const kickoff = (seed: number) => build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
  decider: scripted({ 'def:KR': (a, s) => (a.hasBall ? ahead(s, 'defense') : s.ball.phase === 'inAir' ? chaseBall(a, s) : idleIntent('wait')) }),
}, (ctx) => { ctx.offenseLineup.K!.attrs.kickPower = 60; });

describe('muffs versus fumbles on kick returns', () => {
  it('a returner who loses the ball after fielding the kick has fumbled, not muffed', () => {
    let checked = 0;
    for (let seed = 1; seed <= 6 && checked === 0; seed++) {
      const { engine } = kickoff(seed);
      for (let i = 0; i < 60 * 12 && engine.state.phase !== 'dead'; i++) {
        engine.tick();
        const kr = engine.state.athletes.find((a) => a.id === 'def:KR')!;
        if (kr.hasBall && engine.state.ball.phase === 'held') {
          const cover = engine.state.athletes.find((a) => a.side === 'offense' && a.id !== 'off:K')!;
          looseBallFrom(engine.state, engine.debugEnv(), kr, cover);
          const last = engine.state.events[engine.state.events.length - 1]!;
          expect(last.type).toBe('fumble');
          expect(engine.state.events.some((e) => e.type === 'muff')).toBe(false);
          expect(engine.debugEnv().fumbles.at(-1)?.muff).toBe(false);
          checked++;
          break;
        }
      }
    }
    expect(checked).toBe(1);
  });

  it('a kick that pops off the returner before he secures it is a muff', () => {
    const { engine } = kickoff(3);
    for (let i = 0; i < 60 * 12 && engine.state.ball.phase !== 'inAir'; i++) engine.tick();
    expect(engine.state.ball.phase).toBe('inAir');
    const kr = engine.state.athletes.find((a) => a.id === 'def:KR')!;
    looseBallFrom(engine.state, engine.debugEnv(), kr, null, { popSpeed: 1.5 });
    expect(engine.state.events.at(-1)?.type).toBe('muff');
    expect(engine.debugEnv().fumbles.at(-1)?.muff).toBe(true);
  });
});
