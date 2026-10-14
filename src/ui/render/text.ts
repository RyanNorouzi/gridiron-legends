/**
 * Original 5x7 pixel font rendered with fillRect runs — the game's only UI typeface. Uppercase letters, digits,
 * punctuation and a few marker glyphs (arrows, cursor triangles, discs) used by widgets. Lowercase input is
 * upper-cased; unknown characters draw a hollow box so missing glyphs are visible rather than silent.
 * Size 2 is the large-text accessibility mode. No DOM access outside the ctx passed in; measure* is pure.
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Default gap between glyphs, in font pixels. */
export const GLYPH_GAP = 1;
export type TextSizeScale = 1 | 2 | 3;
export type TextAlign = 'left' | 'center' | 'right';

/** 35-character rows (7 rows x 5 columns), '#' = ink. */
const FONT: Record<string, string> = {
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.#####....#....#....#....#.....####',
  D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.#####....#....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '#####..#....#....#....#....#..#####',
  J: '..###...#....#....#....#.#..#..##..', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#', N: '#...###..##.#.##..###...##...##...#', O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.###.###...#', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
  '0': '.###.#...##..###.#.###..##...#.###.', '1': '..#...##....#....#....#....#...###.', '2': '.###.#...#....#...#...#...#...#####',
  '3': '#####...#...#.....#.....##...#.###.', '4': '...#...##..#.#.#..#.#####...#....#.', '5': '######....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.', '7': '#####....#...#...#...#...#....#....', '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#...#..##..',
  ' ': '...................................', '.': '..........................##...##..', ',': '.....................##....#...#...',
  ':': '......##...##........##...##.......', ';': '......##...##........##....#...#...', '!': '..#....#....#....#....#.........#..',
  '?': '.###.#...#....#...#...#.........#..', "'": '..#....#...#.......................', '"': '.#.#..#.#..#.#.....................',
  '-': '...............#####...............', '+': '.......#....#..#####..#....#.......', '/': '....#....#...#...#...#...#....#....',
  '\\': '#....#.....#.....#.....#.....#....#', '(': '...#...#...#....#....#.....#.....#.', ')': '.#.....#.....#....#....#...#...#...',
  '[': '.###..#....#....#....#....#....###.', ']': '.###....#....#....#....#....#..###.', '%': '##...##..#...#...#...#...#..##...##',
  '&': '.##..#..#.#..#..##..#.#.##..#..##.#', '#': '.#.#..#.#.#####.#.#.#####.#.#..#.#.', '*': '.....#.#.#.###.#####.###.#.#.#.....',
  '<': '...#...#...#...#.....#.....#.....#.', '>': '.#.....#.....#.....#...#...#...#...', '=': '..........#####.....#####..........',
  '_': '..............................#####', '@': '.###.#...##.####.#.##.####....#####', '$': '..#...#####.#...###...#.#####...#..',
  '|': '..#....#....#....#....#....#....#..', '~': '...........##.##.##.##.............',
  '←': '.......#...#...#####.#.....#.......', '→': '.......#.....#..#####...#....#.....', '↑': '..#...###.#.#.#..#....#....#....#..',
  '↓': '..#....#....#....#..#.#.#.###...#..', '▶': '#....##...###..####.###..##...#....', '◀': '....#...##..###.####..###...##....#',
  '▲': '............#...###.#####..........', '▼': '..........#####.###...#............', '●': '......###.###############.###......',
  '○': '......###.#...##...##...#.###......', '■': '.....##########################....', '□': '.....######...##...##...######.....',
  '·': '.................#.................',
  '☰': '.....#####.....#####.....#####.....',
  '★': '..#....#..#####.###..#.#.#...#.....',
  '…': '.........................#.#.#.....',
  '–': '...............#####...............',
  '—': '...............#####...............',
  '°': '.##..#..#..##......................',
  '▮': '......###..###..###..###..###......',
};

const FALLBACK_GLYPH = '□';
const rowCache = new Map<string, readonly number[]>();

