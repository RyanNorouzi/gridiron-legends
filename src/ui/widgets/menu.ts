/**
 * Retro vertical menu list. Navigation comes from an InputState: digital menu/move actions with hold-to-repeat,
 * the analog axis, mouse hover, and pointer taps (touch). Selection wraps and skips disabled items; items may
 * carry a sub-label, a right-aligned value (left/right emits 'change') and can scroll when taller than
 * `maxVisible` rows. Drawing is relative to the theme so large-text mode simply makes rows taller.
 * A tap or click on a value's ◀ / ▶ emits 'change' -1 / +1 (so touch can step a value both ways); a tap anywhere
 * else on a row activates it. A value too wide for its row is cut with "..." so the label keeps some room.
 */
import type { Action, InputState } from '../input/types';
import { drawText, measureText, fitLines, fitSegments } from '../render/text';
import type { Theme } from '../theme';
import type { UiCtx } from './panel';
import { darken, lighten } from '../render/palette';
import { fillAlpha, type ArtCtx } from './ui-art';

/**
 * Lighting on a selected row (drawn over its flat selection fill): a bright 1-art-px top edge, a dark foot, a gold
 * 2-lpx bar on the left and a soft light band that fades to the right, so the highlight reads as a lit slab.
 */
export const drawSelectionTrim = (ctx: ArtCtx, fill: string, accent: string, x: number, y: number, w: number, h: number): void => {
  const hi = lighten(fill, 0.22);
  const band = Math.max(1, Math.round(w / 3));
  for (let i = 0; i < 3; i++) fillAlpha(ctx, hi, 0.28 - i * 0.09, x + i * band, y + 1, i === 2 ? w - 2 * band : band, Math.max(1, Math.round(h / 2) - 1));
  ctx.fillStyle = lighten(fill, 0.4);
  ctx.fillRect(x, y, w, 1);
  ctx.fillStyle = darken(fill, 0.45);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 2, h);
};

export interface MenuItem {
  id: string;
  label: string;
  subLabel?: string;
  disabled?: boolean;
  /** Right-aligned value text; left/right on the item emits a 'change' event. */
  value?: string;
}

export type MenuEvent =
  | { type: 'activate'; item: MenuItem; index: number }
  | { type: 'select'; item: MenuItem; index: number }
  | { type: 'change'; item: MenuItem; index: number; delta: -1 | 1 }
  | { type: 'back' };

export interface MenuListOptions {
  wrap?: boolean;
  /** Seconds before a held direction starts repeating, and between repeats. */
  repeatDelay?: number;
  repeatRate?: number;
  initialIndex?: number;
  /** Rows shown at once; more items scroll. 0 = unlimited. */
  maxVisible?: number;
}

export interface MenuDrawOptions {
  /** Seconds, used to blink the cursor; omit for a steady cursor. */
  time?: number;
  cursor?: boolean;
}

interface RowRect {
  index: number; x: number; y: number; w: number; h: number;
  /** Hit spans (x from..to) of the value's ◀ and ▶ glyphs. */
  dec?: readonly [number, number];
  inc?: readonly [number, number];
}

const anyPressed = (input: InputState, actions: readonly Action[]): boolean => actions.some((a) => input.justPressed.has(a));
const anyDown = (input: InputState, actions: readonly Action[]): boolean => actions.some((a) => input.down.has(a));

export class MenuList {
  items: MenuItem[];
  selectedIndex = 0;
  scroll = 0;
  readonly wrap: boolean;
  readonly maxVisible: number;
  private readonly repeatDelay: number;
  private readonly repeatRate: number;
  private repeatTimer = 0;
  private heldDir = 0;
  private rows: RowRect[] = [];
  private lastPointer: { x: number; y: number } | null = null;
  /** Eased selection-bar position (transition between rows); null = snap on the next draw. */
  private bar: { y: number; h: number; time: number; key: string } | null = null;

  constructor(items: readonly MenuItem[], opts: MenuListOptions = {}) {
    this.items = [...items];
    this.wrap = opts.wrap ?? true;
    this.maxVisible = Math.max(0, opts.maxVisible ?? 0);
    this.repeatDelay = opts.repeatDelay ?? 0.35;
    this.repeatRate = opts.repeatRate ?? 0.12;
    this.selectedIndex = -1;
    if (!this.select(opts.initialIndex ?? 0)) this.move(1);
  }

  get selected(): MenuItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  /** Replaces the items, keeping the selection on the same id when possible. */
  setItems(items: readonly MenuItem[]): void {
    const prevId = this.selected?.id;
    this.items = [...items];
    const idx = prevId ? this.items.findIndex((i) => i.id === prevId) : -1;
    this.selectedIndex = -1;
    if (!this.select(idx >= 0 ? idx : 0)) this.move(1);
  }

  /** Selects an enabled index; returns false (and leaves the selection) if it is disabled or out of range. */
  select(index: number): boolean {
    const item = this.items[index];
    if (!item || item.disabled) return false;
    this.selectedIndex = index;
    this.ensureVisible();
    return true;
  }

