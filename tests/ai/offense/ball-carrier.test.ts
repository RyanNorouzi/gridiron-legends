import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { FIELD_WIDTH } from '@/game/types';
import type { Athlete, PlayState } from '@/game/play-types';
import { carryIntent, chooseMove, clockSituation, evaluateLanes } from '@/ai/ball-carrier';
import { gapLocalX } from '@/ai/blocking';
import { toField, toLocal } from '@/ai/route-running';
import { chasePolicy, fixture, place, runSim, snapNow } from './sim';

const MOVES = ['juke', 'spin', 'stiffArm', 'hurdle', 'truck'];

/** Snaps and hands the ball straight to an athlete at a play-local spot. */
const giveBallAt = (state: PlayState, a: Athlete, local: { x: number; y: number }): void => {
  snapNow(state);
  for (const x of state.athletes) x.hasBall = false;
  place(a, toField(local, state));
  a.hasBall = true;
  state.ball = { ...state.ball, phase: 'held', kind: 'handoff', carrierId: a.id, pos: { ...a.pos } };
};

const clearGap = (fx: ReturnType<typeof fixture>): void => {
  place(fx.byRole('defense', 'DT2'), toField({ x: 5, y: 1.5 }, fx.state));
  place(fx.byRole('defense', 'MLB'), toField({ x: -3, y: 9 }, fx.state));
};

const crossingX = (fx: ReturnType<typeof fixture>, seconds = 3.5, defense?: Parameters<typeof runSim>[1]['defense']): { crossX: number; depth: number } => {
  const rb = fx.byRole('offense', 'RB');
  let crossX = NaN;
  runSim(fx, { seconds, defense, onTick: (state) => { if (Number.isNaN(crossX) && rb.hasBall && state.ctx.direction * (rb.pos.y - state.losY) >= 0) crossX = toLocal(rb.pos, state).x; } });
  return { crossX, depth: toLocal(rb.pos, fx.state).y };
};

