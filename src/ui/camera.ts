/**
 * Field camera: maps world yards to logical screen pixels. Pure math, no DOM. `worldToScreen` / `screenToWorld`
 * are exact inverses and the ONLY projection the game uses (drawing, pointer aiming, taps).
 *
 * The view is HORIZONTAL: the length of the field (world y) runs left-right across the screen and its width
 * (world x) runs top-bottom. Rotation is -PI/2 or +PI/2 (the world turned a quarter clockwise / anticlockwise):
 *  - -PI/2 ("not flipped"): world +y points RIGHT on screen and world +x points DOWN (x = 0 sideline on top);
 *  - +PI/2 ("flipped"): world +y points LEFT and world +x points UP.
 * `rotationFor` picks the one that makes the OFFENSE (the kicking team on kicks, unless the local user is the
 * one receiving a kickoff or punt: then his return goes right) attack to the right. Legacy
 * rotation values are accepted: 0 means not flipped and PI means flipped. Screen-frame input axes
 * (InputState.axis: +y down) are converted to the absolute field frame with `fieldAxisToWorld`, which is the
 * seam src/ui/game/play-input.ts uses before building UserPlayInput.
 */
import { clamp } from '@/core/math';
import type { CameraMode, CameraZoom } from '@/core/settings';
import { vec2, type Vec2 } from '@/core/vec2';
import { FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X, type Direction, type TeamSide } from '@/game/types';

