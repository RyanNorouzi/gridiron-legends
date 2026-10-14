import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import { MIDDLE_X } from '@/game/types';
import type { PlayState } from '@/game/play-types';
import type { RouteDef } from '@/playbook/types';
import { integrateMovement } from '@/physics/movement';
import { routeBreakIndex } from '@/playbook/transform';
import { chaseBallIntent, routeById, routeWaypoints, runRoute, softSpot, timeSinceSnap } from '@/ai/route-running';
import { fixture, place, runSim, snapNow } from './sim';

interface RouteWatch { breakAt: number; minLast: number; ys: number[] }

/** Runs the play with an idle QB and records when each role first gets within 1 yd of its break. */
const watchRoutes = (seed: number, roles: readonly string[], seconds = 4, playId = 'shotgun-mesh'): { watch: Record<string, RouteWatch>; state: PlayState } => {
  const fx = fixture({ offensePlayId: playId, defensePlayId: '43-cover3-zone', seed });
  const watch: Record<string, RouteWatch> = {};
  for (const r of roles) watch[r] = { breakAt: -1, minLast: Infinity, ys: [] };
  runSim(fx, {
    seconds, idleRoles: ['QB'],
    onTick: (state, t) => {
      for (const r of roles) {
        const a = fx.byRole('offense', r);
        if (a.assignment.type !== 'route' || !a.assignment.route) continue;
        const route = routeById(a.assignment.route);
        const wps = routeWaypoints(a, state, route);
        const bp = wps[routeBreakIndex(route)]!;
        const w = watch[r]!;
        if (w.breakAt < 0 && dist(a.pos, bp) < 1) w.breakAt = t;
        w.minLast = Math.min(w.minLast, dist(a.pos, wps[wps.length - 1]!));
        w.ys.push(state.ctx.direction * (a.pos.y - state.losY));
      }
    },
  });
  return { watch, state: fx.state };
};

