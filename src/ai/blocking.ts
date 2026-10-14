import { dist, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentDecider } from '@/game/engine-api';
import { ballCarrier } from '@/game/athlete';
import type { Athlete, PlayState } from '@/game/play-types';
import {
  arriveAt, blendQuality, canPlay, chaseBallIntent, depthOf, downfield, downfieldAngle, nearestTo, opponentsOf,
  routeAlignment, steerTo, teammatesOf, toField, toLocal,
} from './route-running';
import { engageIntent, engagedDefender, gapLocalX, gapPoint, isLineman, isPassProtector, protectPoint } from './blocking-core';
import { passBlockIntent } from './blocking-pass';
import { difficultyFor } from '@/game/difficulty-sides';

export { ENGAGE_RANGE, gapLocalX, gapPoint } from './blocking-core';
export {
  BLITZ_CHECK_SECONDS, CHIP_SECONDS, backBlitzCheckIntent, blitzPickupIntent, chipEdgeIntent, freeRusherFor, passBlockIntent, passProtection, passSetLocal, perceivedRushers,
  type PassProtection,
} from './blocking-pass';

/**
 * Offensive blocking deciders: run blocks (man over the gap, zone combos that climb to the second level, pulls,
 * down blocks and edge seals), lead blocks through the hole and downfield stalk blocks; pass protection lives in
 * blocking-pass.ts. Intents use action 'block' with a targetId once in range; movement always aims for the spot
 * between the defender and whoever is being protected.
 */

/** Seconds a double team is held before the second blocker climbs (sooner when the linebacker comes to it). */
export const DOUBLE_TEAM_SECONDS = 0.55;
/** ...or this soon once the linebacker commits downhill to the combo's gap. */
export const COMMIT_CLIMB_SECONDS = 0.25;

/** Defenders already taken by another blocker (engaged with, or the declared target of, a teammate). */
const takenByMate = (athlete: Athlete, state: PlayState, d: Athlete): boolean =>
  (d.engagedWith !== null && d.engagedWith !== athlete.id)
  || teammatesOf(athlete, state).some((t) => t.ai.blockTargetId === d.id && t.engagedWith === d.id);

/** Stalk block for receivers and backs: pick the defender that threatens `protect` (smart blockers weigh the
 * threat, dull ones just take the nearest), get between him and the ball, engage when close. */
export const stalkBlockIntent = (athlete: Athlete, state: PlayState, protect: Vec2, opts: { engage?: boolean; preferDb?: boolean } = {}): AthleteIntent => {
  const iq = blendQuality(athlete, difficultyFor(state, athlete).blockingIq);
  let best: Athlete | null = null;
  let bs = Infinity;
  for (const d of opponentsOf(athlete, state)) {
    if (!canPlay(d) || (d.engagedWith !== null && d.engagedWith !== athlete.id)) continue;
    const dm = dist(d.pos, athlete.pos);
    if (dm > 14) continue;
    let s = iq > 0.5 ? dm + 0.6 * dist(d.pos, protect) : dm;
    if (opts.preferDb && (d.position === 'CB' || d.position === 'FS' || d.position === 'SS')) s -= 4;
    if (s < bs) { bs = s; best = d; }
  }
  if (!best) {
    athlete.ai.blockTargetId = null;
    const shadow = { x: protect.x, y: protect.y + state.ctx.direction * 4 };
    return steerTo(athlete.pos, shadow, 0.7, false, 'shadow');
  }
  return engageIntent(athlete, best, protect, `stalk ${best.role}`, opts.engage !== false);
};

/* -------------------------------- Run blocking -------------------------------- */

/** Zone schemes (inside/outside zone, stretch): everyone steps play-side, uncovered linemen combo and climb. */
export const isZoneScheme = (state: PlayState): boolean => /zone|stretch/i.test(state.ctx.offensivePlay.id);

const defenderOverGap = (opps: readonly Athlete[], state: PlayState, gx: number): Athlete | null => {
  let best: Athlete | null = null;
  let bs = Infinity;
  for (const d of opps) {
    const l = toLocal(d.pos, state);
    if (l.y < -1 || l.y > 4.5 || Math.abs(l.x - gx) > 1.3) continue;
    const s = l.y + 0.5 * Math.abs(l.x - gx);
    if (s < bs) { bs = s; best = d; }
  }
  return best;
};

/**
 * The second-level defender (linebacker / box safety) to climb to near a gap: the nearest to the gap's second-level
 * point that no teammate has already climbed to (a taken one only when nobody else is there).
 */
