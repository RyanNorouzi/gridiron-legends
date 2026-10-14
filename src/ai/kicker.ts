import { clamp } from '@/core/math';
import { secondsToTicks } from '@/core/time';
import { add, dist, type Vec2 } from '@/core/vec2';
import { ballCarrier } from '@/game/athlete';
import { idleIntent, type AthleteIntent, type IntentDecider } from '@/game/engine-api';
import type { KickKind } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import { END_ZONE_DEPTH, FIELD_WIDTH, MIDDLE_X, fieldY } from '@/game/types';
import { CATCH_HEIGHT, predictLanding } from '@/physics/ball';
import { aiKickMeter, kickoffDistance, puntDistance } from '@/physics/kick';
import { isSpecialPlay } from '@/playbook/special-teams';
import { arrive, avoid, clampToField, decided, holdPosition, seek, targetGoalY } from './movement';
import { kickLaunched, perceive } from './perception';
import { pursueCarrier } from './pursuit';
import { afterTurnover, blockIntent, chaseLooseBall, turnoverPhase } from './turnover';
import { athleteNoise, jitter, noiseScale } from './variance';

/**
 * Kicking-team deciders: 'offense:kicker', 'offense:holder', 'offense:longSnapper', 'offense:gunner' and
 * 'offense:kickCoverage'. On kick plays the kicking team is the offense. Protocol with the engine:
 *   kickoff/onside: once set, the kicker sends action 'kick' (kickPower/kickAccuracy/kickTarget) every tick
 *                   while moving to the tee; the engine strikes the ball when he reaches it;
 *   punt:           the punter (the snap receiver) and the long snapper both ask for the snap with 'snap';
 *                   the punter fields the ball, takes his step and sends 'kick';
 *   FG/XP:          the holder and long snapper ask for the snap; the kicker sends 'kick' (targetId = holder)
 *                   once the holder has the ball and he is at the plant spot.
 * AI kickers skip the on-screen meter: power/accuracy come from physics aiKickMeter, rolled once per play.
 */

/** Edge gap inside which a kickoff is struck. */
export const KICKOFF_STRIKE_GAP = 1.3;
/** Distance to the holder at which a placement kick is struck (the engine accepts a kick within KICK_REACH + 0.4 = 1.8 yd of the ball). */
export const PLACE_KICK_RANGE = 1.8;
/** Seconds a punter holds the ball before kicking when unhurried. */
export const PUNT_STEP_SEC = 0.25;
/** Offense yard line from which punts are aimed at the sideline to pin the return. */
export const DIRECTIONAL_PUNT_BALL_ON = 40;
/** Returner speed (yd/s) below which coverage stops holding lanes and attacks him. */
export const STALLED_RETURNER_SPEED = 1.5;
/** Seconds after the catch that coverage keeps its lanes before converging regardless. */
export const LANE_HOLD_SECONDS = 1.0;
/** Coverage men converge on the returner inside this distance. */
export const COVERAGE_CONVERGE_DIST = 15;

export interface KickPlan {
  kind: KickKind;
  power: number;
  accuracy: number;
  /** Absolute aim point. */
  target: Vec2;
  label: string;
}

/** The kind of kick this play is (null on a scrimmage play or a fake where the kicker has another job). */
export const kickKindFor = (state: Pick<PlayState, 'ctx'>): KickKind | null => {
  const sp = state.ctx.special === 'none' || state.ctx.special === 'twoPoint' ? isSpecialPlay(state.ctx.offensivePlay) : state.ctx.special;
  switch (sp) {
    case 'kickoff': return 'kickoff';
    case 'onside': return 'onside';
    case 'punt': return 'punt';
    case 'fieldGoal': return 'fieldGoal';
    case 'extraPoint': return 'extraPoint';
    default: return null;
  }
};

/** The kick meter this athlete produces this play (rolled once through ctx.rng, then held in scratch). */
export const meterFor = (athlete: Athlete, state: Pick<PlayState, 'ctx'>): { power: number; accuracy: number } => {
  const s = athlete.ai.scratch;
  if (s['meterP'] === undefined || s['meterA'] === undefined) {
    const m = aiKickMeter(athlete.attrs.kickPower, athlete.attrs.kickAccuracy, state.ctx.rng);
    s['meterP'] = m.power;
    s['meterA'] = m.accuracy;
  }
  return { power: s['meterP'] as number, accuracy: s['meterA'] as number };
};

