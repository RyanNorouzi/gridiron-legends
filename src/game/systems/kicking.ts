import { clamp } from '@/core/math';
import { clone, dist, normalize, sub, type Vec2 } from '@/core/vec2';
import { fieldGoalDistance, isFakePlay } from '@/playbook/special-teams';
import { aiKickMeter, applyKick, fieldGoalResult, kickBall, windComponents } from '@/physics/kick';
import { findAthlete } from '../athlete';
import { moveIntent } from '../engine-api';
import type { KickKind } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { canAct, emit, markDead, setTimedState, type EngineEnv } from './env';
import { advanceKickMeter } from './kick-meter';

/**
 * Kicks. Kickoffs go live at the kick (no snap); punts and field goals snap first (a human punter's first meter press
 * asks for the snap; a human place kicker's locked meter does), the punter / holder secures the ball, then the kick happens once the kicker
 * is ready: AI kickers roll aiKickMeter after their hold time, humans finish the meter. Rushers reaching the
 * kick spot before the ball is away have a small per-tick chance to block it. Field goals are decided in closed
 * form (physics/kick.ts fieldGoalResult) with the ball still flown for the camera.
 */
export const PUNT_HOLD_SECONDS = 1.2;
export const FG_HOLD_SECONDS = 0.35;
export const KICK_REACH = 1.4;
export const BLOCK_CHANCE_PER_TICK = { punt: 0.05, fieldGoal: 0.04 };

const isKickPlay = (state: PlayState): boolean =>
  state.ctx.special !== 'none' && state.ctx.special !== 'twoPoint' && !isFakePlay(state.ctx.offensivePlay);

const goLive = (state: PlayState, env: EngineEnv): void => {
  state.phase = 'live';
  state.snapTick = state.tick;
  state.snapX = state.ball.pos.x;
  state.playClock = 0;
  env.snapped = true;
  env.liveTime = 0;
  for (const a of state.athletes) if (a.state === 'presnap') a.state = 'idle';
};

/** Human meter: presses come straight from this tick's input; move.x aims while the meter runs. */
const advanceMeter = (state: PlayState, env: EngineEnv, kicker: Athlete, dt: number): void => {
  const meter = state.kickMeter;
  if (!meter || !kicker.controlled) return;
  const input = env.inputs[kicker.teamSide];
  const press = input?.kickPress ?? false;
  if (input && meter.phase !== 'done' && meter.phase !== 'idle') env.kickAim = clamp(input.move.x, -1, 1);
  const step = advanceKickMeter(meter, env.meterTime, dt, press, kicker.attrs.kickAccuracy);
  env.meterTime = step.phaseTime;
  if (state.phase !== 'presnap') return;
  // A punter asks for the snap with his first press and runs the meter while it comes back to him. A place kicker
  // sets his kick before the snap: the meter runs pre-snap and the snap comes when it is locked, so holder and kicker
  // then go at the AI's tempo (a meter run after the snap took as long as the rush needs to reach the holder).
  const special = state.ctx.special;
  if (step.event === 'started' && special === 'punt') env.snapRequested = true;
  if (step.event === 'done' && (special === 'fieldGoal' || special === 'extraPoint')) env.snapRequested = true;
};

/** A human place kicker is still setting his kick pre-snap: nobody snaps the ball until his meter is locked. */
export const placeKickMeterPending = (state: PlayState): boolean =>
  state.kickMeter !== null && state.kickMeter.phase !== 'done' && (state.ctx.special === 'fieldGoal' || state.ctx.special === 'extraPoint') && !isFakePlay(state.ctx.offensivePlay);

const meterValues = (state: PlayState, env: EngineEnv, kicker: Athlete): { power: number; accuracy: number } => {
  const meter = state.kickMeter;
  if (kicker.controlled && meter && meter.phase === 'done') return { power: meter.power ?? 0.5, accuracy: meter.accuracy ?? 0.5 };
  const it = state.intents[kicker.id];
  if (it?.action === 'kick' && it.kickPower !== null && it.kickAccuracy !== null) return { power: clamp(it.kickPower, 0, 1), accuracy: clamp(it.kickAccuracy, 0, 1) };
  return aiKickMeter(kicker.attrs.kickPower, kicker.attrs.kickAccuracy, env.rng);
};

