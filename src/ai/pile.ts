import { clamp01 } from '@/core/math';
import { dist, len, normalize, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent, type IntentAction } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_WIDTH } from '@/game/types';
import { breakMoveBoost, massFactor, stopPower } from '@/physics/struggle';
import { clockSituation, visionQuality } from './ball-carrier';
import { defenderJitter, judgement } from './defense-shared';
import { jitter } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * AI decisions in a tackle struggle (systems/tackle-struggle.ts moves the bodies; these only choose). A defender
 * hanging on drives the runner back toward his own goal (and out of bounds when the sideline is close, if he reads
 * it), and a man who joined the pile may punch at the ball. A held runner keeps his legs churning upfield and picks
 * a break move by his ratings (the better his read, the likelier the right one), never while protecting the ball late.
 * A free teammate of the runner leans into the pile from behind (legal pile pushing). Difficulty shapes only these
 * choices (via judgement / visionQuality), never the struggle dice.
 */

/** Seconds a held runner waits after the hold before his first break move, and between attempts. */
export const FIRST_MOVE_DELAY = 0.2;
export const MOVE_INTERVAL = 0.9;
/** Yards from the sideline inside which a tackler drives the runner out. */
export const SIDELINE_DRIVE = 3;
/** Yards within which a free teammate goes to push the pile. */
export const PUSH_RANGE = 3.5;
/** Seconds a joiner punches at the ball once he decides to. */
export const STRIP_PUNCH_SECONDS = 0.35;

const attackOf = (state: PlayState, a: Pick<Athlete, 'side'>): 1 | -1 =>
  (a.side === 'offense' ? state.ctx.direction : state.ctx.direction === 1 ? -1 : 1);

const heldCarrier = (state: PlayState): Athlete | null => {
  if (state.ball.phase !== 'held') return null;
  const c = state.athletes.find((a) => a.id === state.ball.carrierId);
  return c && c.active && c.state === 'wrapped' ? c : null;
};

/** A defender hanging on to the runner: drive him back (or out), and maybe strip if he came in second. */
export const pileTacklerIntent = (athlete: Athlete, state: PlayState): AthleteIntent => {
  const carrier = heldCarrier(state);
  const intent = idleIntent('pile: hold');
  if (!carrier) return intent;
  const back = -attackOf(state, carrier);
  let move: Vec2 = { x: 0, y: back };
  const edge = Math.min(carrier.pos.x, FIELD_WIDTH - carrier.pos.x);
  const knob = difficultyFor(state, athlete).tackleDecisionQuality;
  if (edge < SIDELINE_DRIVE && judgement(athlete, knob, 'pileSideline') > 0.4) {
    move = normalize({ x: carrier.pos.x < FIELD_WIDTH / 2 ? -0.8 : 0.8, y: back * 0.6 });
    intent.debug = 'pile: drive him out';
  } else intent.debug = 'pile: drive back';
  intent.move = move;
  intent.sprint = true;
  intent.action = 'tackle';
  intent.targetId = carrier.id;
  // Joined a pile somebody else started: the second man goes for the ball when the runner carries it loosely.
  const sc = athlete.ai.scratch;
  if (sc.pileTick === undefined || state.tick - sc.pileTick > 1) {
    const others = state.athletes.filter((d) => d.id !== athlete.id && d.side === athlete.side && d.state === 'wrapping').length;
    sc.pileJoiner = others > 0 ? 1 : 0;
    const wantsBall = (1 - clamp01((carrier.attrs.carrying - 1) / 98)) * 0.6 + judgement(athlete, knob, 'pileStrip') * 0.4 + defenderJitter(athlete, 'pileStrip', 0.1);
    sc.pileStripUntil = sc.pileJoiner === 1 && wantsBall > 0.55 ? state.time + STRIP_PUNCH_SECONDS : -1;
  }
  sc.pileTick = state.tick;
  if (state.time <= (sc.pileStripUntil ?? -1)) {
    intent.action = 'strip';
    intent.debug = 'pile: punch at the ball';
  }
  return intent;
};

