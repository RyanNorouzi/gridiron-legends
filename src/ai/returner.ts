import { TICK_DT } from '@/core/time';
import { add, cross, dist, dot, len, normalize, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentAction, type IntentDecider } from '@/game/engine-api';
import type { KickKind } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import { CATCH_HEIGHT, predictLanding, type LandingPrediction } from '@/physics/ball';
import { kickKindFor } from './kicker';
import { arrive, attackDirection, avoid, clampToField, decided, holdPosition, ownGoalY, predictedPos, seek, toward } from './movement';
import { fakeInProgress, kickLaunched, perceive, type Perception } from './perception';
import { pursueCarrier } from './pursuit';
import { afterTurnover, blockIntent, chaseLooseBall, convoyBlock, looseBallTarget } from './turnover';
import { athleteNoise, f, jitter } from './variance';

/**
 * Receiving-team deciders: 'defense:returner' fields the kick (fair catch under pressure, let punts die
 * inside the 10, kneel for a touchback when a kickoff lands 3+ yards deep; a kickoff he has time for he catches
 * coming forward) and returns it north-south behind his blocks, with vision for the widest lane and
 * attribute-driven moves; 'defense:returnBlock' blocks a kickoff man for man (each blocker takes the coverage man
 * in his slot across the field, sets up between him and the ball and takes him on), sets a wall off the landing
 * point on punts, and escorts the returner once his own man is beaten.
 */
export type FieldPlan = 'return' | 'fairCatch' | 'kneel' | 'letGo';

/** Kickoff landing depth (yards into the end zone) from which the returner takes a knee. */
export const TOUCHBACK_DEPTH = 3;
/** Coverage within this distance at arrival (scaled by awareness) makes a punt a fair catch. */
export const FAIR_CATCH_RADIUS = 5;
/** Punts landing inside this many yards of the goal line are left alone. */
export const LET_GO_INSIDE = 10;
/** Edge gap inside which a returner uses a move on a closing tackler. */
export const MOVE_GAP = 2.2;
/** Share of a blocked (engaged) coverage man's threat a returner reads into a lane. */
export const ENGAGED_DANGER = 0.35;
/** Lane score lost per yard of lateral shift: returners run north-south behind their blocks, not to the sideline. */
export const LANE_SHIFT_COST = 0.1;
/** Yards ahead the returner aims when he heads for his lane (a longer look is a shallower angle). */
export const LANE_LOOK_AHEAD = 12;
/** Punt-return lane choice: lateral cost per yard and look-ahead (the gunners are on the returner as he catches). */
export const PUNT_LANE_SHIFT_COST = 0.06;
export const PUNT_LANE_LOOK_AHEAD = 8;
/** Candidate return lanes (absolute x). */
const LANES: readonly number[] = [4, 10, 16, 22, MIDDLE_X, 31, 37, 43, 49];

const scratchPlan: Record<FieldPlan, number> = { return: 1, fairCatch: 2, kneel: 3, letGo: 4 };
const PLAN_BY_CODE: readonly FieldPlan[] = ['return', 'return', 'fairCatch', 'kneel', 'letGo'];

/** Nearest distance any coverage man will be from `spot` in `seconds` (assuming constant velocity). */
export const coverageAtArrival = (state: Pick<PlayState, 'athletes'>, spot: Vec2, seconds: number): number => {
  let best = Infinity;
  for (const a of state.athletes) {
    if (!a.active || a.side !== 'offense') continue;
    best = Math.min(best, dist(predictedPos(a, seconds), spot));
  }
  return best;
};

/** Yards from the returner's own goal line to `point` (negative inside the end zone). */
const yardsFromOwnGoal = (athlete: Athlete, state: PlayState, point: Vec2): number => state.ctx.direction * (ownGoalY(athlete, state) - point.y);

/**
 * How to play a kick coming down at `landing`: kneel deep kickoffs (or shallow ones under pressure), let
 * punts inside the 10 or in the end zone go, fair catch when the coverage will be on top of the catch (a
 * more aware returner judges the radius better), otherwise catch and go.
 */
export const fieldPlan = (athlete: Athlete, state: PlayState, kind: KickKind, landing: LandingPrediction): FieldPlan => {
  const seconds = landing.ticks * TICK_DT;
  const pressure = coverageAtArrival(state, landing.pos, seconds);
  const fromGoal = yardsFromOwnGoal(athlete, state, landing.pos);
  if (kind === 'kickoff' || kind === 'onside') {
    if (fromGoal <= -TOUCHBACK_DEPTH) return 'kneel';
    if (fromGoal < 0 && pressure <= 10) return 'kneel';
    return 'return';
  }
  if (fromGoal <= 0) return 'letGo';
  if (fromGoal <= LET_GO_INSIDE) return pressure > 12 && fromGoal >= 5 ? 'return' : 'letGo';
  const radius = FAIR_CATCH_RADIUS * (0.7 + 0.6 * f(athlete.attrs.awareness)) + jitter(athlete, 'fairCatch', 0.5);
  return pressure <= radius ? 'fairCatch' : 'return';
};