const kickerReady = (state: PlayState, kicker: Athlete, held: number, holdSeconds: number): boolean => {
  if (kicker.controlled) return state.kickMeter?.phase === 'done' && held >= Math.min(holdSeconds, 0.4);
  const it = state.intents[kicker.id];
  if (it?.action === 'kick') return held >= Math.min(holdSeconds, 0.3);
  return held >= holdSeconds;
};

const performKick = (state: PlayState, env: EngineEnv, kicker: Athlete, kind: KickKind): void => {
  const { power, accuracy } = meterValues(state, env, kicker);
  const from = clone(state.ball.pos);
  const dirVec: Vec2 = { x: 0, y: env.dir };
  const launch = kickBall(from, dirVec, kind, power, accuracy, env.kickAim, kicker.attrs.kickPower, kicker.attrs.kickAccuracy, state.ctx.weather, env.rng);
  state.ball = applyKick(state.ball, from, launch, kicker.id, kind, state.tick);
  for (const a of state.athletes) a.hasBall = false;
  setTimedState(kicker, 'kicking', 0.5);
  env.kick = { kind, kicker: kicker.id, power, accuracy, kickTick: state.tick, kickSpot: from, made: null, carry: launch.distance, landing: null, fieldedBy: null, returnStart: null, blocked: false, touchedByKickingTeam: false };
  env.stallTime = 0;
  emit(state, { type: 'kick', tick: state.tick, kicker: kicker.id, kind, power, accuracy });
};

const performFieldGoal = (state: PlayState, env: EngineEnv, kicker: Athlete, holder: Athlete, kind: 'fieldGoal' | 'extraPoint'): void => {
  const { power, accuracy } = meterValues(state, env, kicker);
  const from = clone(state.ball.pos);
  const dirVec: Vec2 = { x: 0, y: env.dir };
  const distance = fieldGoalDistance(state.ctx.ballOn);
  const res = fieldGoalResult(distance, power, accuracy, kicker.attrs.kickPower, kicker.attrs.kickAccuracy, windComponents(state.ctx.weather, dirVec), { aim: env.kickAim, hookSign: env.rng.chance(0.5) ? 1 : -1 });
  const launch = kickBall(from, dirVec, kind, power, accuracy, env.kickAim, kicker.attrs.kickPower, kicker.attrs.kickAccuracy, state.ctx.weather, env.rng);
  state.ball = applyKick(state.ball, from, launch, kicker.id, kind, state.tick);
  holder.hasBall = false;
  for (const a of state.athletes) a.hasBall = false;
  setTimedState(kicker, 'kicking', 0.5);
  env.kick = { kind, kicker: kicker.id, power, accuracy, kickTick: state.tick, kickSpot: from, made: res.made, carry: distance, landing: null, fieldedBy: null, returnStart: null, blocked: false, touchedByKickingTeam: false };
  emit(state, { type: 'kick', tick: state.tick, kicker: kicker.id, kind, power, accuracy });
  emit(state, { type: 'kickResult', tick: state.tick, kind, made: res.made, distance });
};

/** Rushers at the kick spot may block the kick before it is away. */
const rollBlock = (state: PlayState, env: EngineEnv, kind: KickKind, radius: number, p: number): boolean => {
  const ball = state.ball;
  for (const d of state.athletes) {
    if (d.side !== 'defense' || !canAct(d) || dist(d.pos, ball.pos) > radius) continue;
    if (!env.rng.chance(p * (d.state === 'jumping' ? 1.5 : 1))) continue;
    emit(state, { type: 'kickBlocked', tick: state.tick, by: d.id });
    const kicker = env.kickerId ?? d.id;
    env.kick = { kind, kicker, power: 0, accuracy: 0, kickTick: state.tick, kickSpot: clone(ball.pos), made: false, carry: 0, landing: clone(ball.pos), fieldedBy: null, returnStart: null, blocked: true, touchedByKickingTeam: false };
    if (kind === 'fieldGoal' || kind === 'extraPoint') emit(state, { type: 'kickResult', tick: state.tick, kind, made: false, distance: fieldGoalDistance(state.ctx.ballOn) });
    markDead(state, env, 'blockedKick', ball.pos);
    return true;
  }
  return false;
};

