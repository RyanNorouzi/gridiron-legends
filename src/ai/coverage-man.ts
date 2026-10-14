import { clamp, clamp01, lerp } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { dist, dot, len, sub } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { MIDDLE_X } from '@/game/types';
import { ballHeightAt } from '@/physics/ball';
import { standingReach } from '@/physics/contact';
import { turnRate } from '@/physics/speed';
import {
  clampPoint, commonIntent, defenderJitter, depthOf, faceToward, holdIntent, mem, nearestTo, perceive, presnapIntent, rf,
  seekIntent, engagedIntent, speedOf, type Perception, type TeamView,
} from './defense-shared';
import { ballHawkShift, breakAngleError, coverageEdge, manCushionShift, manUndercutLead } from './coverage-iq';
import { tackleIntent } from './tackling';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Man coverage. Presnap the corner aligns (press: walks up on the receiver; off: holds his cushion). At the
 * snap a press corner jams for a short window by staying in the receiver's path, an off corner backpedals
 * keeping a cushion sized by the speed matchup and his coverage rating, then flips his hips and runs in phase
 * at the receiver's hip with inside leverage when he has help and outside leverage when he does not. Breaks
 * are anticipated through coverageAnticipation x awareness: until that delay passes he keeps running the
 * line the receiver WAS on. When the ball is thrown to his man he plays the ball (interception or swat, by
 * interceptionAwareness, coverage and reaction), when it goes elsewhere he rallies, and on a recognised run he
 * comes down as a force/contain player with outside leverage.
 */

export interface TrackOptions {
  technique: 'press' | 'off';
  hasHelp: boolean;
  label: string;
}

const MODE_CUSHION = 0;
const MODE_RUN = 1;
const MODE_MIRROR = 2;
const MODE_PRESS = 3;

/** Resolve the man assignment to an athlete: the named role, else the nearest eligible receiver nobody else has. */
export const resolveManTarget = (athlete: Athlete, state: PlayState, view: TeamView): Athlete | null => {
  const known = findAthlete(state, athlete.ai.targetAthleteId);
  if (known && known.active) return known;
  const a = athlete.assignment;
  const role = 'manTarget' in a ? a.manTarget : undefined;
  let t = role ? findAthlete(state, `off:${role}`) : null;
  if (!t || !t.active || !t.eligible) {
    const covered = new Set<string>();
    for (const d of view.defense) {
      if (d === athlete || d.assignment.type !== 'manCover') continue;
      const id = d.ai.targetAthleteId ?? ('manTarget' in d.assignment && d.assignment.manTarget ? `off:${d.assignment.manTarget}` : null);
      if (id) covered.add(id);
    }
    t = nearestTo(view.receivers.filter((r) => !covered.has(r.id)), athlete.pos) ?? nearestTo(view.receivers, athlete.pos);
  }
  if (t) athlete.ai.targetAthleteId = t.id;
  return t;
};

/** Leverage sign: +1/-1 in absolute x, inside (toward the middle) with help, outside without. */
const leverageSign = (target: Athlete, hasHelp: boolean): number => (hasHelp ? 1 : -1) * (target.pos.x <= MIDDLE_X ? 1 : -1);

/** Cushion (yd) an off corner keeps: bigger against faster receivers and for weaker cover men; `edge`
 *  (coverage-iq coverageEdge) makes it softer at rookie and tighter at legend. */
export const cushionFor = (athlete: Athlete, target: Athlete, edge = 0): number =>
  clamp(2.2 + 4 * (rf(target.attrs.speed) - rf(athlete.attrs.speed)) + 1.5 * (1 - rf(athlete.attrs.coverage)) + defenderJitter(athlete, 'cushion', 0.4), 1.5, 6.5)
  + manCushionShift(edge);

/** Seconds the jam lasts: coverage vs the receiver's release rating. */
export const pressWindow = (athlete: Athlete, target: Athlete): number =>
  clamp(0.55 + 0.4 * (rf(athlete.attrs.coverage) - rf(target.attrs.release)) + defenderJitter(athlete, 'press', 0.08), 0.35, 0.95);

/**
 * Play a thrown ball: run to the catch point when it is reachable in time (interception when in phase and the
 * ball-hawk score says so, otherwise a swat at arrival), else meet the receiver at the catch to tackle at once.
 */
