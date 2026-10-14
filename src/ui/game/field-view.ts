/**
 * Field view: draws a play (live PlayState or a replay frame, via the FieldScene projection) through the
 * camera — the field with LOS / line to gain, athletes as procedural sprites in resolved team palettes
 * (facing from velocity, pose from state, animation frame from the state timer), the ball with a ground
 * shadow that shrinks with height, the controlled-player ring, receiver glyphs above throw targets when the
 * user's QB holds the ball, switch hints on defense, the pre-snap route overlay and sideline markers.
 * Everything goes through the camera's horizontal projection (the offense attacks to the right; sprites stay upright
 * and face their screen-space motion; a ball's height lifts it up the screen above its shadow).
 * Positions interpolate between the previous and current tick using the loop alpha. Bodies in a tackle keep the
 * way they face (a tackler dragged backward is not flipped round), and bodies on the ground in a pile stack up.
 * With a world layer (opts.world, the retro art grid) the field, stadium, ring, markers, figures and ball go there
 * through render/world-layer-scene.ts (animation clips and the sprite atlas) and only the overlays (route art,
 * receiver glyphs, switch hints, edge arrows to athletes out of view) stay on the logical surface; without one
 * (tests, `?lores=1`) the legacy 1x path below draws everything as before.
 */
import { POSITION_GROUP } from '@/players/types';
import type { AthleteState, BallPhase, PlayState, ReplayFrame } from '@/game/play-types';
import type { PlayEvent } from '@/game/play-events';
import { maxSpeed } from '@/physics/speed';
import { FIELD_WIDTH, type Direction, type TeamSide, type WeatherState } from '@/game/types';
import type { RouteDef } from '@/playbook/types';
import { routePath } from '@/playbook/transform';
import { vec2, type Vec2 } from '@/core/vec2';
import type { Camera, CameraFocus } from '../camera';
import { drawField, type FieldCtx } from '../render/field';
import { teamUniforms, type ResolvedPalettes } from '../render/palette';
import { drawStadium, type StadiumView } from '../render/stadium';
import { animForState, drawSprite, facingFromScreenVector, frameFor, generateAthleteSprite, generateBallSprite, skinToneFromSeed, type SpriteCache, type SpriteCtx } from '../render/sprites';
import { drawText, type FillCtx } from '../render/text';
import type { WorldLayer } from '../render/canvas';
import { drawWorldScene, viewTier } from '../render/world-layer-scene';
import { figureHeightLpx, type SceneLighting } from '../render/world-layer';
import { setWorldGameInfo, type WorldGameInfo } from '../render/world/game-info';
import { TICK_DT } from '@/core/time';

export { lightingFor } from '../render/world-layer';
import type { Theme } from '../theme';
import type { SnapshotBuffer } from './interp';
import { latestAimPreview } from './throw-aim';

/** States drawn along the athlete's facing rather than his velocity (dragged, driven back, sliding on the ground). */
const HOLD_FACING: ReadonlySet<AthleteState> = new Set<AthleteState>(['wrapped', 'wrapping', 'falling', 'down', 'tackled']);
/** States that lie in a pile: each body landing on others is drawn a little higher, as if stacked on top. */
const PILED: ReadonlySet<AthleteState> = new Set<AthleteState>(['down', 'falling', 'tackled']);
/** Yards within which grounded bodies count as one pile; pixels each body in it is lifted (at most PILE_MAX_LIFT). */
export const PILE_RADIUS = 1.1;
export const PILE_STEP_PX = 2;
export const PILE_MAX_LIFT = 2;
/** Zoom (px/yd) from which the legacy 1x path draws its 16-px sprites at 2x (was 8 before the field-scale change). */
export const LEGACY_DOUBLE_ZOOM = 16;

/** Screen lift (pixels, before sprite scale) for each grounded athlete in a pile, in draw order. */
export const pileLifts = (ordered: readonly Pick<SceneAthlete, 'id' | 'x' | 'y' | 'state'>[]): Map<string, number> => {
  const out = new Map<string, number>();
  const seen: Pick<SceneAthlete, 'x' | 'y'>[] = [];
  for (const a of ordered) {
    if (!PILED.has(a.state)) continue;
    const under = seen.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < PILE_RADIUS).length;
    if (under > 0) out.set(a.id, Math.min(PILE_MAX_LIFT, under) * PILE_STEP_PX);
    seen.push(a);
  }
  return out;
};
import { pixelArrow, pixelEllipse, pixelLine } from './pixel-draw';
import { arrowTip, drawEdgeArrow, drawEdgePointer, offEdge, pinBox } from './edge-marker';

