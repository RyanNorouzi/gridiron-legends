import { clamp } from '@/core/math';
import { angle, dist, sub, type Vec2 } from '@/core/vec2';
import type { AthleteIntent } from '@/game/engine-api';
import { findAthlete } from '@/game/athlete';
import type { AthleteId } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import {
  arriveAt, blendQuality, canPlay, downfieldAngle, findQb, opponentsOf, routeAlignment, steerTo, timeSinceSnap, toField, toLocal,
} from './route-running';
import { engageIntent, isLineman, isPassProtector, isRusherByAssignment } from './blocking-core';
import { isLineBlocker, passProtection, type PassProtection } from './pass-protection';
import { difficultyFor } from '@/game/difficulty-sides';

export { passProtection, perceivedRushers, type PassProtection } from './pass-protection';

/**
 * Pass protection. One pure, state-derived plan that every blocker agrees on:
 *  - the line (linemen and in-line tight ends) is matched to the rushers WITHOUT crossing (an order-preserving
 *    assignment over play-local x), so nobody runs across a teammate's face to block the wrong man, twists and
 *    stunts are handed off by position, and a late blitzer re-plans the slide;
 *  - backs in protection pick up whoever the line leaves free, most dangerous (closest to the passer) first;
 *  - a lineman with nobody to block helps: he sits between the nearest rusher and the passer, ready to take him the
 *    moment he comes off his block, while still scanning for a late blitzer.
 * Blockers set before they punch: tackles kick-slide back and out to meet the edge rusher, guards and the centre
 * set square, each mirroring his man at set depth until the rusher arrives, then engaging on the line between the
 * rusher and the passer.
 */

/** Seconds a chip blocker stays on the edge rusher before releasing. */
export const CHIP_SECONDS = 0.6;
/** Yards a tackle kicks back from his stance (vertical set); guards and the centre set shallower. */
export const TACKLE_SET_DEPTH = 2.4;
export const INTERIOR_SET_DEPTH = 1.3;
/** Play-local set point: tackles kick back and out, interior linemen set square and shallower. */
export const passSetLocal = (athlete: Athlete, state: PlayState): Vec2 => {
  const align = routeAlignment(athlete, state);
  // Kick protection holds the line (step and anchor): giving ground only walks the rush into the kick.
  if (state.ctx.special !== 'none' && state.ctx.special !== 'twoPoint') return { x: align.x, y: align.y - 0.5 };
  const isTackle = athlete.position === 'OT' || Math.abs(align.x) > 2;
  const side = Math.sign(align.x);
  return isTackle
    ? { x: align.x + side * 0.8, y: align.y - TACKLE_SET_DEPTH }
    : { x: align.x + side * 0.15, y: align.y - INTERIOR_SET_DEPTH };
};

/**
 * ai.scratch key the human quarterback's automatic drop (game/user-control.ts) sets once the drop is his own (he
 * reached the top of it, or steered himself): until then the protection sets for the called drop.
 */
export const USER_DROP_DONE_KEY = 'userDropDone';

/** Yards a pass set stays in front of the passer, and how far ahead (seconds) his drop is anticipated. */
const PASSER_CUSHION = 2.2;
const DROP_LOOKAHEAD = 0.5;

/**
 * Play-local depth a pass set may not retreat past: a cushion in front of the passer (for a lineman never upfield of
 * his own stance). An AI passer's drop is known from the call, so the line kicks to its set at the snap and is only
 * held in front of him once he is deep; a human passer's drop is read from his feet (where he will be a moment from
 * now), so one who stays at the snap spot (aiming a pull-back throw from under centre, say) keeps his line in front
 * of him instead of it backing into his lap. No passer (kick protection): no limit.
 */
export const passSetFloor = (athlete: Athlete, state: PlayState, passer: Athlete | null): number => {
  if (!passer) return -Infinity;
  const ql = toLocal(passer.pos, state);
  // A human passer still in his automatic drop (game/user-control.ts autoDrop) is going where the call says.
  const autoDropping = passer.controlled && passer.ai.scratch[USER_DROP_DONE_KEY] !== 1;
  if (!passer.controlled || autoDropping) return ql.y < -4 ? ql.y + PASSER_CUSHION : -Infinity;
  const back = Math.min(0, state.ctx.direction * passer.vel.y) * DROP_LOOKAHEAD;
  // A lineman never sets upfield of his stance; a back may step up to the line to meet a blitzer.
  const align = routeAlignment(athlete, state);
  const cap = isLineBlocker(athlete, state) ? align.y : -1;
  const floor = Math.min(cap, ql.y + back + PASSER_CUSHION);
  // A tackle is wide of the passer, never in his lap: he always gets his kick-slide to meet the edge rusher, however
  // shallow the passer stands (a human aiming from under centre), or the end loops round him untouched.
  const tackle = athlete.position === 'OT' || Math.abs(align.x) > 2;
  return tackle && isLineBlocker(athlete, state) ? Math.min(floor, align.y - TACKLE_MIN_KICK) : floor;
};

