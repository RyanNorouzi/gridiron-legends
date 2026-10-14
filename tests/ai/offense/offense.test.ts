import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import { clearDeciders, decideIntent, getDecider } from '@/ai/index';
import { OFFENSE_DECIDERS, registerOffense } from '@/ai/offense';
import { fixture, place, snapNow } from './sim';

describe('offense registration', () => {
  it('registers a decider for all seven offensive assignment keys', () => {
    clearDeciders();
    registerOffense();
    const fx = fixture({ offensePlayId: 'iform-dive-right', seed: 1 });
    for (const a of fx.state.athletes.filter((x) => x.side === 'offense')) expect(getDecider(a), a.role).toBeDefined();
    expect(Object.keys(OFFENSE_DECIDERS).sort()).toEqual(['carry', 'chipRelease', 'leadBlock', 'passBlock', 'qb', 'route', 'runBlock']);
    const te = fx.byRole('offense', 'TE1');
    te.assignment = { type: 'chipRelease', releaseRoute: 'stick' };
    expect(getDecider(te)).toBeDefined();
    registerOffense();
    expect(getDecider(te)).toBeDefined();
  });

  it('mirrors the debug label into ai.decision and stamps the tick', () => {
    registerOffense();
    const fx = fixture({ seed: 1 });
    snapNow(fx.state);
    fx.state.tick = 17;
    const wr = fx.byRole('offense', 'WR2');
    const intent = decideIntent(wr, fx.state, TICK_DT);
    expect(wr.ai.decision).toBe(intent.debug);
    expect(wr.ai.lastDecisionTick).toBe(17);
  });

  it('every offensive decider chases a loose ball and pursues a defender who has it', () => {
    registerOffense();
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    const state = fx.state;
    snapNow(state);
    fx.byRole('offense', 'QB').hasBall = false;
    const loose = { x: state.ctx.ballX + 6, y: state.losY + state.ctx.direction * 4 };
    state.ball = { ...state.ball, phase: 'loose', kind: 'fumble', carrierId: null, pos: loose, z: 0, vz: 0, vel: { x: 0, y: 0 } };
    for (const a of state.athletes.filter((x) => x.side === 'offense')) {
      const intent = decideIntent(a, state, TICK_DT);
      expect(intent.debug, a.role).toBe('chase ball');
      const before = dist(a.pos, loose);
      const after = dist({ x: a.pos.x + intent.move.x, y: a.pos.y + intent.move.y }, loose);
      expect(after, a.role).toBeLessThan(before);
    }
    const cb = fx.byRole('defense', 'CB1');
    place(cb, loose);
    cb.hasBall = true;
    state.ball = { ...state.ball, phase: 'held', kind: 'fumble', carrierId: cb.id, pos: { ...cb.pos } };
    for (const a of state.athletes.filter((x) => x.side === 'offense')) {
      const intent = decideIntent(a, state, TICK_DT);
      expect(intent.debug, a.role).toBe('pursue carrier');
      expect(intent.sprint).toBe(true);
    }
    const te = fx.byRole('offense', 'TE1');
    place(te, { x: cb.pos.x + 1, y: cb.pos.y });
    const tackle = decideIntent(te, state, TICK_DT);
    expect(tackle.action).toBe('tackle');
    expect(tackle.targetId).toBe(cb.id);
  });

  it('offensive deciders stand still before the snap (the QB runs the cadence)', () => {
    registerOffense();
    const fx = fixture({ offensePlayId: 'shotgun-mesh', seed: 3 });
    for (const a of fx.state.athletes.filter((x) => x.side === 'offense' && x.role !== 'QB')) {
      const intent = decideIntent(a, fx.state, TICK_DT);
      expect(intent.move).toEqual({ x: 0, y: 0 });
      expect(intent.action).toBeNull();
    }
    expect(decideIntent(fx.byRole('offense', 'QB'), fx.state, TICK_DT).debug).toBe('cadence');
  });
});