/** Row bitmasks (bit 4 = leftmost column) for a character, upper-casing letters; unknown -> hollow box. */
export const glyphRows = (ch: string): readonly number[] => {
  const key = ch.length === 1 && ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
  const cached = rowCache.get(key);
  if (cached) return cached;
  const src = FONT[key] ?? FONT[FALLBACK_GLYPH]!;
  const rows: number[] = [];
  for (let r = 0; r < GLYPH_H; r++) {
    let mask = 0;
    for (let c = 0; c < GLYPH_W; c++) if (src[r * GLYPH_W + c] === '#') mask |= 1 << (GLYPH_W - 1 - c);
    rows.push(mask);
  }
  rowCache.set(key, rows);
  return rows;
};

export const hasGlyph = (ch: string): boolean => Object.prototype.hasOwnProperty.call(FONT, ch.length === 1 ? ch.toUpperCase() : ch);

export interface TextMetrics { width: number; height: number }

/** Pixel size of a single-line string at `size`, including inter-glyph gaps (none after the last glyph). */
export const measureText = (text: string, size: TextSizeScale = 1, letterSpacing = GLYPH_GAP): TextMetrics => {
  const chars = Array.from(text);
  if (chars.length === 0) return { width: 0, height: GLYPH_H * size };
  return { width: (chars.length * GLYPH_W + (chars.length - 1) * letterSpacing) * size, height: GLYPH_H * size };
};

export interface DrawTextOptions {
  color?: string;
  size?: TextSizeScale;
  align?: TextAlign;
  /** Drop-shadow colour drawn one font pixel down-right; null/undefined for none. */
  shadow?: string | null;
  letterSpacing?: number;
  /** Fraction 0..1 of the glyph height revealed from the top (used for wipe-in effects). */
  reveal?: number;
}

/** Minimal 2D context surface used by the renderer so tests can pass a recording fake. */
export type FillCtx = Pick<CanvasRenderingContext2D, 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern };

const paintRuns = (ctx: FillCtx, text: string, x: number, y: number, size: number, spacing: number, reveal: number): void => {
  let cx = x;
  const rowsVisible = Math.max(0, Math.min(GLYPH_H, Math.ceil(GLYPH_H * reveal)));
  for (const ch of Array.from(text)) {
    const rows = glyphRows(ch);
    for (let r = 0; r < rowsVisible; r++) {
      const mask = rows[r] as number;
      if (mask === 0) continue;
      let c = 0;
      while (c < GLYPH_W) {
        if (mask & (1 << (GLYPH_W - 1 - c))) {
          let run = 1;
          while (c + run < GLYPH_W && mask & (1 << (GLYPH_W - 1 - c - run))) run++;
          ctx.fillRect(cx + c * size, y + r * size, run * size, size);
          c += run;
        } else c++;
      }
    }
    cx += (GLYPH_W + spacing) * size;
  }
};

/**
 * Draws one line of text with its top-left at (x, y) (adjusted by `align`). Coordinates are snapped to whole
 * pixels so glyphs never blur. Returns the metrics of what was drawn.
 */
export const drawText = (ctx: FillCtx, text: string, x: number, y: number, opts: DrawTextOptions = {}): TextMetrics => {
  const size = opts.size ?? 1;
  const spacing = opts.letterSpacing ?? GLYPH_GAP;
  const metrics = measureText(text, size, spacing);
  let left = Math.round(x);
  if (opts.align === 'center') left = Math.round(x - metrics.width / 2);
  else if (opts.align === 'right') left = Math.round(x - metrics.width);
  const top = Math.round(y);
  const reveal = opts.reveal ?? 1;
  if (opts.shadow) {
    ctx.fillStyle = opts.shadow;
    paintRuns(ctx, text, left + size, top + size, size, spacing, reveal);
  }
  ctx.fillStyle = opts.color ?? '#f2f1e6';
  paintRuns(ctx, text, left, top, size, spacing, reveal);
  return metrics;
};