/** Yards behind his stance a tackle may always kick-slide, whatever the passer's depth. */
export const TACKLE_MIN_KICK = 1.6;
/** A rusher nobody has locked up within this many yards of the passer is a spare lineman's first job. */
export const LOOSE_RUSHER_YARDS = 4;

/**
 * A rusher running loose at the passer (not engaged, inside LOOSE_RUSHER_YARDS of him, behind the line) that this
 * spare blocker is better placed to take than whoever has him, or null: an end looping round a tackle, a stunt the
 * line lost. The spare meets him instead of shuffling beside a pair that is already blocked.
 */
const looseRusherFor = (athlete: Athlete, state: PlayState, prot: PassProtection, qb: Athlete | null): Athlete | null => {
  if (!qb || !qb.hasBall) return null;
  const owner = new Map<AthleteId, AthleteId>();
  for (const [bid, rid] of prot.assignment) owner.set(rid, bid);
  let best: Athlete | null = null;
  let bs = Infinity;
  for (const d of opponentsOf(athlete, state)) {
    if (!canPlay(d) || d.state === 'engaged' || toLocal(d.pos, state).y > 0) continue;
    const dq = dist(d.pos, qb.pos);
    if (dq > LOOSE_RUSHER_YARDS || dist(athlete.pos, d.pos) > 5) continue;
    const bid = owner.get(d.id);
    const b = bid && bid !== athlete.id ? findAthlete(state, bid) : null;
    if (b && dist(b.pos, d.pos) <= dist(athlete.pos, d.pos)) continue;
    if (dq < bs) { bs = dq; best = d; }
  }
  return best;
};

/** Shuffle (strafe) toward a spot, eyes on `look`: the pass-set footwork. */
const shuffle = (athlete: Athlete, to: Vec2, look: number, debug: string): AthleteIntent => {
  const intent = arriveAt(athlete.pos, to, 0.6, 1, false, debug);
  intent.locomotion = 'strafe';
  intent.face = look;
  return intent;
};

/**
 * Take on an assigned rusher: until he arrives, mirror him at set depth (inside-out leverage, never upfield of the
 * set, never back into the passer); once he is on top of the set, engage on the line between him and the passer.
 */
const takeRusher = (athlete: Athlete, rusher: Athlete, state: PlayState, protect: Vec2, floor: number, label: string): AthleteIntent => {
  const set = passSetLocal(athlete, state);
  const me = toLocal(athlete.pos, state);
  const rl = toLocal(rusher.pos, state);
  const d = dist(athlete.pos, rusher.pos);
  if (athlete.engagedWith !== rusher.id && rl.y > me.y + 1.5 && d > 1.6) {
    const align = routeAlignment(athlete, state);
    const side = Math.sign(align.x);
    // Mirror where he is going (a quarter second ahead), inside-out, but only across my own zone: an interior man
    // holds his gap and lets a looper come to him, a tackle may kick out wide for the edge.
    const lead = toLocal({ x: rusher.pos.x + rusher.vel.x * 0.25, y: rusher.pos.y + rusher.vel.y * 0.25 }, state);
    const tackle = Math.abs(set.x - align.x) > 0.5;
    const lo = tackle ? Math.min(align.x - side * 1.8, set.x + side * 2.5) : align.x - 1.2;
    const hi = tackle ? Math.max(align.x - side * 1.8, set.x + side * 2.5) : align.x + 1.2;
    const x = clamp(lead.x - side * 0.25, lo, hi);
    // Never retreat into the passer (passSetFloor: the set follows his drop, it does not run ahead of it).
    const y = Math.max(set.y, floor);
    const intent = shuffle(athlete, toField({ x, y }, state), angle(sub(rusher.pos, athlete.pos)), `${label}: set`);
    athlete.ai.blockTargetId = rusher.id;
    return intent;
  }
  // A blitzer running free at the passer is met in his path (a couple of yards in front of the passer), not chased.
  if (athlete.engagedWith !== rusher.id && !isLineman(rusher) && d > 2.5) return pickupIntent(athlete, rusher, state);
  const intent = engageIntent(athlete, rusher, protect, label);
  intent.sprint = false;
  if (d < 2.5) {
    intent.locomotion = 'strafe';
    intent.face = angle(sub(rusher.pos, athlete.pos));
  }
  return intent;
};

