import { clamp01, ratingToFactor } from '@/core/math';
import { clone, dist, len } from '@/core/vec2';
import { holdBall, predictLanding } from '@/physics/ball';
import { pointSegmentDistance } from '@/physics/collision';
import { reachHeight, standingReach } from '@/physics/contact';
import { autoReturning } from '../auto-return';
import { makePenalty } from '../outcome-factory';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_LENGTH, FIELD_WIDTH } from '../types';
import { ballOnAt, canAct, emit, goalLineY, inField, markDead, takePossession, type EngineEnv, type KickRecord } from './env';
import { looseBallFrom, recoveryChance } from './fumble';

/**
 * A kicked ball in the air or on the turf. The receiving side fields it (fair catch, catch, muff), lets it
 * bounce (the kicking team downs a punt; a kickoff that stops is the receiving team's at the spot; the kicking
 * team recovers an onside / kickoff past 10 yd), or watches it into the end zone (touchback) or out of bounds
 * (dead at the spot; a kickoff out of bounds is flagged). Field goals end when the ball passes the end line.
 */
export const KICK_REST_SECONDS = 1.0;
export const ONSIDE_MIN_YARDS = 10;
export const KICKOFF_OOB_RECEIVING_LINE = 40;
export const AUTO_KNEEL_DEPTH = 3;

const f = (r: number): number => ratingToFactor(r);
const reachOf = (a: Athlete): number => (a.state === 'jumping' ? reachHeight(a) : standingReach(a) + 0.2);

const touchback = (state: PlayState, env: EngineEnv, x: number): void => {
  emit(state, { type: 'touchback', tick: state.tick });
  markDead(state, env, 'touchback', { x, y: goalLineY(env, 'offense') });
};

const inReceivingEndZone = (env: EngineEnv, y: number): boolean => env.dir * (y - goalLineY(env, 'offense')) >= 0;

const field = (state: PlayState, env: EngineEnv, k: KickRecord, r: Athlete): void => {
  state.ball = holdBall(state.ball, r.id, state.tick, state.ball.kind);
  takePossession(state, env, r);
  k.fieldedBy = r.id;
  k.landing = clone(r.pos);
  k.returnStart = clone(r.pos);
  if (r.state === 'idle') r.state = 'moving';
  if (inReceivingEndZone(env, r.pos.y)) {
    const depth = env.dir * (r.pos.y - goalLineY(env, 'offense'));
    if ((!r.controlled || autoReturning(r, state)) && depth >= AUTO_KNEEL_DEPTH) touchback(state, env, r.pos.x);
  }
};

/** Airborne kick reaching an athlete: fair catch, catch, muff, or the kicking team downing a punt. */
const tryField = (state: PlayState, env: EngineEnv, k: KickRecord): void => {
  const ball = state.ball;
  if (ball.vz >= 0) return;
  const end = predictLanding(ball, state.ctx.weather, 0.3).pos;
  const reach = (a: Athlete): number => pointSegmentDistance(a.pos, ball.pos, end);
  const cands = state.athletes
    .filter((a) => (canAct(a) || a.state === 'diving') && ball.z <= reachOf(a) && reach(a) <= 1.0 + 0.3 * f(a.attrs.catching) + (a.assignment.type === 'returner' ? 0.3 : 0))
    .sort((p, q) => reach(p) - reach(q));
  const a = cands[0];
  if (!a) return;
  if (a.side === 'offense') {
    if (k.kind === 'punt') {
      k.landing = clone(ball.pos);
      k.touchedByKickingTeam = true;
      emit(state, { type: 'downed', tick: state.tick, by: a.id, ballOn: ballOnAt(env, ball.pos.y) });
      markDead(state, env, 'kickDowned', ball.pos);
    }
    return;
  }
  if (env.fairCatchSignal[a.id]) {
    state.ball = holdBall(ball, a.id, state.tick, ball.kind);
    takePossession(state, env, a);
    k.fieldedBy = a.id;
    k.landing = clone(a.pos);
    emit(state, { type: 'fairCatch', tick: state.tick, by: a.id });
    if (inReceivingEndZone(env, a.pos.y)) touchback(state, env, a.pos.x);
    else markDead(state, env, 'fairCatch', a.pos);
    return;
  }
  // A clean, uncontested catch is secure; the muff is a pressured catch (a coverage man on him as it arrives) or a
  // diving one, more often on a punt and for poorer hands.
  const pressured = state.athletes.some((d) => d.active && d.side !== a.side && dist(d.pos, a.pos) <= 2.5);
  const risky = pressured || a.state === 'diving';
  const p = clamp01(risky ? 0.9 + 0.06 * f(a.attrs.hands) - (k.kind === 'punt' ? 0.02 : 0) - (a.state === 'diving' ? 0.15 : 0) : 0.995);
  if (env.rng.chance(p)) field(state, env, k, a);
  else {
    k.landing = clone(a.pos);
    looseBallFrom(state, env, a, null, { popSpeed: 1.5 });
  }
};

