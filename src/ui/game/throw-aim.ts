/**
 * Pull-back ("slingshot") passing: the gesture that aims a pass at a SPOT on the field instead of at a receiver.
 *
 * Pointer (mouse / touch): press anywhere on the field (or on the quarterback) and drag BACK, away from where the
 *   ball should go. The pull, mirrored through the quarterback, is the throw: its direction is the aim, its length
 *   the distance (short pull = soft short ball, long pull = deep throw, see pullPower / throwDistance). Releasing
 *   throws to that spot. Releasing inside the start circle (CANCEL_RADIUS_PX) cancels; a quick press-and-release
 *   that never left the circle is a tap (tap a receiver to throw him a touch pass, as before).
 * Gamepad: pull the RIGHT stick away from the target and let it spring back; the pull a few ticks before the
 *   release is the throw. Easing the stick back to the centre cancels.
 * Keyboard: hold the throw modifier and steer the reticle with the movement keys (the quarterback stands while
 *   you aim); releasing the modifier throws to the reticle. Pressing a receiver's throw button instead throws to him
 *   as before, and steering the reticle back onto the quarterback cancels.
 * Trajectory: a DRIVE ball by default (a bullet up to BULLET_MAX_YARDS, a touch pass beyond). HOLDING SPRINT (Shift
 *   on the keyboard, the right trigger on a gamepad) when the ball is released makes it a BULLET at any distance,
 *   overriding the lob and touch choice. The secondary input toggles LOB on and off while aiming: the right mouse
 *   button, a second finger on the field, the throw modifier on a gamepad. The reticle label shows which.
 *
 * Mapping goes through the Camera (screenToWorld / fieldAxisToWorld) only, so it holds for any field orientation.
 * Everything here is pure over its inputs apart from the caller-owned ThrowAimState.
 */
