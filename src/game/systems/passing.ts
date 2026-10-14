import { clamp01, ratingToFactor } from '@/core/math';
import { add, angle, angleDiff, clone, dist, dot, len, sub, type Vec2 } from '@/core/vec2';
import { launchPass, throwBall } from '@/physics/ball';
import { maxSpeed } from '@/physics/speed';
import { ballCarrier, findAthlete } from '../athlete';
import { chemistryFor } from '../chemistry';
import type { AthleteIntent } from '../engine-api';
import type { ThrowType } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_WIDTH, MIDDLE_X } from '../types';
import { ballOnAt, depthOf, emit, isHuman, setTimedState, type EngineEnv } from './env';
import { passGrounded, resolvePassArrival } from './pass-arrival';
import { addFoul } from './penalties-live';
import { inTheGrasp } from './tackle-struggle';
import { difficultyFor } from '../difficulty-sides';

/**
 * Forward passes. On a 'throw' intent the ball is launched toward a lead point (the intent's throwTarget or
 * the receiver's predicted position at arrival) with an error vector sampled from the play rng and scaled by
 * the throw difficulty: distance vs arm, accuracy, awareness, pressure, separation, throw type, weather,
 * fatigue, throwing on the move and QB-receiver chemistry (PlayContext.passChemistry). The human's pass assist shrinks the error. Throw-aways go to the sideline
 * and draw intentional grounding when thrown from inside the tackle box under pressure with nobody near.
 * A 'throw' intent with a throwTarget and NO targetId is a throw to a spot (the human's pull-back pass): the ball is
 * aimed at that point with no lead, and the receiver who gets there best (spotThrowReceiver) becomes its target, so
 * receivers and defenders play it like any other pass. Nobody near it from inside the tackle box under pressure is
 * intentional grounding, as for a throw-away.
 */
export const PRESSURE_RADIUS = 2.5;
export const CLOSING_RADIUS = 4;
export const TACKLE_BOX_HALF = 4;
export const GROUNDING_RADIUS = 6;
/** Difficulty swing from QB-receiver chemistry: +/- half this between a cold pair (0) and a perfect one (1). */
export const CHEMISTRY_DIFFICULTY = 0.12;

const f = (r: number): number => ratingToFactor(r);

export interface ThrowDifficulty {
  difficulty: number;
  underPressure: boolean;
  /** Any rusher on him or closing fast (the full pressurers set): what intentional grounding keys off. */
  threatened: boolean;
  separation: number;
  pressurers: Athlete[];
}

/** Rushers pressuring the passer: within PRESSURE_RADIUS, or within CLOSING_RADIUS and closing fast. */
export const pressurers = (state: PlayState, passer: Athlete): Athlete[] =>
  state.athletes.filter((d) => {
    if (!d.active || d.side === passer.side || d.state === 'engaged' || d.state === 'down') return false;
    const dd = dist(d.pos, passer.pos);
    if (dd <= PRESSURE_RADIUS) return true;
    return dd <= CLOSING_RADIUS && dot(d.vel, sub(passer.pos, d.pos)) / Math.max(dd, 1e-6) > 1.5;
  });

const TYPE_ADJ: Record<ThrowType, number> = { bullet: 0, touch: 0, lob: 0.03, backShoulder: 0.08, highPoint: 0.05, throwAway: -0.1 };

/**
 * 0..1 difficulty of a throw at release. `motion` is the passer's velocity for the throwing-on-the-move cost: his
 * velocity when the throwing motion began (defaults to his current one).
 */