/**
 * The x of the widest return lane ahead, judged with the returner's vision. A kickoff returner trusts his man-for-man
 * blocks (an engaged coverage man counts ENGAGED_DANGER) and stays north-south; a punt returner, with only a thin wall
 * in front of him, reads every coverage man as live and picks his lane on the old, shorter look (PUNT_LANE_*).
 */
export const bestReturnLane = (athlete: Athlete, state: PlayState, kind: KickKind | null = null): number => {
  const punt = kind === 'punt';
  const attack = attackDirection(athlete, state);
  const vision = f(athlete.attrs.vision);
  const reach = 10 + 30 * vision;
  let best = athlete.pos.x;
  let bestScore = -Infinity;
  for (const x of LANES) {
    if (Math.abs(x - athlete.pos.x) > reach) continue;
    let danger = 0;
    for (const c of state.athletes) {
      if (!c.active || c.side === athlete.side) continue;
      const ahead = attack * (c.pos.y - athlete.pos.y);
      if (ahead < -2 || ahead > 25) continue;
      const cx = c.pos.x + c.vel.x * 0.6;
      const near = 1 / (1 + Math.pow(Math.abs(cx - x) / 4, 2));
      // A coverage man tied up by a blocker is much less of a threat to the lane than a free one.
      danger += near * (1 - Math.min(1, ahead / 40)) * (c.state === 'engaged' && !punt ? ENGAGED_DANGER : 1);
    }
    const edge = Math.min(x, FIELD_WIDTH - x) < 5 ? 0.5 : 0;
    const score = -danger - Math.abs(x - athlete.pos.x) * (punt ? PUNT_LANE_SHIFT_COST : LANE_SHIFT_COST) - edge + jitter(athlete, `lane${x}`, 0.3 * (1 - vision));
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return best;
};

/** The move a carrier reaches for against a closing tackler, by build and ratings. */
export const chooseMove = (athlete: Athlete, threat: Athlete): IntentAction => {
  const a = athlete.attrs;
  if (threat.state === 'diving' && f(a.jumping) > 0.5) return 'hurdle';
  const motion = len(athlete.vel) > 0.5 ? normalize(athlete.vel) : { x: Math.cos(athlete.facing), y: Math.sin(athlete.facing) };
  const fromSide = Math.abs(cross(motion, toward(athlete.pos, threat.pos))) > 0.7;
  if (fromSide && f(a.strength) > 0.55) return 'stiffArm';
  if (athlete.massLb >= threat.massLb + 15 && f(a.strength) > 0.6 && athleteNoise(athlete, 'bruiser') > 0.4) return 'truck';
  return f(a.agility) >= f(a.balance) ? 'juke' : 'spin';
};

/** Run the return: kneel a deep kickoff, otherwise hit the widest lane and use moves on closing tacklers. */
const runReturn = (athlete: Athlete, state: PlayState, kind: KickKind | null, p: Perception): AthleteIntent => {
  const attack = attackDirection(athlete, state);
  const fromGoal = yardsFromOwnGoal(athlete, state, athlete.pos);
  if (fromGoal < 0 && (kind === 'kickoff' || kind === 'onside')) {
    const plan = PLAN_BY_CODE[athlete.ai.scratch['plan'] ?? 0];
    if (plan === 'kneel' || fromGoal <= -TOUCHBACK_DEPTH || p.nearestOpponentDist <= 8) return { ...idleIntent('returner: kneel'), action: 'kneel' };
  }
  const laneX = bestReturnLane(athlete, state, kind);
  const target = clampToField({ x: laneX, y: athlete.pos.y + attack * (kind === 'punt' ? PUNT_LANE_LOOK_AHEAD : LANE_LOOK_AHEAD) }, 1);
  let intent = seek(athlete, target, true, `return lane ${laneX.toFixed(0)}`);
  intent = avoid(athlete, state.athletes.filter((a) => a.side === athlete.side), intent, 1.5);
  const threat = p.threats[0];
  if (threat && athlete.specialMoveCooldown <= 0) {
    const gap = dist(athlete.pos, threat.pos) - athlete.radius - threat.radius;
    const closing = dot(sub(threat.vel, athlete.vel), toward(threat.pos, athlete.pos));
    if (gap <= MOVE_GAP && closing > 0) {
      const move = chooseMove(athlete, threat);
      intent = { ...intent, action: move, targetId: threat.id, debug: `${intent.debug} ${move}` };
    }
  }
  return intent;
};

/** Step clear of a kick that should be left to die. */
const stepAway = (athlete: Athlete, state: PlayState, landing: Vec2): AthleteIntent => {
  const b = state.ball;
  const along = len(b.vel) > 0.5 ? normalize(b.vel) : { x: 0, y: state.ctx.direction };
  const side = cross(along, sub(athlete.pos, landing)) >= 0 ? 1 : -1;
  const spot = clampToField(add(landing, scale({ x: -along.y * side, y: along.x * side }, 4)), 1);
  return arrive(athlete, spot, 2, 'returner: let it go');
};

const fieldKick = (athlete: Athlete, state: PlayState, kind: KickKind): AthleteIntent => {
  const landing = predictLanding(state.ball, state.ctx.weather, CATCH_HEIGHT);
  const catchPoint = clampToField(landing.pos, 0.3);
  const returners = state.athletes.filter((a) => a.active && a.side === 'defense' && a.assignment.type === 'returner');
  let fielder = athlete;
  for (const r of returners) if (dist(r.pos, catchPoint) < dist(fielder.pos, catchPoint)) fielder = r;
  const attack = attackDirection(athlete, state);
  if (fielder.id !== athlete.id) {
    const lead = clampToField(add(catchPoint, { x: jitter(athlete, 'leadX', 5), y: attack * 6 }), 1);
    return arrive(athlete, lead, 3, 'returner: lead block');
  }
  const plan = fieldPlan(athlete, state, kind, landing);
  athlete.ai.scratch['plan'] = scratchPlan[plan];
  const face = Math.atan2(state.ball.pos.y - athlete.pos.y, state.ball.pos.x - athlete.pos.x);
  if (plan === 'letGo') return stepAway(athlete, state, catchPoint);
  // Kickoffs only: a punt returner has the gunners on him and catches it set, eyes up.
  if (plan === 'return' && kind !== 'punt') {
    const run = catchOnTheMove(athlete, catchPoint, landing.ticks * TICK_DT, attack);
    if (run) return { ...run, face };
  }
  const go = { ...arrive(athlete, catchPoint, 1.2, plan === 'fairCatch' ? 'returner: fair catch' : plan === 'kneel' ? 'returner: catch, kneel' : 'returner: field'), face };
  return plan === 'fairCatch' ? { ...go, action: 'fairCatch' } : go;
};

/** Yards behind the catch point a returner with time to spare sets up, and his speed (yd/s) coming forward into it. */
export const CATCH_SETBACK = 3;
export const CATCH_APPROACH_SPEED = 5;

/**
 * A returner with time to spare catches the ball going forward, as real returners do: he settles CATCH_SETBACK yards
 * behind the catch point and comes up into the ball so it arrives as he does, instead of catching flat-footed and
 * starting from a standstill. Null when he has no time for it (he just gets to the ball).
 */
const catchOnTheMove = (athlete: Athlete, catchPoint: Vec2, secondsLeft: number, attack: number): AthleteIntent | null => {
  const setup = clampToField({ x: catchPoint.x, y: catchPoint.y - attack * CATCH_SETBACK }, 0.3);
  const toSetup = dist(athlete.pos, setup);
  const toCatch = dist(athlete.pos, catchPoint);
  const behind = attack * (catchPoint.y - athlete.pos.y);
  const lead = toCatch / CATCH_APPROACH_SPEED;
  // Coming up into it: already behind the ball with the landing about as far off in time as in distance.
  if (behind > 0.3 && secondsLeft <= lead + 0.1) {
    const effort = Math.min(1, CATCH_APPROACH_SPEED / 9);
    return { ...seek(athlete, catchPoint, false, 'returner: field on the move'), move: scale(toward(athlete.pos, catchPoint), effort) };
  }
  // Time to get set behind it first (a man who cannot get there in time goes straight to the ball).
  if (toSetup / 7 + CATCH_SETBACK / CATCH_APPROACH_SPEED < secondsLeft) return arrive(athlete, setup, 1.5, 'returner: set up behind it');
  return null;
};

const looseKick = (athlete: Athlete, state: PlayState, kind: KickKind): AthleteIntent => {
  if (kind !== 'punt') return chaseLooseBall(athlete, state);
  const target = looseBallTarget(state);
  const fromGoal = yardsFromOwnGoal(athlete, state, target);
  const rollingHome = state.ctx.direction * state.ball.vel.y > 0.5;
  if (fromGoal <= LET_GO_INSIDE || rollingHome) return stepAway(athlete, state, target);
  return coverageAtArrival(state, target, dist(athlete.pos, target) / 8) > 4 ? seek(athlete, target, true, 'returner: pick up') : stepAway(athlete, state, target);
};

const returnerIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const kind = kickKindFor(state);
  const ball = state.ball;
  const faceBall = Math.atan2(ball.pos.y - athlete.pos.y, ball.pos.x - athlete.pos.x);
  if (state.phase === 'presnap') return holdPosition(athlete, faceBall, 'returner: set');
  if (!kind) return afterTurnover(athlete, state);
  const p = perceive(athlete, state);
  const carrier = p.ballCarrier;
  if (carrier && carrier.id === athlete.id) return runReturn(athlete, state, kind, p);
  if (!kickLaunched(state) && !fakeInProgress(state)) return holdPosition(athlete, faceBall, 'returner: wait');
  if (carrier) return carrier.side === athlete.side ? convoyBlock(athlete, state) : pursueCarrier(athlete, state, { label: 'returner: chase' });
  if (ball.phase === 'loose') return looseKick(athlete, state, kind);
  if (ball.phase === 'inAir') return fieldKick(athlete, state, kind);
  return holdPosition(athlete, faceBall, 'returner: idle');
};