const offenseWith = (state: Pick<PlayState, 'athletes'>, type: string): Athlete[] =>
  state.athletes.filter((a) => a.side === 'offense' && a.assignment.type === type);

/** The deepest returner (closest to the kicking team's target goal line), if any. */
export const deepReturner = (state: Pick<PlayState, 'athletes' | 'ctx'>): Athlete | null => {
  const dir = state.ctx.direction;
  let best: Athlete | null = null;
  for (const a of state.athletes) {
    if (!a.active || a.side !== 'defense' || a.assignment.type !== 'returner') continue;
    if (!best || dir * a.pos.y > dir * best.pos.y) best = a;
  }
  return best;
};

/** Side (-1 left / +1 right, absolute x) to kick toward: away from an offset returner, else personality. */
const kickSide = (athlete: Athlete, state: PlayState): number => {
  const r = deepReturner(state);
  if (r && Math.abs(r.pos.x - MIDDLE_X) > 3) return r.pos.x > MIDDLE_X ? -1 : 1;
  return athleteNoise(athlete, 'kickSide') < 0.5 ? -1 : 1;
};

/** Meter power that lands a punt `yards` downfield for this leg (inverse of physics puntDistance). */
export const puntPowerFor = (kickPowerRating: number, yards: number): number => {
  const full = puntDistance(kickPowerRating, 1);
  return clamp((yards / full - 0.6) / 0.4, 0.3, 1);
};

/** Where and how hard to punt: sideline pin from DIRECTIONAL_PUNT_BALL_ON on, a straight boomer before. */
export const puntPlan = (athlete: Athlete, state: PlayState): KickPlan => {
  const { direction: dir, ballOn, ballX } = state.ctx;
  const meter = meterFor(athlete, state);
  const carry = puntDistance(athlete.attrs.kickPower, meter.power);
  if (ballOn >= DIRECTIONAL_PUNT_BALL_ON) {
    const side = kickSide(athlete, state);
    const landing = Math.min(ballOn + carry, 91);
    const power = landing < ballOn + carry ? puntPowerFor(athlete.attrs.kickPower, landing - ballOn) : meter.power;
    return { kind: 'punt', power, accuracy: meter.accuracy, target: { x: MIDDLE_X + side * (MIDDLE_X - 2.5), y: fieldY(landing, dir) }, label: side < 0 ? 'punt: pin left' : 'punt: pin right' };
  }
  return { kind: 'punt', power: meter.power, accuracy: meter.accuracy, target: { x: ballX + dir * jitter(athlete, 'puntLine', 4), y: fieldY(Math.min(ballOn + carry, 99), dir) }, label: 'punt: deep' };
};

/** The kick to make for `kind`: corner kickoffs, squibs, onside toward the bunched side, uprights for placement kicks. */
export const planKick = (athlete: Athlete, state: PlayState, kind: KickKind): KickPlan => {
  const { direction: dir, ballOn, ballX } = state.ctx;
  const meter = meterFor(athlete, state);
  switch (kind) {
    case 'kickoff': {
      if (state.ctx.offensivePlay.tags.includes('squib')) {
        return { kind, power: clamp(meter.power * 0.6, 0.4, 0.7), accuracy: meter.accuracy, target: { x: MIDDLE_X + jitter(athlete, 'squibX', 6), y: fieldY(Math.min(ballOn + 40, 95), dir) }, label: 'kickoff: squib' };
      }
      const side = kickSide(athlete, state);
      const carry = kickoffDistance(athlete.attrs.kickPower, meter.power);
      return { kind, power: meter.power, accuracy: meter.accuracy, target: { x: MIDDLE_X + side * (MIDDLE_X - 6), y: fieldY(Math.min(ballOn + carry, 104), dir) }, label: side < 0 ? 'kickoff: deep left' : 'kickoff: deep right' };
    }
    case 'onside': {
      const cov = offenseWith(state, 'kickCoverage');
      const right = cov.filter((a) => dir * (a.pos.x - ballX) > 0).length;
      const side = right >= cov.length / 2 ? 1 : -1;
      return { kind, power: clamp(0.4 + 0.2 * athleteNoise(athlete, 'onsidePower'), 0.35, 0.65), accuracy: meter.accuracy, target: { x: ballX + dir * side * 9, y: state.losY + dir * 14 }, label: 'onside' };
    }
    case 'punt': return puntPlan(athlete, state);
    default: {
      const goalY = targetGoalY(athlete, state);
      return { kind, power: meter.power, accuracy: meter.accuracy, target: { x: MIDDLE_X, y: goalY + dir * END_ZONE_DEPTH }, label: kind === 'extraPoint' ? 'xp' : 'fg' };
    }
  }
};

