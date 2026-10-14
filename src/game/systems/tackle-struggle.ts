import { approach, clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { angle, angleDiff, clone, dist, len, type Vec2 } from '@/core/vec2';
import { followCarrier } from '@/physics/ball';
import {
  CARRIER_DRIVE, legDrive, mergeVelocity, pileStep, PUSHER_DRIVE, struggleTick, tacklerDrive, WRAP_MOMENTUM, WRAP_MOMENTUM_HIT, type PileBody, type PileHold,
} from '@/physics/struggle';
import { findAthlete } from '../athlete';
import type { BreakMove, TackleKind } from '../play-events';
import { crossingPoint } from '../live-rules';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_LENGTH, FIELD_WIDTH, otherSide } from '../types';
import {
  attackDir, ballOnAt, canAct, carrierDown, depthOf, emit, goalLineY, inField, isHuman, pairKey, releasePile, setTimedState,
  type EngineEnv, type PileMember, type StruggleState, type TackleRecord,
} from './env';
import { looseBallFrom } from './fumble';
import { difficultyFor } from '../difficulty-sides';

/**
 * The tackle struggle. Contact no longer ends the play on the spot: a tackler who gets hold of the runner
 * (physics/contact.ts contactStart) starts a struggle. The runner is 'wrapped', every defender hanging on is
 * 'wrapping', and the pile moves as one coupled mass: its velocity starts as the bodies' merged momentum and then
 * follows every body's leg drive in the direction its intent asks for (physics/struggle.ts pileStep), so a heavy
 * back churning upfield drags a small corner, a square hit from a big linebacker stops him or drives him back, and
 * teammates leaning in from behind push the pile. Bodies are moved here, never by the AI (it only chooses where to
 * drive and whether to punch at the ball or try a move).
 *
 * Each tick one roll decides whether a defender strips the ball, the runner breaks free, or the tackle finishes
 * (physics/struggle.ts struggleTick); a runner stood up (no forward progress) for STOOD_UP_SECONDS is whistled
 * down; nobody is held longer than MAX_STRUGGLE_SECONDS. The ball is spotted at the furthest point he reached while
 * held (forward progress), never where he was driven back to. A passer held behind the line keeps a short in-the-grasp
 * window to get the ball away (systems/passing.ts). A struggle that ends any other way (out of bounds, a touchdown, a
 * lateral) is simply released (env.ts releasePile).
 */
export const STOOD_UP_SECONDS = 1.0;
/** Forward speed (yd/s) under which the pile is not making progress; driven back faster than this counts 1.3x. */
export const STALL_SPEED = 0.35;
export const DRIVEN_BACK_RATE = 1.3;
export const MAX_STRUGGLE_SECONDS = 2.2;
/**
 * Longest in-the-grasp window (a flimsy grab at the passer), shrinking to none for a grip of GRASP_FULL_HOLD or more
 * (a square wrap: he is going down with the ball).
 */
export const GRASP_SECONDS = 0.25;
export const GRASP_FULL_HOLD = 0.9;
/** Seconds a break move keeps its bonus, and the wait before the next one can start (no button mashing). */
export const BREAK_WINDOW = 0.3;
export const BREAK_COOLDOWN = 0.8;
/** A human tackler not holding the tackle button loses grip at this rate (per second, less with userTackleAssist). */
export const HUMAN_HOLD_DECAY = 1.6;
/** Grip under which a tackler has let go. */
export const RELEASE_HOLD = 0.2;
/** Seconds a strip press counts as punching at the ball. */
export const PILE_STRIP_WINDOW = 0.3;
/** Extra reach (yd) over the two radii within which a teammate leaning in counts as pushing the pile. */
export const PUSH_REACH = 0.35;
/** Burst (yd/s, along his attack) a runner who breaks free comes out of the pile with. */
export const BREAK_BURST = 1.5;
/**
 * A runner still going forward (the pile faster than STALL_SPEED) reaches out as he goes down: FALL_FORWARD_BASE
 * yards plus FALL_FORWARD_PER_SPEED per yd/s of forward pile speed, capped. One who was stopped or driven back does not.
 */
export const FALL_FORWARD_BASE = 0.6;
export const FALL_FORWARD_PER_SPEED = 0.3;
export const FALL_FORWARD_CAP = 1.4;
/** Seconds the tackled runner and his tacklers take to hit the ground. */
export const FALL_SECONDS = 0.5;

