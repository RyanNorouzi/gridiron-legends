/**
 * Chain C installer (art bible §16.9): replaces the world layer's placeholder passes with the world art: the ground
 * and field paint (`ground`), the stadium and crowd (`stadium`), the sideline and chain crew (sorted objects; the
 * `markers` placeholder is retired), lighting-aware shadows (`shadows`), goal posts and pylons (sorted objects), the
 * ball (`ball`), effects (`effects`) and weather plus the lighting tint (`weather`). Imported once from
 * world-layer-install.ts (the registration is deferred a microtask: this module is reached from the scene
 * compositor's own import of the hub); tests may call `installWorldArt` directly.
 */
import { FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X, type TeamSide } from '@/game/types';
import { registerSortedObjects, setWorldPass, type SortedObject, type WorldPass, type WorldPassArgs } from '../world-layer-scene';
import { mix } from '../palette';
import { WD } from '../world-layer';
import { drawBallHi } from './ball-hi';
import { crowdExcitement } from './crowd-hi';
import { drawDivots, drawEffects, effectSortedObjects } from './effects';
import { drawFieldPaint } from './field-paint';
import { drawPost, drawPylon, PYLONS } from './goalposts';
import { drawGround, groundColors } from './ground';
import { worldGameInfo } from './game-info';
import { drawLightingTint, drawNightFalloff, drawStandShadow, effectiveLighting } from './lighting';
import { acrossSign, artRect } from './art';
import { drawShadows } from './shadows';
import { sidelineDrawables, type SidelineDrawable } from './sideline';
import { drawStadiumDeco } from './stadium-deco';
import { drawStadiumHi } from './stadium-hi';
import { drawWeatherHi } from './weather-hi';

/** Crowd excitement of the scene, with an afterglow that outlasts the play (render clock). */
let glow = { level: 0, at: -Infinity };
export const sceneExcitement = (scene: WorldPassArgs['scene'], time: number): number => {
  const e = crowdExcitement(scene.events ?? [], scene.tick ?? 0, scene.presnap);
  const faded = time >= glow.at ? glow.level * Math.max(0, 1 - (time - glow.at) / 10) : 0;
  if (e > faded) glow = { level: e, at: time };
  return Math.max(e, faded);
};

const endTeams = (args: WorldPassArgs): { south: TeamSide; north: TeamSide } => {
  const south: TeamSide = args.scene.southTeam ?? 'home';
  return { south, north: south === 'home' ? 'away' : 'home' };
};

const groundPass: WorldPass = ({ ctx, camera, scene, opts, animate }) => {
  // wear grows by quarter (0.4 -> 1.0) when the screen publishes the quarter, else a mid value
  const q = worldGameInfo()?.quarter;
  const wear = q ? Math.min(1, 0.4 + 0.2 * (q - 1)) : 0.7;
  const g = drawGround(ctx, camera, { fieldType: opts.fieldType, weather: opts.weather, wear });
  if (!g.turf) drawDivots(ctx, camera, opts.palettes);
  const { south, north } = endTeams({ scene } as WorldPassArgs);
  const abbr = { home: opts.homeAbbr, away: opts.awayAbbr };
  const p = opts.palettes;
  drawFieldPaint(ctx, camera, {
    weather: opts.weather,
    south: { color: p[south].primary, accent: p[south].accent, name: abbr[south] },
    north: { color: p[north].primary, accent: p[north].accent, name: abbr[north] },
    home: { primary: p.home.primary, secondary: p.home.secondary, accent: p.home.accent, abbr: opts.homeAbbr },
    losY: scene.losY, firstDownY: scene.firstDownY, dir: scene.direction,
    losColor: opts.theme.colors.los, firstDownColor: opts.theme.colors.firstDown, time: opts.time, animate,
  });
};

const stadiumPass: WorldPass = ({ ctx, camera, scene, opts, animate }) => {
  const view = opts.stadium;
  if (!view) return;
  const night = effectiveLighting(scene.lighting, opts.weather?.type) === 'night';
  const excitement = sceneExcitement(scene, opts.time);
  const homeAccent = opts.palettes.home.accent;
  const { clubTop } = drawStadiumHi(ctx, camera, view, { time: opts.time, animate, excitement, homeAccent, night });
  drawStadiumDeco(ctx, camera, view, { time: opts.time, animate, excitement, homeAccent, awayAbbr: opts.awayAbbr, homeAbbr: opts.homeAbbr, night, weather: opts.weather }, clubTop);
};

/** The sideline objects of the frame being drawn (computed in the shadow pass, drawn in the sorted pass). */
let sideline: { scene: unknown; items: SidelineDrawable[] } = { scene: null, items: [] };

const shadowPass: WorldPass = (args) => {
  const { ctx, camera, scene, opts, tier, tierScale, figures } = args;
  const items = sidelineDrawables(ctx, camera, {
    opts, tier, lighting: effectiveLighting(scene.lighting, opts.weather?.type), excitement: sceneExcitement(scene, opts.time), animate: args.animate,
    losY: scene.losY, firstDownY: scene.firstDownY, dir: scene.direction,
  });
  sideline = { scene, items };
  drawShadows(ctx, camera, { figures, ball: scene.ball, lighting: effectiveLighting(scene.lighting, opts.weather?.type), tierScale, objects: items.flatMap((i) => (i.shadow ? [i.shadow] : [])) });
};

