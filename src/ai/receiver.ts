import { clamp, clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { dist, normalize, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentDecider } from '@/game/engine-api';
import { ballCarrier } from '@/game/athlete';
import type { Athlete, PlayState } from '@/game/play-types';
import type { RouteDef } from '@/playbook/types';
import { CATCH_HEIGHT, predictLanding } from '@/physics/ball';
import { reachHeight } from '@/physics/contact';
import { maxSpeed } from '@/physics/speed';
import { carryIntent } from './ball-carrier';
import { CHIP_SECONDS, backBlitzCheckIntent, chipEdgeIntent, stalkBlockIntent } from './blocking';
import {
  assignedRouteId, athleteNoise, blendQuality, canPlay, chaseBallIntent, clampX, f, isQbScrambling, jitter, opponentsOf, routeById, runRoute,
  steerTo, timeSinceSnap,
} from './route-running';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Receiver deciders ('route' and 'chipRelease'). A receiver runs his route until the ball is thrown: at him he
 * tracks the landing point (high-pointing contested balls when he has the hands and strength for it, diving for
 * low ones, throttling back for underthrows, staying in bounds by SIDELINE_MARGIN); elsewhere he shields the
 * nearest defender near the landing spot (a ball thrown to open grass is chased by the receiver nearest it, see
 * breaksToSpot). After a catch he is a ball carrier; on runs he stalk blocks.
 */

/** Yards inside the sideline a receiver keeps his centre while tracking a ball. */
export const SIDELINE_MARGIN = 0.3;

/** Seconds a receiver keeps running his route before he reacts to a ball thrown at him. */
export const throwReaction = (athlete: Athlete, state: PlayState): number =>
  0.5 * Math.max(0, difficultyFor(state, athlete).aiReactionDelay) * (1.4 - 0.8 * f(athlete.attrs.reaction)) * (0.85 + 0.3 * athleteNoise(athlete, 'react'));

export interface BallTrack {
  /** Where the receiver should be to gather the ball at catch height (adjusted for his judgement, in bounds). */
  landing: Vec2;
  /** Seconds until the ball is there. */
  arrival: number;
  /** Where the ball can be high-pointed at the top of his reach (null when it never gets that high). */
  high: Vec2 | null;
  highArrival: number;
  /** Where the ball drops to knee height (for diving catches). */
  low: Vec2;
  lowArrival: number;
  contested: boolean;
  /** 0..1 willingness to attack a contested ball (hands + strength). */
  aggression: number;
}

/** Where a receiver believes a thrown ball is coming down; receiverIntelligence tightens the estimate. */
export const trackBall = (athlete: Athlete, state: PlayState): BallTrack => {
  const ball = state.ball;
  const w = state.ctx.weather;
  const iq = blendQuality(athlete, difficultyFor(state, athlete).receiverIntelligence);
  const land = predictLanding(ball, w, CATCH_HEIGHT);
  const arrival = land.ticks * TICK_DT;
  const errAmp = (1 - iq) * 1.5 * clamp01(arrival / 1.2);
  const salt = `trk${ball.launchTick}`;
  const landing = { x: clampX(land.pos.x + jitter(athlete, `${salt}x`, errAmp), SIDELINE_MARGIN), y: land.pos.y + jitter(athlete, `${salt}y`, errAmp) };
  const hi = predictLanding(ball, w, reachHeight(athlete) - 0.15);
  const lo = predictLanding(ball, w, 0.7);
  const contested = opponentsOf(athlete, state).some((d) => canPlay(d) && dist(d.pos, landing) < 2.5);
  const aggression = clamp01(0.5 * f(athlete.attrs.hands) + 0.5 * f(athlete.attrs.strength) + jitter(athlete, 'aggr', 0.1));
  return {
    landing, arrival, high: hi.reaches && hi.ticks > 0 ? hi.pos : null, highArrival: hi.ticks * TICK_DT,
    low: { x: clampX(lo.pos.x, SIDELINE_MARGIN), y: lo.pos.y }, lowArrival: lo.ticks * TICK_DT, contested, aggression,
  };
};

/** Get to a ball thrown at this receiver: track it, high-point, dive or throttle as the flight demands. */
export const trackThrowIntent = (athlete: Athlete, state: PlayState, dt: number, route: RouteDef | null): AthleteIntent => {
  const ball = state.ball;
  const sinceThrow = Math.max(0, (state.tick - ball.launchTick) * TICK_DT);
  if (route && sinceThrow < throwReaction(athlete, state)) return runRoute(athlete, state, dt, route);
  const tr = trackBall(athlete, state);
  const top = maxSpeed(athlete.attrs.speed);
  let spot = tr.landing;
  let goHigh = false;
  if (tr.high && (ball.throwType === 'highPoint' || (tr.contested && tr.aggression > 0.45))) {
    const dh = dist(athlete.pos, tr.high);
    if (dh / Math.max(0.05, tr.highArrival) <= top * 1.05) { spot = tr.high; goHigh = true; }
  }
  const d = dist(athlete.pos, spot);
  const tArr = goHigh ? tr.highArrival : tr.arrival;
  const need = tArr > 0.05 ? d / tArr : Infinity;
  const intent = steerTo(athlete.pos, spot, 1, need > top * 0.9, goHigh ? 'attack ball' : 'track ball');
  if (need < top * 0.5 && d > 0.05) intent.move = scale(normalize(sub(spot, athlete.pos)), clamp(need / top + 0.2, 0.3, 1));
  if (goHigh && d < 0.9 && tr.highArrival < 0.3 && athlete.state !== 'jumping') {
    intent.action = 'jump';
    intent.debug = 'high point';
  } else if (!goHigh && need > top * 1.05 && dist(athlete.pos, tr.low) <= 2.2 && tr.lowArrival < 0.45) {
    intent.action = 'dive';
    intent.move = normalize(sub(tr.low, athlete.pos));
    intent.debug = 'dive for it';
  }
  return intent;
};

/** Yards from the landing point inside which a receiver breaks for a pass thrown to a spot nobody was credited with. */
export const SPOT_BREAK_RADIUS = 16;

/** A route runner (this decider's men) still on his feet: the teammates who may break for a spot pass. */
const mayBreak = (a: Athlete): boolean =>
  a.active && a.eligible && (a.assignment.type === 'route' || a.assignment.type === 'chipRelease') && a.state !== 'down' && a.state !== 'tackled';

/**
 * A pass thrown to a spot with no receiver credited (the user's pull-back pass to open grass): the route runner
 * nearest the landing point breaks for it and attacks the catch (a man staying in to block never goes, so he never
 * keeps a receiver from going either). Never for throw-aways or tipped balls.
 */
export const breaksToSpot = (athlete: Athlete, state: PlayState): boolean => {
  const ball = state.ball;
  if (ball.kind !== 'pass' || ball.targetId !== null || ball.isTipped || ball.throwType === 'throwAway' || !mayBreak(athlete)) return false;
  const landing = predictLanding(ball, state.ctx.weather, CATCH_HEIGHT).pos;
  const mine = dist(athlete.pos, landing);
  if (mine > SPOT_BREAK_RADIUS) return false;
  return !state.athletes.some((o) => o.id !== athlete.id && o.side === athlete.side && o.id !== ball.throwerId && mayBreak(o) && dist(o.pos, landing) < mine);
};

/** Shared receiver behaviour for a concrete route id (null = no route: block). */
export const receiverIntent = (athlete: Athlete, state: PlayState, dt: number, routeId: string | undefined): AthleteIntent => {
  if (state.phase === 'presnap') return idleIntent('set');
  const chase = chaseBallIntent(athlete, state);
  if (chase) return chase;
  if (athlete.hasBall) return carryIntent(athlete, state, dt);
  // A back checks for a blitzer before he releases (and stays in on one he picked up).
  const check = backBlitzCheckIntent(athlete, state);
  if (check) return check;
  const ball = state.ball;
  const route = routeId ? routeById(routeId) : null;
  if (ball.phase === 'inAir' && ball.kind !== 'snap') {
    if (ball.targetId === athlete.id) return trackThrowIntent(athlete, state, dt, route);
    if (breaksToSpot(athlete, state)) return trackThrowIntent(athlete, state, dt, route);
    if (ball.kind === 'pass' || ball.kind === 'pitch' || ball.kind === 'lateral') {
      return stalkBlockIntent(athlete, state, predictLanding(ball, state.ctx.weather, CATCH_HEIGHT).pos, { engage: false });
    }
  }
  const carrier = ballCarrier(state);
  const preferDb = athlete.position === 'WR' || route?.type === 'block';
  if (carrier && carrier.side === 'offense' && carrier.assignment.type !== 'qb') return stalkBlockIntent(athlete, state, carrier.pos, { preferDb });
  if (!route) return stalkBlockIntent(athlete, state, carrier ? carrier.pos : ball.pos, { preferDb });
  if (route.type === 'block') {
    const done = athlete.ai.routeIndex >= route.waypoints.length || athlete.ai.routeTimer >= route.breakTime;
    if (done) return stalkBlockIntent(athlete, state, carrier ? carrier.pos : ball.pos, { preferDb: true });
    return runRoute(athlete, state, dt, route);
  }
  if (carrier && carrier.assignment.type === 'qb' && carrier.ai.scratch.keep === 1) return stalkBlockIntent(athlete, state, carrier.pos);
  return runRoute(athlete, state, dt, route, { qbScrambling: isQbScrambling(state) });
};

/** Decider for assignment 'route'. */
export const decideRoute: IntentDecider = (athlete, state, dt) =>
  receiverIntent(athlete, state, dt, assignedRouteId(athlete));

/** Decider for assignment 'chipRelease': chip the edge rusher for CHIP_SECONDS, then run the release route. */
export const decideChipRelease: IntentDecider = (athlete, state, dt) => {
  if (state.phase === 'presnap') return idleIntent('set');
  const chase = chaseBallIntent(athlete, state);
  if (chase) return chase;
  if (athlete.hasBall) return carryIntent(athlete, state, dt);
  const ball = state.ball;
  const qbHolds = ball.phase === 'held' || ball.phase === 'snap' || (ball.phase === 'inAir' && ball.kind === 'snap');
  if (qbHolds && timeSinceSnap(state) < CHIP_SECONDS) {
    const chip = chipEdgeIntent(athlete, state);
    if (chip) return chip;
  }
  return receiverIntent(athlete, state, dt, assignedRouteId(athlete));
};