import { clamp, clamp01, ratingToFactor } from '@/core/math';
import { dist, vec2, type Vec2 } from '@/core/vec2';
import type { AthleteId, ThrowType } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import { spotThrowReceiver } from '@/game/systems/passing';
import { launchPass } from '@/physics/ball';
import { FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import type { Camera } from '../camera';
import type { Action, InputState } from '../input/types';

/** Screen pixels around the press point inside which a release cancels (or counts as a tap). */
export const CANCEL_RADIUS_PX = 8;
/** Pull length (screen px) that throws at full power. */
export const MAX_PULL_PX = 96;
/** Shortest spot throw (yards). */
export const MIN_THROW_YARDS = 4;
/** Power curve exponent: > 1 gives fine control over short throws and saves the long pull for deep balls. */
export const POWER_EXPONENT = 1.35;
/** Right-stick deflection that starts an aim, and below which the stick counts as released. */
export const STICK_START = 0.35;
export const STICK_RELEASE = 0.2;
/** Deflection that counts as a full pull. */
export const STICK_FULL = 0.95;
/** Ticks of stick history searched for the pull on release (the spring back takes a few frames). */
export const STICK_HISTORY = 5;
/** Longest press (s) that still counts as a tap when it never left the cancel circle. */
export const TAP_SECONDS = 0.6;
/** A drive ball up to this distance is a bullet; farther it is a touch pass. */
export const BULLET_MAX_YARDS = 18;
/** Held at the release, this action (Shift / right trigger) forces a bullet at any distance. */
export const BULLET_ACTION: Action = 'sprint';
/** Keyboard reticle speed (yd/s) and its starting depth downfield of the quarterback. */
export const RETICLE_SPEED = 24;
export const RETICLE_START_YARDS = 12;
/** The keyboard reticle within this many yards of the quarterback cancels. */
export const RETICLE_CANCEL_YARDS = 2;

export type AimSource = 'pointer' | 'stick' | 'keys';

/** What the overlay draws while the user aims. */
export interface AimPreview {
  source: AimSource;
  /** Quarterback (world). */
  from: Vec2;
  /** Landing spot (world). */
  target: Vec2;
  throwType: ThrowType;
  lob: boolean;
  /** 0..1 pull strength. */
  power: number;
  /** True while a release now would cancel. */
  cancelled: boolean;
  /** Receiver the throw would be for (the engine's spotThrowReceiver), or null. */
  receiverId: AthleteId | null;
  /** Pointer press point and current point (screen px); null for the stick and the keys. */
  startScreen: Vec2 | null;
  currentScreen: Vec2 | null;
  /** Arc of the throw (yards of height): release, highest point and arrival (physics/ball launchPass). */
  arc: { releaseZ: number; apex: number; landingZ: number; flightTime: number };
}

/** Caller-owned gesture state (lives in the throw hold tracker). */
export interface ThrowAimState {
  source: AimSource | null;
  start: Vec2 | null;
  current: Vec2 | null;
  /** The pull has left the cancel circle at least once. */
  armed: boolean;
  heldSec: number;
  lob: boolean;
  /** The bullet button (BULLET_ACTION) is held now: the throw will be a bullet whatever its length. */
  bullet: boolean;
  secondaryWasDown: boolean;
  stickHistory: Vec2[];
  /** Keyboard reticle (world). */
  reticle: Vec2 | null;
  /** The play the gesture belongs to (a new play drops it). */
  play: PlayState | null;
  preview: AimPreview | null;
}

/** Result of one tick of aiming. */
export type AimResult =
  | { kind: 'none' }
  | { kind: 'throw'; source: AimSource; spot: Vec2; throwType: ThrowType }
  /** A press and release that never left the cancel circle (screen px). */
  | { kind: 'tap'; source: AimSource; at: Vec2; heldSec: number }
  | { kind: 'cancel'; source: AimSource };

export const createThrowAim = (): ThrowAimState => ({
  source: null, start: null, current: null, armed: false, heldSec: 0, lob: false, bullet: false, secondaryWasDown: false, stickHistory: [], reticle: null, play: null, preview: null,
});

const previews = new WeakMap<PlayState, AimPreview>();

/** The aim preview last computed for `play` (for views that do not own the throw hold, e.g. the tutorial). */
export const latestAimPreview = (play: PlayState | null | undefined): AimPreview | null => (play ? previews.get(play) ?? null : null);

/** Drops any gesture in progress. */
export const resetThrowAim = (aim: ThrowAimState): void => {
  if (aim.play) previews.delete(aim.play);
  Object.assign(aim, createThrowAim(), { play: aim.play });
};

/** 0..1 power of a pull `px` screen pixels long (0 inside the cancel circle, 1 at MAX_PULL_PX). */
export const pullPower = (px: number): number => clamp01((px - CANCEL_RADIUS_PX) / (MAX_PULL_PX - CANCEL_RADIUS_PX));

/** 0..1 power of a right-stick deflection. */
export const stickPower = (m: number): number => clamp01((m - STICK_START) / (STICK_FULL - STICK_START));

/** Longest spot throw (yards) for a throw power rating. */
export const armRange = (throwPower: number): number => 30 + 32 * ratingToFactor(throwPower);

/** Yards a throw of `power` travels for a passer with `throwPower` (monotone, MIN_THROW_YARDS..armRange). */
export const throwDistance = (power: number, throwPower: number): number =>
  MIN_THROW_YARDS + (armRange(throwPower) - MIN_THROW_YARDS) * clamp01(power) ** POWER_EXPONENT;

/** Throw type for a drive ball / lob of a distance; `bullet` (the bullet button held) wins over both. */
export const trajectoryFor = (lob: boolean, distance: number, bullet = false): ThrowType =>
  (bullet ? 'bullet' : lob ? 'lob' : distance <= BULLET_MAX_YARDS ? 'bullet' : 'touch');

/** Keeps a spot on the field (a couple of yards of apron allowed, for throwing it away). */
export const clampSpot = (p: Vec2): Vec2 => vec2(clamp(p.x, -2, FIELD_WIDTH + 2), clamp(p.y, -2, FIELD_LENGTH + 2));

/**
 * World landing spot of a pull: `pull` is the screen-frame vector from the release point back to the press point
 * (the direction the ball goes), mapped through the camera so any field orientation works.
 */
export const aimTarget = (camera: Camera, from: Vec2, pull: Vec2, power: number, throwPower: number): Vec2 => {
  const a = camera.screenToWorld(vec2(0, 0));
  const b = camera.screenToWorld(pull);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return clampSpot(from);
  const d = throwDistance(power, throwPower);
  return clampSpot(vec2(from.x + (dx / l) * d, from.y + (dy / l) * d));
};

const buildPreview = (aim: ThrowAimState, play: PlayState, qb: Athlete, target: Vec2, power: number, cancelled: boolean): AimPreview => {
  const source = aim.source ?? 'pointer';
  const throwType = trajectoryFor(aim.lob, dist(qb.pos, target), aim.bullet);
  const receiver = cancelled ? null : spotThrowReceiver(play, qb, target, throwType);
  const launch = launchPass(qb.pos, target, throwType, qb.attrs.throwPower);
  return {
    arc: { releaseZ: launch.releaseZ, apex: launch.apex, landingZ: launch.landingZ, flightTime: launch.flightTime },
    source, from: vec2(qb.pos.x, qb.pos.y), target, throwType, lob: throwType === 'lob', power, cancelled, receiverId: receiver?.id ?? null,
    startScreen: aim.start ? vec2(aim.start.x, aim.start.y) : null, currentScreen: aim.current ? vec2(aim.current.x, aim.current.y) : null,
  };
};

type Ending = { kind: 'throw'; spot: Vec2; throwType: ThrowType } | { kind: 'tap'; at: Vec2; heldSec: number } | { kind: 'cancel' };

const finish = (aim: ThrowAimState, end: Ending): AimResult => {
  const source = aim.source ?? 'pointer';
  resetThrowAim(aim);
  return { ...end, source };
};

const toggleOnEdge = (aim: ThrowAimState, down: boolean): void => {
  if (down && !aim.secondaryWasDown) aim.lob = !aim.lob;
  aim.secondaryWasDown = down;
};

const stepPointer = (aim: ThrowAimState, input: InputState, play: PlayState, camera: Camera, qb: Athlete, dt: number): AimResult => {
  const p = input.pointer;
  if (p) aim.current = vec2(p.x, p.y);
  aim.heldSec += dt;
  toggleOnEdge(aim, p?.secondary === true);
  const start = aim.start ?? vec2(0, 0);
  const cur = aim.current ?? start;
  const pull = vec2(start.x - cur.x, start.y - cur.y);
  const len = Math.hypot(pull.x, pull.y);
  if (len > CANCEL_RADIUS_PX) aim.armed = true;
  const released = !p || p.justUp || !p.down;
  const power = pullPower(len);
  const cancelled = len <= CANCEL_RADIUS_PX;
  const target = aimTarget(camera, qb.pos, pull, power, qb.attrs.throwPower);
  if (released) {
    if (!cancelled) return finish(aim, { kind: 'throw', spot: target, throwType: trajectoryFor(aim.lob, dist(qb.pos, target), aim.bullet) });
    return finish(aim, !aim.armed && aim.heldSec <= TAP_SECONDS + 1e-9 ? { kind: 'tap', at: start, heldSec: aim.heldSec } : { kind: 'cancel' });
  }
  aim.preview = aim.armed ? buildPreview(aim, play, qb, target, power, cancelled) : null;
  return { kind: 'none' };
};

const stepStick = (aim: ThrowAimState, input: InputState, play: PlayState, camera: Camera, qb: Athlete, dt: number): AimResult => {
  const v = input.aim ?? vec2(0, 0);
  aim.heldSec += dt;
  if (input.justPressed.has('throwModifier')) aim.lob = !aim.lob;
  aim.stickHistory.push(vec2(v.x, v.y));
  if (aim.stickHistory.length > STICK_HISTORY) aim.stickHistory.shift();
  const m = Math.hypot(v.x, v.y);
  if (m < STICK_RELEASE) {
    // The pull is the strongest recent sample: the stick springs back through smaller deflections on release.
    const best = aim.stickHistory.reduce((a, b) => (Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y) ? b : a), vec2(0, 0));
    const bm = Math.hypot(best.x, best.y);
    if (bm < STICK_START) return finish(aim, { kind: 'cancel' });
    const target = aimTarget(camera, qb.pos, vec2(-best.x, -best.y), stickPower(bm), qb.attrs.throwPower);
    return finish(aim, { kind: 'throw', spot: target, throwType: trajectoryFor(aim.lob, dist(qb.pos, target), aim.bullet) });
  }
  const target = aimTarget(camera, qb.pos, vec2(-v.x, -v.y), stickPower(m), qb.attrs.throwPower);
  aim.preview = buildPreview(aim, play, qb, target, stickPower(m), m < STICK_START);
  return { kind: 'none' };
};