/** Seconds the play-action back spends carrying out the fake (riding the mesh) before he turns to protect. */
export const PLAY_FAKE_SECONDS = 0.6;

/**
 * The back the play action fakes to sells it first: he runs his path through the passer's mesh point (the passer
 * pulls the ball back out), then picks up. Null outside that window.
 */
const playFakeIntent = (athlete: Athlete, state: PlayState, qb: Athlete | null, T: number): AthleteIntent | null => {
  const play = state.ctx.offensivePlay;
  if (play.type !== 'playAction' || !qb || play.fakeTo !== athlete.role || T >= PLAY_FAKE_SECONDS) return null;
  const ql = toLocal(qb.pos, state);
  const side = Math.sign(routeAlignment(athlete, state).x - ql.x) || 1;
  athlete.ai.blockTargetId = null;
  return steerTo(athlete.pos, toField({ x: ql.x + side * 0.6, y: ql.y + 0.4 }, state), 1, false, 'play fake: mesh');
};

/** Pass block: set, take the assigned rusher, help a neighbour, pick up a late blitzer, never block air. */
export const passBlockIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const sc = athlete.ai.scratch;
  const T = timeSinceSnap(state);
  const qb = findQb(state);
  const fake = playFakeIntent(athlete, state, qb, T);
  if (fake) return fake;
  const iq = blendQuality(athlete, difficultyFor(state, athlete).blockingIq);
  const prot = passProtection(state);
  const floor = passSetFloor(athlete, state, qb);
  const set0 = passSetLocal(athlete, state);
  const setLocal = { x: set0.x, y: Math.max(set0.y, floor) };
  const protect = qb ? qb.pos : toField({ x: 0, y: -6 }, state);
  const rusherId = prot.assignment.get(athlete.id);
  let rusher = rusherId ? findAthlete(state, rusherId) : null;
  // A blitzer takes a beat to recognise (less for a sharp blocker); a down lineman never does.
  if (rusher && !isLineman(rusher) && athlete.engagedWith !== rusher.id) {
    const key = `blitzSeen:${rusher.id}`;
    const seen = sc[key] ?? T;
    sc[key] = seen;
    if (T - seen < (1 - iq) * 0.35) rusher = null;
  }
  if (rusher) return takeRusher(athlete, rusher, state, protect, floor, `pass block ${rusher.role}`);
  const loose = isLineBlocker(athlete, state) && T >= 0.3 ? looseRusherFor(athlete, state, prot, qb) : null;
  if (loose) {
    athlete.ai.blockTargetId = loose.id;
    const intent = engageIntent(athlete, loose, protect, `pass block: loose ${loose.role}`);
    intent.sprint = false;
    return intent;
  }
  const helpId = prot.help.get(athlete.id);
  const helpOn = helpId ? findAthlete(state, helpId) : null;
  if (helpOn && T >= 0.3) {
    // Sit a step inside and behind the pair, between the rusher and the passer: take him if he comes free.
    const rl = toLocal(helpOn.pos, state);
    const ql = toLocal(protect, state);
    const me = toLocal(athlete.pos, state);
    const toward = Math.sign(me.x - rl.x) || -Math.sign(rl.x) || 1;
    const spot = { x: rl.x + toward * 0.9 + (ql.x - rl.x) * 0.2, y: Math.max(Math.min(rl.y - 1.3, setLocal.y), floor) };
    const intent = shuffle(athlete, toField(spot, state), angle(sub(helpOn.pos, athlete.pos)), `pass block: help ${helpOn.role}`);
    athlete.ai.blockTargetId = helpOn.id;
    if (helpOn.state !== 'engaged' && dist(athlete.pos, helpOn.pos) < 2.2) {
      intent.action = 'block';
      intent.targetId = helpOn.id;
    }
    return intent;
  }
  athlete.ai.blockTargetId = null;
  if (!isLineBlocker(athlete, state)) return backCheckIntent(athlete, state);
  const hold = prot.overloadSide === 0 ? setLocal : { x: setLocal.x + prot.overloadSide * 1.6, y: setLocal.y };
  return shuffle(athlete, toField(hold, state), downfieldAngle(state), prot.overloadSide === 0 ? 'pass set' : 'pass block: slide');
};

