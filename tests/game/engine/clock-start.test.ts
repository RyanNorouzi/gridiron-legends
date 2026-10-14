/** The live game clock the HUD shows: when it starts running during a play. */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { createPlayEngine } from '@/game/play-engine';
import { LIVE_CLOCK_SCALE } from '@/game/rules/clock';
import { liveClockElapsed } from '@/ui/game/hud';
import { buildPlayState } from '../../fixtures/play-state';

registerAll();

const engineFor = (offensePlayId: string, defensePlayId: string, special: 'none' | 'kickoff' | 'extraPoint' = 'none') => {
  const f = buildPlayState({ offensePlayId, defensePlayId, seed: 4, ballOn: special === 'kickoff' ? 35 : special === 'extraPoint' ? 85 : 30, ruleset: 'arcade' });
  return createPlayEngine({ ...f.state.ctx, special }, { registries: f.registry });
};

describe('live clock start', () => {
  it('a scrimmage play starts the clock at the snap and the HUD counts it down', () => {
    const e = engineFor('shotgun-mesh', '43-cover3-zone');
    while (e.state.phase === 'presnap') e.tick();
    e.tick();
    expect(e.state.clockStartTick).toBe(e.state.snapTick);
    for (let i = 0; i < 90 && !e.isDead; i++) e.tick();
    // A scrimmage down charges game-clock seconds at LIVE_CLOCK_SCALE per engine second (the fast sim's snap-to-whistle times).
    if (!e.isDead) expect(liveClockElapsed(e.state)).toBeCloseTo(((e.state.tick - e.state.snapTick) / 60) * LIVE_CLOCK_SCALE, 5);
  });

  it('a kickoff starts it only once the kick comes down or is fielded (never on a touchback)', () => {
    let returned = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed, ballOn: 35, ruleset: 'arcade' });
      const e = createPlayEngine({ ...f.state.ctx, special: 'kickoff' }, { registries: f.registry });
      let startedWhileAirborne = false;
      for (let i = 0; i < 1500 && !e.isDead; i++) {
        e.tick();
        const kicked = e.state.events.some((ev) => ev.type === 'kick');
        if (kicked && e.state.ball.phase === 'inAir' && e.state.clockStartTick != null) startedWhileAirborne = true;
      }
      expect(startedWhileAirborne).toBe(false);
      const touchback = e.state.events.some((ev) => ev.type === 'touchback');
      if (touchback) expect(e.state.clockStartTick ?? null).toBeNull();
      else if (e.outcome && e.outcome.returnYards !== 0) { returned++; expect(e.state.clockStartTick ?? null).not.toBeNull(); }
    }
    expect(returned).toBeGreaterThan(0);
  });

  it('a PAT never runs the clock', () => {
    const e = engineFor('extraPoint-standard', 'fgBlock-middle', 'extraPoint');
    for (let i = 0; i < 600 && !e.isDead; i++) {
      e.tick();
      expect(liveClockElapsed(e.state)).toBe(0);
    }
    expect(e.state.clockStartTick ?? null).toBeNull();
  });

  it('is zero between plays', () => {
    expect(liveClockElapsed(null)).toBe(0);
  });
});

describe('kickoff time charged to the game clock (H2-12)', () => {
  it('a touchback charges no time; a return charges only from the catch', () => {
    let touchbacks = 0;
    let returns = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed, ballOn: 35, ruleset: 'arcade' });
      const e = createPlayEngine({ ...f.state.ctx, special: 'kickoff' }, { registries: f.registry });
      const o = e.run();
      if (e.state.deadReason === 'touchback') {
        touchbacks++;
        expect(o.timeElapsed).toBe(0);
      } else if (e.state.clockStartTick != null) {
        returns++;
        expect(o.timeElapsed).toBeCloseTo((e.state.tick - e.state.clockStartTick) / 60, 6);
        expect(o.timeElapsed).toBeLessThan((e.state.tick - e.state.snapTick) / 60);
      }
    }
    expect(touchbacks + returns).toBeGreaterThan(0);
  });
});
