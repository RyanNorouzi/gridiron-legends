import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist, type Vec2 } from '@/core/vec2';
import type { ThrowType } from '@/game/play-events';
import { FIELD_WIDTH } from '@/game/types';
import { CATCH_HEIGHT, launchPass, predictLanding, throwBall, type LaunchOptions } from '@/physics/ball';
import { trackBall, trackThrowIntent, SIDELINE_MARGIN } from '@/ai/receiver';
import { fixture, place, runSim, snapNow, type SimResult } from './sim';

type Fx = ReturnType<typeof fixture>;

/** Puts a pass in the air from the QB to `to` aimed at the receiver `wrRole`. */
const throwTo = (fx: Fx, wrRole: string, to: Vec2, type: ThrowType = 'bullet', opts: LaunchOptions = {}): void => {
  const state = fx.state;
  const qb = fx.byRole('offense', 'QB');
  const wr = fx.byRole('offense', wrRole);
  const launch = launchPass(qb.pos, to, type, qb.attrs.throwPower, opts);
  state.ball = throwBall(state.ball, qb, launch, { id: wr.id, pos: to }, type, state.tick);
  qb.hasBall = false;
};

describe('receiver', () => {
  it('tracks a ball thrown at him and comes back for an underthrow', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const wr = fx.byRole('offense', 'WR2');
    const dir = fx.state.ctx.direction;
    runSim(fx, { seconds: 1.6, idleRoles: ['QB'] });
    const vBefore = wr.vel.y * dir;
    expect(vBefore).toBeGreaterThan(6);
    throwTo(fx, 'WR2', { x: wr.pos.x, y: wr.pos.y - dir * 4 }, 'lob');
    let minV = Infinity;
    runSim(fx, { seconds: 1.2, idleRoles: ['QB'], onTick: () => { minV = Math.min(minV, wr.vel.y * dir); } });
    expect(minV).toBeLessThan(vBefore * 0.4);
    expect(wr.ai.decision).toBe('track ball');
  });

  it('gathers a catchable ball and turns into a ball carrier', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const wr = fx.byRole('offense', 'WR2');
    const dir = fx.state.ctx.direction;
    runSim(fx, { seconds: 1.2, idleRoles: ['QB'] });
    throwTo(fx, 'WR2', { x: wr.pos.x, y: wr.pos.y + dir * 9 }, 'touch');
    const res = runSim(fx, { seconds: 2.5, idleRoles: ['QB'] });
    expect(wr.hasBall).toBe(true);
    expect(res.deadReason).toBeNull();
    expect(wr.ai.decision.startsWith('carry')).toBe(true);
  });

  it('high-points a contested ball with a jump', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const wr = fx.byRole('offense', 'WR2');
    const cb = fx.byRole('defense', 'CB2');
    const dir = fx.state.ctx.direction;
    wr.attrs.hands = 90;
    wr.attrs.strength = 85;
    runSim(fx, { seconds: 1.5, idleRoles: ['QB'] });
    const to = { x: wr.pos.x, y: wr.pos.y + dir * 8 };
    place(cb, { x: to.x + 0.6, y: to.y + dir * 0.4 });
    throwTo(fx, 'WR2', to, 'highPoint');
    const track = trackBall(wr, fx.state);
    expect(track.contested).toBe(true);
    expect(track.aggression).toBeGreaterThan(0.45);
    expect(track.high).not.toBeNull();
    const res: SimResult = runSim(fx, { seconds: 2, idleRoles: ['QB'] });
    const jumps = res.events.filter((e) => e.id === wr.id && e.action === 'jump');
    expect(jumps.length).toBeGreaterThanOrEqual(1);
    expect(jumps[0]!.debug).toBe('high point');
  });

  it('dives for a low ball it cannot reach standing up', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 3 });
    const state = fx.state;
    snapNow(state);
    const wr = fx.byRole('offense', 'WR2');
    const qb = fx.byRole('offense', 'QB');
    place(qb, { x: wr.pos.x, y: wr.pos.y - state.ctx.direction * 8 });
    const to = { x: wr.pos.x + 2.6, y: wr.pos.y };
    throwTo(fx, 'WR2', to, 'bullet', { catchHeight: 0.4 });
    let dove = false;
    for (let i = 0; i < 40 && !dove; i++) {
      state.tick += 1;
      const intent = trackThrowIntent(wr, state, TICK_DT, null);
      if (intent.action === 'dive') dove = true;
      wr.pos = { x: wr.pos.x + intent.move.x * 0.05, y: wr.pos.y + intent.move.y * 0.05 };
      state.ball.pos = { x: state.ball.pos.x + state.ball.vel.x * TICK_DT, y: state.ball.pos.y + state.ball.vel.y * TICK_DT };
      state.ball.z = Math.max(0, state.ball.z + state.ball.vz * TICK_DT - 0.5 * 10.72 * TICK_DT * TICK_DT);
      state.ball.vz -= 10.72 * TICK_DT;
    }
    expect(dove).toBe(true);
  });

  it('keeps his centre in bounds by the sideline margin', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const state = fx.state;
    snapNow(state);
    const wr = fx.byRole('offense', 'WR2');
    place(wr, { x: 51.5, y: wr.pos.y + state.ctx.direction * 6 });
    throwTo(fx, 'WR2', { x: 54.5, y: wr.pos.y + state.ctx.direction * 6 }, 'touch');
    const raw = predictLanding(state.ball, state.ctx.weather, CATCH_HEIGHT).pos;
    expect(raw.x).toBeGreaterThan(FIELD_WIDTH - 0.2);
    expect(trackBall(wr, state).landing.x).toBeLessThanOrEqual(FIELD_WIDTH - SIDELINE_MARGIN + 1e-9);
    runSim(fx, { seconds: 1.5, idleRoles: ['QB'] });
    expect(wr.pos.x).toBeLessThanOrEqual(FIELD_WIDTH - 0.2);
  });

  it('shields a defender when the ball goes elsewhere and blocks after the catch', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1 });
    const wr1 = fx.byRole('offense', 'WR1');
    const rb = fx.byRole('offense', 'RB');
    const dir = fx.state.ctx.direction;
    let shield = false;
    let blocked = false;
    let targeted = false;
    // Let the routes develop, then script the checkdown to the back so the test does not depend on the QB's read.
    runSim(fx, { seconds: 1.0, idleRoles: ['QB'] });
    throwTo(fx, 'RB', { x: rb.pos.x + rb.vel.x * 0.5, y: rb.pos.y + rb.vel.y * 0.5 + dir }, 'bullet');
    runSim(fx, {
      seconds: 3,
      idleRoles: ['QB'],
      onTick: (state) => {
        const dbg = wr1.ai.decision;
        if (state.ball.phase === 'inAir' && state.ball.targetId === rb.id && (dbg.startsWith('stalk') || dbg.startsWith('shadow'))) shield = true;
        if (rb.hasBall && dbg.startsWith('stalk')) { blocked = true; if (wr1.ai.blockTargetId !== null) targeted = true; }
      },
    });
    expect(rb.hasBall).toBe(true);
    expect(shield).toBe(true);
    expect(blocked).toBe(true);
    expect(targeted).toBe(true);
  });

  it('receiver intelligence tightens the early landing estimate', () => {
    const estimate = (difficulty: 'rookie' | 'legend'): number => {
      const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2, difficulty });
      const wr = fx.byRole('offense', 'WR2');
      runSim(fx, { seconds: 1.0, idleRoles: ['QB'] });
      const dir = fx.state.ctx.direction;
      throwTo(fx, 'WR2', { x: wr.pos.x + 1, y: wr.pos.y + dir * 18 }, 'lob');
      const truth = predictLanding(fx.state.ball, fx.state.ctx.weather, CATCH_HEIGHT).pos;
      return dist(trackBall(wr, fx.state).landing, truth);
    };
    const rookie = estimate('rookie');
    const legend = estimate('legend');
    expect(legend).toBeLessThan(rookie);
    expect(legend).toBeLessThan(0.5);
  });
});
