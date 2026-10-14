/**
 * Scene compositor for the world layer (art bible §1.5 draw order), in art pixels:
 *  1-3. ground, field paint and stadium (pass `ground`, `stadium`; default: the legacy painters under a WD transform);
 *  4.   sideline down markers at the line of scrimmage and the line to gain (pass `markers`);
 *  5.   the shadow pass (pass `shadows`), 6. the controlled-player ring (pass `ring`);
 *  7.   the sorted pass, strictly back to front by feet y (ties: left to right, then id): figures (anim-select looks
 *       -> atlas frames) and registered sorted objects; at tiers 1-2 a figure drawn over another gets a 1-px
 *       separating rim there (world-layer-rim.ts), so rows of same-colour linemen stay individual bodies;
 *  8.   the ball in flight (pass `ball`), 9. effects and weather (passes `effects`, `weather`).
 * Chain C replaces passes with `setWorldPass` and adds sorted objects with `registerSortedObjects`; chains A and B
 * plug in through the anim / atlas registries. Figures are placed at `toArt(camera, pos)` of their simulated spot
 * plus the render-only line spacing (world-layer-line.ts: the fan across the line of scrimmage and the pre-snap
 * neutral-zone push), snapped, offset by their look (clamped to MAX_RENDER_OFFSET x tier), and sized by the zoom
 * tier (with hysteresis). The per-view state
 * (animation memory, tier, last frame per athlete) is kept per camera. Nothing here feeds back into the simulation.
 */
import { vec2 } from '@/core/vec2';
import { perfNow } from '@/tools/frame-stats';
import { FIELD_WIDTH, type TeamSide } from '@/game/types';
import type { Camera } from '../camera';
import type { FieldScene, FieldViewOptions, SceneAthlete } from '../game/field-view';
import { drawField } from './field';
import { teamUniforms, type ResolvedPalettes } from './palette';
import { drawStadium } from './stadium';
import { drawSprite, facingFromScreenVector, generateBallSprite, SKIN_TONES } from './sprites';
import { bodyVarFor, buildForPosition, makeKit, MAX_RENDER_OFFSET, type FigureKit, type FrameRequest, type Look } from './anim';
import { AnimMemory } from './anim-memory';
import { chooseLooks, stanceFor, type LookContext, type PlacedAthlete } from './anim-select';
import { installLegacyPainter } from './anim-legacy';
import { FIGURE_ATLAS, prerenderCast, resolveFigure, type CastMember, type ResolvedFigure } from './atlas-figures';
import { drawAtlasFrame } from './atlas';
import type { WorldLayer } from './canvas';
import './world-layer-install';
import { lastPlayEvent } from './figures/contact-events';
import { lineSpacingYd, spacingCarrier, type LineSpacingContext } from './world-layer-line';
import { OverlapRims, paintRimRuns, RIM_MAX_TIER, rimMaskOf } from './world-layer-rim';
import { claimWorld, hashStr, recordWorldTiming, setWorldTimingExtra, TIER_SCALE, tierForZoom, toArt, withLogical, WD, type FigureTier } from './world-layer';

/**
 * A figure ready to draw: placement, look, request and resolved frame. (x, y) is the frame anchor in art px (lifted
 * by piles and the look's lift); `groundY` is where the feet meet the ground (shadows, the ring and the draw order).
 */
export interface PlacedFigure {
  p: PlacedAthlete;
  scene: SceneAthlete;
  look: Look;
  req: FrameRequest;
  fig: ResolvedFigure | null;
  x: number;
  y: number;
  groundY: number;
}

/** What a world pass receives. */
export interface WorldPassArgs {
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  scene: FieldScene;
  opts: FieldViewOptions;
  wd: number;
  tier: FigureTier;
  tierScale: number;
  /** Settings.animations and not reduced motion. */
  animate: boolean;
  figures: readonly PlacedFigure[];
}

/** Replaceable stages of the draw order (§1.5). */
export type WorldPassName = 'ground' | 'stadium' | 'markers' | 'shadows' | 'ring' | 'ball' | 'effects' | 'weather';
/** A pass body: draws on `args.ctx` in art pixels. */
export type WorldPass = (args: WorldPassArgs) => void;
/** An object drawn in the sorted pass at feet-y `y` (art px); `x` breaks ties (left first; default 0). */
export interface SortedObject { y: number; x?: number; draw: () => void }
/** Supplies objects for the sorted pass each frame. */
export type SortedSource = (args: WorldPassArgs) => readonly SortedObject[];