/** A back in protection who has nobody: stay at the passer's side, eyes up, ready for a late blitzer. */
export const backCheckIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const qb = findQb(state);
  const ql = qb ? toLocal(qb.pos, state) : { x: 0, y: -5 };
  const align = routeAlignment(athlete, state);
  const side = Math.sign(align.x - ql.x) || 1;
  return shuffle(athlete, toField({ x: ql.x + side * 1.2, y: ql.y + 1.2 }, state), downfieldAngle(state), 'protect: check');
};

/**
 * A free rusher for this back to pick up (blitz pickup / check-release): the most dangerous rusher the protection
 * left free within 12 yards of him (he steps up into the blitzer's path as it comes), or null. Used by backs and chip-release blockers before they release.
 */
export const freeRusherFor = (athlete: Athlete, state: PlayState): Athlete | null => {
  const qb = findQb(state);
  if (!qb || !qb.hasBall) return null;
  const prot = passProtection(state);
  let best: Athlete | null = null;
  let bs = Infinity;
  for (const id of [...prot.free, ...outsideInterior(prot, state)]) {
    const r = findAthlete(state, id);
    if (!r || !canPlay(r) || r.state === 'engaged' || dist(r.pos, athlete.pos) > 12) continue;
    const s = dist(r.pos, qb.pos);
    if (s < bs) { bs = s; best = r; }
  }
  return best;
};

/**
 * Blitzers (not down linemen) handed to a guard or the centre who is not on him while he runs more than 2 yd outside
 * that lineman: an interior man cannot kick out and catch an edge blitzer, so a checking back takes him.
 */
const outsideInterior = (prot: PassProtection, state: PlayState): AthleteId[] => [...prot.assignment].filter(([bid, rid]) => {
  const b = findAthlete(state, bid);
  const r = findAthlete(state, rid);
  if (!b || !r || isLineman(r) || b.engagedWith === r.id || b.position === 'OT' || Math.abs(routeAlignment(b, state).x) >= 2) return false;
  const [bx, rx] = [toLocal(b.pos, state).x, toLocal(r.pos, state).x];
  return Math.abs(rx) > Math.abs(bx) && Math.abs(rx - bx) > 2;
}).map(([, rid]) => rid);

/**
 * Blitz pickup intent for a back (null when nobody is free): meet the rusher in his path to the passer, a couple of
 * yards in front of the passer (or halfway, when the rusher is already close), squared up; punch once he gets there.
 */
export const blitzPickupIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  const r = freeRusherFor(athlete, state);
  return r ? pickupIntent(athlete, r, state) : null;
};

const pickupIntent = (athlete: Athlete, r: Athlete, state: PlayState): AthleteIntent => {
  const qb = findQb(state);
  // Meet him where the passer is going to be (a dropping passer is still coming back), not where he is now.
  const protect = qb ? { x: qb.pos.x + qb.vel.x * 0.6, y: qb.pos.y + qb.vel.y * 0.6 } : r.pos;
  const dR = dist(r.pos, protect);
  const u = dR > 1e-6 ? { x: (r.pos.x - protect.x) / dR, y: (r.pos.y - protect.y) / dR } : { x: 0, y: state.ctx.direction };
  const meet = Math.min(dR * 0.5, 2.5);
  let spot = { x: protect.x + u.x * meet, y: protect.y + u.y * meet };
  if (!isLineBlocker(athlete, state)) {
    // A back sits in the rusher's lane just in front of the passer (leaning to his side), not upfield of his arc.
    const q = toLocal(protect, state);
    const rl = toLocal({ x: r.pos.x + r.vel.x * 0.35, y: r.pos.y + r.vel.y * 0.35 }, state);
    spot = toField({ x: q.x + clamp((rl.x - q.x) * 0.6, -3, 3), y: q.y + clamp((rl.y - q.y) * 0.5, 0.8, 1.6) }, state);
  }
  athlete.ai.blockTargetId = r.id;
  const d = dist(athlete.pos, r.pos);
  if (d > 2.5 && dist(r.pos, spot) > 1.2) {
    const intent = arriveAt(athlete.pos, spot, 0.8, 1, dist(athlete.pos, spot) > 3, `pickup ${r.role}: meet`);
    intent.locomotion = 'strafe';
    intent.face = angle(sub(r.pos, athlete.pos));
    return intent;
  }
  const intent = { ...engageIntent(athlete, r, protect, `pickup ${r.role}`), sprint: false };
  if (d <= 1.5) { intent.action = 'block'; intent.targetId = r.id; }
  return intent;
};

