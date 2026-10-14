import { clamp01 } from '@/core/math';
import { clone, type Vec2 } from '@/core/vec2';
import { findAthlete } from '../athlete';
import type { PlayEvent } from '../play-events';
import type { PlayState } from '../play-types';
import { attackDir, depthOf, goalLineY, ownGoalLineY, type AlternateRuling, type EngineEnv, type FumbleRecord, type TackleRecord } from './env';

/**
 * Close calls found once the play is dead (the catch and goal-line producers flag theirs during the play, in
 * pass-arrival.ts / live-rules.ts / env.ts): a fumble that might have been down by contact, a spot within a
 * foot or so of the line to gain, and a runner brought down right at his own goal line (safety or not). Each
 * sets env.review (first call wins) with the alternate ruling outcome.ts rebuilds for PlayOutcome.review.
 */

/** Spot within this many yards of the line to gain: the measurement could go either way. */
export const FIRST_DOWN_REVIEW_MARGIN = 0.4;
/** Carrier down within this many yards of his own goal line (either side): safety or not is reviewable. */
export const SAFETY_REVIEW_MARGIN = 0.5;
/** Seconds before a fumble in which a strip press marks it a clear strip (ball out before the knee). */
const STRIP_WINDOW = 0.3;

const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

const confidenceFor = (gap: number, margin: number): number => 0.55 + 0.4 * clamp01(Math.abs(gap) / margin);

const isScrimmage = (state: PlayState): boolean => state.ctx.special === 'none' || state.ctx.special === 'twoPoint';

/**
 * The fumble to review: the first live fumble by an offensive ball carrier knocked loose by a defender on a
 * scrimmage play (a dropped toss or a muff is never 'down by contact').
 */
const reviewableFumble = (state: PlayState, env: EngineEnv): FumbleRecord | null => {
  if (!isScrimmage(state) || env.interception) return null;
  const fu = env.fumbles[0];
  if (!fu || fu.muff || fu.carrierSide !== 'offense' || fu.forcedBy === null) return null;
  return fu;
};

/** How sure the officials are the ball came out first: a big hit or a clean strip is plain, a gang tackle is not. */
const fumbleConfidence = (state: PlayState, env: EngineEnv, fu: FumbleRecord): number => {
  if (state.events.some((e) => e.type === 'hitStick' && e.tick === fu.tick)) return 0.85;
  const strip = fu.forcedBy ? env.stripPress[fu.forcedBy] : undefined;
  if (strip !== undefined && fu.tick / 60 - strip <= STRIP_WINDOW + 0.05) return 0.78;
  const gang = state.athletes.filter((a) => a.side === 'defense' && a.contactTimer < 0.6).length >= 2;
  return gang ? 0.55 : 0.65;
};

const flagFumble = (state: PlayState, env: EngineEnv): boolean => {
  const fu = reviewableFumble(state, env);
  if (!fu) return false;
  env.review = {
    call: { kind: 'fumble', tick: fu.tick, athleteId: fu.carrierId, confidence: fumbleConfidence(state, env, fu) },
    alternate: { deadReason: 'tackle', deadSpot: clone(fu.pos), wipeCompletion: false, wipeFumbleAt: fu.tick },
  };
  return true;
};

const flagFirstDown = (state: PlayState, env: EngineEnv): boolean => {
  const reason = state.deadReason;
  const spot = state.deadSpot;
  if (!isScrimmage(state) || state.ctx.special === 'twoPoint' || !spot || env.possession !== 'offense' || env.fumbles.length > 0) return false;
  if (reason !== 'tackle' && reason !== 'forwardProgress' && reason !== 'outOfBounds') return false;
  const dir = env.dir;
  const toGoal = dir * (goalLineY(env, 'offense') - state.firstDownY);
  if (toGoal < 0.5) return false;
  const gap = dir * (spot.y - state.firstDownY);
  if (Math.abs(gap) >= FIRST_DOWN_REVIEW_MARGIN) return false;
  const alt: Vec2 = { x: spot.x, y: state.firstDownY + dir * (gap >= 0 ? -0.15 : 0.05) };
  env.review = {
    call: { kind: 'firstDown', tick: state.tick, athleteId: state.ball.carrierId, confidence: confidenceFor(gap, FIRST_DOWN_REVIEW_MARGIN) },
    alternate: { deadReason: reason, deadSpot: alt, wipeCompletion: false },
  };
  return true;
};