/** Per-play facts the camera needs to frame a mode. */
export interface CameraFrameContext {
  userSide: TeamSide | null;
  /** Side attacking in `direction` (kicking team on kick plays). Defaults to the user's side. */
  offense?: TeamSide;
  direction: Direction;
  ballPos: Vec2;
  controlledPos: Vec2 | null;
  losY?: number;
  /** Predicted landing spot for kick mode; omitted = 45 yards downfield. */
  kickLandingPos?: Vec2 | null;
  /** A kickoff or punt (a return follows): the local user's RECEIVING team, not the kicking team, attacks right. */
  kickReturn?: boolean;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Logical pixels per yard each mode aims for (simulation is computed from the viewport; kick is the CAP of the kick
 * fit). Retro field scale: one 480x270 pixel grid for world and UI, figures ~22-25 px tall at full size (stepping
 * down as the view zooms out, render/world-layer.ts tiers). STANDARD 9 px/yd shows 53 yards of length and 30 of
 * width; WIDE (x WIDE_FACTOR) 7.2.
 */
export const CAMERA_ZOOM: Readonly<Record<CameraMode, number>> = Object.freeze({
  standard: 9, defensive: 8.5, playerFollow: 14, zoomed: 13, kick: 7.5, replay: 9, simulation: 0,
});
/** Yards the standard view leads the ball in the attack direction (the offense sits left of centre). */
export const STANDARD_LEAD = 12;
/**
 * Most logical pixels any lead puts the ball left of centre (the old CLOSE lead, 12 yd at 7 px/yd): at the higher
 * zooms of the new field scale a lead in yards alone would push the offense under the score bug and leave the QB's
 * drop at the screen edge.
 */
export const LEAD_MAX_PX = 84;
/** A lead of `yards` at `zoom`, capped at LEAD_MAX_PX on screen. */
export const leadYards = (yards: number, zoom: number): number => Math.min(yards, LEAD_MAX_PX / Math.max(zoom, 1e-6));
/** Share of the ball's distance from the middle of the field the standard view follows across. */
export const ACROSS_FOLLOW = 0.5;
/** Rotation (radians) that makes world +y point right on screen, and the one that makes it point left. */
export const ROT_RIGHT = -Math.PI / 2;
export const ROT_LEFT = Math.PI / 2;
/** Yards of apron kept visible beyond the sidelines (top / bottom of the screen) before the view stops following. */
export const FIELD_MARGIN = 6;
/**
 * Yards the view may show past an end line (left / right of the screen): the end-line stands. Near its own goal
 * line the offense then still sits clear of the score bug in the top-left corner instead of being pinned under it.
 */
export const END_MARGIN = 19;
/**
 * Most pixels the kick view puts the ball (the kicking team's line) left of centre, so a kickoff or punt line
 * spread across the width stays clear of the score bug in the top-left corner.
 */
export const KICK_BALL_LEAD_PX = 72;
/** Yards of field width the kick view keeps in frame across (the coverage lanes; the far sidelines may clip). */
export const KICK_ACROSS = 44;
/** Lowest kick framing zoom (px/yd): kicks keep tier-2 figures; the view follows the ball to the landing. */
export const KICK_MIN_ZOOM = 6;
export const MIN_ZOOM = 1.5;
/**
 * Fastest the eased zoom changes, px/yd per second. The exponential ease alone would swing the wider zoom range of
 * the new field scale (AIM 7 <-> CLOSE 10.5) in visible jumps per frame; the cap keeps each frame's step small.
 */
export const MAX_ZOOM_SPEED = 8;
export const MAX_ZOOM = 18;

/** Smallest tap radius (logical px) for picking an athlete on the field. */
export const TAP_RADIUS_MIN = 10;
/** Tap radius around an athlete, in yards of field (art bible §2.1). */
export const TAP_RADIUS_YD = 0.9;
/** Tap radius (logical px) for picking an athlete at a camera zoom: 0.9 yd, never under TAP_RADIUS_MIN. */
export const tapRadiusFor = (zoom: number): number => Math.max(TAP_RADIUS_MIN, TAP_RADIUS_YD * zoom);

/**
 * CLOSE preset (Settings.cameraZoom, the default): the play view sits at CLOSE_ZOOM.standard px/yd (10.5: 45.7
 * yards across the 480-px screen, big chunky figures) and eases out (never below CLOSE_MIN_ZOOM, 9 px/yd: a wide
 * split may then be off the top or bottom edge, and the field view pins an edge arrow to it instead) only as far as
 * needed to keep the must-see points on screen: the pre-snap spread, the athlete the user controls, a pass in the
 * air and its target. A throw being aimed or a deep ball lowers the floor to AIM_ZOOM (38 yards of width, ~69 of
 * length). The defensive view does the same around the ball and the athlete the user controls. The STANDARD preset
 * is the fixed CAMERA_ZOOM framing; WIDE scales it by WIDE_FACTOR.
 */
export const CLOSE_ZOOM = Object.freeze({ standard: 10.5, defensive: 10, replay: 10 });
export const CLOSE_MIN_ZOOM = 9;
export const AIM_ZOOM = 7;
export const WIDE_FACTOR = 0.8;
/**
 * A pass in the air still DEEP_FLIGHT_FAR yards or more from its target is framed at AIM_ZOOM at most (the aim view
 * carries straight on into the flight); the cap lifts linearly back to the close zoom as the ball closes to
 * DEEP_FLIGHT_NEAR yards, so the view settles in on the catch. FAR is 38 (30 before the field-scale change): the
 * zoom range from AIM_ZOOM to the close zoom is 2.5x wider now, and the longer ramp keeps it lifting as gently.
 */
export const DEEP_FLIGHT_FAR = 38;
export const DEEP_FLIGHT_NEAR = 12;
/** Share of the ball's distance from the middle of the field the CLOSE view follows across. */
export const CLOSE_ACROSS_FOLLOW = 0.75;
/** Yards the CLOSE defensive view leads the ball toward the end zone the offense attacks. */
export const CLOSE_DEFENSIVE_LEAD = 8;
/** Yards kept between a must-see point and the screen edge: along the field (left / right) and across (top / bottom). */
export const FIT_MARGIN_ALONG = 10;
export const FIT_MARGIN_ACROSS = 4;
/** Yards the CLOSE view always keeps between its kept point (the ball) and the screen edge, even when the others cannot fit. */
export const BALL_KEEP_YD = 3;

/**
 * What the drawn scene tells the CLOSE framing (the field view refreshes it every frame it draws): whether the
 * play is still pre-snap, the offense's spread across the field (world x) then, and the spot a pull-back throw is
 * being aimed at.
 */
export interface CameraFocus {
  presnap: boolean;
  spreadX: { min: number; max: number } | null;
  aimSpot: Vec2 | null;
}

export class Camera {
  mode: CameraMode = 'standard';
  /** World point at the centre of the screen. */
  readonly target: Vec2 = vec2(MIDDLE_X, FIELD_LENGTH / 2);
  /** Pixels per yard. */
  zoom = CAMERA_ZOOM.standard;
  /** ROT_RIGHT (-PI/2: world +y points right) or ROT_LEFT (+PI/2: world +y points left). */
  rotation = ROT_RIGHT;
  readonly desiredTarget: Vec2 = vec2(MIDDLE_X, FIELD_LENGTH / 2);
  desiredZoom = CAMERA_ZOOM.standard;
  private shakeAmp = 0;
  private shakeTime = 0;
  private shakeClock = 0;
  private framed = false;
  /** Settings.cameraZoom as applied by the director; a bare Camera keeps the fixed STANDARD framing. */
  preset: CameraZoom = 'standard';
  /** Latest scene facts for the CLOSE framing (null: none yet). */
  focus: CameraFocus | null = null;
  private viewW: number;
  private viewH: number;

