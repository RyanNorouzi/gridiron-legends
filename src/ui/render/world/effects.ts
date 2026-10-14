/**
 * Effects (art bible §9), render-only and replay-exact: every effect is an EMITTER (kind, world spot, scene tick,
 * seed) whose particles are a pure function of its age, so a replay, a slow-motion replay and a seek show the same
 * effects as live play. Emitters come from the play's events (tackles, sacks, hit sticks, pancakes, kicks, catches
 * on the sideline, touchdowns), from the looks (cuts / jukes / spins kick up turf), from engaged linemen (a puff of
 * dust every 0.4 s while they drive) and from other chains through `emitEffect`. Spots are taken from the recorded
 * frame at the event's tick when the scene carries frames, else where the athlete stood when the event was first
 * seen. Divots (torn turf where a tackle landed, grass only) persist on the ground for the game (up to 64). Reduced motion: flashes, confetti and shakes off; dust
 * is drawn static. Weather colours the impacts: rain splashes, snow puffs, sweat in the heat, breath in the cold.
 */
import type { PlayEvent } from '@/game/play-events';
import type { Camera } from '../../camera';
import type { FieldScene, SceneAthlete } from '../../game/field-view';
import type { WorldPassArgs } from '../world-layer-scene';
import { viewMemory } from '../world-layer-scene';
import { hashStr, WD } from '../world-layer';
import { h2 } from './art';

/** Effect kinds. */
export type EffectKind = 'dust' | 'turfChunk' | 'impactFlash' | 'sweatSpray' | 'rainSplash' | 'snowPuff' | 'chalkPuff' | 'kickPuff' | 'confetti' | 'breath';

/** One emitter: world spot (yards), lift above the ground (yd of height), scene tick, seed. */
export interface Emitter { kind: EffectKind; x: number; y: number; lift: number; tick: number; seed: number; colors?: readonly string[]; divot?: boolean }

/** Lifetime of each kind, seconds. */
export const LIFETIME: Readonly<Record<EffectKind, number>> = Object.freeze({
  dust: 0.45, turfChunk: 0.4, impactFlash: 0.14, sweatSpray: 0.45, rainSplash: 0.5, snowPuff: 0.6, chalkPuff: 0.5, kickPuff: 0.5, confetti: 2.6, breath: 0.6,
});

interface ViewFx { playKey: string | null; spots: Map<string, { x: number; y: number }>; manual: Emitter[] }
const views = new WeakMap<Camera, ViewFx>();
const viewFx = (camera: Camera, playKey: string | null): ViewFx => {
  let v = views.get(camera);
  if (!v || v.playKey !== playKey) views.set(camera, (v = { playKey, spots: new Map(), manual: [] }));
  return v;
};

/** Emits an effect from another chain (world yards, scene tick); kept until the play changes. */
export const emitEffect = (camera: Camera, scene: Pick<FieldScene, 'playKey'>, e: Emitter): void => {
  const v = viewFx(camera, scene.playKey ?? null);
  if (v.manual.length < 256) v.manual.push(e);
};

/** Where athlete `id` stood at `tick` (recorded frame), else the remembered / current spot. */
const spotOf = (scene: FieldScene, v: ViewFx, id: string, tick: number, key: string): { x: number; y: number } | null => {
  const frames = scene.frames;
  if (frames && frames.length > 0) {
    const first = frames[0]?.tick ?? 0;
    const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round(tick - first)))];
    const a = f?.athletes.find((q) => q.id === id);
    if (a) return { x: a.x, y: a.y };
  }
  const had = v.spots.get(key);
  if (had) return had;
  const a = scene.athletes.find((q) => q.id === id);
  if (!a) return null;
  const s = { x: a.x, y: a.y };
  v.spots.set(key, s);
  return s;
};

