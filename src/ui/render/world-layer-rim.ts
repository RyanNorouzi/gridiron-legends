/**
 * Overlap rims for the sorted figure pass (line-play readability). Figures are drawn back to front by where their
 * feet meet the ground; on the horizontal field the interior linemen stand 10-13 art px apart vertically while a
 * figure is ~20-24 px tall, so every body is drawn partly over the one behind it and two same-colour jerseys merge
 * into one block. Before a figure is drawn, its 1-px outer ring (the pixels just outside its silhouette, 4-way) is
 * painted in RIM_INK wherever that ring falls on a figure drawn earlier this frame: a separating line only where
 * bodies overlap, never on the grass (the figure's own outline stays the only edge there).
 *
 * Pure bookkeeping over a coverage bitmap (which art pixels already show a figure) and per-frame silhouette masks
 * cached by frame; the caller does the fillRects, so it runs in Node tests unchanged. Render-only.
 */

/** Colour of the separating rim (the retro outline ink, a touch darker so it reads against every kit). */
export const RIM_INK = '#0b0912';

/** Highest figure tier that gets rims (tiers 3 and 4 are too small: a rim would eat the body). */
export const RIM_MAX_TIER = 2;

/** A painted frame's silhouette: which pixels are opaque, and its outer 4-way ring. Frame-relative coordinates. */
export interface RimMask {
  width: number;
  height: number;
  ax: number;
  ay: number;
  /** 1 where the frame has an opaque pixel (width x height). */
  solid: Uint8Array;
  /** Outer ring as flat (x, y) pairs, frame-relative (x in -1..width, y in -1..height). */
  ring: Int16Array;
}

/** What a mask is built from: an atlas / painted frame with its RGBA buffer. */
export interface MaskSource {
  width: number;
  height: number;
  ax: number;
  ay: number;
  rgba?: Uint8ClampedArray | null;
}

const masks = new WeakMap<object, RimMask | null>();

/** Builds the silhouette mask of a frame (null without an RGBA buffer). */
export const buildRimMask = (f: MaskSource): RimMask | null => {
  const { width: w, height: h, rgba } = f;
  if (!rgba || w <= 0 || h <= 0 || rgba.length < w * h * 4) return null;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = (rgba[i * 4 + 3] as number) > 0 ? 1 : 0;
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
  const ring: number[] = [];
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (at(x, y)) continue;
      if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) ring.push(x, y);
    }
  }
  return { width: w, height: h, ax: f.ax, ay: f.ay, solid, ring: Int16Array.from(ring) };
};

/** The (cached) mask of a frame object. */
export const rimMaskOf = (f: MaskSource): RimMask | null => {
  if (masks.has(f)) return masks.get(f) ?? null;
  const m = buildRimMask(f);
  masks.set(f, m);
  return m;
};

/**
 * Coverage of the figures drawn so far this frame, on a layer of `width` x `height` art px. `rimRuns` gives the
 * rim of the next figure as horizontal runs; `cover` records it once drawn.
 */
export class OverlapRims {
  private readonly cov: Uint8Array;
  private dirty = false;

  constructor(readonly width: number, readonly height: number) {
    this.cov = new Uint8Array(Math.max(1, width * height));
  }

  /** Clears the coverage (start of a frame). */
  reset(): void {
    if (this.dirty) this.cov.fill(0);
    this.dirty = false;
  }

  /** True when the art pixel shows a figure drawn this frame. */
  covered(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.cov[y * this.width + x] === 1;
  }

  /**
   * Rim pixels of a figure whose frame anchor is at art (x, y): the ring pixels over earlier figures, merged into
   * horizontal runs [x, y, length, ...] in layer pixels.
   */
  rimRuns(m: RimMask, x: number, y: number): number[] {
    const out: number[] = [];
    if (!this.dirty) return out;
    const ox = Math.round(x) - m.ax;
    const oy = Math.round(y) - m.ay;
    const r = m.ring;
    let runX = 0; let runY = 0; let len = 0;
    for (let i = 0; i < r.length; i += 2) {
      const px = ox + (r[i] as number);
      const py = oy + (r[i + 1] as number);
      if (!this.covered(px, py)) continue;
      if (len > 0 && py === runY && px === runX + len) { len++; continue; }
      if (len > 0) out.push(runX, runY, len);
      runX = px; runY = py; len = 1;
    }
    if (len > 0) out.push(runX, runY, len);
    return out;
  }

  /** Marks a drawn figure's opaque pixels as covered. */
  cover(m: RimMask, x: number, y: number): void {
    const ox = Math.round(x) - m.ax;
    const oy = Math.round(y) - m.ay;
    for (let j = 0; j < m.height; j++) {
      const ly = oy + j;
      if (ly < 0 || ly >= this.height) continue;
      const row = ly * this.width;
      for (let i = 0; i < m.width; i++) {
        if (m.solid[j * m.width + i] !== 1) continue;
        const lx = ox + i;
        if (lx >= 0 && lx < this.width) this.cov[row + lx] = 1;
      }
    }
    this.dirty = true;
  }
}

/** Paints rim runs with `fill` (a fillRect-capable context) in RIM_INK. */
export const paintRimRuns = (ctx: Pick<CanvasRenderingContext2D, 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern }, runs: readonly number[]): void => {
  if (runs.length === 0) return;
  ctx.fillStyle = RIM_INK;
  for (let i = 0; i < runs.length; i += 3) ctx.fillRect(runs[i] as number, runs[i + 1] as number, runs[i + 2] as number, 1);
};