export interface SceneAthlete {
  id: string;
  playerId: string;
  teamSide: TeamSide;
  side: 'offense' | 'defense';
  role: string;
  position: keyof typeof POSITION_GROUP;
  number: number;
  x: number;
  y: number;
  /** World heading in radians. */
  facing: number;
  state: AthleteState;
  /** Seconds in the current state (animation clock). */
  stateTimer: number;
  hasBall: boolean;
  controlled: boolean;
  active: boolean;
  eligible: boolean;
  /** Engine body facing, radians (the drawn `facing` follows the velocity while moving). */
  bodyFacing?: number;
  /** Blocking partner (engine `engagedWith`); absent in replays (the look layer infers it). */
  engagedWith?: string | null;
  blockTargetId?: string | null;
  /** Velocity, yards per second (run cadence, backpedal, fall direction). */
  vx?: number;
  vy?: number;
  heightIn?: number;
  weightLb?: number;
  /** Top speed in yd/s (jog / run / sprint thresholds). */
  topSpeed?: number;
}

export interface SceneBall {
  x: number;
  y: number;
  z: number;
  phase: BallPhase;
  carrierId: string | null;
}

/** Everything the field view needs, decoupled from PlayState so replays render through the same code. */
export interface FieldScene {
  athletes: SceneAthlete[];
  ball: SceneBall;
  losY: number | null;
  firstDownY: number | null;
  direction: Direction;
  /** Local viewer's controlled athlete. */
  controlledId: string | null;
  presnap: boolean;
  /** Origin of the offense's routes (ballX, losY) for the play-art overlay. */
  snapX: number;
  /**
   * Team defending the y = 0 end zone right now (the one whose own goal line it is); its end zone is painted in its
   * colours and name, the other one in the opponent's, swapping when the teams change ends. Omitted: home at y = 0.
   */
  southTeam?: TeamSide;
  /** Spot a pull-back throw is being aimed at right now (live plays only; the camera eases out to show it). */
  aimSpot?: Vec2 | null;
  /** Fractional simulation tick of the drawn state (animation clock; replays reproduce it). */
  tick?: number;
  /** Every event of the play so far (event-driven animations). */
  events?: readonly PlayEvent[];
  /** Recorded per-tick frames of the play, when kept (the animation odometer reads them). */
  frames?: readonly ReplayFrame[] | null;
  /** Identifies the play (animation memory resets when it changes). */
  playKey?: string;
  /** Lighting of the game (world layer). */
  lighting?: SceneLighting;
}

/**
 * Camera focus for the CLOSE framing: pre-snap flag, the offense's spread across the field (active athletes) and the
 * aim spot. `drawScene` hands it to the camera every frame it draws.
 */
export const focusFromScene = (scene: FieldScene): CameraFocus => {
  let spreadX: CameraFocus['spreadX'] = null;
  if (scene.presnap) {
    for (const a of scene.athletes) {
      if (a.side !== 'offense' || !a.active) continue;
      spreadX = spreadX ? { min: Math.min(spreadX.min, a.x), max: Math.max(spreadX.max, a.x) } : { min: a.x, max: a.x };
    }
  }
  return { presnap: scene.presnap, spreadX, aimSpot: scene.presnap ? null : scene.aimSpot ?? null };
};

/** The team whose own goal line is at y = 0 when `offense` attacks in `direction`. */
export const southTeamFor = (offense: TeamSide, direction: Direction): TeamSide => (direction === 1 ? offense : offense === 'home' ? 'away' : 'home');

export type FieldViewCtx = FieldCtx & SpriteCtx & FillCtx;