/** The 'kick' intent for a plan (targetId = holder on placement kicks). */
export const kickIntent = (athlete: Athlete, plan: KickPlan, holderId: string | null): AthleteIntent => ({
  ...idleIntent(plan.label),
  face: Math.atan2(plan.target.y - athlete.pos.y, plan.target.x - athlete.pos.x),
  action: 'kick',
  targetId: holderId,
  kickPower: plan.power,
  kickAccuracy: plan.accuracy,
  kickTarget: plan.target,
});

/** True once the snap receiver / snapper wants the ball (their own cadence, or the play clock running down). */
const snapReady = (athlete: Athlete, state: PlayState): boolean => state.tick >= readyTick(athlete, 'snapAt', 0.7) || state.playClock <= 2;

/** The kick fields (action + meter + aim) for a plan, to layer onto a movement intent. */
const kickFields = (athlete: Athlete, state: PlayState, kind: KickKind): Pick<AthleteIntent, 'action' | 'kickPower' | 'kickAccuracy' | 'kickTarget'> => {
  const plan = planKick(athlete, state, kind);
  return { action: 'kick', kickPower: plan.power, kickAccuracy: plan.accuracy, kickTarget: plan.target };
};

const readyTick = (athlete: Athlete, key: string, seconds: number): number => {
  const s = athlete.ai.scratch;
  if (s[key] === undefined) s[key] = secondsToTicks(seconds * noiseScale(athlete, key, 0.3));
  return s[key] as number;
};

const snapLanding = (state: PlayState): Vec2 => {
  const b = state.ball;
  if (b.z > 0 || b.vz > 0) return predictLanding(b, state.ctx.weather, CATCH_HEIGHT).pos;
  return add(b.pos, { x: b.vel.x * 0.2, y: b.vel.y * 0.2 });
};

/** After the ball is away the kicker is the last line of defence: hang back, pursue only when it comes to him. */
const afterKick = (athlete: Athlete, state: PlayState, kind: KickKind): AthleteIntent => {
  const dir = state.ctx.direction;
  if (state.ball.phase === 'loose') {
    // A kickoff / onside kick may not be touched by the kicking team until it has gone 10 yards.
    if ((kind === 'kickoff' || kind === 'onside') && dir * (state.ball.pos.y - state.losY) < 10) {
      return arrive(athlete, clampToField({ x: state.ball.pos.x, y: state.losY + dir * 10.5 }), 2, 'kicker: wait 10 yd');
    }
    return chaseLooseBall(athlete, state);
  }
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'defense') {
    const past = state.athletes.every((a) => a.id === athlete.id || a.side !== 'offense' || !a.active || dir * (a.pos.y - carrier.pos.y) > 0);
    if (past || dist(athlete.pos, carrier.pos) <= COVERAGE_CONVERGE_DIST) return pursueCarrier(athlete, state, { label: 'last line', underControl: true });
  } else if (carrier && carrier.side === 'offense') {
    return afterTurnover(athlete, state);
  }
  if (kind === 'fieldGoal' || kind === 'extraPoint') return holdPosition(athlete, null, 'kicker: watch');
  if (kind === 'kickoff' || kind === 'punt') {
    // The kicker (the punter on a punt) is the safety: he trails his coverage by KICKER_TRAIL yards, shading toward
    // the ball, so a returner who breaks the first wave still has a man to beat instead of a free run to the end zone.
    const unit = state.athletes.filter((a) => a.active && a.side === 'offense' && a.id !== athlete.id).map((a) => dir * a.pos.y).sort((a, b) => a - b);
    const line = unit[Math.floor(unit.length / 2)] ?? dir * athlete.pos.y;
    const focusX = carrier ? carrier.pos.x : state.ball.pos.x;
    const y = dir * Math.max(dir * state.losY, line - KICKER_TRAIL);
    return arrive(athlete, clampToField({ x: MIDDLE_X + (focusX - MIDDLE_X) * 0.6, y }), 3, 'kicker: trail the coverage');
  }
  return arrive(athlete, clampToField({ x: MIDDLE_X, y: state.losY - dir * 5 }), 3, 'kicker: safety');
};

