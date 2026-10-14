import { angle, dist, len, type Vec2 } from '@/core/vec2';
import { findOverlaps, separate } from '@/physics/collision';
import { GROUND_FRICTION, OUT_OF_BOUNDS_MARGIN, turnToward } from '@/physics/movement';
import type { AthleteId } from '../play-events';
import type { Athlete, AthleteState, ReplayFrame } from '../play-types';
import { FIELD_LENGTH, FIELD_WIDTH } from '../types';

/**
 * Post-whistle motion (PRESENTATION ONLY). When a play dies nobody freezes: runners ease off into a jog and pull
 * up, blockers let go, and the ball carrier and the men who tackled him go to the ground together ('falling', then
 * 'down') and slide a little with the pile's momentum. The outcome, the spot and the stats are built before the first
 * settle step and never read anything this module writes; it draws no randomness (variety comes from a hash of the
 * athlete id) and advances neither the play clock nor state.tick. Everyone is at rest within SETTLE_MAX_SECONDS.
 */

/** Hard stop: after this many seconds every body is at rest and on the ground or on his feet. */
export const SETTLE_MAX_SECONDS = 1.5;
/** A runner above this speed brakes hard toward a jog first, then eases from the jog to a stop. */
export const SETTLE_JOG_SPEED = 4.5;
/** Braking above / below the jog (yd/s^2), before the per-athlete variety. */
export const SETTLE_RUN_DECEL = 12;
export const SETTLE_JOG_DECEL = 7.5;
/** Seconds a tackled body spends going down before it lies on the ground. */
export const SETTLE_FALL_SECONDS = 0.35;
/** Friction while falling (bodies skid with the pile) and once down. */
export const SETTLE_FALL_FRICTION = 7;
/** Defenders hanging on within this distance of the carrier go down in the pile with him. */
export const SETTLE_PILE_RADIUS = 1.8;
/** Slide speed limits (yd/s) of a falling body: a pile skids a little, it never glides. */
export const SETTLE_SLIDE_MAX = 3;
export const SETTLE_SLIDE_MIN = 0.8;
/** Seconds before a blocker lets go of his man after the whistle. */
export const SETTLE_RELEASE_SECONDS = 0.25;
/** Speed under which an athlete counts as at rest. */
export const SETTLE_REST_SPEED = 0.05;

/** States in which a body is already on (or going to) the ground. */
const GROUNDED: ReadonlySet<AthleteState> = new Set<AthleteState>(['down', 'falling']);
/** States that go to the ground at the whistle: tackled or held carriers, tacklers hanging on, dives and slides. */
const GOING_DOWN: ReadonlySet<AthleteState> = new Set<AthleteState>(['tackled', 'wrapped', 'wrapping', 'diving', 'sliding']);
/** States that simply keep going (celebrations) until they come to rest. */
const KEEP: ReadonlySet<AthleteState> = new Set<AthleteState>(['celebrating', 'down', 'falling']);
/** Pile states the field view draws stacked and the separation pass leaves overlapping. */
export const PILE_STATES: ReadonlySet<AthleteState> = new Set<AthleteState>(['down', 'falling', 'tackled', 'wrapped', 'wrapping']);

/** Deterministic per-athlete variety in [0, 1) from the id (never env.rng). */
export const idNoise = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
};

/** Settle bookkeeping for one dead play. */
export interface SettleState {
  /** Seconds since the whistle. */
  t: number;
  done: boolean;
  /** Who went down in the pile (carrier first). */
  pile: AthleteId[];
  /** Where heads turn once runners have pulled up (the dead-ball spot). */
  focus: Vec2;
  /** Per-athlete braking multiplier (0.85..1.15) and fall/release delays. */
  pace: Record<AthleteId, number>;
}

const clampToField = (a: Athlete): void => {
  const m = OUT_OF_BOUNDS_MARGIN;
  a.pos.x = Math.min(FIELD_WIDTH + m, Math.max(-m, a.pos.x));
  a.pos.y = Math.min(FIELD_LENGTH + m, Math.max(-m, a.pos.y));
};

