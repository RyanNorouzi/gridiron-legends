import { clamp, clamp01 } from '@/core/math';
import { dist, dot, len, sub, type Vec2 } from '@/core/vec2';
import type { AthleteIntent, IntentAction } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { TackleKind } from '@/game/play-events';
import { MIDDLE_X } from '@/game/types';
import { interceptPoint } from '@/physics/collision';
import { momentumAdvantage } from '@/physics/contact';
import { maxSpeed } from '@/physics/speed';
import { clampPoint, defenderJitter, defenderNoise, depthOf, judgement, rf, seekIntent, speedOf } from './defense-shared';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Pursuit and tackle choice shared by every defensive decider. Pursuit blends the ideal intercept point with
 * the carrier's current position according to pursuitQuality and the pursuit rating; when the carrier is
 * faster the defender takes a cut-off angle ahead of him instead of chasing his heels. Tackle choice reads
 * momentum, angle and the carrier's ball security to pick wrap / hit stick / dive / strip / gang, breaks down
 * in front of shifty carriers and never hits a sliding quarterback in simulation mode.
 */

export type Leverage = 'inside' | 'outside' | 'none';

export interface PursuitPlan {
  /** Where to run. */
  aim: Vec2;
  /** True when a straight-line intercept exists. */
  intercept: boolean;
  /** True when the defender is taking a cut-off angle because the carrier is pulling away. */
  cutOff: boolean;
  /** 0..1 blend toward the ideal angle actually used. */
  quality: number;
}

export interface PursuitOptions {
  leverage?: Leverage;
  /** Yards of lateral leverage offset (default 0.9). */
  leverageYards?: number;
}

/** Sideline-ward sign for `pos` (+1 when the near sideline is at higher x). */
const sidelineSign = (pos: Vec2): number => (pos.x >= MIDDLE_X ? 1 : -1);

/** 0..1 pursuit quality: difficulty knob, awareness and the pursuit rating with a personal lean. */
export const pursuitQuality = (athlete: Athlete, state: Pick<PlayState, 'ctx'>): number =>
  clamp01(0.6 * judgement(athlete, difficultyFor(state, athlete).pursuitQuality, 'pursuit') + 0.4 * rf(athlete.attrs.pursuit) + defenderJitter(athlete, 'angle', 0.05));

/** Plan where to run to meet the carrier, with cut-off angles and inside/outside leverage. */
export const pursuitPlan = (athlete: Athlete, carrier: Athlete, state: Pick<PlayState, 'ctx'>, o: PursuitOptions = {}): PursuitPlan => {
  const q = pursuitQuality(athlete, state);
  const d = dist(athlete.pos, carrier.pos);
  const carrierSpeed = len(carrier.vel);
  const chaser = { pos: athlete.pos, speed: speedOf(athlete) * (0.9 + 0.1 * q) };
  // Plan against the speed the carrier can hold, not his sprint burst: the burst fades before a long chase ends.
  const sustained = Math.min(carrierSpeed, maxSpeed(carrier.attrs.speed));
  const carrierVel = carrierSpeed > 1e-6 ? { x: (carrier.vel.x / carrierSpeed) * sustained, y: (carrier.vel.y / carrierSpeed) * sustained } : carrier.vel;
  const ip = interceptPoint(chaser, { pos: carrier.pos, vel: carrierVel });
  let ideal: Vec2;
  let cutOff = false;
  if (ip && ip.time <= 6) {
    ideal = ip.pos;
  } else {
    cutOff = true;
    // No straight race wins: run to the point on his path where the deficit is smallest (the deepest angle that
    // still makes him come through the defender), not a fixed fraction ahead that leaves the chaser trailing.
    const dir = state.ctx.direction;
    const hx = carrierSpeed > 1 ? carrier.vel.x / carrierSpeed : 0;
    const hy = carrierSpeed > 1 ? carrier.vel.y / carrierSpeed : dir;
    const v = Math.max(1, sustained);
    const lateAt = (L: number): number => Math.hypot(carrier.pos.x + hx * L - athlete.pos.x, carrier.pos.y + hy * L - athlete.pos.y) / chaser.speed - L / v;
    let bestLate = Infinity;
    for (let L = 2; L <= 40; L += 2) bestLate = Math.min(bestLate, lateAt(L));
    // Among the near-optimal points take the DEEPEST: a trailing chaser who is late everywhere still aims well
    // ahead so the carrier has to come through him, never at his heels.
    let bestL = 2;
    for (let L = 2; L <= 40; L += 2) if (lateAt(L) <= bestLate + 0.15) bestL = L;
    // A poorer pursuer settles for a shallower point on the path than the best one (the difficulty knob and his
    // pursuit rating decide how much of the ideal depth he takes).
    const depth = bestL * (0.55 + 0.45 * q);
    ideal = { x: carrier.pos.x + hx * depth, y: carrier.pos.y + hy * depth };
  }
  // Even a poor pursuer takes half the angle (most of it on a cut-off); the knob decides how much of the rest he finds.
  const blend = cutOff ? 0.75 + 0.25 * q : 0.5 + 0.5 * q;
  const aim = { x: carrier.pos.x + (ideal.x - carrier.pos.x) * blend, y: carrier.pos.y + (ideal.y - carrier.pos.y) * blend };
  const lev = o.leverage ?? 'none';
  if (lev !== 'none' && d > 1.5) {
    const yards = o.leverageYards ?? 0.9;
    const toward = lev === 'inside' ? -sidelineSign(carrier.pos) : sidelineSign(carrier.pos);
    aim.x += toward * yards * clamp01(d / 6);
  }
  return { aim: clampPoint(aim, 0.3), intercept: !cutOff, cutOff, quality: q };
};

