/**
 * The ONLY producer of UserPlayInput in the browser. Converts one InputState snapshot (screen frame) into the
 * field-frame intent record the engine consumes, reading only the actions that make sense for the controlled
 * athlete's current context so shared buttons (B = juke / throw2 / switchPlayer ...) never conflict.
 *
 * Throw mapping (throw1..5 -> receiverSlots index 0..4, set on the tick the button is RELEASED):
 *   tap (< LOB_HOLD_SEC)            -> 'touch'
 *   hold >= LOB_HOLD_SEC            -> 'lob'
 *   throwModifier + tap             -> 'bullet', or 'backShoulder' when the receiver runs a vertical route
 *   throwModifier + hold            -> 'highPoint'
 *   sprint (Shift / RT) held        -> 'bullet', whatever else is held (the bullet button, see throw-aim BULLET_ACTION)
 * The modifier and the bullet button count if they were down at any point during the hold. A tap (touch or mouse click, released without
 * dragging) on an eligible receiver throws a 'touch' ball to that receiver (a left click anywhere else is throw1, the
 * button it is bound to); a tap on a defender switches to it; a tap on an airborne kick calls a fair catch.
 * Pull-back passing (drag back from anywhere on the field, the right stick, or the throw modifier + movement keys;
 * see throw-aim.ts) sets UserThrowSpot.throwSpot on release; while a pointer / stick aim is live the throw buttons
 * are ignored, so the mouse buttons that double as throw buttons never throw to a receiver mid-drag. Shared-button rules per context are documented on `playInputContext`.
 */
import { TICK_DT } from '@/core/time';
import { vec2, type Vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { UserThrowSpot } from '@/game/engine-api';
import type { Athlete, PlayState, UserPlayInput } from '@/game/play-types';
import type { AthleteId, ThrowType } from '@/game/play-events';
import type { TeamSide } from '@/game/types';
import type { AudibleSet, DefensiveAudibleSet, RouteDef } from '@/playbook/types';
import type { Camera } from '../camera';
import type { Action, InputState } from '../input/types';
import { BULLET_ACTION, createThrowAim, resetThrowAim, stepThrowAim, type ThrowAimState } from './throw-aim';

/**
 * What the controlled athlete is doing, which decides which actions are read:
 *  - presnapOffense: snap (snap/confirm), motion via the axis, audibles only while `audible` is held (the axis is
 *    then suppressed so an audible never doubles as motion).
 *  - presnapDefense: alignment shifts via the axis, defensive audibles while `audible` is held, switchPlayer.
 *  - kick: kickPress (kick/confirm), move.x = aim; nothing else.
 *  - qb (QB holding the ball behind the LOS, no pass thrown): throws, throwModifier, throwAway, sprint (scramble).
 *    On 'qbRun' plays the LT button is the option pitch instead of the throw modifier.
 *  - carrier: sprint, juke, spin, stiffArm, hurdle; LT = dive (QB: slide; QB behind the LOS on a qbRun: pitch).
 *  - receiver (offense without the ball): sprint, jumpSwat (go up for it), dive (diving catch).
 *  - defense / returner: defSprint or sprint, strafe (held), switchPlayer, tackle, hitStick, strip, jumpSwat and,
 *    for the returner while a kick is airborne, fairCatch.
 *  - spectator / dead: nothing.
 */
export type PlayInputContext =
  | 'dead' | 'presnapOffense' | 'presnapDefense' | 'kick' | 'qb' | 'carrier' | 'receiver' | 'defense' | 'returner' | 'spectator';

/** Seconds a throw button must be held to become a lob / high-point ball. */
export const LOB_HOLD_SEC = 0.25;
/** Screen-pixel radius used when hit-testing taps against athletes and the ball. */
export const DEFAULT_TAP_RADIUS = 10;
/** Sprites are anchored at the feet; taps land on the body this many pixels above the anchor. */
const TAP_BODY_OFFSET = 6;

const THROW_ACTIONS: readonly Action[] = ['throw1', 'throw2', 'throw3', 'throw4', 'throw5'];
const VERTICAL_ROUTES: ReadonlySet<string> = new Set(['go', 'fade', 'seam', 'post', 'skinnyPost', 'corner', 'wheel']);
const VERTICAL_TYPES: ReadonlySet<RouteDef['type']> = new Set<RouteDef['type']>(['go', 'fade', 'seam', 'post', 'corner', 'wheel']);
const OFF_AUDIBLES: readonly (readonly [Action, keyof AudibleSet | 'flip'])[] = [
  ['audibleManBeater', 'manBeater'], ['audibleZoneBeater', 'zoneBeater'], ['audibleBlitzBeater', 'blitzBeater'], ['audibleFlipRunPass', 'flip'],
];
const DEF_AUDIBLES: readonly (readonly [Action, keyof DefensiveAudibleSet])[] = [
  ['defAudibleMan', 'manShift'], ['defAudibleZone', 'zoneShift'], ['defAudibleBlitz', 'blitz'], ['defAudibleSpy', 'spy'],
];

/** Mutable per-side hold tracker for the throw buttons; owned by the Game screen, updated by buildPlayInput. */
export interface ThrowHoldState {
  /** Index 0..4 of the throw button currently held, or null. */
  action: number | null;
  heldSec: number;
  /** True once throwModifier was seen down during this hold. */
  modifier: boolean;
  /** True once the bullet button (sprint) was seen down during this hold. */
  bullet?: boolean;
  /** Pull-back aim gesture (created on first use when absent). */
  aim?: ThrowAimState;
  /**
   * The pointer's primary button / finger as last seen (every context). A pointer found down that was up the tick
   * before is a press even when its one-tick edge was dropped (game speed below 1x skips loop ticks).
   */
  pointerDown?: boolean;
  /**
   * The press being held (null once let go): where it went down and, when that was during the live play, which play.
   * A press made after the snap but before the quarterback has the ball (a shotgun snap in the air) starts the
   * pull-back from that point once he has it; a press from before the snap (the click that snapped) never does.
   */
  press?: { play: PlayState | null; at: Vec2; used: boolean } | null;
}

export const createThrowHold = (): ThrowHoldState => ({ action: null, heldSec: 0, modifier: false, aim: createThrowAim() });

export interface PlayInputOptions {
  side: TeamSide;
  /** Receiver roles for throw1..5 (receiverSlots); omitted = any index passes through. */
  formationSlots?: readonly string[];
  /** Role -> materialized route, for the back-shoulder rule. Falls back to the athlete's route id. */
  routes?: Record<string, RouteDef>;
  throwHold: ThrowHoldState;
  /** Seconds per tick (default TICK_DT). */
  dt?: number;
  tapRadiusPx?: number;
}

/** A UserPlayInput with nothing pressed and no movement. */
export const emptyPlayInput = (): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false,
});

