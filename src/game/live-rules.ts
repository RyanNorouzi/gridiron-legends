import { dist, len, type Vec2 } from '@/core/vec2';
import { ballCarrier } from './athlete';
import type { Athlete, PlayState } from './play-types';
import { FIELD_LENGTH, FIELD_WIDTH } from './types';
import { attackDir, ballOnAt, carrierDown, emit, goalLineY, inField, markDead, progressSpot, trackOwnZone, GOAL_REVIEW_MARGIN, type EngineEnv } from './systems/env';
import { isPasserBehindLine, takeDown } from './systems/tackle-struggle';

/**
 * Per-tick rules for a live ball: the carrier stepping out (dead where he crossed), the ball breaking the plane
 * of the goal line (touchdown, reviewable when a tackle was in progress), safeties and touchbacks (via
 * carrierDown), the first-down marker, forward progress (a wrapped carrier stopped or driven back for
 * FORWARD_PROGRESS_SECONDS is spotted at his furthest point), a pass sailing out of bounds (incomplete), and
 * two safety nets that never fire in a normal play: a carrier standing still untouched for STALL_SECONDS and
 * a live play longer than LIVE_TIME_CAP. A passer standing in the pocket behind the line with the ball (reading the
 * field, aiming a pull-back throw behind a line that holds) is not a stalled runner: the stall net never runs on him,
 * and a passer held there until forward progress is whistled is sacked by the defender on him.
 */
export const FORWARD_PROGRESS_SECONDS = 0.6;
export const STALL_SECONDS = 5;
export const LIVE_TIME_CAP = 30;
export const CONTACT_RECENT = 0.3;

/** Point where the segment prev -> pos crosses the field boundary (clamped to the field). */
export const crossingPoint = (prev: Vec2, pos: Vec2): Vec2 => {
  let t = 1;
  const dx = pos.x - prev.x;
  const dy = pos.y - prev.y;
  if (pos.x < 0 && dx < 0) t = Math.min(t, (0 - prev.x) / dx);
  if (pos.x > FIELD_WIDTH && dx > 0) t = Math.min(t, (FIELD_WIDTH - prev.x) / dx);
  if (pos.y < 0 && dy < 0) t = Math.min(t, (0 - prev.y) / dy);
  if (pos.y > FIELD_LENGTH && dy > 0) t = Math.min(t, (FIELD_LENGTH - prev.y) / dy);
  t = Math.max(0, Math.min(1, t));
  return { x: Math.max(0, Math.min(FIELD_WIDTH, prev.x + dx * t)), y: Math.max(0, Math.min(FIELD_LENGTH, prev.y + dy * t)) };
};

/** Reach (yd, centre to centre) within which a defender is the man holding a passer whistled down in the pocket. */
export const POCKET_HOLD_REACH = 1.6;

/** The defender on a passer stopped in the pocket (nearest active one within POCKET_HOLD_REACH), or null. */
const passerHeldBy = (state: PlayState, carrier: Athlete): Athlete | null => {
  let best: Athlete | null = null;
  for (const d of state.athletes) {
    if (!d.active || d.side === carrier.side || d.state === 'down' || d.state === 'engaged') continue;
    const r = dist(d.pos, carrier.pos);
    if (r <= POCKET_HOLD_REACH && (!best || r < dist(best.pos, carrier.pos))) best = d;
  }
  return best;
};

const carrierRules = (state: PlayState, env: EngineEnv, carrier: Athlete, dt: number): void => {
  const ball = state.ball;
  const attack = attackDir(env, carrier.side);
  const prev = env.tracks[carrier.id]?.prev ?? carrier.pos;
  if (!inField(carrier.pos)) {
    const spot = crossingPoint(prev, carrier.pos);
    emit(state, { type: 'outOfBounds', tick: state.tick, athlete: carrier.id, ballOn: ballOnAt(env, spot.y) });
    carrierDown(state, env, carrier, spot, 'outOfBounds');
    return;
  }
  const goal = goalLineY(env, carrier.side);
  const across = attack * (ball.pos.y - goal);
  if (across >= 0) {
    if (across < GOAL_REVIEW_MARGIN && carrier.contactTimer < 0.15 && env.review === null) {
      env.review = {
        call: { kind: 'touchdown', tick: state.tick, athleteId: carrier.id, confidence: 0.55 + 0.45 * (across / GOAL_REVIEW_MARGIN) },
        alternate: { deadReason: 'tackle', deadSpot: { x: carrier.pos.x, y: goal - attack * 0.4 }, wipeCompletion: false },
      };
    }
    carrierDown(state, env, carrier, ball.pos, 'touchdown');
    return;
  }
  trackOwnZone(state, env, carrier);
  if (carrier.id === env.qbId && state.pass === null && !env.handoffDone && !env.pitched) {
    const depth = attack * (carrier.pos.y - state.losY);
    if (!env.qbDrop) env.qbDrop = { start: depth, deepest: depth };
    else env.qbDrop.deepest = Math.min(env.qbDrop.deepest, depth);
  }
  if (state.forwardProgressY === null || attack * (ball.pos.y - state.forwardProgressY) > 0) state.forwardProgressY = ball.pos.y;
  const kickPlay = state.ctx.special === 'kickoff' || state.ctx.special === 'onside' || state.ctx.special === 'punt';
  if (carrier.side === 'offense' && env.possession === 'offense' && !env.firstDownFlagged && !kickPlay && env.dir * (ball.pos.y - state.firstDownY) >= 0) {
    env.firstDownFlagged = true;
    emit(state, { type: 'firstDown', tick: state.tick });
  }
  const speed = len(carrier.vel);
  const wrapped = carrier.contactTimer < CONTACT_RECENT;
  const drivenBack = state.forwardProgressY !== null && attack * (ball.pos.y - state.forwardProgressY) < -0.1;
  if (wrapped && (speed < 1.0 || drivenBack)) env.progressStallTime += dt;
  else env.progressStallTime = 0;
  const pocket = isPasserBehindLine(state, env, carrier);
  if (env.progressStallTime >= FORWARD_PROGRESS_SECONDS) {
    const spot = progressSpot(state, env, carrier);
    const by = pocket ? passerHeldBy(state, carrier) : null;
    if (by) takeDown(state, env, carrier, by, [], 'wrap', spot, 'forwardProgress', { x: 0, y: 0 });
    else carrierDown(state, env, carrier, spot, 'forwardProgress');
    return;
  }
  if (speed < 0.3 && !wrapped && !pocket) env.stallTime += dt;
  else env.stallTime = 0;
  if (env.stallTime >= STALL_SECONDS) carrierDown(state, env, carrier, carrier.pos, 'forwardProgress');
};

/** One tick of live rules. */
export const liveRules = (state: PlayState, env: EngineEnv, dt: number): void => {
  if (state.phase !== 'live') return;
  env.liveTime += dt;
  const ball = state.ball;
  if (ball.phase === 'held') {
    const carrier = ballCarrier(state);
    if (carrier && carrier.active) carrierRules(state, env, carrier, dt);
  } else if (ball.phase === 'inAir' && (ball.kind === 'pass' || ball.kind === 'tip') && !inField(ball.pos)) {
    emit(state, { type: 'incomplete', tick: state.tick, reason: 'outOfBounds', target: state.pass?.targetId ?? null, defender: null });
    markDead(state, env, 'incomplete', { x: state.snapX, y: state.losY });
  }
  if (state.phase === 'live' && env.liveTime > LIVE_TIME_CAP) markDead(state, env, 'timeExpired', ball.pos);
};