/** A kick on the turf: kicking team downs / recovers it, receiving team picks it up, or it comes to rest. */
const looseKick = (state: PlayState, env: EngineEnv, k: KickRecord, dt: number): void => {
  const ball = state.ball;
  const traveled = env.dir * (ball.pos.y - k.kickSpot.y);
  const near = state.athletes
    .filter((a) => (canAct(a) || a.state === 'diving') && ball.z <= 1.6 && dist(a.pos, ball.pos) <= a.radius + 0.45 && (env.recoveryCooldown[a.id] ?? 0) <= state.time)
    .sort((p, q) => dist(p.pos, ball.pos) - dist(q.pos, ball.pos));
  for (const a of near) {
    if (a.side === 'offense') {
      k.touchedByKickingTeam = true;
      if (k.kind === 'punt' || traveled < ONSIDE_MIN_YARDS) {
        emit(state, { type: 'downed', tick: state.tick, by: a.id, ballOn: ballOnAt(env, ball.pos.y) });
        markDead(state, env, 'kickDowned', ball.pos);
        return;
      }
      if (env.rng.chance(recoveryChance(a))) {
        state.ball = holdBall(ball, a.id, state.tick, ball.kind);
        takePossession(state, env, a);
        emit(state, { type: 'onsideRecovery', tick: state.tick, by: a.id, side: 'offense' });
        markDead(state, env, 'onsideRecovered', a.pos);
        return;
      }
      env.recoveryCooldown[a.id] = state.time + 0.4;
      continue;
    }
    if (env.rng.chance(recoveryChance(a))) {
      field(state, env, k, a);
      emit(state, { type: 'recovery', tick: state.tick, by: a.id, side: 'defense', ballOn: ballOnAt(env, a.pos.y), advanced: true });
      return;
    }
    env.recoveryCooldown[a.id] = state.time + 0.4;
  }
  if (ball.z <= 0 && len(ball.vel) < 0.2) {
    env.stallTime += dt;
    if (env.stallTime >= KICK_REST_SECONDS) {
      const cover = state.athletes.filter((a) => a.side === 'offense' && a.active).sort((p, q) => dist(p.pos, ball.pos) - dist(q.pos, ball.pos))[0];
      if (cover) emit(state, { type: 'downed', tick: state.tick, by: cover.id, ballOn: ballOnAt(env, ball.pos.y) });
      markDead(state, env, 'kickDowned', ball.pos);
    }
  } else env.stallTime = 0;
};