export interface FieldViewOptions {
  theme: Theme;
  sprites: SpriteCache;
  palettes: ResolvedPalettes;
  fieldType: 'grass' | 'turf';
  weather: WeatherState | null;
  homeAbbr: string;
  awayAbbr: string;
  /** Seconds, drives weather + ball spin. */
  time: number;
  userSide: TeamSide | null;
  /** Role -> route to draw pre-snap (offense only). */
  routes?: Record<string, RouteDef>;
  showPlayArt?: boolean;
  /** Receiver roles (throw1..5) and their prompt glyphs; drawn when the controlled athlete is the QB with the ball. */
  receiverSlots?: readonly string[];
  receiverGlyphs?: readonly string[];
  /** Show switch hints on defenders near the ball (defense control). */
  switchHints?: boolean;
  /** Home stadium to draw around the field (stands, crowd, name banner); omitted = bare apron. */
  stadium?: StadiumView | null;
  /** Settings.animations: false freezes athlete run cycles, the spinning ball and the crowd. Default true. */
  animations?: boolean;
  /** The world layer (art pixels): when given, the field and figures are drawn there and only overlays on `ctx`. */
  world?: WorldLayer | null;
  /** Down, quarter and score for the world art (sideline down box, stadium scoreboard, turf wear); none = neutral. */
  gameInfo?: WorldGameInfo | null;
}

const hashId = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};


/** Heading an athlete is drawn along: his velocity while moving (not dragged / falling), else his body facing. */
export const drawnHeading = (state: AthleteState, vx: number, vy: number, facing: number): number =>
  !HOLD_FACING.has(state) && Math.hypot(vx, vy) > 0.3 ? Math.atan2(vy, vx) : facing;

/** Render-clock inputs of a live scene's animation tick (`sceneFromPlay`). */
export interface SceneClockOptions {
  /** Render clock, seconds (RenderContext.time). Without it a dead play's clock holds still. */
  time?: number;
  /** The screen is paused (pause menu, dev console): the clock holds. */
  paused?: boolean;
}

/** Longest render-clock gap (seconds) a dead play's animation clock catches up on in one frame. */
export const SCENE_CLOCK_MAX_GAP = 0.25;

const clocks = new WeakMap<PlayState, { tick: number; time: number | null }>();

/**
 * Animation tick of a live play's scene. While the play runs it is the interpolated sim tick `raw`, but never
 * backward: a stalled play (paused, or waiting under an overlay) would otherwise swing back within a tick every time
 * the loop alpha wraps, and the animation memory would read each swing as a seek and reset. Once the play is dead the
 * sim tick stops, so the clock runs on at the sim rate on the render clock (the post-whistle settle, get-ups and
 * celebrations keep moving, as the replay's settle frames do), held while paused.
 */
export const liveSceneTick = (play: PlayState, raw: number, clock: SceneClockOptions = {}): number => {
  const time = clock.time ?? null;
  const c = clocks.get(play);
  if (!c) {
    clocks.set(play, { tick: raw, time });
    return raw;
  }
  const dt = time !== null && c.time !== null ? Math.min(SCENE_CLOCK_MAX_GAP, Math.max(0, time - c.time)) : 0;
  c.time = time;
  const run = play.phase === 'dead' && !clock.paused ? dt / TICK_DT : 0;
  c.tick = Math.max(raw, c.tick + run);
  return c.tick;
};

/** Stable key per live PlayState object (animation memory resets on a new play). */
const playKeys = new WeakMap<PlayState, string>();
let playKeySeq = 0;
const playKeyOf = (play: PlayState): string => {
  let k = playKeys.get(play);
  if (!k) playKeys.set(play, (k = `live${++playKeySeq}`));
  return k;
};

