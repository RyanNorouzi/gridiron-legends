/**
 * Stencil block lettering for field paint (art bible §10.2): our own thick-stroke numerals and capitals on a 7-row
 * grid, rasterised at any pixel height with chamfered outer corners (the athletic "block" look) instead of a scaled
 * UI font. Painted into RGBA buffers (Node-testable), optionally with an outline and a drop shadow, rotated in
 * quarter turns (end-zone names read along the end line; far / near yard numbers face their sideline), and cached
 * per (text, height, colours, rotation) in an LRU. Browser drawing blits the cached canvas.
 */
import { Lru, newPx, pxImage, setPx, type Px } from './art';

/** Rows of every glyph. */
export const GLYPH_ROWS = 7;

const G: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0': ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  '1': ['..##.', '.###.', '..##.', '..##.', '..##.', '..##.', '.####'],
  '2': ['####.', '...##', '...##', '.###.', '##...', '##...', '#####'],
  '3': ['####.', '...##', '...##', '.###.', '...##', '...##', '####.'],
  '4': ['##.##', '##.##', '##.##', '#####', '...##', '...##', '...##'],
  '5': ['#####', '##...', '##...', '####.', '...##', '...##', '####.'],
  '6': ['.###.', '##...', '##...', '####.', '##.##', '##.##', '.###.'],
  '7': ['#####', '...##', '...##', '..##.', '..##.', '.##..', '.##..'],
  '8': ['.###.', '##.##', '##.##', '.###.', '##.##', '##.##', '.###.'],
  '9': ['.###.', '##.##', '##.##', '.####', '...##', '...##', '.###.'],
  A: ['.###.', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  B: ['####.', '##.##', '##.##', '####.', '##.##', '##.##', '####.'],
  C: ['.####', '##...', '##...', '##...', '##...', '##...', '.####'],
  D: ['####.', '##.##', '##.##', '##.##', '##.##', '##.##', '####.'],
  E: ['#####', '##...', '##...', '####.', '##...', '##...', '#####'],
  F: ['#####', '##...', '##...', '####.', '##...', '##...', '##...'],
  G: ['.####', '##...', '##...', '##.##', '##.##', '##.##', '.####'],
  H: ['##.##', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  I: ['####', '.##.', '.##.', '.##.', '.##.', '.##.', '####'],
  J: ['..###', '...##', '...##', '...##', '##.##', '##.##', '.###.'],
  K: ['##.##', '##.##', '####.', '###..', '####.', '##.##', '##.##'],
  L: ['##...', '##...', '##...', '##...', '##...', '##...', '#####'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##'],
  N: ['##..##', '###.##', '######', '##.###', '##..##', '##..##', '##..##'],
  O: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  P: ['####.', '##.##', '##.##', '####.', '##...', '##...', '##...'],
  Q: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.#.', '.##.#'],
  R: ['####.', '##.##', '##.##', '####.', '####.', '##.##', '##.##'],
  S: ['.####', '##...', '##...', '.###.', '...##', '...##', '####.'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  U: ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  V: ['##.##', '##.##', '##.##', '##.##', '##.##', '.###.', '..#..'],
  W: ['##...##', '##...##', '##...##', '##.#.##', '#######', '###.###', '##...##'],
  X: ['##.##', '##.##', '.###.', '..#..', '.###.', '##.##', '##.##'],
  Y: ['##..##', '##..##', '.####.', '..##..', '..##..', '..##..', '..##..'],
  Z: ['#####', '...##', '..##.', '.##..', '##...', '##...', '#####'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  '.': ['..', '..', '..', '..', '..', '##', '##'],
  "'": ['##', '##', '.#', '..', '..', '..', '..'],
  '&': ['.##..', '##.#.', '.##..', '###.#', '##.##', '##.#.', '.##.#'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
});

/** The glyph of a character (unknown characters become a space). */
export const glyphOf = (ch: string): readonly string[] => G[ch.toUpperCase()] ?? (G[' '] as readonly string[]);

/** Width of a text in glyph cells (1 cell between glyphs). */
export const textCells = (text: string): number => {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += (glyphOf(text[i] as string)[0]?.length ?? 3) + (i > 0 ? 1 : 0);
  return w;
};

const filled = (g: readonly string[], c: number, r: number): boolean => g[r]?.[c] === '#';

/** Whether glyph point (u, v) in cell units is inked, with outer corners chamfered by half a cell. */
const inked = (g: readonly string[], u: number, v: number): boolean => {
  const c = Math.floor(u);
  const r = Math.floor(v);
  if (!filled(g, c, r)) return false;
  const fu = u - c;
  const fv = v - r;
  const up = filled(g, c, r - 1);
  const dn = filled(g, c, r + 1);
  const lf = filled(g, c - 1, r);
  const rt = filled(g, c + 1, r);
  if (!up && !lf && fu + fv < 0.5) return false;
  if (!up && !rt && 1 - fu + fv < 0.5) return false;
  if (!dn && !lf && fu + 1 - fv < 0.5) return false;
  if (!dn && !rt && 2 - fu - fv < 0.5) return false;
  return true;
};

/** Quarter turns clockwise. */
export type Turn = 0 | 1 | 2 | 3;

/** Stencil text request. */
export interface StencilSpec {
  text: string;
  /** Glyph height in pixels (>= 7 for full detail). */
  height: number;
  color: string;
  /** 1-px outline colour. */
  outline?: string;
  /** Drop shadow colour, offset down-right by `shadowPx`. */
  shadow?: string;
  shadowPx?: number;
  /** Quarter turns clockwise. */
  turn?: Turn;
  /** Cells between glyphs (default 1). */
  spacing?: number;
}

/** Rasterises stencil text (pure; exported for tests). The buffer's up is the text's up before `turn`. */
export const paintStencil = (spec: StencilSpec): Px => {
  const h = Math.max(GLYPH_ROWS, Math.round(spec.height));
  const cell = h / GLYPH_ROWS;
  const gap = spec.spacing ?? 1;
  const glyphs = [...spec.text].map(glyphOf);
  const cellsW = glyphs.reduce((s, g, i) => s + (g[0]?.length ?? 3) + (i > 0 ? gap : 0), 0);
  const pad = (spec.outline ? 1 : 0) + (spec.shadow ? spec.shadowPx ?? Math.max(1, Math.round(h / 14)) : 0);
  const w = Math.max(1, Math.round(cellsW * cell));
  const base = newPx(w + pad * 2, h + pad * 2);
  const ink = new Uint8Array(w * h);
  let cx = 0;
  for (const g of glyphs) {
    const gw = g[0]?.length ?? 3;
    const x0 = Math.round(cx * cell);
    const x1 = Math.round((cx + gw) * cell);
    for (let y = 0; y < h; y++) {
      for (let x = x0; x < x1; x++) {
        if (inked(g, ((x - x0 + 0.5) / (x1 - x0)) * gw, ((y + 0.5) / h) * GLYPH_ROWS)) ink[y * w + x] = 1;
      }
    }
    cx += gw + gap;
  }
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x] === 1;
  if (spec.shadow) {
    const s = spec.shadowPx ?? Math.max(1, Math.round(h / 14));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)) setPx(base, x + pad + s, y + pad + s, spec.shadow, 170);
  }
  if (spec.outline) {
    for (let y = -1; y <= h; y++) {
      for (let x = -1; x <= w; x++) {
        if (at(x, y)) continue;
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) setPx(base, x + pad, y + pad, spec.outline);
      }
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y)) setPx(base, x + pad, y + pad, spec.color);
  return rotatePx(base, spec.turn ?? 0);
};

