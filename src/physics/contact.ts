import { clamp, clamp01, logistic, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { dist, len, type Vec2 } from '@/core/vec2';
import { FIELD_WIDTH } from '@/game/types';
import type { Athlete } from '@/game/play-types';
import type { BreakMove, CatchKind, TackleKind, ThrowType } from '@/game/play-events';

/**
 * Contact resolution: pure, attribute-driven contests that the game systems call when circles meet or a
 * ball arrives. Each takes the athletes involved and an rng and returns a classified result plus the numbers
 * behind it (for the dev overlay and tests). No positions or states are mutated here.
 */

const f = (rating: number): number => ratingToFactor(rating);

/** Momentum in lb*yd/s: mass times current speed. */
export const momentum = (athlete: Athlete): number => Math.max(1, athlete.massLb) * len(athlete.vel);

/** -1..1: how much more momentum `a` carries than `b`. */
export const momentumAdvantage = (a: Athlete, b: Athlete): number => {
  const ma = momentum(a);
  const mb = momentum(b);
  return (ma - mb) / (ma + mb + 1e-6);
};

/* --------------------------------- Tackles --------------------------------- */

export type TackleResult = 'tackled' | 'broken' | 'stumble' | 'fumble' | 'missed';

export interface TackleContext {
  rng: Rng;
  /** 0..1 hit-stick timing quality (1 = perfect); only for kind 'hitStick'. */
  hitStickTiming?: number;
  /** Defenders already hanging on (kind 'gang'). */
  assistCount?: number;
  /** DifficultyProfile.userBallSecurityAssist (0..1) when the carrier is user-controlled. */
  ballSecurityAssist?: number;
  /**
   * 0..1 share of the carrier's special-move bonus the tackler has read and takes away (a user-controlled defender's
   * form tackle scaled by DifficultyProfile.userTackleAssist). Absent = 0: the AI never gets it.
   */
  moveRead?: number;
}

export interface TackleOutcome {
  result: TackleResult;
  /** Probability of a fumble that was rolled (whether or not it happened). */
  fumbleChance: number;
  /** Move credited for a broken tackle ('none' when the carrier simply ran through it). */
  breakMove: BreakMove;
  tacklePower: number;
  carrierPower: number;
  /** Chance the tackler whiffed entirely. */
  missChance: number;
}

const KIND_POWER: Record<TackleKind, number> = { arm: -0.1, wrap: 0.08, hitStick: -0.05, gang: 0, dive: -0.08, openField: -0.04, strip: -0.2 };
/**
 * Leverage a tackler has once he has actually reached the runner: the power contest is centred here rather than
 * at zero, so evenly matched athletes see the runner go down about 7 times in 10 on a square wrap (arm tackles,
 * dives and open-field lunges pay their KIND_POWER penalty on top and land nearer a coin flip).
 */
export const CONTACT_EDGE = 0.16;
/** Steepness of the power contest: ratings separate outcomes quickly either side of the edge. */
export const CONTEST_SLOPE = 12;
/** Share of failed tackles that still knock the runner off balance when the powers are level. */
export const STUMBLE_BASE = 0.7;
/** Base fumble chance on a completed tackle (scaled by ball security, tackle kind and the momentum edge). */
export const FUMBLE_BASE = 0.018;
const KIND_MISS: Record<TackleKind, number> = { arm: 0.1, wrap: 0.05, hitStick: 0.1, gang: 0.02, dive: 0.2, openField: 0.1, strip: 0.2 };
/**
 * Whiff chances at first contact in the live engine (contactStart). Lower than the one-roll tackleContest's: there a
 * whiff stood in for every way a tackle could fail, here failing to hold on is the grip roll's and the struggle's job.
 */
const CONTACT_MISS: Record<TackleKind, number> = { arm: 0.1, wrap: 0.03, hitStick: 0.1, gang: 0.01, dive: 0.14, openField: 0.08, strip: 0.2 };
const KIND_FUMBLE: Record<TackleKind, number> = { arm: 0.5, wrap: 0.6, hitStick: 1, gang: 1, dive: 0.8, openField: 0.9, strip: 8 };

/** Which move the carrier gets credit for when a tackle is broken. */
export const breakMoveFor = (carrier: Athlete): BreakMove => {
  switch (carrier.state) {
    case 'juking': return 'juke';
    case 'spinning': return 'spin';
    case 'stiffArming': return 'stiffArm';
    case 'hurdling': return 'hurdle';
    case 'trucking': return 'truck';
    default: return len(carrier.vel) > 7 ? 'burst' : 'none';
  }
};

/** Tackling power 0..~1.2: tackling, strength, pursuit, momentum, kind and hit-stick timing. */
export const tacklePower = (tackler: Athlete, carrier: Athlete, kind: TackleKind, ctx: TackleContext): number => {
  const a = tackler.attrs;
  let p = 0.5 * f(a.tackling) + 0.3 * f(a.strength) + 0.2 * f(a.pursuit) + 0.15 * momentumAdvantage(tackler, carrier) + KIND_POWER[kind];
  if (kind === 'hitStick') p += 0.3 * ((ctx.hitStickTiming ?? 0.5) - 0.5);
  if (kind === 'gang') p += 0.12 * Math.min(3, ctx.assistCount ?? 0);
  return p;
};

/**
 * Carrier resistance 0..~1.1: carrying (ball security and contact balance) first, then balance, strength and a
 * little agility, plus the active special move (less the share `moveRead` of it the tackler read); wears down with
 * each broken tackle. Elusiveness mostly shows up as tacklers never getting square (the move itself), not as a
 * licence to run through a wrap.
 */
export const carrierPower = (carrier: Athlete, moveRead = 0): number => {
  const a = carrier.attrs;
  const p = 0.45 * f(a.carrying) + 0.25 * f(a.balance) + 0.2 * f(a.strength) + 0.1 * f(a.agility);
  let move = 0;
  switch (carrier.state) {
    case 'trucking': move = 0.1 * f(a.strength); break;
    case 'juking':
    case 'spinning': move = 0.07 * f(a.agility); break;
    case 'stiffArming': move = 0.07 * f(a.strength); break;
    case 'hurdling': move = 0.05 * f(a.jumping); break;
    case 'stumbling': move = -0.15; break;
    default: break;
  }
  // A tackler who read the move takes (part of) its bonus away; a stumble is never forgiven.
  if (move > 0) move *= 1 - clamp01(moveRead);
  return p + move - BROKEN_TACKLE_WEAR * Math.min(4, carrier.brokenTacklesThisPlay);
};

/**
 * Power a runner loses for every tackle he has already broken this play (up to four): each break costs balance and
 * momentum, so the fifth man usually gets him (a return through the whole coverage unit is the rare exception).
 */
export const BROKEN_TACKLE_WEAR = 0.05;

/**
 * 0..1 form-tackling technique (tackling, then awareness): trims whiffs. Ratings only: the AI's difficulty shows up in
 * how it approaches (pursuit angle, breaking down, which tackle it chooses; ai/tackling.ts), never in this roll.
 */
export const tacklingTechnique = (tackler: Athlete): number => clamp01(0.6 * f(tackler.attrs.tackling) + 0.4 * f(tackler.attrs.awareness));

/**
 * Resolve one tackle attempt. Order: whiff roll (kind, the tackler's technique, the carrier's agility), then the power contest
 * (tackled vs broken/stumble), then a fumble roll on a completed tackle (strips also roll at half chance when
 * the runner stays up). 99 tackling vs 40 carrying brings the runner down ~80% of the time; the reverse breaks
 * free ~80%.
 */
export const tackleContest = (carrier: Athlete, tackler: Athlete, kind: TackleKind, ctx: TackleContext): TackleOutcome => {
  const tp = tacklePower(tackler, carrier, kind, ctx);
  const cp = carrierPower(carrier, ctx.moveRead ?? 0);
  const diff = tp - cp;
  let missChance = KIND_MISS[kind] * (1.3 - 0.6 * tacklingTechnique(tackler)) * (0.8 + 0.4 * f(carrier.attrs.agility));
  if (kind === 'hitStick' && (ctx.hitStickTiming ?? 0.5) < 0.35) missChance = 0.55;
  missChance = clamp01(missChance);
  const pTackle = 0.08 + 0.84 * logistic(diff + CONTACT_EDGE, 0, CONTEST_SLOPE);
  const timing = ctx.hitStickTiming ?? 0.5;
  const kindFumble = kind === 'hitStick' ? 0.8 + 1.7 * timing : KIND_FUMBLE[kind];
  let fumbleChance = FUMBLE_BASE * (1.4 - f(carrier.attrs.carrying)) * kindFumble * (1 + Math.max(0, momentumAdvantage(tackler, carrier)));
  fumbleChance *= 1 - 0.7 * clamp01(ctx.ballSecurityAssist ?? 0);
  fumbleChance = clamp01(fumbleChance);
  const base = { fumbleChance, breakMove: 'none' as BreakMove, tacklePower: tp, carrierPower: cp, missChance };
  const rng = ctx.rng;
  if (rng.chance(missChance)) return { ...base, result: 'missed', breakMove: breakMoveFor(carrier) };
  if (rng.chance(pTackle)) return { ...base, result: rng.chance(fumbleChance) ? 'fumble' : 'tackled' };
  // A strip attempt can still pop the ball out even when the runner stays up.
  if (kind === 'strip' && rng.chance(fumbleChance * 0.5)) return { ...base, result: 'fumble', breakMove: breakMoveFor(carrier) };
  // A tackle that is broken still usually knocks the runner off balance (the second man arrives).
  const pStumble = clamp01(STUMBLE_BASE + 1.2 * diff);
  return { ...base, result: rng.chance(pStumble) ? 'stumble' : 'broken', breakMove: breakMoveFor(carrier) };
};

/* ------------------------------ Contact start ------------------------------ */

/** What the first contact of a tackle attempt does: the tackler gets hold (a struggle starts, systems/tackle-struggle.ts). */
export type ContactResult = 'wrap' | 'bigHit' | 'fumble' | 'broken' | 'stumble' | 'missed';

export interface ContactOutcome extends Omit<TackleOutcome, 'result'> {
  result: ContactResult;
  /** 0..~1.5 grip the tackler has on a 'wrap' (0 otherwise): how hard the hold is to break and how hard he drives. */
  hold: number;
  /** Chance the tackler got hold of the runner at all (after the whiff roll). */
  gripChance: number;
  /** Chance a hit stick put the runner straight down (0 for other kinds). */
  bigHitChance: number;
}

/**
 * Where the grip contest is centred: a tackler who reaches the runner gets hold of him most of the time (a square
 * wrap ~9 in 10 between even athletes, an arm tackle ~7 in 10); whether the hold brings him down is the struggle's
 * business, not this roll's.
 */
export const GRIP_EDGE = 0.38;
/** Grip each kind of tackle gets on the runner (scaled by the power edge): arm tackles and dives are weak holds. */
export const KIND_HOLD: Record<TackleKind, number> = { arm: 0.55, wrap: 1, hitStick: 1.15, gang: 0.7, dive: 0.6, openField: 0.7, strip: 0.5 };
/** Share of the tackle fumble chance rolled by the hit itself when the tackler gets hold (the rest is the strip in the pile). */
export const CONTACT_FUMBLE_SHARE = 0.6;

/** Grip strength for a hold of `kind` won by a power edge of `diff`. */
export const holdStrength = (kind: TackleKind, diff: number): number => KIND_HOLD[kind] * clamp(1 + 1.2 * diff, 0.5, 1.5);

/**
 * First contact of a tackle attempt (the live engine; fast-sim still uses tackleContest). Order: the whiff roll (as
 * tackleContest), then for a hit stick the big-hit roll (timing, momentum and the power edge: the runner goes straight
 * down, or the ball comes out), then the grip roll: a hold starts a struggle (the hit may still jar the ball loose),
 * no hold is a broken tackle (usually leaving the runner off balance). Ratings and the human-only assists in `ctx`
 * only: never the difficulty.
 */
export const contactStart = (carrier: Athlete, tackler: Athlete, kind: TackleKind, ctx: TackleContext): ContactOutcome => {
  const tp = tacklePower(tackler, carrier, kind, ctx);
  const cp = carrierPower(carrier, ctx.moveRead ?? 0);
  const diff = tp - cp;
  const timing = ctx.hitStickTiming ?? 0.5;
  let missChance = CONTACT_MISS[kind] * (1.3 - 0.6 * tacklingTechnique(tackler)) * (0.8 + 0.4 * f(carrier.attrs.agility));
  if (kind === 'hitStick' && timing < 0.35) missChance = 0.55;
  missChance = clamp01(missChance);
  const kindFumble = kind === 'hitStick' ? 0.8 + 1.7 * timing : KIND_FUMBLE[kind];
  let fumbleChance = FUMBLE_BASE * (1.4 - f(carrier.attrs.carrying)) * kindFumble * (1 + Math.max(0, momentumAdvantage(tackler, carrier)));
  fumbleChance = clamp01(fumbleChance * (1 - 0.7 * clamp01(ctx.ballSecurityAssist ?? 0)));
  const gripChance = 0.08 + 0.87 * logistic(diff + GRIP_EDGE, 0, CONTEST_SLOPE);
  const bigHitChance = kind === 'hitStick' ? clamp01(0.2 + 0.45 * timing + 0.8 * momentumAdvantage(tackler, carrier) + 1.2 * diff) : 0;
  const base = { fumbleChance, breakMove: 'none' as BreakMove, tacklePower: tp, carrierPower: cp, missChance, gripChance, bigHitChance, hold: 0 };
  const rng = ctx.rng;
  if (rng.chance(missChance)) return { ...base, result: 'missed', breakMove: breakMoveFor(carrier) };
  if (kind === 'hitStick' && rng.chance(bigHitChance)) return { ...base, result: rng.chance(fumbleChance) ? 'fumble' : 'bigHit' };
  if (rng.chance(gripChance)) {
    if (rng.chance(fumbleChance * CONTACT_FUMBLE_SHARE)) return { ...base, result: 'fumble' };
    return { ...base, result: 'wrap', hold: holdStrength(kind, diff) };
  }
  if (kind === 'strip' && rng.chance(fumbleChance * 0.5)) return { ...base, result: 'fumble', breakMove: breakMoveFor(carrier) };
  const pStumble = clamp01(STUMBLE_BASE + 1.2 * diff);
  return { ...base, result: rng.chance(pStumble) ? 'stumble' : 'broken', breakMove: breakMoveFor(carrier) };
};

/* --------------------------------- Blocks --------------------------------- */

export type BlockResult = 'engaged' | 'pancake' | 'shed' | 'stalemate';

export interface BlockOutcome {
  result: BlockResult;
  /** Velocity impulse (yd/s) to add to the RUSHER, along blocker -> rusher; negative when the rusher drives the blocker back. */
  pushVec: Vec2;
  blockerPower: number;
  rusherPower: number;
}

/** Blocking power: technique, strength, balance and (run blocks) momentum. */
export const blockerPower = (blocker: Athlete, rusher: Athlete, kind: 'run' | 'pass'): number => {
  const a = blocker.attrs;
  const p = 0.5 * f(a.blocking) + 0.3 * f(a.strength) + 0.2 * f(a.balance);
  return kind === 'run' ? p + 0.1 * momentumAdvantage(blocker, rusher) : p;
};

/** Rushing power: pass rush moves vs a pass set; strength/leverage vs a run block. */
export const rusherPower = (rusher: Athlete, kind: 'run' | 'pass'): number => {
  const a = rusher.attrs;
  return kind === 'pass'
    ? 0.5 * f(a.passRush) + 0.3 * f(a.strength) + 0.2 * f(a.agility)
    : 0.4 * f(a.strength) + 0.35 * f(a.passRush) + 0.25 * f(a.balance);
};

/** Score above which a block is a certain pancake (a 99 wall on a 1 rusher). */
export const PANCAKE_SURE_SCORE = 0.9;
/** Score above which a pancake becomes possible; the chance ramps to PANCAKE_MAX_CHANCE at the sure score. */
export const PANCAKE_MIN_SCORE = 0.4;
export const PANCAKE_MAX_CHANCE = 0.15;
/** Score below which a block is beaten outright (a clear rusher edge, not a coin flip: sheds are a stuff at the line). */
export const SHED_SCORE = -0.3;
/**
 * The same for a run block: the blocker fires out first and has the initiative (a pass rusher has it against a
 * pass set), so it takes a clearer edge to throw him off.
 */
export const RUN_SHED_SCORE = -0.26;

/**
 * One blocker-vs-rusher exchange. Score = blocker - rusher + noise: well above zero holds (engaged, pushing
 * the rusher back) and occasionally pancakes (a winning block is normally just sustained: this is rolled every
 * engagement re-roll, so a pancake is a rare, mismatch-driven event rather than the default win), near zero
 * stalemates, well below sheds. Call on first contact and again each engagement re-roll interval.
 */
export const blockContest = (blocker: Athlete, rusher: Athlete, kind: 'run' | 'pass', rng: Rng): BlockOutcome => {
  const bp = blockerPower(blocker, rusher, kind);
  const rp = rusherPower(rusher, kind);
  const score = bp - rp + rng.gaussian(0, 0.15);
  const d = dist(blocker.pos, rusher.pos);
  const nx = d > 1e-6 ? (rusher.pos.x - blocker.pos.x) / d : 0;
  const ny = d > 1e-6 ? (rusher.pos.y - blocker.pos.y) / d : 1;
  const base = { blockerPower: bp, rusherPower: rp };
  if (score > PANCAKE_MIN_SCORE) {
    const ramp = clamp01((score - PANCAKE_MIN_SCORE) / (PANCAKE_SURE_SCORE - PANCAKE_MIN_SCORE));
    if (score > PANCAKE_SURE_SCORE || rng.chance(PANCAKE_MAX_CHANCE * ramp)) return { ...base, result: 'pancake', pushVec: { x: nx * 3, y: ny * 3 } };
    return { ...base, result: 'engaged', pushVec: { x: nx * score * 1.5, y: ny * score * 1.5 } };
  }
  if (score > 0.05) return { ...base, result: 'engaged', pushVec: { x: nx * score * 1.5, y: ny * score * 1.5 } };
  if (score > (kind === 'run' ? RUN_SHED_SCORE : SHED_SCORE)) return { ...base, result: 'stalemate', pushVec: { x: 0, y: 0 } };
  return { ...base, result: 'shed', pushVec: { x: nx * score * 1.5, y: ny * score * 1.5 } };
};

/* --------------------------------- Catches --------------------------------- */

export type CatchResult = 'catch' | 'drop' | 'defended' | 'interception' | 'tip';

export interface CatchOutcome {
  result: CatchResult;
  /** A defender was close enough to influence the play. */
  contested: boolean;
  catchKind: CatchKind;
  /** False when the ball arrived above everyone's reach: callers treat that as overthrown, not a drop. */
  reachable: boolean;
  receiverSkill: number;
  defenderSkill: number;
  /** Chance the receiver had of securing it after all modifiers. */
  catchChance: number;
  /** The defender that most influenced the play, if any. */
  defenderId: string | null;
}

/** Radius (yd) inside which a defender contests a catch. */
export const CONTEST_RADIUS = 2.6;
/**
 * How far the receiver's catch skill must clear the contesting defender's (proximity-scaled) skill for an even
 * contested catch. A defender a yard off an average receiver takes about a third of the balls, one on his hip half.
 */
export const CONTESTED_CATCH_OFFSET = 0.25;

/** Highest ball an athlete can reach with a jump: standing reach (height + arms) plus a rating-scaled leap. */
export const reachHeight = (athlete: Athlete): number => athlete.heightIn / 36 + 0.85 + 0.3 + 0.7 * f(athlete.attrs.jumping);

/** Standing reach without leaving the ground. */
export const standingReach = (athlete: Athlete): number => athlete.heightIn / 36 + 0.85;

const catchKindFor = (receiver: Athlete, ballHeight: number, throwType: ThrowType, contested: boolean): CatchKind => {
  if (receiver.state === 'diving' || ballHeight < 0.6) return 'diving';
  // Leaping only when he had to go up for it: in the air, or a ball above his standing reach (a jump ball thrown at
  // head height and caught there is a plain catch).
  if (receiver.state === 'jumping' || ballHeight > standingReach(receiver) || (throwType === 'highPoint' && ballHeight > 2.2)) return 'highPoint';
  if (receiver.pos.x < 1.5 || receiver.pos.x > FIELD_WIDTH - 1.5) return 'sideline';
  if (!contested && len(receiver.vel) > 4.5) return 'rac';
  return 'possession';
};

/**
 * Resolve a pass arriving at a receiver. Receiver skill (catching, hands, jumping on high balls, awareness) vs
 * the strongest nearby defender (coverage, reaction, jumping, hands; scaled by proximity and by playing the
 * ball). Throw type shifts the balance: bullets are hard to catch and harder to defend, lobs invite
 * defenders, back-shoulder throws shut them out. `userPassAssist` (0..1) pads the user's catch chance.
 * `playsBall(defender)` (0..1, default 1) is the share of his pick chance the contesting defender's own decision
 * leaves him (went up for it vs swatted vs never turned): ratings roll the dice, decisions set the share.
 * `pickScale(defender)` (default 1) multiplies his finished-pick chance: the CPU team's skill edge (All-Pro / Legend).
 */
export const catchContest = (
  receiver: Athlete, defenders: readonly Athlete[], ballHeight: number, throwType: ThrowType, rng: Rng, userPassAssist: number,
  playsBall: (defender: Athlete) => number = () => 1, pickScale: (defender: Athlete) => number = () => 1,
): CatchOutcome => {
  const a = receiver.attrs;
  const high = throwType === 'highPoint' || ballHeight > standingReach(receiver);
  let rec = high
    ? 0.35 * f(a.catching) + 0.25 * f(a.hands) + 0.3 * f(a.jumping) + 0.1 * f(a.awareness)
    : 0.45 * f(a.catching) + 0.3 * f(a.hands) + 0.1 * f(a.jumping) + 0.15 * f(a.awareness);
  let defAdj = 0;
  switch (throwType) {
    case 'bullet': rec -= 0.05; defAdj = -0.08; break;
    case 'touch': rec += 0.03; break;
    case 'lob': defAdj = 0.1; break;
    case 'backShoulder': rec -= 0.03; defAdj = -0.12; break;
    case 'highPoint': defAdj = 0.02; break;
    case 'throwAway': rec -= 0.5; break;
  }
  let best = 0;
  let bestId: string | null = null;
  let bestDefender: Athlete | null = null;
  for (const d of defenders) {
    if (!d.active || d.id === receiver.id) continue;
    const prox = clamp01(1 - dist(d.pos, receiver.pos) / CONTEST_RADIUS);
    if (prox <= 0) continue;
    const da = d.attrs;
    let s = (0.45 * f(da.coverage) + 0.25 * f(da.reaction) + 0.15 * f(da.jumping) + 0.15 * f(da.hands)) * prox;
    if (d.state === 'jumping') s *= 1.2;
    else if (d.state === 'diving') s *= 1.1;
    if (ballHeight > reachHeight(d)) s *= 0.3;
    s = Math.max(0, s + defAdj * prox);
    if (s > best) { best = s; bestId = d.id; bestDefender = d; }
  }
  const contested = best > 0.12;
  const reachable = ballHeight <= reachHeight(receiver);
  const catchKind = catchKindFor(receiver, ballHeight, throwType, contested);
  const base = { contested, catchKind, reachable, receiverSkill: rec, defenderSkill: best, defenderId: bestId };
  if (!reachable) return { ...base, result: contested && rng.chance(0.3 + best) ? 'defended' : 'drop', catchChance: 0 };
  // An uncontested, catchable ball is dropped about one time in twelve by an average receiver (rarely by a sure-handed one).
  let p = 0.83 + 0.15 * rec + 0.1 * clamp01(userPassAssist);
  if (high) p *= 0.75 + 0.25 * f(a.jumping);
  if (catchKind === 'diving') p *= 0.8;
  // A defender on the catch point takes a real share of the balls: at a yard away roughly half of them.
  if (contested) p *= logistic(rec - best - CONTESTED_CATCH_OFFSET + rng.gaussian(0, 0.08), 0, 6);
  if (throwType === 'throwAway') p *= 0.15; // aimed at nobody; a body in the way rarely gathers it
  p = clamp(p, 0, 0.985);
  if (rng.chance(p)) return { ...base, result: 'catch', catchChance: p };
  if (!contested) return { ...base, result: 'drop', catchChance: p };
  const intMult = throwType === 'lob' ? 1.3 : throwType === 'bullet' ? 0.7 : 1;
  // Most contested balls that are not caught are knocked away; a pick needs the defender to finish it.
  // ... and to have gone for it: `playsBall` is the share his own decision leaves him (1 = he went up for the pick).
  // `pickScale` (default 1) is the CPU PERFORMANCE EDGE on finishing the pick (game/difficulty-sides.ts cpuPickScale).
  const pInt = clamp01((0.03 + 0.12 * best) * intMult * clamp01(bestDefender ? playsBall(bestDefender) : 1) * (bestDefender ? pickScale(bestDefender) : 1));
  if (rng.chance(pInt)) return { ...base, result: 'interception', catchChance: p };
  if (rng.chance(0.2)) return { ...base, result: 'tip', catchChance: p };
  return { ...base, result: 'defended', catchChance: p };
};