/** True when the carrier can make a defender miss in space (or is mid-move). */
export const carrierIsShifty = (carrier: Athlete): boolean =>
  rf(carrier.attrs.agility) >= 0.7 || carrier.state === 'juking' || carrier.state === 'spinning' || carrier.state === 'hurdling';

/**
 * Run at the carrier along the pursuit plan. Within 2.2 yd of a shifty carrier a defender with a good tackle
 * read breaks down (no sprint, reduced effort) so the juke does not blow past him; a poor read overruns.
 */
export const approachIntent = (athlete: Athlete, carrier: Athlete, state: PlayState, o: PursuitOptions = {}): AthleteIntent => {
  const plan = pursuitPlan(athlete, carrier, state, o);
  const d = dist(athlete.pos, carrier.pos);
  const read = judgement(athlete, difficultyFor(state, athlete).tackleDecisionQuality, 'breakdown');
  // Breaking down is for a carrier coming AT the defender; a chaser who eases off behind a runner never catches him.
  const closingOnMe = d > 1e-6 && dot(carrier.vel, sub(athlete.pos, carrier.pos)) / d > 2;
  // A rusher closing on a quarterback in the pocket never breaks down: he finishes the sack.
  const passerInPocket = carrier.position === 'QB' && depthOf(state, carrier.pos) < 0 && carrier.hasBall;
  const shouldBreakDown = d <= 2.2 && closingOnMe && carrierIsShifty(carrier) && read > 0.45 && !passerInPocket;
  const intent = seekIntent(athlete, plan.aim, {
    sprint: !shouldBreakDown && d > 1.2,
    effort: shouldBreakDown ? 0.75 : 1,
    debug: `${plan.cutOff ? 'cut off' : 'pursue'} ${carrier.role}${shouldBreakDown ? ' (breakdown)' : ''}`,
  });
  return intent;
};

export interface TackleChoice {
  kind: TackleKind | null;
  action: IntentAction | null;
  /** 0..1 timing quality for a hit stick (1 = perfect). */
  timing: number;
  reason: string;
}

/**
 * Wrap-up reach from centre to centre (yards). Kept inside the engine's contact reach (radii + 0.3 = 1.3): a
 * 'tackle' signalled from further out is executed as a lunge (dive), and dives whiff and leave the tackler
 * on the turf, so the defender runs through the carrier and wraps on contact instead. The lunge is reserved
 * for a carrier who is pulling away (see losingAngle below).
 */
