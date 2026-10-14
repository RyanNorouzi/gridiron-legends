import { ratingToFactor } from '@/core/math';
import { clone, dist } from '@/core/vec2';
import { handoffBall, holdBall, lateralBall, pitchBall } from '@/physics/ball';
import { ballCarrier, findAthlete } from '../athlete';
import { idleIntent, type AthleteIntent } from '../engine-api';
import type { Athlete, PlayState } from '../play-types';
import { nearestTrailingTeammate } from '../user-control';
import { attackDir, carrierDown, emit, markDead, setTimedState, takePossession, type EngineEnv } from './env';
import { looseBallFrom, recordLooseToss } from './fumble';
import { lateHitOnSlide } from './penalties-live';

/**
 * Ball exchanges: snap arrival, designed handoffs at the mesh point, tosses on outside runs, option pitches,
 * laterals (backward only; a forward lateral becomes a pass), play-action fakes, and the dead-ball actions a
 * ball holder can take (kneel, spike, slide). The QB keeps the ball on qbRun plays and on RPO / read plays
 * unless his intent hands it off.
 */
export const HANDOFF_REACH = 1.5;
export const TOSS_MAX_DISTANCE = 9;
export const TOSS_DELAY = 0.5;
export const SPIKE_WINDOW = 1.5;

const isReadPlay = (state: PlayState): boolean => {
  const p = state.ctx.offensivePlay;
  return p.type === 'rpo' || (p.type === 'qbRun' && p.fakeTo !== undefined);
};

const doHandoff = (state: PlayState, env: EngineEnv, from: Athlete, to: Athlete): void => {
  state.ball = handoffBall(state.ball, from, to, state.tick);
  from.hasBall = false;
  takePossession(state, env, to);
  env.handoffDone = true;
  env.rusherId = to.id;
  if (to.state === 'idle' || to.state === 'presnap') to.state = 'moving';
  emit(state, { type: 'handoff', tick: state.tick, from: from.id, to: to.id });
};

const doPitch = (state: PlayState, env: EngineEnv, from: Athlete, to: Athlete, lateral: boolean): void => {
  state.ball = lateral ? lateralBall(state.ball, from, to, state.tick) : pitchBall(state.ball, from, to, state.tick);
  from.hasBall = false;
  env.pitched = true;
  emit(state, lateral ? { type: 'lateral', tick: state.tick, from: from.id, to: to.id } : { type: 'pitch', tick: state.tick, from: from.id, to: to.id });
};

/** Kneel / spike / slide: the holder gives himself up and the ball is dead at once. */
const handleGiveUp = (state: PlayState, env: EngineEnv, holder: Athlete, intent: AthleteIntent): boolean => {
  const play = state.ctx.offensivePlay;
  // A called kneel / spike executes itself for AI and human QBs alike (there is no dedicated input for it).
  const auto = holder.id === env.qbId;
  if (intent.action === 'kneel' || (auto && play.type === 'kneel' && env.liveTime >= 0.3)) {
    setTimedState(holder, 'down', 1.0);
    holder.vel = { x: 0, y: 0 };
    emit(state, { type: 'kneel', tick: state.tick, athlete: holder.id });
    carrierDown(state, env, holder, holder.pos, 'kneel');
    return true;
  }
  if ((intent.action === 'spike' || (auto && play.type === 'spike')) && holder.id === env.qbId && env.liveTime <= SPIKE_WINDOW) {
    emit(state, { type: 'spike', tick: state.tick, athlete: holder.id });
    markDead(state, env, 'spike', { x: state.snapX, y: state.losY });
    return true;
  }
  // A runner already held cannot slide out of the tackle (a passer would dodge the sack): the struggle rules on him.
  if (intent.action === 'slide' && holder.state !== 'wrapped') {
    setTimedState(holder, 'sliding', 0.6);
    env.slideSpot = clone(holder.pos);
    env.lateHitWindowUntil = state.time + 0.5;
    emit(state, { type: 'slide', tick: state.tick, athlete: holder.id });
    lateHitOnSlide(state, env, holder);
    carrierDown(state, env, holder, holder.pos, 'slide');
    return true;
  }
  return false;
};