export const playBallIntent = (athlete: Athlete, state: PlayState, p: Perception, receiver: Athlete | null): AthleteIntent => {
  const ball = state.ball;
  const landing = p.landing ?? ball.targetPos ?? ball.pos;
  const ticks = p.landingTicks;
  const tLand = ticks * TICK_DT;
  const d = dist(athlete.pos, landing);
  const canArrive = d <= speedOf(athlete) * tLand + 1.0;
  // A receiver arriving at speed leaves the catch point at speed: play THROUGH him (where he will be a beat after
  // the catch), never a spot he is about to vacate. A settled receiver (curl, hitch) is met at the ball.
  const onTheMove = receiver !== null && len(receiver.vel) > 3;
  let aim = landing;
  if (receiver && (!canArrive || onTheMove)) {
    const lead = tLand + (onTheMove ? 0.35 : 0);
    aim = { x: receiver.pos.x + receiver.vel.x * lead, y: receiver.pos.y + receiver.vel.y * lead };
  }
  // The angle is a decision (coverage-iq): a rookie-level defender breaks partly at where the receiver is now.
  const e = coverageEdge(difficultyFor(state, athlete));
  const miss = receiver ? breakAngleError(athlete, e) : 0;
  if (receiver && miss > 0) aim = { x: lerp(aim.x, receiver.pos.x, miss), y: lerp(aim.y, receiver.pos.y, miss) };
  // A settled receiver standing between this defender and the catch point: play the ball from his near shoulder,
  // never by running through his body to the far side (that shove is interference, and it moves him off the ball
  // rather than contesting it).
  let stopAt = onTheMove ? 0.15 : 0.3;
  if (receiver && !onTheMove) {
    const toCatch = sub(landing, receiver.pos);
    const toMe = sub(athlete.pos, receiver.pos);
    const l = len(toMe) || 1;
    if (len(toCatch) < 1.5 && dot(toCatch, toMe) < 0) {
      const r = athlete.radius + receiver.radius + 0.1;
      aim = { x: receiver.pos.x + (toMe.x / l) * r, y: receiver.pos.y + (toMe.y / l) * r };
      stopAt = 0.15;
    }
  }
  // The ball beats him there: drive THROUGH the receiver at full speed so the catch is the tackle, never a slow
  // arrival at an empty landing spot that the receiver has already left at speed.
  if (!canArrive) return seekIntent(athlete, clampPoint(aim, 0.3), { sprint: true, stopRadius: 0.3, debug: 'tackle at catch' });
  // Arrive, don't orbit: full speed to the catch point, easing only over the last yard, and finish with a strafe so
  // the eyes stay on the ball (an early ease-off is a catch made in front of a standing defender).
  const close = d < 2 && !onTheMove;
  const intent = seekIntent(athlete, clampPoint(aim, 0.3), {
    sprint: !close, slowRadius: onTheMove ? 0 : 2.5, stopRadius: stopAt,
    locomotion: close ? 'strafe' : 'run', face: close ? faceToward(athlete.pos, ball.pos) : null,
    debug: 'break on ball',
  });
  if (!canArrive || ticks > 10 || d > 2.0) return intent;
  const dq = difficultyFor(state, athlete);
  const hawk = 0.4 * dq.interceptionAwareness + 0.3 * rf(athlete.attrs.coverage) + 0.2 * rf(athlete.attrs.reaction) + 0.1 * rf(athlete.attrs.hands)
    + defenderJitter(athlete, 'ballhawk', 0.1) + ballHawkShift(e);
  const undercut = receiver ? dot(sub(athlete.pos, receiver.pos), sub(ball.pos, receiver.pos)) > 0 : true;
  // In phase at the receiver's hip, or sitting on the route with the receiver still well short of the catch point.
  const inPhase = receiver ? dist(athlete.pos, receiver.pos) <= 1.8 || dist(receiver.pos, landing) > d + 1.0 : true;
  const goForInt = inPhase && hawk > (undercut ? 0.45 : 0.62);
  // Height when this defender gets to the ball (the landing point itself is at catch height by definition).
  const arriveTicks = Math.min(ticks, Math.ceil(d / Math.max(speedOf(athlete), 1) / TICK_DT));
  const high = ballHeightAt(ball, arriveTicks) > standingReach(athlete) - 0.2;
  intent.action = goForInt || high ? 'jump' : 'swat';
  intent.debug = goForInt ? 'go for INT' : 'swat';
  return intent;
};

