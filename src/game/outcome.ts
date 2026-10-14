import { victoryFormationRunoffSec } from '@/ai/coaching';
import { clone } from '@/core/vec2';
import { TICK_RATE } from '@/core/time';
import { applyFatigue, fatigueFromPlay } from '@/players/fatigue';
import { isFakePlay } from '@/playbook/special-teams';
import { fatigueRateMultiplier } from '@/physics/attributes';
import { isExplosive, isSuccessfulPlay, playEpa } from '@/statistics/epa';
import { ballCarrier, findAthlete } from './athlete';
import { emptyOutcome } from './outcome-factory';
import { buildPlayByPlay, eventsForRuling } from './play-by-play';
import type { PenaltyInfo } from './play-events';
import type { Athlete, PlayOutcome, PlayResultType, PlayState } from './play-types';
import { buildRecording } from './replay';
import { HURRY_UP_RUNOFF_SEC, huddleSeconds, liveClockScale } from './rules/clock';
import { attackDir, ballOnAt, type AlternateRuling, type EngineEnv } from './systems/env';
import type { OutcomeFacts } from './systems/outcome-facts';
import { flagCloseCalls, fumbleWipedView } from './systems/reviews';
import { buildStatDeltas } from './systems/stat-deltas';

/**
 * PlayOutcome builder for the live engine: FACTS only (DERIVED fields stay at emptyOutcome's defaults for
 * GameController.applyOutcome). Close calls are rebuilt through the same path with the alternate ruling to
 * produce `review.ifOverturned`.
 */
const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);
const SPECIAL_RESULT: Record<'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint', PlayResultType> = {
  kickoff: 'kickoff', onside: 'onside', punt: 'punt', fieldGoal: 'fieldGoal', extraPoint: 'extraPoint',
};

const firstOffenseCarrier = (state: PlayState, env: EngineEnv): Athlete | null => {
  for (const id of env.carrierHistory) {
    const a = findAthlete(state, id);
    if (a && a.side === 'offense') return a;
  }
  return null;
};

/** Derives the play facts from the dead state (optionally under an alternate ruling). */
/**
 * A scrimmage gain in whole yards that never contradicts the chains (the down & distance reads the fraction to go
 * rounded up): the rounded gain, except that a play short of the line to gain is at most one yard less than the
 * distance shown, and a first down is at least the distance shown. Only plays ending within a yard of the sticks
 * change, so the stat sheet stays unbiased. `raw` is the gain in (fractional) yards, `distance` the yards to go.
 */
export const chainYards = (raw: number, distance: number, firstDown: boolean): number => {
  const shown = Math.max(1, Math.ceil(distance - 1e-6));
  const g = Math.round(raw) + 0;
  return firstDown ? Math.max(g, shown) : Math.min(g, shown - 1);
};

