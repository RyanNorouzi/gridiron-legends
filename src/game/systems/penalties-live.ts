import { dist, dot, len, normalize, sub } from '@/core/vec2';
import { findAthlete } from '../athlete';
import { makePenalty } from '../outcome-factory';
import type { FoulType, PenaltyInfo, TackleKind } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { attackDir, ballOnAt, depthOf, emit, type EngineEnv } from './env';

/**
 * Live-ball fouls. Each contact situation rolls once (keyed per pair / per athlete) against the ruleset's
 * penaltyFrequency; the play continues and the flags end up in PlayOutcome.penalties with accepted=false for
 * rules/penalties.ts to enforce. Nothing here moves the ball.
 */
/**
 * Per-situation call rates. Each is rolled once per qualifying contact, so the game-level frequency is the rate
 * times how often the situation arises (a free rusher reaches the passer late on ~1 in 5 dropbacks, contact in
 * coverage on most deep balls ...). Calibrated to roughly NFL rates: ~1 DPI, ~0.5 roughing / facemask per game.
 */
export const FOUL_RATES = Object.freeze({
  holding: 0.1,
  facemask: 0.004,
  horseCollar: 0.003,
  dpi: 0.15,
  opi: 0.06,
  illegalContact: 0.05,
  roughingPasser: 0.06,
  intoKicker: 0.3,
  lateHit: 0.3,
});

const enabled = (state: PlayState): boolean => state.ctx.ruleset.penalties;
const freq = (state: PlayState): number => state.ctx.ruleset.penaltyFrequency;

/** Rolls a keyed foul once; returns true when it was called. */
const rollOnce = (state: PlayState, env: EngineEnv, key: string, p: number): boolean => {
  if (!enabled(state) || env.penaltyRolled[key]) return false;
  env.penaltyRolled[key] = true;
  return env.rng.chance(p * freq(state));
};

/** Appends a live-ball foul to the play and emits its event. */
export const addFoul = (state: PlayState, env: EngineEnv, foul: FoulType, fouler: Athlete | null, overrides: Partial<Omit<PenaltyInfo, 'foul' | 'accepted'>> = {}): PenaltyInfo | null => {
  if (!enabled(state)) return null;
  const p = makePenalty(foul, { playerId: fouler?.playerId ?? null, side: fouler?.side, ...overrides });
  env.penalties.push(p);
  emit(state, { type: 'penalty', tick: state.tick, penalty: p });
  return p;
};

/** Tackle fouls: facemask on grabbing tackles, horse collar from behind. */
export const onTackleContact = (state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete, kind: TackleKind): void => {
  if (!enabled(state)) return;
  const key = `${tackler.id}>${carrier.id}@${state.tick}`;
  if ((kind === 'arm' || kind === 'openField' || kind === 'dive') && rollOnce(state, env, `fm:${key}`, FOUL_RATES.facemask)) {
    addFoul(state, env, 'facemask', tackler);
    return;
  }
  const attack = attackDir(env, carrier.side);
  const behind = attack * (carrier.pos.y - tackler.pos.y) > 0.2;
  if (kind === 'arm' && behind && rollOnce(state, env, `hc:${key}`, FOUL_RATES.horseCollar)) addFoul(state, env, 'horseCollar', tackler);
};

/** Plays on which the play 'defense' is a return team: kickoffs, onside kicks and (real) punts. */
const returnTeamPlay = (state: PlayState, env: EngineEnv): boolean => {
  const special = state.ctx.special;
  if (special === 'kickoff' || special === 'onside') return true;
  return special === 'punt' && env.kick !== null;
};

/**
 * Holding roll when a blocker loses a contest badly. A hold by the return team on a kick is a 10-yard spot foul
 * against the receivers (reported as a plain holding foul on side 'defense', enforced by rules/penalties.ts
 * applyReturnFouls from the spot of the foul or the end of the run), never 'defensive holding'.
 */
export const onBlockShed = (state: PlayState, env: EngineEnv, blocker: Athlete, rusher: Athlete, score: number): void => {
  if (!enabled(state) || score > -0.35) return;
  if (!rollOnce(state, env, `hold:${blocker.id}>${rusher.id}@${state.tick}`, FOUL_RATES.holding)) return;
  if (blocker.side === 'offense') addFoul(state, env, 'holdingOffense', blocker);
  else if (returnTeamPlay(state, env)) {
    addFoul(state, env, 'holdingOffense', blocker, {
      side: 'defense', yards: 10, enforcement: 'spotOfFoul', spotBallOn: ballOnAt(env, blocker.pos.y), automaticFirstDown: false, replayDown: false,
    });
  } else addFoul(state, env, 'holdingDefense', blocker);
};

