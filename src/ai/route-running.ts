import { clamp, clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { angle, angleDiff, dist, len, normalize, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { ballCarrier } from '@/game/athlete';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import type { Athlete, PlayState } from '@/game/play-types';
import type { RouteDef } from '@/playbook/types';
import { loadPlaybookData, resolveRoute, type PlaybookRegistry } from '@/playbook/loader';
import { fieldToLocal, localToField, routeBreakIndex, routePath } from '@/playbook/transform';
import { predictLanding, CATCH_HEIGHT } from '@/physics/ball';
import { interceptPoint } from '@/physics/collision';
import { DECEL_RATIO } from '@/physics/movement';
import { accelRate, maxSpeed } from '@/physics/speed';

/**
 * Route running for offensive receivers, plus the small steering/perception helpers every offensive decider
 * shares (the shared ai/movement layer is written in parallel; these local copies are deduped later).
 * Everything here returns intents only and never mutates positions or the ball.
 */

import { athleteNoise, f, jitter, noiseFor } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

let registry: PlaybookRegistry | null = null;

/** Lazily cached bundled playbook registry (routes are looked up by the ids the loader materialised). */
export const playbookRegistry = (): PlaybookRegistry => {
  if (!registry) registry = loadPlaybookData();
  return registry;
};

/** Concrete RouteDef for a materialised route id; throws a descriptive error for an unknown id. */
export const routeById = (id: string): RouteDef => {
  const r = playbookRegistry().routes[id];
  if (!r) throw new Error(`route-running: unknown route id '${id}'`);
  return r;
};

/**
 * The route id an offensive athlete runs: his assignment's route (or chip-release route), resolved to its mirrored
 * twin when the play asks for one (`mirror`: the same route run to the other side, e.g. a left slot's drag crossing
 * to the right). The playbook art draws the resolved route, so the receiver runs what the play diagram shows.
 */
export const assignedRouteId = (athlete: Pick<Athlete, 'assignment'>): string | undefined => {
  const a = athlete.assignment;
  if (a.type !== 'route' && a.type !== 'chipRelease') return undefined;
  const off = a as { route?: string; releaseRoute?: string; mirror?: boolean };
  const id = a.type === 'route' ? off.route : off.releaseRoute;
  if (!id || off.mirror !== true) return id;
  return resolveRoute(playbookRegistry().routes, id, true).id;
};

/** Seconds since the snap (0 before it). Uses snapTick when the engine set it, else the live play clock. */
export const timeSinceSnap = (state: PlayState): number =>
  state.phase !== 'live' ? 0 : state.snapTick >= 0 ? (state.tick - state.snapTick) * TICK_DT : state.playClock;

/** Deterministic personality noise / jitter and the rating factor: the shared src/ai/variance.ts helpers. */
export { athleteNoise, jitter, f };

/** 0..1 decision quality: even blend of a rating factor and a difficulty knob, nudged by personality. */
export const blendQuality = (athlete: Pick<Athlete, 'playerId' | 'attrs'>, difficultyParam: number, rating = athlete.attrs.awareness): number =>
  clamp01(0.5 * f(rating) + 0.5 * clamp01(difficultyParam) + jitter(athlete, 'quality', 0.05));

/** Active opponents of an athlete. */
export const opponentsOf = (athlete: Athlete, state: PlayState): Athlete[] => state.athletes.filter((a) => a.active && a.side !== athlete.side);

/** Active teammates of an athlete (excluding itself). */
export const teammatesOf = (athlete: Athlete, state: PlayState): Athlete[] =>
  state.athletes.filter((a) => a.active && a.side === athlete.side && a.id !== athlete.id);

/** Nearest athlete of a list to a point (null for an empty list). */
export const nearestTo = (athletes: readonly Athlete[], pos: Vec2): Athlete | null => {
  let best: Athlete | null = null;
  let bd = Infinity;
  for (const a of athletes) {
    const d = dist(a.pos, pos);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
};

/** True while the defender can still play (not on the ground). */
export const canPlay = (a: Athlete): boolean => a.active && a.state !== 'down' && a.state !== 'tackled';

/** Play-local coordinates of an absolute point for the current play. */
export const toLocal = (pos: Vec2, state: PlayState): Vec2 => fieldToLocal(pos, state.ctx.ballX, state.losY, state.ctx.direction);

/** Absolute coordinates of a play-local point for the current play. */
export const toField = (local: Vec2, state: PlayState): Vec2 => localToField(local, state.ctx.ballX, state.losY, state.ctx.direction);

/** Yards downfield of an absolute point (negative behind the LOS). */
export const depthOf = (pos: Vec2, state: PlayState): number => state.ctx.direction * (pos.y - state.losY);

/** Absolute y of the goal line the offense attacks. */
export const goalLineY = (state: PlayState): number => (state.ctx.direction === 1 ? FIELD_LENGTH - END_ZONE_DEPTH : END_ZONE_DEPTH);

/** Downfield unit vector for the offense. */
export const downfield = (state: PlayState): Vec2 => ({ x: 0, y: state.ctx.direction });

/** Facing angle that looks downfield. */
export const downfieldAngle = (state: PlayState): number => (state.ctx.direction === 1 ? Math.PI / 2 : -Math.PI / 2);

/** Keep an x coordinate inside the field by `margin` yards. */
export const clampX = (x: number, margin = 0.3): number => clamp(x, margin, FIELD_WIDTH - margin);

/** Intent that moves from `from` toward `to` at `effort` (0..1). Stops when already there. */
export const steerTo = (from: Vec2, to: Vec2, effort = 1, sprint = false, debug = 'move'): AthleteIntent => {
  const d = sub(to, from);
  const l = len(d);
  const intent = idleIntent(debug);
  if (l < 0.05) return intent;
  intent.move = scale(d, clamp01(effort) / l);
  intent.sprint = sprint;
  return intent;
};

/** Like steerTo but eases off inside `slowRadius` so the athlete arrives instead of overshooting. */
export const arriveAt = (from: Vec2, to: Vec2, slowRadius: number, effort = 1, sprint = false, debug = 'arrive'): AthleteIntent => {
  const d = dist(from, to);
  const e = d < slowRadius ? effort * clamp(d / slowRadius, 0.25, 1) : effort;
  return steerTo(from, to, e, sprint && d >= slowRadius, debug);
};

/** The offensive quarterback athlete (assignment type 'qb'), if on the field. */
export const findQb = (state: PlayState): Athlete | null => state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb') ?? null;

/** True when the QB has left the pocket with the ball (engine state or the QB decider's own flag). */
export const isQbScrambling = (state: PlayState): boolean => {
  const qb = findQb(state);
  if (!qb || !qb.hasBall) return false;
  if (qb.state === 'scrambling' || qb.ai.scratch.scrambling === 1) return true;
  return timeSinceSnap(state) > 2.8 && Math.abs(qb.pos.x - state.snapX) > 4.5;
};

/**
 * Every offensive decider calls this first: a loose ball (fumble, tipped pass) is chased and dived on, and a
 * ball held by the other side is pursued with a tackle. Returns null when the ball is ours or in a normal pass.
 */
export const chaseBallIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  const ball = state.ball;
  if (ball.phase === 'dead' || ball.phase === 'presnap') return null;
  const speed = maxSpeed(athlete.attrs.speed) * (0.85 + 0.15 * f(athlete.attrs.pursuit));
  if (ball.phase === 'loose' || (ball.phase === 'inAir' && (ball.isTipped || ball.kind === 'tip' || ball.kind === 'fumble'))) {
    const airborne = ball.z > 0.05 || ball.vz > 0;
    const target = airborne ? predictLanding(ball, state.ctx.weather, CATCH_HEIGHT).pos : { x: ball.pos.x + ball.vel.x * 0.3, y: ball.pos.y + ball.vel.y * 0.3 };
    const d = dist(athlete.pos, target);
    const intent = steerTo(athlete.pos, target, 1, d > 2, 'chase ball');
    if (d <= 1.3 && ball.z < 0.7) intent.action = 'dive';
    return intent;
  }
  const carrier = ballCarrier(state);
  if (carrier && carrier.side !== athlete.side && carrier.active) {
    const ip = interceptPoint({ pos: athlete.pos, speed }, { pos: carrier.pos, vel: carrier.vel });
    const target = ip ? ip.pos : carrier.pos;
    const d = dist(athlete.pos, carrier.pos);
    const intent = steerTo(athlete.pos, target, 1, d > 2, 'pursue carrier');
    if (d <= 1.5) {
      intent.action = 'tackle';
      intent.targetId = carrier.id;
    }
    return intent;
  }
  return null;
};

/* ------------------------------ Route running ------------------------------ */

/** Play-local alignment of the receiver, captured on the first call and kept in ai.scratch for the play. */
export const routeAlignment = (athlete: Athlete, state: PlayState): Vec2 => {
  const sc = athlete.ai.scratch;
  if (sc.alignSet !== 1) {
    const local = toLocal(athlete.pos, state);
    sc.alignX = local.x;
    sc.alignY = local.y;
    sc.alignSet = 1;
  }
  return { x: sc.alignX ?? 0, y: sc.alignY ?? 0 };
};

/** Absolute waypoints of a route for this receiver. */
export const routeWaypoints = (athlete: Athlete, state: PlayState, route: RouteDef): Vec2[] =>
  routePath(route, routeAlignment(athlete, state), state.ctx.ballX, state.losY, state.ctx.direction);

/** True once the receiver has passed the route's primary break. */
export const isPastBreak = (athlete: Athlete, route: RouteDef): boolean => athlete.ai.routeIndex > routeBreakIndex(route);

/**
 * A waypoint counts as reached inside `arriveR` or once the receiver has crossed the plane through it that is
 * perpendicular to the incoming segment (so a fast runner with a wide turning circle never orbits a point).
 */
const passedWaypoint = (pos: Vec2, wps: readonly Vec2[], i: number, start: Vec2, arriveR: number): boolean => {
  const wp = wps[i] as Vec2;
  if (dist(pos, wp) <= arriveR) return true;
  const prev = i > 0 ? (wps[i - 1] as Vec2) : start;
  const seg = sub(wp, prev);
  const l = len(seg);
  if (l < 1e-6) return true;
  const progress = ((pos.x - wp.x) * seg.x + (pos.y - wp.y) * seg.y) / l;
  return progress >= -0.15 && dist(pos, wp) <= 2.2;
};

/** Remaining path length from `pos` through waypoints[i..upTo]. */
const pathRemaining = (pos: Vec2, wps: readonly Vec2[], i: number, upTo: number): number => {
  let total = dist(pos, wps[i] as Vec2);
  for (let k = i; k < upTo; k++) total += dist(wps[k] as Vec2, wps[k + 1] as Vec2);
  return total;
};

/**
 * Soft spot near `base`: pushed away from nearby defenders (zone holes), never more than `maxDrift` yards.
 * A defender standing on the base itself pushes along `fallback` (default: toward the offense's own end).
 */
export const softSpot = (base: Vec2, defenders: readonly Athlete[], maxDrift: number, fallback: Vec2 = { x: 0, y: -1 }): Vec2 => {
  let px = 0;
  let py = 0;
  for (const d of defenders) {
    let dx = base.x - d.pos.x;
    let dy = base.y - d.pos.y;
    let dd = Math.hypot(dx, dy);
    if (dd > 7) continue;
    if (dd < 0.3) {
      const fl = Math.hypot(fallback.x, fallback.y) || 1;
      dx = fallback.x / fl;
      dy = fallback.y / fl;
      dd = 1;
    }
    const w = 6 / Math.max(0.25, dd * dd);
    px += (dx / dd) * w;
    py += (dy / dd) * w;
  }
  const l = Math.hypot(px, py);
  if (l > maxDrift) { px *= maxDrift / l; py *= maxDrift / l; }
  return { x: clampX(base.x + px, 1), y: base.y + py };
};

/** Yards needed to stop from the current speed (planting decelerates at DECEL_RATIO x the acceleration rate). */
const stoppingDistance = (athlete: Athlete): number => {
  const v = len(athlete.vel);
  return (v * v) / (2 * DECEL_RATIO * accelRate(athlete.attrs.acceleration));
};

const settleIntent = (athlete: Athlete, spot: Vec2, qb: Athlete | null, debug: string): AthleteIntent => {
  const d = dist(athlete.pos, spot);
  const toSpot = sub(spot, athlete.pos);
  const speed = len(athlete.vel);
  // A runner cannot reverse instantly: when the spot is behind him, plant (zero move) instead of steering back.
  if (d > 0.45 && (speed < 1.5 || athlete.vel.x * toSpot.x + athlete.vel.y * toSpot.y > 0)) return arriveAt(athlete.pos, spot, 1.5, 0.75, false, debug);
  const intent = idleIntent(debug);
  intent.locomotion = 'strafe';
  intent.face = qb ? angle(sub(qb.pos, athlete.pos)) : athlete.facing;
  return intent;
};

/** A defender within this many yards who is running with the receiver reads as man coverage. */
export const MAN_READ_RANGE = 3;
/** Yards a receiver works away from a man defender after his route before settling again. */
export const BREAK_AWAY_YARDS = 5;

/** Seconds a defender must have stayed with the receiver through his route before the receiver reads it as man. */
export const MAN_SHADOW_SECONDS = 0.8;
/** ai.scratch keys of the shadow tracker: the defender (index in state.athletes) and how long he has stayed with him. */
export const SHADOW_OF_KEY = 'shadowOf';
export const SHADOW_T_KEY = 'shadowT';

const movingTogether = (a: Athlete, d: Athlete, cos: number): boolean => {
  const sa = len(a.vel);
  const sd = len(d.vel);
  return sa > 1.5 && sd > 1.5 && (d.vel.x * a.vel.x + d.vel.y * a.vel.y) / (sa * sd) > cos;
};

/**
 * Keeps, tick by tick during the route, how long the nearest defender has stayed with the receiver (within
 * MAN_READ_RANGE + 1 and moving with him; a beat out of phase at a break only wears it down, a different defender
 * starts it over). A man defender builds it through the whole route; a zone defender carries him briefly, then sits
 * or passes him on.
 */
export const trackShadow = (athlete: Athlete, state: PlayState, dt: number): void => {
  const sc = athlete.ai.scratch;
  let near: Athlete | null = null;
  let bd = MAN_READ_RANGE + 1;
  for (const d of state.athletes) {
    if (d.side === athlete.side || !canPlay(d)) continue;
    const dd = dist(d.pos, athlete.pos);
    if (dd < bd) { bd = dd; near = d; }
  }
  if (!near) { sc[SHADOW_T_KEY] = 0; return; }
  const idx = state.athletes.indexOf(near);
  const together = movingTogether(athlete, near, 0.5);
  if (sc[SHADOW_OF_KEY] !== idx) {
    sc[SHADOW_OF_KEY] = idx;
    sc[SHADOW_T_KEY] = together ? dt : 0;
  } else sc[SHADOW_T_KEY] = together ? (sc[SHADOW_T_KEY] ?? 0) + dt : Math.max(0, (sc[SHADOW_T_KEY] ?? 0) - dt);
};

/**
 * The receiver's read of the coverage on him as his route ends: a defender who has stayed with him through the route
 * (trackShadow: at least MAN_SHADOW_SECONDS in his hip pocket moving with him) and is still on him is man; nobody
 * there, a defender sitting, or one who only picked him up in passing (a zone carry) is zone. Reading it right is a decision: awareness blended with the difficulty's receiverIntelligence,
 * rolled from a hash of the play seed (no die). A misread receiver treats man as zone and sits down on his defender.
 */
export const readCoverage = (athlete: Athlete, state: PlayState, defenders: readonly Athlete[]): { read: 'man' | 'zone'; defender: Athlete | null } => {
  const sc = athlete.ai.scratch;
  const shadow = state.athletes[sc[SHADOW_OF_KEY] ?? -1];
  // The man who stayed with him through the route, still on him (a break buys a step or two of cushion).
  const trailer = shadow && defenders.includes(shadow) && (sc[SHADOW_T_KEY] ?? 0) >= MAN_SHADOW_SECONDS
    && dist(shadow.pos, athlete.pos) < MAN_READ_RANGE + 1.5 ? shadow : null;
  if (!trailer) return { read: 'zone', defender: null };
  const q = blendQuality(athlete, difficultyFor(state, athlete).receiverIntelligence);
  return noiseFor(`${state.ctx.rng.seed}`, `wrread:${athlete.id}`) < q ? { read: 'man', defender: trailer } : { read: 'zone', defender: null };
};

/** After the route: sit in the zone window, or (read as man) keep working away from the defender first. */
const settleOrBreak = (athlete: Athlete, state: PlayState, base: Vec2, defenders: readonly Athlete[], qb: Athlete | null, label: string): AthleteIntent => {
  const sc = athlete.ai.scratch;
  if (sc.covRead === undefined) {
    const r = readCoverage(athlete, state, defenders);
    sc.covRead = r.read === 'man' ? 1 : 0;
    if (r.defender) {
      // Break across, away from the defender's leverage and toward the middle of the field when he is square.
      const away = Math.sign(athlete.pos.x - r.defender.pos.x) || (athlete.pos.x < MIDDLE_X ? 1 : -1);
      sc.breakX = clampX(athlete.pos.x + away * BREAK_AWAY_YARDS, 2);
      sc.breakY = athlete.pos.y;
    }
  }
  if (sc.covRead === 1 && sc.breakX !== undefined && sc.broke !== 1) {
    const target = { x: sc.breakX, y: sc.breakY ?? athlete.pos.y };
    if (dist(athlete.pos, target) > 0.8) return steerTo(athlete.pos, target, 1, true, `${label}: break away (man)`);
    sc.broke = 1;
  }
  const spot = sc.broke === 1 && sc.breakX !== undefined ? { x: sc.breakX, y: sc.breakY ?? athlete.pos.y } : base;
  return settleIntent(athlete, softSpot(spot, defenders, 2.5, { x: 0, y: -state.ctx.direction }), qb, `${label}${sc.covRead === 1 ? ' (after break)' : ' (zone window)'}`);
};

/** Yards from the sideline at which a receiver still crossing the field turns upfield along it. */
export const BOUNDARY_TURN_YARDS = 6;

/** Improvisation once the last waypoint is behind the receiver (or the QB is scrambling). */
const afterRoute = (athlete: Athlete, state: PlayState, route: RouteDef, wps: readonly Vec2[], qbScrambling: boolean): AthleteIntent => {
  const qb = findQb(state);
  const defenders = opponentsOf(athlete, state).filter(canPlay);
  const end = wps[wps.length - 1] as Vec2;
  const back = { x: 0, y: -state.ctx.direction };
  if (qbScrambling && qb) {
    // Scramble drill: work to the QB's side of the field at the current depth and find grass.
    const sideSign = Math.sign(qb.pos.x - state.snapX) || (athlete.pos.x >= MIDDLE_X ? 1 : -1);
    const spread = 6 + 8 * athleteNoise(athlete, 'drill');
    const base = { x: clampX(MIDDLE_X + sideSign * spread, 2), y: athlete.pos.y };
    const spot = softSpot(base, defenders, 3, back);
    return dist(athlete.pos, spot) > 1 ? steerTo(athlete.pos, spot, 0.9, false, 'scramble drill') : settleIntent(athlete, spot, qb, 'scramble drill');
  }
  const tooFar = qb ? dist(athlete.pos, qb.pos) > 45 : false;
  switch (route.scramble) {
    case 'continue': {
      if (tooFar) return settleIntent(athlete, softSpot(athlete.pos, defenders, 2, back), qb, 'settle (range)');
      const prev = wps.length >= 2 ? (wps[wps.length - 2] as Vec2) : athlete.pos;
      const seg = sub(end, prev);
      let dir = len(seg) > 0.1 ? normalize(seg) : downfield(state);
      // A crosser running out of field turns up the boundary instead of running himself out of bounds.
      const sideRoom = dir.x > 0 ? FIELD_WIDTH - athlete.pos.x : athlete.pos.x;
      if (Math.abs(dir.x) > 0.5 && sideRoom < BOUNDARY_TURN_YARDS) dir = normalize({ x: dir.x * 0.2, y: downfield(state).y });
      const goal = goalLineY(state);
      const backLine = goal + state.ctx.direction * (END_ZONE_DEPTH - 1);
      const target = { x: clampX(athlete.pos.x + dir.x * 5, 2.5), y: athlete.pos.y + dir.y * 5 };
      if (state.ctx.direction * (target.y - backLine) > 0) return settleIntent(athlete, { x: target.x, y: backLine }, qb, 'end line');
      return steerTo(athlete.pos, target, 1, true, `continue ${route.type}`);
    }
    case 'comeBack': {
      if (!qb) return settleIntent(athlete, softSpot(end, defenders, 2.5, back), null, 'settle');
      const toQb = sub(qb.pos, athlete.pos);
      const stop = stoppingDistance(athlete) + 0.5;
      const depth = depthOf(athlete.pos, state);
      if (athlete.ai.scratch.settled === 1 || len(toQb) - stop < 6 || depth - stop <= 1.5) {
        athlete.ai.scratch.settled = 1;
        if (athlete.ai.scratch.settleX === undefined) {
          const spot = softSpot(athlete.pos, defenders, 2, { x: 0, y: state.ctx.direction });
          athlete.ai.scratch.settleX = spot.x;
          athlete.ai.scratch.settleY = spot.y + state.ctx.direction * Math.max(0, 1.5 - depthOf(spot, state));
        }
        return settleIntent(athlete, { x: athlete.ai.scratch.settleX, y: athlete.ai.scratch.settleY ?? athlete.pos.y }, qb, 'come back (settled)');
      }
      const step = scale(normalize(toQb), 4);
      return steerTo(athlete.pos, { x: athlete.pos.x + step.x, y: athlete.pos.y + step.y }, 0.85, false, 'come back');
    }
    case 'settle':
    default:
      return settleOrBreak(athlete, state, end, defenders, qb, `settle ${route.type}`);
  }
};

/** Release against press: within the first 1.5 yd a defender in the receiver's face slows him and forces a side step. */
const applyRelease = (athlete: Athlete, state: PlayState, move: Vec2, distFromAlign: number): { move: Vec2; effort: number } => {
  if (distFromAlign > 1.5) return { move, effort: 1 };
  const dirV = normalize(move);
  let presser: Athlete | null = null;
  let pd = 1.7;
  for (const d of opponentsOf(athlete, state)) {
    if (!canPlay(d)) continue;
    const rel = sub(d.pos, athlete.pos);
    const dd = len(rel);
    if (dd < pd && dd > 1e-6 && (rel.x * dirV.x + rel.y * dirV.y) / dd > 0.2) { presser = d; pd = dd; }
  }
  if (!presser) return { move, effort: 1 };
  const edge = f(athlete.attrs.release) - 0.5 * f(presser.attrs.coverage) - 0.5 * f(presser.attrs.strength);
  const effort = clamp(0.6 + 0.5 * edge, 0.35, 1);
  const rel = sub(presser.pos, athlete.pos);
  const side = rel.x * dirV.y - rel.y * dirV.x > 0 ? -1 : 1;
  const perp = { x: -dirV.y * side, y: dirV.x * side };
  const w = 0.75 - 0.35 * f(athlete.attrs.release);
  return { move: normalize({ x: dirV.x + perp.x * w, y: dirV.y + perp.y * w }), effort };
};

export interface RunRouteOptions {
  /** The QB has left the pocket: run the scramble drill instead of the route's improvisation. */
  qbScrambling?: boolean;
}

/**
 * Follow a route's waypoints: speed multipliers, timing to hit the break near `route.breakTime` (throttle when
 * early, sprint when late), cuts that scrub speed by the turn angle (route running keeps more of it and turns
 * tighter), a release contest against press within the first 1.5 yd, then the route's scramble rule.
 * Keeps ai.routeIndex / ai.routeTimer and ai.scratch.breakAt (seconds when the break was reached).
 */
export const runRoute = (athlete: Athlete, state: PlayState, dt: number, route: RouteDef, opts: RunRouteOptions = {}): AthleteIntent => {
  const ai = athlete.ai;
  ai.routeTimer += dt;
  trackShadow(athlete, state, dt);
  const wps = routeWaypoints(athlete, state, route);
  if (wps.length === 0) return idleIntent('no route');
  const breakIdx = routeBreakIndex(route);
  const rr = f(athlete.attrs.routeRunning);
  const arriveR = 0.9 - 0.45 * rr;
  const start = toField(routeAlignment(athlete, state), state);
  while (ai.routeIndex < wps.length && passedWaypoint(athlete.pos, wps, ai.routeIndex, start, arriveR)) {
    if (ai.routeIndex === breakIdx) ai.scratch.breakAt = ai.routeTimer;
    ai.routeIndex++;
  }
  if (ai.routeIndex >= wps.length) return afterRoute(athlete, state, route, wps, opts.qbScrambling === true);
  if (opts.qbScrambling && ai.routeTimer > 1.5) return afterRoute(athlete, state, route, wps, true);
  const i = ai.routeIndex;
  const target = wps[i] as Vec2;
  const toT = sub(target, athlete.pos);
  const d = len(toT);
  const top = maxSpeed(athlete.attrs.speed);
  let effort = route.waypoints[i]?.speed ?? 1;
  let sprint = false;
  if (i <= breakIdx) {
    const remaining = pathRemaining(athlete.pos, wps, i, breakIdx);
    const tLeft = route.breakTime - ai.routeTimer;
    if (tLeft > 0.05) {
      const need = remaining / tLeft;
      if (need < top * 0.8) effort = Math.min(effort, Math.max(0.6, need / top + 0.12));
      sprint = need > top * 0.75;
    } else sprint = remaining > 0.5;
  } else if (route.scramble === 'continue') sprint = true;
  let aim = target;
  if (i + 1 < wps.length && d < Math.max(1.6, (1 - rr) * 4)) {
    const next = wps[i + 1] as Vec2;
    const turn = Math.abs(angleDiff(angle(toT), angle(sub(next, target))));
    if (turn > 0.45) {
      if (d < 1.6) {
        effort *= 1 - (turn / Math.PI) * (1.4 - 0.8 * rr);
        sprint = false;
      }
      // Sloppy route runners round the corner off toward the next waypoint instead of planting on the break.
      const round = (1 - rr) * 4;
      if (d < round) {
        const k = 0.8 * (1 - d / round);
        aim = { x: target.x + (next.x - target.x) * k, y: target.y + (next.y - target.y) * k };
      }
    }
  }
  let move = normalize(sub(aim, athlete.pos));
  if (i === 0) {
    const fromAlign = dist(athlete.pos, toField(routeAlignment(athlete, state), state));
    const rel = applyRelease(athlete, state, move, fromAlign);
    move = rel.move;
    effort *= rel.effort;
  }
  const intent = idleIntent(`route ${route.type} #${i}`);
  intent.move = scale(move, clamp(effort, 0.2, 1));
  intent.sprint = sprint;
  return intent;
};