const sortedObjects = (args: WorldPassArgs): readonly SortedObject[] => {
  const { ctx, camera, scene, opts, animate } = args;
  const out: SortedObject[] = sideline.scene === scene ? sideline.items.map((i) => ({ y: i.y, draw: i.draw })) : [];
  const v = camera.visibleBounds();
  const { south, north } = endTeams(args);
  for (const p of PYLONS) {
    if (p.y < v.minY - 1 || p.y > v.maxY + 1 || p.x < v.minX - 1 || p.x > v.maxX + 1) continue;
    const q = camera.worldToScreen({ x: p.x, y: p.y });
    const x = Math.round(q.x * WD);
    const y = Math.round(q.y * WD);
    const team = opts.palettes[p.end === 'south' ? south : north];
    out.push({ y, draw: () => drawPylon(ctx, x, y, camera.zoom, team.accent) });
  }
  for (const end of [0, FIELD_LENGTH]) {
    if (end < v.minY - 12 || end > v.maxY + 12) continue;
    const base = camera.worldToScreen({ x: MIDDLE_X, y: end + (end === 0 ? -2 : 2) });
    const pad = opts.palettes[end === 0 ? south : north].primary;
    out.push({ y: Math.round(base.y * WD), draw: () => drawPost(ctx, camera, end, { time: opts.time, animate, weather: opts.weather, padColor: pad }) });
  }
  out.push(...effectSortedObjects(args, effectColors(args)));
  return out;
};

const ballPass: WorldPass = ({ ctx, camera, scene, opts, tierScale, animate }) => {
  drawBallHi(ctx, camera, scene.ball, scene.events ?? [], scene.tick ?? opts.time * 60, tierScale, animate);
};

/**
 * Colours of the kicked-up dust: dry soil on grass (a light khaki, only a hint of the grass), pale rubber-and-fibre
 * grey on turf, kicked snow in the snow and a grey-blue spray in the rain. Tuned from the bible's "field light tone"
 * (§9), which read as green smudges on the bodies.
 */
const effectColors = (args: WorldPassArgs): { dust: string; grass: boolean } => {
  const g = groundColors(args.opts.fieldType, args.opts.weather);
  const wt = args.opts.weather?.type;
  const dry = g.turf ? mix(g.light, '#c9ccc2', 0.7) : mix(g.light, '#d9cda6', 0.78);
  const dust = wt === 'snow' ? '#eef3f8' : wt === 'rain' || wt === 'heavyRain' ? mix(g.light, '#b9c9d3', 0.65) : dry;
  return { dust, grass: !g.turf };
};

const effectsPass: WorldPass = (args) => drawEffects(args, effectColors(args));

const weatherPass: WorldPass = (args) => {
  const { camera, scene, opts } = args;
  const lighting = effectiveLighting(scene.lighting, opts.weather?.type);
  if (lighting === 'day' && opts.stadium && opts.stadium.roof !== 'dome') {
    // the far stand's afternoon shadow: from the sideline at the top of the screen
    const topX = acrossSign(camera) > 0 ? 0 : FIELD_WIDTH;
    const y = Math.round(camera.worldToScreen({ x: topX, y: 0 }).y * WD);
    const ox = Math.round(camera.worldToScreen({ x: 0, y: 0 }).x * WD);
    drawStandShadow(args.ctx, y, camera.zoom * WD, ox, camera.width * WD, camera.height * WD);
  }
  if (lighting === 'night') drawNightFalloff(args.ctx, artRect(camera, -3, -3, FIELD_WIDTH + 6, FIELD_LENGTH + 6), camera.width * WD, camera.height * WD);
  drawWeatherHi(args);
  drawLightingTint(args.ctx, lighting, args.camera.width * WD, args.camera.height * WD);
};

/** Per-pass timing (ms, exponential average) of the world art, on globalThis.__glWorldPasses (bench harness). */
export const PASS_MS: Record<string, number> = {};
(globalThis as { __glWorldPasses?: Record<string, number> }).__glWorldPasses = PASS_MS;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const timed = <A>(name: string, fn: (a: A) => void) => (a: A): void => {
  const t0 = now();
  fn(a);
  PASS_MS[name] = (PASS_MS[name] ?? 0) * 0.95 + (now() - t0) * 0.05;
};
const timedList = <A, R>(name: string, fn: (a: A) => R) => (a: A): R => {
  const t0 = now();
  const r = fn(a);
  PASS_MS[name] = (PASS_MS[name] ?? 0) * 0.95 + (now() - t0) * 0.05;
  return r;
};

let installed = false;

/** Registers the world passes and sorted objects (idempotent). Returns false while the compositor is not loaded yet. */
export const installWorldArt = (): boolean => {
  if (installed) return true;
  if (typeof setWorldPass !== 'function' || typeof registerSortedObjects !== 'function') return false;
  try {
    setWorldPass('ground', timed('ground', groundPass));
  } catch {
    return false; // the scene module is still evaluating (import cycle): try again shortly
  }
  installed = true;
  setWorldPass('stadium', timed('stadium', stadiumPass));
  setWorldPass('markers', () => {});
  setWorldPass('shadows', timed('shadows', shadowPass));
  setWorldPass('ball', timed('ball', ballPass));
  setWorldPass('effects', timed('effects', effectsPass));
  setWorldPass('weather', timed('weather', weatherPass));
  registerSortedObjects(timedList('sorted', sortedObjects));
  return true;
};

// Deferred: this module is reached from world-layer-scene's own import of the install hub (a cycle), so the
// scene's registries exist only once the module graph has finished evaluating (in a bundler, by the next microtask;
// under a test runner's async module loader possibly later, hence the retries).
const attempt = (left: number): void => {
  if (!installWorldArt() && left > 0) setTimeout(() => attempt(left - 1), 0);
};
queueMicrotask(() => attempt(200));
