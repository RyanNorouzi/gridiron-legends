/**
 * Engine surrogate for the defensive AI tests: scripts the offense, asks the registered deciders for every
 * defender's intent, integrates movement/collisions/ball with the real physics helpers and advances the clock.
 * Deterministic: everything comes from the fixture's seed.
 */
import { TICK_DT } from '@/core/time';
import { dist, dot, len, sub, type Vec2 } from '@/core/vec2';
import { registerDefense } from '@/ai/defense';
import { decideIntent } from '@/ai/index';
import { idleIntent, moveIntent, type AthleteIntent } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { ThrowType } from '@/game/play-events';
import { followCarrier, handoffBall, holdBall, integrateBall, launchPass, throwBall } from '@/physics/ball';
import { findOverlaps, separate } from '@/physics/collision';
import { integrateMovement } from '@/physics/movement';
import { fieldToLocal, routePath } from '@/playbook/transform';
import { buildPlayState, type Fixture, type FixtureOptions } from '../../fixtures/play-state';

export type Script = (a: Athlete, state: PlayState) => AthleteIntent;
export type Scripts = Record<string, Script>;

/** Fresh fixture with the defensive deciders registered. */
export const setup = (o: FixtureOptions = {}): Fixture => {
  registerDefense();
  return buildPlayState(o);
};

/** Seconds since the snap. */
export const sinceSnap = (st: PlayState): number => (st.phase === 'live' ? (st.tick - st.snapTick) * TICK_DT : 0);

/** Snap the ball: the QB holds it and the play goes live. */
export const snap = (f: Fixture): void => {
  const st = f.state;
  const qb = f.byRole('offense', 'QB');
  st.phase = 'live';
  st.snapTick = st.tick;
  st.ball = holdBall(st.ball, qb.id, st.tick, 'snap');
  st.ball.pos = { x: qb.pos.x, y: qb.pos.y };
  qb.hasBall = true;
  for (const a of st.athletes) if (a.state === 'presnap') a.state = 'idle';
};

/** Runs the bundled route of a role at full effort along its waypoints. */
export const routeScript = (f: Fixture, role: string, effort = 1): Script => {
  const a = f.byRole('offense', role);
  const route = f.routes[role];
  if (!route) throw new Error(`no route for ${role}`);
  const st = f.state;
  const alignment = fieldToLocal(a.pos, st.ctx.ballX, st.losY, st.ctx.direction);
  const path = routePath(route, alignment, st.ctx.ballX, st.losY, st.ctx.direction);
  let idx = 0;
  /** A waypoint counts as reached when the runner is on it or has run past its plane along the segment. */
  const reached = (pos: Vec2, i: number): boolean => {
    const wp = path[i] as Vec2;
    if (dist(pos, wp) < 0.9) return true;
    const prev = i > 0 ? (path[i - 1] as Vec2) : a.pos;
    const seg = sub(wp, prev);
    return dot(sub(wp, pos), seg) < 0;
  };
  return (ath) => {
    while (idx < path.length && reached(ath.pos, idx)) idx++;
    const wp = path[idx];
    if (!wp) return idleIntent('route done');
    const d = sub(wp, ath.pos);
    const l = len(d) || 1;
    // Brake into sharp breaks (a receiver at full speed cannot turn on a dime).
    const speed = len(ath.vel);
    const sharp = speed > 3 && dot(ath.vel, d) / (speed * l) < 0.6;
    const e = sharp ? 0.35 : effort;
    return moveIntent({ x: (d.x / l) * e, y: (d.y / l) * e }, !sharp, `route ${role}`);
  };
};

/** Straight-line run through a list of points (carrier / scripted mover). */
export const pathScript = (points: Vec2[], effort = 1, sprint = true): Script => {
  let idx = 0;
  return (ath) => {
    while (idx < points.length && dist(ath.pos, points[idx] as Vec2) < 0.7) idx++;
    const wp = points[idx];
    if (!wp) return idleIntent('path done');
    const d = sub(wp, ath.pos);
    const l = len(d) || 1;
    return moveIntent({ x: (d.x / l) * effort, y: (d.y / l) * effort }, sprint, 'path');
  };
};

/** QB dropback of `depth` yards straight back from his alignment, then set. */
export const dropbackScript = (f: Fixture, depth: number): Script => {
  const qb = f.byRole('offense', 'QB');
  const dir = f.state.ctx.direction;
  const target = { x: qb.pos.x, y: qb.pos.y - dir * depth };
  return (ath) => {
    if (dist(ath.pos, target) < 0.4) {
      ath.state = 'idle';
      return idleIntent('set');
    }
    ath.state = 'dropback';
    const d = sub(target, ath.pos);
    const l = len(d) || 1;
    const i = moveIntent({ x: d.x / l, y: d.y / l }, false, 'dropback');
    i.locomotion = 'backpedal';
    i.face = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
    return i;
  };
};

export const stillScript: Script = () => idleIntent('hold');

export interface StepOptions {
  /** Complete the pass to its target when the ball arrives within 1.5 yd of him. */
  autoCatch?: boolean;
}

