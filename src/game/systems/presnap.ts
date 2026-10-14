import { clone } from '@/core/vec2';
import { ratingToFactor } from '@/core/math';
import { resolveAudible, resolveDefensiveAudible, type AudibleKey, type DefensiveAudibleKey } from '@/playbook/audibles';
import { formationToField } from '@/playbook/transform';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import { holdBall, snapBall } from '@/physics/ball';
import { emptyAiMemory, findAthlete } from '../athlete';
import { makePenalty } from '../outcome-factory';
import { resolveDefensiveFormation, resolveOffensiveFormation } from '../play-context';
import type { FoulType } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { depthOf, emit, markDead, takePossession, type EngineEnv } from './env';
import { placeKickMeterPending } from './kicking';

/**
 * Pre-snap phase: the play clock runs, audibles resolve, pre-snap fouls are rolled when the ruleset has
 * penalties, and the ball is snapped when the offense asks for it (QB intent 'snap', AI cadence, the human
 * kicker's meter press on punts / field goals, or the play clock expiring with penalties off). Kickoffs never
 * snap: the kicking system takes them live at the kick.
 */
const OFF_KEYS: readonly AudibleKey[] = ['manBeater', 'zoneBeater', 'blitzBeater', 'runToPass', 'passToRun'];
const DEF_KEYS: readonly DefensiveAudibleKey[] = ['manShift', 'zoneShift', 'blitz', 'spy'];
const MIN_ON_LINE = 7;

const isOffKey = (k: string): k is AudibleKey => (OFF_KEYS as readonly string[]).includes(k);
const isDefKey = (k: string): k is DefensiveAudibleKey => (DEF_KEYS as readonly string[]).includes(k);

/** Re-materialises assignments and re-places only the athletes whose alignment moved. */
const applyOffensivePlay = (state: PlayState, env: EngineEnv, play: OffensivePlay): void => {
  state.ctx = { ...state.ctx, offensivePlay: play };
  env.ctx = state.ctx;
  const form = resolveOffensiveFormation(play, env.opts.registries ?? {});
  const pos = formationToField(form, state.ctx.ballX, state.losY, state.ctx.direction);
  for (const a of state.athletes) {
    if (a.side !== 'offense') continue;
    const next = play.assignments[a.role];
    if (next) a.assignment = next;
    a.ai = emptyAiMemory();
    const p = pos[a.role];
    if (p && Math.hypot(p.x - a.pos.x, p.y - a.pos.y) > 0.05) a.pos = clone(p);
  }
  env.offSlots = form.slots;
  const qb = state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb');
  if (qb) env.qbId = qb.id;
  const carrier = play.ballCarrier ? state.athletes.find((a) => a.side === 'offense' && a.role === play.ballCarrier) : null;
  env.designedCarrierId = carrier && carrier.id !== env.qbId ? carrier.id : null;
};

const applyDefensivePlay = (state: PlayState, env: EngineEnv, play: DefensivePlay): void => {
  state.ctx = { ...state.ctx, defensivePlay: play };
  env.ctx = state.ctx;
  const form = resolveDefensiveFormation(play, env.opts.registries ?? {});
  const pos = formationToField(form, state.ctx.ballX, state.losY, state.ctx.direction);
  for (const a of state.athletes) {
    if (a.side !== 'defense') continue;
    const next = play.assignments[a.role];
    if (next) a.assignment = next;
    a.ai = emptyAiMemory();
    const p = pos[a.role];
    if (p && Math.hypot(p.x - a.pos.x, p.y - a.pos.y) > 0.05) a.pos = clone(p);
  }
  env.defSlots = form.slots;
};

/** Audible success grows with the caller's awareness: 55% at rating 1, 100% at 99. */
export const audibleSuccessChance = (awareness: number): number => 0.55 + 0.45 * ratingToFactor(awareness);

const handleAudibles = (state: PlayState, env: EngineEnv): void => {
  const qb = findAthlete(state, env.qbId);
  const qbIntent = qb ? state.intents[qb.id] : undefined;
  if (qb && qbIntent?.action === 'audible' && qbIntent.audible && isOffKey(qbIntent.audible) && !env.audibleTried[`off:${qbIntent.audible}`]) {
    env.audibleTried[`off:${qbIntent.audible}`] = true;
    const reg = env.opts.plays?.offensePlays;
    const target = reg ? resolveAudible(state.ctx.offensivePlay, qbIntent.audible, { offensePlays: reg }) : null;
    const success = target !== null && env.rng.chance(audibleSuccessChance(qb.attrs.awareness));
    emit(state, { type: 'audible', tick: state.tick, success, newPlayId: target?.id ?? state.ctx.offensivePlay.id, side: 'offense' });
    if (success && target) applyOffensivePlay(state, env, target);
  }
  for (const d of state.athletes) {
    if (d.side !== 'defense') continue;
    const it = state.intents[d.id];
    if (!it || it.action !== 'audible' || !it.audible || !isDefKey(it.audible) || env.audibleTried[`def:${it.audible}`]) continue;
    env.audibleTried[`def:${it.audible}`] = true;
    const reg = env.opts.plays?.defensePlays;
    const target = reg ? resolveDefensiveAudible(state.ctx.defensivePlay, it.audible, { defensePlays: reg }) : null;
    const success = target !== null && env.rng.chance(audibleSuccessChance(d.attrs.awareness));
    emit(state, { type: 'audible', tick: state.tick, success, newPlayId: target?.id ?? state.ctx.defensivePlay.id, side: 'defense' });
    if (success && target) applyDefensivePlay(state, env, target);
    break;
  }
};