const passes = new Map<WorldPassName, WorldPass>();
const sortedSources: SortedSource[] = [];

/** Replaces a pass (null restores the default). */
export const setWorldPass = (name: WorldPassName, fn: WorldPass | null): void => {
  if (fn) passes.set(name, fn);
  else passes.delete(name);
};

/** Adds a source of sorted objects (pylons, goal-post bases, sideline people, ground effects). Returns an unregister. */
export const registerSortedObjects = (fn: SortedSource): (() => void) => {
  sortedSources.push(fn);
  return () => {
    const i = sortedSources.indexOf(fn);
    if (i >= 0) sortedSources.splice(i, 1);
  };
};

(globalThis as { __glAtlas?: typeof FIGURE_ATLAS.stats }).__glAtlas = FIGURE_ATLAS.stats;
setWorldTimingExtra(() => `ATLAS ${FIGURE_ATLAS.size}`);

/** Tier the live action is prerendered at (CLOSE zoom). */
export const LIVE_TIER: FigureTier = 1;

/** Per-camera view state. */
interface ViewState { mem: AnimMemory; tier: FigureTier | undefined; lastKey: Map<string, string>; queuedFor: string | null }
const views = new WeakMap<Camera, ViewState>();
const viewOf = (camera: Camera): ViewState => {
  let v = views.get(camera);
  if (!v) views.set(camera, (v = { mem: new AnimMemory(), tier: undefined, lastKey: new Map(), queuedFor: null }));
  return v;
};

/** The animation memory of a camera's view (chain B and tests read it). */
export const viewMemory = (camera: Camera): AnimMemory => viewOf(camera).mem;

/** Figure tier a camera's view drew with last (with hysteresis); the raw tier of its zoom before the first draw. */
export const viewTier = (camera: Camera): FigureTier => viewOf(camera).tier ?? tierForZoom(camera.zoom);

const kitCache = new WeakMap<ResolvedPalettes, Record<TeamSide, FigureKit>>();
const kitsFor = (palettes: ResolvedPalettes): Record<TeamSide, FigureKit> => {
  let k = kitCache.get(palettes);
  if (!k) {
    const u = teamUniforms(palettes);
    k = { home: makeKit('home', palettes.home, u.home), away: makeKit('away', palettes.away, u.away) };
    kitCache.set(palettes, k);
  }
  return k;
};

/** Skin tone index of a player (same hash as the legacy view, so skin tones do not change). */
export const skinIndexFor = (playerId: string): number => {
  let h = 5381;
  for (let i = 0; i < playerId.length; i++) h = ((h << 5) + h + playerId.charCodeAt(i)) | 0;
  return Math.abs(h) % SKIN_TONES.length;
};

const ellipse = (ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void => {
  const h = Math.max(1, Math.round(ry));
  for (let y = -h; y <= h; y++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (h * h))));
    if (half > 0) ctx.fillRect(Math.round(cx) - half, Math.round(cy) + y, half * 2, 1);
  }
};

const defaultGround: WorldPass = ({ ctx, camera, scene, opts }) => {
  const south = scene.southTeam ?? 'home';
  const north: TeamSide = south === 'home' ? 'away' : 'home';
  const abbr = { home: opts.homeAbbr, away: opts.awayAbbr };
  const theme = opts.theme;
  withLogical(ctx, () => drawField(ctx, camera, {
    weather: opts.weather, fieldType: opts.fieldType, endZoneColors: { home: opts.palettes[south].primary, away: opts.palettes[north].primary },
    homeAbbr: abbr[south], awayAbbr: abbr[north], losY: scene.losY, firstDownY: scene.firstDownY, dir: scene.direction,
    time: theme.reducedMotion ? 0 : opts.time, losColor: theme.colors.los, firstDownColor: theme.colors.firstDown,
  }));
};

const defaultStadium: WorldPass = ({ ctx, camera, opts, animate }) => {
  const stadium = opts.stadium;
  if (stadium) withLogical(ctx, () => drawStadium(ctx, camera, stadium, { time: opts.time, animations: animate }));
};

