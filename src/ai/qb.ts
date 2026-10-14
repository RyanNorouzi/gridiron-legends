import { clamp, clamp01 } from '@/core/math';
import { angle, dist, normalize, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentDecider } from '@/game/engine-api';
import { ballCarrier } from '@/game/athlete';
import type { Athlete, PlayState } from '@/game/play-types';
import { readOrder, type DefensivePlay, type OffensivePlay } from '@/playbook/types';
import { resolveAudible, suggestAudible, type AudibleKey } from '@/playbook/audibles';
import { predictLanding } from '@/physics/ball';
import { carryIntent } from './ball-carrier';
import { fooledByDisguise, peekDisguise, rotationReadDelay, shownCall } from './disguise';
import { gapLocalX, gapPoint } from './blocking';
import {
  chooseThrowType, evaluateReceivers, groundingSafeSpot, hesitationMargin, hotRead, pressureLevel, scrambleLane, selectRead, throwAwayAllowed, throwAwayTarget, type ReceiverRead,
} from './qb-reads';
import { rpoDecision } from './rpo';
import {
  arriveAt, blendQuality, canPlay, chaseBallIntent, depthOf, downfield, downfieldAngle, f, opponentsOf, playbookRegistry, routeAlignment,
  steerTo, timeSinceSnap, toField, toLocal,
} from './route-running';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Quarterback decider. Pre-snap: cadence (with an occasional audible), then the snap. Post-snap by play type:
 * kneels and spikes, handoffs/tosses at the mesh, read-option keeps, play-action fakes, and the passing game:
 * drop to the play's depth, progress through the reads (faster with awareness; qbDecisionQuality decides
 * whether the QB finds the best receiver or settles), throw on the break or the timing, check down or throw
 * away under pressure, move in the pocket, and scramble when the pocket collapses and a lane exists.
 */

const AUDIBLE_KEYS: readonly AudibleKey[] = ['manBeater', 'zoneBeater', 'blitzBeater', 'runToPass', 'passToRun'];

/** Cadence window (seconds after the QB is under centre / in the gun). */
export const CADENCE_MIN = 0.6;
export const CADENCE_MAX = 1.4;
/** Seconds after which a QB stops waiting for a receiver to uncover. */
export const MAX_HOLD = 4.5;
/**
 * Earliest ball-in-hand time (s) for a dropback throw by drop depth, before the passer's awareness takes up to 0.3 s
 * off: the quick game comes out at the top of a 3-step drop (~1.4-1.6 s after the snap), a 5-step drop throws off its
 * hitch (~2.5 s), a 7-step or play-action shot later still (~3 s). The line holds long enough for all of them.
 */
export const throwClock = (drop: number): number => (drop <= 3 ? 1.5 : 1.35 + 0.24 * drop);
/** Seconds the throw clock moves per unit of decision quality away from an average processor (0.5). */
export const PROCESSING_SWING = 0.6;
/** Openness a receiver needs for a throw once the passer has held the ball past MAX_HOLD. */
export const LATE_THROW_OPENNESS = 0.4;
/** Ball-in-hand seconds after which an open receiver who is not past his break is thrown to anyway. */
export const LATE_READ_T = 3.1;
/** Chance to ID an overload blitz pre-snap (and throw hot) at decision quality 0, and its slope with quality. */
export const HOT_ID_BASE = 0.3;
export const HOT_ID_SLOPE = 0.6;
/** Seconds of play-action fake before the drop. */
export const FAKE_SECONDS = 0.55;
/** Yards between the QB and the back at which the exchange happens. */
export const MESH_RANGE = 1.3;

/** True when the offense is in a hurry-up situation (a no-huddle call, or a two-minute play while not leading). */
export const isHurryUp = (state: PlayState): boolean => {
  const play = state.ctx.offensivePlay;
  return state.ctx.hurryUp === true || play.tags.includes('hurryUp') || (play.tags.includes('twoMinute') && state.ctx.clockRemaining <= 120 && state.ctx.scoreDiff <= 0);
};

