import { lerp } from '@/core/math';
import { dist, dot, len, sub } from '@/core/vec2';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { Gap, ZoneName } from '@/playbook/types';
import {
  clampPoint, commonIntent, defenderNoise, depthOf, faceToward, gapX, isBlocker, judgement, localX, perceive, presnapIntent, rf,
  seekIntent, engagedIntent, type Perception,
} from './defense-shared';
import { zoneCoverIntent } from './coverage-zone';
import { spyIntent } from './spy';
import { tackleIntent } from './tackling';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Run defense for linebackers and box safeties. Before the read the defender shuffles toward his gap; once the
 * OL and backs show flow he scrapes to the ball side; once the run is recognised he fills the gap the carrier is
 * choosing (blended with his assigned gap by how much he trusts his read), takes on or avoids lead blockers
 * according to the strength matchup, stays square until the carrier commits and then pursues inside-out. A
 * recognised pass sends him to a hook zone (or a QB spy when the call asks for it).
 */

const zoneForDrop = (athlete: Athlete, state: PlayState): ZoneName => {
  const a = athlete.assignment;
  if ('zone' in a && a.zone) return a.zone;
  const lx = localX(state, athlete.pos.x);
  return lx < -2.5 ? 'hookCurlLeft' : lx > 2.5 ? 'hookCurlRight' : 'middleHook';
};

/** Absolute point to fill: the carrier's projected lane blended with the assigned gap, just across the LOS. */
export const fillPoint = (athlete: Athlete, state: PlayState, p: Perception, gap: Gap | undefined, carrier: Athlete | null): { x: number; y: number } => {
  const dir = state.ctx.direction;
  const assignedX = gap ? gapX(state, gap) : state.ctx.ballX + dir * (localX(state, athlete.pos.x) >= 0 ? 1.9 : -1.9);
  let laneX = assignedX;
  if (carrier) {
    const vy = dir * carrier.vel.y;
    const depth = depthOf(state, carrier.pos);
    const tToLos = vy > 1 ? Math.max(0, -depth / vy) : 0.4;
    const projected = carrier.pos.x + carrier.vel.x * Math.min(tToLos, 1.0);
    const trust = judgement(athlete, difficultyFor(state, athlete).pursuitQuality, 'fill');
    laneX = lerp(assignedX, projected, 0.4 + 0.5 * trust);
  } else if (Math.abs(p.view.flowX) > 1.5) {
    laneX = assignedX + dir * Math.sign(p.view.flowX) * 1.5;
  }
  return clampPoint({ x: laneX, y: state.losY + dir * 1.2 }, 0.5);
};

/** The lead blocker between this defender and his aim point: within 2.2 yd, or 3 yd when he is closing on me. */
const leadBlocker = (athlete: Athlete, p: Perception, aim: { x: number; y: number }): Athlete | null => {
  const toAim = sub(aim, athlete.pos);
  const la = len(toAim) || 1;
  let best: Athlete | null = null;
  let bd = 3;
  for (const o of p.view.offense) {
    if (!o.active || o === p.view.carrier || o.hasBall) continue;
    const blocking = isBlocker(o) || o.state === 'blocking' || o.state === 'engaged';
    if (!blocking) continue;
    const to = sub(o.pos, athlete.pos);
    const d = len(to);
    if (d >= bd || d < 1e-6) continue;
    const closing = -dot(o.vel, to) / d > 1;
    if (d > 2.2 && !closing) continue;
    if (dot(to, toAim) / (d * la) < 0.2) continue;
    best = o;
    bd = d;
  }
  return best;
};

/** Adjust the aim for a lead blocker: attack his near shoulder when strong enough, otherwise slip around him. */
const handleBlocker = (athlete: Athlete, blocker: Athlete, aim: { x: number; y: number }, carrier: Athlete | null): { aim: { x: number; y: number }; label: string } => {
  const edge = rf(athlete.attrs.strength) + 0.05 - rf(blocker.attrs.strength) * (0.9 + 0.2 * defenderNoise(athlete, 'takeOn'));
  const side = carrier ? Math.sign(carrier.pos.x - blocker.pos.x) || 1 : Math.sign(aim.x - blocker.pos.x) || 1;
  if (edge >= 0) return { aim: { x: blocker.pos.x + side * 0.5, y: blocker.pos.y }, label: `take on ${blocker.role}` };
  const to = sub(blocker.pos, athlete.pos);
  const l = len(to) || 1;
  const perp = { x: -to.y / l, y: to.x / l };
  const sign = Math.sign(perp.x * side) || 1;
  return { aim: { x: aim.x + perp.x * sign * 1.5, y: aim.y + perp.y * sign * 1.5 }, label: `avoid ${blocker.role}` };
};

