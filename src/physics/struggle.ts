import { clamp, clamp01, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { len, type Vec2 } from '@/core/vec2';
import type { Athlete } from '@/game/play-types';
import type { BreakMove, TackleKind } from '@/game/play-events';
import { BROKEN_TACKLE_WEAR } from './contact';

/**
 * The tackle struggle: once a tackler has hold of the runner (physics/contact.ts contactStart), every tick of the
 * struggle rolls whether the tackle finishes, the runner breaks free, or a defender in the pile strips the ball, and
 * the pile moves as one coupled mass. Pure and attribute-driven like the rest of physics/: positions and states are
 * the caller's (systems/tackle-struggle.ts). Only ratings, body mass and the human-only ball-security assist feed
 * the dice, never the difficulty.
 *
 * Hazard model: each outcome has a rate per second; a tick converts the rates to probabilities (1 - e^(-rate*dt))
 * and ONE uniform draw picks at most one of them (strip, then break, then finish), so a struggle consumes exactly one
 * rng draw per tick. The edge E = stopping power of the pile - the runner's resistance drives both the finish rate
 * (up with E, and with the time he has been held) and the break rate (down with E, and down again for every extra
 * defender): between even athletes a square wrap lasts ~0.4-0.9 s and holds ~85% of the time, an arm tackle breaks
 * far more often, and a second defender ends almost every struggle within a few tenths of a second.
 */

const f = (rating: number): number => ratingToFactor(rating);

/** 0..1 body-size share: 160 lb = 0, 320 lb = 1. */
export const massFactor = (lb: number): number => clamp01((lb - 160) / 160);

/** Stopping power of one tackler who has hold of the runner (before his grip): technique, strength, balance, size. */
export const stopPower = (t: Athlete): number =>
  0.5 * f(t.attrs.tackling) + 0.35 * f(t.attrs.strength) + 0.15 * f(t.attrs.balance) + 0.3 * massFactor(t.massLb);

/** A held runner's resistance: balance, strength, ball carrying, agility and size, worn down by fatigue and broken tackles. */
export const resistPower = (c: Athlete): number =>
  0.35 * f(c.attrs.balance) + 0.3 * f(c.attrs.strength) + 0.2 * f(c.attrs.carrying) + 0.15 * f(c.attrs.agility) + 0.3 * massFactor(c.massLb)
  - 0.25 * clamp01(c.fatigue) - BROKEN_TACKLE_WEAR * Math.min(4, c.brokenTacklesThisPlay);

/** One defender hanging on to the runner. */
export interface PileHold {
  tackler: Athlete;
  /** Grip 0..~1.5 (contact.ts holdStrength); a human who lets go of the tackle button loses it. */
  hold: number;
  kind: TackleKind;
  /** He is punching at the ball this tick. */
  stripping: boolean;
}

export interface StruggleInput {
  carrier: Athlete;
  /** In join order: the first is the primary tackler. */
  holds: readonly PileHold[];
  /** Seconds since the first hold. */
  heldFor: number;
  /** A break move the runner is attempting right now (null = just churning). */
  breakMove: BreakMove | null;
  /** Break attempts that already failed this struggle (each makes the next weaker: no button mashing). */
  failedBreaks: number;
  /** Offensive teammates legally pushing the pile (counted up to MAX_PUSHERS). */
  pushers: number;
  /** DifficultyProfile.userBallSecurityAssist when the runner is user-controlled, else 0. */
  ballSecurityAssist: number;
  dt: number;
}

export type StruggleResult = 'hold' | 'finish' | 'break' | 'strip';

export interface StruggleRoll {
  result: StruggleResult;
  /** The defender who knocked the ball out ('strip'). */
  stripBy: Athlete | null;
  /** Pile stopping power minus the runner's resistance. */
  edge: number;
  finishRate: number;
  breakRate: number;
  stripRate: number;
}

/** Leverage the defense has once it has hold: struggles between even athletes lean a little toward the tackle. */
export const STRUGGLE_EDGE = 0.15;
/**
 * Finish rate (per second) at zero edge, before the held-time ramp: quick enough that most tackles end one-on-one or
 * two-on-one (about 40% assisted, as in real football), slow enough that a runner still fights for the extra yard.
 */
export const FINISH_BASE = 1.2;
export const FINISH_SLOPE = 1.6;
/** Seconds over which a hold ramps from FINISH_RAMP_START to double strength (the longer he is held, the surer he goes down). */
export const FINISH_RAMP_SECONDS = 0.7;
export const FINISH_RAMP_START = 0.35;
/** Break rate (per second) at zero edge with no move (scaled with FINISH_BASE: a shorter struggle, the same odds). */
export const BREAK_BASE = 0.14;
export const BREAK_SLOPE = 2.5;
/** Break rate multiplier for every defender in the pile beyond the first. */
export const EXTRA_DEFENDER_BREAK = 0.4;
/** Share of his power each defender beyond the first adds (bodies get in each other's way). */
export const EXTRA_DEFENDER_STOP = 0.55;
/** Resistance each pushing teammate adds, and how many count. */
export const PUSH_RESIST = 0.06;
export const MAX_PUSHERS = 2;
/** Strip rate (per second) for one defender punching at an average runner's ball (scaled with FINISH_BASE). */
export const STRIP_BASE = 0.14;
/** Each failed break attempt keeps this share of the next one's bonus. */
export const FAILED_BREAK_DECAY = 0.65;

/**
 * Finish-rate multiplier by the primary tackler's kind of hold: a dive at the ankles trips the runner up quickly or not
 * at all (its weak grip makes the break likelier too), and a hit stick that did not put him straight down has still
 * rocked him.
 */
export const KIND_FINISH: Readonly<Partial<Record<TackleKind, number>>> = { dive: 2.5, hitStick: 2 };

/** Break-rate multiplier for the move being attempted: jukes and spins on agility, stiff-arms and trucks on strength and size. */
export const breakMoveBoost = (carrier: Athlete, move: BreakMove | null, failedBreaks: number): number => {
  if (move === null || move === 'none' || move === 'burst' || move === 'hurdle') return 1;
  const a = carrier.attrs;
  const skill = move === 'juke' || move === 'spin'
    ? f(a.agility) * 0.8 + f(a.balance) * 0.2
    : 0.55 * f(a.strength) + 0.25 * massFactor(carrier.massLb) + 0.2 * f(a.balance);
  return 1 + 2 * skill * FAILED_BREAK_DECAY ** Math.max(0, failedBreaks);
};

/** Stopping power of the whole pile. */
export const pileStop = (holds: readonly PileHold[]): number =>
  holds.reduce((s, h, i) => s + stopPower(h.tackler) * h.hold * (i === 0 ? 1 : EXTRA_DEFENDER_STOP), 0);

/** Per-second hazard rates for the current tick (see the module doc). */
export const struggleRates = (inp: StruggleInput): Omit<StruggleRoll, 'result' | 'stripBy'> => {
  const resist = resistPower(inp.carrier) + PUSH_RESIST * Math.min(MAX_PUSHERS, inp.pushers);
  const edge = pileStop(inp.holds) - resist + STRUGGLE_EDGE;
  const ramp = FINISH_RAMP_START + (2 - FINISH_RAMP_START) * clamp01(inp.heldFor / FINISH_RAMP_SECONDS);
  const kind = inp.holds[0]?.kind;
  const finishRate = FINISH_BASE * ramp * Math.exp(FINISH_SLOPE * edge) * (kind ? KIND_FINISH[kind] ?? 1 : 1);
  const extra = Math.max(0, inp.holds.length - 1);
  const breakRate = BREAK_BASE * Math.exp(-BREAK_SLOPE * edge) * EXTRA_DEFENDER_BREAK ** extra * breakMoveBoost(inp.carrier, inp.breakMove, inp.failedBreaks);
  const security = (1.4 - f(inp.carrier.attrs.carrying)) * (1 - 0.7 * clamp01(inp.ballSecurityAssist));
  let stripRate = 0;
  for (const h of inp.holds) if (h.stripping) stripRate += STRIP_BASE * security * (0.5 + 0.5 * f(h.tackler.attrs.strength) + 0.3 * f(h.tackler.attrs.tackling));
  return { edge, finishRate, breakRate, stripRate };
};

const hazard = (rate: number, dt: number): number => 1 - Math.exp(-Math.max(0, rate) * dt);

/** One tick of the struggle: exactly one rng draw. */
export const struggleTick = (inp: StruggleInput, rng: Rng): StruggleRoll => {
  const r = struggleRates(inp);
  const pS = hazard(r.stripRate, inp.dt);
  const pB = hazard(r.breakRate, inp.dt);
  const pF = hazard(r.finishRate, inp.dt);
  const u = rng.next();
  const base = { ...r, stripBy: null };
  if (u < pS) {
    const strippers = inp.holds.filter((h) => h.stripping);
    // The share of the strip chance each stripper holds decides who got the ball (no second draw).
    const who = strippers[Math.min(strippers.length - 1, Math.floor((u / Math.max(pS, 1e-9)) * strippers.length))];
    return { ...base, result: 'strip', stripBy: who?.tackler ?? null };
  }
  if (u < pS + pB) return { ...base, result: 'break' };
  if (u < pS + pB + pF) return { ...base, result: 'finish' };
  return { ...base, result: 'hold' };
};

/* --------------------------------- Pile motion --------------------------------- */

/** Acceleration (yd/s^2) an athlete's legs give his own mass at full drive. */
export const DRIVE_ACCEL = 6;
/** Velocity damping (1/s) of a pile: tangled bodies bleed speed. */
export const PILE_DAMPING = 0.8;
/** Fastest a pile moves (yd/s). */
export const PILE_MAX_SPEED = 3.5;
/** Share of his drive a pushing teammate adds. */
export const PUSHER_DRIVE = 0.5;
/**
 * Share of his leg drive a tackler gets into the pile: his arms are busy holding on.
 */
export const TACKLER_DRIVE = 0.55;
/** The runner's leg drive multiplier: pads low, legs free, churning for the extra yard. */
export const CARRIER_DRIVE = 1.6;
/**
 * Share of a tackler's own velocity that goes into the merged pile on a hold: a wrap catches the runner and absorbs him
 * rather than driving through him (a hit stick carries its full momentum, WRAP_MOMENTUM_HIT).
 */
export const WRAP_MOMENTUM = 0.4;
export const WRAP_MOMENTUM_HIT = 1;

/** 0.4..1 leg drive: strength, balance, acceleration. */
export const legDrive = (a: Athlete): number => 0.4 + 0.6 * (0.5 * f(a.attrs.strength) + 0.3 * f(a.attrs.balance) + 0.2 * f(a.attrs.acceleration));

/**
 * Leg drive each kind of hold lets a tackler put into the pile (times TACKLER_DRIVE, on top of his grip): a square hit
 * stick drives through the runner, a man who dove at him is on the turf hanging on to his legs.
 */
export const KIND_DRIVE: Readonly<Record<TackleKind, number>> = { hitStick: 2, wrap: 1, gang: 1, strip: 1, openField: 1, arm: 1, dive: 0.6 };

/** Drive a tackler puts into the pile with grip `hold` on a hold of `kind` (leg drive x TACKLER_DRIVE x kind x grip). */
export const tacklerDrive = (a: Athlete, hold: number, kind: TackleKind): number =>
  legDrive(a) * TACKLER_DRIVE * KIND_DRIVE[kind] * Math.min(1, Math.max(0, hold));

/** A body in the pile: its mass and the drive it applies (direction and 0..1 effort in `dir`). */
export interface PileBody {
  massLb: number;
  /** Drive direction scaled by effort (|dir| <= 1); zero = dead weight. */
  dir: Vec2;
  /** Drive strength multiplier (leg drive x grip for a tackler). */
  drive: number;
  /** Counts toward the moving mass (pushers lean in without being carried along). */
  carried: boolean;
}

/** Velocity of bodies that stick together on contact (perfectly inelastic): the momentum-weighted mean. */
export const mergeVelocity = (bodies: readonly Pick<Athlete, 'massLb' | 'vel'>[]): Vec2 => {
  let m = 0;
  let px = 0;
  let py = 0;
  for (const b of bodies) {
    const mb = Math.max(1, b.massLb);
    m += mb;
    px += mb * b.vel.x;
    py += mb * b.vel.y;
  }
  return m > 0 ? { x: px / m, y: py / m } : { x: 0, y: 0 };
};

/** Advances the pile velocity one tick under every body's drive (momentum balance with damping, speed-capped). */
export const pileStep = (vel: Vec2, bodies: readonly PileBody[], dt: number): Vec2 => {
  let mass = 0;
  let fx = 0;
  let fy = 0;
  for (const b of bodies) {
    const mb = Math.max(1, b.massLb);
    if (b.carried) mass += mb;
    const k = mb * DRIVE_ACCEL * b.drive * Math.min(1, len(b.dir));
    const l = len(b.dir);
    if (l > 1e-6) {
      fx += (k * b.dir.x) / l;
      fy += (k * b.dir.y) / l;
    }
  }
  if (mass <= 0) return { x: vel.x, y: vel.y };
  let vx = vel.x + (fx / mass - PILE_DAMPING * vel.x) * dt;
  let vy = vel.y + (fy / mass - PILE_DAMPING * vel.y) * dt;
  const sp = Math.hypot(vx, vy);
  if (sp > PILE_MAX_SPEED) {
    vx *= PILE_MAX_SPEED / sp;
    vy *= PILE_MAX_SPEED / sp;
  }
  return { x: clamp(vx, -PILE_MAX_SPEED, PILE_MAX_SPEED), y: clamp(vy, -PILE_MAX_SPEED, PILE_MAX_SPEED) };
};
