import { clamp01, ratingToFactor } from '@/core/math';
import { clone, dist, len, type Vec2 } from '@/core/vec2';
import { fumbleBall, holdBall, type FumbleOptions } from '@/physics/ball';
import { findAthlete } from '../athlete';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_WIDTH } from '../types';
import { attackDir, ballOnAt, canAct, emit, inField, markDead, ownGoalLineY, takePossession, type EngineEnv, type FumbleRecord } from './env';

/**
 * Loose balls: fumbles, muffs, dropped pitches and snaps. The ball bounces (physics/ball.ts with the play rng),
 * any athlete on his feet who reaches it contests the recovery (hands, awareness, reaction), and the recovering
 * side may advance unless the rules say otherwise: on 4th down or inside the last two minutes only the fumbler
 * may advance an offensive fumble, and the kicking team never advances a muffed kick. A loose ball out of
 * bounds is dead at the spot (a forward fumble comes back to the fumble spot); one at rest for a while is
 * awarded to the last side in possession.
 */
export const LOOSE_REST_SECONDS = 1.5;
export const RECOVERY_REACH = 0.45;

const f = (r: number): number => ratingToFactor(r);

const lastTwoMinutes = (state: PlayState): boolean => (state.ctx.quarter === 2 || state.ctx.quarter >= 4) && state.ctx.clockRemaining <= 120;

/** Knocks the ball loose from `carrier`. Records the fumble (or muff for a kick) and emits the event. */
export const looseBallFrom = (state: PlayState, env: EngineEnv, carrier: Athlete, forcedBy: Athlete | null, opts: FumbleOptions = {}): void => {
  // A muff is a kick that was never secured; once the returner has fielded it (the ball is held) it is a fumble.
  const muff = (state.ball.kind === 'kickoff' || state.ball.kind === 'punt') && state.ball.phase !== 'held';
  state.ball = fumbleBall(state.ball, carrier, env.rng, state.tick, opts);
  for (const a of state.athletes) a.hasBall = false;
  const rec: FumbleRecord = { carrierId: carrier.id, carrierSide: carrier.side, forcedBy: forcedBy?.id ?? null, pos: clone(carrier.pos), tick: state.tick, recoveredBy: null, recoverySide: null, muff };
  env.fumbles.push(rec);
  env.stallTime = 0;
  if (muff) {
    env.muffed = true;
    emit(state, { type: 'muff', tick: state.tick, by: carrier.id });
    return;
  }
  const forward = attackDir(env, carrier.side) * state.ball.vel.y > 0;
  emit(state, { type: 'fumble', tick: state.tick, carrier: carrier.id, forcedBy: forcedBy?.id ?? null, ballOn: ballOnAt(env, carrier.pos.y), forward });
};

/** A snap / pitch / lateral that hit the turf untouched is a live fumble charged to the thrower. */
export const recordLooseToss = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const who = findAthlete(state, ball.throwerId) ?? findAthlete(state, ball.targetId);
  ball.kind = 'fumble';
  if (!who) return;
  const rec: FumbleRecord = { carrierId: who.id, carrierSide: who.side, forcedBy: null, pos: clone(ball.pos), tick: state.tick, recoveredBy: null, recoverySide: null };
  env.fumbles.push(rec);
  env.stallTime = 0;
  emit(state, { type: 'fumble', tick: state.tick, carrier: who.id, forcedBy: null, ballOn: ballOnAt(env, ball.pos.y), forward: false });
};

/** Chance an athlete secures a loose ball he has reached. */
export const recoveryChance = (a: Athlete): number => clamp01(0.4 + 0.35 * f(a.attrs.hands) + 0.15 * f(a.attrs.awareness) + (a.state === 'diving' ? 0.1 : 0));