  /** Moves the selection by `delta` rows, skipping disabled items and wrapping if enabled. */
  move(delta: number): boolean {
    const n = this.items.length;
    if (n === 0 || delta === 0) return false;
    const step = delta > 0 ? 1 : -1;
    let i = this.selectedIndex;
    for (let tries = 0; tries < n; tries++) {
      i += step;
      if (i < 0 || i >= n) {
        if (!this.wrap) return false;
        i = (i + n) % n;
      }
      if (!this.items[i]?.disabled) {
        if (i === this.selectedIndex) return false;
        this.selectedIndex = i;
        this.ensureVisible();
        return true;
      }
    }
    return false;
  }

  /** Index of the row under a logical pixel, or -1. Uses the rectangles from the last draw. */
  hitTest(x: number, y: number): number {
    for (const r of this.rows) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.index;
    return -1;
  }

  /** Applies one tick of input and returns the resulting event, if any. */
  update(dt: number, input: InputState): MenuEvent | null {
    let dir = 0;
    if (anyPressed(input, ['menuUp', 'moveUp'])) dir = -1;
    else if (anyPressed(input, ['menuDown', 'moveDown'])) dir = 1;
    const held = anyDown(input, ['menuUp', 'moveUp']) ? -1 : anyDown(input, ['menuDown', 'moveDown']) ? 1 : input.axis.y < -0.5 ? -1 : input.axis.y > 0.5 ? 1 : 0;
    if (held !== 0 && held === this.heldDir) {
      this.repeatTimer -= dt;
      if (this.repeatTimer <= 0) {
        dir = held;
        this.repeatTimer = this.repeatRate;
      }
    } else {
      this.repeatTimer = this.repeatDelay;
      if (held !== 0 && dir === 0) dir = held;
    }
    this.heldDir = held;
    if (dir !== 0 && this.move(dir)) return this.selected ? { type: 'select', item: this.selected, index: this.selectedIndex } : null;

    const pointerEvent = this.pointerUpdate(input);
    if (pointerEvent) return pointerEvent;
    if (anyPressed(input, ['back'])) return { type: 'back' };
    const item = this.selected;
    if (!item) return null;
    if (anyPressed(input, ['confirm'])) return { type: 'activate', item, index: this.selectedIndex };
    if (item.value !== undefined) {
      if (anyPressed(input, ['menuLeft', 'moveLeft'])) return { type: 'change', item, index: this.selectedIndex, delta: -1 };
      if (anyPressed(input, ['menuRight', 'moveRight'])) return { type: 'change', item, index: this.selectedIndex, delta: 1 };
    }
    return null;
  }

  private pointerUpdate(input: InputState): MenuEvent | null {
    const p = input.pointer;
    if (!p) {
      this.lastPointer = null;
      return null;
    }
    const moved = !this.lastPointer || this.lastPointer.x !== p.x || this.lastPointer.y !== p.y;
    this.lastPointer = { x: p.x, y: p.y };
    const hit = this.hitTest(p.x, p.y);
    if (p.justDown) {
      if (hit < 0 || !this.select(hit) || !this.selected) return null;
      const row = this.rows.find((r) => r.index === hit);
      const on = (span: readonly [number, number] | undefined): boolean => span !== undefined && p.x >= span[0] && p.x <= span[1];
      if (this.selected.value !== undefined && on(row?.dec)) return { type: 'change', item: this.selected, index: hit, delta: -1 };
      if (this.selected.value !== undefined && on(row?.inc)) return { type: 'change', item: this.selected, index: hit, delta: 1 };
      return { type: 'activate', item: this.selected, index: hit };
    }
    if (moved && input.lastDevice === 'mouse' && hit >= 0 && hit !== this.selectedIndex && this.select(hit) && this.selected) {
      return { type: 'select', item: this.selected, index: hit };
    }
    return null;
  }