/** Emitters implied by the play's events (pure apart from the remembered spots). */
const eventEmitters = (scene: FieldScene, v: ViewFx, weather: 'rain' | 'snow' | 'hot' | 'none', grass: boolean): Emitter[] => {
  const out: Emitter[] = [];
  const events: readonly PlayEvent[] = scene.events ?? [];
  const impact = (x: number, y: number, tick: number, seed: number, big: boolean): void => {
    out.push({ kind: 'dust', x, y, lift: 0, tick, seed, divot: grass });
    if (grass) out.push({ kind: 'turfChunk', x, y, lift: 0, tick, seed: seed + 1 });
    if (weather === 'rain') out.push({ kind: 'rainSplash', x, y, lift: 0, tick, seed: seed + 2 });
    else if (weather === 'snow') out.push({ kind: 'snowPuff', x, y, lift: 0.6, tick, seed: seed + 2 });
    else if (big || weather === 'hot') out.push({ kind: 'sweatSpray', x, y, lift: 1.1, tick, seed: seed + 2 });
    if (Math.abs(y - Math.round(y / 5) * 5) < 0.35) out.push({ kind: 'chalkPuff', x, y, lift: 0, tick, seed: seed + 3 });
  };
  events.forEach((ev, i) => {
    const seed = hashStr(`${scene.playKey ?? ''}|${i}`);
    const at = (id: string): { x: number; y: number } | null => spotOf(scene, v, id, ev.tick, `${i}|${id}`);
    switch (ev.type) {
      case 'tackle': {
        const p = at(ev.carrier);
        if (!p) break;
        const big = ev.kind === 'hitStick' || ev.kind === 'dive';
        impact(p.x, p.y, ev.tick + (ev.kind === 'dive' ? 12 : 6), seed, big);
        break;
      }
      case 'hitStick': case 'sack': {
        const p = at(ev.type === 'sack' ? ev.by : ev.on);
        if (p) out.push({ kind: 'impactFlash', x: p.x, y: p.y, lift: 1.1, tick: ev.tick, seed });
        if (p && ev.type === 'sack') impact(p.x, p.y, ev.tick + 8, seed + 5, true);
        break;
      }
      case 'pancake': {
        const p = at(ev.defender);
        if (p) {
          out.push({ kind: 'impactFlash', x: p.x, y: p.y, lift: 1, tick: ev.tick, seed });
          impact(p.x, p.y, ev.tick + 10, seed + 5, false);
        }
        break;
      }
      case 'wrapUp': {
        const p = at(ev.carrier);
        if (p) out.push({ kind: 'dust', x: p.x, y: p.y, lift: 0, tick: ev.tick, seed });
        break;
      }
      case 'kick': {
        const p = at(ev.kicker);
        if (p) out.push({ kind: 'kickPuff', x: p.x, y: p.y, lift: 0, tick: ev.tick, seed });
        break;
      }
      case 'touchdown': {
        const scorer = scene.athletes.find((q) => q.id === ev.scorer);
        out.push({ kind: 'confetti', x: 0, y: 0, lift: 0, tick: ev.tick, seed, colors: scorer ? [scorer.teamSide] : ['home'] });
        break;
      }
      default:
        break;
    }
  });
  return out;
};

/** The event emitters of a scene for a camera's view (spots remembered per view and play). */
export const sceneEmitters = (camera: Camera, scene: FieldScene, weather: 'rain' | 'snow' | 'hot' | 'none', grass: boolean): Emitter[] =>
  eventEmitters(scene, viewFx(camera, scene.playKey ?? null), weather, grass);

/** Periodic dust while linemen drive each other (every 0.4 s per engaged athlete, phase by id; pure). */
export const driveEmitters = (athletes: readonly SceneAthlete[], tick: number): Emitter[] => {
  const out: Emitter[] = [];
  for (const a of athletes) {
    if (a.state !== 'engaged' && a.state !== 'blocking') continue;
    if (a.side !== 'defense') continue;
    const h = hashStr(a.id);
    const period = 24;
    const start = Math.floor((tick + (h % period)) / period) * period - (h % period);
    out.push({ kind: 'dust', x: a.x, y: a.y, lift: 0, tick: start, seed: h + start });
  }
  return out;
};

/** Cold-weather breath puffs every 2-3 s per athlete (pure). */
export const breathEmitters = (athletes: readonly SceneAthlete[], tick: number): Emitter[] => {
  const out: Emitter[] = [];
  for (const a of athletes) {
    const h = hashStr(a.playerId);
    const period = 120 + (h % 60);
    const start = Math.floor((tick + (h % period)) / period) * period - (h % period);
    if ((tick - start) / 60 < LIFETIME.breath) out.push({ kind: 'breath', x: a.x, y: a.y, lift: 1.55, tick: start, seed: h });
  }
  return out;
};

type Ctx = CanvasRenderingContext2D;

/**
 * A chunky round pixel puff: a disc of radius `r` art px centred on (cx, cy), filled one row at a time so a
 * translucent puff has one even alpha (overlapping rects would double it into a hard square core). r <= 1 is 2x2.
 */