const secondLevel = (athlete: Athlete, opps: readonly Athlete[], state: PlayState, gx: number, exclude: Athlete | null): Athlete | null => {
  const gp = toField({ x: gx, y: 3 }, state);
  const cands = opps.filter((d) => {
    if (d === exclude) return false;
    const l = toLocal(d.pos, state);
    return l.y >= 1.5 && l.y <= 8.5 && Math.abs(l.x - gx) <= 4;
  });
  const open = cands.filter((d) => !teammatesOf(athlete, state).some((t) => t.ai.blockTargetId === d.id && !isLineman(d)));
  return nearestTo(open.length ? open : cands, gp);
};

/** Pulling lineman: drop, run behind the line to the play-side gap, then turn up through it and kick out / lead. */
const pullIntent = (athlete: Athlete, state: PlayState, gx: number, align: Vec2, opps: readonly Athlete[]): AthleteIntent => {
  const sc = athlete.ai.scratch;
  const phase = sc.pullPhase ?? 0;
  const sideSign = Math.sign(gx) || 1;
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'offense' && depthOf(carrier.pos, state) > depthOf(athlete.pos, state) + 1) sc.pullPhase = 2;
  if (phase === 0) {
    // Open the hip and bucket-step back off the line (a short, quick drop: the pull must beat the back to the hole).
    const drop = toField({ x: align.x + sideSign * 0.4, y: align.y - 1.0 }, state);
    if (dist(athlete.pos, drop) < 0.5) sc.pullPhase = 1;
    const intent = steerTo(athlete.pos, drop, 1, false, 'pull: drop');
    intent.locomotion = 'strafe';
    intent.face = downfieldAngle(state);
    return intent;
  }
  if (phase === 1) {
    const lane = toField({ x: gx - sideSign * 1.0, y: align.y - 0.9 }, state);
    if (dist(athlete.pos, lane) < 0.8) sc.pullPhase = 2;
    return steerTo(athlete.pos, lane, 1, true, 'pull: behind line');
  }
  const gp = toField({ x: gx, y: 0.5 }, state);
  const cands = opps.filter((d) => {
    const l = toLocal(d.pos, state);
    return Math.abs(l.x - gx) <= 2.6 && l.y >= -1.5 && l.y <= 6 && !takenByMate(athlete, state, d);
  });
  const target = nearestTo(cands, gp);
  if (target) return engageIntent(athlete, target, protectPoint(state, { x: gx, y: -2 }), `pull: kick ${target.role}`);
  athlete.ai.blockTargetId = null;
  return steerTo(athlete.pos, toField({ x: gx, y: 2 }, state), 0.9, false, 'pull: through gap');
};

export interface RunBlockTarget {
  target: Athlete | null;
  /** 'gap' = man over the gap, 'climb' = second level, 'nearest' = nobody home / misread fallback, 'pull' = pulling. */
  mode: 'gap' | 'climb' | 'nearest' | 'pull';
}

/** Pure target selection for a run blocker (no misread roll): the man over the gap, else the linebacker to climb to. */
export const runBlockTarget = (athlete: Athlete, state: PlayState): RunBlockTarget => {
  const gap = athlete.assignment.gap ?? state.ctx.offensivePlay.runGap;
  if (!gap) return { target: null, mode: 'nearest' };
  const align = routeAlignment(athlete, state);
  const gx = gapLocalX(gap);
  if (align.x !== 0 && Math.sign(gx) !== Math.sign(align.x) && Math.abs(gx - align.x) > 2.5) return { target: null, mode: 'pull' };
  const opps = opponentsOf(athlete, state).filter(canPlay);
  const over = defenderOverGap(opps, state, gx);
  if (over) return { target: over, mode: 'gap' };
  const lb = secondLevel(athlete, opps, state, gx, null);
  if (lb) return { target: lb, mode: 'climb' };
  return { target: nearestTo(opps.filter((d) => dist(d.pos, athlete.pos) <= 8), athlete.pos), mode: 'nearest' };
};

/**
 * Combo (double team) on a down lineman: the man farther from him helps drive him off the ball, eyes on the
 * linebacker, and climbs once the combo has held long enough or the linebacker commits to the gap.
 */