const brake = (a: Athlete, decel: number, dt: number): void => {
  const speed = len(a.vel);
  if (speed <= 1e-9) return;
  const next = Math.max(0, speed - decel * dt);
  const k = next / speed;
  a.vel.x *= k;
  a.vel.y *= k;
};

const fall = (a: Athlete, slide: Vec2): void => {
  a.state = 'falling';
  a.stateTimer = 0;
  const s = len(slide);
  const k = s > SETTLE_SLIDE_MAX ? SETTLE_SLIDE_MAX / s : 1;
  a.vel = { x: slide.x * k, y: slide.y * k };
};

/** Velocity of an athlete for the fall: his current one, or (when a system already stopped him) the last live one. */
const momentumVel = (a: Athlete, lastVel: ReadonlyMap<AthleteId, Vec2> | undefined): Vec2 => {
  if (len(a.vel) > 0.2) return a.vel;
  const v = lastVel?.get(a.id);
  return v ? { x: v.x, y: v.y } : { x: 0, y: 0 };
};

/**
 * Prepares the settle for a play that just died: picks the pile (a carrier going down plus the defenders on him)
 * and sends it to the ground with the pile's momentum. `lastVel` holds velocities from before the final tick's
 * systems ran (a tackle that stopped the carrier dead still lets the pile skid the way it was moving).
 */
export const beginSettle = (athletes: Athlete[], carrierId: AthleteId | null, focus: Vec2, lastVel?: ReadonlyMap<AthleteId, Vec2>): SettleState => {
  const pace: Record<AthleteId, number> = {};
  for (const a of athletes) pace[a.id] = 0.85 + 0.3 * idNoise(a.id);
  const st: SettleState = { t: 0, done: false, pile: [], focus: { x: focus.x, y: focus.y }, pace };
  const carrier = athletes.find((a) => a.id === carrierId) ?? athletes.find((a) => a.state === 'tackled' || a.state === 'wrapped') ?? null;
  if (carrier && (GOING_DOWN.has(carrier.state) || GROUNDED.has(carrier.state))) {
    const tacklers = athletes.filter((a) => a.side !== carrier.side && dist(a.pos, carrier.pos) <= SETTLE_PILE_RADIUS
      && (a.state === 'wrapping' || a.state === 'tackling' || a.state === 'diving' || a.state === 'falling'));
    const members = [carrier, ...tacklers];
    let mass = 0;
    const p = { x: 0, y: 0 };
    for (const m of members) {
      const v = momentumVel(m, lastVel);
      p.x += v.x * m.massLb;
      p.y += v.y * m.massLb;
      mass += m.massLb;
    }
    const pile = mass > 0 ? { x: p.x / mass, y: p.y / mass } : { x: 0, y: 0 };
    for (const m of members) {
      const own = momentumVel(m, lastVel);
      let slide = { x: own.x * 0.4 + pile.x * 0.6, y: own.y * 0.4 + pile.y * 0.6 };
      if (len(slide) < SETTLE_SLIDE_MIN) {
        // No momentum to speak of: the carrier sags where he faces, a tackler lands on top of him.
        const dir = m === carrier ? m.facing : angle({ x: carrier.pos.x - m.pos.x, y: carrier.pos.y - m.pos.y });
        slide = { x: Math.cos(dir) * SETTLE_SLIDE_MIN, y: Math.sin(dir) * SETTLE_SLIDE_MIN };
      }
      if (m.state !== 'down') fall(m, slide);
      st.pile.push(m.id);
    }
  }
  return st;
};

