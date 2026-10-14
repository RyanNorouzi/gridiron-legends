import type { PlayerId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp } from '@/core/math';
import { clone, type Vec2 } from '@/core/vec2';
import type { InjurySeverity, Player } from '@/players/types';
import type { FormationSlot } from '@/playbook/types';
import type { AthleteIntent, LivePlayOptions } from '../engine-api';
import type { AthleteId, BreakMove, CatchKind, DeadReason, KickKind, PenaltyInfo, PlayEvent, ReviewableCall, TackleKind } from '../play-events';
import type { Athlete, PlayContext, PlayState, UserInputs } from '../play-types';
import { ballOnFromY, fieldY, FIELD_LENGTH, FIELD_WIDTH, type Direction, type Side } from '../types';

/**
 * Engine-private scratch state shared by the live-play systems. PlayState is the canonical, renderable
 * state; EngineEnv carries the bookkeeping the systems need between ticks (engagements, timers, credits,
 * facts for the outcome builder) so nothing leaks into the contract types.
 */
export interface AthleteTrack {
  distance: number;
  sprintSeconds: number;
  contacts: number;
  prev: Vec2;
}

export interface Engagement {
  blockerId: AthleteId;
  rusherId: AthleteId;
  kind: 'run' | 'pass';
  /** Seconds until the next contest re-roll. */
  timer: number;
  age: number;
  /** Drift applied to the pair while engaged (yd/s, blocker -> rusher). */
  push: Vec2;
  /** Last contest score (blocker power - rusher power): positive = the blocker is winning. */
  score: number;
}

export interface KickRecord {
  kind: KickKind;
  kicker: AthleteId;
  power: number;
  accuracy: number;
  kickTick: number;
  kickSpot: Vec2;
  made: boolean | null;
  /** Nominal carry from the kick spot (yd). */
  carry: number;
  /** Where the ball first came down (caught or turf); null while airborne. */
  landing: Vec2 | null;
  fieldedBy: AthleteId | null;
  returnStart: Vec2 | null;
  blocked: boolean;
  /** A loose kick touched by the kicking team (onside / downed). */
  touchedByKickingTeam: boolean;
  /** Seconds a human returner has stood with the ball in his own end zone without heading out (kick-flight.ts). */
  endZoneIdle?: number;
}

export interface CompletionRecord {
  receiverId: AthleteId;
  tick: number;
  pos: Vec2;
  airYards: number;
  contested: boolean;
  catchKind: CatchKind;
}

export interface FumbleRecord {
  carrierId: AthleteId;
  carrierSide: Side;
  forcedBy: AthleteId | null;
  pos: Vec2;
  tick: number;
  recoveredBy: AthleteId | null;
  recoverySide: Side | null;
  /** A kick that was never possessed (muffed catch), as opposed to a returner fumbling after he fielded it. */
  muff?: boolean;
}

export interface TackleRecord {
  tackler: AthleteId;
  assists: AthleteId[];
  kind: TackleKind;
  carrier: AthleteId;
  pos: Vec2;
  tick: number;
}

/** One defender hanging on to the runner in a tackle struggle (systems/tackle-struggle.ts). */
export interface PileMember {
  id: AthleteId;
  joinedAt: number;
  /** Grip 0..~1.5 (physics/contact.ts holdStrength). */
  hold: number;
  kind: TackleKind;
  /** Where he is, relative to the runner's centre (slides from where he grabbed on to `hang`, never a jump). */
  offset: Vec2;
  /** Where he hangs on once settled, relative to the runner's centre (beside the men already there). */
  hang: Vec2;
}

