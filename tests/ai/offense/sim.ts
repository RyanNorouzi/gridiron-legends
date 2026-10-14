/**
 * Minimal tick harness for offensive AI tests: every tick each offensive athlete gets its intent from the
 * registered deciders, defenders follow a scripted policy, intents run through physics/movement, the ball
 * follows its carrier or flies, and a few engine actions (snap, handoff, pitch, throw, catch, dead-ball
 * actions, special-move states) are applied so decisions have consequences. Not the real engine.
 */
import { TICK_DT } from '@/core/time';
import { clone, dist, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentAction } from '@/game/engine-api';
import { findAthlete } from '@/game/athlete';
import type { Athlete, AthleteState, PlayState } from '@/game/play-types';
import type { DeadReason, ThrowType } from '@/game/play-events';
import { handoffBall, holdBall, integrateBall, launchPass, pitchBall, throwBall } from '@/physics/ball';
import { integrateMovement } from '@/physics/movement';
import { maxSpeed } from '@/physics/speed';
import { decideIntent } from '@/ai/index';
import { registerOffense } from '@/ai/offense';
import { buildPlayState, type Fixture, type FixtureOptions } from '../../fixtures/play-state';

export interface SimEvent {
  tick: number;
  time: number;
  id: string;
  action: IntentAction;
  targetId: string | null;
  throwType: ThrowType | null;
  audible: string | null;
  debug: string;
}

export type DefensePolicy = (athlete: Athlete, state: PlayState, dt: number) => AthleteIntent;

export interface SimOptions {
  seconds: number;
  /** Intents for defenders (default: stand still). */
  defense?: DefensePolicy;
  /** Called before each tick's decisions with the seconds since the snap. */
  onTick?: (state: PlayState, sinceSnap: number) => void;
  /** Stop early when true. */
  until?: (state: PlayState) => boolean;
  /** Snap immediately (default true). When false the QB's own cadence snaps the ball. */
  autoSnap?: boolean;
  /** Offensive roles that stand still instead of using their decider (e.g. a QB who never throws). */
  idleRoles?: readonly string[];
}

export interface SimResult {
  events: SimEvent[];
  /** Last intent per athlete id. */
  last: Record<string, AthleteIntent>;
  ticks: number;
  seconds: number;
  deadReason: DeadReason | null;
}

const MOVE_STATES: Partial<Record<IntentAction, AthleteState>> = {
  juke: 'juking', spin: 'spinning', stiffArm: 'stiffArming', hurdle: 'hurdling', truck: 'trucking', dive: 'diving', jump: 'jumping',
};

let registered = false;
/** Registers the offensive deciders once. */
export const ensureOffense = (): void => {
  if (!registered) { registerOffense(); registered = true; }
};

/** Builds a fixture with the offense registered. */
export const fixture = (opts: FixtureOptions = {}): Fixture => {
  ensureOffense();
  return buildPlayState(opts);
};

/** Puts the ball in the QB's hands and starts the live phase. */
export const snapNow = (state: PlayState): void => {
  const qb = state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb');
  if (!qb) throw new Error('sim: no QB');
  state.phase = 'live';
  state.snapTick = state.tick;
  state.snapX = state.ball.pos.x;
  state.playClock = 0;
  state.ball = { ...holdBall(state.ball, qb.id, state.tick, 'snap'), pos: clone(qb.pos) };
  qb.hasBall = true;
  for (const a of state.athletes) a.state = a.hasBall ? 'moving' : 'idle';
};

const giveBall = (state: PlayState, to: Athlete): void => {
  for (const a of state.athletes) a.hasBall = false;
  to.hasBall = true;
  state.ball = { ...holdBall(state.ball, to.id, state.tick, state.ball.kind), pos: clone(to.pos) };
};

/** Reads the phase through a function so TypeScript does not narrow it across the mutating action pass. */
const isDead = (state: PlayState): boolean => state.phase === 'dead';

const kill = (state: PlayState, reason: DeadReason): void => {
  state.phase = 'dead';
  state.deadReason = reason;
  state.deadSpot = clone(state.ball.pos);
  state.ball = { ...state.ball, phase: 'dead', vel: { x: 0, y: 0 }, vz: 0 };
};