  private ensureVisible(): void {
    if (this.maxVisible <= 0) return;
    if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
    else if (this.selectedIndex >= this.scroll + this.maxVisible) this.scroll = this.selectedIndex - this.maxVisible + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.items.length - this.maxVisible)));
  }

  rowHeight(theme: Theme, item: MenuItem): number {
    return theme.lineHeight + (item.subLabel ? theme.glyphH + 2 * theme.textScale : 0);
  }

  /** Total height the visible rows occupy. */
  measure(theme: Theme): number {
    const end = this.maxVisible > 0 ? Math.min(this.items.length, this.scroll + this.maxVisible) : this.items.length;
    let h = 0;
    for (let i = this.scroll; i < end; i++) h += this.rowHeight(theme, this.items[i] as MenuItem);
    return h;
  }

  /**
   * The selection bar glides to a newly selected row over ~0.1 s (a transition; snaps without a clock, with reduced
   * motion, or when the list moved or scrolled). Positions are whole pixels so the bar stays crisp.
   */
  private easeBar(targetY: number, targetH: number, key: string, time: number | undefined, reduced: boolean): { y: number; h: number } {
    const prev = this.bar;
    if (time === undefined || reduced || !prev || prev.key !== key || time < prev.time) {
      this.bar = { y: targetY, h: targetH, time: time ?? 0, key };
      return { y: targetY, h: targetH };
    }
    const k = Math.min(1, Math.max(0, time - prev.time) * 28);
    let ny = prev.y + (targetY - prev.y) * k;
    let nh = prev.h + (targetH - prev.h) * k;
    if (Math.abs(targetY - ny) < 0.5) ny = targetY;
    if (Math.abs(targetH - nh) < 0.5) nh = targetH;
    this.bar = { y: ny, h: nh, time, key };
    return { y: Math.round(ny), h: Math.round(nh) };
  }

  /** Draws the list with its top-left at (x, y) and returns the height used. Records row rects for hit tests. */
  draw(ctx: UiCtx, theme: Theme, x: number, y: number, w: number, opts: MenuDrawOptions = {}): number {
    const c = theme.colors;
    const size = theme.textScale;
    const cursorW = measureText('▶', size).width + theme.gap;
    const blinkOn = opts.time === undefined || theme.reducedMotion || Math.floor(opts.time * 3) % 2 === 0;
    const end = this.maxVisible > 0 ? Math.min(this.items.length, this.scroll + this.maxVisible) : this.items.length;
    // A scrolling list keeps a gutter on the right for its ▲ / ▼ marks so they never sit on a value's ▶.
    const scrolls = this.maxVisible > 0 && this.items.length > this.maxVisible;
    const gutter = scrolls ? measureText('▼', size).width + theme.gap : 0;
    const rowW = w - gutter;
    this.rows = [];
    let cy = Math.round(y);
    for (let i = this.scroll; i < end; i++) {
      const rowH = this.rowHeight(theme, this.items[i] as MenuItem);
      this.rows.push({ index: i, x: Math.round(x), y: cy, w: Math.round(rowW), h: rowH });
      cy += rowH;
    }
    // The selection bar goes down before any label: while it eases between rows it slides UNDER their text
    // instead of covering the rows it passes.
    const sel = this.rows.find((r) => r.index === this.selectedIndex);
    if (sel) {
      const b = this.easeBar(sel.y, sel.h, `${Math.round(x)}|${Math.round(y)}|${this.scroll}|${Math.round(rowW)}`, opts.time, theme.reducedMotion);
      ctx.fillStyle = c.selection;
      ctx.fillRect(Math.round(x), b.y, Math.round(rowW), b.h);
      drawSelectionTrim(ctx as ArtCtx, c.selection, c.accent, Math.round(x), b.y, Math.round(rowW), b.h);
    }
    for (const row of this.rows) {
      const i = row.index;
      const item = this.items[i] as MenuItem;
      const selected = i === this.selectedIndex;
      cy = row.y;
      if (selected && (opts.cursor ?? true) && blinkOn) drawText(ctx, '▶', x + theme.gap, cy + (theme.lineHeight - theme.glyphH) / 2, { color: c.accent, size });
      const labelColor = item.disabled ? c.textDim : selected ? c.accent : c.text;
      const textX = x + theme.gap + cursorW;
      const textY = cy + (theme.lineHeight - theme.glyphH) / 2;
      // Labels fit the row: the value column (if any) keeps its room, anything longer ends in "...". A value too
      // wide for the row is cut instead, leaving the label at least a few characters.
      const right = x + rowW - theme.gap;
      let valueText = item.value !== undefined ? `◀ ${item.value} ▶` : '';
      if (item.value !== undefined) {
        const labelMin = Math.min(measureText(item.label, size).width, measureText('WWWWWW', size).width);
        const maxValueW = right - textX - labelMin - theme.gap * 2;
        if (measureText(valueText, size).width > maxValueW) {
          const inner = fitLines(item.value, Math.max(0, maxValueW - measureText('◀  ▶', size).width), 1, size)[0] ?? '';
          valueText = `◀ ${inner} ▶`;
        }
      }
      const valueW = item.value !== undefined ? measureText(valueText, size).width + theme.gap * 2 : 0;
      const textW = Math.max(8, right - valueW - textX);
      drawText(ctx, fitLines(item.label, textW, 1, size)[0] ?? '', textX, textY, { color: labelColor, size });
      if (item.value !== undefined) {
        drawText(ctx, valueText, right, textY, { color: selected ? c.text : c.textDim, size, align: 'right' });
        const arrowW = measureText('◀', size).width;
        const start = right - measureText(valueText, size).width;
        row.dec = [start - theme.gap, start + arrowW + theme.gap];
        row.inc = [right - arrowW - theme.gap, right + theme.gap];
      }
      if (item.subLabel) drawText(ctx, fitSegments(item.subLabel, Math.max(8, x + rowW - theme.gap - textX), size), textX, cy + theme.lineHeight, { color: c.textDim, size });
      cy += row.h;
    }
    if (this.maxVisible > 0) {
      if (this.scroll > 0) drawText(ctx, '▲', x + w, y, { color: c.textDim, size, align: 'right' });
      if (end < this.items.length) drawText(ctx, '▼', x + w, cy - theme.glyphH, { color: c.textDim, size, align: 'right' });
    }
    return cy - Math.round(y);
  }
}
