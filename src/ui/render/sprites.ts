/**
 * Procedural pixel sprites: athletes (helmet, jersey with number, pants, skin) in 8 facings with idle, run,
 * catch, throw, kick, block, dive, tackled and down poses, the tackle-struggle poses (wrapped / wrapping / falling,
 * see sprite-contact.ts), plus the ball. Everything is painted into a plain
 * RGBA buffer so Node tests can assert pixels; the browser wraps the buffer in a canvas lazily on first draw.
 * Generation is a pure function of the parameters (no randomness) and cached by key.
 */
import { ObjectPool } from '@/core/pool';
import type { AthleteState } from '@/game/play-types';
import type { PositionGroup } from '@/players/types';
import type { TeamColors } from '@/teams/types';
import { hexToRgb, type Rgb } from './palette';
import { contactPose, drawReach, FALL_TILT, NEUTRAL, tiltBuffer, type ArmPose, type Pose } from './sprite-contact';
import { microDigitRows } from './text';

export const SPRITE_W = 16;
export const SPRITE_H = 16;
export const BALL_SPRITE_SIZE = 8;

/** Facing in SCREEN space: 'n' = up on the canvas (we see the back), 's' = down (face and numbers visible). */
export type Facing8 = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const FACINGS: readonly Facing8[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
export type SpriteAnim = 'idle' | 'run' | 'tackled' | 'down' | 'catch' | 'throw' | 'kick' | 'dive' | 'block' | 'celebrate'
  | 'wrapped' | 'wrapping' | 'falling';
export const ANIM_FRAMES: Readonly<Record<SpriteAnim, number>> = Object.freeze({
  idle: 1, run: 4, tackled: 2, down: 1, catch: 2, throw: 2, kick: 2, dive: 1, block: 2, celebrate: 2, wrapped: 4, wrapping: 2, falling: 2,
});
/** Animations that loop (the rest play once and hold their last frame). */
const LOOPING: ReadonlySet<SpriteAnim> = new Set<SpriteAnim>(['run', 'celebrate', 'wrapped', 'wrapping']);

export interface PixelBuffer {
  width: number;
  height: number;
  /** RGBA, row-major, alpha 0 or 255. */
  data: Uint8ClampedArray;
}

export interface Sprite extends PixelBuffer {
  key: string;
  /** Pixel of the buffer that sits on the athlete's world position (feet centre / ball centre). */
  anchorX: number;
  anchorY: number;
  /** Lazily created drawable copy (browser only); null in Node. */
  image: CanvasImageSource | null;
}

export interface AthleteSpriteParams {
  palette: TeamColors;
  skinTone: string;
  group: PositionGroup;
  facing: Facing8;
  anim: SpriteAnim;
  frame: number;
  /** Jersey number 0..99. */
  number: number;
}

export interface BallSpriteParams {
  /** Rotation step 0..3 (45 degrees each). */
  frame: number;
}

export const SKIN_TONES: readonly string[] = Object.freeze(['#f5d5b8', '#e2b48f', '#c98d63', '#a56a41', '#7a4a2c', '#4d2e1b']);

/** Deterministic skin tone for a player, from any integer seed (e.g. a hash of the player id). */
export const skinToneFromSeed = (seed: number): string => SKIN_TONES[Math.abs(Math.floor(seed)) % SKIN_TONES.length] as string;

/** Facing for a direction expressed in screen space (+x right, +y down). Zero vectors face south. */
export const facingFromScreenVector = (sx: number, sy: number): Facing8 => {
  if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) return 's';
  const sector = ((Math.round(Math.atan2(sy, sx) / (Math.PI / 4)) % 8) + 8) % 8;
  return FACINGS[sector] as Facing8;
};

/** Pose family for an engine athlete state. */
export const animForState = (state: AthleteState): SpriteAnim => {
  switch (state) {
    case 'moving': case 'scrambling': case 'dropback': case 'juking': case 'spinning': case 'hurdling': case 'stiffArming':
    case 'trucking': case 'stumbling': case 'shedding':
      return 'run';
    case 'tackled': case 'sliding': return 'tackled';
    case 'down': return 'down';
    case 'diving': case 'tackling': return 'dive';
    case 'catching': case 'jumping': return 'catch';
    case 'throwing': return 'throw';
    case 'kicking': return 'kick';
    case 'blocking': case 'engaged': return 'block';
    case 'celebrating': return 'celebrate';
    case 'wrapped': return 'wrapped';
    case 'wrapping': return 'wrapping';
    case 'falling': return 'falling';
    default: return 'idle';
  }
};