/** Deepest an off man defender aligns over his receiver before the snap (yards): a safety on the slot walks down. */
export const OFF_ALIGN_MAX_DEPTH = 7;
/** Closest to the line (yards, defense side) a pressing defender aligns before the snap: outside the neutral zone. */
export const PRESS_MIN_DEPTH = 0.4;
/** Closest to the line (yards, defense side) an off man defender aligns before the snap. */
export const PRESNAP_MIN_DEPTH = 1;
/** Depth (yards, defense side) a defender covering a back aligns at: linebacker depth, never in the backfield. */
export const BACK_COVER_DEPTH = 4.5;
/** A target deeper than this behind the line (yards) is a backfield player, not a receiver on or near the line. */
const BACKFIELD_DEPTH = 2;

/**
 * Presnap alignment: press corners walk up on the receiver, off defenders walk down to a real cushion over their
 * man (a safety assigned to the slot does not cover him from 14 yards) and watch him.
 */
const presnapMan = (athlete: Athlete, target: Athlete, state: PlayState, o: TrackOptions): AthleteIntent => {
  const dir = state.ctx.direction;
  // A man lined up in the backfield (a back, a sniffer) is never pressed: that walk would end next to the quarterback.
  const backfield = depthOf(state, target.pos) < -BACKFIELD_DEPTH;
  if (o.technique === 'press' && !backfield) {
    const depth = Math.max(PRESS_MIN_DEPTH, depthOf(state, target.pos) + 1.3);
    const spot = { x: target.pos.x + leverageSign(target, o.hasHelp) * 0.5, y: state.losY + dir * depth };
    if (dist(athlete.pos, spot) > 0.35) return seekIntent(athlete, spot, { effort: 1, slowRadius: 2, stopRadius: 0.1, debug: `press align ${target.role}` });
  } else {
    const wantDepth = clamp(cushionFor(athlete, target, coverageEdge(difficultyFor(state, athlete))) + 2.5, 4, OFF_ALIGN_MAX_DEPTH);
    const gap = depthOf(state, athlete.pos) - depthOf(state, target.pos);
    if (gap > wantDepth + 0.5 || Math.abs(athlete.pos.x - target.pos.x) > 4) {
      // Never across the line before the snap: a back is covered from linebacker depth, anyone else from at least a
      // yard off the ball.
      const floor = backfield ? BACK_COVER_DEPTH : PRESNAP_MIN_DEPTH;
      const wantY = target.pos.y + dir * Math.min(gap, wantDepth);
      const y = dir * (wantY - state.losY) < floor ? state.losY + dir * floor : wantY;
      const spot = { x: target.pos.x + leverageSign(target, o.hasHelp) * 0.8, y };
      return seekIntent(athlete, clampPoint(spot, 0.3), { effort: 0.7, stopRadius: 0.4, debug: `walk down on ` });
    }
  }
  return holdIntent(faceToward(athlete.pos, target.pos), ` presnap`);
};

/**
 * Track a receiver in man coverage (also used by match coverage once a defender converts to man). Handles the
 * press window, the cushion backpedal, the hip flip, trailing with leverage, break anticipation and mirroring
 * a settled receiver.
 */