const BREAK_MOVES: ReadonlySet<string> = new Set(['juke', 'spin', 'stiffArm', 'truck']);
const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

/** True while the runner is a passer still behind the line on a pass play before any throw, handoff or pitch. */
export const isPasserBehindLine = (state: PlayState, env: EngineEnv, carrier: Athlete): boolean =>
  carrier.side === 'offense' && carrier.id === env.qbId && !env.handoffDone && !env.pitched && state.pass === null
  && PASS_TYPES.has(state.ctx.offensivePlay.type) && depthOf(state, carrier.pos.y) < 0;

/** A passer held right now who may still get the ball away (the in-the-grasp window). */
export const inTheGrasp = (state: PlayState, env: EngineEnv, passer: Athlete): boolean => {
  const s = env.struggle;
  return passer.state === 'wrapped' && !!s && s.carrierId === passer.id && s.graspUntil !== null && state.time <= s.graspUntil;
};

/** Speed (yd/s) at which a man who grabbed on from arm's length (or a dive) slides in onto the runner: never a jump. */
export const HANG_SLIDE_SPEED = 4;
/** Smallest angle (radians) between two men hanging on the runner: they hold him side by side, not on one spot. */
export const HANG_SPREAD = 1.05;

/**
 * A new pile man's place on the runner: on his own side when that is free, else the free spot (HANG_SPREAD clear of
 * every man already hanging on) nearest his side; with no free spot left, the roomiest one.
 */