/** Projects a PlayState (interpolated through the buffer) into a FieldScene; `clock` drives its animation tick. */
export const sceneFromPlay = (play: PlayState, buffer: SnapshotBuffer | null, alpha: number, clock?: SceneClockOptions): FieldScene => {
  const athletes: SceneAthlete[] = play.athletes.map((a) => {
    const p = buffer ? buffer.athletePos(a.id, { x: a.pos.x, y: a.pos.y, facing: a.facing }, alpha) : { x: a.pos.x, y: a.pos.y, facing: a.facing };
    const heading = drawnHeading(a.state, a.vel.x, a.vel.y, a.facing);
    return {
      id: a.id, playerId: a.playerId, teamSide: a.teamSide, side: a.side, role: a.role, position: a.position, number: a.number,
      x: p.x, y: p.y, facing: heading, state: a.state, stateTimer: a.stateTimer, hasBall: a.hasBall, controlled: a.controlled, active: a.active, eligible: a.eligible,
      bodyFacing: p.facing, engagedWith: a.engagedWith, blockTargetId: a.ai.blockTargetId, vx: a.vel.x, vy: a.vel.y, heightIn: a.heightIn, weightLb: a.massLb,
      topSpeed: maxSpeed(a.baseAttrs.speed),
    };
  });
  const b = buffer ? buffer.ballPos({ x: play.ball.pos.x, y: play.ball.pos.y, z: play.ball.z }, alpha) : { x: play.ball.pos.x, y: play.ball.pos.y, z: play.ball.z };
  // A pull still inside its cancel circle is not an aim yet (a tap must not pulse the zoom).
  const aim = play.ball.phase === 'held' ? latestAimPreview(play) : null;
  return {
    aimSpot: aim && !aim.cancelled ? vec2(aim.target.x, aim.target.y) : null,
    athletes,
    ball: { x: b.x, y: b.y, z: b.z, phase: play.ball.phase, carrierId: play.ball.carrierId },
    losY: play.losY,
    firstDownY: play.firstDownY,
    direction: play.ctx.direction,
    controlledId: play.controlledId,
    presnap: play.phase === 'presnap',
    snapX: play.snapX,
    southTeam: southTeamFor(play.ctx.offense, play.ctx.direction),
    // The buffer interpolates from the previous tick to the current one.
    tick: liveSceneTick(play, buffer ? play.tick - 1 + alpha : play.tick, clock),
    events: play.events,
    frames: play.recordFrames ? play.frames : null,
    playKey: playKeyOf(play),
  };
};

const drawRouteOverlay = (ctx: FieldViewCtx, camera: Camera, scene: FieldScene, opts: FieldViewOptions): void => {
  const routes = opts.routes;
  if (!routes || scene.losY === null) return;
  const color = opts.theme.colors.accent2;
  for (const a of scene.athletes) {
    if (a.side !== 'offense') continue;
    const r = routes[a.role];
    if (!r) continue;
    // Route offsets are relative to the alignment; the athlete's current spot is that alignment pre-snap.
    const path = routePath(r, vec2(0, 0), a.x, a.y, scene.direction);
    let prev = camera.worldToScreen(vec2(a.x, a.y));
    // Waypoints are offsets from the alignment (the first is rarely 0,0), so the athlete -> waypoint[0] leg counts.
    for (let i = 0; i < path.length; i++) {
      const q = camera.worldToScreen(path[i] as Vec2);
      if (i === path.length - 1) pixelArrow(ctx, prev.x, prev.y, q.x, q.y, color, 1, 3);
      else pixelLine(ctx, prev.x, prev.y, q.x, q.y, color, 1);
      prev = q;
    }
  }
};

const drawShadow = (ctx: FillCtx, p: Vec2, z: number, zoom: number, color: string): void => {
  const r = Math.max(1, (0.45 - Math.min(0.3, z * 0.04)) * zoom);
  pixelEllipse(ctx, p.x, p.y, r, r * 0.5, color, true);
};