/** Frame index wrapped into 0..ANIM_FRAMES[anim]-1 (negative frames wrap too). */
const wrapFrame = (anim: SpriteAnim, frame: number): number => {
  const n = ANIM_FRAMES[anim];
  return ((Math.floor(frame) % n) + n) % n;
};

/** Frame index for an animation at `timeSec` (cycles for run/celebrate/struggle, holds the last frame otherwise). */
export const frameFor = (anim: SpriteAnim, timeSec: number, fps = 8): number => {
  const n = ANIM_FRAMES[anim];
  const raw = Math.floor(Math.max(0, timeSec) * fps);
  return LOOPING.has(anim) ? raw % n : Math.min(raw, n - 1);
};

/* ---------------------------------- painter ---------------------------------- */

interface Painter {
  mirror: boolean;
  px(x: number, y: number, c: Rgb): void;
  rect(x: number, y: number, w: number, h: number, c: Rgb): void;
}

const makePainter = (buf: PixelBuffer): Painter => {
  const p: Painter = {
    mirror: false,
    px: (x, y, c) => {
      const xx = p.mirror ? buf.width - 1 - x : x;
      if (xx < 0 || y < 0 || xx >= buf.width || y >= buf.height) return;
      const i = (y * buf.width + xx) * 4;
      buf.data[i] = c.r;
      buf.data[i + 1] = c.g;
      buf.data[i + 2] = c.b;
      buf.data[i + 3] = 255;
    },
    rect: (x, y, w, h, c) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) p.px(xx, yy, c);
    },
  };
  return p;
};

/** Darkens every opaque pixel that touches transparency, giving a crisp silhouette without adding pixels. */
const outlineEdges = (buf: PixelBuffer, factor = 0.55): void => {
  const { width, height, data } = buf;
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] === 255;
  const edges: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaque(x, y)) continue;
      if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) edges.push((y * width + x) * 4);
    }
  }
  for (const i of edges) {
    data[i] = Math.round((data[i] as number) * factor);
    data[i + 1] = Math.round((data[i + 1] as number) * factor);
    data[i + 2] = Math.round((data[i + 2] as number) * factor);
  }
};

/* --------------------------------- athlete ---------------------------------- */

const BULK: Readonly<Record<PositionGroup, number>> = { QB: 1, RB: 1, WR: 0, TE: 1, OL: 2, DL: 2, LB: 1, DB: 0, ST: 0 };
const MASK: Rgb = { r: 62, g: 64, b: 72 };
const SHOE: Rgb = { r: 28, g: 28, b: 34 };
const WHITE: Rgb = { r: 244, g: 244, b: 238 };

const poseFor = (anim: SpriteAnim, frame: number, side: boolean): Pose => {
  const f = wrapFrame(anim, frame);
  const contact = contactPose(anim, f, side);
  if (contact) return contact;
  switch (anim) {
    case 'run': {
      const stride = side ? 2 : 1;
      if (f === 0) return { ...NEUTRAL, legL: { dx: -stride, dy: 0 }, legR: { dx: 0, dy: -1 }, armR: 'swing' };
      if (f === 2) return { ...NEUTRAL, legL: { dx: 0, dy: -1 }, legR: { dx: stride, dy: 0 }, armL: 'swing' };
      return { ...NEUTRAL, bob: 1 };
    }
    case 'catch': return { ...NEUTRAL, armL: f === 0 ? 'up' : 'chest', armR: f === 0 ? 'up' : 'chest' };
    case 'throw': return f === 0 ? { ...NEUTRAL, armR: 'up', armL: 'swing' } : { ...NEUTRAL, armR: 'out', bob: 1 };
    case 'kick': return f === 0 ? { ...NEUTRAL, legR: { dx: 1, dy: 0 }, armL: 'out' } : { ...NEUTRAL, kickLeg: true, armL: 'out', armR: 'out' };
    case 'block': return { ...NEUTRAL, armL: f === 0 ? 'up' : 'swing', armR: f === 0 ? 'up' : 'swing', bob: f };
    case 'celebrate': return { ...NEUTRAL, armL: 'up', armR: 'up', bob: f };
    case 'tackled': return { ...NEUTRAL, lean: 2, legL: { dx: -1, dy: 0 }, legR: { dx: 1, dy: 0 } };
    default: return NEUTRAL;
  }
};

