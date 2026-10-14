import { decideIntent } from '@/ai/index';
import { USER_DROP_DONE_KEY } from '@/ai/blocking-pass';
import { DROP_SETTLE_YARDS, FAKE_SECONDS, dropbackDepth } from '@/ai/qb';
import { routeAlignment, toField, toLocal } from '@/ai/route-running';
import { clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { angle, dist, dot, len, normalize, sub, type Vec2 } from '@/core/vec2';
import { predictLanding } from '@/physics/ball';
import { receiverSlots, type OffensiveFormation } from '@/playbook/types';
import { athleteId, ballCarrier, findAthlete } from './athlete';
import { autoReturning, takeOverReturn, touchedReturn } from './auto-return';
import { idleIntent, type AthleteIntent, type LivePlayOptions, type UserThrowSpot } from './engine-api';
import type { AthleteId } from './play-events';
import type { Athlete, PlayState, UserPlayInput } from './play-types';
import type { Side, TeamSide } from './types';
import { difficultyFor } from './difficulty-sides';

/**
 * Converts one side's UserPlayInput into the controlled athlete's AthleteIntent, and owns the control
 * bookkeeping: switching defenders, and moving control to whoever holds the ball for a human side.
 * The input is already in the field frame (src/ui/game/play-input.ts applied the camera), so `move` passes
 * through unchanged. Kick-meter presses are consumed by the kicking system, not here.
 */
export interface UserControlContext {
  /** Receiver roles for throw1..5 (receiverSlots order). */
  receiverSlots: string[];
}

/** Receiver slots for the play: from the registry formation when available, else the offense in formation order. */
export const receiverSlotsFor = (state: PlayState, opts: LivePlayOptions = {}): string[] => {
  const play = state.ctx.offensivePlay;
  const registry = opts.registries?.offensiveFormations?.[play.formation];
  const formation: OffensiveFormation = registry ?? {
    id: play.formation, name: play.formation, personnel: '11', qbAlignment: 'shotgun',
    slots: state.athletes.filter((a) => a.side === 'offense').map((a) => ({ role: a.role, position: a.position, x: 0, y: 0, eligible: a.eligible })),
  };
  return receiverSlots(play, formation);
};

/** Nearest teammate behind the holder (pitch / option target). */
export const nearestTrailingTeammate = (state: PlayState, holder: Athlete, attack: 1 | -1): Athlete | null => {
  const cands = state.athletes
    .filter((a) => a.active && a.side === holder.side && a.id !== holder.id && attack * (a.pos.y - holder.pos.y) < 0.5 && dist(a.pos, holder.pos) <= 12)
    .sort((p, q) => dist(p.pos, holder.pos) - dist(q.pos, holder.pos));
  return cands[0] ?? null;
};

const attackOf = (state: PlayState, side: Side): 1 | -1 => (side === 'offense' ? state.ctx.direction : state.ctx.direction === 1 ? -1 : 1);

/** Builds the intent for a controlled athlete from this tick's input. */
/** Seconds after the snap during which the AI runs a human quarterback's designed exchange (handoff / option read). */
export const AUTO_EXCHANGE_SECONDS = 1.4;
/** Stick deflection that counts as the human taking a read play himself (a keep). */
export const READ_OVERRIDE = 0.6;

/**
 * Designed exchanges are automatic, as in most football games: on a called run the quarterback carries out the
 * mesh (reverse pivot, draw drop, toss) and control passes to the runner at the handoff. A human quarterback has no
 * mesh input, so standing still (or drifting with the stick, or pressing a throw) would otherwise never reach the
 * runner. On read plays (RPO / zone read) the AI makes the give/keep/throw read unless the human clearly takes over
 * with the stick. Ends at the handoff/pitch or AUTO_EXCHANGE_SECONDS after the snap.
 */
export const autoExchange = (athlete: Athlete, input: UserPlayInput, state: PlayState): boolean => {
  if (state.phase !== 'live' || athlete.side !== 'offense' || athlete.assignment.type !== 'qb') return false;
  const play = state.ctx.offensivePlay;
  const read = play.type === 'rpo' || (play.type === 'qbRun' && play.fakeTo !== undefined);
  if (play.type !== 'run' && !read) return false;
  const ball = state.ball;
  const holds = ball.phase === 'held' && ball.carrierId === athlete.id;
  const snapComing = ball.phase === 'inAir' && ball.kind === 'snap';
  if (!holds && !snapComing) return false;
  if (state.events.some((e) => e.type === 'handoff' || e.type === 'pitch')) return false;
  if ((state.tick - state.snapTick) * TICK_DT > AUTO_EXCHANGE_SECONDS) return false;
  if (read && Math.hypot(input.move.x, input.move.y) >= READ_OVERRIDE) return false;
  return true;
};

/** Stick deflection that takes a human quarterback out of his automatic drop (he steers himself from then on). */
export const AUTO_DROP_OVERRIDE = 0.3;
const PASS_DROP_TYPES = new Set(['pass', 'playAction']);

/**
 * The called drop, run for a human quarterback, as in most football games: on a pass play he takes the snap and
 * drops to the play's depth (3/5/7-step from under centre, a shorter set from the gun), carrying out a play-action
 * fake on the way, while the user reads the field. Pushing the stick takes over at once; at the top of the drop the
 * user has him. A throw may be made at any point (the caller still reads the throw buttons). Returns the move for
 * this tick, or null when the drop is not (or no longer) his.
 */
export const autoDrop = (athlete: Athlete, input: UserPlayInput, state: PlayState): { move: Vec2; face: number; debug: string } | null => {
  const sc = athlete.ai.scratch;
  if (state.phase !== 'live' || athlete.side !== 'offense' || athlete.assignment.type !== 'qb' || sc[USER_DROP_DONE_KEY] === 1) return null;
  const play = state.ctx.offensivePlay;
  const holds = state.ball.phase === 'held' && state.ball.carrierId === athlete.id;
  if (!PASS_DROP_TYPES.has(play.type) || !holds || state.pass !== null) return null;
  if (Math.hypot(input.move.x, input.move.y) >= AUTO_DROP_OVERRIDE) {
    sc[USER_DROP_DONE_KEY] = 1;
    return null;
  }
  const face = state.ctx.direction === 1 ? Math.PI / 2 : -Math.PI / 2;
  const T = (state.tick - state.snapTick) * TICK_DT;
  const fakeRole = play.fakeTo ?? (athlete.assignment.type === 'qb' ? athlete.assignment.fakeTo : undefined);
  const back = fakeRole ? state.athletes.find((a) => a.side === 'offense' && a.role === fakeRole && a.active) : undefined;
  if (play.type === 'playAction' && back && T < FAKE_SECONDS + 0.2) {
    const to = sub(back.pos, athlete.pos);
    const d = len(to);
    return { move: d > 1 ? normalize(to) : { x: 0, y: 0 }, face: angle(to), debug: 'auto drop: play fake' };
  }
  const align = routeAlignment(athlete, state);
  const depth = dropbackDepth(play, -align.y, state.ctx.ballOn);
  const set = toField({ x: align.x, y: -depth }, state);
  const to = sub(set, athlete.pos);
  if (-toLocal(athlete.pos, state).y >= depth - 0.15 || len(to) < 0.25) {
    sc[USER_DROP_DONE_KEY] = 1;
    return null;
  }
  // Gather at the top of the drop instead of running through it.
  const gather = Math.min(1, Math.max(0.3, len(to) / DROP_SETTLE_YARDS));
  const dir = normalize(to);
  return { move: { x: dir.x * gather, y: dir.y * gather }, face, debug: 'auto drop' };
};

/** Seconds between a passer's pocket hitches, how long each lasts, and its stick deflection. */
export const FEET_ALIVE_PERIOD = 1.1;
export const FEET_ALIVE_STEP = 0.25;
const FEET_ALIVE_MOVE = 0.3;

/**
 * Feet alive: a human passer standing in the pocket with the stick at rest (reading the field, aiming a pull-back
 * throw) keeps his feet under him with a small hitch every FEET_ALIVE_PERIOD, alternately up and back, instead of
 * standing dead still (which the engine's stall net would whistle as a runner stopped). Any stick input is his.
 * Returns the move for this tick, or null.
 */
export const feetAlive = (athlete: Athlete, input: UserPlayInput, state: PlayState): Vec2 | null => {
  if (state.phase !== 'live' || athlete.side !== 'offense' || athlete.assignment.type !== 'qb' || state.pass !== null) return null;
  const holds = state.ball.phase === 'held' && state.ball.carrierId === athlete.id;
  if (!holds || !PASS_DROP_TYPES.has(state.ctx.offensivePlay.type) || input.strafe || Math.hypot(input.move.x, input.move.y) > 0.05) return null;
  if (state.ctx.direction * (athlete.pos.y - state.losY) > -1) return null;
  const T = (state.tick - state.snapTick) * TICK_DT;
  if (T < FEET_ALIVE_PERIOD || T % FEET_ALIVE_PERIOD > FEET_ALIVE_STEP) return null;
  const up = Math.floor(T / FEET_ALIVE_PERIOD) % 2 === 0 ? 1 : -1;
  return { x: 0, y: state.ctx.direction * up * FEET_ALIVE_MOVE };
};

/**
 * A human kicker's stick aims the kick (kicking.ts reads move.x while the meter runs), so it must not also walk him:
 * he holds still while the meter is sweeping, and while a punt snap is still on its way (drifting away from it muffs
 * the snap). Once he holds the ball with the meter idle he may move (a fake), and after the kick he covers normally.
 */
export const kickerHoldsStill = (athlete: Athlete, state: PlayState): boolean => {
  const meter = state.kickMeter;
  if (!meter || meter.phase === 'done' || athlete.side !== 'offense' || state.phase !== 'live') return false;
  if (meter.phase === 'power' || meter.phase === 'accuracy') return true;
  const secured = state.ball.phase === 'held' && state.ball.carrierId === athlete.id;
  return !secured && state.ball.kind === 'snap';
};

export const userControl = (athlete: Athlete, input: UserPlayInput & UserThrowSpot, state: PlayState, uc: UserControlContext): AthleteIntent => {
  const intent = idleIntent('user');
  intent.move = kickerHoldsStill(athlete, state) ? { x: 0, y: 0 } : { x: input.move.x, y: input.move.y };
  intent.sprint = input.sprint;
  if (input.strafe) {
    const face = angle(sub(state.ball.pos, athlete.pos));
    const mv = intent.move;
    const moving = Math.hypot(mv.x, mv.y) > 0.05;
    const fwd = moving ? (mv.x * Math.cos(face) + mv.y * Math.sin(face)) / Math.hypot(mv.x, mv.y) : 0;
    intent.locomotion = fwd < -0.3 ? 'backpedal' : 'strafe';
    intent.face = face;
  }
  if (state.phase === 'presnap') {
    // The alignment the called drop is measured from (captured before the snap moves him).
    if (athlete.assignment.type === 'qb') routeAlignment(athlete, state);
    if (athlete.side === 'offense') {
      // The offense is set before the snap: a held stick must not walk the quarterback (or the kicker) off his
      // alignment, let alone through the line with the snap following him. Pre-snap motion is the AI's.
      intent.move = { x: 0, y: 0 };
      intent.sprint = false;
      if (input.snap) intent.action = 'snap';
      if (input.audible) {
        intent.action = 'audible';
        intent.audible = input.audible;
      }
    } else if (input.defAudible) {
      intent.action = 'audible';
      intent.audible = input.defAudible;
    }
    return intent;
  }
  if (autoReturning(athlete, state)) {
    if (!touchedReturn(input)) {
      const ai = decideIntent(athlete, state, TICK_DT);
      return { ...ai, debug: `auto return: ${ai.debug}` };
    }
    takeOverReturn(state, athlete);
  }
  if (autoExchange(athlete, input, state)) {
    const ai = decideIntent(athlete, state, TICK_DT);
    return { ...ai, debug: `auto exchange: ${ai.debug}` };
  }
  const drop = autoDrop(athlete, input, state);
  if (drop) {
    intent.move = drop.move;
    intent.sprint = false;
    intent.locomotion = 'backpedal';
    intent.face = drop.face;
    intent.debug = drop.debug;
    if (drop.debug.endsWith('fake')) intent.locomotion = 'run';
  } else {
    const feet = feetAlive(athlete, input, state);
    if (feet) {
      intent.move = feet;
      intent.locomotion = 'strafe';
      intent.face = state.ctx.direction === 1 ? Math.PI / 2 : -Math.PI / 2;
      intent.debug = 'pocket: feet alive';
    }
  }
  const holder = state.ball.carrierId === athlete.id && state.ball.phase === 'held';
  if (holder) {
    if (input.throwAway) {
      intent.action = 'throwAway';
      intent.throwType = 'throwAway';
    } else if (input.throwTo !== null) {
      const role = uc.receiverSlots[input.throwTo];
      if (role) {
        intent.action = 'throw';
        intent.targetId = athleteId('offense', role);
        intent.throwType = input.throwType;
      }
    } else if (input.throwSpot) {
      // Pull-back pass: thrown to a spot, not to a receiver (the passing system decides who it is for).
      intent.action = 'throw';
      intent.targetId = null;
      intent.throwTarget = { x: input.throwSpot.x, y: input.throwSpot.y };
      intent.throwType = input.throwType;
    } else if (input.pitch) {
      const target = nearestTrailingTeammate(state, athlete, attackOf(state, athlete.side));
      if (target) {
        intent.action = 'pitch';
        intent.targetId = target.id;
      }
    } else if (athlete.state === 'wrapped') heldCarrierAction(intent, input);
    else if (input.slide) intent.action = 'slide';
    else if (input.juke) intent.action = 'juke';
    else if (input.spin) intent.action = 'spin';
    else if (input.stiffArm) intent.action = 'stiffArm';
    else if (input.hurdle) intent.action = 'hurdle';
    else if (input.dive) intent.action = 'dive';
    return intent;
  }
  const carrier = opposingCarrier(state, athlete);
  const read = carrier ? readCarrier(athlete, carrier) : null;
  const sc = athlete.ai.scratch;
  if (input.hitStick) sc[HIT_COMMIT_KEY] = state.time;
  if (input.tackle) sc[TACKLE_BUFFER_KEY] = state.time;
  // A tackle press is buffered briefly, so a press a beat early still finishes a runner who stumbles off the hit.
  const tackle = input.tackle || state.time - (sc[TACKLE_BUFFER_KEY] ?? -Infinity) <= TACKLE_BUFFER_SECONDS;
  if (carrier && read && !committedToHit(athlete, state)) applyBreakdown(intent, athlete, carrier, state, read, tackle);
  if (input.hitStick) intent.action = 'hitStick';
  else if (input.strip) intent.action = 'strip';
  else if (tackle && carrier && read) {
    // Wrap on contact; lay out only for a carrier who is getting away (special-moves never lunges a human 'tackle').
    const lunge = shouldLunge(read);
    intent.action = lunge ? 'dive' : 'tackle';
    intent.targetId = carrier.id;
    if (lunge) delete sc[TACKLE_BUFFER_KEY];
  } else if (input.tackle) intent.action = 'tackle'; // hanging on to a runner: holding the button keeps the grip
  else if (input.jumpSwat) intent.action = state.ball.phase === 'inAir' && state.ball.z <= 1.7 && athlete.side === 'defense' ? 'swat' : 'jump';
  else if (input.fairCatch) intent.action = 'fairCatch';
  else if (input.dive) intent.action = 'dive';
  return intent;
};

/**
 * A human runner held in a tackle struggle (systems/tackle-struggle.ts): the stick is his leg drive (upfield churns
 * for more yards, sprint digs in harder, nothing lets the tackler drive him back), and the move buttons are break attempts: juke, spin and
 * stiff-arm as usual, and the hurdle button lowers the shoulder (a truck: nobody hurdles out of a wrap). The struggle
 * itself rations the attempts (one per BREAK_COOLDOWN, each failure weaker), so mashing buys nothing.
 */
export const heldCarrierAction = (intent: AthleteIntent, input: UserPlayInput): void => {
  if (input.juke) intent.action = 'juke';
  else if (input.spin) intent.action = 'spin';
  else if (input.stiffArm) intent.action = 'stiffArm';
  else if (input.hurdle) intent.action = 'truck';
  intent.debug = 'user: held';
};

/** Makes `id` the controlled athlete for `side`, keeping the per-athlete flags in sync. */
export const setControlled = (state: PlayState, side: TeamSide, id: AthleteId): void => {
  for (const a of state.athletes) if (a.teamSide === side) a.controlled = a.id === id;
  state.controlledIds[side] = id;
  if (state.ctx.userSide === side) state.controlledId = id;
};

/** Where a defender should look: the ball, or its landing point while airborne. */
export const ballFocus = (state: PlayState): Vec2 => {
  if (state.ball.phase === 'inAir') return predictLanding(state.ball, state.ctx.weather, 1.2).pos;
  return state.ball.pos;
};

/** States in which a man cannot help right now: the switch button passes over him. */
const BUSY: ReadonlySet<Athlete['state']> = new Set(['engaged', 'down', 'tackled', 'wrapping', 'falling']);

/**
 * Handles switchPlayer / switchToId for a human side: the nearest active athlete to the ball (or its predicted
 * landing point), preferring athletes who are free (not engaged, down or already hanging on to the runner). Never switches to an inactive athlete.
 * Emits 'switchPlayer'. Returns the new controlled id or null when nothing changed.
 */
export const switchControlled = (state: PlayState, side: TeamSide, input: UserPlayInput): AthleteId | null => {
  if (!input.switchPlayer && input.switchToId === null) return null;
  const current = state.controlledIds[side] ?? null;
  const athleteSide: Side = side === state.ctx.offense ? 'offense' : 'defense';
  let target: Athlete | null = null;
  if (input.switchToId !== null) {
    const a = findAthlete(state, input.switchToId);
    if (a && a.active && a.side === athleteSide) target = a;
  }
  if (!target && input.switchToId !== null) return null;
  if (!target) {
    const focus = ballFocus(state);
    // Men who cannot help right now (blocked, on the ground, already hanging on to the runner) come last.
    const score = (a: Athlete): number => dist(a.pos, focus) + (BUSY.has(a.state) ? 6 : 0);
    target = state.athletes.filter((a) => a.active && a.side === athleteSide && a.id !== current).sort((p, q) => score(p) - score(q))[0] ?? null;
  }
  if (!target || target.id === current) return null;
  setControlled(state, side, target.id);
  state.events.push({ type: 'switchPlayer', tick: state.tick, to: target.id, side });
  return target.id;
};

/** Moves a human side's control to its ball carrier (handoff, pitch, catch, interception, recovery). */
export const syncControlToCarrier = (state: PlayState, side: TeamSide, kickPending = false): void => {
  if (state.ctx.controllers[side] !== 'human') return;
  if (kickPending && side === state.ctx.offense) return;
  const carrier = ballCarrier(state);
  if (!carrier || !carrier.active || carrier.teamSide !== side || state.ball.phase !== 'held') return;
  if (state.controlledIds[side] === carrier.id) return;
  setControlled(state, side, carrier.id);
  state.events.push({ type: 'switchPlayer', tick: state.tick, to: carrier.id, side });
};

/* ------------------------------------ Tackle assist ------------------------------------ */

/**
 * The human defender's tackle assist, the counterpart of the AI's breakdown in src/ai/tackling.ts. Closing on a
 * carrier who is coming at him, the user's defender breaks down: no burst, BREAKDOWN_EFFORT of his top speed, his
 * shoulders squared to the runner, reading the runner's cut (userTackleAssist sets how much of the cut he reads and
 * how much of the approach the assist steers). The tackle button wraps up in contact range and lunges only at a
 * carrier who would otherwise get away, never at one running toward him. Meeting the runner square and under
 * control makes a form tackle (systems/tackle.ts formTackle) rather than an open-field grab. A user who wants the
 * full-speed big hit presses hit stick, which commits him through the breakdown (and gets him juked more often).
 */
/** Yards inside which the user's defender breaks down on a carrier coming at him. */
export const BREAKDOWN_RANGE = 3;
/** ...or seconds before contact at the current closing rate (a head-on closing speed eats 3 yd in a blink). */
export const BREAKDOWN_SECONDS = 0.3;
/** Farthest out (yards) the breakdown starts however fast the two are closing. */
export const BREAKDOWN_MAX_RANGE = 6;
/** Share of his (burst-free) top speed a broken-down defender keeps: under control, feet under him. */
export const BREAKDOWN_EFFORT = 0.8;
/** Carrier speed toward the defender (yd/s) above which the carrier is coming at him. */
export const ONCOMING_SPEED = 1;
/** Gap closing rate (yd/s) at or below which a carrier beyond contact reach is getting away. */
export const ESCAPE_CLOSING = 0.5;
/** Farthest (centre to centre, yards) the tackle button lays out from. */
export const LUNGE_REACH = 2.4;
/** Extra reach over the two radii at which the engine resolves contact (systems/tackle.ts TACKLE_REACH). */
const CONTACT_MARGIN = 0.3;
/** Seconds of the carrier's lateral motion the approach leads by at full assist: reading the cut. */
export const JUKE_READ_SECONDS = 0.35;
/** The stick must point within ~60 degrees of the carrier for the assist to take the approach. */
const AIM_COS = 0.5;
/** Seconds after a hit-stick press during which the defender stays committed to the full-speed hit (no breakdown). */
export const HIT_COMMIT_SECONDS = 0.6;
const HIT_COMMIT_KEY = 'userHitStickT';
/** Seconds a tackle press stays live (input buffering: wrap on the contact it was pressed for, or lunge at the escape). */
export const TACKLE_BUFFER_SECONDS = 0.4;
const TACKLE_BUFFER_KEY = 'userTackleT';
/** userTackleAssist for a profile that predates the knob (the pro preset). */
export const DEFAULT_TACKLE_ASSIST = 0.5;

export interface CarrierRead {
  /** Centre-to-centre distance (yards). */
  distance: number;
  /** Carrier speed toward the defender (yd/s; negative when running away from him). */
  oncoming: number;
  /** Rate the gap is closing (yd/s; negative when it is opening). */
  closing: number;
  /** Distance at which the engine resolves contact. */
  contactReach: number;
}

/** The opposing ball carrier the user's defender can tackle, if the ball is held by one. */
const opposingCarrier = (state: PlayState, athlete: Athlete): Athlete | null => {
  if (state.ball.phase !== 'held' || athlete.hasBall) return null;
  const c = ballCarrier(state);
  return c && c.active && c.side !== athlete.side && c.state !== 'tackled' ? c : null;
};

/** Geometry of the defender vs the carrier. */
export const readCarrier = (athlete: Athlete, carrier: Athlete): CarrierRead => {
  const to = sub(carrier.pos, athlete.pos);
  const d = Math.max(len(to), 1e-6);
  return {
    distance: d,
    oncoming: -dot(carrier.vel, to) / d,
    closing: -dot(sub(carrier.vel, athlete.vel), to) / d,
    contactReach: athlete.radius + carrier.radius + CONTACT_MARGIN,
  };
};

/** True when the tackle button should lay out: the carrier is out of contact reach, inside lunge reach and getting away. */
export const shouldLunge = (r: CarrierRead): boolean =>
  r.distance > r.contactReach && r.distance <= LUNGE_REACH && r.oncoming <= ONCOMING_SPEED && r.closing <= ESCAPE_CLOSING;

/** True while the user's defender is committed to a hit stick he pressed (he runs through at full speed instead). */
export const committedToHit = (athlete: Athlete, state: PlayState): boolean => {
  const t = athlete.ai.scratch[HIT_COMMIT_KEY];
  return t !== undefined && state.time - t <= HIT_COMMIT_SECONDS;
};

/** The user's tackle assist from his team's difficulty profile (`who`: the user's defender; default the viewer's side). */
export const userTackleAssist = (state: PlayState, who?: Pick<Athlete, 'teamSide'>): number => {
  const side = who?.teamSide ?? state.ctx.userSide;
  return clamp01((side ? difficultyFor(state, side) : state.ctx.difficulty).userTackleAssist ?? DEFAULT_TACKLE_ASSIST);
};

/**
 * Breaks the user's defender down on a carrier coming at him (see the section doc). Applies only while the stick
 * points at the carrier (or tackle is pressed) so a user steering elsewhere keeps full control. Returns true when
 * it took the approach.
 */
export const applyBreakdown = (intent: AthleteIntent, athlete: Athlete, carrier: Athlete, state: PlayState, r: CarrierRead, tackle: boolean): boolean => {
  if (intent.locomotion !== 'run') return false;
  const stick = len(intent.move);
  const u = { x: (carrier.pos.x - athlete.pos.x) / r.distance, y: (carrier.pos.y - athlete.pos.y) / r.distance };
  const aimed = stick > 0.05 && dot(intent.move, u) / stick >= AIM_COS;
  if (!aimed && !tackle) return false;
  const range = Math.min(BREAKDOWN_MAX_RANGE, Math.max(BREAKDOWN_RANGE, r.closing * BREAKDOWN_SECONDS));
  if (r.distance > range || r.oncoming <= ONCOMING_SPEED) return false;
  // Like the AI's rushers, nobody breaks down on a quarterback still behind the line: he finishes the sack.
  if (carrier.side === 'offense' && carrier.position === 'QB' && state.ctx.direction * (carrier.pos.y - state.losY) < 0) return false;
  const assist = userTackleAssist(state, athlete);
  // Lead only the carrier's motion across the line between them: along it he is coming at us anyway.
  const along = dot(carrier.vel, u);
  const lat = { x: carrier.vel.x - u.x * along, y: carrier.vel.y - u.y * along };
  const lead = JUKE_READ_SECONDS * assist;
  const square = normalize({ x: carrier.pos.x + lat.x * lead - athlete.pos.x, y: carrier.pos.y + lat.y * lead - athlete.pos.y });
  const own = aimed ? { x: intent.move.x / stick, y: intent.move.y / stick } : square;
  const w = 0.5 + 0.5 * assist;
  const dir = normalize({ x: own.x * (1 - w) + square.x * w, y: own.y * (1 - w) + square.y * w });
  const effort = aimed ? Math.min(stick, BREAKDOWN_EFFORT) : BREAKDOWN_EFFORT;
  intent.move = { x: dir.x * effort, y: dir.y * effort };
  intent.sprint = false;
  intent.debug = 'user: breakdown';
  return true;
};