const hangOn = (carrier: Athlete, tackler: Athlete, taken: readonly PileMember[]): Vec2 => {
  const r = (carrier.radius + tackler.radius) * 0.9;
  const rel = { x: tackler.pos.x - carrier.pos.x, y: tackler.pos.y - carrier.pos.y };
  const own = len(rel) < 1e-6 ? -Math.PI / 2 : angle(rel);
  const angles = taken.map((m) => angle(m.hang));
  const room = (a: number): number => angles.reduce((mn, t) => Math.min(mn, Math.abs(angleDiff(t, a))), Math.PI);
  const candidates = [own, ...angles.flatMap((t) => [t + HANG_SPREAD, t - HANG_SPREAD])];
  let best = own;
  let bestScore = -Infinity;
  for (const c of candidates) {
    // Free spots first (nearest his own side), then the most room.
    const free = room(c) >= HANG_SPREAD - 1e-9;
    const score = free ? 10 - Math.abs(angleDiff(own, c)) : room(c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { x: Math.cos(best) * r, y: Math.sin(best) * r };
};

/** A pile man at his grab point (`offset`) and his settled place (`hang`). */
const member = (carrier: Athlete, tackler: Athlete, taken: readonly PileMember[], at: number, hold: number, kind: TackleKind): PileMember => ({
  id: tackler.id, joinedAt: at, hold, kind, offset: { x: tackler.pos.x - carrier.pos.x, y: tackler.pos.y - carrier.pos.y }, hang: hangOn(carrier, tackler, taken),
});

/** Turn (radians) still to go under which a pile man slides straight to his place instead of around the pile. */
const AROUND_START = 0.35;

/**
 * Slides a pile man's offset toward his place around the runner (radius and angle, at most `step` yards). One whose
 * place is well round the runner goes round the OUTSIDE of the men already hanging on (out to twice his hang radius,
 * turning only as he gets out there) instead of through them.
 */
const slideIn = (m: PileMember, step: number): void => {
  const r0 = len(m.offset);
  const r1 = len(m.hang);
  if (r0 < 1e-6) {
    m.offset = clone(m.hang);
    return;
  }
  const a0 = angle(m.offset);
  const da = angleDiff(a0, angle(m.hang));
  const around = clamp01((Math.abs(da) - AROUND_START) / AROUND_START);
  const r = approach(r0, r1 * (1 + around), step);
  const out = around > 0 ? Math.max(0.25, clamp01((r - r1) / (r1 * around))) : 1;
  const a = a0 + Math.sign(da) * Math.min(Math.abs(da), (step * out) / Math.max(r, 0.3));
  m.offset = { x: Math.cos(a) * r, y: Math.sin(a) * r };
};

/** The share of a tackler's velocity his hold puts into the pile (WRAP_MOMENTUM; a hit stick all of it). */
const wrapMomentum = (tackler: Athlete, kind: TackleKind): Vec2 => {
  const k = kind === 'hitStick' ? WRAP_MOMENTUM_HIT : WRAP_MOMENTUM;
  return { x: tackler.vel.x * k, y: tackler.vel.y * k };
};

const pileMass = (state: PlayState, s: StruggleState, carrier: Athlete): number =>
  s.tacklers.reduce((m, t) => m + Math.max(1, findAthlete(state, t.id)?.massLb ?? 0), Math.max(1, carrier.massLb));

/** Starts a struggle: `tackler` has hold of `carrier` with grip `hold`. */
export const beginStruggle = (state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete, kind: TackleKind, hold: number): void => {
  const passer = isPasserBehindLine(state, env, carrier);
  // Forward progress starts at the contact point (bestY).
  env.struggle = {
    carrierId: carrier.id, startedAt: state.time, startPos: clone(carrier.pos), bestY: carrier.pos.y, stalled: 0,
    tacklers: [member(carrier, tackler, [], state.time, hold, kind)],
    vel: mergeVelocity([carrier, { massLb: tackler.massLb, vel: wrapMomentum(tackler, kind) }]), pos: clone(carrier.pos), breakMove: null, breakUntil: 0, nextBreakAt: state.time + 0.15, failedBreaks: 0,
    graspUntil: passer ? state.time + GRASP_SECONDS * clamp01((GRASP_FULL_HOLD - hold) / 0.4) : null,
  };
  setTimedState(carrier, 'wrapped', 0);
  setTimedState(tackler, 'wrapping', 0);
  emit(state, { type: 'wrapUp', tick: state.tick, tackler: tackler.id, carrier: carrier.id, kind });
};

/** Another defender gets hold of the runner: he adds his momentum to the pile and his grip to the stop. */
export const joinPile = (state: PlayState, env: EngineEnv, carrier: Athlete, defender: Athlete, kind: TackleKind, hold: number): void => {
  const s = env.struggle;
  if (!s) return;
  const m = pileMass(state, s, carrier);
  const md = Math.max(1, defender.massLb);
  const dv = wrapMomentum(defender, kind);
  s.vel = { x: (s.vel.x * m + dv.x * md) / (m + md), y: (s.vel.y * m + dv.y * md) / (m + md) };
  s.tacklers.push(member(carrier, defender, s.tacklers, state.time, hold, kind));
  setTimedState(defender, 'wrapping', 0);
  emit(state, { type: 'pileJoin', tick: state.tick, defender: defender.id, carrier: carrier.id });
};

/**
 * The runner goes down: the tackle record (the first man to hold him is the tackler, the rest assist), a sack when he
 * was a passer behind the line, and carrierDown at `spot`. The runner and his tacklers go to the ground ('falling')
 * with the pile's momentum instead of stopping dead.
 */
export const takeDown = (
  state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete, assists: readonly Athlete[], kind: TackleKind,
  spot: Vec2, reason: 'tackle' | 'forwardProgress', vel: Vec2, dragYards?: number,
): void => {
  const dropback = carrier.side === 'offense' && carrier.id === env.qbId && !env.handoffDone && !env.pitched && state.pass === null
    && PASS_TYPES.has(state.ctx.offensivePlay.type);
  env.struggle = null;
  setTimedState(carrier, 'falling', FALL_SECONDS);
  carrier.vel = clone(vel);
  for (const t of [tackler, ...assists]) {
    setTimedState(t, 'falling', FALL_SECONDS);
    t.vel = clone(vel);
  }
  const rec: TackleRecord = { tackler: tackler.id, assists: assists.map((a) => a.id), kind, carrier: carrier.id, pos: clone(spot), tick: state.tick };
  env.lastTackle = rec;
  env.tackleRecords.push(rec);
  const ev = { type: 'tackle' as const, tick: state.tick, tackler: tackler.id, carrier: carrier.id, kind, assists: rec.assists };
  emit(state, dragYards !== undefined ? { ...ev, dragYards } : ev);
  const depth = depthOf(state, spot.y);
  if (dropback && depth < 0) {
    // Yards lost stop at the goal line: a sack in the end zone is a safety charged to the goal line, not beyond it.
    const yardsLost = Math.min(-depth, state.ctx.ballOn);
    env.sack = { by: tackler.id, assists: rec.assists, yardsLost };
    emit(state, { type: 'sack', tick: state.tick, by: tackler.id, assists: rec.assists, yardsLost });
  }
  carrierDown(state, env, carrier, spot, reason);
};

const members = (state: PlayState, s: StruggleState): { m: PileMember; a: Athlete }[] =>
  s.tacklers.map((m) => ({ m, a: findAthlete(state, m.id) })).filter((x): x is { m: PileMember; a: Athlete } => !!x.a);

/**
 * The recorded kind of a finished pile tackle: 'gang' only when more than one man brought him down (a hit stick keeps
 * its name); a lone tackler whose grab was read as a gang arrival made a plain wrap.
 */
export const pileKind = (pileSize: number, primary: TackleKind): TackleKind => {
  if (pileSize >= 2) return primary === 'hitStick' ? 'hitStick' : 'gang';
  return primary === 'gang' ? 'wrap' : primary;
};

/** Finishes the struggle in a tackle (or a forward-progress whistle) at the furthest point reached. */
const finish = (state: PlayState, env: EngineEnv, s: StruggleState, carrier: Athlete, reason: 'tackle' | 'forwardProgress'): void => {
  const d = attackDir(env, carrier.side);
  const pile = members(state, s);
  const primary = pile[0];
  if (!primary) return;
  const fwd = d * s.vel.y;
  const fall = reason === 'tackle' && fwd > STALL_SPEED ? Math.min(FALL_FORWARD_CAP, FALL_FORWARD_BASE + fwd * FALL_FORWARD_PER_SPEED) : 0;
  const reached = carrier.pos.y + d * fall;
  const bestY = d * (reached - s.bestY) > 0 ? reached : s.bestY;
  const drag = Math.max(0, Math.round(d * (bestY - s.startPos.y) * 10) / 10);
  takeDown(state, env, carrier, primary.a, pile.slice(1).map((p) => p.a), pileKind(pile.length, primary.m.kind), { x: carrier.pos.x, y: bestY }, reason, s.vel, drag);
};

/** The runner shakes everyone off: each defender who was hanging on is charged with a broken tackle. */
const breakFree = (state: PlayState, env: EngineEnv, s: StruggleState, carrier: Athlete, move: BreakMove): void => {
  const d = attackDir(env, carrier.side);
  env.struggle = null;
  for (const { a } of members(state, s)) {
    emit(state, { type: 'brokenTackle', tick: state.tick, carrier: carrier.id, defender: a.id, move });
    carrier.brokenTacklesThisPlay += 1;
    setTimedState(a, 'stumbling', 0.55);
    env.pairCooldown[pairKey(a.id, carrier.id)] = state.time + 0.6;
  }
  setTimedState(carrier, 'moving', 0);
  carrier.vel = { x: s.vel.x, y: s.vel.y + d * BREAK_BURST };
};

/** A defender in the pile punched the ball out. */
const strip = (state: PlayState, env: EngineEnv, s: StruggleState, carrier: Athlete, by: Athlete | null): void => {
  env.struggle = null;
  for (const { a } of members(state, s)) setTimedState(a, 'moving', 0);
  carrier.vel = clone(s.vel);
  looseBallFrom(state, env, carrier, by, { popSpeed: 2 });
  setTimedState(carrier, 'stumbling', 0.5);
};

/** Teammates of the runner leaning into the pile from behind (legal pile pushing). */
const pushersOf = (state: PlayState, env: EngineEnv, carrier: Athlete): Athlete[] => {
  const d = attackDir(env, carrier.side);
  return state.athletes.filter((m) => {
    if (m.side !== carrier.side || m.id === carrier.id || !canAct(m) || m.hasBall) return false;
    if (dist(m.pos, carrier.pos) > m.radius + carrier.radius + PUSH_REACH || d * (carrier.pos.y - m.pos.y) < -0.3) return false;
    const it = state.intents[m.id];
    return !!it && len(it.move) > 0.3 && (d * it.move.y) / len(it.move) > 0.3;
  });
};

/** Keeps a human tackler's grip while he holds the tackle (or strip) button; lets it slip otherwise. */
const humanGrip = (state: PlayState, env: EngineEnv, s: StruggleState, carrier: Athlete, dt: number): void => {
  const assist = clamp01(difficultyFor(state, otherSide(carrier.teamSide)).userTackleAssist ?? 0.5);
  for (const { m, a } of members(state, s)) {
    if (!a.controlled || !isHuman(state.ctx, a)) continue;
    const act = state.intents[a.id]?.action;
    if (act === 'tackle' || act === 'strip') continue;
    m.hold -= HUMAN_HOLD_DECAY * (1 - 0.5 * assist) * dt;
    if (m.hold > RELEASE_HOLD) continue;
    s.tacklers = s.tacklers.filter((x) => x.id !== a.id);
    emit(state, { type: 'brokenTackle', tick: state.tick, carrier: carrier.id, defender: a.id, move: 'none' });
    carrier.brokenTacklesThisPlay += 1;
    setTimedState(a, 'stumbling', 0.3);
    env.pairCooldown[pairKey(a.id, carrier.id)] = state.time + 0.6;
  }
};

/** Reads a break move off the runner's intent (juke / spin / stiff-arm / truck), one per BREAK_COOLDOWN. */
const breakAttempt = (state: PlayState, s: StruggleState, carrier: Athlete): void => {
  if (s.breakMove !== null && state.time >= s.breakUntil) {
    s.breakMove = null;
    s.failedBreaks += 1;
  }
  const act = state.intents[carrier.id]?.action;
  if (!act || !BREAK_MOVES.has(act) || state.time < s.nextBreakAt) return;
  const move = act as BreakMove;
  s.breakMove = move;
  s.breakUntil = state.time + BREAK_WINDOW;
  s.nextBreakAt = state.time + BREAK_COOLDOWN;
  emit(state, { type: 'specialMove', tick: state.tick, athlete: carrier.id, move });
};

/** Closest (share of the two radii) a teammate leaning into the pile gets to the runner. */
export const MATE_CLEARANCE = 0.9;

/**
 * The engine lets a runner's own teammates overlap him (handoffs, blockers he runs past); in a pile they are bodies
 * leaning on him: one who has walked into the runner is set back against him instead of through him.
 */
const keepMatesClear = (state: PlayState, carrier: Athlete): void => {
  for (const m of state.athletes) {
    if (!m.active || m.side !== carrier.side || m.id === carrier.id) continue;
    const min = (m.radius + carrier.radius) * MATE_CLEARANCE;
    const rel = { x: m.pos.x - carrier.pos.x, y: m.pos.y - carrier.pos.y };
    const d = len(rel);
    if (d >= min) continue;
    const dir = d > 1e-6 ? { x: rel.x / d, y: rel.y / d } : { x: 0, y: -1 };
    m.pos = { x: carrier.pos.x + dir.x * min, y: carrier.pos.y + dir.y * min };
  }
};

/** Moves the coupled pile one tick (runner, the men hanging on him and the ball). */
const movePile = (state: PlayState, env: EngineEnv, s: StruggleState, carrier: Athlete, pushers: readonly Athlete[], dt: number): void => {
  const d = attackDir(env, carrier.side);
  const cIntent = state.intents[carrier.id];
  const tired = 1 - 0.3 * clamp01(carrier.fatigue);
  const bodies: PileBody[] = [{ massLb: carrier.massLb, dir: cIntent?.move ?? { x: 0, y: 0 }, drive: legDrive(carrier) * CARRIER_DRIVE * tired * (cIntent?.sprint ? 1 : 0.85), carried: true }];
  for (const { m, a } of members(state, s)) bodies.push({ massLb: a.massLb, dir: state.intents[a.id]?.move ?? { x: 0, y: 0 }, drive: tacklerDrive(a, m.hold, m.kind), carried: true });
  for (const p of pushers) bodies.push({ massLb: p.massLb, dir: { x: 0, y: d }, drive: legDrive(p) * PUSHER_DRIVE, carried: false });
  s.vel = pileStep(s.vel, bodies, dt);
  carrier.pos = { x: s.pos.x + s.vel.x * dt, y: s.pos.y + s.vel.y * dt };
  carrier.vel = clone(s.vel);
  s.pos = clone(carrier.pos);
  for (const { m, a } of members(state, s)) {
    slideIn(m, HANG_SLIDE_SPEED * dt);
    a.pos = { x: carrier.pos.x + m.offset.x, y: carrier.pos.y + m.offset.y };
    a.vel = clone(s.vel);
    if (len(m.offset) > 1e-6) a.facing = Math.atan2(-m.offset.y, -m.offset.x);
  }
  keepMatesClear(state, carrier);
  if (state.ball.phase === 'held' && state.ball.carrierId === carrier.id) followCarrier(state.ball, carrier);
  const fwd = d * s.vel.y;
  if (d * (carrier.pos.y - s.bestY) > 0) s.bestY = carrier.pos.y;
  if (fwd > STALL_SPEED) s.stalled = 0;
  else s.stalled += dt * (fwd < -STALL_SPEED ? DRIVEN_BACK_RATE : 1);
};

/**
 * One tick of an ongoing struggle (joins are resolved by systems/tackle.ts first). Returns false when there is no
 * struggle any more (ended this tick or before).
 */
export const advanceStruggle = (state: PlayState, env: EngineEnv, dt = TICK_DT): boolean => {
  const s = env.struggle;
  if (!s) return false;
  const carrier = findAthlete(state, s.carrierId);
  if (state.phase !== 'live' || !carrier || !carrier.active || state.ball.phase !== 'held' || state.ball.carrierId !== carrier.id || carrier.state !== 'wrapped') {
    releasePile(state, env);
    return false;
  }
  s.tacklers = s.tacklers.filter((m) => findAthlete(state, m.id)?.state === 'wrapping');
  humanGrip(state, env, s, carrier, dt);
  if (s.tacklers.length === 0) {
    env.struggle = null;
    setTimedState(carrier, 'moving', 0);
    return false;
  }
  breakAttempt(state, s, carrier);
  const pushers = pushersOf(state, env, carrier);
  const from = clone(s.pos);
  const bestBefore = s.bestY;
  movePile(state, env, s, carrier, pushers, dt);
  const attack = attackDir(env, carrier.side);
  if (carrier.pos.x < 0 || carrier.pos.x > FIELD_WIDTH || carrier.pos.y < 0 || carrier.pos.y > FIELD_LENGTH) {
    // Out of bounds where he crossed the sideline (or his own end line); driven back out, he keeps his forward
    // progress (a runner held in the field of play and driven out the back of his end zone is no safety).
    const cross = crossingPoint(from, carrier.pos);
    const drivenBack = attack * (bestBefore - cross.y) > 0;
    const pile = members(state, s);
    const primary = pile[0];
    if (drivenBack && primary) {
      // His forward progress was stopped before he was driven out: he is down in the field of play at that spot (the
      // clock does not stop for an out of bounds), tackled by the men who drove him there.
      emit(state, { type: 'forwardProgressStopped', tick: state.tick, carrier: carrier.id, ballOn: ballOnAt(env, bestBefore) });
      const kind = pileKind(pile.length, primary.m.kind);
      const drag = Math.max(0, Math.round(attack * (bestBefore - s.startPos.y) * 10) / 10);
      takeDown(state, env, carrier, primary.a, pile.slice(1).map((m) => m.a), kind, { x: cross.x, y: bestBefore }, 'forwardProgress', s.vel, drag);
      return false;
    }
    const y = drivenBack ? bestBefore : cross.y;
    emit(state, { type: 'outOfBounds', tick: state.tick, athlete: carrier.id, ballOn: ballOnAt(env, y) });
    carrierDown(state, env, carrier, { x: cross.x, y }, 'outOfBounds');
    return false;
  }
  // Over the goal line (or the end line): live-rules rules on it.
  if (!inField(carrier.pos) || attack * (state.ball.pos.y - goalLineY(env, carrier.side)) >= 0) return true;
  const holds: PileHold[] = members(state, s).map(({ m, a }) => {
    const press = env.stripPress[a.id];
    const stripping = state.intents[a.id]?.action === 'strip' || (press !== undefined && state.time - press <= PILE_STRIP_WINDOW);
    return { tackler: a, hold: m.hold, kind: m.kind, stripping };
  });
  const roll = struggleTick({
    carrier, holds, heldFor: state.time - s.startedAt, breakMove: s.breakMove, failedBreaks: s.failedBreaks, pushers: pushers.length,
    ballSecurityAssist: carrier.controlled && isHuman(state.ctx, carrier) ? difficultyFor(state, carrier).userBallSecurityAssist : 0, dt,
  }, env.rng);
  switch (roll.result) {
    case 'strip': strip(state, env, s, carrier, roll.stripBy); return false;
    case 'break': breakFree(state, env, s, carrier, s.breakMove ?? 'none'); return false;
    case 'finish': finish(state, env, s, carrier, 'tackle'); return false;
    default: break;
  }
  if (s.stalled >= STOOD_UP_SECONDS) {
    emit(state, { type: 'forwardProgressStopped', tick: state.tick, carrier: carrier.id, ballOn: ballOnAt(env, s.bestY) });
    finish(state, env, s, carrier, 'forwardProgress');
    return false;
  }
  if (state.time - s.startedAt >= MAX_STRUGGLE_SECONDS) {
    finish(state, env, s, carrier, 'tackle');
    return false;
  }
  return true;
};