/** Wedge (kickoff) or wall (punt) spot for a blocker relative to the landing point. */
export const wallSpot = (athlete: Athlete, state: PlayState, landing: Vec2, kind: KickKind): Vec2 => {
  const dir = state.ctx.direction;
  const attack = attackDirection(athlete, state);
  const blockers = state.athletes
    .filter((a) => a.side === 'defense' && a.assignment.type === 'returnBlock')
    .map((a) => ({ id: a.id, x: a.ai.scratch['alignX'] ?? a.pos.x, depth: dir * ((a.ai.scratch['alignY'] ?? a.pos.y) - state.losY) }));
  if (kind === 'punt') {
    const side = landing.x < MIDDLE_X ? -1 : 1;
    const ordered = blockers.sort((a, b) => b.depth - a.depth);
    const i = Math.max(0, ordered.findIndex((b) => b.id === athlete.id));
    return clampToField({ x: MIDDLE_X + side * 12, y: landing.y + attack * (8 + i * 3.5) }, 1);
  }
  const median = blockers.map((b) => b.depth).sort((a, b) => a - b)[Math.floor(blockers.length / 2)] ?? 0;
  const tier = blockers.filter((b) => (b.depth <= median) === ((blockers.find((b2) => b2.id === athlete.id)?.depth ?? 0) <= median)).sort((a, b) => a.x - b.x);
  const front = (blockers.find((b) => b.id === athlete.id)?.depth ?? 0) <= median;
  const i = Math.max(0, tier.findIndex((b) => b.id === athlete.id));
  const spread = (i - (tier.length - 1) / 2) * 4;
  return clampToField({ x: landing.x + spread, y: landing.y + attack * (front ? 12 : 20) }, 1);
};