/** Run-fill intent for an assigned gap (exported for pass rushers who shed and fill on a recognised run). */
export const runFillIntent = (athlete: Athlete, state: PlayState, p: Perception, gap: Gap | undefined): AthleteIntent => {
  const view = p.view;
  if (state.phase !== 'live') return presnapIntent(athlete, state, `fill ${gap ?? 'box'}`);
  const c = p.carrier;
  if (athlete.state === 'engaged') return engagedIntent(athlete, state, p, fillPoint(athlete, state, p, gap, null), 'shed');
  if (c && c.position !== 'QB' && state.ball.kind === 'pass') return tackleIntent(athlete, c, state, { leverage: 'inside' });
  if (c && c.position === 'QB' && view.qbDepth > -0.3) return tackleIntent(athlete, c, state, { leverage: 'inside' });
  if (view.ballInAir && p.passSeen) {
    const landing = p.landing ?? state.ball.pos;
    return seekIntent(athlete, clampPoint(landing, 0.3), { sprint: true, effort: 0.9, debug: 'rally' });
  }
  if (p.recognizedPass && !p.recognizedRun) {
    if (state.ctx.defensivePlay.tags.includes('spy')) return spyIntent(athlete, state, p);
    return zoneCoverIntent(athlete, state, p, zoneForDrop(athlete, state));
  }
  const runCarrier = p.recognizedRun && c && c.position !== 'QB' ? c : null;
  if (runCarrier && (depthOf(state, runCarrier.pos) > 0.5 || dist(runCarrier.pos, athlete.pos) < 3)) {
    return tackleIntent(athlete, runCarrier, state, { leverage: 'inside' });
  }
  let aim = fillPoint(athlete, state, p, gap, runCarrier);
  let label = runCarrier ? `fill ${gap ?? 'lane'} on ${runCarrier.role}` : p.recognizedRun ? `fill ${gap ?? 'gap'}` : 'read keys';
  const blocker = leadBlocker(athlete, p, aim);
  if (blocker && (p.recognizedRun || dist(blocker.pos, athlete.pos) < 1.5)) {
    const h = handleBlocker(athlete, blocker, aim, runCarrier);
    aim = clampPoint(h.aim, 0.5);
    label = `${label} / ${h.label}`;
  }
  const d = dist(athlete.pos, aim);
  const ballSpot = c ? c.pos : state.ball.pos;
  const face = faceToward(athlete.pos, ballSpot);
  if (!p.recognizedRun) {
    const scrape = Math.abs(view.flowX) > 1.5 && p.t > p.reaction * 0.5;
    // Read the keys from his alignment depth, sliding with the flow: never a drift back (a linebacker who gives ground
    // on every snap meets the back two yards deeper than he lined up).
    return seekIntent(athlete, { x: aim.x, y: athlete.pos.y }, { locomotion: 'strafe', face, effort: scrape ? 0.75 : 0.45, stopRadius: 0.3, debug: scrape ? 'scrape' : label });
  }
  const square = d < 2.5 && runCarrier !== null && dist(runCarrier.pos, athlete.pos) > 4 && depthOf(state, runCarrier.pos) < 0;
  if (square) return seekIntent(athlete, aim, { locomotion: 'strafe', face, stopRadius: 0.3, debug: `${label} (square)` });
  return seekIntent(athlete, aim, { sprint: d > 3, stopRadius: 0.3, debug: label });
};

/** 'defense:runFill' decider. */
export const decideRunFill: IntentDecider = (athlete, state) => {
  const p = perceive(athlete, state);
  const common = commonIntent(athlete, state, p.view);
  if (common) return common;
  const a = athlete.assignment;
  return runFillIntent(athlete, state, p, 'gap' in a ? a.gap : undefined);
};
