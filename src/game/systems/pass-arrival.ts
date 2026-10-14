import { clamp01, ratingToFactor } from '@/core/math';
import { clone, dist } from '@/core/vec2';
import { holdBall, predictLanding, tipBall } from '@/physics/ball';
import { pointSegmentDistance } from '@/physics/collision';
import { catchContest, CONTEST_RADIUS, reachHeight, standingReach, type CatchOutcome } from '@/physics/contact';
import { findAthlete } from '../athlete';
import type { AthleteId, IncompleteReason, ThrowType } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_WIDTH } from '../types';
import { ballOnAt, depthOf, emit, isHuman, markDead, setTimedState, takePossession, type EngineEnv } from './env';
import { cpuPickScale, difficultyFor } from '../difficulty-sides';

/**
 * Pass arrival. While the ball climbs, defenders at the line who play the ball may bat it. On the way down the
 * nearest athlete who can reach it resolves the play: a receiver runs catchContest against the defenders
 * within CONTEST_RADIUS (jump/swat intents count through the 'jumping' state), a lone defender attempts the
 * interception. Only eligible receivers may catch an untouched pass; once a defender tips it anyone may. A ball that
 * lands untouched is incomplete. Sideline catches
 * need the receiver's centre inside by SIDELINE_INSIDE and produce a reviewable 'catch' call when close.
 */
export const SIDELINE_INSIDE = 0.25;
export const SIDELINE_REVIEW_BAND = 0.75;
export const BAT_RADIUS = 0.9;

const f = (r: number): number => ratingToFactor(r);

const catchRadius = (state: PlayState, a: Athlete, targeted: boolean): number =>
  1.0 + 0.35 * f(a.attrs.catching) + (a.state === 'diving' ? 0.5 : 0) + (targeted ? 0.15 : 0) +
  (a.controlled && a.side === 'offense' && isHuman(state.ctx, a) ? 0.6 * difficultyFor(state, a).userPassAssist : 0);

const reachOf = (a: Athlete): number => (a.state === 'jumping' ? reachHeight(a) : standingReach(a) + 0.2);

/** Share of off-target balls (passing.ts bad balls) the intended receiver still catches. */
export const ERRANT_CATCH_SHARE = 0.12;

/** Seconds a receiver spends securing a catch (tucking it before the burst; physics/movement 'catching' profile). */
export const SECURE_CATCH_SECONDS = 0.45;

/** Lowest height an athlete still gathers a ball at (below it the pass is on the turf). */
export const LOW_CATCH_Z = 0.3;

/**
 * Horizontal distance from an athlete to the rest of the ball's descent (from its current spot to where it
 * reaches LOW_CATCH_Z): a catch is judged on the whole path, not on one tick's sample.
 */
export const descentDistance = (state: PlayState, a: Athlete): number => {
  const ball = state.ball;
  const end = predictLanding(ball, state.ctx.weather, LOW_CATCH_Z).pos;
  return pointSegmentDistance(a.pos, ball.pos, end);
};

const losSpot = (state: PlayState): { x: number; y: number } => ({ x: state.snapX, y: state.losY });

const incomplete = (state: PlayState, env: EngineEnv, reason: IncompleteReason, target: AthleteId | null, defender: AthleteId | null): void => {
  emit(state, { type: 'incomplete', tick: state.tick, reason, target, defender });
  markDead(state, env, 'incomplete', losSpot(state));
};

const complete = (state: PlayState, env: EngineEnv, r: Athlete, out: CatchOutcome): void => {
  state.ball = holdBall(state.ball, r.id, state.tick, 'pass');
  takePossession(state, env, r);
  state.firstContactY = null;
  env.completion = { receiverId: r.id, tick: state.tick, pos: clone(r.pos), airYards: depthOf(state, r.pos.y), contested: out.contested, catchKind: out.catchKind };
  setTimedState(r, 'catching', SECURE_CATCH_SECONDS);
  emit(state, { type: 'catch', tick: state.tick, receiver: r.id, contested: out.contested, catchKind: out.catchKind, ballOn: ballOnAt(env, r.pos.y) });
  const inside = Math.min(r.pos.x, FIELD_WIDTH - r.pos.x) - SIDELINE_INSIDE;
  if (inside < SIDELINE_REVIEW_BAND && env.review === null) {
    env.review = {
      call: { kind: 'catch', tick: state.tick, athleteId: r.id, confidence: 0.55 + 0.45 * clamp01(inside / SIDELINE_REVIEW_BAND) },
      alternate: { deadReason: 'incomplete', deadSpot: losSpot(state), wipeCompletion: true },
    };
  }
};