const settleOne = (a: Athlete, st: SettleState, dt: number): void => {
  const pace = st.pace[a.id] ?? 1;
  // Outside the pile: a missed dive, a slide or an injured man goes to the ground where he is.
  if (!GROUNDED.has(a.state) && (GOING_DOWN.has(a.state) || !a.active)) fall(a, a.vel);
  a.stateTimer += dt;
  if (a.state === 'falling') {
    brake(a, SETTLE_FALL_FRICTION, dt);
    if (a.stateTimer >= SETTLE_FALL_SECONDS * pace) {
      a.state = 'down';
      a.stateTimer = 0;
    }
  } else if (a.state === 'down') {
    brake(a, GROUND_FRICTION, dt);
  } else {
    const speed = len(a.vel);
    brake(a, (speed > SETTLE_JOG_SPEED ? SETTLE_RUN_DECEL : SETTLE_JOG_DECEL) / pace, dt);
    const now = len(a.vel);
    if (now > 0.5) a.facing = angle(a.vel);
    else a.facing = turnToward(a.facing, angle({ x: st.focus.x - a.pos.x, y: st.focus.y - a.pos.y }), 2.5 * dt);
    if (!KEEP.has(a.state) && st.t >= SETTLE_RELEASE_SECONDS * pace) {
      const next: AthleteState = now > 0.3 ? 'moving' : 'idle';
      if (a.state !== next) a.stateTimer = 0;
      a.state = next;
    }
  }
  a.pos.x += a.vel.x * dt;
  a.pos.y += a.vel.y * dt;
  clampToField(a);
};

/**
 * One settle step of `dt` seconds for every athlete. Returns true while anything is still moving or falling;
 * after SETTLE_MAX_SECONDS it forces everyone to rest (fallers down) and returns false.
 */
export const settleStep = (athletes: Athlete[], st: SettleState, dt: number): boolean => {
  if (st.done) return false;
  st.t += dt;
  for (const a of athletes) settleOne(a, st, dt);
  // Standing bodies drift apart a little; the pile stays stacked.
  for (const o of findOverlaps(athletes)) {
    if (PILE_STATES.has(o.a.state) || PILE_STATES.has(o.b.state)) continue;
    separate(o.a, o.b, o.penetration * 0.2, o.normal);
  }
  const busy = athletes.some((a) => a.state === 'falling' || len(a.vel) > SETTLE_REST_SPEED);
  if (busy && st.t < SETTLE_MAX_SECONDS) return true;
  for (const a of athletes) {
    a.vel = { x: 0, y: 0 };
    if (a.state === 'falling') { a.state = 'down'; a.stateTimer = 0; }
    else if (a.state === 'moving') a.state = 'idle';
  }
  st.done = true;
  return false;
};

/** Snapshot of the settling athletes in the replay frame format (ball fixed at its dead spot). */
export const settleFrame = (tick: number, athletes: readonly Athlete[], ball: ReplayFrame['ball']): ReplayFrame => ({
  tick,
  athletes: athletes.map((a) => ({ id: a.id, x: a.pos.x, y: a.pos.y, facing: a.facing, state: a.state, hasBall: a.hasBall })),
  ball: { ...ball },
});

/** Deep-enough copy of the athletes for a dry settle run (positions, velocities and states only change). */
export const cloneForSettle = (athletes: readonly Athlete[]): Athlete[] => athletes.map((a) => ({ ...a, pos: { ...a.pos }, vel: { ...a.vel } }));

/**
 * Runs a whole settle on copies of the athletes and returns its frames (for the replay recording). The live settle
 * run from the same inputs produces identical frames: both are pure functions of the athletes at the whistle.
 */
export const settleFrames = (athletes: readonly Athlete[], st: SettleState, dt: number, firstTick: number, ball: ReplayFrame['ball']): ReplayFrame[] => {
  const copy = cloneForSettle(athletes);
  const run: SettleState = { ...st, pile: [...st.pile], focus: { ...st.focus }, pace: { ...st.pace } };
  const frames: ReplayFrame[] = [];
  const cap = Math.ceil(SETTLE_MAX_SECONDS / dt) + 1;
  for (let i = 0; i < cap; i++) {
    const more = settleStep(copy, run, dt);
    frames.push(settleFrame(firstTick + i, copy, ball));
    if (!more) break;
  }
  return frames;
};

/** A live play that can keep animating its bodies after the whistle (PlayEngine). */
export interface SettleablePlay {
  /** One presentation-only settle tick of a dead play; true while bodies are still moving. */
  settle(): boolean;
  /** The whole settle as replay frames (for appending to the play's recording); empty before the whistle. */
  settleFrames(): ReplayFrame[];
}

/** Whether a LivePlay (or fake) implements post-whistle settling. */
export const canSettle = <T extends object>(play: T | null | undefined): play is T & SettleablePlay =>
  !!play && typeof (play as Partial<SettleablePlay>).settle === 'function';