/** Greedy word wrap into lines no wider than `maxWidth` pixels; a single word longer than the width is split. */
export const wrapText = (text: string, maxWidth: number, size: TextSizeScale = 1, letterSpacing = GLYPH_GAP): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, size, letterSpacing).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let chunk = '';
      for (const ch of Array.from(word)) {
        if (measureText(chunk + ch, size, letterSpacing).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
};

/**
 * Wraps `text` to `maxWidth` and keeps at most `maxLines` lines; when text is dropped the last kept line ends in
 * "..." (the pixel font has no ellipsis glyph), trimmed until it fits.
 */
export const fitLines = (text: string, maxWidth: number, maxLines: number, size: TextSizeScale = 1): string[] => {
  const lines = wrapText(text, maxWidth, size);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  // A cut never leaves a dangling separator before the dots ("TEAM PLAYER,..." / "SHORT YARDAGE ·...").
  const clean = (t: string): string => t.replace(/[\s,;:·\-–—]+$/u, '');
  let last = `${clean(kept[kept.length - 1] ?? '')}...`;
  while (last.length > 3 && measureText(last, size).width > maxWidth) last = `${clean(last.slice(0, -4))}...`;
  kept[kept.length - 1] = last;
  return kept;
};

/**
 * One line of a "A · B · C" list that fits `maxWidth`: whole trailing segments are dropped first (so a tag list
 * never ends in a dangling " ·..."), and only when even the first segment is too wide is it cut with "...".
 */
export const fitSegments = (text: string, maxWidth: number, size: TextSizeScale = 1, separator = ' · '): string => {
  if (measureText(text, size).width <= maxWidth) return text;
  const parts = text.split(separator);
  for (let n = parts.length - 1; n >= 1; n--) {
    const line = parts.slice(0, n).join(separator);
    if (measureText(line, size).width <= maxWidth) return line;
  }
  return fitLines(parts[0] ?? '', maxWidth, 1, size)[0] ?? '';
};

/**
 * Wraps a "A · B · C" line at its separators first (whole segments per line, so "STADIUM · ATTENDANCE 71,500"
 * never breaks inside "ATTENDANCE 71,500"); a segment wider than the line is word-wrapped on its own.
 */
export const wrapSegments = (text: string, maxWidth: number, size: TextSizeScale = 1, separator = ' · '): string[] => {
  if (measureText(text, size).width <= maxWidth) return [text];
  const out: string[] = [];
  let line = '';
  for (const part of text.split(separator)) {
    const candidate = line ? `${line}${separator}${part}` : part;
    if (measureText(candidate, size).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) out.push(line);
    const wrapped = wrapText(part, maxWidth, size);
    out.push(...wrapped.slice(0, -1));
    line = wrapped[wrapped.length - 1] ?? '';
  }
  if (line) out.push(line);
  return out;
};

/** Draws several lines stacked with `lineGap` font pixels between them; returns the total height used. */
export const drawTextLines = (ctx: FillCtx, lines: readonly string[], x: number, y: number, opts: DrawTextOptions & { lineGap?: number } = {}): number => {
  const size = opts.size ?? 1;
  const step = (GLYPH_H + (opts.lineGap ?? 2)) * size;
  lines.forEach((line, i) => drawText(ctx, line, x, y + i * step, opts));
  return lines.length * step;
};

/** 3x5 micro digits for jersey numbers on sprites: 5 row masks per digit, bit 2 = leftmost column. */
const MICRO_DIGITS: readonly (readonly number[])[] = [
  [0b111, 0b101, 0b101, 0b101, 0b111], [0b010, 0b110, 0b010, 0b010, 0b111], [0b111, 0b001, 0b111, 0b100, 0b111],
  [0b111, 0b001, 0b011, 0b001, 0b111], [0b101, 0b101, 0b111, 0b001, 0b001], [0b111, 0b100, 0b111, 0b001, 0b111],
  [0b111, 0b100, 0b111, 0b101, 0b111], [0b111, 0b001, 0b001, 0b010, 0b010], [0b111, 0b101, 0b111, 0b101, 0b111],
  [0b111, 0b101, 0b111, 0b001, 0b111],
];

/** Row masks for a single digit 0..9 (3 wide, 5 tall). */
export const microDigitRows = (digit: number): readonly number[] => MICRO_DIGITS[((digit % 10) + 10) % 10] as readonly number[];