const flag = (state: PlayState, env: EngineEnv, foul: FoulType, fouler: Athlete | null): void => {
  const p = makePenalty(foul, { playerId: fouler?.playerId ?? null });
  env.penalties.push(p);
  emit(state, { type: 'penalty', tick: state.tick, penalty: p });
};

/** Athletes on the line of scrimmage (within 1.05 yd of it). */
export const countOnLine = (state: PlayState): number => state.athletes.filter((a) => a.side === 'offense' && depthOf(state, a.pos.y) >= -1.05).length;

/** Rolls the pre-snap fouls at the moment of the snap. Returns true when a dead-ball foul killed the play. */
const rollPresnapFouls = (state: PlayState, env: EngineEnv): boolean => {
  const ctx = state.ctx;
  if (!ctx.ruleset.penalties) return false;
  const freq = ctx.ruleset.penaltyFrequency;
  const rng = env.rng;
  const offense = state.athletes.filter((a) => a.side === 'offense' && a.id !== env.qbId && a.id !== env.kickerId);
  const pFalse = freq * (0.012 + (ctx.offense === 'away' ? 0.03 * ctx.crowdFactor : 0));
  if (offense.length > 0 && rng.chance(pFalse)) {
    flag(state, env, 'falseStart', rng.pick(offense));
    markDead(state, env, 'penaltyDeadBall', state.ball.pos);
    return true;
  }
  const front = state.athletes.filter((a) => a.side === 'defense' && ['rushGap', 'blitz', 'contain', 'runFill'].includes(a.assignment.type));
  const defenders = front.length > 0 ? front : state.athletes.filter((a) => a.side === 'defense');
  if (defenders.length > 0 && rng.chance(freq * 0.012)) {
    if (rng.chance(0.4)) {
      flag(state, env, 'encroachment', rng.pick(defenders));
      markDead(state, env, 'penaltyDeadBall', state.ball.pos);
      return true;
    }
    flag(state, env, 'offsides', rng.pick(defenders));
  }
  const offCount = state.athletes.filter((a) => a.side === 'offense').length;
  if (offCount >= MIN_ON_LINE && countOnLine(state) < MIN_ON_LINE) flag(state, env, 'illegalFormation', null);
  return false;
};

/** Snaps the ball to the snap receiver (QB / punter / holder). Under centre the QB has it at once. */
export const doSnap = (state: PlayState, env: EngineEnv): void => {
  const receiver = findAthlete(state, env.qbId) ?? state.athletes.find((a) => a.side === 'offense') ?? null;
  if (!receiver) throw new Error('doSnap: the offense has no athletes');
  const snapper = findAthlete(state, env.snapperId);
  state.snapX = state.ball.pos.x;
  state.ball = snapper ? snapBall(state.ball, snapper, receiver, state.tick) : { ...holdBall(state.ball, receiver.id, state.tick, 'snap'), pos: clone(receiver.pos) };
  if (state.ball.phase === 'held') takePossession(state, env, receiver);
  state.phase = 'live';
  state.snapTick = state.tick;
  state.playClock = 0;
  env.snapped = true;
  env.liveTime = 0;
  for (const a of state.athletes) if (a.state === 'presnap') a.state = 'idle';
  emit(state, { type: 'snap', tick: state.tick });
};

/** One pre-snap tick. */
export const presnapSystem = (state: PlayState, env: EngineEnv, dt: number): void => {
  if (state.phase !== 'presnap') return;
  state.playClock -= dt;
  handleAudibles(state, env);
  if (state.phase !== 'presnap') return;
  if (state.ctx.special === 'kickoff' || state.ctx.special === 'onside') {
    if (state.playClock > 0 || env.snapRequested) return;
    if (state.ctx.ruleset.penalties) {
      flag(state, env, 'delayOfGame', findAthlete(state, env.kickerId));
      markDead(state, env, 'penaltyDeadBall', state.ball.pos);
      return;
    }
    env.snapRequested = true;
    return;
  }
  const receiver = findAthlete(state, env.qbId);
  const intent = receiver ? state.intents[receiver.id] : undefined;
  let wantsSnap = (intent?.action === 'snap' && receiver?.side === 'offense') || env.snapRequested;
  if (receiver && !receiver.controlled && state.time >= env.snapCadence) wantsSnap = true;
  // A human place kicker sets his meter first: neither the AI holder's cadence nor its snap call beats him to it.
  if (placeKickMeterPending(state)) wantsSnap = false;
  if (state.playClock <= 0) {
    if (state.ctx.ruleset.penalties) {
      flag(state, env, 'delayOfGame', receiver);
      markDead(state, env, 'penaltyDeadBall', state.ball.pos);
      return;
    }
    wantsSnap = true;
  }
  if (!wantsSnap) return;
  if (rollPresnapFouls(state, env)) return;
  doSnap(state, env);
};