/** The runner's own tackle this play (the record that put him down). */
const finalTackle = (state: PlayState, env: EngineEnv): TackleRecord | null => {
  const t = env.lastTackle;
  if (!t) return null;
  const carrier = findAthlete(state, t.carrier);
  return carrier && carrier.side === 'offense' ? t : null;
};

const flagSafetySpot = (state: PlayState, env: EngineEnv): boolean => {
  if (!isScrimmage(state) || env.possession !== 'offense' || env.fumbles.length > 0) return false;
  const t = finalTackle(state, env);
  if (!t || (state.deadReason !== 'safety' && state.deadReason !== 'tackle')) return false;
  const attack = attackDir(env, 'offense');
  const own = ownGoalLineY(env, 'offense');
  const past = attack * (t.pos.y - own);
  if (Math.abs(past) >= SAFETY_REVIEW_MARGIN) return false;
  // Ruled a safety: the alternate has him down just outside the goal line; ruled down in the field: a safety.
  const ruledSafety = state.deadReason === 'safety';
  const alternate: AlternateRuling = ruledSafety
    ? { deadReason: 'tackle', deadSpot: { x: t.pos.x, y: own + attack * 0.3 }, wipeCompletion: false }
    : { deadReason: 'safety', deadSpot: { x: t.pos.x, y: own }, wipeCompletion: false };
  env.review = { call: { kind: 'spot', tick: t.tick, athleteId: t.carrier, confidence: confidenceFor(past, SAFETY_REVIEW_MARGIN) }, alternate };
  return true;
};

/** Flags the dead play's close call (fumble, safety spot, first-down spot) unless one is already flagged. */
export const flagCloseCalls = (state: PlayState, env: EngineEnv): void => {
  if (env.review !== null || state.phase !== 'dead' || !state.ctx.ruleset.challenges) return;
  if (flagFumble(state, env)) return;
  if (flagSafetySpot(state, env)) return;
  flagFirstDown(state, env);
};

/**
 * The play as it would stand had the carrier been down before the ball came out at `tick`: the fumble and everything
 * after it are erased, the offense keeps the ball, and the man who forced it made the tackle there (a sack when he
 * was a passer still behind the line).
 */
export const fumbleWipedView = (state: PlayState, env: EngineEnv, tick: number): { state: PlayState; env: EngineEnv } => {
  const fu = env.fumbles.find((f) => f.tick === tick) ?? env.fumbles[0];
  if (!fu) return { state, env };
  const tackler = fu.forcedBy ?? fu.carrierId;
  const rec: TackleRecord = { tackler, assists: [], kind: 'wrap', carrier: fu.carrierId, pos: clone(fu.pos), tick: fu.tick };
  const before = state.events.filter((e) => e.tick < fu.tick);
  const events: PlayEvent[] = [...before, { type: 'tackle', tick: fu.tick, tackler, carrier: fu.carrierId, kind: 'wrap', assists: [] }];
  const depth = depthOf(state, fu.pos.y);
  const dropback = PASS_TYPES.has(state.ctx.offensivePlay.type);
  const passerDown = dropback && fu.carrierId === env.qbId && !env.handoffDone && !env.pitched && state.pass === null && depth < 0;
  const sack = passerDown ? { by: tackler, assists: [], yardsLost: Math.min(-depth, state.ctx.ballOn) } : env.sack;
  if (passerDown) events.push({ type: 'sack', tick: fu.tick, by: tackler, assists: [], yardsLost: sack?.yardsLost ?? 0 });
  events.push({ type: 'whistle', tick: fu.tick, reason: 'tackle' });
  const completion = env.completion && env.completion.tick <= fu.tick ? env.completion : null;
  const viewEnv: EngineEnv = {
    ...env, fumbles: env.fumbles.filter((f) => f.tick < fu.tick), possession: 'offense', lastTackle: rec,
    tackleRecords: [...env.tackleRecords.filter((t) => t.tick < fu.tick), rec], sack, completion,
  };
  const viewState: PlayState = { ...state, events, deadReason: 'tackle', deadSpot: clone(fu.pos), tick: fu.tick };
  return { state: viewState, env: viewEnv };
};