/** Designed exchanges while the QB holds the ball. */
const handleQbExchange = (state: PlayState, env: EngineEnv, qb: Athlete, intent: AthleteIntent): void => {
  const play = state.ctx.offensivePlay;
  const designed = findAthlete(state, env.designedCarrierId);
  if (intent.action === 'handoff') {
    const target = findAthlete(state, intent.targetId) ?? designed;
    if (target && target.active && target.side === 'offense' && target.id !== qb.id && dist(target.pos, qb.pos) <= HANDOFF_REACH) {
      doHandoff(state, env, qb, target);
      return;
    }
  }
  if (!env.playActionFaked && play.fakeTo && (play.type === 'playAction' || (designed === null && play.type !== 'run'))) {
    const fake = state.athletes.find((a) => a.side === 'offense' && a.role === play.fakeTo);
    if (fake && dist(fake.pos, qb.pos) <= HANDOFF_REACH + 0.3) {
      env.playActionFaked = true;
      emit(state, { type: 'playActionFake', tick: state.tick, qb: qb.id, to: fake.id });
    }
  }
  if (!designed || !designed.active || env.handoffDone || isReadPlay(state)) return;
  if (play.type !== 'run' && play.type !== 'screen') return;
  const d = dist(designed.pos, qb.pos);
  if (d <= HANDOFF_REACH) {
    doHandoff(state, env, qb, designed);
    return;
  }
  if (play.concept === 'outsideRun' && !env.pitched && env.liveTime >= TOSS_DELAY && d <= TOSS_MAX_DISTANCE) {
    doPitch(state, env, qb, designed, false);
    env.rusherId = designed.id;
  }
};

/** Option pitches and laterals by any ball holder. A forward "lateral" is handed to the passing system. */
const handlePitchLateral = (state: PlayState, env: EngineEnv, holder: Athlete, intent: AthleteIntent): void => {
  if (intent.action !== 'pitch' && intent.action !== 'lateral') return;
  const attack = attackDir(env, holder.side);
  const target = findAthlete(state, intent.targetId) ?? (intent.action === 'pitch' ? nearestTrailingTeammate(state, holder, attack) : null);
  if (!target || !target.active || target.side !== holder.side || target.id === holder.id || dist(target.pos, holder.pos) > 14) return;
  const forward = attack * (target.pos.y - holder.pos.y) > 0.3;
  if (forward) {
    if (holder.side === 'offense' && !state.pass) state.intents[holder.id] = { ...intent, action: 'throw', targetId: target.id, throwType: intent.throwType ?? 'bullet' };
    return;
  }
  doPitch(state, env, holder, target, intent.action === 'lateral');
  if (holder.id === env.qbId && !env.handoffDone) env.rusherId = target.id;
};

/** Snap / pitch / lateral in flight: the target gathers it, muffs it, or it hits the turf and is live. */
const resolveTossArrival = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const target = findAthlete(state, ball.targetId);
  // A pitch is gathered a little further out than the snap exchange: the back reaches for a ball leading him.
  const reach = ball.kind === 'snap' ? 1.1 : 1.4;
  if (target && target.active && dist(target.pos, ball.pos) <= reach && ball.z <= 2.3 && state.tick >= ball.launchTick + 2) {
    // A toss is muffed about one time in seventy (poorer hands a little more); the snap exchange is routine.
    const secure = ball.kind === 'snap' || env.rng.chance(0.982 + 0.016 * ratingToFactor(target.attrs.hands));
    if (secure) {
      state.ball = holdBall(ball, target.id, state.tick, ball.kind);
      takePossession(state, env, target);
      if (ball.kind !== 'snap' && target.side === 'offense' && env.rusherId === null) env.rusherId = target.id;
      if (target.state === 'idle' || target.state === 'presnap') target.state = 'moving';
      return;
    }
    looseBallFrom(state, env, target, null, { popSpeed: 1.5 });
  }
};

/** One tick of ball handling. */
export const ballHandlingSystem = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const toss = ball.kind === 'snap' || ball.kind === 'pitch' || ball.kind === 'lateral';
  if (ball.phase === 'inAir' && toss) {
    resolveTossArrival(state, env);
    return;
  }
  if (ball.phase === 'loose' && toss) {
    recordLooseToss(state, env);
    return;
  }
  if (ball.phase !== 'held') return;
  const holder = ballCarrier(state);
  if (!holder || !holder.active) return;
  const intent = state.intents[holder.id] ?? idleIntent();
  if (handleGiveUp(state, env, holder, intent)) return;
  if (holder.id === env.qbId && holder.side === 'offense') handleQbExchange(state, env, holder, intent);
  if (state.ball.phase !== 'held' || state.ball.carrierId !== holder.id) return;
  handlePitchLateral(state, env, holder, intent);
};