/** Yards the kick safety (the kicker, or the punter) stays behind the middle of his coverage line. */
export const KICKER_TRAIL = 12;

const punterIntent = (athlete: Athlete, state: PlayState, plan: KickPlan): AthleteIntent => {
  const ball = state.ball;
  const s = athlete.ai.scratch;
  if (ball.phase === 'loose') {
    s['badSnap'] = 1;
    return chaseLooseBall(athlete, state);
  }
  const carrier = ballCarrier(state);
  if (carrier && carrier.id !== athlete.id) return afterTurnover(athlete, state);
  if (!carrier) return arrive(athlete, snapLanding(state), 1.5, 'punt: field snap');
  if (s['heldT'] === undefined) s['heldT'] = state.time;
  const held = state.time - (s['heldT'] as number);
  const p = perceive(athlete, state);
  if (s['badSnap'] === 1 && p.nearestOpponentDist <= 3 && p.nearestOpponent) {
    const dir = state.ctx.direction;
    const awayX = p.nearestOpponent.pos.x > athlete.pos.x ? 3 : FIELD_WIDTH - 3;
    return seek(athlete, clampToField({ x: awayX, y: athlete.pos.y + dir * 6 }), true, 'punt: broken play run');
  }
  if (held >= PUNT_STEP_SEC || p.nearestOpponentDist <= 2) return kickIntent(athlete, plan, null);
  return { ...idleIntent('punt: step'), move: { x: 0, y: state.ctx.direction * 0.4 } };
};

const placeKickerIntent = (athlete: Athlete, state: PlayState, kind: KickKind): AthleteIntent => {
  const ball = state.ball;
  const holder = offenseWith(state, 'holder')[0] ?? null;
  if (ball.phase === 'loose') return holder && dist(holder.pos, ball.pos) < 3 ? holdPosition(athlete, null, 'fg: holder recovers') : chaseLooseBall(athlete, state);
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'defense') return afterTurnover(athlete, state);
  if (holder && carrier && carrier.id === holder.id) {
    if (dist(athlete.pos, holder.pos) <= PLACE_KICK_RANGE) return kickIntent(athlete, planKick(athlete, state, kind), holder.id);
    const dir = state.ctx.direction;
    return seek(athlete, add(holder.pos, { x: -dir * 1.0, y: -dir * 1.2 }), false, 'fg: approach');
  }
  return holdPosition(athlete, null, 'fg: wait for hold');
};

const kickerIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const kind = kickKindFor(state);
  if (!kind) return afterTurnover(athlete, state);
  const ball = state.ball;
  if (kickLaunched(state)) return afterKick(athlete, state, kind);
  const teeKick = kind === 'kickoff' || kind === 'onside';
  if (state.phase === 'presnap') {
    if (!teeKick) {
      if (kind === 'punt' && snapReady(athlete, state)) return { ...idleIntent('punt: call for the snap'), action: 'snap' };
      return holdPosition(athlete, null, kind === 'punt' ? 'punt: await snap' : 'fg: await snap');
    }
    if (state.tick < readyTick(athlete, 'approach', 0.8)) return holdPosition(athlete, Math.atan2(ball.pos.y - athlete.pos.y, ball.pos.x - athlete.pos.x), 'kickoff: set');
    return { ...kickIntent(athlete, planKick(athlete, state, kind), null), move: { x: 0, y: 0 } };
  }
  if (teeKick) {
    if (dist(athlete.pos, ball.pos) - athlete.radius <= KICKOFF_STRIKE_GAP) return kickIntent(athlete, planKick(athlete, state, kind), null);
    return { ...seek(athlete, ball.pos, true, 'kickoff: approach'), ...kickFields(athlete, state, kind) };
  }
  if (kind === 'punt') return punterIntent(athlete, state, planKick(athlete, state, kind));
  return placeKickerIntent(athlete, state, kind);
};

const holderIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const ball = state.ball;
  if (state.phase === 'presnap') return snapReady(athlete, state) ? { ...idleIntent('holder: call for the snap'), action: 'snap' } : holdPosition(athlete, null, 'holder: set');
  if (ball.phase === 'loose') return chaseLooseBall(athlete, state);
  if (kickLaunched(state)) return turnoverPhase(athlete, state) === 'none' ? holdPosition(athlete, null, 'holder: done') : afterTurnover(athlete, state);
  const carrier = ballCarrier(state);
  if (!carrier) return arrive(athlete, snapLanding(state), 1, 'holder: field snap');
  if (carrier.id !== athlete.id) return afterTurnover(athlete, state);
  const s = athlete.ai.scratch;
  if (s['heldT'] === undefined) s['heldT'] = state.time;
  const held = state.time - (s['heldT'] as number);
  const p = perceive(athlete, state);
  if (held > 1.5 && p.nearestOpponentDist <= 1.5) {
    const dir = state.ctx.direction;
    return seek(athlete, clampToField({ x: athlete.pos.x < MIDDLE_X ? 3 : FIELD_WIDTH - 3, y: athlete.pos.y + dir * 5 }), true, 'holder: broken play');
  }
  const kicker = offenseWith(state, 'kicker')[0];
  return holdPosition(athlete, kicker ? Math.atan2(kicker.pos.y - athlete.pos.y, kicker.pos.x - athlete.pos.x) : null, 'holder: hold');
};

/** A coverage man's alignment rank across the unit (0 = nearest the low sideline) and the unit's size. */
const coverageRank = (athlete: Athlete, state: PlayState): { rank: number; n: number } => {
  const unit = state.athletes
    .filter((a) => a.side === 'offense' && (a.assignment.type === 'kickCoverage' || a.assignment.type === 'longSnapper'))
    .map((a) => ({ id: a.id, x: a.ai.scratch['alignX'] ?? a.pos.x }))
    .sort((a, b) => a.x - b.x);
  return { rank: Math.max(0, unit.findIndex((u) => u.id === athlete.id)), n: Math.max(1, unit.length) };
};

/** Lane x for a coverage man: evenly spaced by alignment rank across the field (gunners excluded). */
export const coverageLaneX = (athlete: Athlete, state: PlayState): number => {
  const { rank, n } = coverageRank(athlete, state);
  return 6 + (FIELD_WIDTH - 12) * ((rank + 0.5) / n);
};

/**
 * Yards behind the coverage wall the two kickoff safeties (second man in from each sideline) trail until the returner
 * commits: the last line behind the kicker, so a returner who splits the wall still has men with an angle on him.
 */
export const KICKOFF_SAFETY_DEPTH = 10;

/** True for a kickoff safety: the second coverage man in from either sideline in a unit of eight or more. */
const kickoffSafety = (athlete: Athlete, state: PlayState): boolean => {
  const { rank, n } = coverageRank(athlete, state);
  return n >= 8 && (rank === 1 || rank === n - 2);
};

