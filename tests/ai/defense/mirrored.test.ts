import { describe, expect, it } from 'vitest';
import { dist, dot, sub } from '@/core/vec2';
import { zoneDropPoint } from '@/playbook/zones';
import { depthOf, localX } from '@/ai/defense-shared';
import type { FixtureOptions } from '../../fixtures/play-state';
import { dropbackScript, handoff, pathScript, routeScript, runFor, setAttrs, setup, snap, stillScript, type Scripts } from './harness';

/**
 * Every scenario here attacks toward y = 0 (direction -1) from an off-centre hash so any play-local vs absolute
 * sign slip in the defensive deciders shows up. The behaviours mirror the direction +1 tests in the sibling files.
 */
const MIRROR: FixtureOptions = { direction: -1, ballX: 20, ballOn: 40 };

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

const OL = ['LT', 'LG', 'C', 'RG', 'RT'];
const benchLine = (f: ReturnType<typeof setup>): void => {
  for (const a of f.state.athletes) if (a.side === 'offense' && OL.includes(a.role)) a.active = false;
};

describe('defensive AI attacking toward y = 0', () => {
  it('press man stays within 2.5 yd of a go route for 3 s', () => {
    const f = setup({ ...MIRROR, offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover1-man', seed: 3 });
    expect(f.state.ctx.direction).toBe(-1);
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    setAttrs(wr, 80, { speed: 88, acceleration: 88, agility: 85, release: 80 });
    setAttrs(cb, 80, { speed: 88, acceleration: 88, agility: 85, coverage: 82, reaction: 80, awareness: 75 });
    runFor(f, 1.5, offenseStill(f));
    // Presnap the press corner walked up on the LOS side of his man.
    expect(dist(wr.pos, cb.pos)).toBeLessThan(2);
    expect(depthOf(f.state, cb.pos)).toBeGreaterThan(depthOf(f.state, wr.pos));
    const scripts = offenseStill(f);
    scripts[wr.id] = routeScript(f, 'WR1');
    scripts['off:QB'] = dropbackScript(f, 3);
    snap(f);
    let max = 0;
    runFor(f, 3, scripts, {}, () => { max = Math.max(max, dist(wr.pos, cb.pos)); });
    expect(max).toBeLessThanOrEqual(2.5);
    expect(depthOf(f.state, wr.pos)).toBeGreaterThan(15);
  });

  it('zone defenders drop to their landmarks and the deep third stays over the top', () => {
    const f = setup({ ...MIRROR, offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const st = f.state;
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    const mlb = f.byRole('defense', 'MLB');
    setAttrs(wr, 80, { speed: 92, acceleration: 90 });
    setAttrs(cb, 80, { speed: 86, acceleration: 86 });
    const scripts = offenseStill(f);
    scripts[wr.id] = routeScript(f, 'WR1');
    scripts['off:QB'] = dropbackScript(f, 7);
    snap(f);
    let mlbArrived = Infinity;
    let minGap = Infinity;
    runFor(f, 3.5, scripts, {}, (s, t) => {
      const zone = mlb.assignment.type === 'zone' ? mlb.assignment.zone : undefined;
      if (zone && mlbArrived === Infinity && dist(mlb.pos, zoneDropPoint(zone, s.losY, s.ctx.direction)) < 1.5) mlbArrived = t;
      minGap = Math.min(minGap, depthOf(s, cb.pos) - depthOf(s, wr.pos));
    });
    expect(mlbArrived).toBeLessThanOrEqual(1.5);
    expect(minGap).toBeGreaterThan(1);
    expect(depthOf(st, mlb.pos)).toBeGreaterThan(3);
  });

  it('contain rushes outside and the gap rusher reaches the quarterback depth', () => {
    const f = setup({ ...MIRROR, offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    benchLine(f);
    const qb = f.byRole('offense', 'QB');
    const de = f.byRole('defense', 'DE2');
    const gapRushers = [f.byRole('defense', 'DT1'), f.byRole('defense', 'DT2')];
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    let deWidest = 0;
    let reachedAt = Infinity;
    // No tackle system in this harness: the first man there shoves the passer back, so contact reach counts too.
    runFor(f, 3, scripts, {}, (s, t) => {
      if (t < 1.5) deWidest = Math.max(deWidest, Math.abs(localX(s, de.pos.x)));
      const there = gapRushers.some((dt) => depthOf(s, dt.pos) <= depthOf(s, qb.pos) + 0.5 || dist(dt.pos, qb.pos) <= dt.radius + qb.radius + 0.3);
      if (reachedAt === Infinity && there) reachedAt = t;
    });
    expect(deWidest).toBeGreaterThan(3.8);
    expect(reachedAt).toBeLessThan(3);
  });

  it('linebacker fills toward the back after a handoff and the spy mirrors the quarterback', () => {
    const f = setup({ ...MIRROR, offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    const st = f.state;
    const dir = st.ctx.direction;
    const rb = f.byRole('offense', 'RB');
    const mlb = f.byRole('defense', 'MLB');
    const scripts = offenseStill(f);
    scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 1.9, y: st.losY + dir * 1 }, { x: st.ctx.ballX + dir * 3, y: st.losY + dir * 15 }]);
    snap(f);
    handoff(f, 'RB');
    let filled = false;
    runFor(f, 1.2, scripts, {}, (s) => {
      const i = s.intents[mlb.id];
      if (i && i.debug.includes('on RB') && dot(i.move, sub(rb.pos, mlb.pos)) > 0) filled = true;
    });
    expect(filled).toBe(true);

    const g = setup({ ...MIRROR, offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover1-spy', seed: 3 });
    const gqb = g.byRole('offense', 'QB');
    const spy = g.byRole('defense', 'MLB');
    const gs = offenseStill(g);
    gs['off:QB'] = pathScript([{ x: gqb.pos.x + g.state.ctx.direction * 4.5, y: gqb.pos.y }], 0.5, false);
    snap(g);
    runFor(g, 2.2, gs);
    expect(Math.abs(spy.pos.x - gqb.pos.x)).toBeLessThan(2.5);
    expect(depthOf(g.state, spy.pos)).toBeGreaterThan(3);
    expect(depthOf(g.state, spy.pos)).toBeLessThan(7);
  });
});
