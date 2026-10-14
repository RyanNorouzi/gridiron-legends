/**
 * Kick coverage holds its lanes while a returner picks his way, but a returner who stalls (or just stands with the
 * ball, as a human who does nothing) is attacked and brought down quickly.
 */
import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { idleIntent, type IntentDecider } from '@/game/engine-api';
import { createPlayEngine } from '@/game/play-engine';
import { buildPlayState } from '../../fixtures/play-state';

registerAll();

/** The returner fields the kick normally, then stands still with it; everyone else is the real AI. */
const standingReturner: IntentDecider = (a, s, dt) => (a.side === 'defense' && a.hasBall ? idleIntent('stand') : decideIntent(a, s, dt));

describe('kick coverage vs a stalled returner', () => {
  it('attacks a returner who stands with the ball instead of holding lanes around him', () => {
    let fielded = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed, ballOn: 35, ruleset: 'arcade' });
      const e = createPlayEngine({ ...f.state.ctx, special: 'kickoff' }, { registries: f.registry, decider: standingReturner });
      let arrivedTick: number | null = null;
      for (let i = 0; i < 3000 && !e.isDead; i++) {
        e.tick();
        const holder = e.state.athletes.find((a) => a.hasBall);
        if (arrivedTick === null && holder && holder.side === 'defense') {
          const near = e.state.athletes.some((a) => a.side === 'offense' && a.active && Math.hypot(a.pos.x - holder.pos.x, a.pos.y - holder.pos.y) <= 5);
          if (near) arrivedTick = e.state.tick;
        }
      }
      expect(e.isDead).toBe(true);
      if (arrivedTick === null || e.state.events.some((ev) => ev.type === 'touchback' || ev.type === 'fairCatch')) continue;
      fielded++;
      // From the first coverage man arriving within 5 yd to the first hit (a wrap-up or tackle): no lane-holding
      // standoff. The struggle after the wrap-up (the owner's "keep moving through a hit") is not a standoff.
      const arrived = arrivedTick;
      const hit = e.state.events.find((ev) => (ev.type === 'wrapUp' || ev.type === 'tackle') && ev.tick >= arrived);
      const seconds = ((hit?.tick ?? e.state.tick) - arrived) / 60;
      expect(seconds, `seed ${seed}: coverage stood off a stationary returner for ${seconds.toFixed(1)} s`).toBeLessThan(1.5);
    }
    expect(fielded).toBeGreaterThan(0);
  }, 30_000); // whole kick plays: ~2.5 s alone, timed out at the 5 s default beside other suites
});