interface AthleteInk { primary: Rgb; secondary: Rgb; accent: Rgb; helmet: Rgb; skin: Rgb }

const drawArm = (p: Painter, ink: AthleteInk, x: number, pose: ArmPose, bob: number): void => {
  switch (pose) {
    case 'down': p.rect(x, 9 + bob, 1, 3, ink.skin); break;
    case 'swing': p.rect(x, 8 + bob, 1, 2, ink.skin); break;
    case 'up': p.rect(x, 3 + bob, 1, 4, ink.skin); p.px(x, 7 + bob, ink.primary); break;
    case 'out': p.rect(x < 8 ? x - 2 : x, 8 + bob, 3, 1, ink.skin); break;
    case 'chest': p.rect(x < 8 ? x + 1 : x - 3, 9 + bob, 3, 1, ink.skin); break;
    case 'reach': break;
  }
};

const drawUpright = (p: Painter, ink: AthleteInk, bulk: number, facing: Facing8, pose: Pose): void => {
  const front = facing.includes('s');
  const back = facing.includes('n');
  const diagonal = facing.length === 2;
  const bob = pose.bob;
  const lean = pose.lean;
  // helmet (rows 0-5 shifted by bob) with face, mask or back stripe
  p.rect(6 + lean, bob, 4, 1, ink.helmet);
  p.rect(5 + lean, 1 + bob, 6, 5, ink.helmet);
  if (front) {
    const fx = 6 + lean + (diagonal ? 1 : 0);
    p.rect(fx, 3 + bob, 4, 2, ink.skin);
    p.rect(5 + lean, 5 + bob, 6, 1, MASK);
  } else if (back) {
    p.rect(7 + lean + (diagonal ? 1 : 0), bob, 2, 5, ink.accent);
  } else {
    p.rect(9 + lean, 3 + bob, 2, 2, ink.skin);
    p.rect(9 + lean, 5 + bob, 3, 1, MASK);
    p.px(11 + lean, 4 + bob, MASK);
  }
  if (bob === 0) p.rect(7 + lean, 6, 2, 1, ink.skin);
  // shoulders + torso (rows 7-11)
  const sw = 10 + 2 * bulk;
  p.rect(8 - sw / 2 + lean, 7, sw, 1, ink.primary);
  p.rect(4 + lean, 7, 8, 5, ink.primary);
  p.px(8 - sw / 2 + lean, 8, ink.accent);
  p.px(8 + sw / 2 - 1 + lean, 8, ink.accent);
  drawArm(p, ink, 8 - sw / 2 - 1 + lean, pose.armL, 0);
  drawArm(p, ink, 8 + sw / 2 + lean, pose.armR, 0);
  if (pose.armL === 'reach' || pose.armR === 'reach') drawReach(p, ink.skin, !front && !back, lean, Math.min(bob, 1));
  // pants (rows 12-13) and legs (14-15)
  p.rect(5, 12, 6, 2, ink.secondary);
  p.px(5, 12, ink.accent);
  p.px(10, 12, ink.accent);
  const leg = (x: number, l: { dx: number; dy: number }): void => {
    if (l.dy < 0) {
      p.rect(x + l.dx, 14, 2, 1, SHOE);
    } else {
      p.rect(x + l.dx, 14, 2, 1, ink.secondary);
      p.rect(x + l.dx, 15, 2, 1, SHOE);
    }
  };
  leg(5, pose.legL);
  if (pose.kickLeg) {
    p.rect(9, 13, 4, 1, ink.secondary);
    p.px(13, 13, SHOE);
  } else leg(9, pose.legR);
};

const drawProne = (p: Painter, ink: AthleteInk, bulk: number, dive: boolean): void => {
  const ox = dive ? -3 : 0;
  p.rect(11 + ox, 9, 5, 5, ink.helmet);
  p.rect(15 + ox, 11, 1, 2, MASK);
  p.rect(4 + ox, 10, 7, 4, ink.primary);
  p.rect(4 + ox, 10 - Math.min(bulk, 1), 7, 1, ink.primary);
  p.rect(0 + ox, 11, 4, 3, ink.secondary);
  p.px(0 + ox, 11, SHOE);
  p.px(0 + ox, 13, SHOE);
  if (dive) {
    p.rect(13 + ox + 3, 10, 3, 1, ink.skin);
    p.rect(13 + ox + 3, 13, 3, 1, ink.skin);
  } else {
    p.rect(5, 9, 2, 1, ink.skin);
    p.rect(5, 14, 2, 1, ink.skin);
  }
};

