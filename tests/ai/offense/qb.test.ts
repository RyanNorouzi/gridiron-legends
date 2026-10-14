import { describe, expect, it } from 'vitest';
import { dist } from '@/core/vec2';
import { dropbackDepth, rollCadence } from '@/ai/qb';
import { toField } from '@/ai/route-running';
import { fixture, gluePolicy, manCoverPolicy, place, runSim, rushPolicy, snapNow } from './sim';

describe('qb decider', () => {
  it('snaps within the cadence window against a base look', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed });
      const res = runSim(fx, { seconds: 3, autoSnap: false, until: (s) => s.phase === 'live' });
      const snap = res.events.find((e) => e.action === 'snap');
      expect(snap, `seed ${seed}`).toBeDefined();
      const t = snap!.tick / 60;
      expect(t).toBeGreaterThanOrEqual(0.6);
      expect(t).toBeLessThanOrEqual(1.4);
      expect(res.events.some((e) => e.action === 'audible')).toBe(false);
      expect(fx.state.phase).toBe('live');
    }
  });

  it('rolls a shorter cadence in a hurry-up and on kneel/spike plays', () => {
    const fx = fixture({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover1-man', seed: 2 });
    fx.state.ctx.clockRemaining = 90;
    fx.state.ctx.scoreDiff = -3;
    const qb = fx.byRole('offense', 'QB');
    for (let i = 0; i < 10; i++) expect(rollCadence(qb, fx.state)).toBeLessThanOrEqual(0.7);
    const kneel = fixture({ offensePlayId: 'iform-kneel', seed: 2 });
    for (let i = 0; i < 10; i++) expect(rollCadence(kneel.byRole('offense', 'QB'), kneel.state)).toBeLessThanOrEqual(0.5);
    const normal = fixture({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover1-man', seed: 2 });
    const values = Array.from({ length: 20 }, () => rollCadence(normal.byRole('offense', 'QB'), normal.state));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...values)).toBeLessThanOrEqual(1.4);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.1);
  });

  it('kneels on a kneel play and spikes on a spike play', () => {
    const kneel = fixture({ offensePlayId: 'iform-kneel', seed: 3 });
    const kr = runSim(kneel, { seconds: 3, autoSnap: false });
    const snap = kr.events.find((e) => e.action === 'snap')!;
    const kn = kr.events.find((e) => e.action === 'kneel')!;
    expect(snap.tick / 60).toBeLessThanOrEqual(0.5);
    expect(kn.time).toBeLessThanOrEqual(0.5);
    expect(kr.deadReason).toBe('kneel');
    const spike = fixture({ offensePlayId: 'singleback-spike', seed: 3 });
    const sr = runSim(spike, { seconds: 2 });
    const sp = sr.events.find((e) => e.action === 'spike')!;
    expect(sp.time).toBeLessThanOrEqual(0.05);
    expect(sp.throwType).toBe('throwAway');
    expect(sr.deadReason).toBe('spike');
  });

  it('a sharp QB audibles to the blitz beater against a blitz look', () => {
    let audibles = 0;
    for (const seed of [1, 2, 3, 4]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed, difficulty: 'legend' });
      const res = runSim(fx, { seconds: 3, autoSnap: false, until: (s) => s.phase === 'live' });
      const aud = res.events.find((e) => e.action === 'audible');
      if (aud) {
        audibles++;
        expect(aud.audible).toBe('blitzBeater');
        const snap = res.events.find((e) => e.action === 'snap')!;
        expect(snap.tick).toBeGreaterThan(aud.tick);
      }
    }
    expect(audibles).toBeGreaterThanOrEqual(2);
  });

  it('drops to the play depth and throws to the primary with a bullet or touch when nobody moves', () => {
    for (const seed of [1, 2, 3, 4]) {
      const fx = fixture({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover3-zone', seed });
      const qb = fx.byRole('offense', 'QB');
      // The defense stands still and nobody is parked on the primary's side.
      for (const role of ['CB2', 'OLB2', 'SS']) place(fx.byRole('defense', role), toField({ x: 20, y: 22 }, fx.state));
      const target = dropbackDepth(fx.offensivePlay, 5);
      let maxDepth = 0;
      const res = runSim(fx, { seconds: 4, onTick: (s) => { if (qb.hasBall) maxDepth = Math.max(maxDepth, -s.ctx.direction * (qb.pos.y - s.losY)); } });
      const t = res.events.find((e) => e.action === 'throw' || e.action === 'throwAway')!;
      expect(t.action).toBe('throw');
      expect(t.targetId).toBe('off:WR2');
      expect(['bullet', 'touch']).toContain(t.throwType);
      expect(maxDepth).toBeGreaterThanOrEqual(target - 1);
      expect(maxDepth).toBeLessThanOrEqual(target + 1.5);
      expect(fx.byRole('offense', 'WR2').hasBall).toBe(true);
    }
  });

  it('completes a seven-step drop before a deep throw', () => {
    const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const qb = fx.byRole('offense', 'QB');
    const target = dropbackDepth(fx.offensivePlay, 5);
    expect(target).toBe(9);
    let maxDepth = 0;
    const res = runSim(fx, { seconds: 4, onTick: (s) => { if (qb.hasBall) maxDepth = Math.max(maxDepth, -s.ctx.direction * (qb.pos.y - s.losY)); } });
    expect(res.events.some((e) => e.action === 'throw')).toBe(true);
    expect(maxDepth).toBeGreaterThanOrEqual(target - 1);
    expect(fx.state.intents['off:QB']).toBeDefined();
  });

  it('progresses to a later read when the primary is blanketed', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed });
      const res = runSim(fx, { seconds: 5, defense: gluePolicy({ SS: 'WR3' }) });
      const t = res.events.find((e) => e.action === 'throw' || e.action === 'throwAway');
      expect(t, `seed ${seed}`).toBeDefined();
      expect(t!.targetId).not.toBe('off:WR3');
      expect(t!.action).toBe('throw');
    }
    // A defender merely chasing the primary from depth is not a blanket: the QB may still take him.
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed: 1 });
    const res = runSim(fx, { seconds: 5, defense: manCoverPolicy({ SS: 'WR3', CB1: 'WR3' }) });
    expect(res.events.some((e) => e.action === 'throw')).toBe(true);
  });

  it('throws away or checks down quickly with an end in his lap', () => {
    for (const seed of [1, 2, 3]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed });
      const qb = fx.byRole('offense', 'QB');
      const de = fx.byRole('defense', 'DE1');
      place(de, { x: qb.pos.x - 1, y: qb.pos.y + 0.6 });
      const res = runSim(fx, { seconds: 4, defense: rushPolicy(['DE1']) });
      const first = res.events.find((e) => e.id === 'off:QB');
      expect(first, `seed ${seed}`).toBeDefined();
      expect(['throw', 'throwAway']).toContain(first!.action);
      expect(first!.time).toBeLessThanOrEqual(1.0);
      if (first!.action === 'throw') expect(first!.debug.startsWith('checkdown')).toBe(true);
    }
  });

  it('scrambles through an open side when everyone is blanketed and the rush comes from one edge', () => {
    const pairs: Record<string, string> = { CB1: 'WR1', CB2: 'WR2', SS: 'WR3', OLB2: 'TE1' };
    let scrambles = 0;
    let slides = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed });
      const qb = fx.byRole('offense', 'QB');
      qb.attrs.speed = 92;
      qb.attrs.agility = 92;
      fx.byRole('offense', 'RB').assignment = { type: 'passBlock' };
      let saw = false;
      const res = runSim(fx, {
        seconds: 5,
        defense: (a, state, dt) => (['DE1', 'DT1', 'OLB1'].includes(a.role) ? rushPolicy(['DE1', 'DT1', 'OLB1'], false)(a, state, dt) : gluePolicy(pairs)(a, state, dt)),
        onTick: () => { if (qb.ai.decision.startsWith('scramble')) saw = true; },
      });
      if (saw) scrambles++;
      if (res.events.some((e) => e.id === qb.id && e.action === 'slide')) slides++;
      expect(res.events.some((e) => e.id === qb.id && e.action === 'throw')).toBe(false);
    }
    expect(scrambles).toBeGreaterThanOrEqual(3);
    expect(slides).toBeGreaterThanOrEqual(1);
  });

  it('hands off at the mesh on a run play and pitches on a toss', () => {
    const dive = fixture({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    const r1 = runSim(dive, { seconds: 2 });
    const hand = r1.events.find((e) => e.action === 'handoff')!;
    expect(hand.targetId).toBe('off:RB');
    expect(hand.time).toBeLessThan(1.2);
    expect(dive.byRole('offense', 'RB').hasBall).toBe(true);
    const toss = fixture({ offensePlayId: 'iform-toss-right', defensePlayId: '43-runStop-cover1', seed: 1 });
    const r2 = runSim(toss, { seconds: 2.5 });
    const pitch = r2.events.find((e) => e.action === 'pitch')!;
    expect(pitch.targetId).toBe('off:RB');
    expect(pitch.time).toBeLessThan(0.5);
    expect(toss.byRole('offense', 'RB').hasBall).toBe(true);
  });

  it('fakes to the back before dropping on play action', () => {
    const fx = fixture({ offensePlayId: 'singleback-paPost', defensePlayId: '43-cover3-zone', seed: 2 });
    const qb = fx.byRole('offense', 'QB');
    const rb = fx.byRole('offense', 'RB');
    let minMesh = Infinity;
    let fakeSeen = false;
    const res = runSim(fx, { seconds: 4, onTick: (_s, t) => { if (t < 0.6) { minMesh = Math.min(minMesh, dist(qb.pos, rb.pos)); if (qb.ai.decision === 'play fake') fakeSeen = true; } } });
    expect(fakeSeen).toBe(true);
    expect(minMesh).toBeLessThan(2);
    expect(res.events.some((e) => e.action === 'handoff')).toBe(false);
    expect(res.events.some((e) => e.action === 'throw' || e.action === 'throwAway')).toBe(true);
  });

  it('waits for a shotgun snap in flight before doing anything else', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', seed: 1 });
    const state = fx.state;
    snapNow(state);
    const qb = fx.byRole('offense', 'QB');
    qb.hasBall = false;
    state.ball = { ...state.ball, phase: 'inAir', kind: 'snap', carrierId: null, targetId: qb.id, pos: { x: state.ctx.ballX, y: state.losY }, z: 1, vz: 2, vel: { x: 0, y: -state.ctx.direction * 12 } };
    const res = runSim(fx, { seconds: 0.2 });
    expect(res.last['off:QB']!.debug).toBe('catch snap');
    expect(res.events.filter((e) => e.id === 'off:QB')).toHaveLength(0);
  });

  it('throws the ball away out of bounds past the line when flushed outside the box with nobody open', () => {
    const pairs: Record<string, string> = { CB1: 'WR1', CB2: 'WR2', SS: 'WR3', OLB2: 'TE1', MLB: 'RB' };
    let aways = 0;
    for (const seed of [1, 2, 3, 4]) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed });
      const qb = fx.byRole('offense', 'QB');
      qb.attrs.speed = 40;
      qb.attrs.agility = 40;
      snapNow(fx.state);
      place(qb, { x: fx.state.snapX + 6, y: qb.pos.y });
      const de = fx.byRole('defense', 'DE1');
      place(de, { x: qb.pos.x - 1.2, y: qb.pos.y + fx.state.ctx.direction * 0.5 });
      const res = runSim(fx, {
        seconds: 3,
        defense: (a, state, dt) => (a.role === 'DE1' ? rushPolicy(['DE1'])(a, state, dt) : gluePolicy(pairs)(a, state, dt)),
      });
      const first = res.events.find((e) => e.id === qb.id && (e.action === 'throw' || e.action === 'throwAway'));
      if (!first || first.action !== 'throwAway') continue;
      aways++;
      expect(first.time).toBeLessThan(1.0);
      expect(first.throwType).toBe('throwAway');
      expect(res.deadReason).toBe('incomplete');
    }
    expect(aways).toBeGreaterThanOrEqual(2);
  });
});