const applyAction = (state: PlayState, a: Athlete, intent: AthleteIntent): void => {
  const action = intent.action;
  if (!action) return;
  const target = findAthlete(state, intent.targetId);
  switch (action) {
    case 'snap':
      if (state.phase === 'presnap') snapNow(state);
      break;
    case 'handoff':
      if (a.hasBall && target && dist(a.pos, target.pos) <= 1.6) {
        state.ball = { ...handoffBall(state.ball, a, target, state.tick), pos: clone(target.pos) };
        a.hasBall = false;
        target.hasBall = true;
      }
      break;
    case 'pitch':
      if (a.hasBall && target) {
        state.ball = pitchBall(state.ball, a, target, state.tick);
        a.hasBall = false;
      }
      break;
    case 'throw':
      if (a.hasBall && target) {
        const to = intent.throwTarget ?? target.pos;
        const type = intent.throwType ?? 'bullet';
        const launch = launchPass(a.pos, to, type, a.attrs.throwPower);
        state.ball = throwBall(state.ball, a, launch, { id: target.id, pos: to }, type, state.tick);
        a.hasBall = false;
      }
      break;
    case 'throwAway':
    case 'spike':
      if (a.hasBall) { a.hasBall = false; kill(state, action === 'spike' ? 'spike' : 'incomplete'); }
      break;
    case 'kneel':
      if (a.hasBall) kill(state, 'kneel');
      break;
    case 'slide':
      if (a.hasBall) kill(state, 'slide');
      break;
    default: {
      const st = MOVE_STATES[action];
      if (st && a.specialMoveCooldown <= 0) {
        a.state = st;
        a.stateTimer = 0.35;
        a.specialMoveCooldown = 1.5;
      }
    }
  }
};

const settleStates = (a: Athlete, dt: number): void => {
  a.specialMoveCooldown = Math.max(0, a.specialMoveCooldown - dt);
  if (a.stateTimer > 0) {
    a.stateTimer -= dt;
    if (a.stateTimer <= 0 && a.state !== 'idle' && a.state !== 'moving') a.state = 'moving';
  }
};

/** Runs the play for `seconds` (or until `until`), returning what the offense did. */
export const runSim = (fx: Fixture, opts: SimOptions): SimResult => {
  ensureOffense();
  const state = fx.state;
  const dt = TICK_DT;
  const events: SimEvent[] = [];
  const last: Record<string, AthleteIntent> = {};
  if (opts.autoSnap !== false && state.phase === 'presnap') snapNow(state);
  const n = Math.round(opts.seconds / dt);
  let ticks = 0;
  for (let i = 0; i < n; i++) {
    if (state.phase === 'dead') break;
    if (opts.until && opts.until(state)) break;
    const since = state.phase === 'live' ? (state.tick - state.snapTick) * dt : 0;
    opts.onTick?.(state, since);
    const intents = new Map<string, AthleteIntent>();
    for (const a of state.athletes) {
      if (!a.active) continue;
      const idle = a.side === 'offense' && opts.idleRoles?.includes(a.role);
      const intent = idle ? idleIntent('scripted idle') : a.side === 'offense' ? decideIntent(a, state, dt) : opts.defense ? opts.defense(a, state, dt) : idleIntent('def idle');
      intents.set(a.id, intent);
      state.intents[a.id] = intent;
      last[a.id] = intent;
      if (intent.action) events.push({ tick: state.tick, time: since, id: a.id, action: intent.action, targetId: intent.targetId, throwType: intent.throwType, audible: intent.audible, debug: intent.debug });
    }
    for (const a of state.athletes) {
      const intent = intents.get(a.id);
      if (intent) applyAction(state, a, intent);
    }
    if (isDead(state)) { ticks++; break; }
    for (const a of state.athletes) {
      if (!a.active) continue;
      const intent = intents.get(a.id) ?? idleIntent();
      if (state.phase === 'live' || a.side === 'defense') integrateMovement(a, intent, dt, state.ctx.weather);
      settleStates(a, dt);
    }
    const ball = state.ball;
    if (ball.phase === 'held' && ball.carrierId) {
      const c = findAthlete(state, ball.carrierId);
      if (c) { ball.pos.x = c.pos.x; ball.pos.y = c.pos.y; ball.vel = clone(c.vel); }
    } else if (ball.phase === 'inAir' || ball.phase === 'loose') {
      const res = integrateBall(ball, dt, state.ctx.weather, state.ctx.rng);
      const target = findAthlete(state, ball.targetId);
      if (ball.phase === 'inAir' && target && ball.z <= 2.4 && dist(target.pos, ball.pos) <= 1.2) {
        giveBall(state, target);
      } else if (res.hitGround && ball.kind === 'pass') kill(state, 'incomplete');
    }
    // Scripted tackles: a defender whose policy says 'tackle' within reach ends the play.
    for (const d of state.athletes) {
      if (d.side !== 'defense') continue;
      const intent = intents.get(d.id);
      const carrier = findAthlete(state, state.ball.carrierId);
      if (intent?.action === 'tackle' && carrier && carrier.side === 'offense' && dist(d.pos, carrier.pos) <= 1.0) kill(state, 'tackle');
    }
    state.tick++;
    state.time += dt;
    state.playClock = state.phase === 'live' ? (state.tick - state.snapTick) * dt : state.playClock - dt;
    ticks++;
  }
  return { events, last, ticks, seconds: ticks * dt, deadReason: state.deadReason };
};