/** A tackle in progress: the runner is held but still fighting (athlete states 'wrapped' / 'wrapping'). */
export interface StruggleState {
  carrierId: AthleteId;
  startedAt: number;
  startPos: Vec2;
  /** Furthest absolute y the runner has reached in his attack direction since the hold (the forward-progress spot). */
  bestY: number;
  /** Seconds of accumulated no forward progress (stood up / driven back): the whistle blows at STOOD_UP_SECONDS. */
  stalled: number;
  /** In join order; the first is the primary tackler. */
  tacklers: PileMember[];
  /** Velocity of the coupled pile (yd/s). */
  vel: Vec2;
  /** The runner's position when the struggle last moved him (the pile's own integration point). */
  pos: Vec2;
  /** Break move being attempted, until `breakUntil`; the next attempt may start at `nextBreakAt`. */
  breakMove: BreakMove | null;
  breakUntil: number;
  nextBreakAt: number;
  failedBreaks: number;
  /** A passer held behind the line may still get the ball away until this play time (in the grasp); null = not a passer. */
  graspUntil: number | null;
}

/**
 * A change of possession near the new owner's own goal line, decided from the carrier's BODY (never the ball, which
 * sits a yard in front of him at the catch): whether he has been in the field of play since he got the ball (a man
 * downed in his end zone who never left it is a touchback, one who left and came back is a safety), and the momentum
 * exception (caught in the field inside MOMENTUM_ZONE yards, carried into the end zone by the catch itself within
 * MOMENTUM_SECONDS: the ball is his at the catch spot).
 */
export interface OwnZoneTrack {
  left: boolean;
  catchSpot: Vec2;
  catchTime: number;
  momentum: boolean;
}
export const MOMENTUM_ZONE = 5;
export const MOMENTUM_SECONDS = 1.0;

/** The alternate ruling used to build PlayOutcome.review.ifOverturned. */
export interface AlternateRuling {
  deadReason: DeadReason;
  deadSpot: Vec2;
  /** The catch is ruled incomplete (completion wiped). */
  wipeCompletion: boolean;
  /** Down by contact before the ball came out: the fumble at this tick and everything after it never happened. */
  wipeFumbleAt?: number;
}

export interface ReviewCandidate {
  call: ReviewableCall;
  alternate: AlternateRuling;
}