/** Rotates a buffer by quarter turns clockwise. */
export const rotatePx = (px: Px, turn: Turn): Px => {
  if (turn === 0) return px;
  const out = newPx(turn % 2 === 1 ? px.h : px.w, turn % 2 === 1 ? px.w : px.h);
  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      const i = (y * px.w + x) * 4;
      let nx = x;
      let ny = y;
      if (turn === 1) { nx = px.h - 1 - y; ny = x; }
      else if (turn === 2) { nx = px.w - 1 - x; ny = px.h - 1 - y; }
      else { nx = y; ny = px.w - 1 - x; }
      const j = (ny * out.w + nx) * 4;
      out.data[j] = px.data[i] ?? 0; out.data[j + 1] = px.data[i + 1] ?? 0; out.data[j + 2] = px.data[i + 2] ?? 0; out.data[j + 3] = px.data[i + 3] ?? 0;
    }
  }
  return out;
};

const cache = new Lru<Px>(96);

/** Cached stencil buffer for a spec. */
export const stencil = (spec: StencilSpec): Px => {
  const key = `${spec.text}|${Math.round(spec.height)}|${spec.color}|${spec.outline ?? ''}|${spec.shadow ?? ''}|${spec.shadowPx ?? ''}|${spec.turn ?? 0}|${spec.spacing ?? 1}`;
  return cache.getOr(key, () => paintStencil(spec));
};

/** Draws stencil text centred on (cx, cy) in art px; returns the drawn buffer (for layout). */
export const drawStencil = (ctx: Pick<CanvasRenderingContext2D, 'drawImage'>, spec: StencilSpec, cx: number, cy: number): Px => {
  const px = stencil(spec);
  const img = pxImage(px);
  if (img) ctx.drawImage(img, Math.round(cx - px.w / 2), Math.round(cy - px.h / 2));
  return px;
};