const defaultMarkers: WorldPass = ({ ctx, camera, scene, opts, tierScale }) => {
  const pole = (y: number, color: string): void => {
    for (const x of [-1.6, FIELD_WIDTH + 1.6]) {
      const p = toArt(camera, vec2(x, y));
      const h = Math.round(17 * tierScale);
      ctx.fillStyle = 'rgba(8,20,10,0.28)';
      ellipse(ctx, p.x + 3, p.y, 4, 1.5);
      ctx.fillStyle = '#1b1d24'; ctx.fillRect(p.x - 2, p.y - h, 4, h);
      ctx.fillStyle = '#e8e8e0'; ctx.fillRect(p.x - 1, p.y - h + 1, 2, h - 1);
      ctx.fillStyle = '#1b1d24'; ctx.fillRect(p.x - 5, p.y - h - 5, 10, 7);
      ctx.fillStyle = color; ctx.fillRect(p.x - 4, p.y - h - 4, 8, 5);
    }
  };
  if (scene.losY !== null) pole(scene.losY, opts.theme.colors.los);
  if (scene.firstDownY !== null) pole(scene.firstDownY, opts.theme.colors.firstDown);
};

const defaultShadows: WorldPass = ({ ctx, figures, tierScale, camera, scene }) => {
  ctx.fillStyle = 'rgba(8,20,10,0.28)';
  for (const f of figures) {
    const rx = (f.look.lying ? 13 : 8) * tierScale;
    ellipse(ctx, f.x + 2, f.groundY + 1, rx, rx * 0.4);
  }
  const b = scene.ball;
  if (b.phase !== 'held' && b.phase !== 'presnap' && b.phase !== 'snap' && b.phase !== 'dead') {
    const p = toArt(camera, vec2(b.x, b.y));
    const r = Math.max(2, (5 - Math.min(3, b.z * 0.4)) * tierScale * 2);
    ellipse(ctx, p.x, p.y, r, r * 0.45);
  }
};

const defaultRing: WorldPass = ({ ctx, camera, scene, figures, animate, opts }) => {
  const f = figures.find((q) => q.scene.id === scene.controlledId);
  if (!f) return;
  const rx = Math.max(8, Math.round(0.62 * camera.zoom * WD));
  const ry = Math.max(4, Math.round(rx * 0.42));
  ctx.globalAlpha = animate && !opts.theme.reducedMotion ? 0.85 + 0.15 * Math.sin(opts.time * Math.PI * 4) : 1;
  ctx.fillStyle = '#ffd23f';
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    ctx.fillRect(Math.round(f.x + Math.cos(a) * rx) - 1, Math.round(f.groundY + Math.sin(a) * ry) - 1, 2, 2);
  }
  // chevron on the screen-forward side: a shape cue as well as a colour one
  const d = f.p.dir;
  const cx = Math.round(f.x + d.x * (rx + 3));
  const cy = Math.round(f.groundY + d.y * (ry + 2));
  ctx.fillRect(cx - 1, cy - 1, 3, 3);
  ctx.globalAlpha = 1;
};

const drawBallAt = (ctx: CanvasRenderingContext2D, opts: FieldViewOptions, x: number, y: number, frame: number, tier: FigureTier): void => {
  const ball = generateBallSprite(opts.sprites, { frame });
  drawSprite(ctx, ball, x, y, { scale: tier <= 2 ? 2 : 1 });
};

const defaultBall: WorldPass = ({ ctx, camera, scene, opts, animate, tier, wd }) => {
  const b = scene.ball;
  if (b.phase === 'held' || b.phase === 'presnap' || b.phase === 'snap' || b.phase === 'dead') return;
  const p = toArt(camera, vec2(b.x, b.y));
  drawBallAt(ctx, opts, p.x, p.y - Math.round(b.z * camera.zoom * 0.5 * wd), animate ? Math.floor(opts.time * 10) % 4 : 0, tier);
};

const runPass = (name: WorldPassName, fallback: WorldPass | null, args: WorldPassArgs): void => {
  const fn = passes.get(name) ?? fallback;
  if (fn) fn(args);
};

/** Tick of the scene (frame clock x 60 when the scene has none: an empty field between plays). */
const sceneTick = (scene: FieldScene, time: number): number => scene.tick ?? time * 60;

/** Line-spacing facts of a scene (the snap from the view's event memory). */
const spacingOf = (view: ViewState, scene: FieldScene, tier: FigureTier): LineSpacingContext => {
  const snap = scene.presnap ? null : lastPlayEvent(view.mem, 'snap');
  return {
    tier, losY: scene.losY, snapX: scene.snapX, sinceSnap: scene.presnap ? null : snap ? view.mem.timeSince(snap) : 1e9,
    carrier: spacingCarrier(scene.athletes), controlledId: scene.controlledId ?? null,
  };
};