const intercept = (state: PlayState, env: EngineEnv, d: Athlete): void => {
  state.ball = holdBall(state.ball, d.id, state.tick, 'pass');
  takePossession(state, env, d);
  env.interception = { by: d.id, pos: clone(d.pos), tick: state.tick };
  if (d.state === 'idle' || d.state === 'jumping') d.state = 'moving';
  emit(state, { type: 'interception', tick: state.tick, defender: d.id, ballOn: ballOnAt(env, d.pos.y) });
};

/**
 * Share of his hands-based pick chance a defender keeps for what he DECIDED to do with the ball: going for the
 * interception (a 'jump' intent: the AI's ball-hawk call, which is where interceptionAwareness lives, or the user's
 * button), swatting it down, or never playing it at all (the ball simply arrives on a man who has not turned to it).
 * The roll itself is ratings only; difficulty never touches it.
 */
export const PLAY_BALL_SHARE = { goForIt: 1.2, swat: 0.45, unaware: 0.7 } as const;

/** What a defender decided to do with an arriving ball, read from his intent this tick. */
export const ballDecisionShare = (state: PlayState, d: Athlete): number => {
  const action = state.intents[d.id]?.action;
  return action === 'jump' ? PLAY_BALL_SHARE.goForIt : action === 'swat' ? PLAY_BALL_SHARE.swat : PLAY_BALL_SHARE.unaware;
};

/**
 * Share of the balls a lone defender who gets to the ball first (and does not pick it) knocks away; the rest get
 * past him (a late hand, a ball through his arms) and the receiver can still make the play.
 */
export const LONE_BREAKUP = 0.5;
/** Scale on a lone defender's pick chance at the one play he gets at the ball. */
export const LONE_PICK_SCALE = 1.35;

/**
 * A lone defender reaching the ball: pick it or knock it down (hands/catching, scaled by his decision). He gets one
 * play at each ball in flight (a new flight after a tip is a new chance), not a fresh roll every other tick while
 * the ball drops through his reach.
 */
const interceptionAttempt = (state: PlayState, env: EngineEnv, d: Athlete, target: AthleteId | null): void => {
  const key = `arr:${d.id}:${state.ball.launchTick}`;
  if (env.contactPairs[key] !== undefined) return;
  // Most balls a defender gets to are knocked away; the pick is the exception (~1 in 3 for good hands going for it).
  let p = LONE_PICK_SCALE * (0.05 + 0.18 * f(d.attrs.hands) + 0.07 * f(d.attrs.catching)) * ballDecisionShare(state, d);
  if (d.state === 'jumping') p *= 1.15;
  if (state.ball.isTipped) p *= 0.9;
  p *= cpuPickScale(state.ctx, d.teamSide);
  if (env.rng.chance(clamp01(p))) {
    intercept(state, env, d);
    return;
  }
  if (env.rng.chance(LONE_BREAKUP)) {
    incomplete(state, env, 'defended', target, d.id);
    return;
  }
  env.contactPairs[key] = state.tick;
};

const receiverContest = (state: PlayState, env: EngineEnv, r: Athlete, throwType: ThrowType): void => {
  const defenders = state.athletes.filter((d) => d.active && d.side !== r.side && dist(d.pos, r.pos) <= CONTEST_RADIUS);
  const assist = r.controlled && isHuman(state.ctx, r) ? difficultyFor(state, r).userPassAssist : 0;
  const out = catchContest(r, defenders, state.ball.z, throwType, env.rng, assist, (d) => ballDecisionShare(state, d), (d) => cpuPickScale(state.ctx, d.teamSide));
  if (!out.reachable) {
    incomplete(state, env, 'overthrown', r.id, out.defenderId);
    return;
  }
  // An off-target ball (passing.ts errantPass) reaches him on the wrong shoulder, at his shoetops or over his head:
  // only now and then does he get both hands to it.
  const errant = env.errantPass ?? 0;
  if (out.result === 'catch' && errant !== 0 && state.ball.kind === 'pass' && !state.ball.isTipped && state.ball.targetId === r.id && !env.rng.chance(ERRANT_CATCH_SHARE)) {
    // A sailed ball goes on to whoever is behind him: a covering defender there gets his play at it.
    const behind = errant > 0 ? defenders.filter((d) => d.active && canCatchForwardPass(d, true)).sort((p, q) => dist(p.pos, state.ball.pos) - dist(q.pos, state.ball.pos))[0] : undefined;
    const before = state.events.length;
    if (behind) interceptionAttempt(state, env, behind, r.id);
    if (!state.events.slice(before).some((e) => e.type === 'interception' || e.type === 'incomplete')) incomplete(state, env, errant > 0 ? 'overthrown' : 'underthrown', r.id, null);
    return;
  }
  switch (out.result) {
    case 'catch':
      if (Math.min(r.pos.x, FIELD_WIDTH - r.pos.x) < SIDELINE_INSIDE) incomplete(state, env, 'outOfBounds', r.id, null);
      else complete(state, env, r, out);
      break;
    case 'drop':
      incomplete(state, env, 'drop', r.id, null);
      break;
    case 'defended':
      incomplete(state, env, 'defended', r.id, out.defenderId);
      break;
    case 'tip': {
      const by = out.defenderId ?? r.id;
      tipBall(state.ball, by, env.rng);
      emit(state, { type: 'tipped', tick: state.tick, by });
      break;
    }
    case 'interception': {
      const d = findAthlete(state, out.defenderId);
      if (d) intercept(state, env, d);
      else incomplete(state, env, 'defended', r.id, null);
      break;
    }
  }
};