export const puff = (ctx: Ctx, cx: number, cy: number, r: number): void => {
  if (r <= 1) {
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    return;
  }
  for (let dy = -r; dy < r; dy++) {
    const yy = dy + 0.5;
    const half = Math.round(Math.sqrt(Math.max(0, r * r - yy * yy)));
    if (half > 0) ctx.fillRect(cx - half, cy + dy, half * 2, 1);
  }
};

/** Draws one emitter at its age (seconds); `s` = tier scale, (x, y) art px of the ground spot. */
export const drawEmitter = (ctx: Ctx, e: Emitter, age: number, x: number, y: number, s: number, animate: boolean, dust: string, zoom: number): void => {
  const life = LIFETIME[e.kind];
  if (age < 0 || age > life) return;
  const t = animate ? age / life : 0.35;
  const hs = zoom * WD * 0.68;
  const ly = y - Math.round(e.lift * hs);
  const n = (k: number): number => h2(e.seed, k);
  switch (e.kind) {
    case 'dust': case 'kickPuff': case 'chalkPuff': case 'snowPuff': {
      const count = e.kind === 'kickPuff' ? 7 : 3 + Math.floor(n(0) * 4);
      const color = e.kind === 'chalkPuff' || e.kind === 'snowPuff' ? '#f4f6f0' : dust;
      ctx.fillStyle = color;
      for (let k = 0; k < count; k++) {
        const ang = n(k + 1) * Math.PI * 2;
        const dist = (3 + n(k + 9) * 7) * s * (0.4 + t);
        const r = Math.max(1, Math.round((2 + n(k + 17) * 2) * s * (1 + t * 0.6)));
        ctx.globalAlpha = 0.55 * (1 - t);
        const px = Math.round(x + Math.cos(ang) * dist);
        const py = Math.round(ly + Math.sin(ang) * dist * 0.5 - 4 * s * t);
        puff(ctx, px, py, r);
      }
      break;
    }
    case 'turfChunk': {
      if (!animate) return;
      for (let k = 0; k < 2 + Math.floor(n(0) * 3); k++) {
        const vx = (n(k + 1) - 0.5) * 30 * s;
        const up = (18 + n(k + 5) * 14) * s;
        const px = x + vx * t;
        const py = y - (up * t - 22 * s * t * t * 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = k % 2 === 0 ? '#5b4630' : '#2f6a2c';
        ctx.fillRect(Math.round(px), Math.round(py), k % 3 === 0 ? 2 : 1, 1);
      }
      break;
    }
    case 'impactFlash': {
      if (!animate) return;
      const r = Math.round((12 + 8 * t) * s * 0.5);
      ctx.globalAlpha = 1 - t * 0.6;
      ctx.fillStyle = '#ffe27a';
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        ctx.fillRect(Math.round(x + Math.cos(a) * r) - 1, Math.round(ly + Math.sin(a) * r) - 1, 2, 2);
      }
      if (t < 0.5) {
        ctx.fillStyle = '#ffffff';
        const c = Math.max(2, Math.round(4 * s * (1 - t)));
        ctx.fillRect(Math.round(x) - c, Math.round(ly) - 1, c * 2, 2);
        ctx.fillRect(Math.round(x) - 1, Math.round(ly) - c, 2, c * 2);
      }
      break;
    }
    case 'sweatSpray': case 'rainSplash': {
      ctx.fillStyle = e.kind === 'rainSplash' ? '#cfe2ff' : '#e8f4ff';
      if (e.kind === 'rainSplash') {
        const r = Math.round((3 + 8 * t) * s);
        ctx.globalAlpha = 0.7 * (1 - t);
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r * 0.45), 1, 1);
        }
      }
      ctx.globalAlpha = 0.85 * (1 - t);
      for (let k = 0; k < 6; k++) {
        const vx = (n(k + 1) - 0.5) * 26 * s;
        const up = (10 + n(k + 7) * 10) * s;
        ctx.fillRect(Math.round(x + vx * t), Math.round(ly - up * t + 30 * s * t * t), 1, 1);
      }
      break;
    }
    case 'breath': {
      const r = Math.max(1, Math.round((1 + 1.5 * t) * s));
      ctx.globalAlpha = 0.45 * (1 - t);
      ctx.fillStyle = '#f2f6fa';
      puff(ctx, Math.round(x + (n(1) < 0.5 ? -5 : 5) * s), Math.round(ly - 3 * s * t), r);
      break;
    }
    default:
      break;
  }
  ctx.globalAlpha = 1;
};