/** Places the athletes, picks their looks and resolves their frames. */
const placeFigures = (view: ViewState, camera: Camera, scene: FieldScene, opts: FieldViewOptions, tier: FigureTier, lifts: ReadonlyMap<string, number>, animate: boolean): PlacedFigure[] => {
  const tierScale = TIER_SCALE[tier];
  const placed: PlacedAthlete[] = [];
  const byScene = new Map<string, SceneAthlete>();
  const pileArt = new Map<string, number>();
  // Looks are chosen for everyone on the field (the animation memory must not depend on what the camera happens
  // to show: a replay stepped at any rate picks the same clips); only the athletes in view are resolved and drawn.
  const visible = new Set<string>();
  const spacing = spacingOf(view, scene, tier);
  for (const a of scene.athletes) {
    if (camera.isVisible(vec2(a.x, a.y), 3)) visible.add(a.id);
    const nudge = lineSpacingYd(spacing, a);
    const p = toArt(camera, vec2(a.x + nudge.dx, a.y + nudge.dy));
    const dir = camera.screenFacing(a.facing);
    const body = camera.screenFacing(a.bodyFacing ?? a.facing);
    byScene.set(a.id, a);
    const pile = Math.round((lifts.get(a.id) ?? 0) * WD * tierScale);
    pileArt.set(a.id, pile);
    placed.push({ a, x: p.x, y: p.y - pile, wx: a.x, wy: a.y, dir, body });
  }
  const ctx: LookContext = {
    mem: view.mem, presnap: scene.presnap, tier, animate, ball: scene.ball, losY: scene.losY, snapX: scene.snapX,
    placed, byId: new Map(placed.map((q) => [q.a.id, q])),
  };
  const looks = chooseLooks(ctx);
  const kits = kitsFor(opts.palettes);
  const lighting = scene.lighting ?? 'day';
  const maxOff = Math.round(MAX_RENDER_OFFSET * tierScale);
  const out: PlacedFigure[] = [];
  for (const p of placed) {
    if (!visible.has(p.a.id)) continue;
    const a = byScene.get(p.a.id) as SceneAthlete;
    const look = looks.get(a.id) ?? { clip: 'idle', frame: 0, facing: facingFromScreenVector(p.dir.x, p.dir.y), dx: 0, dy: 0 };
    const build = buildForPosition(a.position);
    const req: FrameRequest = {
      clip: look.clip, frame: look.frame, facing: look.facing, build, bodyVar: bodyVarFor(build, a.weightLb), tier, kit: kits[a.teamSide],
      skin: skinIndexFor(a.playerId), number: a.number, ball: a.hasBall, accessory: hashStr(a.playerId), lighting,
    };
    const fig = resolveFigure(FIGURE_ATLAS, req, view.lastKey.get(a.id) ?? null);
    if (fig) view.lastKey.set(a.id, fig.key);
    const dx = Math.max(-maxOff, Math.min(maxOff, Math.round(look.dx)));
    const dy = Math.max(-maxOff, Math.min(maxOff, Math.round(look.dy)));
    out.push({ p, scene: a, look, req, fig, x: p.x + dx, y: p.y + dy - Math.round(look.lift ?? 0), groundY: p.y + (pileArt.get(a.id) ?? 0) + dy });
  }
  return out;
};

/**
 * Queues the prerender of everyone on the field once per play (pre-snap): stances at the tier shown now, the run /
 * carry / block cycles at LIVE_TIER (the CLOSE view the play is mostly watched at; other tiers paint lazily).
 */
const queuePrerender = (view: ViewState, scene: FieldScene, opts: FieldViewOptions, tier: FigureTier, figures: readonly PlacedFigure[]): void => {
  const key = scene.playKey ?? '';
  if (!scene.presnap || view.queuedFor === key) return;
  view.queuedFor = key;
  const kits = kitsFor(opts.palettes);
  const cast: CastMember[] = figures.map((f) => ({
    kit: kits[f.scene.teamSide], build: f.req.build, bodyVar: f.req.bodyVar, skin: f.req.skin, number: f.req.number, accessory: f.req.accessory,
    stance: stanceFor(f.p, { snapX: scene.snapX, ball: scene.ball }), facing: f.look.facing,
  }));
  prerenderCast(FIGURE_ATLAS, cast, LIVE_TIER, scene.lighting ?? 'day', tier);
};