/** Cadence rolled once per play: 0.6-1.4 s (aware QBs vary it more), shorter in a hurry-up, fastest on kneels/spikes. */
export const rollCadence = (qb: Athlete, state: PlayState): number => {
  const play = state.ctx.offensivePlay;
  const rng = state.ctx.rng;
  if (play.type === 'kneel' || play.type === 'spike') return rng.range(0.3, 0.5);
  if (isHurryUp(state)) return rng.range(0.35, 0.7);
  return clamp(1.0 + rng.gaussian(0, 0.12 + 0.2 * f(qb.attrs.awareness)), CADENCE_MIN, CADENCE_MAX);
};

/**
 * Seconds between progression reads: 0.46 s for a 1-awareness QB down to 0.25 s at 99, scaled by the difficulty's
 * qbDecisionQuality around the calibrated pro baseline (x1): x1.08 at rookie, x0.92 at all-pro, x0.86 at legend.
 */
export const progressionInterval = (awareness: number, qbDecisionQuality: number): number =>
  0.35 * (1.3 - 0.6 * f(awareness)) * (1 + 0.4 * (0.6 - clamp01(qbDecisionQuality)));

/**
 * Target depth behind the LOS for a pass drop: the play's dropback, at least a step deeper than the alignment. Backed
 * up (`ballOn` yards from his own goal line) he shortens it to stay out of his end zone, never shallower than where he
 * lined up.
 */
export const dropbackDepth = (play: OffensivePlay, alignDepth: number, ballOn = 100): number =>
  Math.min(Math.max(alignDepth + 1, (play.dropback ?? 3) + (alignDepth > 3 ? 2 : 1)), Math.max(alignDepth, ballOn - BACKED_UP_MARGIN));

/** Yards over which the passer gathers himself at the top of the drop (he sets, he does not run through it). */
export const DROP_SETTLE_YARDS = 1.2;
/** Yards short of his own goal line a backed-up passer's drop stops. */
export const BACKED_UP_MARGIN = 0.7;

const roleAthlete = (state: PlayState, role: string | undefined): Athlete | null =>
  role ? state.athletes.find((a) => a.side === 'offense' && a.role === role && a.active) ?? null : null;

const faceDownfield = (state: PlayState, intent: AthleteIntent): AthleteIntent => {
  intent.locomotion = 'strafe';
  intent.face = downfieldAngle(state);
  return intent;
};

/** Seconds into the pre-snap when the QB reads the defense's look (the shell has shown by then). */
export const LOOK_READ_T = 0.2;

/** The defensive call as this QB reads it: the real one, or the disguised shell when the disguise fools him. */
export const perceivedDefense = (qb: Athlete, state: PlayState): DefensivePlay => {
  const plan = peekDisguise(state);
  const q = blendQuality(qb, difficultyFor(state, qb).qbDecisionQuality);
  return plan && fooledByDisguise(state, qb.id, q) ? shownCall(state.ctx.defensivePlay, plan) : state.ctx.defensivePlay;
};

const presnapIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  sc.presnapT = (sc.presnapT ?? 0) + dt;
  if (sc.cadence === undefined) {
    sc.cadence = rollCadence(qb, state);
    sc.audibleKey = -1;
  }
  if (sc.lookRead !== 1 && sc.presnapT >= LOOK_READ_T) {
    sc.lookRead = 1;
    const play = state.ctx.offensivePlay;
    const suggestion = suggestAudible(play, perceivedDefense(qb, state));
    if (suggestion && resolveAudible(play, suggestion, playbookRegistry())) {
      const q = blendQuality(qb, difficultyFor(state, qb).qbDecisionQuality);
      const chance = clamp01((q - 0.35) * 1.4) * (isHurryUp(state) ? 0.3 : 1);
      if (state.ctx.rng.chance(chance)) { sc.audibleKey = AUDIBLE_KEYS.indexOf(suggestion); sc.cadence += 0.4; }
    }
  }
  if ((sc.audibleKey ?? -1) >= 0 && sc.audibled !== 1 && sc.presnapT >= 0.25) {
    sc.audibled = 1;
    const intent = idleIntent('audible');
    intent.action = 'audible';
    intent.audible = AUDIBLE_KEYS[sc.audibleKey ?? 0] ?? null;
    return intent;
  }
  if (sc.presnapT >= (sc.cadence ?? CADENCE_MAX) || state.playClock <= 1) {
    const intent = idleIntent('snap');
    intent.action = 'snap';
    return intent;
  }
  return idleIntent('cadence');
};

const withoutBallIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  const ball = state.ball;
  if ((ball.phase === 'inAir' || ball.phase === 'snap') && ball.kind === 'snap') {
    const landing = predictLanding(ball, state.ctx.weather, 1.2).pos;
    const intent = steerTo(qb.pos, landing, 0.6, false, 'catch snap');
    intent.locomotion = 'backpedal';
    intent.face = downfieldAngle(state);
    return intent;
  }
  if (ball.phase === 'inAir') {
    const intent = idleIntent('watch throw');
    intent.locomotion = 'strafe';
    intent.face = angle(sub(ball.pos, qb.pos));
    return intent;
  }
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'offense') {
    sc.postT = (sc.postT ?? 0) + dt;
    if (sc.postT < 1) {
      const gap = state.ctx.offensivePlay.runGap;
      const away = -(gap ? Math.sign(gapLocalX(gap)) : 1) || -1;
      return steerTo(qb.pos, toField({ x: away * 5, y: -5 }, state), 0.6, false, 'fake boot');
    }
    return idleIntent('watch run');
  }
  return idleIntent('qb: waiting');
};

const throwIntent = (qb: Athlete, state: PlayState, pick: ReceiverRead, label: string): AthleteIntent => {
  const type = chooseThrowType(qb, pick, opponentsOf(qb, state).filter(canPlay), pick.distance);
  const intent = idleIntent(`${label} ${pick.role} (${type})`);
  intent.action = 'throw';
  intent.targetId = pick.id;
  intent.throwType = type;
  intent.throwTarget = pick.leadPoint;
  qb.ai.scratch.thrown = 1;
  return intent;
};

const throwAwayIntent = (qb: Athlete, state: PlayState, spot: Vec2 | null = null): AthleteIntent => {
  const intent = idleIntent(spot ? 'throw away (at a receiver\'s feet)' : 'throw away');
  intent.action = 'throwAway';
  intent.throwType = 'throwAway';
  intent.throwTarget = spot ?? throwAwayTarget(qb, state);
  qb.ai.scratch.thrown = 1;
  return intent;
};

/** Rolled once per play: scrambling QBs (speed + agility) are more willing to leave the pocket. */
const willingToScramble = (qb: Athlete, state: PlayState): boolean => {
  const sc = qb.ai.scratch;
  if (sc.scrWill === undefined) sc.scrWill = state.ctx.rng.chance(0.3 + 0.6 * (0.5 * f(qb.attrs.speed) + 0.5 * f(qb.attrs.agility))) ? 1 : 0;
  return sc.scrWill === 1;
};

const startScramble = (qb: Athlete, state: PlayState, dt: number, lane: Vec2): AthleteIntent => {
  qb.ai.scratch.scrambling = 1;
  const intent = carryIntent(qb, state, dt, { designed: { x: qb.pos.x + lane.x * 6, y: qb.pos.y + lane.y * 6 } });
  intent.debug = `scramble: ${intent.debug}`;
  return intent;
};

/** Scrambling: throw on the run if someone uncovers before the LOS, otherwise run like a ball carrier. */
const scrambleIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  if (depthOf(qb.pos, state) < -0.5) {
    sc.readT = (sc.readT ?? 0) + dt;
    if (sc.readT >= 0.3) {
      sc.readT = 0;
      const reads = evaluateReceivers(qb, state, readOrder(state.ctx.offensivePlay));
      const q = blendQuality(qb, difficultyFor(state, qb).qbDecisionQuality);
      const pick = selectRead(reads, q, state.ctx.rng, { threshold: 0.55, maxDifficulty: 0.75 });
      if (pick) return throwIntent(qb, state, pick, 'throw on the run');
    }
  }
  const intent = carryIntent(qb, state, dt);
  intent.debug = `scramble: ${intent.debug}`;
  return intent;
};