export interface EngineEnv {
  ctx: PlayContext;
  rng: Rng;
  opts: LivePlayOptions;
  dir: Direction;
  offSlots: FormationSlot[];
  defSlots: FormationSlot[];
  /** Roster player behind each athlete (injury status, age, history). */
  players: Record<AthleteId, Player>;
  /** Snap receiver on scrimmage plays: QB, punter or holder. */
  qbId: AthleteId | null;
  snapperId: AthleteId | null;
  kickerId: AthleteId | null;
  holderId: AthleteId | null;
  designedCarrierId: AthleteId | null;
  snapCadence: number;
  kickCadence: number;
  snapped: boolean;
  /** A human kicker's first meter press asks for the long snap (punt / field goal). */
  snapRequested: boolean;
  tracks: Record<AthleteId, AthleteTrack>;
  engagements: Engagement[];
  pairCooldown: Record<string, number>;
  /** pairKey(blocker, rusher) -> play time before which that pair may not engage again (a beaten block stays beaten). */
  blockCooldown: Record<string, number>;
  hitStickPress: Record<AthleteId, number>;
  stripPress: Record<AthleteId, number>;
  fairCatchSignal: Record<AthleteId, boolean>;
  invulnerableUntil: Record<AthleteId, number>;
  recoveryCooldown: Record<AthleteId, number>;
  ballStep: { hitGround: boolean; bounced: boolean; settled: boolean };
  penalties: PenaltyInfo[];
  injuries: { playerId: PlayerId; severity: InjurySeverity }[];
  injuredIds: Set<AthleteId>;
  review: ReviewCandidate | null;
  handoffDone: boolean;
  playActionFaked: boolean;
  pitched: boolean;
  passerId: AthleteId | null;
  releaseTime: number | null;
  /** The pass in the air is off target (1 sailed, -1 died short; 0 / undefined on target): set at release. */
  errantPass?: number;
  /**
   * A throw in its wind-up: released at `releaseAt` unless the passer is brought down first. `motion` is the passer's
   * velocity when he started the motion, so planting for the throw does not erase the cost of throwing on the run.
   */
  pendingThrow?: { passerId: AthleteId; intent: AthleteIntent; releaseAt: number; motion: Vec2 } | null;
  completion: CompletionRecord | null;
  interception: { by: AthleteId; pos: Vec2; tick: number } | null;
  sack: { by: AthleteId; assists: AthleteId[]; yardsLost: number } | null;
  fumbles: FumbleRecord[];
  muffed: boolean;
  /** Offense athlete credited with the rush (handoff / pitch / keeper). */
  rusherId: AthleteId | null;
  carrierHistory: AthleteId[];
  lastTackle: TackleRecord | null;
  tackleRecords: TackleRecord[];
  kick: KickRecord | null;
  kickAim: number;
  kickReady: boolean;
  /** This tick's human inputs (the kick meter reads presses straight from them). */
  inputs: UserInputs;
  meterTime: number;
  holdStart: number | null;
  pressureIds: Set<AthleteId>;
  coverDefenderId: AthleteId | null;
  shedBy: Record<AthleteId, AthleteId>;
  /** Side entitled to the ball right now (flips on interceptions / defensive recoveries / kick receptions). */
  possession: Side;
  stallTime: number;
  progressStallTime: number;
  liveTime: number;
  deadTime: number | null;
  firstDownFlagged: boolean;
  audibleTried: Record<string, boolean>;
  penaltyRolled: Record<string, boolean>;
  contactPairs: Record<string, number>;
  slideSpot: Vec2 | null;
  /** Athletes that may not be re-tackled (down after a dive / kneel). */
  lateHitWindowUntil: number | null;
  /** The tackle struggle in progress (absent / null = none). Owned by systems/tackle-struggle.ts. */
  struggle?: StruggleState | null;
  /** Own-end-zone bookkeeping since the last change of possession (absent / null = none yet). */
  ownZone?: OwnZoneTrack | null;
  /** The passer's depth (yd behind the line, negative) when he first held the snap and the deepest he went before the ball left (play-by-play). */
  qbDrop?: { start: number; deepest: number } | null;
}

/** Fresh per-athlete effort tracker. */
export const createTrack = (pos: Vec2): AthleteTrack => ({ distance: 0, sprintSeconds: 0, contacts: 0, prev: clone(pos) });

export const emit = (state: PlayState, event: PlayEvent): void => {
  state.events.push(event);
};

/** Marks the play dead exactly once; the first caller wins. Emits the whistle. */
export const markDead = (state: PlayState, env: EngineEnv, reason: DeadReason, spot: Vec2): boolean => {
  if (state.phase === 'dead') return false;
  state.phase = 'dead';
  state.deadReason = reason;
  state.deadSpot = { x: clamp(spot.x, 0, FIELD_WIDTH), y: clamp(spot.y, 0, FIELD_LENGTH) };
  env.deadTime = state.time;
  releasePile(state, env);
  emit(state, { type: 'whistle', tick: state.tick, reason });
  return true;
};

/**
 * Ends any tackle struggle without a ruling (the whistle blew for something else: out of bounds, a touchdown, time):
 * the runner is loose again and the men hanging on are just finishing their tackle. Bodies keep their velocities.
 */
export const releasePile = (state: PlayState, env: EngineEnv): void => {
  if (!env.struggle) return;
  env.struggle = null;
  for (const a of state.athletes) {
    if (a.state === 'wrapped') setTimedState(a, 'moving', 0);
    else if (a.state === 'wrapping') setTimedState(a, 'tackling', 0.4);
  }
};

/** Direction of attack for a side (the receiving/defending side attacks the other way). */
export const attackDir = (env: EngineEnv, side: Side): Direction => (side === 'offense' ? env.dir : env.dir === 1 ? -1 : 1);

