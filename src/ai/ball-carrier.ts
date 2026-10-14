import { clamp01 } from '@/core/math';
import { angle, angleDiff, dist, dot, len, normalize, rotate, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentAction, type IntentDecider } from '@/game/engine-api';
import { ballCarrier } from '@/game/athlete';
import { FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import type { Athlete, PlayState } from '@/game/play-types';
import { predictLanding, CATCH_HEIGHT } from '@/physics/ball';
import { interceptPoint, pointSegmentDistance } from '@/physics/collision';
import { momentumAdvantage } from '@/physics/contact';
import { maxSpeed } from '@/physics/speed';
import { gapLocalX, gapPoint, stalkBlockIntent } from './blocking';
import {
  canPlay, chaseBallIntent, depthOf, downfield, f, goalLineY, jitter, opponentsOf, routeAlignment, steerTo, teammatesOf,
  timeSinceSnap, toField, toLocal,
} from './route-running';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Ball-carrier vision and the 'carry' decider. Anyone holding the ball (backs, receivers after a catch, a
 * scrambling QB) shares `carryIntent`: sample candidate lanes, score them by where defenders can intercept,
 * which blockers are in the way, the sideline, the sticks and the goal line, cut at an agility-limited rate,
 * pick a special move against the nearest closing tackler, burst in the open field, and handle the clock
 * situations (step out when trailing late, protect the ball when leading late, slide/kneel for QBs).
 */

/** Candidate lane angles (radians from straight downfield). */
export const LANE_ANGLES: readonly number[] = [-70, -45, -22, 0, 22, 45, 70].map((d) => (d * Math.PI) / 180);
/** Seconds ahead a lane is projected. */
export const LANE_HORIZON = 1.1;
/** Seconds the designed gap keeps its bonus after the handoff. */
export const DESIGNED_SECONDS = 1.0;
/** Yards past the line before a QB on a designed run starts protecting himself with a slide. */
export const QB_RUN_SLIDE_DEPTH = 8;
/** Distance inside which a tackler triggers move/slide/dive decisions. */
export const THREAT_RANGE = 2.4;

export interface LaneScore {
  /** Unit direction of the lane. */
  dir: Vec2;
  /** Signed angle from downfield (radians). */
  angle: number;
  score: number;
  designed: boolean;
}

export interface ClockSituation {
  /** Trailing inside two minutes: get out of bounds. */
  wantOob: boolean;
  /** Leading late: protect the ball, no risky moves. */
  protect: boolean;
}

/** Clock-driven carrier priorities from the play context. */
export const clockSituation = (state: PlayState): ClockSituation => {
  const c = state.ctx;
  const endOfHalf = c.quarter === 2 || c.quarter >= 4;
  return {
    wantOob: c.scoreDiff < 0 && c.clockRemaining <= 120 && endOfHalf,
    protect: c.scoreDiff > 0 && c.clockRemaining <= 240 && c.quarter >= 4,
  };
};

/** 0..1 how well this carrier reads the field: vision, awareness, carrying and the difficulty knob. */
export const visionQuality = (athlete: Athlete, state: PlayState): number =>
  clamp01(0.4 * f(athlete.attrs.vision) + 0.2 * f(athlete.attrs.awareness) + 0.1 * f(athlete.attrs.carrying)
    + 0.3 * clamp01(difficultyFor(state, athlete).receiverIntelligence) + jitter(athlete, 'vision', 0.05));

/**
 * Score every candidate lane. `noise` (0..1) adds gaussian error drawn from ctx.rng so poor vision misjudges
 * lanes; `designed` (the run's aim point) gets a bonus so the back hits the hole before bouncing.
 */
export const evaluateLanes = (athlete: Athlete, state: PlayState, designed: Vec2 | null, noise: number): LaneScore[] => {
  const dir = state.ctx.direction;
  const down = downfield(state);
  const pos = athlete.pos;
  const speed = maxSpeed(athlete.attrs.speed) * 0.9;
  const opps = opponentsOf(athlete, state).filter(canPlay);
  const mates = teammatesOf(athlete, state).filter((m) => m.assignment.type !== 'qb');
  const sit = clockSituation(state);
  const goalY = goalLineY(state);
  const cur = athlete.ai.scratch.laneAngle;
  const H = LANE_HORIZON + 0.4;
  const cands: LaneScore[] = LANE_ANGLES.map((a) => ({ dir: rotate(down, a * dir), angle: a, score: 0, designed: false }));
  if (designed) {
    const dd = sub(designed, pos);
    if (len(dd) > 0.5) cands.push({ dir: normalize(dd), angle: angleDiff(angle(down), angle(dd)) * dir, score: 0, designed: true });
  }
  for (const c of cands) {
    const vel = scale(c.dir, speed);
    const P = { x: pos.x + vel.x * LANE_HORIZON, y: pos.y + vel.y * LANE_HORIZON };
    let score = dir * (P.y - pos.y);
    const edge = Math.min(P.x, FIELD_WIDTH - P.x);
    if (edge < 0.6) score += sit.wantOob ? 3 : -8;
    else score += (sit.wantOob ? 1.5 : -2) * clamp01(1 - edge / 4);
    if (dir * (pos.y - state.firstDownY) < 0 && dir * (P.y - state.firstDownY) >= 0) score += 2.5;
    if (dir * (pos.y - goalY) < 0 && dir * (P.y - goalY) >= 0) score += 5;
    for (const d of opps) {
      // Pursuit: can he get to where this lane leads? Discounted when a blocker has him.
      let chase = 0;
      const ip = interceptPoint({ pos: d.pos, speed: maxSpeed(d.attrs.speed) * (0.8 + 0.2 * f(d.attrs.pursuit)) }, { pos, vel });
      if (ip && ip.time <= H) chase = 4 * (1 - ip.time / H);
      const rel = sub(d.pos, pos);
      const along = dot(rel, c.dir);
      if (along < -0.5) chase *= 0.5; // already behind the carrier: has to chase
      const blocked = d.engagedWith !== null || mates.some((m) => dist(m.pos, d.pos) < 1.5);
      if (blocked) chase *= 0.3;
      else if (mates.some((m) => dist(m.pos, d.pos) < 3 && pointSegmentDistance(m.pos, d.pos, pos) < 1.2)) chase *= 0.5;
      // Occupancy: a body in the lane is a wall whether or not someone is blocking him (press the hole next to it).
      let wall = 0;
      if (along > -0.3 && along < 6) {
        const lat = Math.abs(rel.x * c.dir.y - rel.y * c.dir.x);
        if (lat < 0.8) wall = 9;
        else if (lat < 2) wall = 2.5 * (1 - lat / 2);
        if (blocked) wall *= 0.7;
      }
      score -= chase + wall;
    }
    score -= (0.35 * Math.abs(c.angle)) / (70 * Math.PI / 180);
    if (c.designed) score += 6;
    if (cur !== undefined && Math.abs(c.angle - cur) < 0.2) score += 0.4;
    if (noise > 0) score += state.ctx.rng.gaussian(0, 1.6 * noise);
    c.score = score;
  }
  return cands.sort((a, b) => b.score - a.score);
};

/** Nearest defender that is about to make contact (inside THREAT_RANGE and closing, or right on the carrier). */
export const closingThreat = (athlete: Athlete, state: PlayState): Athlete | null => {
  let best: Athlete | null = null;
  let bd = THREAT_RANGE;
  for (const d of opponentsOf(athlete, state)) {
    if (!canPlay(d) || d.engagedWith !== null) continue;
    const dd = dist(d.pos, athlete.pos);
    if (dd >= bd) continue;
    const closing = dd > 1e-6 ? dot(normalize(sub(athlete.pos, d.pos)), d.vel) : 1;
    if (closing > 0.3 || dd < 1.5) { bd = dd; best = d; }
  }
  return best;
};

/**
 * Pick the special move that best fits the carrier against `threat`: relative agility (juke/spin), strength and
 * momentum (truck/stiff arm), jumping vs a diving tackler (hurdle), and the approach angle. Returns null when
 * no move clears `threshold` (arcade rulesets lower it).
 */
export const chooseMove = (athlete: Athlete, state: PlayState, threat: Athlete, threshold = 0.12): IntentAction | null => {
  const a = athlete.attrs;
  const d = threat.attrs;
  const heading = len(athlete.vel) > 0.5 ? angle(athlete.vel) : athlete.facing;
  const approach = Math.abs(angleDiff(heading, angle(sub(threat.pos, athlete.pos))));
  const front = approach < 0.7;
  const side = approach >= 0.7 && approach < 1.9;
  const low = threat.state === 'diving' || threat.state === 'tackling';
  const exaggerated = state.ctx.ruleset.exaggeratedMoves ? 0.15 : 0;
  const scores: [IntentAction, number][] = [
    ['juke', f(a.agility) - f(d.agility) + 0.25 + (front ? 0.1 : side ? 0 : -0.3) + jitter(athlete, 'juke', 0.08)],
    ['spin', 0.8 * f(a.agility) - 0.5 * f(d.tackling) - 0.1 + (side ? 0.2 : front ? -0.1 : 0.3) + jitter(athlete, 'spin', 0.08)],
    ['stiffArm', f(a.strength) - 0.6 * f(d.tackling) - 0.1 + (side ? 0.25 : 0) + jitter(athlete, 'stiff', 0.08)],
    ['truck', 0.8 * momentumAdvantage(athlete, threat) + f(a.strength) - f(d.strength) - 0.1 * f(d.tackling) + (front ? 0.1 : -0.3) + jitter(athlete, 'truck', 0.08)],
    ['hurdle', f(a.jumping) - 0.45 + (low ? 0.5 : 0) + (front ? 0 : -0.5) + jitter(athlete, 'hurdle', 0.08)],
  ];
  let best: IntentAction | null = null;
  let bs = threshold - exaggerated;
  for (const [move, s] of scores) if (s > bs) { bs = s; best = move; }
  return best;
};

export interface CarryOptions {
  /** Aim point of the designed run (the QB passes its keep-side gap); null = open-field running. */
  designed?: Vec2 | null;
}

/** Yards to the nearest marker (first down or goal line) straight ahead; Infinity when none ahead. */
const markerAhead = (athlete: Athlete, state: PlayState): number => {
  const dir = state.ctx.direction;
  const ys = [state.firstDownY, goalLineY(state)];
  let best = Infinity;
  for (const y of ys) {
    const d = dir * (y - athlete.pos.y);
    if (d > -0.5 && d < best) best = d;
  }
  return best;
};

/** Intent for an athlete holding the ball (see module doc). */
export const carryIntent = (athlete: Athlete, state: PlayState, dt: number, opts: CarryOptions = {}): AthleteIntent => {
  const sc = athlete.ai.scratch;
  const c = state.ctx;
  const dir = c.direction;
  sc.carryT = (sc.carryT ?? 0) + dt;
  const depth = depthOf(athlete.pos, state);
  const play = c.offensivePlay;
  let designed: Vec2 | null = opts.designed ?? null;
  if (designed === null && play.runGap && play.ballCarrier === athlete.role && sc.carryT <= DESIGNED_SECONDS && depth < 0.5) {
    designed = gapPoint(play.runGap, state, 1.5);
  }
  const sit = clockSituation(state);
  const isQb = athlete.assignment.type === 'qb';
  const q = visionQuality(athlete, state);
  const interval = 0.5 - 0.3 * f(athlete.attrs.agility);
  sc.laneT = (sc.laneT ?? 0) + dt;
  if (sc.laneSet !== 1 || sc.laneT >= interval) {
    const best = evaluateLanes(athlete, state, designed, 1 - q)[0];
    if (best) {
      sc.laneAngle = best.angle;
      sc.laneX = best.dir.x;
      sc.laneY = best.dir.y;
      sc.laneScore = best.score;
      sc.laneSet = 1;
      sc.laneT = 0;
    }
  }
  let move: Vec2 = { x: sc.laneX ?? 0, y: sc.laneY ?? dir };
  const opps = opponentsOf(athlete, state).filter(canPlay);
  const threat = closingThreat(athlete, state);
  if (sit.wantOob) {
    const edgeX = athlete.pos.x < MIDDLE_X ? 0 : FIELD_WIDTH;
    const toEdge = Math.abs(athlete.pos.x - edgeX);
    if (toEdge < 4 && opps.some((d) => dist(d.pos, athlete.pos) < 3.5)) move = normalize({ x: Math.sign(edgeX - athlete.pos.x), y: dir * 0.4 });
  }
  const intent = idleIntent(designed ? 'carry: designed gap' : 'carry: lane');
  intent.move = move;
  const ahead = opps.some((d) => dist(d.pos, athlete.pos) < 4.5 && dot(sub(d.pos, athlete.pos), move) > 0);
  intent.sprint = !ahead || depth > 6;
  const marker = markerAhead(athlete, state);
  const airborne = athlete.state === 'diving' || athlete.state === 'sliding';
  // A QB gives himself up only once past the line: behind it a slide is just a sack he volunteered for. On a designed
  // QB run (a sneak, a draw) he runs like a back until he is loose in the second level.
  const designedQbRun = play.type === 'qbRun' && depth < QB_RUN_SLIDE_DEPTH;
  if (isQb && threat && c.ruleset.mode === 'simulation' && marker > 1.5 && depth >= 0 && !designedQbRun) {
    if (!airborne) intent.action = 'slide';
    intent.debug = 'slide';
    return intent;
  }
  if (threat && marker <= 1.5) {
    if (!airborne) intent.action = 'dive';
    intent.move = downfield(state);
    intent.debug = 'dive for marker';
    return intent;
  }
  const canMove = threat && !sit.protect && athlete.specialMoveCooldown <= 0 && (sc.lastMoveT === undefined || state.time - sc.lastMoveT > 1.0);
  if (threat && canMove) {
    const mv = chooseMove(athlete, state, threat, isQb ? 0.3 : 0.12);
    if (mv) {
      intent.action = mv;
      intent.debug = `${mv} vs ${threat.role}`;
      sc.lastMoveT = state.time;
    }
  } else if (threat && sit.protect) intent.debug = 'carry: protect ball';
  return intent;
};

/** Pre-handoff path for the designed carrier: to the mesh, then through the gap (or wide for a toss). */
const meshIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const play = state.ctx.offensivePlay;
  const gap = play.runGap ?? athlete.assignment.gap;
  const align = routeAlignment(athlete, state);
  if (!gap) return steerTo(athlete.pos, toField({ x: (Math.sign(align.x) || 1) * 4, y: -3 }, state), 0.6, false, 'release flat');
  const gx = gapLocalX(gap);
  const T = timeSinceSnap(state);
  if (play.concept === 'draw' && T < 0.5) return idleIntent('draw: sell pass');
  const depth = depthOf(athlete.pos, state);
  if (depth > -0.3) {
    const carrier = ballCarrier(state);
    if (depth > 1 && carrier && carrier.side === 'offense') return stalkBlockIntent(athlete, state, carrier.pos);
    return steerTo(athlete.pos, gapPoint(gap, state, 3), 0.7, false, 'carry out fake');
  }
  const toss = play.concept === 'outsideRun' && Math.abs(gx) >= 5 && align.y <= -5;
  if (toss) return steerTo(athlete.pos, toField({ x: gx * 1.1, y: -4.5 }, state), 0.85, false, 'toss path');
  // The mesh is where the quarterback is. Under center he steps back to about a yard deep, so the old gap-side spot
  // 0.8 yd off the line works; from shotgun / pistol he stays 3.5-5 yd deep, so the back crosses just in front of him
  // toward the gap side instead of racing past him to the line.
  const qb = state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb' && a.active);
  const qbLocal = qb ? toLocal(qb.pos, state) : null;
  const deepQb = qbLocal !== null && qbLocal.y < -2;
  const mesh = deepQb && qbLocal
    ? toField({ x: qbLocal.x + Math.max(-1, Math.min(1, gx * 0.25)), y: qbLocal.y + 0.7 }, state)
    : toField({ x: gx * 0.7, y: -0.8 }, state);
  return steerTo(athlete.pos, mesh, 0.85, false, 'to mesh');
};