/** Seconds after the snap a releasing back checks for a blitzer before he goes out on his route. */
export const BLITZ_CHECK_SECONDS = 1.4;
/** Seconds a back who read a blitzer stays in for him before giving up and releasing. */
export const PICKUP_HOLD_SECONDS = 2.6;

/**
 * A releasing back's blitz check (check-release): while the passer holds the ball, a back who has picked up a
 * blitzer stays on him, and in the first BLITZ_CHECK_SECONDS he steps up to take a rusher the line left free.
 * Null when there is nobody to pick up: he releases into his route.
 */
export const backBlitzCheckIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  if (athlete.position !== 'RB' && athlete.position !== 'FB') return null;
  if (state.ctx.offensivePlay.type !== 'pass' && state.ctx.offensivePlay.type !== 'playAction') return null;
  const qb = findQb(state);
  if (!qb || !qb.hasBall || state.ball.phase !== 'held') return null;
  const on = athlete.engagedWith ? findAthlete(state, athlete.engagedWith) : null;
  if (on && on.side !== athlete.side) return { ...engageIntent(athlete, on, qb.pos, `pickup ${on.role}: stay in`), sprint: false };
  const sc = athlete.ai.scratch;
  const T = timeSinceSnap(state);
  // Once he has read a blitzer he stays in (past the check window) for him, or for a crosser the line lets through.
  const committed = sc.pickupOf !== undefined && T < PICKUP_HOLD_SECONDS;
  if (T >= BLITZ_CHECK_SECONDS && !committed) return null;
  const free = freeRusherFor(athlete, state);
  // He stays on the man he read while that man is still coming, unless a free rusher is closer to the passer (a
  // linebacker who only stepped up with him in coverage is not worth a blitzer running free behind him).
  const kept = committed ? state.athletes[sc.pickupOf ?? -1] ?? null : null;
  const dQb = (a: Athlete): number => dist(a.pos, qb.pos);
  const coming = kept !== null && canPlay(kept) && kept.state !== 'engaged' && dQb(kept) < 14
    && (toLocal(kept.pos, state).y < -0.5 || (kept.vel.x * (qb.pos.x - kept.pos.x) + kept.vel.y * (qb.pos.y - kept.pos.y)) / Math.max(dQb(kept), 1e-6) > 1.5);
  const r = coming && kept && (!free || dQb(kept) <= dQb(free)) ? kept : free;
  // Against a blitz look (as many set to rush as the line has blockers) he checks at the passer's side first.
  if (!r) return T < BLITZ_CHECK_SECONDS && blitzLook(state) ? backCheckIntent(athlete, state) : null;
  sc.pickupOf = state.athletes.indexOf(r);
  return pickupIntent(athlete, r, state);
};

/** The defense has as many men set to rush as the offense has line blockers, or more (read from the alignment and the call). */
const blitzLook = (state: PlayState): boolean => {
  let rush = 0;
  let line = 0;
  for (const a of state.athletes) {
    if (!a.active) continue;
    if (a.side === 'defense' && isRusherByAssignment(a)) rush += 1;
    else if (a.side === 'offense' && isPassProtector(a, state) && isLineBlocker(a, state)) line += 1;
  }
  return rush >= line;
};

/**
 * Chip-release blocker: pick up a free blitzer first (a back stays in for him); otherwise a tight end chips the edge
 * rusher on his side. Null when there is nothing to do (release into the route).
 */
export const chipEdgeIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  const pickup = blitzPickupIntent(athlete, state);
  if (pickup) return pickup;
  if (athlete.position === 'RB' || athlete.position === 'FB') return null;
  const local = toLocal(athlete.pos, state);
  const side = Math.sign(local.x) || 1;
  let edge: Athlete | null = null;
  let bd = 6;
  for (const d of opponentsOf(athlete, state)) {
    if (!canPlay(d)) continue;
    const dl = toLocal(d.pos, state);
    if (dl.y > 3.5 || Math.abs(dl.x) < 1.5 || Math.sign(dl.x) !== side) continue;
    if (!(isLineman(d) || d.position === 'OLB' || isRusherByAssignment(d))) continue;
    const dd = dist(d.pos, athlete.pos);
    if (dd < bd) { bd = dd; edge = d; }
  }
  if (!edge) return null;
  const qb = findQb(state);
  const intent = engageIntent(athlete, edge, qb ? qb.pos : toField({ x: 0, y: -6 }, state), `chip ${edge.role}`);
  if (dist(athlete.pos, edge.pos) <= 1.3) {
    intent.action = 'block';
    intent.targetId = edge.id;
  }
  return intent;
};