export const trackIntent = (athlete: Athlete, target: Athlete, state: PlayState, dt: number, p: Perception, o: TrackOptions): AthleteIntent => {
  const s = athlete.ai.scratch;
  const dir = state.ctx.direction;
  const now = state.time;
  const dq = difficultyFor(state, athlete);
  // Smoothed receiver velocity and break detection.
  const k = clamp01(dt / 0.25);
  const svx = lerp(mem(s, 'svx', target.vel.x), target.vel.x, k);
  const svy = lerp(mem(s, 'svy', target.vel.y), target.vel.y, k);
  const tSpeed = len(target.vel);
  const sSpeed = Math.hypot(svx, svy);
  if (tSpeed > 2.5 && sSpeed > 1.5) {
    const cos = (target.vel.x * svx + target.vel.y * svy) / (tSpeed * sSpeed);
    if (cos < 0.82 && now - mem(s, 'breakAt', -9) > 0.5) {
      s.breakAt = now;
      s.bvx = svx;
      s.bvy = svy;
    }
  }
  s.svx = svx;
  s.svy = svy;
  const anticipation = clamp01(dq.coverageAnticipation * (0.55 + 0.45 * rf(athlete.attrs.awareness)) + defenderJitter(athlete, 'anticipation', 0.08));
  const breakDelay = p.reaction * (1.3 - anticipation);
  const breakAt = mem(s, 'breakAt', -9);
  const reacting = breakAt >= 0 && now - breakAt < breakDelay;
  const vel = reacting ? { x: mem(s, 'bvx', 0), y: mem(s, 'bvy', 0) } : target.vel;
  const lev = leverageSign(target, o.hasHelp) * 0.8;
  const d = dist(athlete.pos, target.pos);
  const gap = depthOf(state, athlete.pos) - depthOf(state, target.pos);
  const cushion = cushionFor(athlete, target, coverageEdge(dq));
  let mode = mem(s, 'mode', o.technique === 'press' ? MODE_PRESS : MODE_CUSHION);
  // The jam ends when the window closes or the receiver is already away at speed: standing in the jam spot
  // while he runs through it is how a press corner ends up three yards behind his man.
  if (mode === MODE_PRESS && (p.t > pressWindow(athlete, target) || d > 2.0 || tSpeed > 2.5)) mode = gap < cushion * 0.8 ? MODE_RUN : MODE_CUSHION;
  if (mode === MODE_CUSHION) {
    const closing = dir * vel.y;
    const flipTime = Math.PI / turnRate(athlete.attrs.agility) + 0.2;
    const timeToCushion = closing > 0.8 ? (gap - cushion) / closing : Infinity;
    const lateralBreak = !reacting && Math.abs(vel.x) > 3 && breakAt >= 0;
    // Flip early enough to be at speed when he arrives: the turn itself plus roughly half the acceleration run.
    if (timeToCushion < flipTime + 0.5 || gap < cushion * 0.7 || lateralBreak || p.t > 2.5) mode = MODE_RUN;
  }
  if (mode === MODE_RUN) {
    if (tSpeed < 1.5) {
      if (mem(s, 'settledAt', -1) < 0) s.settledAt = now;
      if (now - mem(s, 'settledAt', now) > 0.3) mode = MODE_MIRROR;
    } else {
      s.settledAt = -1;
    }
  } else if (mode === MODE_MIRROR && tSpeed > 3) {
    mode = MODE_RUN;
    s.settledAt = -1;
  }
  s.mode = mode;
  const faceHim = faceToward(athlete.pos, target.pos);
  // Hips half open toward the leverage side so the flip to run is a quarter turn, not a full 180.
  const face = faceHim + (lev > 0 ? 1 : -1) * dir * 0.7;
  switch (mode) {
    case MODE_PRESS: {
      // Jam while moving WITH him: the spot leads his velocity so the corner is already rolling when he releases
      // (a corner planted in the jam spot starts from zero and trails by five yards for the rest of the route).
      const spot = { x: target.pos.x + target.vel.x * 0.35 + lev * 0.4, y: target.pos.y + target.vel.y * 0.35 + dir * 0.9 };
      const jamFace = tSpeed > 2.5 ? Math.atan2(target.vel.y, target.vel.x) : faceHim;
      const rolling = tSpeed > 2;
      return seekIntent(athlete, spot, { locomotion: rolling ? 'run' : 'strafe', sprint: rolling, face: rolling ? null : jamFace, stopRadius: 0.1, debug: `${o.label} jam` });
    }
    case MODE_CUSHION: {
      const alignX = target.pos.x + vel.x * 0.2 + lev;
      const wantDepth = depthOf(state, target.pos) + cushion;
      const aim = { x: alignX, y: state.losY + dir * wantDepth };
      // Backpedal as soon as the receiver stems at me; a receiver who is not closing only gets a lateral shuffle.
      const closingSpeed = dir * vel.y;
      const deeperThanNeeded = gap > cushion + 6 || closingSpeed < 1;
      const effort = deeperThanNeeded ? 0.5 : clamp(closingSpeed / 6, 0.4, 1);
      const locomotion = deeperThanNeeded ? 'strafe' : 'backpedal';
      const point = deeperThanNeeded ? { x: alignX, y: athlete.pos.y } : aim;
      return seekIntent(athlete, clampPoint(point, 0.3), { locomotion, face, effort, stopRadius: 0.25, debug: `${o.label} cushion ${cushion.toFixed(1)}` });
    }
    case MODE_MIRROR: {
      const spot = { x: target.pos.x + lev, y: target.pos.y + dir * 1.0 };
      return seekIntent(athlete, clampPoint(spot, 0.3), { locomotion: 'strafe', face: faceHim, stopRadius: 0.2, debug: `${o.label} mirror` });
    }
    default: {
      // Trailing (behind his hip): aim further along his line so the corner runs to the hip instead of a pursuit curve.
      const trailingHim = gap < -0.3 && tSpeed > 3;
      // Undercut vs trail is a decision (coverage-iq): legend plays ahead on the route line, rookie sits on the hip.
      const lead = Math.max(0, 0.15 + 0.2 * anticipation + (trailingHim ? 0.3 : 0) + manUndercutLead(coverageEdge(dq)));
      const hipX = target.pos.x + vel.x * lead + lev * 1.25;
      const vertical = dir * vel.y;
      // A lateral break underneath is driven on; a receiver still short of my hip is never run AT (that is a
      // collision course and a three-yard trail afterwards): hold over him with the eyes on him until he is at
      // speed, then open the gate and run with him along his line so the flip happens at his hip.
      const breakingUnder = Math.abs(vel.x) > 3.5 && gap > 0.5;
      // Only a receiver still coming at me is held over; one who has settled or slowed is driven to.
      const under = !breakingUnder && gap > 0.5 && vertical > 1.5;
      const opening = under && vertical > 3;
      let aim: { x: number; y: number };
      if (breakingUnder) aim = { x: hipX, y: target.pos.y + vel.y * lead };
      else if (under) {
        const myDepth = depthOf(state, athlete.pos);
        const ahead = opening ? Math.max(myDepth + 1.5, depthOf(state, target.pos) + vertical * 0.6) : myDepth + 0.8;
        aim = { x: hipX, y: state.losY + dir * ahead };
      } else aim = { x: hipX, y: target.pos.y + vel.y * lead };
      const slower = tSpeed < Math.hypot(athlete.vel.x, athlete.vel.y) - 2;
      const holding = under && !opening;
      const easing = opening && gap > 4.5;
      const effort = slower && d < 2.5 ? 0.7 : holding ? 0.6 : easing ? 0.8 : 1;
      const sprint = !slower && !easing && !holding && (d > 0.8 || tSpeed > 0.6 * speedOf(athlete, false));
      const label = breakingUnder ? 'drive' : opening ? 'open gate' : holding ? 'hold over' : 'trail';
      return seekIntent(athlete, clampPoint(aim, 0.3), {
        sprint, effort, stopRadius: 0.15, locomotion: holding ? 'backpedal' : 'run', face: holding ? faceHim : null,
        debug: `${o.label} ${label}${reacting ? ' (late)' : ''}`,
      });
    }
  }
};