interface PassOptions {
  /** RPO: no drop, throw the first acceptable read at once. */
  quick?: boolean;
}

const passIntent = (qb: Athlete, state: PlayState, dt: number, opts: PassOptions = {}): AthleteIntent => {
  const sc = qb.ai.scratch;
  const c = state.ctx;
  const play = c.offensivePlay;
  if (sc.scrambling === 1) return scrambleIntent(qb, state, dt);
  const align = routeAlignment(qb, state);
  const depthTarget = dropbackDepth(play, -align.y, c.ballOn);
  const setPoint = toField({ x: align.x, y: -depthTarget }, state);
  const myDepth = -depthOf(qb.pos, state);
  const T = sc.hasBallT ?? 0;
  const q = blendQuality(qb, difficultyFor(c, qb).qbDecisionQuality);
  // Hot (more rushers than protectors, when he IDs it pre-snap): a quick set, and the ball comes out on the quick clock.
  if (sc.hot === undefined) sc.hot = !opts.quick && hotRead(perceivedDefense(qb, state), state) && c.rng.chance(HOT_ID_BASE + HOT_ID_SLOPE * q) ? 1 : 0;
  const hot = sc.hot === 1;
  const atSet = opts.quick === true || myDepth >= (hot ? Math.min(depthTarget, 2 - align.y) : depthTarget) - 0.4;
  const pressure = pressureLevel(qb, state);
  // Pocket presence is a read: a sharper QB feels the rush a beat earlier, a poor one bails on a rusher who was never
  // going to get home (or never sees the one who is).
  // How early he feels it varies snap to snap (rolled once per play); the read sets the average.
  if (sc.pocketFeel === undefined) sc.pocketFeel = c.rng.gaussian(0, 0.1);
  const ttcTrigger = clamp(0.15 + 0.3 * q + sc.pocketFeel, 0.1, 0.6);
  // A free rusher already within arm's reach is pressure whatever his closing speed.
  const inLap = pressure.freeDist < 1.6;
  const underPressure = pressure.level >= 0.7 || pressure.timeToContact < ttcTrigger || inLap;
  const reads = evaluateReceivers(qb, state, readOrder(play));
  const threshold = (underPressure ? 0.5 : 0.62 - 0.15 * f(qb.attrs.throwAccuracy) - (opts.quick ? 0.1 : 0)) + hesitationMargin(difficultyFor(c, qb).qbDecisionQuality);
  // A deep shot needs real separation: the further the ball travels the more a trailing defender closes on it.
  const deepNeed = (r: ReceiverRead): number => 0.3 * clamp01((depthOf(r.leadPoint, state) - 8) / 12);
  const maxDifficulty = underPressure ? 0.8 : 0.8;
  // Progression speed: the QB's awareness sets it, the difficulty's decision quality sharpens (or dulls) it.
  const interval = progressionInterval(qb.attrs.awareness, difficultyFor(c, qb).qbDecisionQuality);
  sc.readT = (sc.readT ?? 0) + dt;
  if (sc.readSet !== 1 || sc.readT >= interval || underPressure) {
    const pick = selectRead(reads, q, c.rng, { threshold, maxDifficulty });
    sc.readSet = 1;
    sc.readT = 0;
    qb.ai.targetAthleteId = pick ? pick.id : null;
    qb.ai.readIndex = pick ? pick.order : -1;
  }
  const pick = qb.ai.targetAthleteId ? reads.find((r) => r.id === qb.ai.targetAthleteId) ?? null : null;
  // A dropback throw needs the routes to develop: nothing goes before ~1 s of ball-in-hand (sharper processors a
  // touch earlier) unless it is the quick game or the rush is home.
  // The quick game (a three-step drop) is timed to the break at 5-6 yd: the ball is out as the receiver comes open,
  // not after the route has carried him into the safeties.
  const drop = play.dropback ?? 3;
  // A QB fooled by a disguised shell is a beat late while the coverage rotates in front of him.
  if (sc.fooled === undefined) sc.fooled = fooledByDisguise(state, qb.id, q) ? 1 : 0;
  const rotation = sc.fooled === 1 && !opts.quick ? rotationReadDelay(state) : 0;
  // A sharper processor (awareness, and the difficulty's decision quality) is ready to let it go sooner.
  const minThrowT = opts.quick ? 0.1 : underPressure ? 0.7 : throwClock(hot ? 3 : drop) - 0.3 * f(qb.attrs.awareness) - PROCESSING_SWING * (q - 0.5) + rotation;
  const anticipates = q > 0.55;
  // The drop comes first: a QB does not let it go mid-drop unless the rush is already on him.
  if (!atSet && !underPressure) {
    const intent = arriveAt(qb.pos, setPoint, DROP_SETTLE_YARDS, 1, false, 'dropback');
    intent.locomotion = 'backpedal';
    intent.face = downfieldAngle(state);
    return intent;
  }
  if (pick && T >= minThrowT && pick.openness >= threshold + deepNeed(pick) && (pick.isPastBreak || (anticipates && pick.timing >= 0.7) || underPressure || T > LATE_READ_T)) {
    return throwIntent(qb, state, pick, 'throw');
  }
  if (pressure.level >= 0.75 || pressure.timeToContact < 0.9 * ttcTrigger || inLap) {
    const check = reads.filter((r) => r.isCheckdown && !r.laneBlocked).sort((a, b) => b.openness - a.openness)[0];
    if (check && check.openness >= 0.3 && T >= 0.2) return throwIntent(qb, state, check, 'checkdown');
    if (throwAwayAllowed(qb, state) && T >= 0.2) return throwAwayIntent(qb, state);
    const lane = scrambleLane(qb, state);
    if (lane && willingToScramble(qb, state)) return startScramble(qb, state, dt, lane.dir);
    // From the pocket a throwaway has to land near an eligible man: an aware QB finds one and lives to play the next
    // down; a poorer one holds it and takes the sack or tries to escape.
    if (T >= 0.2 && q > 0.45) {
      const spot = groundingSafeSpot(qb, state);
      if (spot) return throwAwayIntent(qb, state, spot);
    }
    if (pressure.nearest) {
      // Slide away from the rush along the line (stepping up from an edge rusher), never a sprint backwards: a
      // QB who retreats ten yards turns a pressure into a drive-killing sack.
      const rl = toLocal(pressure.nearest.pos, state);
      const ql = toLocal(qb.pos, state);
      const lateral = Math.sign(ql.x - rl.x) || 1;
      const edge = Math.abs(rl.x - ql.x) > 1;
      const tooDeep = myDepth > depthTarget + 1.5;
      const local = { x: lateral, y: edge ? 0.6 : tooDeep ? 0 : -0.3 };
      const intent = idleIntent('evade rush');
      intent.move = normalize(sub(toField(local, state), toField({ x: 0, y: 0 }, state)));
      intent.sprint = true;
      return intent;
    }
  }
  if (!atSet) {
    const intent = arriveAt(qb.pos, setPoint, DROP_SETTLE_YARDS, 1, false, 'dropback');
    intent.locomotion = 'backpedal';
    intent.face = downfieldAngle(state);
    return intent;
  }
  if (T > MAX_HOLD) {
    // Holding it this long means nobody came open: take a real window if there is one, otherwise live to play the
    // next down (throw it away, or throw it at a receiver's feet) rather than forcing it into coverage.
    const any = reads.filter((r) => r.openness >= LATE_THROW_OPENNESS && !r.laneBlocked).sort((a, b) => b.score - a.score)[0];
    if (any) return throwIntent(qb, state, any, 'late throw');
    if (throwAwayAllowed(qb, state)) return throwAwayIntent(qb, state);
    const spot = q > 0.45 ? groundingSafeSpot(qb, state) : null;
    if (spot) return throwAwayIntent(qb, state, spot);
    const lane = scrambleLane(qb, state, 2);
    if (lane) return startScramble(qb, state, dt, lane.dir);
  }
  if (T > LATE_READ_T + 0.3 && !pick) {
    const lane = scrambleLane(qb, state, 3);
    if (lane && willingToScramble(qb, state)) return startScramble(qb, state, dt, lane.dir);
  }
  if (pressure.nearest && dist(pressure.nearest.pos, qb.pos) < 3.5) {
    const rl = toLocal(pressure.nearest.pos, state);
    const ql = toLocal(qb.pos, state);
    const fromEdge = Math.abs(rl.x - ql.x) > 2;
    let move: Vec2;
    if (fromEdge && myDepth > 2.5) move = downfield(state);
    else {
      const sign = -(Math.sign(rl.x - ql.x) || 1);
      move = { x: c.direction * sign, y: 0 };
    }
    const intent = idleIntent(fromEdge ? 'pocket: step up' : 'pocket: slide');
    intent.move = scale(move, 0.6);
    return faceDownfield(state, intent);
  }
  return faceDownfield(state, idleIntent(pick ? `read ${pick.role}` : 'read'));
};

const handoffIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  const play = state.ctx.offensivePlay;
  const back = roleAthlete(state, play.ballCarrier);
  const gap = play.runGap;
  if (!back || !gap) return carryIntent(qb, state, dt);
  const gx = gapLocalX(gap);
  const toss = play.concept === 'outsideRun' && Math.abs(gx) >= 5 && routeAlignment(back, state).y <= -5;
  const T = sc.hasBallT ?? 0;
  if (toss) {
    if (T < 0.2) return idleIntent('toss: turn');
    const intent = idleIntent('toss');
    intent.action = 'pitch';
    intent.targetId = back.id;
    return intent;
  }
  if (dist(qb.pos, back.pos) <= MESH_RANGE) {
    const intent = steerTo(qb.pos, back.pos, 0.3, false, 'handoff');
    intent.action = 'handoff';
    intent.targetId = back.id;
    return intent;
  }
  if (T > 0.6 && depthOf(back.pos, state) > depthOf(qb.pos, state) + 1.5) {
    sc.keep = 1;
    return carryIntent(qb, state, dt, { designed: gapPoint(gap, state, 1.5) });
  }
  const mesh = { x: back.pos.x + back.vel.x * 0.25, y: back.pos.y + back.vel.y * 0.25 };
  return steerTo(qb.pos, mesh, 0.9, false, 'to mesh');
};

const readOptionIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  const play = state.ctx.offensivePlay;
  const back = roleAthlete(state, play.fakeTo);
  const T = sc.hasBallT ?? 0;
  if (sc.rpoDecided !== 1 && back && dist(qb.pos, back.pos) > MESH_RANGE && T < 1.2) {
    const mesh = { x: back.pos.x + back.vel.x * 0.25, y: back.pos.y + back.vel.y * 0.25 };
    return steerTo(qb.pos, mesh, 0.9, false, 'ride mesh');
  }
  const read = rpoDecision(qb, state);
  const gap = play.runGap;
  switch (read.decision) {
    case 'give': {
      if (back && dist(qb.pos, back.pos) <= MESH_RANGE + 0.3 && back.active) {
        const intent = steerTo(qb.pos, back.pos, 0.3, false, `give (${read.reason})`);
        intent.action = 'handoff';
        intent.targetId = back.id;
        return intent;
      }
      sc.keep = 1;
      return carryIntent(qb, state, dt, { designed: gap ? gapPoint(gap, state, 1.5) : null });
    }
    case 'keep': {
      sc.keep = 1;
      // Zone read: the keep goes around the unblocked backside end (the far D gap); an RPO keep bounces the run side.
      const runRight = gap ? gapLocalX(gap) > 0 : false;
      const keepGap = gap ? (play.type === 'qbRun' ? (runRight ? 'D-left' : 'D-right') : (runRight ? 'D-right' : 'D-left')) : null;
      const intent = carryIntent(qb, state, dt, { designed: keepGap ? gapPoint(keepGap, state, 1.5) : null });
      intent.debug = `keep (${read.reason}): ${intent.debug}`;
      return intent;
    }
    case 'throw':
    default: {
      if (T < 0.25) return idleIntent(`rpo fake (${read.reason})`);
      // The quick throw is a now-or-never read: when nobody uncovers and the pocket is quiet, tuck it and run.
      if (sc.scrambling !== 1 && T > 1.4) {
        sc.keep = 1;
        const intent = carryIntent(qb, state, dt, { designed: gap ? gapPoint(gap, state, 1.5) : null });
        intent.debug = `rpo tuck: ${intent.debug}`;
        return intent;
      }
      return passIntent(qb, state, dt, { quick: true });
    }
  }
};

const playActionIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  const play = state.ctx.offensivePlay;
  const back = roleAthlete(state, play.fakeTo ?? (qb.assignment.type === 'qb' ? qb.assignment.fakeTo : undefined));
  const T = sc.hasBallT ?? 0;
  if (back && T < FAKE_SECONDS) {
    if (dist(qb.pos, back.pos) > 1.0) return steerTo(qb.pos, back.pos, 0.9, false, 'play fake');
    return idleIntent('play fake');
  }
  return passIntent(qb, state, dt);
};

const qbRunIntent = (qb: Athlete, state: PlayState, dt: number): AthleteIntent => {
  const sc = qb.ai.scratch;
  const play = state.ctx.offensivePlay;
  if (play.concept === 'draw' && (sc.hasBallT ?? 0) < 0.6) {
    const back = toField({ x: 0, y: -(-routeAlignment(qb, state).y + 1.5) }, state);
    const intent = steerTo(qb.pos, back, 0.7, false, 'draw: sell pass');
    intent.locomotion = 'backpedal';
    intent.face = downfieldAngle(state);
    return intent;
  }
  sc.keep = 1;
  return carryIntent(qb, state, dt, { designed: play.runGap ? gapPoint(play.runGap, state, 1.5) : null });
};

/** Decider for assignment 'qb'. */
export const decideQb: IntentDecider = (qb, state, dt) => {
  // Capture the alignment before the QB moves (drop depth and set point are measured from it).
  routeAlignment(qb, state);
  if (state.phase === 'presnap') return presnapIntent(qb, state, dt);
  const chase = chaseBallIntent(qb, state);
  if (chase) return chase;
  if (!qb.hasBall) return withoutBallIntent(qb, state, dt);
  const sc = qb.ai.scratch;
  sc.hasBallT = (sc.hasBallT ?? 0) + dt;
  const play = state.ctx.offensivePlay;
  switch (play.type) {
    case 'kneel': {
      const intent = steerTo(qb.pos, toField({ x: 0, y: -8 }, state), 0.4, false, 'kneel');
      if (sc.hasBallT >= 0.25) intent.action = 'kneel';
      return intent;
    }
    case 'spike': {
      const intent = idleIntent('spike');
      intent.action = 'spike';
      intent.throwType = 'throwAway';
      return intent;
    }
    case 'run':
      return handoffIntent(qb, state, dt);
    case 'qbRun':
      return play.fakeTo ? readOptionIntent(qb, state, dt) : qbRunIntent(qb, state, dt);
    case 'rpo':
      return readOptionIntent(qb, state, dt);
    case 'playAction':
      return playActionIntent(qb, state, dt);
    case 'pass':
    case 'screen':
    case 'special':
    default:
      if (play.fakeTo && play.type !== 'screen') return playActionIntent(qb, state, dt);
      return passIntent(qb, state, dt);
  }
};

/** Seconds since the snap, exposed for tests and the dev overlay. */
export const qbClock = (state: PlayState): number => timeSinceSnap(state);