const drawNumber = (p: Painter, number: number, c: Rgb): void => {
  const n = ((Math.round(number) % 100) + 100) % 100;
  const digits = n >= 10 ? [Math.floor(n / 10), n % 10] : [n];
  const xs = digits.length === 2 ? [5, 9] : [7];
  digits.forEach((d, i) => {
    const rows = microDigitRows(d);
    for (let r = 0; r < 5; r++) for (let cx = 0; cx < 3; cx++) if ((rows[r] as number) & (1 << (2 - cx))) p.px((xs[i] as number) + cx, 7 + r, c);
  });
};

const paintAthlete = (buf: PixelBuffer, params: AthleteSpriteParams): void => {
  const ink: AthleteInk = {
    primary: hexToRgb(params.palette.primary), secondary: hexToRgb(params.palette.secondary), accent: hexToRgb(params.palette.accent),
    helmet: hexToRgb(params.palette.helmet), skin: hexToRgb(params.skinTone),
  };
  const p = makePainter(buf);
  const bulk = BULK[params.group];
  const facing = params.facing;
  const side = facing === 'e' || facing === 'w';
  p.mirror = facing.includes('w') || facing === 's';
  const frame = wrapFrame(params.anim, params.frame);
  const prone = params.anim === 'down' || params.anim === 'dive' || (params.anim === 'tackled' && frame === 1);
  if (prone) {
    drawProne(p, ink, bulk, params.anim === 'dive');
  } else {
    p.mirror = facing.includes('w');
    drawUpright(p, ink, bulk, facing, poseFor(params.anim, frame, side));
    if (!side) {
      p.mirror = false;
      drawNumber(p, params.number, ink.accent);
    }
    if (params.anim === 'falling') {
      const [shear, drop] = FALL_TILT[frame] ?? [0, 0];
      tiltBuffer(buf, facing.includes('w') ? -1 : facing.includes('e') ? 1 : 0, shear, drop);
    }
  }
  outlineEdges(buf);
};

/* ----------------------------------- ball ----------------------------------- */

const BALL_BROWN: Rgb = { r: 140, g: 78, b: 38 };
const BALL_LIGHT: Rgb = { r: 176, g: 108, b: 58 };

const paintBall = (buf: PixelBuffer, params: BallSpriteParams): void => {
  const p = makePainter(buf);
  const theta = (((params.frame % 4) + 4) % 4) * (Math.PI / 4);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const c = (BALL_SPRITE_SIZE - 1) / 2;
  for (let y = 0; y < BALL_SPRITE_SIZE; y++) {
    for (let x = 0; x < BALL_SPRITE_SIZE; x++) {
      const dx = x - c;
      const dy = y - c;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if ((u / 3.1) ** 2 + (v / 1.7) ** 2 > 1) continue;
      let ink = BALL_BROWN;
      if (Math.abs(u) <= 1 && v <= 0 && v > -1) ink = WHITE;
      else if (Math.abs(u) > 2.3) ink = WHITE;
      else if (v < -0.6) ink = BALL_LIGHT;
      p.px(x, y, ink);
    }
  }
  outlineEdges(buf, 0.65);
};

/* ----------------------------------- cache ----------------------------------- */

/** Keyed cache of generated sprites with pooled pixel buffers. `clear()` recycles buffers: drop old references. */
export class SpriteCache {
  private readonly sprites = new Map<string, Sprite>();
  private readonly pools = new Map<number, ObjectPool<Uint8ClampedArray>>();

  get size(): number {
    return this.sprites.size;
  }

  has(key: string): boolean {
    return this.sprites.has(key);
  }

  /** Returns the cached sprite for `key` or paints a new one with `paint` into a pooled buffer. */
  getOrBuild(key: string, width: number, height: number, anchorX: number, anchorY: number, paint: (buf: PixelBuffer) => void): Sprite {
    const hit = this.sprites.get(key);
    if (hit) return hit;
    const buf: PixelBuffer = { width, height, data: this.pool(width * height * 4).acquire() };
    paint(buf);
    const sprite: Sprite = { ...buf, key, anchorX, anchorY, image: null };
    this.sprites.set(key, sprite);
    return sprite;
  }

  clear(): void {
    for (const s of this.sprites.values()) {
      s.image = null;
      this.pool(s.data.length).release(s.data);
    }
    this.sprites.clear();
  }

