import { clamp, clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { angle, angleDiff, dist, sub } from '@/core/vec2';
import type { AthleteIntent } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { isDeepZone, zoneDropPoint, zoneLandmark, type ZoneLandmark } from '@/playbook/zones';
import type { ZoneName } from '@/playbook/types';
import {
  clampPoint, defenderJitter, depthOf, faceToward, holdIntent, mem, presnapIntent, rf, seekIntent, engagedIntent, type Perception,
} from './defense-shared';
import { playBallIntent } from './coverage-man';
import { ballReachBonus, coverageEdge, deepCushionLoss, dropDepthScale, helpRotation, landmarkDrift, sinkReach, squatOffset } from './coverage-iq';
import { tackleIntent } from './tackling';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Zone coverage. Each defender drops to his landmark (underneath zones run/angle straight there, deep zones
 * backpedal first then open up), then pattern-matches: the deepest receiver threatening a deep zone, or the
 * receiver nearest the quarterback's eyes for an underneath zone (awareness decides how much the eyes matter).
 * Underneath players squat on a receiver settling in the zone and sink under one running through it. Deep
 * players are never beaten over the top: their depth is always the deepest threat plus a cushion. When the
 * ball is thrown into or near the zone the defender breaks on the landing point and plays it; after a catch
 * everybody rallies to the carrier. On a recognised run the underneath players fill toward the ball while the
 * deep players hold an alley until the carrier crosses the line.
 */

const ZONE_MARGIN = 2.5;

export interface ZoneThreat {
  athlete: Athlete;
  score: number;
}

/** True when a point is inside the zone box expanded by `margin` yards (depth band and lateral band). */
export const inZoneBox = (lm: ZoneLandmark, state: PlayState, pos: { x: number; y: number }, margin = ZONE_MARGIN): boolean => {
  const depth = depthOf(state, pos);
  return Math.abs(pos.x - lm.center.x) <= lm.halfWidth + margin && depth >= lm.depthMin - margin && depth <= lm.depthMax + margin + 1;
};

/** True when a point sits in front of (shallower than) an underneath zone, inside its lateral band. */
const underZone = (lm: ZoneLandmark, state: PlayState, pos: { x: number; y: number }): boolean => {
  const depth = depthOf(state, pos);
  return Math.abs(pos.x - lm.center.x) <= lm.halfWidth + 1 && depth >= 0 && depth < lm.depthMin;
};

/** 0..1 how squarely the QB is looking at a receiver (1 = dead on). */
const eyesOn = (qb: Athlete | null, r: Athlete): number => {
  if (!qb) return 0.5;
  const a = angle(sub(r.pos, qb.pos));
  return clamp01(1 - Math.abs(angleDiff(qb.facing, a)) / (Math.PI / 2));
};

/**
 * The receiver this zone should be most worried about: for deep zones the deepest one in (or entering) the
 * lateral band; for underneath zones the one in the box nearest to the landmark, weighted toward where the QB
 * is looking in proportion to the defender's awareness. Null when nobody threatens the zone.
 */
export const zoneThreat = (athlete: Athlete, state: PlayState, p: Perception, zone: ZoneName): ZoneThreat | null => {
  const lm = zoneLandmark(zone, state.losY, state.ctx.direction);
  const deep = isDeepZone(zone);
  const dir = state.ctx.direction;
  const aware = rf(athlete.attrs.awareness);
  let best: ZoneThreat | null = null;
  for (const r of p.view.receivers) {
    if (r.state === 'blocking' || r.state === 'engaged') continue;
    const ahead = { x: r.pos.x + r.vel.x * 0.6, y: r.pos.y + r.vel.y * 0.6 };
    const depth = depthOf(state, r.pos);
    let score: number;
    if (deep) {
      const lateral = Math.abs(ahead.x - lm.center.x) <= lm.halfWidth + 3 || Math.abs(r.pos.x - lm.center.x) <= lm.halfWidth + 3;
      const vertical = dir * r.vel.y;
      if (!lateral || (depth < 4 && vertical < 2)) continue;
      score = depth + vertical * 0.8 + 3 * eyesOn(p.view.qb, r) * aware;
    } else {
      // Underneath defenders also wall a receiver crossing UNDER their zone (a drag at 3-4 yd): he is theirs to
      // collision and drive on, not a free release between the flat and the hook.
      if (!inZoneBox(lm, state, r.pos) && !inZoneBox(lm, state, ahead) && !underZone(lm, state, r.pos)) continue;
      const d = dist(ahead, lm.center);
      score = 20 - d + 8 * eyesOn(p.view.qb, r) * (0.3 + 0.7 * aware);
    }
    if (!best || score > best.score) best = { athlete: r, score };
  }
  return best;
};

/** Underneath zone drop / squat / sink position. */
const underneathSpot = (athlete: Athlete, state: PlayState, p: Perception, lm: ZoneLandmark, threat: Athlete | null): { aim: { x: number; y: number }; label: string } => {
  const dir = state.ctx.direction;
  const qb = p.view.qb;
  const drop = disciplinedDrop(athlete, state, zoneOf(athlete));
  const e = coverageEdge(difficultyFor(state, athlete));
  if (threat) {
    const toQb = qb ? sub(qb.pos, threat.pos) : { x: 0, y: -dir };
    const l = Math.hypot(toQb.x, toQb.y) || 1;
    // How tight he squats on the route is a decision (coverage-iq): soft at rookie, squeezing the window at legend.
    const off = squatOffset(e);
    const aim = { x: threat.pos.x + threat.vel.x * 0.2 + (toQb.x / l) * off, y: threat.pos.y + threat.vel.y * 0.2 + (toQb.y / l) * off };
    const box = { x: clamp(aim.x, lm.center.x - lm.halfWidth - 3, lm.center.x + lm.halfWidth + 3), y: aim.y };
    const depth = clamp(depthOf(state, box), lm.depthMin - 2, lm.depthMax + 3);
    return { aim: { x: box.x, y: state.losY + dir * depth }, label: `squat ${threat.role}` };
  }
  let sink = false;
  for (const r of p.view.receivers) {
    if (Math.abs(r.pos.x - lm.center.x) > lm.halfWidth + 2) continue;
    const depth = depthOf(state, r.pos);
    // How early he sinks under a vertical is a read (coverage-iq): a legend one carries it from shorter.
    if (depth > lm.depthMax - sinkReach(e) && dir * r.vel.y > 2 && depth < lm.depthMax + 8) sink = true;
  }
  const eyesShift = qb ? Math.cos(qb.facing) * 1.5 * rf(athlete.attrs.awareness) : 0;
  const aim = { x: drop.x + eyesShift, y: sink ? state.losY + dir * (lm.depthMax + 1) : drop.y };
  return { aim, label: sink ? 'sink' : 'settle' };
};

/** Deep zone position: over the top of the deepest threat, shading toward him, never shallower than him. */
const deepSpot = (athlete: Athlete, state: PlayState, p: Perception, lm: ZoneLandmark, threat: Athlete | null): { aim: { x: number; y: number }; label: string } => {
  const dir = state.ctx.direction;
  const drop = disciplinedDrop(athlete, state, zoneOf(athlete));
  const e = coverageEdge(difficultyFor(state, athlete));
  if (!threat) {
    const help = helpRotation(e) > 0 ? helpTarget(athlete, state, p, lm) : null;
    if (!help) return { aim: drop, label: 'deep drop' };
    // Safety help (coverage-iq): nothing in my band, so rotate over the deepest vertical outside it.
    const k = helpRotation(e);
    const depth = Math.max(depthOf(state, drop), depthOf(state, help.pos) + 4);
    return { aim: { x: drop.x + (help.pos.x - drop.x) * k, y: state.losY + dir * depth }, label: `help over ${help.role}` };
  }
  const cushion = clamp(4 + 2 * (rf(threat.attrs.speed) - rf(athlete.attrs.speed)) + defenderJitter(athlete, 'deepCushion', 0.4), 2.5, 6.5) - deepCushionLoss(e);
  const threatDepth = depthOf(state, threat.pos) + dir * threat.vel.y * 0.3;
  // Never capped by the zone's nominal depth: a go route past 35 yd is still carried over the top (the caller
  // clamps the point inside the field, so the back of the end zone is the only limit).
  const depth = Math.max(threatDepth + cushion, lm.depthMin - 1);
  const x = clamp(lm.center.x + (threat.pos.x - lm.center.x) * 0.7, lm.center.x - lm.halfWidth - 2, lm.center.x + lm.halfWidth + 2);
  return { aim: { x, y: state.losY + dir * depth }, label: `over the top ${threat.role}` };
};

/** The deepest vertical receiver outside this deep defender's band (a help candidate), or null. */
const helpTarget = (athlete: Athlete, state: PlayState, p: Perception, lm: ZoneLandmark): Athlete | null => {
  const dir = state.ctx.direction;
  let best: Athlete | null = null;
  let bestDepth = 8;
  for (const r of p.view.receivers) {
    if (r.state === 'blocking' || r.state === 'engaged') continue;
    const depth = depthOf(state, r.pos);
    if (dir * r.vel.y < 3 || depth <= bestDepth || Math.abs(r.pos.x - lm.center.x) <= lm.halfWidth + 3) continue;
    if (Math.abs(r.pos.x - athlete.pos.x) > 20) continue;
    best = r;
    bestDepth = depth;
  }
  return best;
};

/** The zone named by an athlete's assignment (middleHook when none). */
export const zoneOf = (athlete: Athlete): ZoneName => {
  const a = athlete.assignment;
  return 'zone' in a && a.zone ? a.zone : 'middleHook';
};

/**
 * The drop point this defender actually plays (coverage-iq): the zone's landmark, with a rookie-level defender's
 * underneath drop bailing too deep (dropDepthScale) and his spot drifting off the landmark (landmarkDrift); from pro
 * up he drops to the landmark itself.
 */
export const disciplinedDrop = (athlete: Athlete, state: PlayState, zone: ZoneName): { x: number; y: number } => {
  const dir = state.ctx.direction;
  const drop = zoneDropPoint(zone, state.losY, dir);
  const e = coverageEdge(difficultyFor(state, athlete));
  if (e === 0) return drop;
  const depth = depthOf(state, drop) * (isDeepZone(zone) ? 1 : dropDepthScale(e));
  return clampPoint({ x: drop.x + landmarkDrift(athlete, e), y: state.losY + dir * depth }, 0.5);
};

/** Fill / contain reaction of a zone defender to a recognised run. */
const zoneRunIntent = (athlete: Athlete, state: PlayState, zone: ZoneName, carrier: Athlete, flowX = 0): AthleteIntent => {
  const dir = state.ctx.direction;
  const wide = zone.startsWith('flat') || zone.startsWith('curlFlat');
  // The quarterback still in the backfield with the ball is about to hand it off: fill the line on the side the play
  // is flowing to instead of chasing him five yards deep (that is how the back meets nobody at the line).
  if (carrier.position === 'QB' && depthOf(state, carrier.pos) < -0.5 && !isDeepZone(zone)) {
    const lean = Math.abs(flowX) > 1 ? Math.sign(flowX) * 2.5 : 0;
    const spot = clampPoint({ x: carrier.pos.x + carrier.vel.x * 0.4 + dir * lean, y: state.losY + dir * 1.0 }, 0.5);
    return seekIntent(athlete, spot, { sprint: dist(athlete.pos, spot) > 3, stopRadius: 0.4, debug: 'fill on the mesh' });
  }
  if (!isDeepZone(zone)) return tackleIntent(athlete, carrier, state, { leverage: wide ? 'outside' : 'inside' });
  if (depthOf(state, carrier.pos) > 1) return tackleIntent(athlete, carrier, state, { leverage: 'outside' });
  const holdDepth = 8 + 2 * defenderJitter(athlete, 'alley', 1);
  const aim = clampPoint({ x: carrier.pos.x + carrier.vel.x * 0.4, y: state.losY + dir * holdDepth }, 0.5);
  return seekIntent(athlete, aim, { locomotion: 'strafe', face: faceToward(athlete.pos, carrier.pos), effort: 0.9, stopRadius: 0.3, debug: 'alley' });
};

/** Play or rally on a thrown ball from a zone. */
const zoneBallIntent = (athlete: Athlete, state: PlayState, p: Perception, lm: ZoneLandmark): AthleteIntent => {
  const landing = p.landing ?? state.ball.pos;
  const target = state.ball.targetId ? p.view.receivers.find((r) => r.id === state.ball.targetId) ?? null : null;
  // How far he goes to play a ball thrown away from him is a read (coverage-iq).
  const reach = ballReachBonus(coverageEdge(difficultyFor(state, athlete)));
  const near = inZoneBox(lm, state, landing, Math.max(1, 4 + reach)) || dist(landing, athlete.pos) < 7 + reach;
  if (near) return playBallIntent(athlete, state, p, target);
  const tLand = p.landingTicks * TICK_DT;
  const rallyTo = target ? { x: target.pos.x + target.vel.x * (tLand + 0.3), y: target.pos.y + target.vel.y * (tLand + 0.3) } : landing;
  return seekIntent(athlete, clampPoint(rallyTo, 0.3), { sprint: true, effort: 0.9, debug: 'rally' });
};

/** Zone coverage intent for a given zone (exported for run-fill pass drops and match coverage). */
export const zoneCoverIntent = (athlete: Athlete, state: PlayState, p: Perception, zone: ZoneName): AthleteIntent => {
  const dir = state.ctx.direction;
  const lm = zoneLandmark(zone, state.losY, dir);
  const deep = isDeepZone(zone);
  if (state.phase !== 'live') return presnapIntent(athlete, state, `zone ${zone}`);
  if (athlete.state === 'engaged') return engagedIntent(athlete, state, p, zoneDropPoint(zone, state.losY, dir), 'shed');
  const c = p.carrier;
  if (c && c.position !== 'QB') return state.ball.kind === 'pass' ? tackleIntent(athlete, c, state, { leverage: 'inside' }) : zoneRunIntent(athlete, state, zone, c);
  if (c && c.position === 'QB' && p.view.qbDepth > -0.3) return tackleIntent(athlete, c, state, { leverage: deep ? 'outside' : 'inside' });
  if (p.view.ballInAir && p.passSeen) return zoneBallIntent(athlete, state, p, lm);
  // The run is read from the line and the backs, not from spotting the carrier: once recognised the fill happens
  // on whoever the team view says has the ball (waiting for the personal carrier read is a zone drop into nowhere).
  const runCarrier = c ?? (p.recognizedRun ? p.view.carrier : null);
  if (p.recognizedRun && !p.view.ballInAir && runCarrier && runCarrier.side === 'offense') return zoneRunIntent(athlete, state, zone, runCarrier, p.view.flowX);
  const threat = zoneThreat(athlete, state, p, zone);
  const s = athlete.ai.scratch;
  const drop = disciplinedDrop(athlete, state, zone);
  const arrived = mem(s, 'zoneArrived', 0) === 1 || dist(athlete.pos, drop) < 1.5;
  if (arrived) s.zoneArrived = 1;
  const qb = p.view.qb;
  const face = qb ? faceToward(athlete.pos, qb.pos) : faceToward(athlete.pos, state.ball.pos);
  athlete.ai.zoneCenter = lm.center;
  if (!arrived && !threat) {
    const d = dist(athlete.pos, drop);
    if (deep && p.t < 0.6) return seekIntent(athlete, drop, { locomotion: 'backpedal', face, debug: `zone ${zone} backpedal` });
    return seekIntent(athlete, drop, { sprint: d > 4, slowRadius: 2, debug: `zone ${zone} drop` });
  }
  const spot = deep ? deepSpot(athlete, state, p, lm, threat?.athlete ?? null) : underneathSpot(athlete, state, p, lm, threat?.athlete ?? null);
  const aim = clampPoint(spot.aim, 0.5);
  const d = dist(athlete.pos, aim);
  const away = dir * (aim.y - athlete.pos.y) > 0;
  const t = threat?.athlete ?? null;
  if (d < 0.35) return holdIntent(face, `zone ${zone} ${spot.label}`);
  if (deep && t) {
    // Bail: a vertical threat means turn and run for depth now (a late flip at speed is what gets corners beaten).
    const gap = depthOf(state, athlete.pos) - depthOf(state, t.pos);
    const vertical = dir * t.vel.y;
    if (vertical > 4 || gap < 7) return seekIntent(athlete, aim, { sprint: gap < 5, stopRadius: 0.3, debug: `zone ${zone} bail ${t.role}` });
    if (away && d < 6) return seekIntent(athlete, aim, { locomotion: 'backpedal', face: faceToward(athlete.pos, t.pos), stopRadius: 0.3, debug: `zone ${zone} ${spot.label}` });
  }
  if (d < 3 && !deep) return seekIntent(athlete, aim, { locomotion: 'strafe', face, stopRadius: 0.3, debug: `zone ${zone} ${spot.label}` });
  return seekIntent(athlete, aim, { sprint: d > 5, slowRadius: 1.5, stopRadius: 0.3, debug: `zone ${zone} ${spot.label}` });
};