/** The athlete `side` controls in this play (per-side map first, then the local viewer's id). */
export const controlledAthlete = (play: PlayState, side: TeamSide): Athlete | null => {
  const id = play.controlledIds[side] ?? (play.ctx.userSide === side ? play.controlledId : null);
  return findAthlete(play, id);
};

const behindLos = (play: PlayState, a: Athlete): boolean => play.ctx.direction * (a.pos.y - play.losY) <= 0;

/** Classifies the input context for `side` (see the type doc for what each context reads). */
export const playInputContext = (play: PlayState, side: TeamSide): PlayInputContext => {
  if (play.phase === 'dead') return 'dead';
  const onOffense = play.ctx.offense === side;
  if (onOffense && play.kickMeter && play.kickMeter.phase !== 'done') return 'kick';
  if (play.phase === 'presnap') return onOffense ? 'presnapOffense' : 'presnapDefense';
  const me = controlledAthlete(play, side);
  if (!me || !me.active) return 'spectator';
  if (!onOffense) return me.assignment.type === 'returner' ? 'returner' : 'defense';
  if (me.hasBall) return me.assignment.type === 'qb' && play.pass === null && behindLos(play, me) ? 'qb' : 'carrier';
  return 'receiver';
};

/** Throw type from hold length, modifier and whether the target runs a vertical route; `bullet` (Shift) wins. */
export const throwTypeFor = (heldSec: number, modifier: boolean, vertical: boolean, bullet = false): ThrowType => {
  if (bullet) return 'bullet';
  if (modifier) return heldSec >= LOB_HOLD_SEC ? 'highPoint' : vertical ? 'backShoulder' : 'bullet';
  return heldSec >= LOB_HOLD_SEC ? 'lob' : 'touch';
};

