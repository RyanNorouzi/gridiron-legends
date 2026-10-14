/**
 * A human punter's stick aims the kick; it must not also walk him away from the snap or off his spot while the
 * meter sweeps. After the kick he moves normally (coverage).
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import type { PlayState, UserPlayInput } from '@/game/play-types';
import { kickerHoldsStill } from '@/game/user-control';
import { build } from './helpers';

registerAll();

const input = (o: Partial<UserPlayInput> = {}): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false, ...o,
});

const puntPlay = (seed: number) =>
  build({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', seed, ballOn: 30, ruleset: 'arcade', userSide: 'home', controlRole: 'P' }, { special: 'punt' });

const punter = (s: PlayState) => s.athletes.find((a) => a.role === 'P' && a.side === 'offense')!;

describe('human punter control', () => {
  it('holds still while the snap is in flight and while the meter sweeps, then kicks with the aim applied', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const { engine } = puntPlay(seed);
      expect(engine.state.controlledIds.home).toBe(punter(engine.state).id);
      expect(engine.state.kickMeter).not.toBeNull();
      // Snap, then keep the stick hard right the whole time and press the meter three times once he has the ball.
      while (engine.state.phase === 'presnap') engine.tick({ home: input({ snap: true }) });
      const start = { ...punter(engine.state).pos };
      let presses = 0;
      let stillWhileAiming = true;
      for (let t = 0; t < 600 && !engine.isDead; t++) {
        const s = engine.state;
        const p = punter(s);
        const held = s.ball.carrierId === p.id && s.ball.phase === 'held';
        const press = held && presses < 3 && t % 20 === 0;
        if (press) presses += 1;
        const before = { ...p.pos };
        const aiming = kickerHoldsStill(p, s);
        engine.tick({ home: input({ move: vec2(1, 0), kickPress: press }) });
        if (aiming && Math.hypot(p.pos.x - before.x, p.pos.y - before.y) > 0.05) stillWhileAiming = false;
        if (s.kickMeter?.phase === 'done') break;
      }
      expect(stillWhileAiming).toBe(true);
      expect(engine.state.events.some((e) => e.type === 'muff' && e.by === punter(engine.state).id)).toBe(false);
      expect(engine.state.events.some((e) => e.type === 'kick')).toBe(true);
      // He did not wander off his spot before the kick.
      expect(Math.abs(punter(engine.state).pos.x - start.x)).toBeLessThan(1.5);
    }
  });

  it('moves freely once the kick is away', () => {
    const { engine } = puntPlay(2);
    while (engine.state.phase === 'presnap') engine.tick({ home: input({ snap: true }) });
    let presses = 0;
    for (let t = 0; t < 600 && !engine.isDead && !engine.state.events.some((e) => e.type === 'kick'); t++) {
      const p = punter(engine.state);
      const held = engine.state.ball.carrierId === p.id && engine.state.ball.phase === 'held';
      const press = held && presses < 3 && t % 20 === 0;
      if (press) presses += 1;
      engine.tick({ home: input({ kickPress: press }) });
    }
    expect(engine.state.events.some((e) => e.type === 'kick')).toBe(true);
    const p = punter(engine.state);
    expect(kickerHoldsStill(p, engine.state)).toBe(false);
    const x0 = p.pos.x;
    const dbg = `controlled=${engine.state.controlledIds.home} punter=${p.id} state=${p.state} timer=${p.stateTimer.toFixed(2)} dead=${engine.isDead}`;
    for (let t = 0; t < 90 && !engine.isDead; t++) engine.tick({ home: input({ move: vec2(1, 0), sprint: true }) });
    expect(p.pos.x - x0, dbg).toBeGreaterThan(1);
  });
});

describe('human place kicks beat the rush (H2-04)', () => {
  it('the meter is set before the snap, so the kick is away about as fast as the AI kicker gets it off', () => {
    let kicked = 0;
    for (let seed = 1; seed <= 6; seed++) {
      for (const special of ['fieldGoal', 'extraPoint'] as const) {
        const { engine } = build({ offensePlayId: special === 'fieldGoal' ? 'fieldGoal-standard' : 'extraPoint-standard', defensePlayId: 'fgBlock-middle', seed, ballOn: special === 'fieldGoal' ? 70 : 85, ruleset: 'arcade', userSide: 'home' }, { special });
        const s = engine.state;
        const o = engine.run((st) => {
          const m = st.kickMeter;
          const press = !!m && ((m.phase === 'idle' && st.tick > 10) || (m.phase === 'power' && m.cursor >= 0.95) || (m.phase === 'accuracy' && m.cursor >= 0.95));
          return { home: input({ kickPress: press }) };
        });
        const kick = s.events.find((e) => e.type === 'kick');
        expect(kick, `seed ${seed} ${special}: ${o.playByPlay.join(' / ')}`).toBeDefined();
        if (kick) {
          kicked++;
          expect((kick.tick - s.snapTick) / 60).toBeLessThan(1.5);
        }
      }
    }
    expect(kicked).toBe(12);
  });
});