export const throwDifficulty = (
  state: PlayState, passer: Athlete, target: Athlete | null, aim: Vec2, throwType: ThrowType, motion: Vec2 = passer.vel,
): ThrowDifficulty => {
  const a = passer.attrs;
  const w = state.ctx.weather;
  const d = dist(passer.pos, aim);
  const distFactor = clamp01((d - 10) / 30) * (1 - 0.5 * f(a.throwPower));
  const acc = 0.35 * (1 - f(a.throwAccuracy));
  const rushers = pressurers(state, passer);
  // Graded by how close the nearest rusher is: a man in the passer's face costs the full penalty, one still closing
  // from four yards only a little.
  const nearest = rushers.reduce((m, r) => Math.min(m, dist(r.pos, passer.pos)), Infinity);
  const pressure = rushers.length > 0 ? 0.3 * clamp01((CLOSING_RADIUS - nearest) / 2.5) : 0;
  let separation = 99;
  if (target) for (const o of state.athletes) if (o.active && o.side !== target.side) separation = Math.min(separation, dist(o.pos, target.pos));
  const sepFactor = target ? clamp01(1 - separation / 6) * 0.15 : 0;
  const typeAdj = TYPE_ADJ[throwType] + (throwType === 'bullet' && d > 25 ? 0.05 : 0);
  const weather = clamp01(w.windMph / 40) * 0.2 + clamp01(w.precipitation) * 0.1 + (1 - clamp01(w.visibility)) * 0.1;
  const fatigue = passer.fatigue * 0.15;
  const moving = clamp01(len(motion) / 6) * 0.15;
  const offPlatform = Math.abs(angleDiff(passer.facing, angle(sub(aim, passer.pos)))) > Math.PI / 3 ? 0.1 : 0;
  const awareness = -0.1 * f(a.awareness);
  // A passer and a target who have played together read the same leverage and land the ball on time.
  const chemistry = target ? CHEMISTRY_DIFFICULTY * (0.5 - chemistryFor(state.ctx.passChemistry, target.playerId)) : 0;
  const difficulty = clamp01(0.06 + distFactor + acc + pressure + sepFactor + typeAdj + weather + fatigue + moving + offPlatform + awareness + chemistry);
  // The pressure charged to the throw (the stat and the extra bad-ball chance) is a rusher actually on the passer.
  const onHim = rushers.filter((r) => dist(r.pos, passer.pos) <= PRESSURE_RADIUS);
  return { difficulty, underPressure: onHim.length > 0, threatened: rushers.length > 0, separation: target ? separation : 0, pressurers: onHim };
};

/** Extra throw difficulty for a passer getting the ball away with a defender hanging on him (in the grasp). */
export const IN_GRASP_DIFFICULTY = 0.25;

/** Standard deviation (yd, per axis) of the placement error for a difficulty. */
export const errorSigma = (difficulty: number): number => 0.5 + 3.0 * difficulty;
/** Share of throws that are simply bad balls (sailed or short) at 1 accuracy; a poor arm doubles it. */
export const BAD_BALL_BASE = 0.08;
/** Extra bad-ball chance on a deep ball (ramping in from 15 yd of throw to its full value at 40): the long ones are
 *  the ones that get away. */
export const BAD_BALL_DEEP = 0.22;
/** Extra placement error (yd) on a bad ball that sails. */
export const BAD_BALL_YARDS = 4.5;
/** Height (yd) a sailed bad ball still has when it reaches the (overthrown) aim point: over a leaping receiver. */
export const BAD_BALL_SAIL_HEIGHT = 4.2;
/** Yards to one side of the receiver's line a bad ball goes. */
export const BAD_BALL_WIDE = 2;
/** Yards short of the receiver a bad ball dies. */
export const BAD_BALL_SHORT_YARDS = 2.5;
/** Height (yd) a short bad ball is aimed to reach at its spot: the turf, at the receiver's feet. */
export const BAD_BALL_SHORT_HEIGHT = 0;

/** Engine default throw type by distance. */
export const defaultThrowType = (distance: number): ThrowType => (distance <= 15 ? 'bullet' : distance <= 28 ? 'touch' : 'lob');

/** Lead point: the receiver's position after the flight time, converged over two iterations. */
export const leadPoint = (passer: Athlete, target: Athlete, throwType: ThrowType): Vec2 => {
  let aim = clone(target.pos);
  for (let i = 0; i < 2; i++) {
    const t = launchPass(passer.pos, aim, throwType, passer.attrs.throwPower).flightTime;
    aim = { x: target.pos.x + target.vel.x * t, y: target.pos.y + target.vel.y * t };
  }
  return aim;
};

/** A spot out of bounds past the nearest sideline, a few yards downfield of the passer. */
export const throwAwayAim = (state: PlayState, passer: Athlete): Vec2 => ({
  x: passer.pos.x < MIDDLE_X ? -4 : FIELD_WIDTH + 4,
  y: passer.pos.y + state.ctx.direction * 8,
});

/** Farthest (yd) from a spot throw's landing point a receiver can still be the ball's target. */
export const SPOT_CLAIM_RADIUS = 14;
/** Seconds behind the ball a receiver may arrive at the spot and still be its target. */
export const SPOT_CLAIM_LATE = 1.5;
/**
 * Seconds a man loses getting up to speed toward a spot he is not already running at (standing: the whole lag; one
 * already at full speed toward it: none).
 */
export const SPOT_ACCEL_LAG = 0.7;