/** Confetti over the screen in the scoring team's colours (screen space, 2.6 s, <= 120 streamers). */
export const drawConfetti = (ctx: Ctx, age: number, seed: number, colors: readonly string[], wind: number, w = 960, h = 540): void => {
  if (age < 0 || age > LIFETIME.confetti) return;
  const fade = age > LIFETIME.confetti - 0.6 ? (LIFETIME.confetti - age) / 0.6 : 1;
  for (let k = 0; k < 120; k++) {
    const n = (j: number): number => h2(seed + k * 7, j);
    const x0 = n(1) * w;
    const fall = 50 + n(2) * 90;
    const y = -20 - n(3) * 160 + fall * age * 1.6;
    if (y < -4 || y > h + 4) continue;
    const x = x0 + Math.sin(age * (2 + n(4) * 3) + k) * 10 + wind * age * 30;
    // a streamer tumbling through 4 phases (flat, edge-on, flat, twisted); review: 1-3 px flecks were too small to
    // read as a celebration on the 960 x 540 world layer, so each is 2-5 art px with a shaded half when it twists
    const flip = Math.floor(age * 8 + k) % 4;
    const px = Math.round(((x % w) + w) % w);
    const py = Math.round(y);
    const cw = flip === 0 ? 5 : flip === 1 ? 2 : flip === 2 ? 4 : 3;
    const ch = flip === 0 ? 2 : flip === 1 ? 4 : flip === 2 ? 3 : 3;
    ctx.globalAlpha = fade;
    ctx.fillStyle = colors[k % colors.length] ?? '#ffffff';
    ctx.fillRect(px, py, cw, ch);
    if (flip === 3) {
      ctx.globalAlpha = fade * 0.35;
      ctx.fillStyle = '#000000';
      ctx.fillRect(px + 1, py, cw - 1, ch - 1);
    }
  }
  ctx.globalAlpha = 1;
};

/** A persistent divot (world yards). */
export interface Divot { x: number; y: number; seed: number }
/** Divots of each game (keyed by the game's palettes object), oldest first, at most 64. */
const divots = new WeakMap<object, Divot[]>();

/** Records a divot for a game (deduplicated by spot: a replay of the play adds none). */
export const addDivot = (game: object, d: Divot): void => {
  let list = divots.get(game);
  if (!list) divots.set(game, (list = []));
  if (list.some((q) => Math.hypot(q.x - d.x, q.y - d.y) < 0.35)) return;
  list.push(d);
  if (list.length > 64) list.shift();
};

/** Draws a game's divots on the ground (ground pass): torn turf, darker and browner, 0.3 x 0.15 yd. */
export const drawDivots = (ctx: Ctx, camera: Camera, game: object): void => {
  const list = divots.get(game);
  if (!list || list.length === 0) return;
  const v = camera.visibleBounds();
  const ppy = camera.zoom * WD;
  for (const d of list) {
    if (d.x < v.minX - 1 || d.x > v.maxX + 1 || d.y < v.minY - 1 || d.y > v.maxY + 1) continue;
    const p = camera.worldToScreen({ x: d.x + (h2(d.seed, 1) - 0.5) * 0.6, y: d.y + (h2(d.seed, 2) - 0.5) * 0.6 });
    const w = Math.max(2, Math.round(0.3 * ppy));
    const h = Math.max(1, Math.round(0.15 * ppy));
    const x = Math.round(p.x * WD - w / 2);
    const y = Math.round(p.y * WD - h / 2);
    ctx.fillStyle = 'rgba(70,52,30,0.55)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(40,30,18,0.5)';
    ctx.fillRect(x + 1, y + h - 1, Math.max(1, w - 2), 1);
    ctx.fillStyle = 'rgba(120,150,80,0.5)';
    ctx.fillRect(x - 1, y - 1, Math.max(1, Math.round(w / 2)), 1);
  }
};

/**
 * Kinds that happen at ground level (a puff at the feet, a splash ring): they join the sorted pass just in front of
 * the feet they rise from, so a body standing nearer the camera covers them and they never smear over a torso. The
 * rest (impact flash, sweat, breath, snow puff, flying turf) are airborne and draw after the figures.
 */
export const GROUND_EFFECTS: ReadonlySet<EffectKind> = new Set<EffectKind>(['dust', 'kickPuff', 'chalkPuff', 'rainSplash']);

/** One effect to draw this frame: its emitter, age (s) and ground spot in art px. */
export interface LiveEffect { e: Emitter; age: number; x: number; y: number }