/** Stay in the lane until the returner commits, then pursue; block on punts until the ball is away. */
const coverageIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const kind = kickKindFor(state);
  const dir = state.ctx.direction;
  const s = athlete.ai.scratch;
  if (s['alignX'] === undefined) s['alignX'] = athlete.pos.x;
  if (state.phase === 'presnap') return holdPosition(athlete, null, 'coverage: set');
  if (!kind) return afterTurnover(athlete, state);
  const p = perceive(athlete, state);
  if (!kickLaunched(state)) {
    if (kind === 'kickoff' || kind === 'onside') return holdPosition(athlete, null, 'coverage: wait for kick');
    const threat = p.threats.find((t) => dir * (t.pos.y - athlete.pos.y) > -0.5 && dist(t.pos, athlete.pos) <= 3);
    const kicker = offenseWith(state, 'kicker')[0];
    return threat ? blockIntent(athlete, threat, kicker ? kicker.pos : athlete.pos, 'protect') : holdPosition(athlete, null, 'coverage: protect');
  }
  if (state.ball.phase === 'loose') {
    if ((kind === 'kickoff' || kind === 'onside') && dir * (state.ball.pos.y - state.losY) < 10) {
      return arrive(athlete, clampToField({ x: state.ball.pos.x, y: state.losY + dir * 10.5 }), 2, 'coverage: wait 10 yd');
    }
    return chaseLooseBall(athlete, state);
  }
  const carrier = p.ballCarrier;
  if (carrier && carrier.side === 'offense') return afterTurnover(athlete, state);
  if (carrier && athlete.state === 'engaged' && dist(athlete.pos, carrier.pos) <= COVERAGE_SHED_RANGE) return fightOffBlock(athlete, carrier);
  if (carrier) {
    if (s['catchY'] === undefined) s['catchY'] = carrier.pos.y;
    if (s['catchT'] === undefined) s['catchT'] = state.time;
    const sinceCatch = state.time - (s['catchT'] as number);
    // Lanes hold only while the returner is picking his way; a returner who stalls (or stands) gets attacked.
    const stalled = (Math.hypot(carrier.vel.x, carrier.vel.y) < STALLED_RETURNER_SPEED && sinceCatch > 0.4) || sinceCatch > LANE_HOLD_SECONDS;
    const committed = stalled || Math.abs(carrier.pos.y - (s['catchY'] as number)) > 3 || dist(athlete.pos, carrier.pos) <= COVERAGE_CONVERGE_DIST;
    // A kickoff safety keeps his depth (shading to the ball) until the returner is on him, then takes his angle. He
    // keeps it by holding his ground, never by turning and running for his own goal line ahead of the returner (at
    // the returner's pace the gap would never close): once his spot is behind him the returner is coming and he attacks.
    if (committed && kind === 'kickoff' && kickoffSafety(athlete, state) && dist(athlete.pos, carrier.pos) > KICKOFF_SAFETY_DEPTH - 2) {
      const lane = coverageLaneX(athlete, state);
      const spot = clampToField({ x: (lane + carrier.pos.x) / 2, y: carrier.pos.y - dir * KICKOFF_SAFETY_DEPTH });
      if (dir * (spot.y - athlete.pos.y) >= -1) return arrive(athlete, spot, 1.5, 'coverage: safety');
    }
    if (committed) return pursueCarrier(athlete, state, { label: stalled ? 'coverage: attack stalled returner' : 'coverage', underControl: true });
  }
  const focusY = carrier ? carrier.pos.y : p.ballLanding ? p.ballLanding.pos.y : athlete.pos.y + dir * 20;
  const lane = coverageLaneX(athlete, state);
  if (kind === 'kickoff' && kickoffSafety(athlete, state)) {
    const hold = clampToField({ x: lane + (MIDDLE_X - lane) * 0.4, y: focusY - dir * KICKOFF_SAFETY_DEPTH });
    if (dir * (hold.y - athlete.pos.y) <= 1) return arrive(athlete, hold, 2, 'coverage: safety');
  }
  const stopShort = dir * (focusY - athlete.pos.y) <= 4;
  const target = clampToField({ x: lane, y: stopShort ? focusY - dir * 3 : athlete.pos.y + dir * 8 });
  const intent = stopShort ? arrive(athlete, target, 2, 'coverage: lane hold') : seek(athlete, target, true, 'coverage: lane');
  return avoid(athlete, state.athletes.filter((a) => a.side === 'defense'), intent, 2);
};

/** A coverage man tied up by a return blocker fights off the block once the returner is inside this distance (yd). */
export const COVERAGE_SHED_RANGE = 5;

/**
 * A coverage man tied up by a return blocker with the returner coming by fights to get off the block onto him (a
 * 'shed' aimed at the carrier, as a scrimmage defender does), instead of running on as if he were free.
 */
