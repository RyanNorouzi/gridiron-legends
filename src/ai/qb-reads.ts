import { clamp, clamp01 } from '@/core/math';
import type { Rng } from '@/core/rng';
import { dist, dot, len, normalize, rotate, sub, type Vec2 } from '@/core/vec2';
import { FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import type { AthleteId, ThrowType } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import type { DefensivePlay, RouteType } from '@/playbook/types';
import { routeBreakIndex } from '@/playbook/transform';
import { armSpeed } from '@/physics/ball';
import { pointSegmentDistance } from '@/physics/collision';
import { assignedRouteId, canPlay, depthOf, downfield, f, goalLineY, opponentsOf, routeById, timeSinceSnap, toLocal } from './route-running';
import { difficultyFor } from '@/game/difficulty-sides';
import { getDifficulty } from '@/game/rulesets';

/**
 * Pure quarterback evaluation: coverage recognition, per-receiver reads (openness, throw difficulty, expected
 * yards, timing), throw-type selection, pressure, throw-away legality and scramble lanes. Nothing here returns
 * intents; qb.ts turns these numbers into decisions.
 */

export interface ReceiverRead {
  athlete: Athlete;
  id: AthleteId;
  role: string;
  /** Position in the progression (0 = primary). */
  order: number;
  /** 0..1 how open the receiver is at the lead point. */
  openness: number;
  /** Yards from the nearest defender to the lead point. */
  separation: number;
  /** Yards/s the nearest defender closes on the lead point (negative = drifting away). */
  closingSpeed: number;
  /** +1 defender on top of the route, -1 trailing. */
  leverage: number;
  /** A defender sits in the throwing lane close to the passer. */
  laneBlocked: boolean;
  /** 0..1 difficulty of the throw (distance vs arm, window, sideline, accuracy). */
  throwDifficulty: number;
  distance: number;
  expectedYards: number;
  isPastBreak: boolean;
  /** 1 at the moment of the break, fading to 0 half a second either side. */
  timing: number;
  isCheckdown: boolean;
  routeType: RouteType | null;
  leadPoint: Vec2;
  nearestDefenderId: AthleteId | null;
  /** Composite preference used when the QB finds the best receiver. */
  score: number;
}

export interface CoverageRead {
  recognized: boolean;
  family: 'man' | 'zone' | 'match' | 'unknown';
  blitz: boolean;
  deepSafeties: number;
}

/** Openness points of hesitation per point of decision knob below pro's (see hesitationMargin). */
export const HESITATION_PER_KNOB = 0.45;
let proKnob: number | null = null;

/**
 * Extra openness (0..1 points) a below-pro decision maker waits for before he pulls the trigger: a rookie-level
 * quarterback does not trust what he sees, holds the ball for a man running wide open and takes the sack or the
 * checkdown instead. 0 from the neutral pro knob up, so pro and the levels above keep their reads untouched.
 */
export const hesitationMargin = (qbDecisionQuality: number): number => {
  proKnob ??= getDifficulty('pro').qbDecisionQuality;
  return HESITATION_PER_KNOB * Math.max(0, proKnob - qbDecisionQuality);
};

/** Longest throw (yd) the arm can make: 30 at rating 1, ~68 at 99. */
export const armRange = (throwPower: number): number => 30 + 38 * f(throwPower);

/**
 * Coverage recognition unlocks a beat after the snap: awareness and the difficulty knob shorten the wait.
 * Once recognised the QB knows the family (man/zone/match) and whether extra rushers are coming.
 */
export const recognizeCoverage = (qb: Athlete, state: PlayState): CoverageRead => {
  const sc = qb.ai.scratch;
  const need = Math.max(0.15, 0.9 - 0.6 * f(qb.attrs.awareness) - 0.2 * clamp01(difficultyFor(state, qb).qbDecisionQuality));
  const recognized = sc.recognized === 1 || timeSinceSnap(state) >= need;
  if (recognized) sc.recognized = 1;
  const dp = state.ctx.defensivePlay;
  let deep = 0;
  let rushers = 0;
  for (const d of opponentsOf(qb, state)) {
    const l = toLocal(d.pos, state);
    if (l.y >= 10) deep++;
    if (l.y <= 3 && -state.ctx.direction * d.vel.y > 1) rushers++;
  }
  return {
    recognized,
    family: recognized ? dp.family : 'unknown',
    blitz: recognized && (dp.blitz !== 'none' || rushers >= 5),
    deepSafeties: deep,
  };
};

/** Yards inside the sideline a passer leads a receiver to: the ball goes to his inside shoulder, not out of bounds. */
export const SIDELINE_LEAD_MARGIN = 1.5;

const CROSSERS = new Set<RouteType>(['drag', 'cross', 'in', 'dig', 'slant', 'post']);
const VERTICALS = new Set<RouteType>(['go', 'fade', 'seam', 'wheel', 'post', 'corner']);

/** Evaluate every eligible receiver in progression order (blockers and the ball carrier are skipped). */
export const evaluateReceivers = (qb: Athlete, state: PlayState, order: readonly string[]): ReceiverRead[] => {
  const opps = opponentsOf(qb, state).filter(canPlay);
  const cov = recognizeCoverage(qb, state);
  const arm = armSpeed(qb.attrs.throwPower);
  const range = armRange(qb.attrs.throwPower);
  const dir = state.ctx.direction;
  const maxDepth = dir * (goalLineY(state) - state.losY);
  const reads: ReceiverRead[] = [];
  order.forEach((role, idx) => {
    const r = state.athletes.find((a) => a.side === 'offense' && a.role === role && a.active);
    if (!r || r.id === qb.id || r.hasBall) return;
    const t = r.assignment.type;
    if (t !== 'route' && t !== 'chipRelease') return;
    const routeId = assignedRouteId(r);
    const route = routeId ? routeById(routeId) : null;
    if (route && route.type === 'block') return;
    const distance = dist(qb.pos, r.pos);
    const flight = clamp(distance / (arm * 0.85), 0.3, 2.2);
    const leadT = len(r.vel) > 2 ? Math.min(flight, 0.9) : 0;
    const lead = { x: clamp(r.pos.x + r.vel.x * leadT, SIDELINE_LEAD_MARGIN, FIELD_WIDTH - SIDELINE_LEAD_MARGIN), y: r.pos.y + r.vel.y * leadT };
    let nd: Athlete | null = null;
    let separation = Infinity;
    let laneBlocked = false;
    // A short throw is flat, so anyone near the lane within 8 yd can bat it; a deep ball is rising over all but the linemen.
    const lowWindow = distance < 15 ? Math.min(8, distance - 1) : 3.5;
    for (const d of opps) {
      // Defenders keep running too: a man in phase stays in phase at the lead point.
      const projected = { x: d.pos.x + d.vel.x * leadT * 0.8, y: d.pos.y + d.vel.y * leadT * 0.8 };
      const dd = dist(projected, lead);
      if (dd < separation) { separation = dd; nd = d; }
      const dq = dist(d.pos, qb.pos);
      if (dq > 1.5 && dq < lowWindow && pointSegmentDistance(d.pos, qb.pos, lead) < 1.2) laneBlocked = true;
    }
    if (!Number.isFinite(separation)) separation = 20;
    const toLead = sub(lead, nd ? nd.pos : lead);
    const closingSpeed = nd && len(toLead) > 1e-6 ? dot(normalize(toLead), nd.vel) : 0;
    const heading = len(r.vel) > 0.5 ? normalize(r.vel) : downfield(state);
    const leverage = nd && dist(nd.pos, r.pos) > 1e-6 ? dot(heading, normalize(sub(nd.pos, r.pos))) : -1;
    let openness = clamp01((separation - 0.6) / 4.5) - clamp01(closingSpeed / 8) * 0.25;
    if (leverage > 0.5 && separation < 3) openness -= 0.15;
    if (laneBlocked) openness -= 0.5;
    const depthLead = depthOf(lead, state);
    if (depthLead >= 15) {
      const helpers = opps.filter((d) => depthOf(d.pos, state) > depthLead + 1 && Math.abs(d.pos.x - lead.x) < 10).length;
      openness -= 0.1 * Math.min(2, helpers);
    }
    if (cov.recognized && route) {
      if (cov.family === 'man') {
        if (CROSSERS.has(route.type)) openness += 0.08;
        if (nd && r.attrs.speed > nd.attrs.speed + 8) openness += 0.06;
      } else if (len(r.vel) < 2 && separation > 2.5) openness += 0.1;
    }
    openness = clamp01(openness);
    const sideline = clamp01(1 - Math.min(lead.x, FIELD_WIDTH - lead.x) / 3);
    // Distance is risk in its own right: the longer the ball is in the air the more the coverage closes on it.
    const throwDifficulty = clamp01(0.12 + 0.5 * (distance / range) ** 2 + 0.12 * clamp01((distance - 12) / 20) + 0.25 * (1 - openness) + 0.12 * sideline
      - 0.15 * f(qb.attrs.throwAccuracy) + 0.1 * clamp01(closingSpeed / 6));
    const yac = openness * (3 + 6 * f(r.attrs.speed));
    const expectedYards = Math.min(depthLead + yac, maxDepth);
    const breakTime = route ? route.breakTime : 0;
    const timing = route ? 1 - clamp01(Math.abs(r.ai.routeTimer - breakTime) / 0.5) : 1;
    const isPastBreak = route ? r.ai.routeIndex > routeBreakIndex(route) || r.ai.routeTimer > breakTime + 0.25 : true;
    const isCheckdown = depthLead < 5 || r.position === 'RB' || r.position === 'FB';
    // The primary is the play's answer to the coverage: comparable reads defer to the design, clearly better ones win.
    const progressionBias = idx === 0 ? 0.2 : Math.max(0, 0.12 - 0.03 * idx);
    const score = 0.55 * openness + 0.12 * clamp01(expectedYards / 25) - 0.35 * throwDifficulty + progressionBias
      + 0.12 * timing * (isPastBreak ? 1 : 0.5) - (laneBlocked ? 1 : 0);
    reads.push({
      athlete: r, id: r.id, role, order: idx, openness, separation, closingSpeed, leverage, laneBlocked, throwDifficulty, distance,
      expectedYards, isPastBreak, timing, isCheckdown, routeType: route ? route.type : null, leadPoint: lead,
      nearestDefenderId: nd ? nd.id : null, score,
    });
  });
  return reads;
};

export interface SelectOptions {
  /** Minimum openness to be throwable. */
  threshold: number;
  /** Maximum throw difficulty accepted. */
  maxDifficulty: number;
}

/**
 * The read the QB commits to: with probability `quality` (awareness blended with qbDecisionQuality) he finds the
 * BEST acceptable receiver by score; otherwise he settles for the first acceptable one in the progression.
 * Null when nobody clears the thresholds.
 */
export const selectRead = (reads: readonly ReceiverRead[], quality: number, rng: Rng, opts: SelectOptions): ReceiverRead | null => {
  const ok = reads.filter((r) => r.openness >= opts.threshold && r.throwDifficulty <= opts.maxDifficulty);
  if (ok.length === 0) return null;
  if (rng.chance(clamp01(quality))) return ok.reduce((a, b) => (b.score > a.score ? b : a));
  return ok.reduce((a, b) => (b.order < a.order ? b : a));
};

/**
 * Throw type for a target: bullets for short/tight windows, touch over an underneath defender or on medium
 * routes, lobs deep, back-shoulder against a trailing defender on a vertical, high-point for a taller receiver
 * in a tight deep window.
 */
export const chooseThrowType = (qb: Athlete, target: ReceiverRead, defenders: readonly Athlete[], distance: number): ThrowType => {
  const nd = target.nearestDefenderId ? defenders.find((d) => d.id === target.nearestDefenderId) ?? null : null;
  const underneath = defenders.some((d) => d !== nd && canPlay(d) && dist(d.pos, qb.pos) > 2 && dist(d.pos, qb.pos) < distance - 2
    && pointSegmentDistance(d.pos, qb.pos, target.leadPoint) < 1.5);
  if (distance < 12) return underneath ? 'touch' : 'bullet';
  if (target.routeType && VERTICALS.has(target.routeType) && distance > 18 && nd) {
    if (target.leverage < -0.3 && target.separation < 2.5) return 'backShoulder';
    if (target.athlete.heightIn - nd.heightIn >= 2 && target.separation < 2.5) return 'highPoint';
    return distance > 28 || target.separation < 3 ? 'lob' : 'touch';
  }
  if (distance <= 22) return target.separation < 1.8 && !underneath ? 'bullet' : 'touch';
  return distance > 30 ? 'lob' : 'touch';
};

export interface PressureRead {
  /** 0..1 how close the rush is to getting home. */
  level: number;
  nearest: Athlete | null;
  /** Seconds until the nearest rusher arrives (Infinity when nobody is closing). */
  timeToContact: number;
  fromLeft: boolean;
  fromRight: boolean;
  interior: boolean;
  rushers: number;
  /** Distance (yd) to the nearest unblocked rusher (Infinity when none). */
  freeDist: number;
}

/** Rushers within 7 yd that are closing (or already on top of the QB), weighted by distance and closing speed. */
/** A blocker this close to the rusher's straight line to the QB is in his way. */
const BLOCKER_LANE_WIDTH = 0.9;

/** True when no offensive blocker stands between the rusher and the QB (he has a free run). */
export const isFreeRusher = (rusher: Athlete, qb: Athlete, state: PlayState): boolean => {
  if (rusher.engagedWith !== null) return false;
  const dd = dist(rusher.pos, qb.pos);
  if (dd <= 1.2) return true;
  for (const b of state.athletes) {
    if (b.side !== qb.side || b.id === qb.id || !b.active || b.hasBall) continue;
    if (pointSegmentDistance(b.pos, rusher.pos, qb.pos) <= BLOCKER_LANE_WIDTH && dist(b.pos, qb.pos) < dd) return false;
  }
  return true;
};

export const pressureLevel = (qb: Athlete, state: PlayState): PressureRead => {
  const out: PressureRead = { level: 0, nearest: null, timeToContact: Infinity, fromLeft: false, fromRight: false, interior: false, rushers: 0, freeDist: Infinity };
  const local = toLocal(qb.pos, state);
  let freeRushers = 0;
  for (const d of opponentsOf(qb, state)) {
    if (!canPlay(d)) continue;
    const dd = dist(d.pos, qb.pos);
    if (dd > 7) continue;
    const closing = dd > 1e-6 ? dot(normalize(sub(qb.pos, d.pos)), d.vel) : 5;
    if (closing < 0.5 && dd > 2.5) continue;
    out.rushers++;
    // A rusher with a blocker in his lane (or already locked up) is a worry, not a hit: he shapes the level but
    // never the time to contact, so the QB finishes his drop instead of dumping it off at the snap.
    const free = isFreeRusher(d, qb, state);
    if (free) {
      freeRushers++;
      out.freeDist = Math.min(out.freeDist, dd);
    }
    let threat = clamp01(1 - dd / 6) * (0.6 + 0.4 * clamp01(closing / 6));
    if (!free) threat *= 0.5;
    if (threat > out.level) { out.level = threat; out.nearest = d; }
    const t = free ? dd / Math.max(1, closing) : Infinity;
    if (t < out.timeToContact) out.timeToContact = t;
    const dl = toLocal(d.pos, state);
    if (dl.x < local.x - 1) out.fromLeft = true;
    else if (dl.x > local.x + 1) out.fromRight = true;
    else out.interior = true;
  }
  // Several UNBLOCKED rushers compound the problem; a four-man line sitting in its blocks does not.
  if (freeRushers > 1) out.level = clamp01(out.level + 0.15 * (freeRushers - 1));
  return out;
};

/** Half-width of the tackle box around the snap spot (grounding rule). */
export const TACKLE_BOX_HALF = 4;

/** True when the QB is outside (or at the edge of) the tackle box, so a throw-away past the LOS is legal. */
export const throwAwayAllowed = (qb: Athlete, state: PlayState): boolean =>
  Math.abs(qb.pos.x - state.snapX) > TACKLE_BOX_HALF - 1 || depthOf(qb.pos, state) > -1;

/** Where to throw the ball away: out of bounds on the nearer sideline, past the line of scrimmage. */
export const throwAwayTarget = (qb: Athlete, state: PlayState): Vec2 => ({
  x: qb.pos.x < MIDDLE_X ? -2 : FIELD_WIDTH + 2,
  y: state.losY + state.ctx.direction * 4,
});

/**
 * A legal throwaway from inside the pocket: a spot on the turf a few yards past an eligible receiver (inside the
 * grounding radius of him), on whichever side keeps it furthest from every defender. Null when nobody is within a
 * throwable distance.
 */
export const groundingSafeSpot = (qb: Athlete, state: PlayState): Vec2 | null => {
  const eligible = state.athletes.filter((a) => a.active && a.side === qb.side && a.id !== qb.id && a.eligible && dist(a.pos, qb.pos) <= 30);
  const defenders = opponentsOf(qb, state).filter(canPlay);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const r of eligible) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const spot = { x: r.pos.x + Math.cos(ang) * 4, y: r.pos.y + Math.sin(ang) * 4 };
      // Never short of him toward the passer (that is where the underneath defenders sit), and never behind the
      // passer: a ball thrown backward is a live lateral, not a throwaway.
      if (dist(spot, qb.pos) < dist(r.pos, qb.pos)) continue;
      if ((spot.y - qb.pos.y) * state.ctx.direction < 1) continue;
      const clear = defenders.reduce((m, d) => Math.min(m, dist(d.pos, spot)), 99);
      const score = clear - 0.05 * dist(spot, qb.pos);
      if (score > bestScore) { bestScore = score; best = spot; }
    }
  }
  return best;
};