/** Coverage men a return unit blocks (the kicker is left to the returner, as in real returns). */
const coverageMen = (state: PlayState): Athlete[] =>
  state.athletes
    .filter((a) => a.active && a.side === 'offense' && (a.assignment.type === 'kickCoverage' || a.assignment.type === 'gunner' || a.assignment.type === 'longSnapper'))
    .sort((a, b) => (a.ai.scratch['alignX'] ?? a.pos.x) - (b.ai.scratch['alignX'] ?? b.pos.x) || (a.id < b.id ? -1 : 1));

const SCRATCH_MAN = 'coverMan';

/**
 * Man-for-man kick return blocking, counted across the field: once the kick is away every return blocker takes the
 * coverage man in his own slot (blockers and coverage both ordered by alignment across the field), and the man (or
 * men) left over when the coverage outnumbers the blockers is the one furthest from where the ball comes down. Stored
 * once per play (the index into coverageMen) so the assignment never flickers.
 */
export const returnBlockAssignment = (athlete: Athlete, state: PlayState, landingX: number): Athlete | null => {
  const cover = coverageMen(state);
  const s = athlete.ai.scratch;
  if (s[SCRATCH_MAN] === undefined) {
    const blockers = state.athletes
      .filter((a) => a.active && a.side === 'defense' && a.assignment.type === 'returnBlock')
      .sort((a, b) => (a.ai.scratch['alignX'] ?? a.pos.x) - (b.ai.scratch['alignX'] ?? b.pos.x) || (a.id < b.id ? -1 : 1));
    const byDistance = cover.map((c, i) => ({ i, d: Math.abs((c.ai.scratch['alignX'] ?? c.pos.x) - landingX) })).sort((a, b) => a.d - b.d || a.i - b.i);
    const kept = byDistance.slice(0, blockers.length).map((c) => c.i).sort((a, b) => a - b);
    const rank = blockers.findIndex((b) => b.id === athlete.id);
    s[SCRATCH_MAN] = rank >= 0 && rank < kept.length ? (kept[rank] as number) : -1;
  }
  const idx = s[SCRATCH_MAN] as number;
  return idx >= 0 ? cover[idx] ?? null : null;
};

