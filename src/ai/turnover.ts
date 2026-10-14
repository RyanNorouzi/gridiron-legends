import { add, dist, len, scale, type Vec2 } from '@/core/vec2';
import { ballCarrier } from '@/game/athlete';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { Side } from '@/game/types';
import { predictLanding } from '@/physics/ball';
import { arrive, attackDirection, clampToField, seek, toward } from './movement';
import { kickLaunched } from './perception';
import { pursueCarrier } from './pursuit';
import { jitter } from './variance';

/**
 * Fallback behaviour every decider uses once the ball is no longer where the play expects it: loose on the
 * turf, or carried by the side that was not supposed to have it. Offensive players turn into tacklers,
 * defenders into a convoy for their returner, and a loose ball draws the nearest three from each side while
 * the rest block or contain.
 */
export type TurnoverPhase = 'none' | 'loose' | 'lost' | 'gained';

/** How many athletes per side dive after a loose ball. */
export const LOOSE_BALL_CHASERS = 3;
/** Gap inside which a chaser lays out for a loose ball. */
export const LOOSE_DIVE_GAP = 1.6;
/** Edge gap at which a blocker engages. */
export const BLOCK_ENGAGE_GAP = 1.2;

/** The side that is supposed to have the ball right now (the receiving team once a kick is launched). */
export const expectedPossession = (state: PlayState): Side => {
  const sp = state.ctx.special;
  if (sp === 'kickoff' || sp === 'onside' || sp === 'punt') return kickLaunched(state) ? 'defense' : 'offense';
  return 'offense';
};

/** Classifies the ball situation from this athlete's point of view. */
export const turnoverPhase = (athlete: Pick<Athlete, 'side'>, state: PlayState): TurnoverPhase => {
  const b = state.ball;
  if (b.phase === 'loose') return 'loose';
  if (b.phase === 'inAir' && (b.kind === 'fumble' || b.kind === 'tip')) return 'loose';
  if (b.phase !== 'held') return 'none';
  const carrier = ballCarrier(state);
  if (!carrier) return 'none';
  const expected = expectedPossession(state);
  if (carrier.side === athlete.side) return expected === athlete.side ? 'none' : 'gained';
  return expected === athlete.side ? 'lost' : 'none';
};

/** True when the athlete's normal assignment no longer applies (loose ball or possession flipped). */
export const isTurnoverSituation = (athlete: Pick<Athlete, 'side'>, state: PlayState): boolean => turnoverPhase(athlete, state) !== 'none';

/** Where a loose ball is heading: its landing point when airborne, else a short roll ahead of it. */
export const looseBallTarget = (state: PlayState): Vec2 => {
  const b = state.ball;
  if (b.phase === 'inAir' || b.z > 0.3 || b.vz > 0) return clampToField(predictLanding(b, state.ctx.weather).pos);
  return clampToField(add(b.pos, scale(b.vel, 0.3)));
};

/** Move to get between `threat` and `protect`, engaging the block once within reach. */
export const blockIntent = (athlete: Athlete, threat: Athlete, protect: Vec2, label = 'block'): AthleteIntent => {
  const gap = dist(athlete.pos, threat.pos) - athlete.radius - threat.radius;
  if (gap <= BLOCK_ENGAGE_GAP) return { ...seek(athlete, threat.pos, false, `${label} ${threat.role}`), action: 'block', targetId: threat.id };
  const spot = add(threat.pos, scale(toward(threat.pos, protect), 0.9));
  return seek(athlete, spot, true, `${label} -> ${threat.role}`);
};

const nearestOpponentTo = (state: PlayState, athlete: Athlete, pos: Vec2, radius: number): Athlete | null => {
  let best: Athlete | null = null;
  let bestD = radius;
  for (const a of state.athletes) {
    if (!a.active || a.side === athlete.side) continue;
    const d = dist(a.pos, pos);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
};

/** Go after a loose ball: the nearest LOOSE_BALL_CHASERS of each side attack it, the rest block or converge. */
export const chaseLooseBall = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const target = looseBallTarget(state);
  const mine = state.athletes.filter((a) => a.active && a.side === athlete.side).sort((a, b) => dist(a.pos, target) - dist(b.pos, target));
  const rank = mine.findIndex((a) => a.id === athlete.id);
  athlete.ai.blockTargetId = null;
  if (rank >= 0 && rank < LOOSE_BALL_CHASERS) {
    const gap = dist(athlete.pos, state.ball.pos) - athlete.radius;
    const contested = nearestOpponentTo(state, athlete, state.ball.pos, 2.5) !== null;
    const intent = seek(athlete, target, true, `loose ball #${rank + 1}`);
    if (gap <= LOOSE_DIVE_GAP && (len(state.ball.vel) > 1 || contested)) return { ...intent, action: 'dive', debug: `${intent.debug} dive` };
    return intent;
  }
  const threat = nearestOpponentTo(state, athlete, target, 8);
  if (threat) {
    athlete.ai.blockTargetId = threat.id;
    return blockIntent(athlete, threat, target, 'loose: block');
  }
  return arrive(athlete, target, 4, 'loose: converge');
};

/** Escort a teammate carrying the ball: block the nearest unclaimed threat or lead ahead of the runner. */
export const convoyBlock = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const carrier = ballCarrier(state);
  if (!carrier || carrier.side !== athlete.side || carrier.id === athlete.id) return idleIntent('convoy: no carrier');
  const attack = attackDirection(carrier, state);
  const claimed = new Set<string>();
  for (const a of state.athletes) {
    if (a.side === athlete.side && a.id !== athlete.id && a.ai.blockTargetId && a.ai.lastDecisionTick >= state.tick - 1) claimed.add(a.ai.blockTargetId);
  }
  const threats = state.athletes
    .filter((a) => a.active && a.side !== athlete.side)
    .map((o) => ({ o, score: dist(o.pos, carrier.pos) + (attack * (o.pos.y - carrier.pos.y) < -1 ? 6 : 0) + dist(o.pos, athlete.pos) * 0.5 }))
    .filter((t) => t.score < 30)
    .sort((a, b) => a.score - b.score);
  const pick = threats.find((t) => !claimed.has(t.o.id)) ?? threats[0];
  if (!pick) {
    athlete.ai.blockTargetId = null;
    const spot = clampToField(add(carrier.pos, { x: jitter(athlete, 'convoyX', 4), y: attack * 5 }));
    return arrive(athlete, spot, 3, 'convoy lead');
  }
  athlete.ai.blockTargetId = pick.o.id;
  return blockIntent(athlete, pick.o, carrier.pos, 'convoy');
};

/**
 * What to do once the play has broken: chase a loose ball, run down the new carrier, or form a convoy for
 * a teammate who just took the ball away. When nothing is off (called defensively) it pursues an opposing
 * carrier if there is one and otherwise stands.
 */
export const afterTurnover = (athlete: Athlete, state: PlayState): AthleteIntent => {
  switch (turnoverPhase(athlete, state)) {
    case 'loose': return chaseLooseBall(athlete, state);
    case 'lost': return pursueCarrier(athlete, state, { label: 'chase' });
    case 'gained': return convoyBlock(athlete, state);
    default: {
      const carrier = ballCarrier(state);
      return carrier && carrier.side !== athlete.side ? pursueCarrier(athlete, state) : idleIntent('turnover: none');
    }
  }
};