const overlapping = (a: Athlete, b: Athlete, extra = 0.15): boolean => dist(a.pos, b.pos) < a.radius + b.radius + extra;

const passInterference = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  const pass = state.pass;
  if (ball.phase !== 'inAir' || ball.kind !== 'pass' || !pass || !pass.targetId || state.tick >= ball.landingTick - 3) return;
  const target = findAthlete(state, pass.targetId);
  if (!target || !target.active) return;
  for (const d of state.athletes) {
    if (!d.active || d.side === target.side || !overlapping(d, target)) continue;
    const key = `pi:${d.id}>${target.id}`;
    if (env.penaltyRolled[key]) continue;
    const toT = normalize(sub(target.pos, d.pos));
    const dSpeed = dot(d.vel, toT);
    const tSpeed = -dot(target.vel, toT);
    const spot = ballOnAt(env, target.pos.y);
    // The defender initiates the contact whenever he is closing on the receiver (through his back on a ball the
    // receiver comes back for included); the receiver only when he runs into a defender who is not closing.
    const defenderInitiates = dSpeed > 0.5 && dSpeed >= tSpeed - 2;
    if (defenderInitiates) {
      if (rollOnce(state, env, key, FOUL_RATES.dpi)) addFoul(state, env, 'passInterferenceDefense', d, { spotBallOn: spot });
    } else if (rollOnce(state, env, key, FOUL_RATES.opi)) addFoul(state, env, 'passInterferenceOffense', target);
  }
};

const illegalContact = (state: PlayState, env: EngineEnv): void => {
  if (state.pass || state.ball.phase !== 'held' || state.ball.carrierId !== env.qbId) return;
  for (const r of state.athletes) {
    if (!r.active || r.side !== 'offense' || !r.eligible || r.assignment.type !== 'route' || depthOf(state, r.pos.y) <= 5) continue;
    for (const d of state.athletes) {
      if (!d.active || d.side !== 'defense' || !overlapping(d, r, 0.05)) continue;
      if (rollOnce(state, env, `ic:${d.id}>${r.id}`, FOUL_RATES.illegalContact)) addFoul(state, env, 'illegalContact', d);
    }
  }
};

const roughingPasser = (state: PlayState, env: EngineEnv): void => {
  if (env.passerId === null || env.releaseTime === null) return;
  const t = state.time - env.releaseTime;
  if (t < 0.5 || t > 1.5) return;
  const passer = findAthlete(state, env.passerId);
  if (!passer || !passer.active) return;
  for (const d of state.athletes) {
    if (!d.active || d.side === passer.side || len(d.vel) < 2.5 || !overlapping(d, passer)) continue;
    if (rollOnce(state, env, `rtp:${d.id}`, FOUL_RATES.roughingPasser)) addFoul(state, env, 'roughingPasser', d);
  }
};

const intoKicker = (state: PlayState, env: EngineEnv): void => {
  const k = env.kick;
  if (!k || k.blocked || k.kind === 'kickoff' || k.kind === 'onside' || state.tick - k.kickTick > 60) return;
  const kicker = findAthlete(state, k.kicker);
  if (!kicker || !kicker.active) return;
  for (const d of state.athletes) {
    if (!d.active || d.side === kicker.side || len(d.vel) < 2 || !overlapping(d, kicker)) continue;
    if (rollOnce(state, env, `rik:${d.id}`, FOUL_RATES.intoKicker)) addFoul(state, env, env.rng.chance(0.3) ? 'roughingKicker' : 'runningIntoKicker', d);
  }
};

/** A defender flying in on a sliding carrier. */
export const lateHitOnSlide = (state: PlayState, env: EngineEnv, slider: Athlete): void => {
  if (!enabled(state)) return;
  for (const d of state.athletes) {
    if (!d.active || d.side === slider.side || dist(d.pos, slider.pos) > 1.4) continue;
    const closing = dot(d.vel, normalize(sub(slider.pos, d.pos)));
    if (closing < 4) continue;
    if (rollOnce(state, env, `late:${d.id}`, FOUL_RATES.lateHit)) addFoul(state, env, 'unnecessaryRoughness', d);
  }
};

/** Per-tick live foul checks (pass interference, illegal contact, roughing the passer / kicker). */
export const penaltiesLiveSystem = (state: PlayState, env: EngineEnv): void => {
  if (!enabled(state) || state.phase !== 'live') return;
  passInterference(state, env);
  illegalContact(state, env);
  roughingPasser(state, env);
  intoKicker(state, env);
};
