/**
 * Sprite atlas (art bible §11): painted frames cached as small offscreen surfaces under a string key, least
 * recently used entries evicted past a cap. Painting is budgeted per frame so a burst of cache misses never stalls
 * a frame: `get` paints only while the frame's paint budget lasts (else returns null and the caller draws a
 * fallback frame); `prerender` queues jobs (the kits and builds known at game start) that `pump` paints in
 * time slices. Node-safe: without a DOM (tests) frames keep their RGBA buffer and `image` stays null, and all the
 * bookkeeping (keys, LRU, budget, queue) still runs. Frames are drawn in art pixels on the world layer.
 */
import type { PaintedFrame } from './anim';

/** A cached frame: the painted frame plus its surface (null in Node). */
export interface AtlasFrame extends PaintedFrame {
  key: string;
  image: CanvasImageSource | null;
}

/** A paint job for the prerender queue. */
export interface AtlasJob {
  key: string;
  paint: () => PaintedFrame;
}

/** Atlas limits and injectable clock / surface factory. */
export interface AtlasOptions {
  /** Most cached frames (default 2500, bible §11). */
  maxEntries?: number;
  /** Milliseconds of cache-miss painting allowed per frame (default 1.5). */
  frameBudgetMs?: number;
  /** Clock (ms); defaults to performance.now. */
  now?: () => number;
  /** Surface factory; defaults to the DOM (null when none: Node). */
  createSurface?: (w: number, h: number) => { getContext(type: '2d'): CanvasRenderingContext2D | null } | null;
}

/** Counters for the dev overlay and tests. */
export interface AtlasStats {
  size: number;
  hits: number;
  misses: number;
  painted: number;
  evicted: number;
  /** Misses refused because the frame's budget was spent. */
  deferred: number;
  queued: number;
  /** Milliseconds painted in the current frame. */
  frameMs: number;
}

interface DomGlobals { document?: Document; OffscreenCanvas?: typeof OffscreenCanvas; ImageData?: typeof ImageData }

const defaultClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const domSurface = (w: number, h: number): { getContext(type: '2d'): CanvasRenderingContext2D | null } | null => {
  const g = globalThis as DomGlobals;
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(w, h) as unknown as { getContext(type: '2d'): CanvasRenderingContext2D | null };
  return null;
};

/** LRU cache of painted frames with a per-frame paint budget and a time-sliced prerender queue. */
export class SpriteAtlas {
  private readonly map = new Map<string, AtlasFrame>();
  private readonly queue: AtlasJob[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly max: number;
  private readonly budget: number;
  private readonly clock: () => number;
  private readonly surface: NonNullable<AtlasOptions['createSurface']>;
  private spent = 0;
  readonly stats: AtlasStats = { size: 0, hits: 0, misses: 0, painted: 0, evicted: 0, deferred: 0, queued: 0, frameMs: 0 };

  constructor(opts: AtlasOptions = {}) {
    this.max = Math.max(1, opts.maxEntries ?? 2500);
    this.budget = opts.frameBudgetMs ?? 1.5;
    this.clock = opts.now ?? defaultClock;
    this.surface = opts.createSurface ?? domSurface;
  }

  get size(): number {
    return this.map.size;
  }

  /** Starts a new frame's paint budget. */
  beginFrame(): void {
    this.spent = 0;
    this.stats.frameMs = 0;
  }

  /** The cached frame for `key` without painting (refreshes its LRU position); null on a miss. */
  peek(key: string): AtlasFrame | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** True when `key` is cached (no LRU refresh). */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * The frame for `key`, painting it on a miss while this frame's paint budget lasts (`force` paints regardless:
   * the first frame of a figure with nothing to fall back to). Null when the miss was deferred.
   */
  get(key: string, paint: () => PaintedFrame, force = false): AtlasFrame | null {
    const hit = this.peek(key);
    if (hit) {
      this.stats.hits++;
      return hit;
    }
    this.stats.misses++;
    if (!force && this.spent >= this.budget) {
      this.stats.deferred++;
      this.enqueue({ key, paint });
      return null;
    }
    return this.paintNow(key, paint);
  }

  /** Paints and caches `key` now (no budget check). */
  paintNow(key: string, paint: () => PaintedFrame): AtlasFrame {
    const t0 = this.clock();
    const frame = paint();
    const entry: AtlasFrame = { ...frame, key, image: this.toImage(frame) };
    const ms = Math.max(0, this.clock() - t0);
    this.spent += ms;
    this.stats.frameMs += ms;
    this.stats.painted++;
    this.map.set(key, entry);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.stats.evicted++;
    }
    this.stats.size = this.map.size;
    return entry;
  }

  /** Queues a job (skipped when cached or already queued). */
  enqueue(job: AtlasJob): void {
    if (this.map.has(job.key) || this.queuedKeys.has(job.key)) return;
    this.queue.push(job);
    this.queuedKeys.add(job.key);
    this.stats.queued = this.queue.length;
  }

  /** Queues many jobs in priority order (a prerender plan). */
  prerender(jobs: Iterable<AtlasJob>): void {
    for (const j of jobs) this.enqueue(j);
  }

  /** Paints queued jobs for up to `ms` milliseconds; returns how many were painted. */
  pump(ms: number): number {
    const t0 = this.clock();
    let n = 0;
    while (this.queue.length > 0 && this.clock() - t0 < ms) {
      const job = this.queue.shift() as AtlasJob;
      this.queuedKeys.delete(job.key);
      if (!this.map.has(job.key)) {
        this.paintNow(job.key, job.paint);
        n++;
      }
    }
    this.stats.queued = this.queue.length;
    return n;
  }

  /** Jobs still waiting. */
  get pending(): number {
    return this.queue.length;
  }

  /** Drops every frame and job. */
  clear(): void {
    this.map.clear();
    this.queue.length = 0;
    this.queuedKeys.clear();
    this.stats.size = 0;
    this.stats.queued = 0;
  }

  /** Surface for a painted frame (null in Node). */
  private toImage(frame: PaintedFrame): CanvasImageSource | null {
    if (frame.width <= 0 || frame.height <= 0) return null;
    const s = this.surface(frame.width, frame.height);
    const ctx = s?.getContext('2d') ?? null;
    if (!s || !ctx) return null;
    ctx.imageSmoothingEnabled = false;
    if (frame.draw) frame.draw(ctx);
    else if (frame.rgba) {
      const g = globalThis as DomGlobals;
      if (!g.ImageData) return null;
      ctx.putImageData(new g.ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
    }
    return s as unknown as CanvasImageSource;
  }
}

/** Draws an atlas frame with its anchor on art pixel (x, y). */
export const drawAtlasFrame = (ctx: Pick<CanvasRenderingContext2D, 'drawImage'>, frame: AtlasFrame, x: number, y: number): void => {
  if (frame.image) ctx.drawImage(frame.image, Math.round(x - frame.ax), Math.round(y - frame.ay));
};