export const WRAP_REACH = 1.25;
/** Dive reach (yards). */
export const DIVE_REACH = 2.4;
/** Distance inside which a defender joins a tackle already in progress. */
export const GANG_RADIUS = 2;

/** States in which a teammate is not in a position to help finish a tackle. */
const NOT_HELPING: ReadonlySet<Athlete['state']> = new Set(['engaged', 'diving', 'down', 'stumbling', 'tackled']);

/** Per-play roll: does this rusher time the quarterback's release well enough to lay out for it? */
const readsTheRelease = (athlete: Athlete, state: PlayState, read: number): boolean => {
  const sc = athlete.ai.scratch;
  if (sc.releaseRead === undefined) sc.releaseRead = state.ctx.rng.next();
  return sc.releaseRead < clamp01(RELEASE_READ_RATE * (read - 0.3));
};

/** How strongly the tackle read turns into timing the release (chance = rate x (read - 0.3)). */
export const RELEASE_READ_RATE = 0.6;

const NONE: TackleChoice = { kind: null, action: null, timing: 0, reason: 'out of reach' };

/**
 * Which tackle to attempt right now, if any. Hit stick needs a momentum advantage, a head-on approach and a
 * good read (tackleDecisionQuality x awareness, personal aggression); strip from behind on carriers with poor
 * ball security; dive when losing the angle; join a gang tackle on a contested carrier; wrap by default. A
 * sliding QB is never hit in simulation mode.
 */