/** True when the receiver at `role` runs a vertical route (go/fade/seam/post/corner/wheel). */
export const runsVerticalRoute = (play: PlayState, role: string, routes?: Record<string, RouteDef>): boolean => {
  const def = routes?.[role];
  if (def) return VERTICAL_TYPES.has(def.type);
  const a = findAthlete(play, `off:${role}`);
  const routeId = a && a.assignment.type === 'route' ? a.assignment.route : undefined;
  if (!routeId) return false;
  const base = routeId.endsWith('~m') ? routeId.slice(0, -2) : routeId;
  return VERTICAL_ROUTES.has(base);
};

interface ThrowRelease { index: number; heldSec: number; modifier: boolean; bullet: boolean }

/** Advances the hold tracker for this tick; returns the release when a throw button came up. */
export const updateThrowHold = (hold: ThrowHoldState, input: InputState, dt: number): ThrowRelease | null => {
  for (let i = 0; i < THROW_ACTIONS.length; i++) {
    if (input.justPressed.has(THROW_ACTIONS[i] as Action)) {
      hold.action = i;
      hold.heldSec = 0;
      hold.modifier = false;
      hold.bullet = false;
    }
  }
  if (hold.action === null) return null;
  if (input.down.has('throwModifier')) hold.modifier = true;
  if (input.down.has(BULLET_ACTION)) hold.bullet = true;
  if (input.justReleased.has(THROW_ACTIONS[hold.action] as Action)) {
    const out = { index: hold.action, heldSec: hold.heldSec, modifier: hold.modifier, bullet: hold.bullet === true };
    hold.action = null;
    hold.heldSec = 0;
    hold.modifier = false;
    hold.bullet = false;
    return out;
  }
  hold.heldSec += dt;
  return null;
};

const tapPoint = (input: InputState): Vec2 | null => {
  const p = input.pointer;
  if (!p || !p.justDown || input.lastDevice !== 'touch') return null;
  return vec2(p.x, p.y);
};