/** Best break move for a held runner against the pile holding him (null = just churn). */
export const pileBreakMove = (athlete: Athlete, state: PlayState, holders: readonly Athlete[]): IntentAction | null => {
  const q = visionQuality(athlete, state);
  const stop = holders.reduce((s, h) => s + stopPower(h), 0);
  const moves = ['juke', 'spin', 'stiffArm', 'truck'] as const;
  let best: IntentAction | null = null;
  let bs = 1.2 + 0.4 * holders.length;
  for (const m of moves) {
    // What the move is worth against this pile, misjudged by a poor read.
    const worth = breakMoveBoost(athlete, m, 0) - 0.5 * stop
      + (m === 'truck' ? 0.3 * massFactor(athlete.massLb) : 0) + jitter(athlete, `pileMove:${m}`, 0.3 * (1 - q));
    if (worth > bs) {
      bs = worth;
      best = m;
    }
  }
  return best;
};

/**
 * A held runner: whatever his own decider wanted to do with the ball (a throw in the grasp, a pitch out of the pile)
 * stands; otherwise he churns upfield (or toward the sideline when the clock says get out) and tries a break move now
 * and then.
 */
export const wrappedCarrierIntent = (athlete: Athlete, state: PlayState, base: AthleteIntent): AthleteIntent => {
  if (base.action === 'throw' || base.action === 'throwAway' || base.action === 'pitch' || base.action === 'lateral') return base;
  const intent = idleIntent('held: churn');
  const up = attackOf(state, athlete);
  const sit = clockSituation(state);
  const edge = Math.min(athlete.pos.x, FIELD_WIDTH - athlete.pos.x);
  intent.move = sit.wantOob && edge < SIDELINE_DRIVE && athlete.side === 'offense'
    ? normalize({ x: athlete.pos.x < FIELD_WIDTH / 2 ? -1 : 1, y: up * 0.3 })
    : { x: 0, y: up };
  intent.sprint = true;
  const sc = athlete.ai.scratch;
  if (sc.heldTick === undefined || state.tick - sc.heldTick > 1) sc.heldSince = state.time;
  sc.heldTick = state.tick;
  const since = state.time - (sc.heldSince ?? state.time);
  const lastMove = sc.pileMoveT ?? -Infinity;
  if (!sit.protect && since >= FIRST_MOVE_DELAY && state.time - lastMove >= MOVE_INTERVAL) {
    const holders = state.athletes.filter((d) => d.side !== athlete.side && d.state === 'wrapping' && dist(d.pos, athlete.pos) < 2);
    const mv = pileBreakMove(athlete, state, holders);
    if (mv) {
      intent.action = mv;
      intent.debug = `held: ${mv}`;
      sc.pileMoveT = state.time;
    }
  }
  return intent;
};

/** A free teammate near a held runner leans in from behind and pushes upfield; null when he has better things to do. */
export const pilePushIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  if (athlete.hasBall || athlete.state === 'engaged' || athlete.state === 'down' || athlete.state === 'stumbling' || !athlete.active) return null;
  const carrier = heldCarrier(state);
  if (!carrier || carrier.side !== athlete.side) return null;
  const d = dist(athlete.pos, carrier.pos);
  if (d > PUSH_RANGE || judgement(athlete, difficultyFor(state, athlete).blockingIq, 'pilePush') < 0.35) return null;
  const up = attackOf(state, carrier);
  const intent = idleIntent('pile: push');
  if (d <= athlete.radius + carrier.radius + 0.3 && up * (carrier.pos.y - athlete.pos.y) > -0.3) {
    intent.move = { x: 0, y: up };
  } else {
    const behind = { x: carrier.pos.x - athlete.pos.x, y: carrier.pos.y - up * 0.8 - athlete.pos.y };
    intent.move = len(behind) > 1e-6 ? normalize(behind) : { x: 0, y: up };
    intent.debug = 'pile: get behind it';
  }
  intent.sprint = true;
  return intent;
};

/** Overrides an athlete's decided intent while a struggle is on (see the module doc); returns `base` otherwise. */
export const pileOverride = (athlete: Athlete, state: PlayState, base: () => AthleteIntent): AthleteIntent => {
  if (state.phase !== 'live') return base();
  if (athlete.state === 'wrapping') return pileTacklerIntent(athlete, state);
  if (athlete.hasBall && athlete.state === 'wrapped') return wrappedCarrierIntent(athlete, state, base());
  return pilePushIntent(athlete, state) ?? base();
};