describe('route running', () => {
  it('receivers on shotgun-mesh reach their break within 0.5 s of the route breakTime', () => {
    for (const seed of [1, 2, 3]) {
      const { watch } = watchRoutes(seed, ['WR3', 'WR1', 'WR2', 'TE1']);
      for (const [role, routeId] of [['WR3', 'drag~m'], ['WR1', 'corner~m'], ['WR2', 'go'], ['TE1', 'drag']] as const) {
        const route = routeById(routeId);
        expect(watch[role]!.breakAt, `${role} ${routeId} seed ${seed}`).toBeGreaterThan(0);
        expect(Math.abs(watch[role]!.breakAt - route.breakTime), `${role} ${routeId} seed ${seed}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('a go route keeps going after its last waypoint and never turns back', () => {
    const { watch } = watchRoutes(2, ['WR2'], 4.5);
    const ys = watch.WR2!.ys;
    expect(ys[ys.length - 1]).toBeGreaterThan(28);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]! - 1e-6);
  });

  it('the drag passes within 1 yd of its last waypoint and the swing settles on its end point', () => {
    const { watch, state } = watchRoutes(3, ['WR3', 'RB']);
    expect(watch.WR3!.minLast).toBeLessThan(1);
    expect(watch.RB!.minLast).toBeLessThan(1);
    const rb = state.athletes.find((a) => a.id === 'off:RB')!;
    const wps = routeWaypoints(rb, state, routeById('swing'));
    expect(dist(rb.pos, wps[wps.length - 1]!)).toBeLessThan(1);
    expect(rb.ai.decision.startsWith('settle')).toBe(true);
  });

  it('settle finds the soft spot away from a defender parked on the route end', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3 });
    snapNow(fx.state);
    const rb = fx.byRole('offense', 'RB');
    const wps = routeWaypoints(rb, fx.state, routeById('swing'));
    const end = wps[wps.length - 1]!;
    const lb = fx.byRole('defense', 'OLB2');
    place(lb, end);
    runSim(fx, { seconds: 4, idleRoles: ['QB'] });
    expect(dist(rb.pos, lb.pos)).toBeGreaterThan(1.5);
    expect(dist(rb.pos, end)).toBeLessThan(3.5);
    expect(dist(softSpot(end, [lb], 2.5), end)).toBeCloseTo(2.5, 1);
  });

  it('comeBack works back toward the QB without crossing the line of scrimmage', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4 });
    const state = fx.state;
    snapNow(state);
    const wr = fx.byRole('offense', 'WR2');
    const qb = fx.byRole('offense', 'QB');
    const route: RouteDef = { id: 'test-comeback', type: 'curl', waypoints: [{ dx: 0, dy: 12, isBreak: true }], breakTime: 1.8, depth: 12, scramble: 'comeBack' };
    let atBreak = Infinity;
    for (let i = 0; i < 60 * 5; i++) {
      const intent = runRoute(wr, state, TICK_DT, route);
      integrateMovement(wr, intent, TICK_DT, state.ctx.weather);
      if (wr.ai.routeIndex >= 1 && atBreak === Infinity) atBreak = dist(wr.pos, qb.pos);
      state.tick++;
      state.time += TICK_DT;
    }
    expect(atBreak).toBeLessThan(Infinity);
    expect(dist(wr.pos, qb.pos)).toBeLessThan(atBreak - 3);
    expect(state.ctx.direction * (wr.pos.y - state.losY)).toBeGreaterThanOrEqual(0.5);
  });

  it('runs the scramble drill to the QB side when the QB leaves the pocket', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 5 });
    const state = fx.state;
    snapNow(state);
    const qb = fx.byRole('offense', 'QB');
    const wr = fx.byRole('offense', 'WR1');
    const startX = wr.pos.x;
    expect(startX).toBeLessThan(MIDDLE_X);
    place(qb, { x: state.snapX + 9, y: qb.pos.y });
    qb.ai.scratch.scrambling = 1;
    runSim(fx, { seconds: 4.5, idleRoles: ['QB'] });
    expect(wr.pos.x).toBeGreaterThan(startX + 8);
    expect(wr.pos.x).toBeGreaterThan(MIDDLE_X - 2);
    expect(wr.ai.decision).toContain('scramble drill');
  });

  it('release rating beats press coverage off the line', () => {
    const run = (release: number): number => {
      const fx = fixture({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover1-man', seed: 6 });
      const wr = fx.byRole('offense', 'WR2');
      const cb = fx.byRole('defense', 'CB2');
      wr.attrs.release = release;
      wr.baseAttrs.release = release;
      place(cb, { x: wr.pos.x, y: wr.pos.y + fx.state.ctx.direction * 1.0 });
      cb.attrs.coverage = 85;
      cb.attrs.strength = 80;
      runSim(fx, { seconds: 1.2, idleRoles: ['QB'] });
      return fx.state.ctx.direction * (wr.pos.y - fx.state.losY);
    };
    const strong = run(95);
    const weak = run(15);
    expect(strong).toBeGreaterThan(weak + 0.5);
    expect(weak).toBeGreaterThan(1.5);
  });

  it('route running rating tightens the cut: crisp runners plant on the break, sloppy ones round it off', () => {
    const run = (rr: number): number => {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 7 });
      const wr = fx.byRole('offense', 'WR1');
      wr.attrs.routeRunning = rr;
      wr.baseAttrs.routeRunning = rr;
      let closest = Infinity;
      runSim(fx, {
        seconds: 3, idleRoles: ['QB'],
        onTick: (state) => {
          const wps = routeWaypoints(wr, state, routeById('corner~m'));
          closest = Math.min(closest, dist(wr.pos, wps[0]!));
        },
      });
      return closest;
    };
    const crisp = run(95);
    const sloppy = run(20);
    expect(crisp).toBeLessThan(0.8);
    expect(sloppy).toBeGreaterThan(crisp + 0.25);
  });

  it('keeps routeIndex/routeTimer bookkeeping and records the break time', () => {
    const { state } = watchRoutes(1, ['WR3'], 2.5);
    const wr = state.athletes.find((a) => a.id === 'off:WR3')!;
    expect(wr.ai.routeTimer).toBeCloseTo(2.5, 1);
    expect(wr.ai.routeIndex).toBeGreaterThanOrEqual(2);
    expect(wr.ai.scratch.breakAt).toBeGreaterThan(1);
    expect(timeSinceSnap(state)).toBeCloseTo(2.5, 1);
  });

  it('chaseBallIntent pursues a loose ball and a defensive carrier, and is null for our own pass', () => {
    const fx = fixture({ seed: 1 });
    const state = fx.state;
    snapNow(state);
    const wr = fx.byRole('offense', 'WR2');
    state.ball = { ...state.ball, phase: 'loose', kind: 'fumble', carrierId: null, z: 0, vz: 0, pos: { x: wr.pos.x + 4, y: wr.pos.y }, vel: { x: 0, y: 0 } };
    fx.byRole('offense', 'QB').hasBall = false;
    const chase = chaseBallIntent(wr, state);
    expect(chase).not.toBeNull();
    expect(chase!.move.x).toBeGreaterThan(0.9);
    state.ball = { ...state.ball, pos: { x: wr.pos.x + 1, y: wr.pos.y } };
    expect(chaseBallIntent(wr, state)!.action).toBe('dive');
    const cb = fx.byRole('defense', 'CB2');
    place(cb, { x: wr.pos.x + 1.2, y: wr.pos.y });
    state.ball = { ...state.ball, phase: 'held', carrierId: cb.id, pos: { ...cb.pos } };
    cb.hasBall = true;
    const pursue = chaseBallIntent(wr, state)!;
    expect(pursue.action).toBe('tackle');
    expect(pursue.targetId).toBe(cb.id);
    cb.hasBall = false;
    state.ball = { ...state.ball, phase: 'inAir', kind: 'pass', carrierId: null, throwerId: 'off:QB', targetId: 'off:WR1', isTipped: false, z: 2, vz: 3 };
    expect(chaseBallIntent(wr, state)).toBeNull();
  });
});