/** Cover a thrown ball: play it when it is coming to my man or near me, otherwise rally to the landing point. */
const thrownBallIntent = (athlete: Athlete, target: Athlete, state: PlayState, p: Perception): AthleteIntent => {
  const ball = state.ball;
  const landing = p.landing ?? ball.pos;
  const tLand = p.landingTicks * TICK_DT;
  const catchPoint = { x: target.pos.x + target.vel.x * tLand, y: target.pos.y + target.vel.y * tLand };
  const toMyMan = ball.targetId === target.id || dist(landing, catchPoint) < 3.5;
  if (toMyMan || dist(landing, athlete.pos) < 5) return playBallIntent(athlete, state, p, toMyMan ? target : null);
  return seekIntent(athlete, clampPoint(landing, 0.3), { sprint: true, effort: 0.9, debug: 'rally' });
};

/** 'defense:manCover' decider. */
export const decideManCover: IntentDecider = (athlete, state, dt) => {
  const p = perceive(athlete, state);
  const common = commonIntent(athlete, state, p.view);
  if (common) return common;
  const a = athlete.assignment;
  const technique = 'technique' in a && a.technique ? a.technique : 'off';
  const hasHelp = 'hasHelp' in a ? a.hasHelp === true : false;
  const target = resolveManTarget(athlete, state, p.view);
  if (!target) return presnapIntent(athlete, state, 'man (no target)');
  const o: TrackOptions = { technique, hasHelp, label: `man ${target.role}` };
  if (state.phase !== 'live') return presnapMan(athlete, target, state, o);
  if (athlete.state === 'engaged') return engagedIntent(athlete, state, p, target.pos, 'shed');
  const c = p.carrier;
  if (c && c.position !== 'QB') return tackleIntent(athlete, c, state, { leverage: c === target ? 'none' : 'outside' });
  if (c && c.position === 'QB' && p.view.qbDepth > -0.3) return tackleIntent(athlete, c, state, { leverage: 'outside' });
  if (p.view.ballInAir && p.passSeen) return thrownBallIntent(athlete, target, state, p);
  return trackIntent(athlete, target, state, dt, p, o);
};