  constructor(viewW = 480, viewH = 270) {
    this.viewW = viewW;
    this.viewH = viewH;
  }

  get width(): number {
    return this.viewW;
  }
  get height(): number {
    return this.viewH;
  }
  get flipped(): boolean {
    return this.rotation > 0;
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  /** Accepts ROT_RIGHT / ROT_LEFT (or the legacy 0 / PI): anything above zero is the flipped view. */
  setRotation(rotation: number): void {
    this.rotation = rotation > 1e-6 ? ROT_LEFT : ROT_RIGHT;
  }

  /** +1 when world +y points right, -1 when flipped. */
  private get orient(): number {
    return this.flipped ? -1 : 1;
  }

  private shakeOffset(): Vec2 {
    if (this.shakeTime <= 0 || this.shakeAmp <= 0) return vec2(0, 0);
    const k = this.shakeAmp * Math.min(1, this.shakeTime / 0.15);
    return vec2(Math.round(Math.sin(this.shakeClock * 61) * k), Math.round(Math.cos(this.shakeClock * 47) * k));
  }

  /** World yards -> logical screen pixels: world y along the screen x axis, world x down the screen y axis. */
  worldToScreen(v: Vec2): Vec2 {
    const o = this.orient;
    const s = this.shakeOffset();
    return vec2(this.viewW / 2 + o * (v.y - this.target.y) * this.zoom + s.x, this.viewH / 2 + o * (v.x - this.target.x) * this.zoom + s.y);
  }

  /** Exact inverse of `worldToScreen` (pointer / touch positions -> field spots). */
  screenToWorld(p: Vec2): Vec2 {
    const o = this.orient;
    const s = this.shakeOffset();
    return vec2(this.target.x + (o * (p.y - s.y - this.viewH / 2)) / this.zoom, this.target.y + (o * (p.x - s.x - this.viewW / 2)) / this.zoom);
  }

  /** Rotates a world-space direction into screen space (+y down) without translation or scaling. */
  worldDirToScreen(d: Vec2): Vec2 {
    const o = this.orient;
    return vec2(o * d.y + 0, o * d.x + 0);
  }

  /** Converts a screen-frame input axis (+x right, +y down) to the absolute field frame (inverse of worldDirToScreen). */
  fieldAxisToWorld(screenAxis: Vec2): Vec2 {
    const o = this.orient;
    return vec2(o * screenAxis.y + 0, o * screenAxis.x + 0);
  }

  /** Screen x direction (+1 right, -1 left) of a world attack direction along the field. */
  screenDirOf(direction: Direction): 1 | -1 {
    return direction * this.orient > 0 ? 1 : -1;
  }

  /** Screen-space facing vector of a world heading in radians. */
  screenFacing(worldAngle: number): Vec2 {
    return this.worldDirToScreen(vec2(Math.cos(worldAngle), Math.sin(worldAngle)));
  }

  /** World-space AABB currently on screen. */
  visibleBounds(): Bounds {
    const a = this.screenToWorld(vec2(0, 0));
    const b = this.screenToWorld(vec2(this.viewW, this.viewH));
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  isVisible(pos: Vec2, marginYards = 1): boolean {
    const b = this.visibleBounds();
    return pos.x >= b.minX - marginYards && pos.x <= b.maxX + marginYards && pos.y >= b.minY - marginYards && pos.y <= b.maxY + marginYards;
  }

  /** Exponentially eases the centre toward `target`; `smoothing` is the rate per second (Infinity snaps). */
  follow(target: Vec2, dt: number, smoothing = 6): void {
    const t = Camera.easeFactor(dt, smoothing);
    this.target.x += (target.x - this.target.x) * t;
    this.target.y += (target.y - this.target.y) * t;
  }

  /** Eases the zoom toward `zoom` (clamped to the normal range). */
  zoomTo(zoom: number, dt: number, smoothing = 6): void {
    this.easeZoom(clamp(zoom, MIN_ZOOM, MAX_ZOOM), dt, smoothing);
  }

  /** Blend factor for one step of exponential easing; Infinity snaps, a non-positive dt does nothing. */
  private static easeFactor(dt: number, smoothing: number): number {
    if (smoothing === Infinity) return 1;
    return dt > 0 ? 1 - Math.exp(-smoothing * dt) : 0;
  }

  private easeZoom(zoom: number, dt: number, smoothing: number): void {
    const step = (zoom - this.zoom) * Camera.easeFactor(dt, smoothing);
    const cap = smoothing === Infinity ? Infinity : MAX_ZOOM_SPEED * Math.max(0, dt);
    this.zoom += clamp(step, -cap, cap);
  }

  /** Jumps to the desired framing immediately. */
  snap(): void {
    this.target.x = this.desiredTarget.x;
    this.target.y = this.desiredTarget.y;
    this.zoom = this.desiredZoom;
  }

  /** Free framing for replay / dev mode. Not clamped to the field. */
  setFree(target: Vec2, zoom: number): void {
    this.desiredTarget.x = target.x;
    this.desiredTarget.y = target.y;
    this.desiredZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  }

  addShake(amplitudePx: number, seconds: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amplitudePx);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  /**
   * Rotation that makes the offense (the side attacking in `ctx.direction`: the kicking team on kicks) attack to
   * the RIGHT, for either possession and with or without a local user. It flips with possession between plays. The
   * one exception is a kickoff or punt the local user RECEIVES: his return goes to the right (his "downfield", as on
   * the drive that follows), so the ball is kicked right to left.
   */
  static rotationFor(ctx: CameraFrameContext): number {
    const receiving = ctx.kickReturn === true && ctx.userSide !== null && ctx.offense !== undefined && ctx.userSide !== ctx.offense;
    const d = receiving ? -ctx.direction : ctx.direction;
    return d === 1 ? ROT_RIGHT : ROT_LEFT;
  }

  /** Changes mode and computes the framing; snaps on the first call and whenever the mode actually changes. */
  setMode(mode: CameraMode, ctx: CameraFrameContext): void {
    const changed = mode !== this.mode || !this.framed;
    this.mode = mode;
    this.track(ctx);
    if (changed) this.snap();
    this.framed = true;
  }

  /** Recomputes the desired framing for the current mode (call once per tick with fresh play facts). */
  track(ctx: CameraFrameContext): void {
    this.setRotation(Camera.rotationFor(ctx));
    const dir = ctx.direction;
    const ball = ctx.ballPos;
    const scale = this.preset === 'wide' ? WIDE_FACTOR : 1;
    switch (this.mode) {
      case 'standard':
        if (this.preset === 'close') {
          // Pre-snap the user may be moving someone other than the passer (a practice or tutorial receiver): he is
          // a must-see point and, when the floor cannot show him and the ball together, the one kept in view.
          const mover = this.focus?.presnap ? ctx.controlledPos : null;
          this.frameClose(ctx, CLOSE_ZOOM.standard, leadYards(STANDARD_LEAD, CLOSE_ZOOM.standard), mover, mover ?? ctx.ballPos);
        }
        else this.aim(MIDDLE_X + (ball.x - MIDDLE_X) * ACROSS_FOLLOW, ball.y + dir * leadYards(STANDARD_LEAD, CAMERA_ZOOM.standard * scale), CAMERA_ZOOM.standard * scale);
        break;
      case 'defensive': {
        if (this.preset === 'close') {
          this.frameClose(ctx, CLOSE_ZOOM.defensive, leadYards(CLOSE_DEFENSIVE_LEAD, CLOSE_ZOOM.defensive), ctx.controlledPos, ctx.ballPos);
          break;
        }
        const los = ctx.losY ?? ball.y;
        this.aim(ball.x + (MIDDLE_X - ball.x) * 0.5, los + dir * 10, CAMERA_ZOOM.defensive * scale);
        break;
      }
      case 'playerFollow': {
        const p = ctx.controlledPos ?? ball;
        this.aim(p.x, p.y, CAMERA_ZOOM.playerFollow);
        break;
      }
      case 'zoomed':
        this.aim(ball.x, ball.y, CAMERA_ZOOM.zoomed);
        break;
      case 'kick': {
        // A "landing" behind the line (the snap going back to the punter / holder) would swing the view backward.
        const base = ctx.losY ?? ball.y;
        const given = ctx.kickLandingPos ?? null;
        const landing = given && (given.y - base) * dir > 5 ? given : vec2(ball.x, clamp(base + dir * 45, 0, FIELD_LENGTH));
        const dist = Math.abs(landing.y - ball.y);
        // Fits the kick, KICK_ACROSS yards of width, and (with the ball at most KICK_BALL_LEAD_PX left of centre) the landing.
        const fit = Math.min(this.viewW / (dist + 24), (this.viewW / 2 + KICK_BALL_LEAD_PX) / (dist + 12), this.viewH / KICK_ACROSS);
        // Kicks stay close enough for tier-2 figures; the camera follows the ball to the landing.
        const zoom = clamp(fit, KICK_MIN_ZOOM, CAMERA_ZOOM.kick);
        // Centre between ball and landing, but never so far ahead that the kicking line slides under the score bug.
        const half = (landing.y - ball.y) / 2;
        const lead = half * dir > KICK_BALL_LEAD_PX / zoom ? (dir * KICK_BALL_LEAD_PX) / zoom : half;
        this.aim((ball.x + landing.x) / 2, ball.y + lead, zoom);
        break;
      }
      case 'simulation': {
        const zoom = Math.min(this.viewW / (FIELD_LENGTH + 6), this.viewH / (FIELD_WIDTH + 6));
        this.desiredTarget.x = MIDDLE_X;
        this.desiredTarget.y = FIELD_LENGTH / 2;
        this.desiredZoom = clamp(zoom, 0.5, MAX_ZOOM);
        break;
      }
      case 'replay':
        break;
    }
  }

  /** Replay framing zoom for the current preset. */
  replayZoom(): number {
    if (this.preset === 'close') return CLOSE_ZOOM.replay;
    return CAMERA_ZOOM.replay * (this.preset === 'wide' ? WIDE_FACTOR : 1);
  }

  /**
   * CLOSE framing: `base` px/yd around the ball (leading it `lead` yards toward the attacked end zone, following it
   * across), eased out just enough to keep every must-see point in view with FIT_MARGIN_* to spare: the pre-snap
   * spread, a pass's target while the ball is in the air (`ctx.kickLandingPos`; a deep ball also caps the zoom, see
   * DEEP_FLIGHT_FAR), `extra` (the athlete the user controls) and, while a throw is aimed, the aim spot (then at
   * most AIM_ZOOM). When they cannot all fit at the zoom floor, `keep` (the ball, or the athlete the user moves
   * pre-snap) still never leaves the view. Continuous in its inputs, so the eased view never jumps.
   */
  private frameClose(ctx: CameraFrameContext, base: number, lead: number, extra: Vec2 | null, keep: Vec2): void {
    const ball = ctx.ballPos;
    const f = this.focus;
    const pts: Vec2[] = [ball];
    let cap = base;
    if (f?.presnap && f.spreadX) pts.push(vec2(f.spreadX.min, ball.y), vec2(f.spreadX.max, ball.y));
    const flight = f?.presnap ? null : ctx.kickLandingPos ?? null;
    if (flight) {
      pts.push(flight);
      const togo = Math.hypot(flight.x - ball.x, flight.y - ball.y);
      cap = Math.min(cap, base + (AIM_ZOOM - base) * clamp((togo - DEEP_FLIGHT_NEAR) / (DEEP_FLIGHT_FAR - DEEP_FLIGHT_NEAR), 0, 1));
    }
    if (f?.aimSpot) {
      pts.push(f.aimSpot);
      cap = Math.min(cap, AIM_ZOOM);
    }
    if (extra) pts.push(extra);
    let minX = ball.x, maxX = ball.x, minY = ball.y, maxY = ball.y;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const fit = Math.min(this.viewW / (maxY - minY + FIT_MARGIN_ALONG * 2), this.viewH / (maxX - minX + FIT_MARGIN_ACROSS * 2));
    const zoom = clamp(Math.min(cap, fit), Math.min(CLOSE_MIN_ZOOM, cap), base);
    const halfAlong = this.viewW / zoom / 2 - FIT_MARGIN_ALONG;
    const halfAcross = this.viewH / zoom / 2 - FIT_MARGIN_ACROSS;
    // Points that cannot all fit at the zoom floor share the view evenly, but `keep` never leaves it (the field
    // view pins an edge arrow to whoever is cut off instead).
    const within = (want: number, lo: number, hi: number, b: number, half: number): number =>
      clamp(lo <= hi ? clamp(want, lo, hi) : (lo + hi) / 2, b - Math.max(0, half), b + Math.max(0, half));
    const x = within(MIDDLE_X + (ball.x - MIDDLE_X) * CLOSE_ACROSS_FOLLOW, maxX - halfAcross, minX + halfAcross, keep.x, this.viewH / zoom / 2 - BALL_KEEP_YD);
    const y = within(ball.y + ctx.direction * lead, maxY - halfAlong, minY + halfAlong, keep.y, this.viewW / zoom / 2 - BALL_KEEP_YD);
    this.aim(x, y, zoom);
  }

  /**
   * Eases current framing toward the desired one and advances the shake. `zoomSmoothing` (default: `smoothing`)
   * lets the zoom ease more gently than the pan.
   */
  update(dt: number, smoothing = 6, zoomSmoothing = smoothing): void {
    this.follow(this.desiredTarget, dt, smoothing);
    // desiredZoom is already clamped by whichever mode set it (simulation may legitimately sit below MIN_ZOOM)
    this.easeZoom(this.desiredZoom, dt, zoomSmoothing);
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      this.shakeClock += dt;
      if (this.shakeTime <= 0) {
        this.shakeAmp = 0;
        this.shakeTime = 0;
      }
    }
  }

  /**
   * `target` moved just enough that a view at `zoom` stays on the field plus the apron (sidelines, top / bottom) and
   * the end-line stands (left / right) wherever the view is smaller than that; centred on an axis it cannot fill.
   * The screen's width shows world y (along the field), its height world x (across).
   */
  clampTarget(target: Vec2, zoom: number): Vec2 {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const halfAlong = this.viewW / z / 2;
    const halfAcross = this.viewH / z / 2;
    return vec2(
      halfAcross * 2 >= FIELD_WIDTH + FIELD_MARGIN * 2 ? MIDDLE_X : clamp(target.x, halfAcross - FIELD_MARGIN, FIELD_WIDTH + FIELD_MARGIN - halfAcross),
      halfAlong * 2 >= FIELD_LENGTH + END_MARGIN * 2 ? FIELD_LENGTH / 2 : clamp(target.y, halfAlong - END_MARGIN, FIELD_LENGTH + END_MARGIN - halfAlong),
    );
  }

  /** Sets the desired framing, kept on the field by `clampTarget`. */
  private aim(x: number, y: number, zoom: number): void {
    const t = this.clampTarget(vec2(x, y), zoom);
    this.desiredZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.desiredTarget.x = t.x;
    this.desiredTarget.y = t.y;
  }
}
