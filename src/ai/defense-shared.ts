import { clampToField } from './movement';
import { coverageEdge, throwReadSeconds } from './coverage-iq';
import { f } from './variance';
import { clamp01, lerp } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { dist, len, sub, type Vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import { idleIntent, type AthleteIntent, type Locomotion } from '@/game/engine-api';
import type { DifficultyProfile } from '@/game/types';
import type { Athlete, PlayState } from '@/game/play-types';
import type { Gap } from '@/playbook/types';
import type { Position } from '@/players/types';
import { ballHeightAt, CATCH_HEIGHT, predictLanding } from '@/physics/ball';
import { maxSpeed } from '@/physics/speed';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Shared layer for the DEFENSIVE deciders: per-athlete personality noise, reaction delays, honest perception
 * (what a defender has noticed so far, not what the play call says), steering intents and the turnover
 * fallbacks. Everything is pure except the per-athlete memory kept in `athlete.ai.scratch` (numbers only) and a
 * per-PlayState cache of the team-wide view for the current tick. No randomness is consumed here: personality
 * comes from a hash of the player id so replays and tests are stable.
 */

/* ------------------------------ Personality noise ------------------------------ */

const fnv1a = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

const avalanche = (h: number): number => {
  let x = h ^ (h >>> 16);
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
};

/** Deterministic 0..1 personality value for a (player, decision) pair; stable across ticks, plays and replays. */
export const defenderNoise = (athlete: Pick<Athlete, 'playerId'>, salt: string): number =>
  avalanche(fnv1a(`${athlete.playerId}#${salt}`)) / 4294967296;

/** Symmetric jitter in [-amplitude, amplitude] from defenderNoise. */
export const defenderJitter = (athlete: Pick<Athlete, 'playerId'>, salt: string, amplitude: number): number =>
  (defenderNoise(athlete, salt) * 2 - 1) * amplitude;

/** 1..99 rating to a 0..1 factor (the shared variance helper under the defence modules' name). */
export const rf = f;

/* ------------------------------ Reaction & judgement ------------------------------ */

/**
 * Seconds this defender needs to react to a new stimulus (throw, cut, handoff). Difficulty sets the baseline
 * (rookie 0.45 s, legend 0.08 s), the reaction rating scales it between 1.45x (rating 1) and 0.55x (rating 99)
 * and personality spreads it +/-15%, so two defenders never react in lockstep and a legend-AI defender always
 * beats a rookie-AI one regardless of rating.
 */
export const reactionSeconds = (athlete: Pick<Athlete, 'playerId' | 'attrs'>, difficulty: Pick<DifficultyProfile, 'aiReactionDelay'>): number => {
  const base = Math.max(0, difficulty.aiReactionDelay);
  const ratingMult = 1.45 - 0.9 * rf(athlete.attrs.reaction);
  return Math.max(0.02, base * ratingMult * (1 + defenderJitter(athlete, 'reaction', 0.15)));
};

/** 0..1 quality of a judgement call: awareness blended with a difficulty knob, nudged by personality. */
export const judgement = (athlete: Pick<Athlete, 'playerId' | 'attrs'>, knob: number, salt = 'judgement'): number =>
  clamp01(lerp(rf(athlete.attrs.awareness), clamp01(knob), 0.55) + defenderJitter(athlete, salt, 0.06));

/* ------------------------------ Field helpers ------------------------------ */

type FieldState = Pick<PlayState, 'losY' | 'ctx'>;

/** Yards beyond the LOS along the offense's direction (positive = the defensive side of the ball). */
export const depthOf = (state: FieldState, pos: Vec2): number => state.ctx.direction * (pos.y - state.losY);

/** Play-local x (offense's right positive) of an absolute x. */
export const localX = (state: FieldState, x: number): number => state.ctx.direction * (x - state.ctx.ballX);

/** Clamp a point inside the field with a margin. */
export const clampPoint = clampToField;

export const faceToward = (from: Vec2, to: Vec2): number => Math.atan2(to.y - from.y, to.x - from.x);

/** Play-local lateral centre of each gap (yards from the ball, offense's right positive). */
export const GAP_LOCAL_X: Record<Gap, number> = {
  'A-left': -0.6, 'A-right': 0.6, 'B-left': -1.9, 'B-right': 1.9, 'C-left': -3.4, 'C-right': 3.4, 'D-left': -5.6, 'D-right': 5.6,
};

/** Absolute x of a gap for this play. */
export const gapX = (state: FieldState, gap: Gap): number => state.ctx.ballX + state.ctx.direction * GAP_LOCAL_X[gap];

/** Top running speed (with a small sprint allowance) for planning intercepts. */
export const speedOf = (athlete: Pick<Athlete, 'attrs'>, sprint = true): number => maxSpeed(athlete.attrs.speed) * (sprint ? 1.06 : 1);

/** Seconds since the snap (0 before it). */
export const sinceSnap = (state: Pick<PlayState, 'phase' | 'tick' | 'snapTick'>): number =>
  state.phase === 'live' && state.snapTick >= 0 ? (state.tick - state.snapTick) * TICK_DT : 0;

/** Nearest active athlete of a list to a point (null for an empty list). */
export const nearestTo = (list: readonly Athlete[], pos: Vec2, exclude: Athlete | null = null): Athlete | null => {
  let best: Athlete | null = null;
  let bd = Infinity;
  for (const a of list) {
    if (!a.active || a === exclude) continue;
    const d = dist(a.pos, pos);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
};

/* ------------------------------ Team-wide view (cached per tick) ------------------------------ */

export interface TeamView {
  live: boolean;
  offense: Athlete[];
  defense: Athlete[];
  qb: Athlete | null;
  /** Whoever holds the ball right now (either side), null when nobody does. */
  carrier: Athlete | null;
  linemen: Athlete[];
  /** Eligible offensive athletes (never the QB). */
  receivers: Athlete[];
  /** Mean movement of the OL relative to their alignment (+ = fired out across the LOS, - = pass set). */
  olDrive: number;
  /** Mean play-local x velocity of the OL and backs (+ = flowing to the offense's right). */
  flowX: number;
  qbDepth: number;
  qbSnapDepth: number;
  runCue: boolean;
  passCue: boolean;
  ballInAir: boolean;
  /** Where an airborne pass comes down to catch height (null when no pass is in the air). */
  landing: Vec2 | null;
  landingTicks: number;
  loose: boolean;
  defenseHasBall: boolean;
  sinceSnap: number;
}

interface StateMemory {
  qbSnapDepth: number | null;
  /** Mean OL depth at the snap (measured, not assumed) so olDrive is relative to the actual alignment. */
  olSnapDepth: number | null;
  key: string;
  view: TeamView | null;
}

const memories = new WeakMap<PlayState, StateMemory>();

const OL_POSITIONS = new Set<Position>(['OT', 'OG', 'C']);

/** Reach (yd) inside which a receiver gathers a ball passing him, and the highest ball he takes in stride. */
const CATCH_REACH = 1.2;
const CATCH_MAX_Z = 2.6;

/**
 * Where a thrown ball actually meets its target: the first moment the ball (flat projection) passes within the
 * receiver's reach at a catchable height, extrapolating both at their current velocities. A bullet is caught
 * yards short of the point where it would come down to catch height, so defenders who break on the landing spot
 * arrive late and watch the catch happen in front of them. Falls back to the landing prediction.
 */
const catchPointFor = (ball: PlayState['ball'], receiver: Athlete, landing: Vec2, landingTicks: number): { pos: Vec2; ticks: number } => {
  for (let i = 2; i <= landingTicks; i += 2) {
    const t = i * TICK_DT;
    const bp = { x: ball.pos.x + ball.vel.x * t, y: ball.pos.y + ball.vel.y * t };
    const rp = { x: receiver.pos.x + receiver.vel.x * t, y: receiver.pos.y + receiver.vel.y * t };
    if (ballHeightAt(ball, i) <= CATCH_MAX_Z && dist(bp, rp) <= CATCH_REACH) return { pos: bp, ticks: i };
  }
  return { pos: landing, ticks: landingTicks };
};

/** True for offensive athletes whose job this play is to block. */
export const isBlocker = (a: Athlete): boolean =>
  OL_POSITIONS.has(a.position) || a.assignment.type === 'runBlock' || a.assignment.type === 'passBlock' || a.assignment.type === 'leadBlock';

const buildView = (state: PlayState, mem: StateMemory): TeamView => {
  const offense = state.athletes.filter((a) => a.side === 'offense');
  const defense = state.athletes.filter((a) => a.side === 'defense');
  const qb = offense.find((a) => a.active && a.position === 'QB') ?? offense.find((a) => a.active && a.assignment.type === 'qb') ?? null;
  const carrier = findAthlete(state, state.ball.carrierId) ?? state.athletes.find((a) => a.active && a.hasBall) ?? null;
  const linemen = offense.filter((a) => a.active && isBlocker(a));
  const receivers = offense.filter((a) => a.active && a.eligible && a.position !== 'QB');
  const dir = state.ctx.direction;
  const t = sinceSnap(state);
  const live = state.phase === 'live';
  let drive = 0;
  let flow = 0;
  let n = 0;
  for (const l of linemen) {
    if (!OL_POSITIONS.has(l.position)) continue;
    drive += depthOf(state, l.pos);
    flow += dir * l.vel.x;
    n++;
  }
  const olDepth = n > 0 ? drive / n : 0;
  if (live && mem.olSnapDepth === null) mem.olSnapDepth = olDepth;
  const olDrive = live && mem.olSnapDepth !== null ? olDepth - mem.olSnapDepth : 0;
  for (const b of offense) if (b.active && (b.position === 'RB' || b.position === 'FB')) { flow += dir * b.vel.x; n++; }
  const flowX = n > 0 ? flow / n : 0;
  const qbDepth = qb ? depthOf(state, qb.pos) : 0;
  if (live && mem.qbSnapDepth === null) mem.qbSnapDepth = qbDepth;
  const qbSnapDepth = mem.qbSnapDepth ?? qbDepth;
  const ball = state.ball;
  const held = ball.phase === 'held';
  const offCarrier = carrier && carrier.side === 'offense' ? carrier : null;
  const nonQbCarrier = offCarrier !== null && offCarrier.position !== 'QB' && held;
  const qbKeeper = offCarrier !== null && offCarrier.position === 'QB' && held && qbDepth > -0.5 && t > 0.25;
  const runCue = live && (nonQbCarrier || qbKeeper || (t > 0.15 && olDrive > 0.45) || ball.kind === 'handoff' || ball.kind === 'pitch');
  const passInAir = ball.phase === 'inAir' && ball.kind === 'pass';
  const qbDropped = offCarrier !== null && offCarrier.position === 'QB' && qbDepth < qbSnapDepth - 1.2;
  const qbSet = qb !== null && (qb.state === 'dropback' || qb.state === 'throwing');
  const passCue = live && (passInAir || qbSet || qbDropped || (t > 0.15 && olDrive < -0.7));
  const airborne = ball.phase === 'inAir' || (ball.phase === 'loose' && (ball.z > 0 || ball.vz > 0));
  let landing: Vec2 | null = null;
  let landingTicks = 0;
  if (airborne) {
    const lp = predictLanding(ball, state.ctx.weather, passInAir && !ball.isTipped ? CATCH_HEIGHT : 0);
    landing = lp.pos;
    landingTicks = lp.ticks;
    const target = passInAir && !ball.isTipped ? findAthlete(state, ball.targetId) : null;
    if (target && target.active) {
      const cp = catchPointFor(ball, target, landing, landingTicks);
      landing = cp.pos;
      landingTicks = cp.ticks;
    }
  }
  return {
    live, offense, defense, qb, carrier, linemen, receivers, olDrive, flowX, qbDepth, qbSnapDepth, runCue, passCue,
    ballInAir: passInAir && !ball.isTipped, landing, landingTicks,
    // A held ball is never loose, whatever its kind says (holdBall keeps 'fumble'/'tip' after a recovery).
    loose: ball.phase === 'loose' || (ball.phase === 'inAir' && ball.isTipped),
    defenseHasBall: carrier !== null && carrier.side === 'defense' && held,
    sinceSnap: t,
  };
};

/** The team-wide situation this tick, computed once per PlayState tick and shared by every defender. */
export const teamView = (state: PlayState): TeamView => {
  let mem = memories.get(state);
  if (!mem) {
    mem = { qbSnapDepth: null, olSnapDepth: null, key: '', view: null };
    memories.set(state, mem);
  }
  const key = `${state.tick}|${state.phase}|${state.ball.phase}|${state.ball.carrierId ?? ''}|${state.ball.launchTick}`;
  if (mem.view && mem.key === key) return mem.view;
  mem.view = buildView(state, mem);
  mem.key = key;
  return mem.view;
};

/* ------------------------------ Per-defender perception ------------------------------ */

export interface Perception {
  view: TeamView;
  /** This defender's reaction delay in seconds. */
  reaction: number;
  recognizedRun: boolean;
  recognizedPass: boolean;
  /** The offensive ball carrier this defender has noticed (after the reaction delay); null until then. */
  carrier: Athlete | null;
  /** A pass in the air that this defender has reacted to. */
  passSeen: boolean;
  landing: Vec2 | null;
  landingTicks: number;
  t: number;
}

/** Read a scratch number with a fallback (scratch entries are absent until first written). */
export const mem = (scratch: Record<string, number>, key: string, fallback: number): number => {
  const v = scratch[key];
  return v === undefined ? fallback : v;
};

/**
 * What this defender knows right now. Run/pass cues from the team view are only acknowledged after the
 * defender's reaction delay (memorised in ai.scratch); a later contradicting cue (draw after a pass set, play
 * action after a run fake) overrides once it is itself recognised. Also tracks the noticed ball carrier and
 * whether a thrown ball has been seen yet.
 */
export const perceive = (athlete: Athlete, state: PlayState): Perception => {
  const view = teamView(state);
  const s = athlete.ai.scratch;
  const now = state.time;
  let reaction = mem(s, 'reaction', -1);
  if (reaction < 0) {
    reaction = reactionSeconds(athlete, difficultyFor(state, athlete));
    s.reaction = reaction;
  }
  if (view.runCue && mem(s, 'runCueAt', -1) < 0) s.runCueAt = now;
  if (view.passCue && mem(s, 'passCueAt', -1) < 0) s.passCueAt = now;
  const runAt = mem(s, 'runCueAt', -1);
  const passAt = mem(s, 'passCueAt', -1);
  const ai = athlete.ai;
  if (runAt >= 0 && now - runAt >= reaction) ai.recognizedRun = true;
  if (passAt >= 0 && now - passAt >= reaction) ai.recognizedPass = true;
  if (ai.recognizedRun && ai.recognizedPass) {
    const c = view.carrier;
    const runNow = c !== null && c.side === 'offense' && (c.position !== 'QB' || view.qbDepth > -0.5);
    if (runNow) ai.recognizedPass = false;
    else ai.recognizedRun = false;
  }
  const c = view.carrier;
  const idx = c ? state.athletes.indexOf(c) : -1;
  if (idx !== mem(s, 'carrierIdx', -2)) {
    s.carrierIdx = idx;
    // A defender who was already playing the ball in the air sees the catch as it happens: no fresh reaction delay.
    s.carrierCueAt = mem(s, 'sawPass', 0) === 1 ? now - reaction : now;
  }
  const carrierDelay = c !== null && c.position === 'QB' ? 0 : reaction;
  const carrierSeen = c !== null && c.side === 'offense' && now - mem(s, 'carrierCueAt', now) >= carrierDelay;
  if (view.ballInAir) {
    if (mem(s, 'throwAt', -1) < 0 || mem(s, 'throwLaunch', -1) !== state.ball.launchTick) {
      s.throwAt = now;
      s.throwLaunch = state.ball.launchTick;
    }
  } else if (mem(s, 'throwAt', -1) >= 0) {
    s.throwAt = -1;
  }
  // The eyes on the throw are a decision (coverage-iq): rookie defenders find the ball late, legend ones read the release.
  const passSeen = view.ballInAir && now - mem(s, 'throwAt', now) >= throwReadSeconds(athlete, reaction, coverageEdge(difficultyFor(state, athlete)));
  s.sawPass = passSeen ? 1 : 0;
  return {
    view, reaction, recognizedRun: ai.recognizedRun, recognizedPass: ai.recognizedPass,
    carrier: carrierSeen ? c : null, passSeen, landing: view.landing, landingTicks: view.landingTicks, t: view.sinceSnap,
  };
};

/* ------------------------------ Steering intents ------------------------------ */

export interface SeekOptions {
  sprint?: boolean;
  /** Effort scales down linearly inside this radius (arrive behaviour). */
  slowRadius?: number;
  /** No movement inside this radius. */
  stopRadius?: number;
  effort?: number;
  locomotion?: Locomotion;
  face?: number | null;
  debug?: string;
}

/** Move toward `target` (run by default); `slowRadius` gives arrive behaviour, `face` + strafe/backpedal keep the eyes on something. */
export const seekIntent = (athlete: Pick<Athlete, 'pos'>, target: Vec2, o: SeekOptions = {}): AthleteIntent => {
  const to = sub(target, athlete.pos);
  const d = len(to);
  const intent = idleIntent(o.debug ?? 'seek');
  intent.locomotion = o.locomotion ?? 'run';
  intent.face = o.face ?? null;
  if (d < (o.stopRadius ?? 0.2)) return intent;
  let effort = clamp01(o.effort ?? 1);
  if (o.slowRadius !== undefined && o.slowRadius > 0 && d < o.slowRadius) effort *= Math.max(0.25, d / o.slowRadius);
  intent.move = { x: (to.x / d) * effort, y: (to.y / d) * effort };
  intent.sprint = o.sprint ?? false;
  return intent;
};

/** Stand still, turning to `face` (null keeps the current facing). */
export const holdIntent = (face: number | null, debug: string): AthleteIntent => {
  const i = idleIntent(debug);
  i.locomotion = 'strafe';
  i.face = face;
  return i;
};

/** Fight off the blocker this athlete is engaged with while working toward `toward`. */
export const shedIntent = (athlete: Athlete, toward: Vec2, debug: string): AthleteIntent => {
  const i = seekIntent(athlete, toward, { debug, sprint: false });
  i.action = 'shed';
  i.targetId = athlete.engagedWith;
  return i;
};

/**
 * Longest a defender with the worst run-fit judgement keeps playing his blocker after he has spotted the carrier
 * before deciding to come off it onto the ball (scaled down by judgement on DifficultyProfile.pursuitQuality).
 */
export const SHED_READ_SECONDS = 0.45;

/**
 * Engaged: fight off the blocker. Once the carrier has been seen AND read (the pursuit-judgement delay has passed) the
 * defender commits to coming off the block onto the ball (a 'shed' aimed at the carrier, which the engine's chase-shed
 * roll honours in full); until then he works toward `fallback` and plays the man in front of him.
 */
export const engagedIntent = (athlete: Athlete, state: PlayState, p: Perception, fallback: Vec2, debug: string): AthleteIntent => {
  const c = p.carrier;
  if (c) {
    const seenAt = mem(athlete.ai.scratch, 'carrierCueAt', state.time) + (c.position === 'QB' ? 0 : p.reaction);
    const read = SHED_READ_SECONDS * (1 - judgement(athlete, difficultyFor(state, athlete).pursuitQuality, 'shedRead'));
    if (state.time - seenAt >= read) {
      const i = shedIntent(athlete, c.pos, `${debug} to ball`);
      i.targetId = c.id;
      return i;
    }
  }
  return shedIntent(athlete, fallback, debug);
};

/** Default presnap posture: hold, eyes on the ball. */
export const presnapIntent = (athlete: Pick<Athlete, 'pos'>, state: Pick<PlayState, 'ball'>, debug = 'presnap'): AthleteIntent =>
  holdIntent(faceToward(athlete.pos, state.ball.pos), debug);

/* ------------------------------ Turnover fallbacks ------------------------------ */

const looseBallIntent = (athlete: Athlete, state: PlayState, view: TeamView): AthleteIntent => {
  const ball = state.ball;
  const spot = view.landing && view.landingTicks > 0 ? view.landing : { x: ball.pos.x + ball.vel.x * 0.3, y: ball.pos.y + ball.vel.y * 0.3 };
  const target = clampPoint(spot, 0.3);
  const myD = dist(athlete.pos, target);
  let rank = 0;
  for (const d of view.defense) if (d.active && d !== athlete && dist(d.pos, target) < myD) rank++;
  const intent = seekIntent(athlete, target, { sprint: rank <= 2, effort: rank <= 2 ? 1 : 0.85, stopRadius: 0.1, debug: 'loose ball' });
  const rival = nearestTo(view.offense, target);
  if (myD <= 1.6 && ball.z < 0.5 && rival && dist(rival.pos, target) < 2.5 && athlete.state !== 'diving') intent.action = 'dive';
  return intent;
};

const returnIntent = (athlete: Athlete, state: PlayState, view: TeamView): AthleteIntent => {
  const dir = state.ctx.direction;
  const threat = nearestTo(view.offense, athlete.pos);
  let lateral = 0;
  if (threat) {
    const toThreat = sub(threat.pos, athlete.pos);
    const ahead = -dir * toThreat.y > -1;
    if (ahead && len(toThreat) < 6) lateral = (athlete.pos.x >= threat.pos.x ? 1 : -1) * 3;
  }
  const target = clampPoint({ x: athlete.pos.x + lateral, y: athlete.pos.y - dir * 15 }, 2);
  const intent = seekIntent(athlete, target, { sprint: true, debug: 'return' });
  if (threat && dist(threat.pos, athlete.pos) <= 1.6 && athlete.specialMoveCooldown <= 0) {
    intent.action = rf(athlete.attrs.agility) >= 0.7 ? 'juke' : rf(athlete.attrs.strength) >= 0.7 ? 'stiffArm' : 'spin';
  }
  return intent;
};

const convoyIntent = (athlete: Athlete, state: PlayState, view: TeamView, carrier: Athlete): AthleteIntent => {
  const dir = state.ctx.direction;
  const threats = view.offense.filter((a) => a.active).sort((a, b) => dist(a.pos, carrier.pos) - dist(b.pos, carrier.pos));
  let mine: Athlete | null = null;
  for (const t of threats) {
    const closer = view.defense.find((d) => d.active && d !== athlete && d !== carrier && dist(d.pos, t.pos) < dist(athlete.pos, t.pos));
    if (!closer) { mine = t; break; }
  }
  if (!mine) mine = nearestTo(threats, athlete.pos);
  if (!mine) return seekIntent(athlete, { x: carrier.pos.x, y: carrier.pos.y - dir * 4 }, { sprint: true, debug: 'convoy lead' });
  const toCarrier = sub(carrier.pos, mine.pos);
  const l = len(toCarrier) || 1;
  const aim = { x: mine.pos.x + (toCarrier.x / l) * 1.0, y: mine.pos.y + (toCarrier.y / l) * 1.0 };
  const intent = seekIntent(athlete, aim, { sprint: true, stopRadius: 0.3, debug: `convoy block ${mine.role}` });
  if (dist(athlete.pos, mine.pos) <= 1.6) {
    intent.action = 'block';
    intent.targetId = mine.id;
  }
  return intent;
};

/**
 * Intents that apply to every defender regardless of assignment: nothing to do when the play is dead or the
 * athlete is out of it, chase a loose ball, and after a takeaway either return it or convoy for the returner.
 * Returns null when the assignment-specific decider should run.
 */
export const commonIntent = (athlete: Athlete, state: PlayState, view: TeamView): AthleteIntent | null => {
  if (state.phase === 'dead' || !athlete.active || athlete.state === 'tackled' || athlete.state === 'down') return idleIntent('out');
  if (!view.live) return null;
  if (view.loose) return looseBallIntent(athlete, state, view);
  if (view.defenseHasBall && view.carrier) {
    return view.carrier.id === athlete.id ? returnIntent(athlete, state, view) : convoyIntent(athlete, state, view, view.carrier);
  }
  return null;
};