export const deriveFacts = (state: PlayState, env: EngineEnv, alt?: AlternateRuling): OutcomeFacts => {
  const ctx = state.ctx;
  const dir = ctx.direction;
  const deadReason = alt?.deadReason ?? state.deadReason ?? 'timeExpired';
  const deadSpot = alt?.deadSpot ?? state.deadSpot ?? clone(state.ball.pos);
  const completion = alt?.wipeCompletion ? null : env.completion;
  const fake = isFakePlay(ctx.offensivePlay);
  // A punt that is never kicked (the punter runs, or is downed or chased out of his own end zone first) is a
  // scrimmage down: the kicking team still has the ball, so downs, rushing stats and a safety all go the usual way.
  const unkickedPunt = ctx.special === 'punt' && env.kick === null;
  const kickPlay = (ctx.special === 'kickoff' || ctx.special === 'onside' || ctx.special === 'punt') && !fake && !unkickedPunt;
  const fgPlay = (ctx.special === 'fieldGoal' || ctx.special === 'extraPoint') && !fake;
  const isScrimmage = !kickPlay && !fgPlay;
  const isPassPlay = PASS_TYPES.has(ctx.offensivePlay.type);
  const deadBallFoul = deadReason === 'penaltyDeadBall';
  const touchdown = deadReason === 'touchdown';
  const safety = deadReason === 'safety';
  const incomplete = deadReason === 'incomplete' || deadReason === 'spike';
  const outOfBounds = deadReason === 'outOfBounds' || deadReason === 'fumbleOutOfBounds';
  const carrier = ballCarrier(state);
  const scorer = touchdown ? (carrier ?? null) : null;
  const holderSide = env.possession;
  const lastFumble = env.fumbles[env.fumbles.length - 1];

  let turnover = false;
  let turnoverType: OutcomeFacts['turnoverType'] = null;
  if (kickPlay) {
    if (deadReason === 'onsideRecovered') { turnover = true; turnoverType = 'onside'; }
    else if (lastFumble && lastFumble.recoverySide === 'offense' && env.possession === 'offense') { turnover = true; turnoverType = 'fumble'; }
  } else if (!deadBallFoul && holderSide === 'defense') {
    turnover = true;
    turnoverType = env.interception ? 'interception' : 'fumble';
  }

  let endBallOn: number;
  if (incomplete || deadBallFoul) endBallOn = ctx.ballOn;
  else if (touchdown) endBallOn = holderSide === 'offense' ? 100 : 0;
  else if (safety) endBallOn = holderSide === 'offense' ? 0 : 100;
  else if (deadReason === 'touchback') endBallOn = 100;
  else endBallOn = ballOnAt(env, deadSpot.y);
  const endBallX = incomplete || deadBallFoul ? ctx.ballX : deadSpot.x;

  let yards = 0;
  if (isScrimmage && !incomplete && !deadBallFoul) {
    if (turnover) yards = env.interception ? 0 : lastFumble ? ballOnAt(env, lastFumble.pos.y) - ctx.ballOn : 0;
    else yards = endBallOn - ctx.ballOn;
  }
  // Whole yards, like the stat sheet: the spot itself (endBallOn) keeps its fraction, the box score does not, and
  // the team totals (rules/index.ts) add the same integers the player deltas carry.
  yards = Math.round(yards);

  const qbCarrier = firstOffenseCarrier(state, env);
  const qbScramble = isPassPlay && isScrimmage && !env.handoffDone && !env.pitched && state.pass === null && qbCarrier !== null && qbCarrier.id === env.qbId && !deadBallFoul;
  let result: PlayResultType;
  if (deadBallFoul) result = 'penalty';
  else if (deadReason === 'kneel') result = 'kneel';
  else if (deadReason === 'spike') result = 'spike';
  else if (env.sack) result = 'sack';
  else if (env.interception) result = 'interception';
  else if (incomplete) result = 'incomplete';
  else if (completion) result = 'pass';
  else if (!isScrimmage && env.kick && ctx.special !== 'none' && ctx.special !== 'twoPoint') result = SPECIAL_RESULT[ctx.special];
  else if (!isScrimmage && ctx.special !== 'none' && ctx.special !== 'twoPoint') result = SPECIAL_RESULT[ctx.special];
  else if (qbScramble) result = 'scramble';
  else result = 'run';

  const firstDown = isScrimmage && !turnover && !deadBallFoul && !incomplete && ((touchdown && holderSide === 'offense') || endBallOn >= Math.min(100, ctx.ballOn + ctx.distance) - 1e-9);
  // Whole yards that never contradict the chains: a play short of the line to gain never reads as reaching it ('gain of
  // 10' on 2nd & 10 with 3rd & 1 next), one that moves the chains never reads as short of it.
  if (isScrimmage && !turnover && !deadBallFoul && !incomplete && !touchdown && !safety) yards = chainYards(endBallOn - ctx.ballOn, ctx.distance, firstDown);
  const rusher = result === 'run' || result === 'scramble' ? (findAthlete(state, env.rusherId) ?? qbCarrier) : null;
  const passer = state.pass ? findAthlete(state, state.pass.throwerId) : env.sack ? findAthlete(state, env.qbId) : null;
  const receiver = state.pass ? findAthlete(state, state.pass.targetId) : null;
  const tackle = deadReason === 'tackle' || deadReason === 'forwardProgress' ? env.lastTackle : null;

  const k = env.kick;
  let kickMade: boolean | null = null;
  let kickDistance: number | null = null;
  if (k && fgPlay) {
    kickMade = k.made ?? false;
    kickDistance = k.carry;
  } else if (k && kickPlay && !k.blocked) {
    const land = k.landing ?? deadSpot;
    kickDistance = Math.round(k.kind === 'punt' ? dir * (land.y - state.losY) : dir * (land.y - k.kickSpot.y));
  }
  let returnYards = 0;
  if (k && k.returnStart && !k.blocked) returnYards = Math.round(attackDir(env, 'defense') * (deadSpot.y - k.returnStart.y));
  else if (env.interception && turnover) returnYards = Math.round(attackDir(env, 'defense') * (deadSpot.y - env.interception.pos.y));
  else if (turnover && lastFumble && lastFumble.recoveredBy) {
    const rec = findAthlete(state, lastFumble.recoveredBy);
    if (rec) returnYards = Math.round(attackDir(env, 'defense') * (deadSpot.y - lastFumble.pos.y));
  }
  if (touchdown && returnYards < 0) returnYards = 0;
  // No return happened: a touchback (even one run out of and back into the end zone) or a fair catch.
  if (deadReason === 'touchback' || deadReason === 'fairCatch') returnYards = 0;

  const airYards = completion ? Math.round(completion.airYards) : state.pass ? Math.round(state.pass.airYards) : 0;
  const yac = completion && !turnover ? Math.max(0, Math.round(endBallOn - ballOnAt(env, completion.pos.y))) : 0;
  let yardsAfterContact = 0;
  if (state.firstContactY !== null && !turnover && !incomplete && isScrimmage) yardsAfterContact = Math.max(0, Math.round(dir * (deadSpot.y - state.firstContactY)));
  const explosive = isExplosive(result, yards);

  let points = 0;
  if (fgPlay && kickMade) points = ctx.special === 'extraPoint' ? 1 : 3;
  if (ctx.special === 'twoPoint' && !turnover && (touchdown || endBallOn >= 100)) points = 2;
  const epaTurnover = kickPlay || fgPlay ? !turnover && !(fgPlay && kickMade) : turnover;
  const epa = deadBallFoul ? 0 : playEpa({ down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn, turnover: epaTurnover, touchdown, safety, points, firstDown });
  const success = isScrimmage && !turnover && !deadBallFoul && ((touchdown && holderSide === 'offense') || isSuccessfulPlay(ctx.down, ctx.distance, yards));

  // Free kicks start the game clock only when the ball comes down or is fielded (systems/clock-start.ts): a touchback
  // or a kick out of bounds never touched in the field of play runs no time off.
  const freeKick = ctx.special === 'kickoff' || ctx.special === 'onside';
  const clockTick = !freeKick ? state.snapTick : deadReason === 'touchback' ? null
    : state.clockStartTick ?? (k && (k.landing !== null || k.fieldedBy !== null) ? state.tick : null);
  const timeElapsed = env.snapped && clockTick !== null ? (Math.max(0, state.tick - clockTick) / TICK_RATE) * liveClockScale(ctx.special) : 0;
  const clockRunning = ctx.clockRunning ?? true;
  // The game clock ran from the previous whistle: the huddle / line-up (or the hurry-up runoff) plus the seconds
  // the engine actually spent pre-snap, never more than one full play clock.
  const huddleSec = ctx.hurryUp ? Math.min(HURRY_UP_RUNOFF_SEC, ctx.ruleset.huddleRunoffSec) : huddleSeconds(ctx.ruleset);
  const enginePresnapSec = (env.snapped ? state.snapTick : state.tick) / TICK_RATE;
  // A kneel is victory formation: the offense lets the play clock run down however early the snap is pressed.
  const huddled = Math.min(ctx.ruleset.playClockSec, huddleSec + enginePresnapSec);
  const kneeling = ctx.offensivePlay.type === 'kneel' && ctx.special === 'none';
  const presnapElapsed = ctx.special === 'kickoff' || ctx.special === 'onside' || !clockRunning ? 0 : kneeling ? Math.max(huddled, victoryFormationRunoffSec(ctx.ruleset)) : huddled;

  return {
    result, yards, endBallOn, endBallX, turnover, turnoverType, touchdown, safety, firstDown, incomplete, outOfBounds, kickMade, kickDistance, returnYards,
    rusher, passer, receiver, completion, tackle, scorer, carrier, airYards, yac, yardsAfterContact, explosive, isScrimmage, isPassPlay, success, epa, timeElapsed, presnapElapsed,
  };
};