/** Absolute y of the goal line a side is attacking. */
export const goalLineY = (env: EngineEnv, side: Side): number => (side === 'offense' ? fieldY(100, env.dir) : fieldY(0, env.dir));

/** Yards downfield of the LOS in the offense's direction (negative = behind). */
export const depthOf = (state: PlayState, y: number): number => state.ctx.direction * (y - state.losY);

/** Offense-perspective yard line for an absolute y, clamped to [0, 100]. */
export const ballOnAt = (env: EngineEnv, y: number): number => clamp(ballOnFromY(y, env.dir), 0, 100);

export const inField = (p: Vec2): boolean => p.x >= 0 && p.x <= FIELD_WIDTH && p.y >= 0 && p.y <= FIELD_LENGTH;

export const pairKey = (a: AthleteId, b: AthleteId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Active, on his feet and free to act (not engaged, down, tackled, hanging on to a runner or going to the ground). */
export const canAct = (a: Athlete): boolean =>
  a.active && a.state !== 'tackled' && a.state !== 'down' && a.state !== 'engaged' && a.state !== 'stumbling' && a.state !== 'sliding'
  && a.state !== 'wrapping' && a.state !== 'falling';

export const isHuman = (ctx: PlayContext, a: Athlete): boolean => ctx.controllers[a.teamSide] === 'human';

export const opponentsOf = (state: PlayState, a: Athlete): Athlete[] => state.athletes.filter((o) => o.active && o.side !== a.side);

export const teammatesOf = (state: PlayState, a: Athlete): Athlete[] => state.athletes.filter((o) => o.active && o.side === a.side && o.id !== a.id);

/** Clears every engagement and the engaged states (change of possession, whistle). */
export const clearEngagements = (state: PlayState, env: EngineEnv): void => {
  for (const e of env.engagements) {
    for (const id of [e.blockerId, e.rusherId]) {
      const a = state.athletes.find((x) => x.id === id);
      if (a && a.state === 'engaged') a.state = 'moving';
      if (a) a.engagedWith = null;
    }
  }
  env.engagements = [];
};

/**
 * Records a new ball carrier: sets hasBall flags, possession side, forward-progress reset and the
 * carrier history. The caller has already put the ball in his hands (holdBall).
 */
export const takePossession = (state: PlayState, env: EngineEnv, athlete: Athlete): void => {
  for (const a of state.athletes) a.hasBall = a.id === athlete.id;
  if (env.possession !== athlete.side) {
    env.possession = athlete.side;
    const own = ownGoalLineY(env, athlete.side);
    env.ownZone = { left: attackDir(env, athlete.side) * (athlete.pos.y - own) > 0, catchSpot: clone(athlete.pos), catchTime: state.time, momentum: false };
    state.forwardProgressY = null;
    state.firstContactY = null;
    clearEngagements(state, env);
  }
  env.carrierHistory.push(athlete.id);
  env.stallTime = 0;
  env.progressStallTime = 0;
};

/** Ball carrier spot honouring forward progress (the furthest point reached while in bounds). */
export const progressSpot = (state: PlayState, env: EngineEnv, carrier: Athlete): Vec2 => {
  const d = attackDir(env, carrier.side);
  const fp = state.forwardProgressY;
  const y = fp !== null && d * (fp - carrier.pos.y) > 0 ? fp : carrier.pos.y;
  return { x: carrier.pos.x, y };
};

/** Records contact for gang-tackle timing and the fatigue tracker. */
export const noteContact = (env: EngineEnv, a: Athlete): void => {
  a.contactTimer = 0;
  const t = env.tracks[a.id];
  if (t) t.contacts += 1;
};

/** Sets a timed state (juking, stumbling, ...) on an athlete. */
export const setTimedState = (a: Athlete, state: Athlete['state'], seconds: number): void => {
  a.state = state;
  a.stateTimer = seconds;
};

/** Own goal line of a side (the line behind which it is a safety / touchback). */
export const ownGoalLineY = (env: EngineEnv, side: Side): number => goalLineY(env, side === 'offense' ? 'defense' : 'offense');

/**
 * Per-tick own-end-zone bookkeeping for the ball carrier (OwnZoneTrack): his body in the field of play means he has
 * left the end zone; entering it straight off a catch made in the field inside MOMENTUM_ZONE is the momentum exception.
 */
export const trackOwnZone = (state: PlayState, env: EngineEnv, carrier: Athlete): void => {
  const z = env.ownZone;
  if (!z || carrier.side !== env.possession) return;
  const attack = attackDir(env, carrier.side);
  const own = ownGoalLineY(env, carrier.side);
  if (attack * (carrier.pos.y - own) > 0) {
    z.left = true;
    z.momentum = false;
    return;
  }
  const caughtNear = attack * (z.catchSpot.y - own) > 0 && attack * (z.catchSpot.y - own) <= MOMENTUM_ZONE;
  if (!z.momentum && caughtNear && state.time - z.catchTime <= MOMENTUM_SECONDS && z.left) z.momentum = true;
};

/**
 * The ball carrier is down at `spot` for `reason`: resolves touchdown (ball across the goal line he attacks),
 * safety / touchback (down behind his own goal line) or an ordinary dead ball, and flags a reviewable
 * touchdown call when the ruling is within GOAL_REVIEW_MARGIN of the goal line.
 */
export const GOAL_REVIEW_MARGIN = 0.3;

export const carrierDown = (state: PlayState, env: EngineEnv, carrier: Athlete, spot: Vec2, reason: DeadReason): void => {
  if (state.phase === 'dead') return;
  const attack = attackDir(env, carrier.side);
  const goal = goalLineY(env, carrier.side);
  const own = ownGoalLineY(env, carrier.side);
  const across = attack * (spot.y - goal);
  if (across >= 0) {
    emit(state, { type: 'touchdown', tick: state.tick, scorer: carrier.id, side: carrier.side });
    markDead(state, env, 'touchdown', { x: spot.x, y: goal });
    if (reason === 'tackle' && across < GOAL_REVIEW_MARGIN && env.review === null) {
      env.review = {
        call: { kind: 'touchdown', tick: state.tick, athleteId: carrier.id, confidence: 0.55 + 0.45 * (across / GOAL_REVIEW_MARGIN) },
        alternate: { deadReason: 'tackle', deadSpot: { x: spot.x, y: goal - attack * 0.4 }, wipeCompletion: false },
      };
    }
    return;
  }
  if (attack * (spot.y - own) <= 0) {
    const zone = env.ownZone && carrier.side === env.possession ? env.ownZone : null;
    if (carrier.side === 'defense' && zone?.momentum) {
      markDead(state, env, reason, { x: zone.catchSpot.x, y: zone.catchSpot.y });
      return;
    }
    const left = zone ? zone.left : state.forwardProgressY !== null && attack * (state.forwardProgressY - own) > 0;
    if (carrier.side === 'defense' && !left) {
      emit(state, { type: 'touchback', tick: state.tick });
      markDead(state, env, 'touchback', { x: spot.x, y: own });
      return;
    }
    emit(state, { type: 'safety', tick: state.tick });
    markDead(state, env, 'safety', { x: spot.x, y: own });
    return;
  }
  markDead(state, env, reason, spot);
  if (reason === 'tackle' && -across < GOAL_REVIEW_MARGIN && env.review === null) {
    env.review = {
      call: { kind: 'touchdown', tick: state.tick, athleteId: carrier.id, confidence: 0.55 + 0.45 * (-across / GOAL_REVIEW_MARGIN) },
      alternate: { deadReason: 'touchdown', deadSpot: { x: spot.x, y: goal }, wipeCompletion: false },
    };
  }
};