const stepKeys = (aim: ThrowAimState, input: InputState, play: PlayState, camera: Camera, qb: Athlete, dt: number): AimResult => {
  aim.heldSec += dt;
  toggleOnEdge(aim, input.pointer?.secondary === true);
  const d = camera.fieldAxisToWorld(input.axis);
  const r = aim.reticle ?? vec2(qb.pos.x, qb.pos.y + play.ctx.direction * RETICLE_START_YARDS);
  aim.reticle = clampSpot(vec2(r.x + d.x * RETICLE_SPEED * dt, r.y + d.y * RETICLE_SPEED * dt));
  const range = armRange(qb.attrs.throwPower);
  const cancelled = dist(aim.reticle, qb.pos) <= RETICLE_CANCEL_YARDS;
  if (!input.down.has('throwModifier')) {
    if (cancelled) return finish(aim, { kind: 'cancel' });
    const spot = vec2(aim.reticle.x, aim.reticle.y);
    return finish(aim, { kind: 'throw', spot, throwType: trajectoryFor(aim.lob, dist(qb.pos, spot), aim.bullet) });
  }
  aim.preview = buildPreview(aim, play, qb, vec2(aim.reticle.x, aim.reticle.y), clamp01(dist(aim.reticle, qb.pos) / range), cancelled);
  return { kind: 'none' };
};