/** Draws the scene on the world layer; `lifts` are the pile lifts in logical px (field-view's pileLifts). */
export const drawWorldScene = (layer: WorldLayer, camera: Camera, scene: FieldScene, opts: FieldViewOptions, lifts: ReadonlyMap<string, number>): readonly PlacedFigure[] => {
  const t0 = perfNow();
  installLegacyPainter();
  const ctx = claimWorld(layer, opts.theme.colors.bg);
  const view = viewOf(camera);
  FIGURE_ATLAS.beginFrame();
  view.mem.sync({ playKey: scene.playKey ?? null, tick: sceneTick(scene, opts.time), events: scene.events ?? [], frames: scene.frames ?? null });
  const tier = tierForZoom(camera.zoom, view.tier);
  view.tier = tier;
  const tierScale = TIER_SCALE[tier];
  const animate = opts.animations ?? true;
  const decorAnimate = animate && !opts.theme.reducedMotion;
  const base: WorldPassArgs = { ctx, camera, scene, opts, wd: WD, tier, tierScale, animate: decorAnimate, figures: [] };
  runPass('ground', defaultGround, base);
  runPass('stadium', defaultStadium, base);
  runPass('markers', defaultMarkers, base);
  const figures = placeFigures(view, camera, scene, opts, tier, lifts, animate);
  const args: WorldPassArgs = { ...base, figures };
  runPass('shadows', defaultShadows, args);
  runPass('ring', defaultRing, args);
  const rims = tier <= RIM_MAX_TIER ? rimsFor(layer) : null;
  rims?.reset();
  // By where the feet meet the ground: a body lifted onto a pile still draws over the bodies beneath it.
  const sorted: SortedObject[] = figures.map((f) => ({ y: f.groundY + (f.look.layer ?? 0) * 0.01, x: f.x, draw: () => drawFigure(ctx, f, opts, tier, rims) }));
  for (const src of sortedSources) sorted.push(...src(args));
  sortBackToFront(sorted);
  for (const o of sorted) o.draw();
  runPass('ball', defaultBall, args);
  runPass('effects', null, args);
  runPass('weather', null, args);
  queuePrerender(view, scene, opts, tier, figures);
  if (FIGURE_ATLAS.pending > 0) FIGURE_ATLAS.pump(scene.presnap ? 3 : 1);
  recordWorldTiming(perfNow() - t0);
  return figures;
};

/** Overlap coverage per world layer (reused across frames). */
const rimCache = new WeakMap<WorldLayer, OverlapRims>();
const rimsFor = (layer: WorldLayer): OverlapRims => {
  let r = rimCache.get(layer);
  if (!r || r.width !== layer.width || r.height !== layer.height) rimCache.set(layer, (r = new OverlapRims(layer.width, layer.height)));
  return r;
};

/**
 * Sorts the pass strictly back to front by feet y; equal feet (a pair locked on one row) by x, then by insertion
 * order (the figures come in the scene's athlete order), so the same scene always draws in the same order.
 */
export const sortBackToFront = (list: SortedObject[]): void => {
  const idx = new Map<SortedObject, number>(list.map((o, i) => [o, i]));
  list.sort((p, q) => p.y - q.y || (p.x ?? 0) - (q.x ?? 0) || (idx.get(p) ?? 0) - (idx.get(q) ?? 0));
};

/** Draws one figure (overlap rim, cached frame, draw-time decoration, the carried ball). */
const drawFigure = (ctx: CanvasRenderingContext2D, f: PlacedFigure, opts: FieldViewOptions, tier: FigureTier, rims: OverlapRims | null): void => {
  const fig = f.fig;
  if (!fig) return;
  const mask = rims ? rimMaskOf(fig.frame) : null;
  if (rims && mask) paintRimRuns(ctx, rims.rimRuns(mask, f.x, f.y));
  drawAtlasFrame(ctx, fig.frame, f.x, f.y);
  if (rims && mask) rims.cover(mask, f.x, f.y);
  fig.painter.decorate?.(ctx, fig.frame, f.req, f.x, f.y);
  if (f.scene.hasBall && !fig.painter.drawsBall) {
    const at = fig.frame.attach?.ball ?? { x: 0, y: -12 };
    drawBallAt(ctx, opts, f.x + at.x, f.y + at.y, 0, tier);
  }
};