/* ------------------------------ Defense policies ------------------------------ */

const moveTo = (a: Athlete, target: Vec2, sprint = true): AthleteIntent => {
  const d = dist(a.pos, target);
  const intent = idleIntent('def move');
  if (d < 0.1) return intent;
  intent.move = { x: (target.x - a.pos.x) / d, y: (target.y - a.pos.y) / d };
  intent.sprint = sprint;
  return intent;
};

/** Named defenders (by role) shadow named offensive roles; everyone else stands. */
export const manCoverPolicy = (pairs: Record<string, string>): DefensePolicy => (a, state) => {
  const role = pairs[a.role];
  if (!role) return idleIntent('def idle');
  const t = state.athletes.find((x) => x.side === 'offense' && x.role === role);
  if (!t) return idleIntent('def idle');
  const lead = { x: t.pos.x + t.vel.x * 0.15, y: t.pos.y + t.vel.y * 0.15 };
  return moveTo(a, lead);
};

/** Scripted blanket coverage: named defenders are kept glued to their receiver's hip, moving with him. */
export const gluePolicy = (pairs: Record<string, string>): DefensePolicy => (a, state) => {
  const role = pairs[a.role];
  if (!role) return idleIntent('def idle');
  const t = state.athletes.find((x) => x.side === 'offense' && x.role === role);
  if (!t) return idleIntent('def idle');
  place(a, { x: t.pos.x + 0.4, y: t.pos.y + state.ctx.direction * 0.5 });
  a.vel = { ...t.vel };
  return idleIntent('glued');
};

/** Named defenders rush the ball (QB/carrier) flat out and tackle when they reach it. */
export const rushPolicy = (roles: readonly string[], tackle = true): DefensePolicy => (a, state) => {
  if (!roles.includes(a.role)) return idleIntent('def idle');
  const carrier = findAthlete(state, state.ball.carrierId);
  const target = carrier && carrier.side === 'offense' ? carrier.pos : state.ball.pos;
  const intent = moveTo(a, target);
  if (tackle && dist(a.pos, target) <= 1.0) { intent.action = 'tackle'; intent.targetId = carrier ? carrier.id : null; }
  return intent;
};

/** Every defender chases the ball carrier at a fraction of full speed (no tackles). */
export const chasePolicy = (effort = 1): DefensePolicy => (a, state) => {
  const carrier = findAthlete(state, state.ball.carrierId);
  if (!carrier || carrier.side !== 'offense') return idleIntent('def idle');
  const intent = moveTo(a, carrier.pos, effort >= 1);
  intent.move = { x: intent.move.x * effort, y: intent.move.y * effort };
  return intent;
};

/** Teleports an athlete (velocity cleared). */
export const place = (a: Athlete, pos: Vec2): void => {
  a.pos = clone(pos);
  a.vel = { x: 0, y: 0 };
};

/** Top speed of an athlete in yd/s (for timing assertions). */
export const topSpeed = (a: Athlete): number => maxSpeed(a.attrs.speed);