interface FrameFx { scene: FieldScene; tick: number; camera: Camera; live: LiveEffect[] }
let frameFx: FrameFx | null = null;

/** Every live effect of the frame (computed once per scene / tick / view; divots are recorded as a side effect). */
export const liveEffects = (args: WorldPassArgs, grass: boolean): LiveEffect[] => {
  const { camera, scene, opts, animate } = args;
  const tick = scene.tick ?? opts.time * 60;
  if (frameFx && frameFx.scene === scene && frameFx.tick === tick && frameFx.camera === camera) return frameFx.live;
  const v = viewFx(camera, scene.playKey ?? null);
  const wt = opts.weather?.type;
  const weather = wt === 'rain' || wt === 'heavyRain' ? 'rain' : wt === 'snow' ? 'snow' : wt === 'heat' ? 'hot' : 'none';
  const list = [...eventEmitters(scene, v, weather, grass), ...driveEmitters(scene.athletes, tick), ...v.manual];
  if ((opts.weather?.temperatureF ?? 60) < 40 && animate) list.push(...breathEmitters(scene.athletes, tick));
  // cuts, jukes and spins kick up turf where they started (the look memory knows when the one-shot began)
  const mem = viewMemory(camera);
  for (const f of args.figures) {
    const one = mem.of(f.scene.id).oneShot;
    if (!one || !['cut', 'juke', 'spin', 'spinMove', 'diveTackle', 'catchDive'].includes(one.clip)) continue;
    const key = `look|${f.scene.id}|${one.start}`;
    let spot = v.spots.get(key);
    if (!spot) v.spots.set(key, (spot = { x: f.scene.x, y: f.scene.y }));
    const startTick = one.start * 60;
    list.push({ kind: 'dust', x: spot.x, y: spot.y, lift: 0, tick: startTick, seed: hashStr(key) });
    if (grass) list.push({ kind: 'turfChunk', x: spot.x, y: spot.y, lift: 0, tick: startTick, seed: hashStr(key) + 1 });
  }
  const bounds = camera.visibleBounds();
  const live: LiveEffect[] = [];
  for (const e of list) {
    const age = (tick - e.tick) / 60;
    if (e.kind === 'confetti') {
      live.push({ e, age, x: 0, y: 0 });
      continue;
    }
    if (e.divot && age >= 0) addDivot(opts.palettes, { x: e.x, y: e.y, seed: e.seed });
    if (age < 0 || age > LIFETIME[e.kind] || e.x < bounds.minX - 2 || e.x > bounds.maxX + 2 || e.y < bounds.minY - 2 || e.y > bounds.maxY + 2) continue;
    const s = camera.worldToScreen({ x: e.x, y: e.y });
    live.push({ e, age, x: Math.round(s.x * WD), y: Math.round(s.y * WD) });
  }
  frameFx = { scene, tick, camera, live };
  return live;
};

/** Ground-level effects as sorted objects (feet y + 0.1: over the body they rise from, under nearer ones). */
export const effectSortedObjects = (args: WorldPassArgs, extra: { dust: string; grass: boolean }): { y: number; draw: () => void }[] =>
  liveEffects(args, extra.grass)
    .filter((l) => GROUND_EFFECTS.has(l.e.kind))
    .map((l) => ({ y: l.y + 0.1, draw: () => drawEmitter(args.ctx, l.e, l.age, l.x, l.y, args.tierScale, args.animate, extra.dust, args.camera.zoom) }));

/** The effects pass: every live airborne emitter at its age, then the confetti (ground effects are sorted objects). */
export const drawEffects = (args: WorldPassArgs, extra: { dust: string; grass: boolean }): void => {
  const { ctx, camera, opts, tierScale, animate } = args;
  for (const { e, age, x, y } of liveEffects(args, extra.grass)) {
    if (e.kind === 'confetti') {
      if (!animate) continue;
      const side = e.colors?.[0] === 'away' ? 'away' : 'home';
      const p = opts.palettes[side];
      const wind = opts.weather ? Math.cos(opts.weather.windDir) * Math.min(1, opts.weather.windMph / 20) : 0;
      drawConfetti(ctx, age, e.seed, [p.primary, p.accent, '#f4f4ee', p.secondary], wind);
      continue;
    }
    if (GROUND_EFFECTS.has(e.kind)) continue;
    drawEmitter(ctx, e, age, x, y, tierScale, animate, extra.dust, camera.zoom);
  }
};