const comboIntent = (athlete: Athlete, state: PlayState, dt: number, target: Athlete, gx: number, opps: readonly Athlete[]): { target: Athlete; mode: string } => {
  const sc = athlete.ai.scratch;
  const myD = dist(athlete.pos, target.pos);
  const mate = teammatesOf(athlete, state).find((t) =>
    (t.assignment.type === 'runBlock' || t.assignment.type === 'leadBlock') && t.ai.blockTargetId === target.id && dist(t.pos, target.pos) < myD - 0.1);
  if (!mate) return { target, mode: 'gap' };
  sc.doubleT = (sc.doubleT ?? 0) + dt;
  const lb = secondLevel(athlete, opps, state, gx, target);
  const lbCommits = lb !== null && toLocal(lb.pos, state).y < 3.2;
  const held = sc.doubleT > DOUBLE_TEAM_SECONDS || (sc.doubleT > COMMIT_CLIMB_SECONDS && lbCommits);
  if (held && lb) return { target: lb, mode: 'climb' };
  return { target, mode: 'double' };
};

/** Run block: man over my gap, else climb to the linebacker; pulls, combos, down blocks and seals handled here too. */
export const runBlockIntent = (athlete: Athlete, state: PlayState, dt: number): AthleteIntent => {
  // Play action: the run block is the fake's first step; the line then protects the passer.
  if (isPassProtector(athlete, state)) return passBlockOrRelease(athlete, state);
  const gap = athlete.assignment.gap ?? state.ctx.offensivePlay.runGap;
  if (!gap) return stalkBlockIntent(athlete, state, protectPoint(state, { x: 0, y: -2 }));
  const sc = athlete.ai.scratch;
  const align = routeAlignment(athlete, state);
  const gx = gapLocalX(gap);
  const opps = opponentsOf(athlete, state).filter(canPlay);
  const held = engagedDefender(athlete, state);
  const protect = protectPoint(state, { x: gx, y: -2 });
  if (held) {
    const partner = isLineman(held) ? teammatesOf(athlete, state).find((t) => t.engagedWith === held.id) : undefined;
    if (partner) {
      // On a combo: drive the down lineman together, and the man aligned farther from him climbs to the linebacker
      // once the combo has moved him (or the linebacker commits to the gap).
      sc.doubleT = (sc.doubleT ?? 0) + dt;
      const lb = secondLevel(athlete, opps, state, gx, held);
      const lbCommits = lb !== null && toLocal(lb.pos, state).y < 3.2;
      const hx = toLocal(held.pos, state).x;
      const mine = Math.abs(align.x - hx);
      const theirs = Math.abs(routeAlignment(partner, state).x - hx);
      const iClimb = mine > theirs + 0.05 || (Math.abs(mine - theirs) <= 0.05 && athlete.id > partner.id);
      if (lb && iClimb && (sc.climbing === 1 || sc.doubleT > DOUBLE_TEAM_SECONDS || (sc.doubleT > COMMIT_CLIMB_SECONDS && lbCommits))) {
        sc.climbing = 1;
        return climbIntent(athlete, lb, protect);
      }
      return engageIntent(athlete, held, protect, `run block double ${held.role}`);
    }
    return engageIntent(athlete, held, protect, `run block engaged ${held.role}`);
  }
  const chosen = runBlockTarget(athlete, state);
  if (chosen.mode === 'pull') return pullIntent(athlete, state, gx, align, opps);
  if (sc.climbing === 1) {
    // Committed to the second level off a combo: go get the linebacker (flat out) instead of drifting back.
    const lb = secondLevel(athlete, opps, state, gx, null);
    if (lb && !isLineman(lb)) return climbIntent(athlete, lb, protect);
    sc.climbing = 0;
  }
  if (sc.misreadRolled !== 1) {
    sc.misreadRolled = 1;
    const iq = blendQuality(athlete, difficultyFor(state, athlete).blockingIq);
    sc.misread = state.ctx.rng.chance((1 - iq) * 0.35) ? 1 : 0;
  }
  let target = chosen.target;
  let mode: string = chosen.mode;
  if (sc.misread === 1) {
    // A misread takes the nearest defender nobody else has (never a man a teammate is already on).
    target = nearestTo(opps.filter((d) => dist(d.pos, athlete.pos) <= 6 && !takenByMate(athlete, state, d)), athlete.pos) ?? target;
    mode = 'misread';
  } else if (target && isLineman(target)) {
    const combo = comboIntent(athlete, state, dt, target, gx, opps);
    target = combo.target;
    mode = combo.mode;
    sc.climbing = mode === 'climb' ? 1 : 0;
  }
  if (!target) {
    athlete.ai.blockTargetId = null;
    // Nobody home: zone blockers step play-side and climb; a man blocker walls off his gap.
    const hold = toField({ x: gx + (isZoneScheme(state) ? Math.sign(gx) * 0.8 : 0), y: 1.5 }, state);
    const intent = arriveAt(athlete.pos, hold, 1, 0.8, false, 'run block: hold gap');
    intent.locomotion = 'strafe';
    intent.face = downfieldAngle(state);
    return intent;
  }
  if (mode === 'climb') return climbIntent(athlete, target, protect);
  return engageIntent(athlete, target, protect, `run block ${mode} ${target.role}`);
};