/** Seconds for `r` to reach `spot`: top speed over the distance, plus the lag of getting going in that direction. */
export const spotArrival = (r: Athlete, spot: Vec2): number => {
  const d = dist(r.pos, spot);
  const top = Math.max(1, maxSpeed(r.attrs.speed));
  const along = d > 1e-6 ? (r.vel.x * (spot.x - r.pos.x) + r.vel.y * (spot.y - r.pos.y)) / d : top;
  return d / top + SPOT_ACCEL_LAG * clamp01(1 - along / top);
};

/** Score handicap (yd) for an eligible man who is not running a route (a back carrying out a fake or a mesh). */
const SPOT_NON_ROUTE = 6;
/** Assignments whose AI plays a ball thrown to him (route runners, chip-and-release men, the designed carrier). */
const SPOT_PLAYERS: ReadonlySet<string> = new Set(['route', 'chipRelease', 'carry']);

/**
 * The receiver a ball thrown to `spot` is meant for: of the passer's eligible teammates still up and free (not locked
 * in a block) whose AI plays a thrown ball (SPOT_PLAYERS; a man staying in to pass block never looks for it), the one
 * who can be at the spot soonest relative to the ball's flight (from where he is, at his top speed), then the one whose
 * current run carries him closest to it (a man streaking at a deep ball beats one standing near where it was thrown);
 * route runners first. A man may be as far from the spot as SPOT_CLAIM_RADIUS plus what he can cover while the ball is
 * in the air (a 40-yard lead on a vertical is his), arriving (spotArrival) no later than SPOT_CLAIM_LATE after it. Null when nobody can get there.
 */