  private pool(bytes: number): ObjectPool<Uint8ClampedArray> {
    let pool = this.pools.get(bytes);
    if (!pool) {
      pool = new ObjectPool<Uint8ClampedArray>(() => new Uint8ClampedArray(bytes), (b: Uint8ClampedArray) => b.fill(0));
      this.pools.set(bytes, pool);
    }
    return pool;
  }
}

export const athleteSpriteKey = (p: AthleteSpriteParams): string =>
  `a|${p.palette.primary}|${p.palette.secondary}|${p.palette.accent}|${p.palette.helmet}|${p.skinTone}|${p.group}|${p.facing}|${p.anim}|${wrapFrame(p.anim, p.frame)}|${p.number}`;

/** Athlete sprite for the parameters; anchored at the feet centre (bottom middle). */
export const generateAthleteSprite = (cache: SpriteCache, params: AthleteSpriteParams): Sprite =>
  cache.getOrBuild(athleteSpriteKey(params), SPRITE_W, SPRITE_H, SPRITE_W / 2, SPRITE_H - 1, (buf) => paintAthlete(buf, params));

/** Ball sprite anchored at its centre. */
export const generateBallSprite = (cache: SpriteCache, params: BallSpriteParams): Sprite =>
  cache.getOrBuild(`b|${((params.frame % 4) + 4) % 4}`, BALL_SPRITE_SIZE, BALL_SPRITE_SIZE, BALL_SPRITE_SIZE / 2, BALL_SPRITE_SIZE / 2, (buf) => paintBall(buf, params));

/* ---------------------------------- drawing ---------------------------------- */

interface ImageGlobals {
  document?: Document;
  OffscreenCanvas?: typeof OffscreenCanvas;
  ImageData?: typeof ImageData;
}

/** Creates (once) a canvas holding the sprite pixels. Returns null where canvases do not exist (Node). */
export const ensureSpriteImage = (sprite: Sprite): CanvasImageSource | null => {
  if (sprite.image) return sprite.image;
  const g = globalThis as ImageGlobals;
  if (!g.ImageData) return null;
  let surface: HTMLCanvasElement | OffscreenCanvas;
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = sprite.width;
    c.height = sprite.height;
    surface = c;
  } else if (g.OffscreenCanvas) surface = new g.OffscreenCanvas(sprite.width, sprite.height);
  else return null;
  const sctx = surface.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!sctx) return null;
  sctx.putImageData(new g.ImageData(new Uint8ClampedArray(sprite.data), sprite.width, sprite.height), 0, 0);
  sprite.image = surface;
  return surface;
};

export type SpriteCtx = Pick<CanvasRenderingContext2D, 'fillRect' | 'drawImage' | 'save' | 'restore' | 'scale' | 'translate'> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
};

export interface DrawSpriteOptions {
  scale?: number;
  flipX?: boolean;
}

/** Draws a sprite so its anchor lands on (x, y). Uses the cached image when available, else per-run fillRects. */
export const drawSprite = (ctx: SpriteCtx, sprite: Sprite, x: number, y: number, opts: DrawSpriteOptions = {}): void => {
  const scale = opts.scale ?? 1;
  const left = Math.round(x - sprite.anchorX * scale);
  const top = Math.round(y - sprite.anchorY * scale);
  const image = ensureSpriteImage(sprite);
  if (image) {
    if (opts.flipX) {
      ctx.save();
      ctx.translate(left + sprite.width * scale, top);
      ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0, sprite.width * scale, sprite.height * scale);
      ctx.restore();
    } else ctx.drawImage(image, left, top, sprite.width * scale, sprite.height * scale);
    return;
  }
  const { width, height, data } = sprite;
  for (let yy = 0; yy < height; yy++) {
    let xx = 0;
    while (xx < width) {
      const i = (yy * width + xx) * 4;
      if (data[i + 3] !== 255) {
        xx++;
        continue;
      }
      let run = 1;
      while (xx + run < width) {
        const j = (yy * width + xx + run) * 4;
        if (data[j + 3] !== 255 || data[j] !== data[i] || data[j + 1] !== data[i + 1] || data[j + 2] !== data[i + 2]) break;
        run++;
      }
      ctx.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      const sx = opts.flipX ? width - xx - run : xx;
      ctx.fillRect(left + sx * scale, top + yy * scale, run * scale, scale);
      xx += run;
    }
  }
};
