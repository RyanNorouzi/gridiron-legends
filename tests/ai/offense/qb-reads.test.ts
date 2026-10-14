import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { readOrder } from '@/playbook/types';
import type { Athlete } from '@/game/play-types';
import {
  chooseThrowType, evaluateReceivers, pressureLevel, recognizeCoverage, scrambleLane, selectRead, throwAwayAllowed, throwAwayTarget,
  type ReceiverRead,
} from '@/ai/qb-reads';
import { toField } from '@/ai/route-running';
import { fixture, place, runSim, snapNow } from './sim';

const read = (athlete: Athlete, over: Partial<ReceiverRead>): ReceiverRead => ({
  athlete, id: athlete.id, role: athlete.role, order: 0, openness: 0.5, separation: 3, closingSpeed: 0, leverage: 0, laneBlocked: false,
  throwDifficulty: 0.3, distance: 10, expectedYards: 8, isPastBreak: true, timing: 1, isCheckdown: false, routeType: 'go',
  leadPoint: { ...athlete.pos }, nearestDefenderId: null, score: 0.5, ...over,
});

describe('qb reads', () => {
  it('evaluates every route runner in progression order and openness drops as a defender closes', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1 });
    runSim(fx, { seconds: 1.2, idleRoles: ['QB'] });
    const qb = fx.byRole('offense', 'QB');
    const reads = evaluateReceivers(qb, fx.state, readOrder(fx.offensivePlay));
    expect(reads.map((r) => r.role)).toEqual(['WR3', 'TE1', 'RB', 'WR1', 'WR2']);
    const wr2 = reads.find((r) => r.role === 'WR2')!;
    expect(wr2.openness).toBeGreaterThan(0.5);
    const cb = fx.byRole('defense', 'CB2');
    place(cb, { x: wr2.leadPoint.x, y: wr2.leadPoint.y });
    const tight = evaluateReceivers(qb, fx.state, ['WR2'])[0]!;
    expect(tight.openness).toBeLessThan(wr2.openness - 0.4);
    expect(tight.separation).toBeLessThan(1);
    expect(tight.nearestDefenderId).toBe(cb.id);
    expect(tight.throwDifficulty).toBeGreaterThan(wr2.throwDifficulty);
  });

  it('flags a defender sitting in the throwing lane of a short throw but not under a deep ball', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1 });
    runSim(fx, { seconds: 0.8, idleRoles: ['QB'] });
    const qb = fx.byRole('offense', 'QB');
    for (const d of fx.state.athletes) if (d.side === 'defense') place(d, toField({ x: -20, y: 30 }, fx.state));
    const clean = evaluateReceivers(qb, fx.state, ['TE1'])[0]!;
    expect(clean.laneBlocked).toBe(false);
    expect(clean.distance).toBeLessThan(15);
    const toLead = { x: clean.leadPoint.x - qb.pos.x, y: clean.leadPoint.y - qb.pos.y };
    const k = 3 / Math.hypot(toLead.x, toLead.y);
    place(fx.byRole('defense', 'MLB'), { x: qb.pos.x + toLead.x * k, y: qb.pos.y + toLead.y * k });
    const blocked = evaluateReceivers(qb, fx.state, ['TE1'])[0]!;
    expect(blocked.laneBlocked).toBe(true);
    expect(blocked.score).toBeLessThan(clean.score - 0.5);
    // A linebacker 6 yd out is under a deep ball, not in its lane.
    const wr2 = fx.byRole('offense', 'WR2');
    place(wr2, { x: qb.pos.x + 4, y: qb.pos.y + fx.state.ctx.direction * 28 });
    const deep = evaluateReceivers(qb, fx.state, ['WR2'])[0]!;
    expect(deep.distance).toBeGreaterThan(15);
    place(fx.byRole('defense', 'MLB'), { x: qb.pos.x + 4 * (6 / 28), y: qb.pos.y + fx.state.ctx.direction * 6 });
    expect(evaluateReceivers(qb, fx.state, ['WR2'])[0]!.laneBlocked).toBe(false);
  });

  it('coverage recognition unlocks sooner for an aware QB and reports the family', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed: 2 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    qb.attrs.awareness = 20;
    expect(recognizeCoverage(qb, fx.state).recognized).toBe(false);
    expect(recognizeCoverage(qb, fx.state).family).toBe('unknown');
    fx.state.tick += 60;
    expect(recognizeCoverage(qb, fx.state).recognized).toBe(true);
    expect(recognizeCoverage(qb, fx.state).family).toBe('man');
    const fx2 = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2 });
    snapNow(fx2.state);
    const sharp = fx2.byRole('offense', 'QB');
    sharp.attrs.awareness = 99;
    fx2.state.tick += 12;
    const cov = recognizeCoverage(sharp, fx2.state);
    expect(cov.recognized).toBe(true);
    expect(cov.blitz).toBe(true);
  });

  it('chooses throw types by distance, window and leverage', () => {
    const fx = fixture({ seed: 1 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    const wr = fx.byRole('offense', 'WR2');
    const cb = fx.byRole('defense', 'CB2');
    const none: Athlete[] = [];
    expect(chooseThrowType(qb, read(wr, { distance: 8 }), none, 8)).toBe('bullet');
    expect(chooseThrowType(qb, read(wr, { distance: 16, separation: 1.2, routeType: 'in' }), none, 16)).toBe('bullet');
    expect(chooseThrowType(qb, read(wr, { distance: 16, separation: 4, routeType: 'in' }), none, 16)).toBe('touch');
    const trailing = read(wr, { distance: 24, separation: 1.5, leverage: -0.8, routeType: 'go', nearestDefenderId: cb.id });
    expect(chooseThrowType(qb, trailing, [cb], 24)).toBe('backShoulder');
    wr.heightIn = cb.heightIn + 4;
    const tall = read(wr, { distance: 24, separation: 1.5, leverage: 0.5, routeType: 'go', nearestDefenderId: cb.id });
    expect(chooseThrowType(qb, tall, [cb], 24)).toBe('highPoint');
    const deep = read(wr, { distance: 34, separation: 5, routeType: 'go', nearestDefenderId: cb.id });
    expect(chooseThrowType(qb, deep, [cb], 34)).toBe('lob');
    expect(chooseThrowType(qb, read(wr, { distance: 34, routeType: 'dig' }), none, 34)).toBe('lob');
    // A defender underneath the lane on a short throw gets a touch pass over him.
    const under = fx.byRole('defense', 'MLB');
    place(wr, { x: qb.pos.x + 6, y: qb.pos.y + fx.state.ctx.direction * 8 });
    place(under, { x: qb.pos.x + 3, y: qb.pos.y + fx.state.ctx.direction * 4 });
    expect(chooseThrowType(qb, read(wr, { distance: 10, leadPoint: { ...wr.pos } }), [under], 10)).toBe('touch');
  });

  it('pressure rises with a rusher on top of the QB and reports the side', () => {
    const fx = fixture({ seed: 3 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    const calm = pressureLevel(qb, fx.state);
    expect(calm.level).toBeLessThan(0.3);
    const de = fx.byRole('defense', 'DE1');
    place(de, toField({ x: -1.5, y: -4.5 }, fx.state));
    expect(fx.byRole('offense', 'QB').pos.y).toBeCloseTo(toField({ x: 0, y: -5 }, fx.state).y, 5);
    de.vel = { x: (qb.pos.x - de.pos.x) * 4, y: (qb.pos.y - de.pos.y) * 4 };
    const hot = pressureLevel(qb, fx.state);
    expect(hot.level).toBeGreaterThan(0.7);
    expect(hot.nearest!.id).toBe(de.id);
    expect(hot.fromLeft).toBe(true);
    expect(hot.fromRight).toBe(false);
    expect(hot.timeToContact).toBeLessThan(0.6);
  });

  it('throw-aways are only allowed outside the tackle box and go out of bounds past the LOS', () => {
    const fx = fixture({ seed: 3 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    expect(throwAwayAllowed(qb, fx.state)).toBe(false);
    place(qb, { x: fx.state.snapX + 5, y: qb.pos.y });
    expect(throwAwayAllowed(qb, fx.state)).toBe(true);
    const t = throwAwayTarget(qb, fx.state);
    expect(t.x < 0 || t.x > 53).toBe(true);
    expect(fx.state.ctx.direction * (t.y - fx.state.losY)).toBeGreaterThan(0);
  });

  it('finds a scramble lane only when a side is clear', () => {
    const fx = fixture({ seed: 4 });
    snapNow(fx.state);
    const qb = fx.byRole('offense', 'QB');
    const defenders = fx.state.athletes.filter((a) => a.side === 'defense');
    defenders.forEach((d, i) => place(d, toField({ x: -6 + i * 1.1, y: -2 }, fx.state)));
    expect(scrambleLane(qb, fx.state)).toBeNull();
    defenders.forEach((d, i) => place(d, toField({ x: -12 + i * 0.8, y: -2 }, fx.state)));
    const lane = scrambleLane(qb, fx.state)!;
    expect(lane).not.toBeNull();
    expect(lane.clearance).toBeGreaterThanOrEqual(2.5);
    expect(lane.dir.x * fx.state.ctx.direction).toBeGreaterThan(0);
  });

  it('a legend QB finds the more open receiver more often than a rookie across 100 seeds', () => {
    const fx = fixture({ seed: 5 });
    const primary = read(fx.byRole('offense', 'WR3'), { order: 0, openness: 0.45, score: 0.35 });
    const open = read(fx.byRole('offense', 'WR1'), { order: 3, openness: 0.95, score: 0.85 });
    const reads = [primary, open];
    const count = (quality: number): number => {
      let n = 0;
      for (let seed = 1; seed <= 100; seed++) if (selectRead(reads, quality, createRng(seed), { threshold: 0.35, maxDifficulty: 0.8 })?.id === open.id) n++;
      return n;
    };
    const legend = count(0.95);
    const rookie = count(0.4);
    expect(legend).toBeGreaterThan(rookie + 25);
    expect(legend).toBeGreaterThanOrEqual(85);
    expect(rookie).toBeLessThanOrEqual(60);
    expect(selectRead(reads, 0.5, createRng(1), { threshold: 0.99, maxDifficulty: 0.8 })).toBeNull();
  });
});