/** Batting at the line while the ball climbs (defenders playing the ball). */
const tryBat = (state: PlayState, env: EngineEnv): boolean => {
  const ball = state.ball;
  if (state.tick - ball.launchTick < 2) return false;
  for (const d of state.athletes) {
    if (!d.active || d.side === 'offense' || dist(d.pos, ball.pos) > BAT_RADIUS || ball.z > reachHeight(d)) continue;
    const it = state.intents[d.id];
    if (d.state !== 'jumping' && it?.action !== 'swat' && it?.action !== 'jump') continue;
    if (!env.rng.chance(0.5)) continue;
    tipBall(ball, d.id, env.rng);
    emit(state, { type: 'tipped', tick: state.tick, by: d.id });
    return true;
  }
  return false;
};

/** Whether a defender has touched the pass in flight (after which every player may catch it). */
export const touchedByDefense = (state: PlayState): boolean =>
  state.events.some((e) => e.type === 'tipped' && findAthlete(state, e.by)?.side === 'defense');

/**
 * Eligibility: an ineligible offensive player (interior linemen, a QB under centre) may not catch a forward pass
 * until a defender has touched it. Defenders can always play the ball.
 */
export const canCatchForwardPass = (a: Athlete, touchedByDefender: boolean): boolean =>
  a.side === 'defense' || a.eligible || touchedByDefender;

/** Resolves a pass or tipped ball in flight. */
export const resolvePassArrival = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const throwType: ThrowType = ball.throwType ?? state.pass?.throwType ?? 'bullet';
  if (ball.vz > 0 && !ball.isTipped) {
    tryBat(state, env);
    return;
  }
  if (!(ball.vz < 0 || ball.z <= 1.2)) return;
  // A throwaway is thrown into the turf or out of bounds beyond everyone: it is not a catchable (or pickable) ball
  // unless a defender got a hand on it on the way up.
  if (throwType === 'throwAway' && !ball.isTipped) return;
  const anyoneMayCatch = touchedByDefense(state);
  const near = state.athletes.filter((a) => {
    if (!a.active || a.state === 'tackled' || a.state === 'down' || a.state === 'engaged') return false;
    if (a.id === ball.throwerId && !ball.isTipped) return false;
    if (!canCatchForwardPass(a, anyoneMayCatch)) return false;
    return ball.z <= reachOf(a) && dist(a.pos, ball.pos) <= catchRadius(state, a, a.id === ball.targetId) + 4;
  });
  const cands = near.filter((a) => descentDistance(state, a) <= catchRadius(state, a, a.id === ball.targetId));
  if (cands.length === 0) return;
  const target = findAthlete(state, ball.targetId);
  const receiver = target && cands.includes(target) ? target : cands.sort((p, q) => descentDistance(state, p) - descentDistance(state, q))[0];
  if (!receiver) return;
  if (receiver.side === 'defense') interceptionAttempt(state, env, receiver, ball.targetId);
  else receiverContest(state, env, receiver, throwType);
};

/** The pass hit the turf untouched. */
export const passGrounded = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const pass = state.pass;
  let reason: IncompleteReason = 'overthrown';
  if (ball.isTipped) reason = 'batted';
  else if (pass?.throwType === 'throwAway') reason = 'throwAway';
  else if (pass) {
    const target = findAthlete(state, pass.targetId);
    if (target) reason = dist(pass.releasePos, ball.pos) > dist(pass.releasePos, target.pos) + 1 ? 'overthrown' : 'underthrown';
  }
  incomplete(state, env, reason, pass?.targetId ?? null, null);
};
