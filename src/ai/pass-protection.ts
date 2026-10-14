import { clamp01 } from '@/core/math';
import { dist, type Vec2 } from '@/core/vec2';
import type { AthleteId } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import { canPlay, findQb, routeAlignment, toField, toLocal } from './route-running';
import { engagedDefender, isLineman, isPassProtector, isRusherByAssignment } from './blocking-core';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * The pass-protection PLAN (split from blocking-pass.ts, which turns it into each blocker's footwork): which rushers
 * the protection can see, the non-crossing line match, the backs' pickups and the spare linemen's help. A pure
 * function of the state, so every blocker computes the same plan.
 */

/** Lateral reach (yd) beyond which a lineman cannot realistically take a rusher. */
const MAX_REACH_X = 6.5;
/** ...and for a guard or centre on a blitzing linebacker or defensive back. */
const INTERIOR_REACH_X = 3.5;
/** Stickiness: a blocker already on a rusher keeps him unless someone else is clearly better placed. */
const KEEP_BONUS = 1.2;

/**
 * Defenders the protection can tell are rushing: linemen at the LOS (unless visibly bailing into coverage), assigned
 * blitzers/containers once inside a radius that grows with blocking IQ, and anyone charging at the passer (not a
 * linebacker flowing with a back to the flat: he is covering him).
 */
export const perceivedRushers = (state: PlayState, iq: number): Athlete[] => {
  const out: Athlete[] = [];
  const qb = findQb(state);
  for (const d of state.athletes) {
    if (d.side !== 'defense' || !canPlay(d)) continue;
    const local = toLocal(d.pos, state);
    // Anyone already in the backfield counts, however deep the drop (a blitzer at the passer's depth is the threat).
    if (local.y > 12 || local.y < -16) continue;
    const towardLos = -state.ctx.direction * d.vel.y;
    const toQb = qb ? (d.vel.x * (qb.pos.x - d.pos.x) + d.vel.y * (qb.pos.y - d.pos.y)) / Math.max(dist(d.pos, qb.pos), 1e-6) : towardLos;
    if (isLineman(d) && local.y <= 3 && towardLos > -2.5) out.push(d);
    else if (isRusherByAssignment(d) && local.y <= 2 + 6 * iq) out.push(d);
    else if (towardLos > 2 && toQb > 2 && local.y <= 3 + 3 * iq) out.push(d);
  }
  return out;
};

export interface PassProtection {
  /** blocker id -> rusher id. */
  assignment: Map<AthleteId, AthleteId>;
  /** Side (play-local sign) with more rushers than blockers, 0 when balanced. */
  overloadSide: -1 | 0 | 1;
  /** Rushers nobody is assigned to (hot: the passer must beat them). */
  free: AthleteId[];
  /** Unassigned line blockers -> the rusher each one helps on. */
  help: Map<AthleteId, AthleteId>;
}

interface Placed { a: Athlete; local: Vec2 }

/** A blocker aligned on the line (linemen, in-line tight ends) rather than in the backfield. */
export const isLineBlocker = (b: Athlete, state: PlayState): boolean => routeAlignment(b, state).y >= -1.8;

/** Cost of leaving a rusher unblocked: inside rushers (the shortest path to the passer) are the last to leave. */
const leaveCost = (r: Placed): number => 7 + 5 * (1 - clamp01((Math.abs(r.local.x) - 1) / 6));

const pairCost = (b: Placed, r: Placed, state: PlayState): number => {
  const dx = Math.abs(b.local.x - r.local.x);
  // An interior lineman does not chase a blitzer outside the tackle box: that is the back's (or the tackle's) man.
  const interior = Math.abs(routeAlignment(b.a, state).x) < 2 && b.a.position !== 'OT';
  if (dx > (interior && !isLineman(r.a) ? INTERIOR_REACH_X : MAX_REACH_X)) return Infinity;
  return dx + 0.2 * Math.abs(b.local.y - r.local.y) - (b.a.ai.blockTargetId === r.a.id ? KEEP_BONUS : 0);
};

/**
 * Order-preserving matching of line blockers to rushers (both sorted by x) that minimises lateral travel plus the
 * cost of rushers left free: dp[i][j] = best plan for the first i blockers and first j rushers.
 */
const matchLine = (blockers: readonly Placed[], rushers: readonly Placed[], state: PlayState): Map<number, number> => {
  const nb = blockers.length;
  const nr = rushers.length;
  const dp: number[][] = Array.from({ length: nb + 1 }, () => new Array<number>(nr + 1).fill(Infinity));
  const how: number[][] = Array.from({ length: nb + 1 }, () => new Array<number>(nr + 1).fill(0));
  (dp[0] as number[])[0] = 0;
  for (let i = 0; i <= nb; i++) {
    for (let j = 0; j <= nr; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      let move = 0;
      if (i > 0 && (dp[i - 1] as number[])[j]! < best) { best = (dp[i - 1] as number[])[j]!; move = 1; }
      if (j > 0) {
        const c = (dp[i] as number[])[j - 1]! + leaveCost(rushers[j - 1] as Placed);
        if (c < best) { best = c; move = 2; }
      }
      if (i > 0 && j > 0) {
        const c = (dp[i - 1] as number[])[j - 1]! + pairCost(blockers[i - 1] as Placed, rushers[j - 1] as Placed, state);
        if (c < best) { best = c; move = 3; }
      }
      (dp[i] as number[])[j] = best;
      (how[i] as number[])[j] = move;
    }
  }
  const out = new Map<number, number>();
  let i = nb;
  let j = nr;
  while (i > 0 || j > 0) {
    const m = (how[i] as number[])[j];
    if (m === 1) i--;
    else if (m === 2) j--;
    else { out.set(i - 1, j - 1); i--; j--; }
  }
  return out;
};

/**
 * A rusher who is not locked up and is at least level with (or inside and past) the blocker assigned to him: the
 * block is not made, and a spare should be there for him.
 */
const gettingPast = (r: Placed, blocker: Athlete | undefined, state: PlayState): boolean => {
  if (!blocker || r.a.state === 'engaged') return false;
  const bl = toLocal(blocker.pos, state);
  return r.local.y < bl.y + 0.8 && Math.abs(r.local.x - bl.x) > 0.9;
};

/**
 * Global pass-protection plan, a pure function of the state so every blocker agrees (see the module doc). Blockers
 * already locked up keep their man; nobody else spends a body on him.
 */
export const passProtection = (state: PlayState): PassProtection => {
  const iq = clamp01(difficultyFor(state, state.ctx.offense).blockingIq);
  const all = state.athletes.filter((a) => a.side === 'offense' && a.active && isPassProtector(a, state));
  const assignment = new Map<AthleteId, AthleteId>();
  const held = new Set<AthleteId>();
  for (const b of all) {
    const d = engagedDefender(b, state);
    if (d && !held.has(d.id)) { assignment.set(b.id, d.id); held.add(d.id); }
  }
  const place = (a: Athlete): Placed => ({ a, local: toLocal(a.pos, state) });
  const byX = (p: Placed, q: Placed): number => p.local.x - q.local.x || p.a.id.localeCompare(q.a.id);
  const rushersAll = perceivedRushers(state, iq).map(place);
  const rushers = rushersAll.filter((r) => !held.has(r.a.id)).sort(byX);
  const openLine = all.filter((b) => !assignment.has(b.id) && isLineBlocker(b, state)).map(place).sort(byX);
  const match = matchLine(openLine, rushers, state);
  const taken = new Set<number>();
  for (const [bi, ri] of match) {
    assignment.set((openLine[bi] as Placed).a.id, (rushers[ri] as Placed).a.id);
    taken.add(ri);
  }
  // Backs pick up what the line left, most dangerous first.
  const qb = findQb(state);
  const qbPos = qb ? qb.pos : toField({ x: 0, y: -6 }, state);
  const leftover = rushers.filter((_, i) => !taken.has(i)).sort((p, q) => dist(p.a.pos, qbPos) - dist(q.a.pos, qbPos));
  const backs = all.filter((b) => !assignment.has(b.id) && !isLineBlocker(b, state));
  const free: AthleteId[] = [];
  for (const r of leftover) {
    let best: Athlete | null = null;
    let bs = 12;
    for (const b of backs) {
      if (assignment.has(b.id)) continue;
      const s = dist(b.pos, r.a.pos) - (b.ai.blockTargetId === r.a.id ? KEEP_BONUS : 0);
      if (s < bs) { bs = s; best = b; }
    }
    if (best) assignment.set(best.id, r.a.id);
    else free.push(r.a.id);
  }
  // Spare linemen help on the nearest rusher (inside first on a tie), and first of all on one who is getting past
  // the man who has him (a looper coming inside a tackle, a rusher not yet engaged who is level with his blocker).
  const help = new Map<AthleteId, AthleteId>();
  const blockerOf = new Map<AthleteId, Athlete>();
  for (const b of all) { const r = assignment.get(b.id); if (r) blockerOf.set(r, b); }
  const blocked = rushersAll.filter((r) => blockerOf.has(r.a.id));
  for (const b of openLine) {
    if (assignment.has(b.a.id)) continue;
    let best: Placed | null = null;
    let bs = 4;
    for (const r of blocked) {
      const s = Math.abs(r.local.x - b.local.x) + 0.1 * Math.abs(r.local.x) - (gettingPast(r, blockerOf.get(r.a.id), state) ? 2.5 : 0);
      if (s < bs) { bs = s; best = r; }
    }
    if (best) help.set(b.a.id, best.a.id);
  }
  const count = (xs: readonly Placed[], sign: number): number => xs.filter((x) => Math.sign(x.local.x) === sign).length;
  const lineAll = all.filter((b) => isLineBlocker(b, state)).map(place);
  const leftGap = count(rushersAll, -1) - count(lineAll, -1);
  const rightGap = count(rushersAll, 1) - count(lineAll, 1);
  const overloadSide: -1 | 0 | 1 = leftGap > 0 && leftGap >= rightGap ? -1 : rightGap > 0 ? 1 : 0;
  return { assignment, overloadSide, free, help };
};

