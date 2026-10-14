/**
 * The FINE typeface (art bible §12.1): an original proportional 4x6-art-px capital set with 1-art-px strokes, for
 * dense secondary labels (score-bug captions, play-card chips, table headers). One art pixel is one logical pixel of
 * the chunky 480x270 grid, so a line is 6 px tall (still smaller than the 5x7 Chunky font with its descent-free
 * cap height). Large-text mode never uses it: callers go
 * through `drawSmallText` / `measureSmallText`, which map FINE -> Chunky whenever `theme.textScale > 1`.
 */
import { drawText, measureText, type TextAlign } from '../render/text';
import type { Theme } from '../theme';
import type { ArtCtx } from './ui-art';

/** Glyph height in art px. */
export const FINE_H = 6;

/** Rows of up to 4 columns per glyph ('#' = ink); width is taken from the widest row. */
const FINE: Record<string, readonly string[]> = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#'], B: ['###.', '#..#', '###.', '#..#', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '#...', '.###'], D: ['###.', '#..#', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '#...', '####'], F: ['####', '#...', '###.', '#...', '#...', '#...'],
  G: ['.###', '#...', '#...', '#.##', '#..#', '.###'], H: ['#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '###'], J: ['..##', '...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#', '#..#'], L: ['#...', '#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#'], N: ['#..#', '##.#', '#.##', '#..#', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.'], P: ['###.', '#..#', '#..#', '###.', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#..#', '#.#.', '.#.#'], R: ['###.', '#..#', '#..#', '###.', '#.#.', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '...#', '###.'], T: ['###', '.#.', '.#.', '.#.', '.#.', '.#.'],
  U: ['#..#', '#..#', '#..#', '#..#', '#..#', '.##.'], V: ['#..#', '#..#', '#..#', '#..#', '.##.', '.##.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'], X: ['#..#', '#..#', '.##.', '.##.', '#..#', '#..#'],
  Y: ['#.#', '#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['####', '...#', '..#.', '.#..', '#...', '####'],
  '0': ['.##.', '#..#', '#.##', '##.#', '#..#', '.##.'], '1': ['.#', '##', '.#', '.#', '.#', '.#'],
  '2': ['.##.', '#..#', '..#.', '.#..', '#...', '####'], '3': ['###.', '...#', '.##.', '...#', '...#', '###.'],
  '4': ['#..#', '#..#', '####', '...#', '...#', '...#'], '5': ['####', '#...', '###.', '...#', '...#', '###.'],
  '6': ['.##.', '#...', '###.', '#..#', '#..#', '.##.'], '7': ['####', '...#', '..#.', '.#..', '.#..', '.#..'],
  '8': ['.##.', '#..#', '.##.', '#..#', '#..#', '.##.'], '9': ['.##.', '#..#', '#..#', '.###', '...#', '.##.'],
  ' ': ['..', '..', '..', '..', '..', '..'], '.': ['.', '.', '.', '.', '.', '#'], ',': ['.', '.', '.', '.', '#', '#'],
  ':': ['.', '#', '.', '.', '#', '.'], '-': ['...', '...', '###', '...', '...', '...'], '+': ['...', '.#.', '###', '.#.', '...', '...'],
  '/': ['...#', '..#.', '..#.', '.#..', '.#..', '#...'], "'": ['#', '#', '.', '.', '.', '.'], '!': ['#', '#', '#', '#', '.', '#'],
  '?': ['###.', '...#', '.##.', '.#..', '....', '.#..'], '(': ['.#', '#.', '#.', '#.', '#.', '.#'], ')': ['#.', '.#', '.#', '.#', '.#', '#.'],
  '&': ['.#..', '#.#.', '.#..', '#.##', '#..#', '.##.'], '#': ['.#.#', '####', '.#.#', '####', '.#.#', '....'], '%': ['#..#', '...#', '..#.', '.#..', '#...', '#..#'],
  '·': ['.', '.', '#', '.', '.', '.'], '>': ['#..', '.#.', '..#', '.#.', '#..', '...'], '<': ['..#', '.#.', '#..', '.#.', '..#', '...'],
  '★': ['..#..', '.###.', '#####', '.###.', '.#.#.', '#...#'], '▶': ['#..', '##.', '###', '##.', '#..', '...'], '◀': ['..#', '.##', '###', '.##', '..#', '...'],
  '=': ['...', '###', '...', '###', '...', '...'], '_': ['....', '....', '....', '....', '....', '####'], '"': ['#.#', '#.#', '...', '...', '...', '...'],
};

interface FineGlyph { w: number; rows: readonly number[] }
const glyphCache = new Map<string, FineGlyph>();

/** Bit rows (bit 0 = leftmost column) and width of a FINE glyph; unknown characters draw a hollow box. */
export const fineGlyph = (ch: string): FineGlyph => {
  const key = ch.length === 1 && ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const src = FINE[key] ?? ['###', '#.#', '#.#', '#.#', '#.#', '###'];
  const w = Math.max(...src.map((r) => r.length));
  const rows = src.map((r) => {
    let m = 0;
    for (let c = 0; c < r.length; c++) if (r[c] === '#') m |= 1 << c;
    return m;
  });
  const g = { w, rows };
  glyphCache.set(key, g);
  return g;
};

/** True when the FINE set has a glyph for the character. */
export const hasFineGlyph = (ch: string): boolean => Object.prototype.hasOwnProperty.call(FINE, ch.length === 1 ? ch.toUpperCase() : ch);

/** Width of a string in ART px (1-art-px gap between glyphs, none after the last). */
export const fineArtWidth = (text: string): number => {
  const chars = Array.from(text);
  if (chars.length === 0) return 0;
  return chars.reduce((t, ch) => t + fineGlyph(ch).w, 0) + chars.length - 1;
};

/** Width and height of a FINE string in LOGICAL px on this context. */
export const measureFine = (_ctx: ArtCtx, text: string): { width: number; height: number } => ({ width: fineArtWidth(text), height: FINE_H });

/** FINE draw options. */
export interface FineOptions {
  color?: string;
  align?: TextAlign;
  /** Shadow colour drawn one art px down (and right); null for none. */
  shadow?: string | null;
}

/** Draws FINE text with its top-left at (x, y) (adjusted by align); returns its logical width. */
export const drawFine = (ctx: ArtCtx, text: string, x: number, y: number, opts: FineOptions = {}): number => {
  const width = fineArtWidth(text);
  let left = Math.round(x);
  if (opts.align === 'center') left = Math.round(x - width / 2);
  else if (opts.align === 'right') left = Math.round(x - width);
  const top = Math.round(y);
  const paint = (ox: number, oy: number): void => {
    let cx = left + ox;
    for (const ch of Array.from(text)) {
      const g = fineGlyph(ch);
      g.rows.forEach((mask, r) => {
        let c = 0;
        while (c < g.w) {
          if (!(mask & (1 << c))) {
            c++;
            continue;
          }
          let run = 1;
          while (c + run < g.w && mask & (1 << (c + run))) run++;
          ctx.fillRect(cx + c, top + oy + r, run, 1);
          c += run;
        }
      });
      cx += g.w + 1;
    }
  };
  if (opts.shadow) {
    ctx.fillStyle = opts.shadow;
    paint(1, 1);
  }
  ctx.fillStyle = opts.color ?? '#f4f1e4';
  paint(0, 0);
  return width;
};

/**
 * Secondary label: FINE on normal text, the Chunky font in large-text mode (accessibility: FINE -> Chunky).
 * Returns the logical width drawn.
 */
export const drawSmallText = (ctx: ArtCtx, theme: Theme, text: string, x: number, y: number, opts: FineOptions = {}): number => {
  if (theme.textScale > 1) return drawText(ctx, text, x, y, { color: opts.color, align: opts.align, size: theme.textScale, shadow: opts.shadow ?? null }).width;
  return drawFine(ctx, text, x, y, opts);
};

/** Logical size of a secondary label as `drawSmallText` would draw it. */
export const measureSmallText = (ctx: ArtCtx, theme: Theme, text: string): { width: number; height: number } =>
  theme.textScale > 1 ? measureText(text, theme.textScale) : measureFine(ctx, text);