describe('ball carrier', () => {
  it('hits the designed gap then gets upfield on an inside run', () => {
    for (const [play, seed] of [['iform-dive-right', 1], ['iform-dive-right', 2], ['pistol-insideZone-right', 1]] as const) {
      const fx = fixture({ offensePlayId: play, defensePlayId: '43-runStop-cover1', seed });
      clearGap(fx);
      const gx = gapLocalX('A-right');
      const { crossX, depth } = crossingX(fx);
      expect(Math.abs(crossX - gx), `${play} seed ${seed}`).toBeLessThan(1.5);
      expect(depth).toBeGreaterThan(8);
    }
  });

  it('bounces when defenders fill the designed gap (no lead blocker to trust)', () => {
    const clean = fixture({ offensePlayId: 'pistol-insideZone-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    clearGap(clean);
    const a = crossingX(clean).crossX;
    const plugged = fixture({ offensePlayId: 'pistol-insideZone-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    clearGap(plugged);
    place(plugged.byRole('defense', 'MLB'), toField({ x: gapLocalX('A-right'), y: 0.4 }, plugged.state));
    place(plugged.byRole('defense', 'SS'), toField({ x: gapLocalX('A-right'), y: 2.5 }, plugged.state));
    const b = crossingX(plugged).crossX;
    expect(Math.abs(a - b)).toBeGreaterThan(1);
    expect(Math.abs(b - gapLocalX('A-right'))).toBeGreaterThan(1.2);
  });

  it('uses a special move against a closing tackler and respects the cooldown', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    const rb = fx.byRole('offense', 'RB');
    giveBallAt(fx.state, rb, { x: 0, y: 15 });
    const fs = fx.byRole('defense', 'FS');
    place(fs, toField({ x: 0.3, y: 18.5 }, fx.state));
    const res = runSim(fx, { seconds: 1.5, defense: chasePolicy() });
    const moves = res.events.filter((e) => e.id === rb.id && MOVES.includes(e.action));
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[0]!.time).toBeLessThan(1.2);
    for (let i = 1; i < moves.length; i++) expect(moves[i]!.time - moves[i - 1]!.time).toBeGreaterThan(0.9);
  });

  it('chooses trucks for power backs and jukes for shifty ones', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    const rb = fx.byRole('offense', 'RB');
    giveBallAt(fx.state, rb, { x: 0, y: 8 });
    const lb = fx.byRole('defense', 'MLB');
    place(lb, toField({ x: 0, y: 9.5 }, fx.state));
    lb.vel = { x: 0, y: -fx.state.ctx.direction * 5 };
    rb.vel = { x: 0, y: fx.state.ctx.direction * 7 };
    rb.facing = fx.state.ctx.direction > 0 ? Math.PI / 2 : -Math.PI / 2;
    rb.attrs = { ...rb.attrs, strength: 95, agility: 30, jumping: 30 };
    rb.massLb = 245;
    lb.attrs = { ...lb.attrs, strength: 40, agility: 60, tackling: 60 };
    expect(chooseMove(rb, fx.state, lb)).toBe('truck');
    rb.attrs = { ...rb.attrs, strength: 40, agility: 97, jumping: 30 };
    rb.massLb = 185;
    lb.attrs = { ...lb.attrs, strength: 90, agility: 45 };
    expect(chooseMove(rb, fx.state, lb)).toBe('juke');
    lb.state = 'diving';
    rb.attrs = { ...rb.attrs, agility: 50, jumping: 99 };
    expect(chooseMove(rb, fx.state, lb)).toBe('hurdle');
  });

  it('protects the ball when leading late and steps out when trailing in the two-minute', () => {
    const lead = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    lead.state.ctx.scoreDiff = 7;
    lead.state.ctx.clockRemaining = 100;
    lead.state.ctx.quarter = 4;
    expect(clockSituation(lead.state)).toEqual({ wantOob: false, protect: true });
    const rb = lead.byRole('offense', 'RB');
    giveBallAt(lead.state, rb, { x: 0, y: 15 });
    place(lead.byRole('defense', 'FS'), toField({ x: 0.3, y: 18.5 }, lead.state));
    let protectSeen = false;
    const res = runSim(lead, { seconds: 1.5, defense: chasePolicy(), onTick: () => { if (rb.ai.decision === 'carry: protect ball') protectSeen = true; } });
    expect(res.events.filter((e) => e.id === rb.id && MOVES.includes(e.action))).toHaveLength(0);
    expect(protectSeen).toBe(true);

    const trail = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    trail.state.ctx.scoreDiff = -3;
    trail.state.ctx.clockRemaining = 60;
    trail.state.ctx.quarter = 4;
    expect(clockSituation(trail.state).wantOob).toBe(true);
    const rb2 = trail.byRole('offense', 'RB');
    giveBallAt(trail.state, rb2, { x: 0, y: 6 });
    place(rb2, { x: 4, y: rb2.pos.y });
    trail.state.ball.pos = { ...rb2.pos };
    place(trail.byRole('defense', 'MLB'), { x: 6, y: rb2.pos.y - trail.state.ctx.direction * 2 });
    const startX = rb2.pos.x;
    runSim(trail, { seconds: 2, defense: chasePolicy(0.9) });
    expect(rb2.pos.x).toBeLessThan(startX - 2);
    expect(rb2.pos.x).toBeLessThan(1.0);
  });

  it('dives for the marker with a tackler on him', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 3, distance: 10 });
    const rb = fx.byRole('offense', 'RB');
    giveBallAt(fx.state, rb, { x: 0, y: 9 });
    const lb = fx.byRole('defense', 'MLB');
    place(lb, toField({ x: 0.5, y: 10.2 }, fx.state));
    lb.vel = { x: 0, y: -fx.state.ctx.direction * 4 };
    const intent = carryIntent(rb, fx.state, TICK_DT);
    expect(intent.action).toBe('dive');
    expect(intent.move.y * fx.state.ctx.direction).toBeGreaterThan(0.9);
  });

  it('a scrambling QB slides in simulation mode but keeps running in arcade', () => {
    for (const ruleset of ['simulation', 'arcade'] as const) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4, ruleset });
      const qb = fx.byRole('offense', 'QB');
      giveBallAt(fx.state, qb, { x: 0, y: 5 });
      const lb = fx.byRole('defense', 'MLB');
      place(lb, toField({ x: 0.3, y: 6.5 }, fx.state));
      lb.vel = { x: 0, y: -fx.state.ctx.direction * 5 };
      const intent = carryIntent(qb, fx.state, TICK_DT);
      if (ruleset === 'simulation') expect(intent.action).toBe('slide');
      else expect(intent.action).not.toBe('slide');
      // Behind the line a slide is just a volunteered sack: keep working instead.
      giveBallAt(fx.state, qb, { x: 0, y: -4 });
      place(lb, toField({ x: 0.3, y: -2.5 }, fx.state));
      lb.vel = { x: 0, y: -fx.state.ctx.direction * 5 };
      expect(carryIntent(qb, fx.state, TICK_DT).action).not.toBe('slide');
    }
  });

  it('a QB on a designed sneak keeps driving instead of sliding; loose in the second level he may slide', () => {
    const fx = fixture({ offensePlayId: 'goalLine-qbSneak', defensePlayId: '43-cover3-zone', seed: 4, ruleset: 'simulation', ballOn: 14 });
    const qb = fx.byRole('offense', 'QB');
    const lb = fx.byRole('defense', 'MLB');
    giveBallAt(fx.state, qb, { x: 0, y: 2 });
    place(lb, toField({ x: 0.3, y: 3.5 }, fx.state));
    lb.vel = { x: 0, y: -fx.state.ctx.direction * 5 };
    expect(carryIntent(qb, fx.state, TICK_DT).action).not.toBe('slide');
    giveBallAt(fx.state, qb, { x: 0, y: 14 });
    place(lb, toField({ x: 0.3, y: 15.5 }, fx.state));
    lb.vel = { x: 0, y: -fx.state.ctx.direction * 5 };
    expect(carryIntent(qb, fx.state, TICK_DT).action).toBe('slide');
  });

  it('sprints in the open field and lane scores prefer open grass over a wall of defenders', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 5 });
    const rb = fx.byRole('offense', 'RB');
    giveBallAt(fx.state, rb, { x: 0, y: 15 });
    for (const d of fx.state.athletes) if (d.side === 'defense') place(d, toField({ x: -20, y: 30 }, fx.state));
    expect(carryIntent(rb, fx.state, TICK_DT).sprint).toBe(true);
    // Wall on the left: the best lane bends right.
    for (const [i, d] of fx.state.athletes.filter((a) => a.side === 'defense').entries()) place(d, toField({ x: -6 + i * 0.8, y: 19 }, fx.state));
    const lanes = evaluateLanes(rb, fx.state, null, 0);
    const local = toLocal({ x: rb.pos.x + lanes[0]!.dir.x * 5, y: rb.pos.y + lanes[0]!.dir.y * 5 }, fx.state);
    expect(local.x).toBeGreaterThan(0.5);
    expect(lanes[0]!.score).toBeGreaterThan(lanes[lanes.length - 1]!.score);
  });

  it('the designed carrier runs to the mesh before the handoff and never leaves the field', () => {
    const fx = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    const rb = fx.byRole('offense', 'RB');
    let early = '';
    runSim(fx, { seconds: 0.4, idleRoles: ['QB'], onTick: (_s, t) => { if (t > 0.1 && !early) early = rb.ai.decision; } });
    expect(early).toBe('to mesh');
    expect(rb.pos.x).toBeGreaterThan(0);
    expect(rb.pos.x).toBeLessThan(FIELD_WIDTH);
  });
});