/** Yards in front of the catch a return blocker sets up (on the line from the catch to his man) before the catch. */
export const RETURN_SET_DEPTH = 11;
/** Coverage man within this gap of a blocker who is set: go get him. */
export const RETURN_ENGAGE_RANGE = 5;

/** Blocks his coverage man: set between him and the ball (or the returner) and take him on as he comes. */
const blockMan = (athlete: Athlete, man: Athlete, protect: Vec2, attack: number, caught: boolean): AthleteIntent => {
  const gap = dist(athlete.pos, man.pos);
  if (caught || gap <= RETURN_ENGAGE_RANGE || attack * (man.pos.y - protect.y) <= RETURN_SET_DEPTH + 2) {
    athlete.ai.blockTargetId = man.id;
    return blockIntent(athlete, man, protect, 'return block');
  }
  const along = normalize(sub(man.pos, protect));
  const spot = clampToField({ x: protect.x + along.x * RETURN_SET_DEPTH, y: protect.y + along.y * RETURN_SET_DEPTH }, 1);
  athlete.ai.blockTargetId = man.id;
  return arrive(athlete, spot, 2, `return block: set on ${man.role}`);
};

const returnBlockIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const kind = kickKindFor(state);
  const s = athlete.ai.scratch;
  if (s['alignX'] === undefined) { s['alignX'] = athlete.pos.x; s['alignY'] = athlete.pos.y; }
  if (state.phase === 'presnap') return holdPosition(athlete, null, 'wedge: set');
  if (!kind) return afterTurnover(athlete, state);
  const p = perceive(athlete, state);
  const carrier = p.ballCarrier;
  const dir = state.ctx.direction;
  if (!kickLaunched(state) && !fakeInProgress(state)) {
    if (kind !== 'punt') return holdPosition(athlete, null, 'wedge: wait');
    const rusher = p.threats.find((t) => dir * (t.pos.y - athlete.pos.y) < 0.5 && dist(t.pos, athlete.pos) <= 2.5);
    return rusher ? blockIntent(athlete, rusher, athlete.pos, 'hold up') : holdPosition(athlete, null, 'wall: hold up');
  }
  if (carrier && carrier.side === 'offense') return pursueCarrier(athlete, state, { label: 'wedge: chase' });
  if (state.ball.phase === 'loose') return chaseLooseBall(athlete, state);
  const landing = p.ballLanding ? clampToField(p.ballLanding.pos, 1) : state.ball.pos;
  if (kind !== 'punt') {
    const man = returnBlockAssignment(athlete, state, carrier ? carrier.pos.x : landing.x);
    const free = man && man.active && man.state !== 'down' && man.state !== 'tackled' && man.state !== 'falling';
    const attack = attackDirection(athlete, state);
    // His man is beaten, down or somebody else's already: help the returner's convoy instead.
    if (man && free && !(carrier && attack * (carrier.pos.y - man.pos.y) > 1)) return blockMan(athlete, man, carrier ? carrier.pos : landing, attack, !!carrier);
    if (carrier) return convoyBlock(athlete, state);
  }
  if (carrier) return convoyBlock(athlete, state);
  const near = p.threats.find((t) => dist(t.pos, athlete.pos) <= 3);
  if (near) {
    athlete.ai.blockTargetId = near.id;
    return blockIntent(athlete, near, landing, kind === 'punt' ? 'wall' : 'wedge');
  }
  athlete.ai.blockTargetId = null;
  return arrive(athlete, wallSpot(athlete, state, landing, kind), 2, kind === 'punt' ? 'wall: set' : 'wedge: set');
};

export const returnerDecider: IntentDecider = (athlete, state) => decided(athlete, state, returnerIntent(athlete, state));
export const returnBlockDecider: IntentDecider = (athlete, state) => decided(athlete, state, returnBlockIntent(athlete, state));