export const chooseTackle = (athlete: Athlete, carrier: Athlete, state: PlayState): TackleChoice => {
  // Centres never coincide after collision separation, but guard the divisions anyway.
  const d = Math.max(dist(athlete.pos, carrier.pos), 1e-3);
  if (d > DIVE_REACH) return NONE;
  if (carrier.state === 'sliding' && state.ctx.ruleset.mode === 'simulation') return { kind: null, action: null, timing: 0, reason: 'sliding qb' };
  const read = judgement(athlete, difficultyFor(state, athlete).tackleDecisionQuality, 'tackle');
  const toCarrier = sub(carrier.pos, athlete.pos);
  const mySpeed = len(athlete.vel);
  const carrierSpeed = len(carrier.vel);
  const headOn = mySpeed > 0.5 ? dot(athlete.vel, toCarrier) / (mySpeed * d) : 0;
  const closingSpeed = -dot(sub(carrier.vel, athlete.vel), toCarrier) / d;
  // A runner already held (a struggle) or just hit is a pile to join.
  const contested = carrier.state === 'wrapped' || (carrier.contactTimer > 0 && carrier.contactTimer < 0.5);
  // Only an upright, free teammate is help: a lineman locked in a block or a man already on the turf holds nobody.
  const helper = state.athletes.some((a) => a.side !== carrier.side && a !== athlete && a.active && !NOT_HELPING.has(a.state)
    && dist(a.pos, carrier.pos) <= 1.2);
  // Piling onto a carrier who is already wrapped up or stumbling. A sound tackler runs through and joins the pile
  // from wrap range; a poor read lunges from further out (the engine turns a 'tackle' from beyond contact reach
  // into a dive, which whiffs and leaves him on the turf).
  const canLunge = athlete.specialMoveCooldown <= 0;
  // A quarterback still behind the line with the ball is a sack waiting to be finished: piling onto him is a lunge.
  const passerInPocket = carrier.position === 'QB' && depthOf(state, carrier.pos) < 0 && carrier.hasBall;
  const gangReach = passerInPocket ? GANG_RADIUS : GANG_RADIUS - (GANG_RADIUS - WRAP_REACH) * clamp01(read / 0.7);
  if (d <= GANG_RADIUS && (contested || carrier.state === 'stumbling' || helper) && d > WRAP_REACH * 0.8) {
    if (canLunge && d <= gangReach) return { kind: 'gang', action: 'tackle', timing: 0, reason: 'gang' };
    // Out of lunge range (or no lunge left): run through the pile and wrap on contact, which the engine scores as
    // a gang tackle because the teammate is already hanging on.
    return { kind: 'gang', action: null, timing: 0, reason: 'gang (run through)' };
  }
  if (d <= WRAP_REACH) {
    // A man still gathering the ball (a returner fielding a kick, a receiver securing a catch) is wrapped up, never
    // hit-sticked or stripped: the big hit before he has it is interference, not a tackle.
    if (carrier.state === 'catching') return { kind: 'wrap', action: 'tackle', timing: 0, reason: 'wrap (fielding)' };
    const adv = momentumAdvantage(athlete, carrier);
    const aggression = defenderNoise(athlete, 'aggression');
    const timing = clamp01(1 - Math.abs(d - WRAP_REACH * 0.85) / 0.8) * (0.6 + 0.4 * read);
    // The big hit is the eager, low-read choice; a sound tackler wraps unless the momentum edge is clear.
    if (adv > 0.12 && headOn > 0.7 && mySpeed > 3.5 && (1 - read) * 0.6 + aggression * 0.4 + Math.max(0, adv - 0.3) > 0.5) {
      return { kind: 'hitStick', action: 'hitStick', timing, reason: `hit stick (+${adv.toFixed(2)} momentum)` };
    }
    const behind = carrierSpeed > 2 && dot(carrier.vel, sub(athlete.pos, carrier.pos)) / (carrierSpeed * d) < -0.5;
    if (behind && rf(carrier.attrs.carrying) < 0.6 && read + defenderJitter(athlete, 'strip', 0.15) > 0.5) {
      return { kind: 'strip', action: 'strip', timing, reason: 'strip from behind' };
    }
    return { kind: 'wrap', action: 'tackle', timing, reason: 'wrap' };
  }
  // Only a carrier who is actually running away (not a QB standing in the pocket behind his centre) earns a lunge.
  // A trailing defender who is not gaining lays out: at equal speeds the gap never closes on its own.
  // A quarterback still behind the line is lunged at from two yards whenever the rusher is not closing fast: the
  // sack is a dive at a passer who is trying to slide away, not a wrap on a runner.
  // A passer whose arm is already going back can be laid out for from full dive range, but only by a rusher who
  // reads the release (rolled once per play; the tackle read sets how often): the rest keep coming and are late.
  if (canLunge && passerInPocket && carrier.state === 'throwing' && d > WRAP_REACH && readsTheRelease(athlete, state, read)) {
    return { kind: 'dive', action: 'dive', timing: 0, reason: 'dive (beat the release)' };
  }
  const losingAngle = (carrierSpeed > 3 && closingSpeed <= 0.3 && d > WRAP_REACH && d <= 2.0) || (passerInPocket && d > WRAP_REACH && d <= 2.0 && closingSpeed <= 2);
  // A poor read lunges readily; a good one lays out only when the carrier is clearly pulling away.
  const eagerDive = (1 - read) + defenderJitter(athlete, 'dive', 0.1) > 0.55 || closingSpeed <= -1.5 || passerInPocket;
  if (canLunge && losingAngle && eagerDive) {
    return { kind: 'dive', action: 'dive', timing: 0, reason: 'dive (losing the angle)' };
  }
  return NONE;
};

/** Full pursue-and-tackle intent: the approach plus the tackle action when in range. */
export const tackleIntent = (athlete: Athlete, carrier: Athlete, state: PlayState, o: PursuitOptions = {}): AthleteIntent => {
  const intent = approachIntent(athlete, carrier, state, o);
  const choice = chooseTackle(athlete, carrier, state);
  if (choice.action) {
    intent.action = choice.action;
    intent.targetId = carrier.id;
    intent.debug = `${intent.debug} -> ${choice.reason}`;
  } else if (choice.reason === 'sliding qb') {
    intent.move = { x: 0, y: 0 };
    intent.sprint = false;
    intent.debug = 'let him slide';
  }
  return intent;
};

/** Yards per second the carrier is closing on the defender (negative when pulling away). */
export const closingRate = (athlete: Athlete, carrier: Athlete): number => {
  const to = sub(carrier.pos, athlete.pos);
  const d = len(to) || 1;
  return clamp(-dot(sub(carrier.vel, athlete.vel), to) / d, -50, 50);
};