/** Climb to a second-level defender: take the angle between him and the ball, at full speed until contact. */
const climbIntent = (athlete: Athlete, lb: Athlete, protect: Vec2): AthleteIntent => {
  const intent = engageIntent(athlete, lb, protect, `run block climb ${lb.role}`);
  intent.sprint = dist(athlete.pos, lb.pos) > 1.5;
  return intent;
};

/* -------------------------------- Lead blocking -------------------------------- */

/** Lead block: run through the assigned gap ahead of the carrier and block the first unblocked defender in the lane. */
export const leadBlockIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const gap = athlete.assignment.gap ?? state.ctx.offensivePlay.runGap;
  if (!gap) return stalkBlockIntent(athlete, state, protectPoint(state, { x: 0, y: -3 }));
  const gx = gapLocalX(gap);
  const gp = gapPoint(gap, state, 0.5);
  const protect = protectPoint(state, { x: gx, y: -3 });
  const held = engagedDefender(athlete, state);
  if (held) return engageIntent(athlete, held, protect, `lead engaged ${held.role}`);
  const opps = opponentsOf(athlete, state).filter(canPlay);
  const cands = opps.filter((d) => {
    const l = toLocal(d.pos, state);
    return Math.abs(l.x - gx) <= 2.4 && l.y >= -0.5 && l.y <= 7 && !takenByMate(athlete, state, d);
  });
  const target = nearestTo(cands, gp);
  if (target) {
    const intent = engageIntent(athlete, target, protect, `lead ${target.role}`);
    intent.sprint = true;
    return intent;
  }
  athlete.ai.blockTargetId = null;
  if (dist(athlete.pos, gp) > 0.8) return steerTo(athlete.pos, gp, 1, true, 'lead through gap');
  const next = nearestTo(opps.filter((d) => dist(d.pos, athlete.pos) <= 6 && depthOf(d.pos, state) >= depthOf(athlete.pos, state) - 1 && !takenByMate(athlete, state, d)), athlete.pos);
  if (next) return engageIntent(athlete, next, protect, `lead ${next.role}`);
  const d = downfield(state);
  return steerTo(athlete.pos, { x: athlete.pos.x + d.x * 3, y: athlete.pos.y + d.y * 3 }, 0.7, false, 'lead: upfield');
};

/* ----------------------------------- Deciders ----------------------------------- */

/** A blocker who ends up with the ball (fumble recovery): protect it and run north. */
const linemanCarry = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const d = downfield(state);
  return steerTo(athlete.pos, { x: athlete.pos.x + d.x * 5, y: athlete.pos.y + d.y * 5 }, 1, true, 'recovered: run');
};

const withCommon = (body: (athlete: Athlete, state: PlayState, dt: number) => AthleteIntent): IntentDecider => (athlete, state, dt) => {
  if (state.phase === 'presnap') return idleIntent('set');
  const chase = chaseBallIntent(athlete, state);
  if (chase) return chase;
  if (athlete.hasBall) return linemanCarry(athlete, state);
  return body(athlete, state, dt);
};

/** Pass protection until a teammate other than the passer has the ball (a screen, a checkdown): then block for him. */
const passBlockOrRelease = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'offense' && carrier.assignment.type !== 'qb') return stalkBlockIntent(athlete, state, carrier.pos);
  return passBlockIntent(athlete, state);
};

/** Decider for assignment 'runBlock'. */
export const decideRunBlock: IntentDecider = withCommon(runBlockIntent);
/** Decider for assignment 'passBlock'. */
export const decidePassBlock: IntentDecider = withCommon((athlete, state) => passBlockOrRelease(athlete, state));
/** Decider for assignment 'leadBlock'. */
export const decideLeadBlock: IntentDecider = withCommon((athlete, state) => leadBlockIntent(athlete, state));