/** One fixed tick: intents (scripted offense, AI defense), movement, collisions, ball, clock. */
export const stepPlay = (f: Fixture, scripts: Scripts, opts: StepOptions = {}): void => {
  const st = f.state;
  const dt = TICK_DT;
  for (const a of st.athletes) {
    if (!a.active) continue;
    const script = scripts[a.id];
    const intent = script ? script(a, st) : a.side === 'defense' ? decideIntent(a, st, dt) : idleIntent('none');
    st.intents[a.id] = intent;
    integrateMovement(a, intent, dt, st.ctx.weather);
  }
  for (const o of findOverlaps(st.athletes)) separate(o.a, o.b, o.penetration, o.normal);
  const ball = st.ball;
  if (ball.phase === 'held') {
    const c = st.athletes.find((a) => a.id === ball.carrierId);
    if (c) followCarrier(ball, c);
  } else if (ball.phase === 'inAir' || ball.phase === 'loose') {
    integrateBall(ball, dt, st.ctx.weather, st.ctx.rng);
    if (opts.autoCatch && ball.phase === 'inAir' && st.tick >= ball.landingTick - 1) {
      const t = st.athletes.find((a) => a.id === ball.targetId);
      if (t && dist(t.pos, ball.pos) < 1.5) {
        st.ball = holdBall(ball, t.id, st.tick, 'pass');
        t.hasBall = true;
      }
    }
  }
  st.tick += 1;
  st.time += dt;
  if (st.phase === 'live') st.playClock = (st.tick - st.snapTick) * dt;
};

/** Advance `seconds` of play, calling `onTick` after each tick with the seconds since the snap. */
export const runFor = (f: Fixture, seconds: number, scripts: Scripts, opts: StepOptions = {}, onTick?: (st: PlayState, t: number) => void): void => {
  const n = Math.round(seconds / TICK_DT);
  for (let i = 0; i < n; i++) {
    stepPlay(f, scripts, opts);
    onTick?.(f.state, sinceSnap(f.state));
  }
};

/** Advance until `done(state)` holds or `maxSeconds` elapse; returns true when the predicate was met. */
export const runUntil = (f: Fixture, maxSeconds: number, scripts: Scripts, done: (st: PlayState) => boolean, opts: StepOptions = {}): boolean => {
  const n = Math.round(maxSeconds / TICK_DT);
  for (let i = 0; i < n; i++) {
    if (done(f.state)) return true;
    stepPlay(f, scripts, opts);
  }
  return done(f.state);
};

/** True once the athlete has come to a stop. */
export const settled = (a: Athlete): boolean => len(a.vel) < 0.5;

/** Put a pass in the air from the QB to a receiver, leading him by up to 0.3 s of his current velocity. */
export const throwTo = (f: Fixture, targetRole: string, throwType: ThrowType = 'bullet'): void => {
  const st = f.state;
  const qb = f.byRole('offense', 'QB');
  const t = f.byRole('offense', targetRole);
  const first = launchPass(qb.pos, t.pos, throwType, qb.attrs.throwPower);
  const leadTime = Math.min(first.flightTime, 0.3);
  const lead = { x: t.pos.x + t.vel.x * leadTime, y: t.pos.y + t.vel.y * leadTime };
  const launch = launchPass(qb.pos, lead, throwType, qb.attrs.throwPower);
  st.ball = throwBall(st.ball, qb, launch, { id: t.id, pos: lead }, throwType, st.tick);
  qb.hasBall = false;
  qb.state = 'idle';
};

/** Put a pass in the air toward an arbitrary point (no receiver). */
export const throwToPoint = (f: Fixture, point: Vec2, throwType: ThrowType = 'touch'): void => {
  const st = f.state;
  const qb = f.byRole('offense', 'QB');
  const launch = launchPass(qb.pos, point, throwType, qb.attrs.throwPower);
  st.ball = throwBall(st.ball, qb, launch, { id: null, pos: point }, throwType, st.tick);
  qb.hasBall = false;
};

/** Hand the ball from the QB to a back. */
export const handoff = (f: Fixture, toRole: string): void => {
  const st = f.state;
  const qb = f.byRole('offense', 'QB');
  const rb = f.byRole('offense', toRole);
  st.ball = handoffBall(st.ball, qb, rb, st.tick);
  qb.hasBall = false;
  rb.hasBall = true;
};

/** Set every attribute of an athlete (both base and effective) to `value` with overrides. */
export const setAttrs = (a: Athlete, value: number, overrides: Partial<Athlete['attrs']> = {}): void => {
  for (const k of Object.keys(a.attrs) as (keyof Athlete['attrs'])[]) {
    a.attrs[k] = value;
    a.baseAttrs[k] = value;
  }
  for (const [k, v] of Object.entries(overrides) as [keyof Athlete['attrs'], number][]) {
    a.attrs[k] = v;
    a.baseAttrs[k] = v;
  }
};

/** Local-frame position of an athlete (offense's right +x, downfield +y). */
export const localPos = (st: PlayState, a: Athlete): Vec2 => fieldToLocal(a.pos, st.ctx.ballX, st.losY, st.ctx.direction);