const kickOutOfBounds = (state: PlayState, env: EngineEnv, k: KickRecord): void => {
  const ball = state.ball;
  const endLine = env.dir === 1 ? FIELD_LENGTH : 0;
  if (env.dir * (ball.pos.y - endLine) >= 0 && ball.pos.x >= 0 && ball.pos.x <= FIELD_WIDTH) {
    touchback(state, env, ball.pos.x);
    return;
  }
  const spot = { x: Math.max(0, Math.min(FIELD_WIDTH, ball.pos.x)), y: Math.max(0, Math.min(FIELD_LENGTH, ball.pos.y)) };
  k.landing = clone(spot);
  emit(state, { type: 'outOfBounds', tick: state.tick, athlete: null, ballOn: ballOnAt(env, spot.y) });
  if (k.kind === 'kickoff' || k.kind === 'onside') {
    const receivingSpot = 100 - ballOnAt(env, spot.y);
    const p = makePenalty('illegalTouching', { side: 'offense', yards: Math.max(0, KICKOFF_OOB_RECEIVING_LINE - receivingSpot), enforcement: 'endOfPlay', replayDown: false, deadBall: false, playerId: null });
    env.penalties.push(p);
    emit(state, { type: 'penalty', tick: state.tick, penalty: p });
  }
  markDead(state, env, 'outOfBounds', spot);
};

/** Seconds a human returner may stand in his end zone with the ball before it counts as taking a knee. */
export const END_ZONE_KNEEL_SECONDS = 0.6;

/**
 * A human returner who fields a kick in his own end zone and does not bring it out (no stick toward the field) takes
 * a knee after END_ZONE_KNEEL_SECONDS: a touchback, as the AI returner does. One who has already been out in the field
 * of play and came back is not covered (that is his own doing: a safety if he is downed there).
 */
const humanEndZoneKneel = (state: PlayState, env: EngineEnv, k: KickRecord, dt: number): void => {
  const r = k.fieldedBy !== null && state.ball.carrierId === k.fieldedBy ? state.athletes.find((a) => a.id === k.fieldedBy) : undefined;
  if (!r || !r.controlled || state.ctx.controllers[r.teamSide] !== 'human' || r.side !== 'defense' || r.state === 'wrapped') return;
  // Out means his BODY has been in the field of play since the catch (env.ownZone): the ball in his hands sits a yard
  // in front of him, so a catch just inside the end zone would otherwise read as already out.
  const out = env.ownZone ? env.ownZone.left : state.forwardProgressY !== null && env.dir * (state.forwardProgressY - goalLineY(env, 'offense')) < 0;
  if (out || !inReceivingEndZone(env, r.pos.y)) {
    k.endZoneIdle = 0;
    return;
  }
  const move = state.intents[r.id]?.move;
  // Heading out of the end zone (toward the kicking team's goal) is a return; standing or drifting is a knee.
  const headingOut = !!move && -env.dir * move.y > 0.3;
  k.endZoneIdle = headingOut ? 0 : (k.endZoneIdle ?? 0) + dt;
  if (k.endZoneIdle >= END_ZONE_KNEEL_SECONDS) {
    emit(state, { type: 'kneel', tick: state.tick, athlete: r.id });
    touchback(state, env, r.pos.x);
  }
};

/** One tick of kick flight / fielding. */
export const kickFlightSystem = (state: PlayState, env: EngineEnv, dt: number): void => {
  const k = env.kick;
  if (!k || k.blocked || state.phase !== 'live') return;
  const ball = state.ball;
  if (k.kind === 'fieldGoal' || k.kind === 'extraPoint') {
    const endLine = env.dir === 1 ? FIELD_LENGTH : 0;
    if (env.dir * (ball.pos.y - endLine) >= 0 || ball.phase === 'loose' || state.tick - k.kickTick > 210) {
      k.landing = clone(ball.pos);
      markDead(state, env, k.made ? 'kickMade' : 'kickMissed', k.kickSpot);
    }
    return;
  }
  if (ball.phase === 'held') {
    humanEndZoneKneel(state, env, k, dt);
    return;
  }
  if (ball.kind === 'fumble') return;
  if (k.landing === null && (env.ballStep.hitGround || ball.phase === 'loose')) k.landing = clone(ball.pos);
  if (!inField(ball.pos)) {
    kickOutOfBounds(state, env, k);
    return;
  }
  if (inReceivingEndZone(env, ball.pos.y) && (ball.phase === 'loose' || ball.z <= 0)) {
    touchback(state, env, ball.pos.x);
    return;
  }
  if (ball.phase === 'inAir') {
    tryField(state, env, k);
    return;
  }
  looseKick(state, env, k, dt);
};