/**
 * Roughing the passer on a completion the offense kept is added to the end of the play (the catch and run stand);
 * on an incompletion or a turnover it stays a previous-spot foul that wipes the play out.
 */
export const roughingOnCompletion = (penalties: readonly PenaltyInfo[], completedAndKept: boolean): PenaltyInfo[] =>
  penalties.map((p) => (p.foul === 'roughingPasser' && completedAndKept ? { ...p, enforcement: 'endOfPlay' as const } : p));

const fatigueAfter = (state: PlayState, env: EngineEnv): Record<string, number> => {
  const out: Record<string, number> = {};
  const mult = fatigueRateMultiplier(state.ctx.weather);
  for (const a of state.athletes) {
    const t = env.tracks[a.id] ?? { distance: 0, sprintSeconds: 0, contacts: 0 };
    const gained = fatigueFromPlay(a.baseAttrs, { distanceYards: t.distance, sprintSeconds: t.sprintSeconds, contacts: t.contacts }) * mult;
    out[a.playerId] = applyFatigue(a.fatigue, gained);
  }
  return out;
};

/** Builds the PlayOutcome for a dead play (or the alternate ruling for a review). */
export const buildOutcome = (liveState: PlayState, liveEnv: EngineEnv, alt?: AlternateRuling): PlayOutcome => {
  if (!alt) flagCloseCalls(liveState, liveEnv);
  // A 'down by contact' reversal rebuilds the play from a view in which the fumble never happened.
  const { state, env } = alt?.wipeFumbleAt !== undefined ? fumbleWipedView(liveState, liveEnv, alt.wipeFumbleAt) : { state: liveState, env: liveEnv };
  const ctx = state.ctx;
  const facts = deriveFacts(state, env, alt);
  const kickReturner = env.kick?.fieldedBy ? findAthlete(state, env.kick.fieldedBy) : null;
  const receiverPlayer = facts.completion ? findAthlete(state, facts.completion.receiverId) : null;
  const ballCarrierId = facts.rusher?.playerId ?? receiverPlayer?.playerId ?? kickReturner?.playerId ?? (env.sack ? facts.passer?.playerId ?? null : null);
  let replayId: string | null = null;
  if (!alt && state.recordFrames && env.opts.replayStore && env.opts.replayStore.retention !== 'off') {
    replayId = `replay:${ctx.playIndex}:${ctx.rng.seed}`;
    env.opts.replayStore.push(buildRecording(state, replayId));
  }
  const o = emptyOutcome({
    result: facts.result,
    yards: facts.yards,
    endBallOn: facts.endBallOn,
    endBallX: facts.endBallX,
    turnover: facts.turnover,
    turnoverType: facts.turnoverType,
    touchdown: facts.touchdown,
    safety: facts.safety,
    outOfBounds: facts.outOfBounds,
    incomplete: facts.incomplete,
    firstDown: facts.firstDown,
    timeElapsed: facts.timeElapsed,
    presnapElapsed: facts.presnapElapsed,
    penalties: roughingOnCompletion(env.penalties, facts.completion !== null && !facts.turnover),
    kickMade: facts.kickMade,
    kickDistance: facts.kickDistance,
    returnYards: facts.returnYards,
    ballCarrierId,
    passerId: facts.passer?.playerId ?? null,
    receiverId: facts.receiver?.playerId ?? null,
    tacklerIds: facts.tackle ? [facts.tackle.tackler, ...facts.tackle.assists].map((id) => findAthlete(state, id)?.playerId ?? null).filter((p): p is NonNullable<typeof p> => p !== null) : env.sack ? [env.sack.by, ...env.sack.assists].map((id) => findAthlete(state, id)?.playerId ?? null).filter((p): p is NonNullable<typeof p> => p !== null) : [],
    events: eventsForRuling(state.events, facts, alt),
    airYards: facts.airYards,
    yac: facts.yac,
    yardsAfterContact: facts.yardsAfterContact,
    separationAtThrow: state.pass ? Math.round(state.pass.separationAtThrow * 10) / 10 : null,
    underPressure: state.pass?.underPressure ?? false,
    bigPlay: facts.explosive || facts.touchdown || facts.turnover,
    replayId,
    injuries: env.injuries.map((i) => ({ ...i })),
    fatigueAfter: fatigueAfter(state, env),
    epa: Math.round(facts.epa * 1000) / 1000,
    success: facts.success,
  }, ctx.offense);
  o.stats = buildStatDeltas(state, env, facts);
  o.playByPlay = buildPlayByPlay(state, env, facts, alt);
  if (!alt && env.review) o.review = { call: { ...env.review.call }, ifOverturned: buildOutcome(liveState, liveEnv, env.review.alternate) };
  return o;
};