/** Draws the scene through the camera. */
export const drawScene = (ctx: FieldViewCtx, camera: Camera, scene: FieldScene, opts: FieldViewOptions): void => {
  const { theme, palettes } = opts;
  camera.focus = focusFromScene(scene);
  if (opts.world) {
    setWorldGameInfo(opts.gameInfo ?? null);
    const byY = [...scene.athletes].sort((a, b) => camera.worldToScreen(vec2(a.x, a.y)).y - camera.worldToScreen(vec2(b.x, b.y)).y);
    drawWorldScene(opts.world, camera, scene, opts, pileLifts(byY));
    if (scene.presnap && opts.showPlayArt) drawRouteOverlay(ctx, camera, scene, opts);
    drawPrompts(ctx, camera, scene, opts, scene.athletes.find((a) => a.id === scene.controlledId) ?? null, Math.ceil(figureHeightLpx(viewTier(camera))) + 3);
    return;
  }
  // drawField paints its 'home' end zone at y = 0: hand it whichever team defends that end right now.
  const south = scene.southTeam ?? 'home';
  const north: TeamSide = south === 'home' ? 'away' : 'home';
  const abbr = { home: opts.homeAbbr, away: opts.awayAbbr };
  drawField(ctx, camera, {
    weather: opts.weather, fieldType: opts.fieldType, endZoneColors: { home: palettes[south].primary, away: palettes[north].primary },
    // Reduced motion: rain / snow stay drawn (they tell the conditions) but stop drifting.
    homeAbbr: abbr[south], awayAbbr: abbr[north], losY: scene.losY, firstDownY: scene.firstDownY, dir: scene.direction, time: theme.reducedMotion ? 0 : opts.time,
    losColor: theme.colors.los, firstDownColor: theme.colors.firstDown,
  });
  const animate = opts.animations ?? true;
  // The crowd bob is decoration: frozen by Settings.animations and by reduced motion.
  if (opts.stadium) drawStadium(ctx, camera, opts.stadium, { time: opts.time, animations: animate && !theme.reducedMotion });
  if (scene.presnap && opts.showPlayArt) drawRouteOverlay(ctx, camera, scene, opts);
  const zoom = camera.zoom;
  // Legacy 1x path: sprites double only on the closest views (the presets put CLOSE at 10.5 px/yd).
  const scale = zoom >= LEGACY_DOUBLE_ZOOM ? 2 : 1;
  // controlled ring + sideline markers before sprites
  const controlled = scene.athletes.find((a) => a.id === scene.controlledId) ?? null;
  if (controlled) {
    const p = camera.worldToScreen(vec2(controlled.x, controlled.y));
    pixelEllipse(ctx, p.x, p.y, 0.9 * zoom, 0.45 * zoom, theme.colors.accent, false);
  }
  if (scene.losY !== null) {
    for (const x of [-1.2, FIELD_WIDTH + 1.2]) {
      const p = camera.worldToScreen(vec2(x, scene.losY));
      ctx.fillStyle = theme.colors.los;
      ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 2, 3, 5);
    }
    if (scene.firstDownY !== null) {
      for (const x of [-1.2, FIELD_WIDTH + 1.2]) {
        const p = camera.worldToScreen(vec2(x, scene.firstDownY));
        ctx.fillStyle = theme.colors.firstDown;
        ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 2, 3, 5);
      }
    }
  }
  // ball shadow under everything that could cover it
  const ballScreen = camera.worldToScreen(vec2(scene.ball.x, scene.ball.y));
  const ballHeld = scene.ball.phase === 'held' || scene.ball.phase === 'presnap' || scene.ball.phase === 'snap';
  if (!ballHeld && scene.ball.phase !== 'dead') drawShadow(ctx, ballScreen, scene.ball.z, zoom, theme.colors.shadow);
  // athletes back to front (screen y ascending), in game-day uniforms (home colours vs away whites)
  const uniforms = teamUniforms(palettes);
  const ordered = [...scene.athletes].sort((a, b) => camera.worldToScreen(vec2(a.x, a.y)).y - camera.worldToScreen(vec2(b.x, b.y)).y);
  const lifts = pileLifts(ordered);
  for (const a of ordered) {
    const p = camera.worldToScreen(vec2(a.x, a.y));
    p.y -= (lifts.get(a.id) ?? 0) * scale;
    if (!camera.isVisible(vec2(a.x, a.y), 3)) continue;
    const dir = camera.screenFacing(a.facing);
    const anim = animForState(a.state);
    const palette = a.teamSide === 'home' ? uniforms.home : uniforms.away;
    const sprite = generateAthleteSprite(opts.sprites, {
      palette, skinTone: skinToneFromSeed(hashId(a.playerId)), group: POSITION_GROUP[a.position], facing: facingFromScreenVector(dir.x, dir.y),
      anim, frame: animate ? frameFor(anim, a.stateTimer) : 0, number: a.number,
    });
    drawSprite(ctx, sprite, p.x, p.y + 1, { scale });
    if (a.hasBall) {
      const ball = generateBallSprite(opts.sprites, { frame: 0 });
      drawSprite(ctx, ball, p.x + dir.x * 4 * scale, p.y - 6 * scale, { scale: Math.max(1, scale - 0) });
    }
  }
  // free ball above the crowd
  if (!ballHeld && scene.ball.phase !== 'dead') {
    const ball = generateBallSprite(opts.sprites, { frame: animate ? Math.floor(opts.time * 10) % 4 : 0 });
    drawSprite(ctx, ball, ballScreen.x, ballScreen.y - scene.ball.z * zoom * 0.5, { scale });
  }
  drawPrompts(ctx, camera, scene, opts, controlled);
};