export interface ScrambleLane {
  dir: Vec2;
  /** Yards of clearance from the nearest defender along the lane. */
  clearance: number;
}

/** Best escape lane (downfield +/- 60 degrees) with at least `minClearance` yards of room; null when the pocket is sealed. */
export const scrambleLane = (qb: Athlete, state: PlayState, minClearance = 2.5): ScrambleLane | null => {
  const down = downfield(state);
  const dir = state.ctx.direction;
  const opps = opponentsOf(qb, state).filter(canPlay);
  let best: ScrambleLane | null = null;
  let bs = -Infinity;
  for (const deg of [-60, -35, 0, 35, 60]) {
    const d = rotate(down, (deg * Math.PI / 180) * dir);
    const end = { x: qb.pos.x + d.x * 7, y: qb.pos.y + d.y * 7 };
    if (end.x < 1 || end.x > FIELD_WIDTH - 1) continue;
    let clearance = Infinity;
    for (const o of opps) {
      const ahead = dot(sub(o.pos, qb.pos), d);
      if (ahead < -1 || ahead > 9) continue;
      clearance = Math.min(clearance, pointSegmentDistance(o.pos, qb.pos, end));
    }
    const score = Math.min(clearance, 6) - 0.02 * Math.abs(deg);
    if (clearance >= minClearance && score > bs) { bs = score; best = { dir: d, clearance }; }
  }
  return best;
};

/**
 * The hot read: the defense he sees (the shown call; a disguise can hide it) sends more men than the offense has in
 * pass protection, so someone comes free and the ball has to come out on the quick clock. Backs who may stay in to
 * check do not count: they are the answer only if they get there.
 */
export const hotRead = (shown: DefensivePlay, state: PlayState): boolean => {
  const rush = Object.values(shown.assignments).filter((a) => a.type === 'blitz' || a.type === 'rushGap' || a.type === 'contain').length;
  const pa = state.ctx.offensivePlay.type === 'playAction';
  const protect = state.athletes.filter((a) => a.side === 'offense' && a.active && (a.assignment.type === 'passBlock' || (pa && a.assignment.type === 'runBlock'))).length;
  return rush > protect;
};