export const spotThrowReceiver = (state: PlayState, passer: Athlete, spot: Vec2, throwType: ThrowType): Athlete | null => {
  const flight = launchPass(passer.pos, spot, throwType, passer.attrs.throwPower).flightTime;
  let best: Athlete | null = null;
  let bestScore = Infinity;
  for (const r of state.athletes) {
    if (!r.active || r.side !== passer.side || r.id === passer.id || !r.eligible || !SPOT_PLAYERS.has(r.assignment.type)) continue;
    if (r.state === 'down' || r.state === 'tackled' || r.state === 'engaged') continue;
    const d = dist(r.pos, spot);
    const top = Math.max(1, maxSpeed(r.attrs.speed));
    if (d > SPOT_CLAIM_RADIUS + top * flight) continue;
    const late = spotArrival(r, spot) - flight;
    if (late > SPOT_CLAIM_LATE) continue;
    const route = r.assignment.type === 'route' || r.assignment.type === 'chipRelease';
    // Where his current run takes him while the ball is in the air (no further than the spot's distance from him).
    const run = Math.min(flight, d / top);
    const carried = dist({ x: r.pos.x + r.vel.x * run, y: r.pos.y + r.vel.y * run }, spot);
    const score = Math.max(0, late) * 8 + Math.min(d, carried) + (route ? 0 : SPOT_NON_ROUTE);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
};

/**
 * An eligible receiver is in the area of a ball thrown away (no intentional grounding): within GROUNDING_RADIUS of
 * where it lands, or able to get there by the time it does (SPOT_CLAIM_LATE after its flight).
 */
const receiverInArea = (state: PlayState, aimPoint: Vec2, flight: number): boolean =>
  state.athletes.some((r) => {
    if (!r.active || r.side !== 'offense' || !r.eligible || r.hasBall) return false;
    return dist(r.pos, aimPoint) <= GROUNDING_RADIUS || spotArrival(r, aimPoint) <= flight + SPOT_CLAIM_LATE;
  });

const nearestDefender = (state: PlayState, target: Athlete): Athlete | null =>
  state.athletes.filter((o) => o.active && o.side !== target.side).sort((p, q) => dist(p.pos, target.pos) - dist(q.pos, target.pos))[0] ?? null;

const throwPass = (state: PlayState, env: EngineEnv, passer: Athlete, intent: AthleteIntent, motion: Vec2 = passer.vel): void => {
  const throwAway = intent.action === 'throwAway' || intent.throwType === 'throwAway';
  const spot = !throwAway && intent.action === 'throw' && !intent.targetId && intent.throwTarget ? clone(intent.throwTarget) : null;
  const spotType = spot ? intent.throwType ?? defaultThrowType(dist(passer.pos, spot)) : null;
  const target = throwAway ? null : spot && spotType ? spotThrowReceiver(state, passer, spot, spotType) : findAthlete(state, intent.targetId);
  if (!throwAway && !spot && (!target || !target.active || target.side !== 'offense' || target.id === passer.id)) return;
  let aim: Vec2;
  let throwType: ThrowType;
  if (spot && spotType) {
    throwType = spotType;
    aim = spot;
  } else if (throwAway || !target) {
    throwType = 'throwAway';
    aim = intent.throwTarget ? clone(intent.throwTarget) : throwAwayAim(state, passer);
  } else {
    throwType = intent.throwType ?? defaultThrowType(dist(passer.pos, target.pos));
    aim = intent.throwTarget ? clone(intent.throwTarget) : leadPoint(passer, target, throwType);
  }
  const diff = throwDifficulty(state, passer, target, aim, throwType, motion);
  if (passer.state === 'wrapped') diff.difficulty = clamp01(diff.difficulty + IN_GRASP_DIFFICULTY);
  const human = passer.controlled && isHuman(state.ctx, passer);
  let sigma = errorSigma(diff.difficulty) * (human ? 1 - 0.5 * difficultyFor(state, passer).userPassAssist : 1);
  if (throwType === 'throwAway') sigma *= 0.5;
  // Most throws land within the sigma; a few are just bad balls that sail or die short (more for poor arms and
  // under pressure), which no receiver adjustment brings back.
  const deep = BAD_BALL_DEEP * clamp01((dist(passer.pos, aim) - 15) / 25);
  const badChance = throwType === 'throwAway' ? 0 : (BAD_BALL_BASE * (2 - f(passer.attrs.throwAccuracy)) + deep + (diff.underPressure ? 0.1 : 0)) * (human ? 1 - 0.5 * difficultyFor(state, passer).userPassAssist : 1);
  // A bad ball either sails (arrives over his hands and carries on past him) or dies short at his feet.
  const badKind = env.rng.chance(badChance) ? (env.rng.chance(0.6) ? 1 : -1) : 0;
  const bad = badKind > 0 ? BAD_BALL_YARDS : badKind < 0 ? -BAD_BALL_SHORT_YARDS : 0;
  env.errantPass = badKind;
  const along = dist(passer.pos, aim) > 1e-6 ? { x: (aim.x - passer.pos.x) / dist(passer.pos, aim), y: (aim.y - passer.pos.y) / dist(passer.pos, aim) } : { x: 0, y: 0 };
  // ...and off to one side of him (a receiver at full speed cannot turn back for a ball behind him).
  const wide = badKind !== 0 ? BAD_BALL_WIDE * (env.rng.chance(0.5) ? 1 : -1) : 0;
  const aimPoint = add(aim, { x: env.rng.gaussian(0, sigma) + along.x * bad - along.y * wide, y: env.rng.gaussian(0, sigma) + along.y * bad + along.x * wide });
  const armScale = 1 - 0.15 * passer.fatigue - 0.1 * clamp01(len(motion) / 6);
  const launch = launchPass(passer.pos, aimPoint, throwType, passer.attrs.throwPower, {
    armScale, ...(badKind !== 0 ? { catchHeight: badKind > 0 ? BAD_BALL_SAIL_HEIGHT : BAD_BALL_SHORT_HEIGHT } : {}),
  });
  state.ball = throwBall(state.ball, passer, launch, { id: target?.id ?? null, pos: aimPoint }, throwType, state.tick);
  passer.hasBall = false;
  setTimedState(passer, 'throwing', 0.3);
  const release = clone(passer.pos);
  const airYards = depthOf(state, launch.aimPoint.y);
  state.pass = {
    throwerId: passer.id, targetId: target?.id ?? null, throwType, difficulty: diff.difficulty, airYards, releaseTick: state.tick, releasePos: release,
    passerOutsideTackleBox: Math.abs(passer.pos.x - state.snapX) > TACKLE_BOX_HALF, underPressure: diff.underPressure, separationAtThrow: diff.separation,
  };
  env.passerId = passer.id;
  env.releaseTime = state.time;
  for (const r of diff.pressurers) {
    if (env.pressureIds.has(r.id)) continue;
    env.pressureIds.add(r.id);
    emit(state, { type: 'pressure', tick: state.tick, by: r.id });
  }
  if (target) env.coverDefenderId = nearestDefender(state, target)?.id ?? null;
  emit(state, { type: 'throw', tick: state.tick, thrower: passer.id, target: target?.id ?? null, throwType, airYards, difficulty: diff.difficulty });
  if (depthOf(state, release.y) > 0) addFoul(state, env, 'illegalForwardPass', passer, { spotBallOn: ballOnAt(env, release.y) });
  // Grounding is throwing it away to dodge an imminent loss: a rusher closing from a few yards counts, not only one
  // already on him (the narrower underPressure is the stat and the accuracy penalty).
  if ((throwType === 'throwAway' || (spot && !target)) && !state.pass.passerOutsideTackleBox && diff.threatened) {
    // A spot throw is to a man who can reach it; a throw-away button is judged only by who is near where it lands.
    const near = spot ? receiverInArea(state, aimPoint, launch.flightTime) : state.athletes.some((r) => r.active && r.side === 'offense' && r.eligible && dist(r.pos, aimPoint) <= GROUNDING_RADIUS);
    if (!near) addFoul(state, env, 'intentionalGrounding', passer, { spotBallOn: ballOnAt(env, release.y) });
  }
};

/**
 * Seconds of throwing motion between the AI passer's decision to throw and the release. The passer plants for it, and
 * a rusher who gets to him inside it finishes the sack (or the strip) instead of watching the ball leave on the same
 * tick. The AI decides on the tick it sees the read, so this stands in for the motion a human's own reaction already
 * costs him.
 */
export const THROW_WINDUP = 0.115;

/**
 * Human feel setting: seconds of wind-up for a human-controlled passer. Zero, so the ball leaves on the tick the throw
 * button is pressed; the player's own reaction and input time is his throwing motion, and a further engine delay reads
 * as input lag. Not difficulty-dependent.
 */
export const USER_THROW_WINDUP = 0;

/** Wind-up seconds for this passer. */
export const throwWindup = (state: PlayState, passer: Athlete): number =>
  (passer.controlled && isHuman(state.ctx, passer) ? USER_THROW_WINDUP : THROW_WINDUP);

/**
 * Starts the wind-up (or throws at once when it is zero); the aim at a moving receiver is advanced by the wind-up so
 * the lead point stays true, and the passer's velocity is kept for the on-the-run cost at release.
 */
const startWindup = (state: PlayState, env: EngineEnv, passer: Athlete, intent: AthleteIntent): void => {
  const windup = throwWindup(state, passer);
  if (windup <= 0) {
    throwPass(state, env, passer, intent);
    return;
  }
  const target = findAthlete(state, intent.targetId);
  const lead = intent.throwTarget && target && intent.action === 'throw'
    ? { x: intent.throwTarget.x + target.vel.x * windup, y: intent.throwTarget.y + target.vel.y * windup }
    : intent.throwTarget;
  const stored: AthleteIntent = { ...intent };
  if (lead) stored.throwTarget = clone(lead);
  env.pendingThrow = { passerId: passer.id, intent: stored, releaseAt: state.time + windup - 1e-6, motion: clone(passer.vel) };
  // A passer in the grasp throws with the defender still hanging on him: he stays held (the struggle keeps him).
  if (passer.state !== 'wrapped') setTimedState(passer, 'throwing', windup + 0.02);
};

/** One tick of passing: launches a throw, or resolves the ball in flight. */
export const passingSystem = (state: PlayState, env: EngineEnv): void => {
  if (state.phase !== 'live') return;
  const ball = state.ball;
  const passKind = ball.kind === 'pass' || ball.kind === 'tip';
  if (ball.phase === 'inAir' && passKind) {
    resolvePassArrival(state, env);
    return;
  }
  if (ball.phase === 'loose' && passKind) {
    passGrounded(state, env);
    return;
  }
  if (ball.phase !== 'held' || state.pass !== null) {
    env.pendingThrow = null;
    return;
  }
  const holder = ballCarrier(state);
  const pending = env.pendingThrow ?? null;
  if (!holder || !holder.active || holder.side !== 'offense') {
    env.pendingThrow = null;
    return;
  }
  if (pending) {
    // The wind-up survives only while the same passer is still on his feet with the ball.
    // A passer held past the in-the-grasp window has been wrapped up before the ball left: no throw.
    const heldDown = holder.state === 'wrapped' && !inTheGrasp(state, env, holder);
    if (pending.passerId !== holder.id || holder.state === 'tackled' || holder.state === 'down' || holder.state === 'sliding' || holder.state === 'falling' || heldDown) env.pendingThrow = null;
    else {
      if (state.time >= pending.releaseAt) {
        env.pendingThrow = null;
        throwPass(state, env, holder, pending.intent, pending.motion);
      }
      return;
    }
  }
  if (holder.state === 'tackled' || holder.state === 'down' || holder.state === 'sliding' || holder.state === 'throwing' || holder.state === 'falling') return;
  if (holder.state === 'wrapped' && !inTheGrasp(state, env, holder)) return;
  const intent = state.intents[holder.id];
  if (!intent || (intent.action !== 'throw' && intent.action !== 'throwAway')) return;
  startWindup(state, env, holder, intent);
};