const recover = (state: PlayState, env: EngineEnv, a: Athlete, rec: FumbleRecord): void => {
  state.ball = holdBall(state.ball, a.id, state.tick, 'handoff');
  rec.recoveredBy = a.id;
  rec.recoverySide = a.side;
  takePossession(state, env, a);
  if (a.state === 'idle' || a.state === 'stumbling') a.state = 'moving';
  const kickPlay = state.ctx.special === 'kickoff' || state.ctx.special === 'onside' || state.ctx.special === 'punt';
  const sameSide = a.side === rec.carrierSide;
  const restricted = sameSide && a.side === 'offense' && a.id !== rec.carrierId && (state.ctx.down === 4 || lastTwoMinutes(state));
  // The kicking team may not advance a muff; a returner's fumble after the catch is a live ball like any other.
  const kickingTeam = kickPlay && a.side === 'offense' && rec.muff === true;
  const advanced = !restricted && !kickingTeam;
  emit(state, { type: 'recovery', tick: state.tick, by: a.id, side: a.side, ballOn: ballOnAt(env, a.pos.y), advanced });
  if (!advanced) markDead(state, env, 'fumbleRecovered', restricted ? rec.pos : a.pos);
};

const looseOutOfBounds = (state: PlayState, env: EngineEnv, rec: FumbleRecord | undefined): void => {
  const ball = state.ball;
  const side = rec?.carrierSide ?? env.possession;
  const attack = attackDir(env, side);
  const clamped: Vec2 = { x: Math.max(0, Math.min(FIELD_WIDTH, ball.pos.x)), y: ball.pos.y };
  const forward = rec !== undefined && attack * (ball.pos.y - rec.pos.y) > 0;
  const spot = forward && rec ? clone(rec.pos) : clamped;
  const own = ownGoalLineY(env, side);
  emit(state, { type: 'outOfBounds', tick: state.tick, athlete: null, ballOn: ballOnAt(env, spot.y) });
  if (attack * (spot.y - own) <= 0) {
    const muff = env.kick !== null && env.kick.fieldedBy === null && side === 'defense';
    if (muff) {
      emit(state, { type: 'touchback', tick: state.tick });
      markDead(state, env, 'touchback', { x: spot.x, y: own });
      return;
    }
    emit(state, { type: 'safety', tick: state.tick });
    markDead(state, env, 'safety', { x: spot.x, y: own });
    return;
  }
  markDead(state, env, 'fumbleOutOfBounds', spot);
};

/** One tick of loose-ball resolution (fumbles only; loose kicks are the kick-flight system's). */
export const fumbleSystem = (state: PlayState, env: EngineEnv, dt: number): void => {
  const ball = state.ball;
  if (state.phase !== 'live' || ball.phase !== 'loose' || ball.kind !== 'fumble') return;
  const rec = env.fumbles[env.fumbles.length - 1];
  if (!inField(ball.pos)) {
    looseOutOfBounds(state, env, rec);
    return;
  }
  const rng = env.rng;
  const cands = state.athletes
    .filter((a) => (canAct(a) || a.state === 'diving') && ball.z <= 1.6 && dist(a.pos, ball.pos) <= a.radius + RECOVERY_REACH && (env.recoveryCooldown[a.id] ?? 0) <= state.time)
    .map((a) => ({ a, score: f(a.attrs.reaction) + rng.next() * 0.3 }))
    .sort((p, q) => q.score - p.score);
  for (const { a } of cands) {
    if (rng.chance(recoveryChance(a))) {
      if (rec) recover(state, env, a, rec);
      else {
        state.ball = holdBall(ball, a.id, state.tick, 'handoff');
        takePossession(state, env, a);
      }
      return;
    }
    env.recoveryCooldown[a.id] = state.time + 0.4;
  }
  if (ball.z <= 0 && len(ball.vel) < 0.2) {
    env.stallTime += dt;
    if (env.stallTime >= LOOSE_REST_SECONDS) markDead(state, env, 'fumbleRecovered', ball.pos);
  } else env.stallTime = 0;
};