const kickoffFlow = (state: PlayState, env: EngineEnv, kicker: Athlete): void => {
  if (env.kick || state.phase !== 'presnap') return;
  const ready = env.snapRequested || (kicker.controlled ? state.kickMeter?.phase === 'done' : state.time >= env.kickCadence || state.intents[kicker.id]?.action === 'kick');
  if (!ready) return;
  env.kickReady = true;
  if (dist(kicker.pos, state.ball.pos) > KICK_REACH) return;
  performKick(state, env, kicker, state.ctx.special === 'onside' ? 'onside' : 'kickoff');
  goLive(state, env);
};

const puntFlow = (state: PlayState, env: EngineEnv, kicker: Athlete): void => {
  if (env.kick || state.phase !== 'live' || state.ball.phase !== 'held' || state.ball.carrierId !== kicker.id) return;
  if (env.holdStart === null) env.holdStart = state.time;
  const held = state.time - env.holdStart;
  if (rollBlock(state, env, 'punt', 1.5, BLOCK_CHANCE_PER_TICK.punt)) return;
  if (!kickerReady(state, kicker, held, PUNT_HOLD_SECONDS)) return;
  performKick(state, env, kicker, 'punt');
};

const fieldGoalFlow = (state: PlayState, env: EngineEnv, kicker: Athlete): void => {
  if (env.kick || state.phase !== 'live') return;
  const holder = findAthlete(state, env.holderId) ?? kicker;
  if (state.ball.phase !== 'held' || state.ball.carrierId !== holder.id) return;
  if (env.holdStart === null) env.holdStart = state.time;
  const held = state.time - env.holdStart;
  const kind: 'fieldGoal' | 'extraPoint' = state.ctx.special === 'extraPoint' ? 'extraPoint' : 'fieldGoal';
  if (rollBlock(state, env, kind, 1.2, BLOCK_CHANCE_PER_TICK.fieldGoal)) return;
  const ready = kickerReady(state, kicker, held, FG_HOLD_SECONDS);
  env.kickReady = ready;
  if (!ready) return;
  if (holder.id !== kicker.id && dist(kicker.pos, state.ball.pos) > KICK_REACH + 0.4) return;
  performFieldGoal(state, env, kicker, holder, kind);
};

/** Pre-movement hook: a ready kicker runs up to the ball (kickoffs, field goals). */
export const kickerApproach = (state: PlayState, env: EngineEnv): void => {
  if (!env.kickReady || env.kick || !isKickPlay(state)) return;
  if (state.ctx.special === 'punt') return;
  const kicker = findAthlete(state, env.kickerId);
  if (!kicker || !kicker.active) return;
  const to = sub(state.ball.pos, kicker.pos);
  if (dist(kicker.pos, state.ball.pos) <= 0.6) return;
  state.intents[kicker.id] = moveIntent(normalize(to), true, 'approach');
};

/** One tick of kicking (runs pre-snap and live). */
export const kickingSystem = (state: PlayState, env: EngineEnv, dt: number): void => {
  if (!isKickPlay(state)) return;
  const kicker = findAthlete(state, env.kickerId);
  if (!kicker || !kicker.active) return;
  advanceMeter(state, env, kicker, dt);
  switch (state.ctx.special) {
    case 'kickoff':
    case 'onside':
      kickoffFlow(state, env, kicker);
      break;
    case 'punt':
      puntFlow(state, env, kicker);
      break;
    case 'fieldGoal':
    case 'extraPoint':
      fieldGoalFlow(state, env, kicker);
      break;
    default:
      break;
  }
};