/** Decider for assignment 'carry' (the designed ball carrier). */
export const decideCarry: IntentDecider = (athlete, state, dt) => {
  if (state.phase === 'presnap') return idleIntent('set');
  const chase = chaseBallIntent(athlete, state);
  if (chase) return chase;
  if (athlete.hasBall) return carryIntent(athlete, state, dt);
  const ball = state.ball;
  if (ball.phase === 'inAir' && ball.targetId === athlete.id) {
    const landing = predictLanding(ball, state.ctx.weather, CATCH_HEIGHT).pos;
    return steerTo(athlete.pos, landing, 1, dist(athlete.pos, landing) > 4, `track ${ball.kind}`);
  }
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'offense' && carrier.id !== athlete.id) {
    const qbKeeps = carrier.assignment.type === 'qb' && (carrier.ai.scratch.keep === 1 || carrier.ai.scratch.scrambling === 1);
    if (carrier.assignment.type !== 'qb' || qbKeeps) return stalkBlockIntent(athlete, state, carrier.pos);
  }
  if (ball.phase === 'inAir' && ball.kind === 'pass') {
    return stalkBlockIntent(athlete, state, predictLanding(ball, state.ctx.weather, CATCH_HEIGHT).pos, { engage: false });
  }
  return meshIntent(athlete, state);
};