export interface AimOptions {
  /** Keyboard reticle allowed (the throw modifier is not the option pitch on this play). */
  allowKeys: boolean;
  dt: number;
  /** A pointer press to start from this tick (default: its justDown edge). */
  pointerPressed?: boolean;
  /** Where that press went down (screen px; default: the pointer now), e.g. before the quarterback had the ball. */
  pressAt?: Vec2;
}

/**
 * One tick of aiming for the quarterback `qb` (call only while he may throw; reset otherwise). Starts a gesture
 * from a pointer press, a right-stick pull or (keyboard) the throw modifier held with a movement key, advances it,
 * updates `aim.preview`, and returns the throw / tap / cancel on the tick it ends.
 */
export const stepThrowAim = (aim: ThrowAimState, input: InputState, play: PlayState, camera: Camera, qb: Athlete, opts: AimOptions): AimResult => {
  if (aim.play !== play) {
    resetThrowAim(aim);
    aim.play = play;
  }
  if (aim.source === null) {
    const p = input.pointer;
    const stick = input.aim ? Math.hypot(input.aim.x, input.aim.y) : 0;
    const moving = input.axis.x !== 0 || input.axis.y !== 0;
    if (p && (opts.pointerPressed ?? p.justDown)) {
      const at = opts.pressAt ?? p;
      Object.assign(aim, { source: 'pointer', start: vec2(at.x, at.y), current: vec2(p.x, p.y), armed: false, heldSec: 0, lob: false, secondaryWasDown: p.secondary === true });
    } else if (stick >= STICK_START) {
      Object.assign(aim, { source: 'stick', stickHistory: [], heldSec: 0, lob: false });
    } else if (opts.allowKeys && input.lastDevice === 'keyboard' && input.down.has('throwModifier') && moving) {
      Object.assign(aim, { source: 'keys', reticle: null, heldSec: 0, lob: false, secondaryWasDown: input.pointer?.secondary === true });
    } else return { kind: 'none' };
  }
  aim.bullet = input.down.has(BULLET_ACTION);
  let out: AimResult;
  if (aim.source === 'pointer') out = stepPointer(aim, input, play, camera, qb, opts.dt);
  else if (aim.source === 'stick') out = stepStick(aim, input, play, camera, qb, opts.dt);
  else out = stepKeys(aim, input, play, camera, qb, opts.dt);
  if (aim.preview) previews.set(play, aim.preview);
  else previews.delete(play);
  return out;
};