const fightOffBlock = (athlete: Athlete, carrier: Athlete): AthleteIntent => ({
  ...seek(athlete, carrier.pos, false, 'coverage: shed to returner'),
  action: 'shed',
  targetId: carrier.id,
});

/** Distance (yd) from the landing at which a gunner leaves the sideline and converges on the catch. */
export const GUNNER_CONVERGE_DIST = 24;

/** Gunners release down the sideline through the jam and converge on the landing point. */
const gunnerIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const dir = state.ctx.direction;
  const s = athlete.ai.scratch;
  if (s['alignX'] === undefined) s['alignX'] = athlete.pos.x;
  if (state.phase === 'presnap') return holdPosition(athlete, null, 'gunner: set');
  const launched = kickLaunched(state);
  if (launched && state.ball.phase === 'loose') return chaseLooseBall(athlete, state);
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'defense' && athlete.state === 'engaged' && dist(athlete.pos, carrier.pos) <= COVERAGE_SHED_RANGE) return fightOffBlock(athlete, carrier);
  if (carrier && carrier.side === 'defense') return pursueCarrier(athlete, state, { label: 'gunner', underControl: true });
  if (carrier && carrier.side === 'offense' && launched) return afterTurnover(athlete, state);
  const p = perceive(athlete, state);
  // He turns in off the sideline within GUNNER_CONVERGE_DIST of the landing, or once he is level with it: a gunner who
  // held the sideline until he was within 18 yards of a ball punted down the middle ran right past the returner.
  if (launched && p.ballLanding && (dist(athlete.pos, p.ballLanding.pos) <= GUNNER_CONVERGE_DIST || dir * (p.ballLanding.pos.y - athlete.pos.y) <= 0)) {
    const fairCaught = state.events.some((e) => e.type === 'fairCatch');
    const spot = fairCaught ? add(p.ballLanding.pos, { x: 0, y: -dir * 2 }) : p.ballLanding.pos;
    return arrive(athlete, spot, fairCaught ? 3 : 2, fairCaught ? 'gunner: fair catch' : 'gunner: converge');
  }
  const sidelineX = (s['alignX'] as number) < MIDDLE_X ? 3 : FIELD_WIDTH - 3;
  const intent = seek(athlete, clampToField({ x: sidelineX, y: athlete.pos.y + dir * 10 }), true, 'gunner: release');
  return avoid(athlete, state.athletes.filter((a) => a.side === 'defense'), intent, 2.5);
};

const longSnapperIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  if (state.phase === 'presnap') {
    if (!snapReady(athlete, state)) return holdPosition(athlete, null, 'ls: set');
    const target = offenseWith(state, 'holder')[0] ?? offenseWith(state, 'kicker')[0] ?? offenseWith(state, 'qb')[0] ?? null;
    return { ...idleIntent('snap'), action: 'snap', targetId: target ? target.id : null };
  }
  if (kickLaunched(state) || turnoverPhase(athlete, state) !== 'none') {
    const kind = kickKindFor(state);
    return kind === 'punt' ? coverageIntent(athlete, state) : afterTurnover(athlete, state);
  }
  const dir = state.ctx.direction;
  const p = perceive(athlete, state);
  const threat = p.threats.find((t) => dir * (t.pos.y - athlete.pos.y) > -0.5 && dist(t.pos, athlete.pos) <= 2.5);
  const protect = offenseWith(state, 'holder')[0] ?? offenseWith(state, 'kicker')[0];
  return threat ? blockIntent(athlete, threat, protect ? protect.pos : athlete.pos, 'ls: protect') : { ...holdPosition(athlete, null, 'ls: protect'), face: Math.atan2(dir, 0) };
};

export const kickerDecider: IntentDecider = (athlete, state) => decided(athlete, state, kickerIntent(athlete, state));
export const holderDecider: IntentDecider = (athlete, state) => decided(athlete, state, holderIntent(athlete, state));
export const longSnapperDecider: IntentDecider = (athlete, state) => decided(athlete, state, longSnapperIntent(athlete, state));
export const gunnerDecider: IntentDecider = (athlete, state) => decided(athlete, state, gunnerIntent(athlete, state));
export const kickCoverageDecider: IntentDecider = (athlete, state) => decided(athlete, state, coverageIntent(athlete, state));