/** Closest athlete (satisfying `filter`) whose body is within `radius` px of the tap, or null. */
export const tappedAthlete = (play: PlayState, camera: Camera, tap: Vec2, radius: number, filter: (a: Athlete) => boolean): Athlete | null => {
  let best: Athlete | null = null;
  let bestD = radius;
  for (const a of play.athletes) {
    if (!a.active || !filter(a)) continue;
    const s = camera.worldToScreen(a.pos);
    const d = Math.hypot(s.x - tap.x, s.y - TAP_BODY_OFFSET - tap.y);
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
};

const tappedBall = (play: PlayState, camera: Camera, tap: Vec2, radius: number): boolean => {
  const s = camera.worldToScreen(play.ball.pos);
  return Math.hypot(s.x - tap.x, s.y - camera.zoom * play.ball.z * 0.5 - tap.y) <= radius;
};

const pressed = (input: InputState, a: Action): boolean => input.justPressed.has(a);
const held = (input: InputState, a: Action): boolean => input.down.has(a);

const offenseAudible = (input: InputState, play: PlayState): keyof AudibleSet | null => {
  for (const [action, key] of OFF_AUDIBLES) {
    if (!pressed(input, action)) continue;
    if (key !== 'flip') return key;
    const t = play.ctx.offensivePlay.type;
    return t === 'run' || t === 'qbRun' || t === 'rpo' ? 'runToPass' : 'passToRun';
  }
  return null;
};

const defenseAudible = (input: InputState): keyof DefensiveAudibleSet | null => {
  for (const [action, key] of DEF_AUDIBLES) if (pressed(input, action)) return key;
  return null;
};

const clearHold = (hold: ThrowHoldState): void => {
  hold.action = null;
  hold.heldSec = 0;
  hold.modifier = false;
  hold.bullet = false;
};

/** Ends any throw-button hold and pull-back aim in progress (a screen covered the play): nothing throws afterwards. */
export const dropThrowHold = (hold: ThrowHoldState): void => {
  clearHold(hold);
  if (hold.aim) resetThrowAim(hold.aim);
};

/** True when the pointer was pressed this tick: its edge, or down now after being up on the last tick seen. */
const pointerPressed = (input: InputState, hold: ThrowHoldState): boolean => {
  const p = input.pointer;
  return p !== null && (p.justDown || (p.down && hold.pointerDown === false));
};

/** Records a new pointer press (tagged with the play when it is live) and forgets it once the pointer is up. */
const trackPress = (input: InputState, play: PlayState, hold: ThrowHoldState): void => {
  const p = input.pointer;
  if (p && pointerPressed(input, hold)) hold.press = { play: play.phase === 'live' ? play : null, at: vec2(p.x, p.y), used: false };
  else if (!p || !p.down) hold.press = null;
};

const applyThrow = (
  out: UserPlayInput & UserThrowSpot, play: PlayState, input: InputState, opts: PlayInputOptions, dt: number, camera: Camera, radius: number, allowModifier: boolean,
): void => {
  const hold = opts.throwHold;
  const aim = (hold.aim ??= createThrowAim());
  const release = updateThrowHold(hold, input, dt);
  if (!allowModifier) hold.modifier = false;
  const slots = opts.formationSlots;
  const qb = controlledAthlete(play, opts.side);
  const fresh = hold.press && !hold.press.used && hold.press.play === play ? hold.press : null;
  const result = qb ? stepThrowAim(aim, input, play, camera, qb, { allowKeys: allowModifier, dt, pointerPressed: fresh !== null, pressAt: fresh?.at }) : null;
  if (fresh && aim.source !== 'keys' && (aim.source === 'pointer' || (result !== null && result.kind !== 'none'))) fresh.used = true;
  if (result && result.kind === 'throw') {
    clearHold(hold);
    out.throwSpot = result.spot;
    out.throwType = result.throwType;
    return;
  }
  const gesture = result && result.kind !== 'none' ? result.source !== 'keys' : aim.source === 'pointer' || aim.source === 'stick';
  if (gesture) {
    // A pointer drag or a stick pull owns the throw: the mouse buttons (throw1 / throw2) pressed with it never throw.
    clearHold(hold);
    const tap = result && result.kind === 'tap' ? result : null;
    if (!tap || !slots) return;
    const target = tappedAthlete(play, camera, tap.at, radius, (a) => a.side === 'offense' && a.eligible && !a.hasBall && slots.includes(a.role));
    if (target) {
      out.throwTo = slots.indexOf(target.role);
      out.throwType = input.down.has(BULLET_ACTION) ? 'bullet' : 'touch';
    } else if (input.lastDevice === 'mouse' && slots.length > 0) {
      // A click (the left button is throw1) anywhere else is the primary's throw button, as its on-field glyph says.
      const role = slots[0] as string;
      out.throwTo = 0;
      out.throwType = throwTypeFor(tap.heldSec, allowModifier && input.down.has('throwModifier'), runsVerticalRoute(play, role, opts.routes), input.down.has(BULLET_ACTION));
    }
    return;
  }
  if (aim.source === 'keys') {
    // A receiver's throw button pressed while aiming the reticle throws to him (modifier = bullet) as before.
    if (release || hold.action !== null) resetThrowAim(aim);
    else {
      out.move = vec2(0, 0);
      out.sprint = false;
      return;
    }
  }
  if (release && (slots === undefined || release.index < slots.length)) {
    const role = slots?.[release.index];
    out.throwTo = release.index;
    out.throwType = throwTypeFor(release.heldSec, allowModifier && release.modifier, role !== undefined && runsVerticalRoute(play, role, opts.routes), release.bullet);
  }
};

const applyQb = (out: UserPlayInput & UserThrowSpot, play: PlayState, input: InputState, opts: PlayInputOptions, dt: number, camera: Camera, radius: number, move: Vec2): void => {
  out.move = move;
  out.sprint = held(input, 'sprint');
  out.throwAway = pressed(input, 'throwAway');
  const optionPlay = play.ctx.offensivePlay.type === 'qbRun';
  if (optionPlay) out.pitch = pressed(input, 'pitch');
  applyThrow(out, play, input, opts, dt, camera, radius, !optionPlay);
};

const applyDefense = (out: UserPlayInput, play: PlayState, input: InputState, camera: Camera, radius: number, returner: boolean): void => {
  out.sprint = held(input, 'defSprint') || held(input, 'sprint');
  out.strafe = held(input, 'strafe');
  out.switchPlayer = pressed(input, 'switchPlayer');
  out.tackle = pressed(input, 'tackle');
  out.hitStick = pressed(input, 'hitStick');
  out.strip = pressed(input, 'strip');
  out.jumpSwat = pressed(input, 'jumpSwat');
  const kickInAir = play.ball.phase === 'inAir' && (play.ball.kind === 'kickoff' || play.ball.kind === 'punt');
  if (returner) out.fairCatch = pressed(input, 'fairCatch') && kickInAir;
  const tap = tapPoint(input);
  if (!tap) return;
  if (returner && kickInAir && tappedBall(play, camera, tap, radius)) {
    out.fairCatch = true;
    return;
  }
  const me = play.controlledIds[play.ctx.offense === 'home' ? 'away' : 'home'] ?? play.controlledId;
  const target = tappedAthlete(play, camera, tap, radius, (a) => a.side === 'defense' && a.id !== me);
  if (target) {
    out.switchPlayer = true;
    out.switchToId = target.id as AthleteId;
  }
};

/**
 * Builds the engine input for `opts.side` from this tick's InputState. Pure apart from `opts.throwHold`, the
 * caller-owned throw hold tracker it advances. The axis is rotated into the field frame through the camera.
 */
export const buildPlayInput = (input: InputState, play: PlayState, camera: Camera, opts: PlayInputOptions): UserPlayInput & UserThrowSpot => {
  const out: UserPlayInput & UserThrowSpot = emptyPlayInput();
  const dt = opts.dt ?? TICK_DT;
  const radius = opts.tapRadiusPx ?? DEFAULT_TAP_RADIUS;
  const context = playInputContext(play, opts.side);
  const move = camera.fieldAxisToWorld(input.axis);
  if (context !== 'qb' && opts.throwHold.aim?.source) resetThrowAim(opts.throwHold.aim);
  trackPress(input, play, opts.throwHold);
  if (context === 'qb') applyQb(out, play, input, opts, dt, camera, radius, move);
  opts.throwHold.pointerDown = input.pointer?.down === true;
  if (context === 'qb') return out;
  switch (context) {
    case 'dead':
    case 'spectator':
      opts.throwHold.action = null;
      return out;
    case 'kick':
      // The kick's aim is relative to the kicker (+1 = his right, as kicking.ts / kickBall read it), not a world x:
      // flip by the attack direction so the landing moves the way the stick points on screen for both directions.
      out.move = vec2(Math.max(-1, Math.min(1, move.x * play.ctx.direction)), 0);
      out.kickPress = pressed(input, 'kick') || pressed(input, 'confirm');
      return out;
    case 'presnapOffense': {
      const audibleMode = held(input, 'audible');
      out.audible = audibleMode ? offenseAudible(input, play) : null;
      out.move = audibleMode ? vec2(0, 0) : move;
      out.snap = !audibleMode && (pressed(input, 'snap') || pressed(input, 'confirm'));
      return out;
    }
    case 'presnapDefense': {
      const audibleMode = held(input, 'audible');
      out.defAudible = audibleMode ? defenseAudible(input) : null;
      out.move = audibleMode ? vec2(0, 0) : move;
      out.switchPlayer = pressed(input, 'switchPlayer');
      const tap = tapPoint(input);
      const target = tap ? tappedAthlete(play, camera, tap, radius, (a) => a.side === 'defense') : null;
      if (target) {
        out.switchPlayer = true;
        out.switchToId = target.id;
      }
      return out;
    }
    case 'carrier': {
      const me = controlledAthlete(play, opts.side);
      out.move = move;
      out.sprint = held(input, 'sprint');
      out.juke = pressed(input, 'juke');
      out.spin = pressed(input, 'spin');
      out.stiffArm = pressed(input, 'stiffArm');
      out.hurdle = pressed(input, 'hurdle');
      const lt = pressed(input, 'dive') || pressed(input, 'slide') || pressed(input, 'pitch');
      if (lt && me) {
        if (me.position !== 'QB') out.dive = true;
        else if (play.ctx.offensivePlay.type === 'qbRun' && behindLos(play, me)) out.pitch = true;
        else out.slide = true;
      }
      return out;
    }
    case 'receiver':
      out.move = move;
      out.sprint = held(input, 'sprint');
      out.jumpSwat = pressed(input, 'jumpSwat');
      out.dive = pressed(input, 'dive');
      return out;
    case 'defense':
      out.move = move;
      applyDefense(out, play, input, camera, radius, false);
      return out;
    case 'returner':
      out.move = move;
      applyDefense(out, play, input, camera, radius, true);
      return out;
  }
};