/**
 * Receiver glyphs, switch hints and the edge pointer to the athlete the user controls when he is out of view; `head`
 * is the logical px from the feet to the bottom of a glyph (clears the figure).
 */
const drawPrompts = (ctx: FieldViewCtx, camera: Camera, scene: FieldScene, opts: FieldViewOptions, controlled: SceneAthlete | null, head?: number): void => {
  const theme = opts.theme;
  const s = theme.textScale;
  const lift = head ?? 12 * s;
  if (controlled && controlled.side === 'offense' && controlled.hasBall && controlled.role === 'QB' && opts.receiverSlots && (scene.ball.phase === 'held' || scene.presnap)) {
    opts.receiverSlots.forEach((role, i) => {
      const r = scene.athletes.find((a) => a.side === 'offense' && a.role === role && a.active);
      if (!r) return;
      const p = camera.worldToScreen(vec2(r.x, r.y));
      const glyph = opts.receiverGlyphs?.[i] ?? String(i + 1);
      const w = glyph.length * 6 * s + 2;
      const gh = 8 * s + 2;
      // The glyph sits above his head; a receiver out of the close view (a wide split off the top or bottom edge, a
      // deep route past the side) gets it pinned to that edge with a pixel arrow pointing at him.
      const edge = offEdge(p.x, p.y, p.y - lift, camera.width, camera.height);
      const box = pinBox(p.x - w / 2, p.y - lift - gh, w, gh, camera.width, camera.height, edge);
      const col = i === 0 ? theme.colors.accent : theme.colors.text;
      ctx.fillStyle = theme.colors.shadow;
      ctx.fillRect(box.x, box.y, w, gh);
      drawText(ctx, glyph, box.x + w / 2, box.y + 1, { color: col, size: s, align: 'center' });
      if (edge) {
        const tip = arrowTip(edge, box, w, gh);
        drawEdgeArrow(ctx, edge, tip.x, tip.y, col, theme.colors.shadow);
      }
    });
  }
  if (opts.switchHints && controlled && controlled.side === 'defense' && !scene.presnap) {
    const ball = vec2(scene.ball.x, scene.ball.y);
    let best: SceneAthlete | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const a of scene.athletes) {
      if (a.side !== 'defense' || !a.active || a.id === controlled.id) continue;
      const d = Math.hypot(a.x - ball.x, a.y - ball.y);
      if (d < bestD) { bestD = d; best = a; }
    }
    if (best) {
      const p = camera.worldToScreen(vec2(best.x, best.y));
      ctx.fillStyle = theme.colors.accent2;
      ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - lift - 8 * s, 3, 3);
      drawText(ctx, '▼', p.x, p.y - lift - 7 * s, { color: theme.colors.accent2, size: s, align: 'center' });
    }
  }
  // Whoever the user controls (a deep safety, a split corner, a returner) always has a way back into view.
  if (controlled) {
    const p = camera.worldToScreen(vec2(controlled.x, controlled.y));
    const edge = offEdge(p.x, p.y, p.y - lift, camera.width, camera.height, 0);
    if (edge) drawEdgePointer(ctx, edge, p.x, p.y - lift / 2, camera.width, camera.height, theme.colors.accent, theme.colors.shadow);
  }
};

/** Convenience: project + draw a PlayState. */
export const drawPlayState = (ctx: FieldViewCtx, camera: Camera, play: PlayState, buffer: SnapshotBuffer | null, alpha: number, opts: FieldViewOptions): FieldScene => {
  const scene = sceneFromPlay(play, buffer, alpha);
  drawScene(ctx, camera, scene, opts);
  return scene;
};
