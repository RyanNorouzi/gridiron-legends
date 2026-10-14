/**
 * DataTable layout and drawing. `fitColumns` turns character-based column specs into pixel widths for the
 * available room; `layoutTable` builds the pure view-model (header cells with sort markers, visible rows with
 * fitted "..."-ellipsised text, tones, bars, scroll markers) and records hit rectangles on the table;
 * `drawDataTable` paints it with theme colours. Row height is `theme.lineHeight`, so large-text mode simply
 * shows fewer, taller rows. Narrow tables first hide optional columns (`Column.priority`, see `shownColumns`),
 * then try a column's `shorten` form (initials for names) before cutting text with "...".
 */
import { GLYPH_GAP, GLYPH_W, drawText, fitLines, measureText, type TextSizeScale } from '../../render/text';
import { UI_SLAB, lighten, mix } from '../../render/palette';
import { drawSelectionTrim } from '../../widgets/menu';
import type { ArtCtx } from '../../widgets/ui-art';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { CellBar, CellValue, Column, DataTable, TableHitMap } from './data-table';
import { toneColor, type Tone } from './format';
import type { Rect, SortDir } from './list';
import { drawRatingBar } from './rating-bar';

/** Width spec used by fitColumns. */
export interface ColumnWidthSpec {
  width?: number;
  flex?: number;
  minWidth?: number;
}

/** Pixel width of one character cell at a text scale. */
export const charWidth = (size: TextSizeScale): number => (GLYPH_W + GLYPH_GAP) * size;

/**
 * Pixel widths for columns in `available` px with `gap` px between them. Fixed columns get width x charW,
 * flex columns share the remainder by weight (never below minWidth chars). When even the minimums do not
 * fit, every column shrinks proportionally (to at least one character).
 */
export const fitColumns = (cols: readonly ColumnWidthSpec[], available: number, charW: number, gap: number): number[] => {
  if (cols.length === 0) return [];
  const room = Math.max(0, available - gap * (cols.length - 1));
  const isFlex = (c: ColumnWidthSpec): boolean => c.width === undefined;
  const want = cols.map((c) => (isFlex(c) ? Math.max(1, c.minWidth ?? 3) : Math.max(1, c.width ?? 1)) * charW);
  const total = want.reduce((a, b) => a + b, 0);
  if (total > room) {
    const k = room / total;
    return want.map((w) => Math.max(Math.min(charW, w), Math.floor(w * k)));
  }
  const flexIdx = cols.map((c, i) => (isFlex(c) ? i : -1)).filter((i) => i >= 0);
  const weights = flexIdx.map((i) => Math.max(0, cols[i]?.flex ?? 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const extra = room - total;
  const out = [...want];
  if (flexIdx.length > 0 && weightSum > 0) {
    let given = 0;
    flexIdx.forEach((i, k) => {
      const share = k === flexIdx.length - 1 ? extra - given : Math.floor((extra * (weights[k] ?? 0)) / weightSum);
      given += share;
      out[i] = (out[i] ?? 0) + share;
    });
  }
  return out;
};

/**
 * The columns that fit `available` px: while the fixed widths plus every flex column's minimum overflow, the
 * column with the highest `priority` (the last such on ties) is dropped. Columns without a priority always stay.
 */
export const shownColumns = <C extends ColumnWidthSpec & { priority?: number }>(cols: readonly C[], available: number, charW: number, gap: number): C[] => {
  const out = [...cols];
  const need = (): number => out.reduce((s, c) => s + Math.max(1, c.width ?? c.minWidth ?? 3) * charW, 0) + gap * Math.max(0, out.length - 1);
  while (need() > available) {
    let drop = -1;
    out.forEach((c, i) => {
      if ((c.priority ?? 0) > 0 && (drop < 0 || (c.priority ?? 0) >= (out[drop]?.priority ?? 0))) drop = i;
    });
    if (drop < 0) break;
    out.splice(drop, 1);
  }
  return out;
};

/** Text that fits `width` px on one line, ending in "..." when cut. */
export const fitCell = (text: string, width: number, size: TextSizeScale): string => {
  if (measureText(text, size).width <= width) return text;
  if (width < measureText('...', size).width) return '';
  return fitLines(text, width, 1, size)[0] ?? '';
};

const cellParts = (v: CellValue): { text: string; tone: Tone } => (typeof v === 'string' ? { text: v, tone: 'normal' } : { text: v.text, tone: v.tone ?? 'normal' });

/** One laid-out cell. */
export interface CellView {
  key: string;
  x: number;
  w: number;
  text: string;
  align: 'left' | 'right' | 'center';
  tone: Tone;
  bar: CellBar | null;
}

/** One laid-out header cell. */
export interface HeaderView {
  key: string;
  x: number;
  w: number;
  text: string;
  align: 'left' | 'right' | 'center';
  sortable: boolean;
  sorted: SortDir | null;
}

/** Pure view-model of a table for one frame. */
export interface TableView {
  rect: Rect;
  rowH: number;
  header: HeaderView[] | null;
  rows: { index: number; y: number; selected: boolean; tone: Tone | null; cells: CellView[] }[];
  scrollUp: Rect | null;
  scrollDown: Rect | null;
  /** Empty-state text, or null when there are rows. */
  empty: string | null;
}

/** Lays the table out in `rect`, records its hit map/visible rows on the table and returns the view-model. */
export const layoutTable = <R>(table: DataTable<R>, theme: Theme, rect: Rect): TableView => {
  const size = theme.textScale;
  const rowH = theme.lineHeight;
  const cw = charWidth(size);
  const markerW = measureText('▲', size).width + theme.gap;
  const innerW = Math.max(0, rect.w - theme.gap * 2 - markerW);
  const columns = shownColumns(table.columns, innerW, cw, theme.gap * 2);
  table.setShownColumns(columns.map((c) => c.key));
  const widths = fitColumns(columns, innerW, cw, theme.gap * 2);
  const xs: number[] = [];
  let cx = rect.x + theme.gap;
  widths.forEach((w) => {
    xs.push(cx);
    cx += w + theme.gap * 2;
  });
  const headerH = table.showHeader ? rowH : 0;
  const visible = Math.max(1, Math.floor((rect.h - headerH) / rowH));
  const header: HeaderView[] | null = table.showHeader
    ? columns.map((c: Column<R>, i) => {
      const sorted = table.sortKey === c.key ? table.sortDir : null;
      const arrow = sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '';
      const w = widths[i] ?? 0;
      // The sort arrow may spill into the gap beside the column (the table's edge pad for a right-aligned first
      // column), so a 3-character column like OVR keeps its full label next to the arrow.
      const spill = arrow ? (i === 0 && (c.align ?? 'left') === 'right' ? theme.gap : theme.gap * 2) - size : 0;
      const labelRoom = w + spill - measureText(arrow, size).width - (arrow ? GLYPH_GAP * size : 0);
      const label = arrow ? `${fitCell(c.label, Math.max(0, labelRoom), size)}${arrow}` : fitCell(c.label, w, size);
      return { key: c.key, x: xs[i] ?? 0, w, text: label, align: c.align ?? 'left', sortable: !!c.sortValue, sorted };
    })
    : null;
  table.setHitMap({ header: [], rows: [], rowH, scrollUp: null, scrollDown: null }, visible);
  const start = table.scroll;
  const end = Math.min(table.rows.length, start + table.visibleRows);
  const bodyY = rect.y + headerH;
  const rows: TableView['rows'] = [];
  for (let i = start; i < end; i++) {
    const row = table.rows[i] as R;
    const y = bodyY + (i - start) * rowH;
    const cells = columns.map((c, ci): CellView => {
      const w = widths[ci] ?? 0;
      const { text, tone } = cellParts(c.format(row));
      const fitted = c.shorten && measureText(text, size).width > w ? c.shorten(text) : text;
      return { key: c.key, x: xs[ci] ?? 0, w, text: fitCell(fitted, w, size), align: c.align ?? 'left', tone, bar: c.bar?.(row) ?? null };
    });
    rows.push({ index: i, y, selected: i === table.selectedIndex, tone: table.toneOf(row), cells });
  }
  const markerX = rect.x + rect.w - markerW;
  const scrollUp = start > 0 ? { x: markerX, y: bodyY, w: markerW, h: rowH } : null;
  const scrollDown = end < table.rows.length ? { x: markerX, y: bodyY + (visible - 1) * rowH, w: markerW, h: rowH } : null;
  const hits: TableHitMap = {
    header: (header ?? []).filter((h) => h.sortable).map((h) => ({ key: h.key, rect: { x: h.x - theme.gap, y: rect.y, w: h.w + theme.gap * 2, h: rowH } })),
    rows: rows.map((r) => ({ index: r.index, rect: { x: rect.x, y: r.y, w: rect.w - markerW, h: rowH } })),
    rowH,
    scrollUp,
    scrollDown,
  };
  table.setHitMap(hits, visible);
  return { rect, rowH, header, rows, scrollUp, scrollDown, empty: table.rows.length === 0 ? table.emptyText : null };
};

const alignX = (c: { x: number; w: number; align: 'left' | 'right' | 'center' }): number =>
  c.align === 'right' ? c.x + c.w : c.align === 'center' ? c.x + c.w / 2 : c.x;

/** Fill of the odd (zebra) table rows. */
export const zebraTone = (theme: Theme): string => {
  const key = `${theme.colors.bgAlt}|${theme.colors.panelLight}`;
  if (key !== zebraKey) {
    zebraKey = key;
    zebraFill = mix(theme.colors.bgAlt, theme.colors.panelLight, 0.35);
  }
  return zebraFill;
};
let zebraKey = '';
let zebraFill = '';

/** Lays out and draws the table in `rect`; returns the view-model that was drawn. */
export const drawDataTable = <R>(ctx: UiCtx, theme: Theme, table: DataTable<R>, rect: Rect): TableView => {
  const view = layoutTable(table, theme, rect);
  const c = theme.colors;
  const size = theme.textScale;
  const textDy = Math.floor((view.rowH - theme.glyphH) / 2);
  const art = ctx as ArtCtx;
  if (view.header) {
    ctx.fillStyle = c.panelLight;
    ctx.fillRect(rect.x, rect.y, rect.w, view.rowH);
    // Header slab: lit top edge, dark foot, a gold rule under the sorted column.
    ctx.fillStyle = lighten(c.panelLight, 0.25);
    ctx.fillRect(rect.x, rect.y, rect.w, 1);
    ctx.fillStyle = UI_SLAB.edge;
    ctx.fillRect(rect.x, rect.y + view.rowH - 1, rect.w, 1);
    for (const h of view.header) {
      if (!h.sorted) continue;
      ctx.fillStyle = c.accent;
      ctx.fillRect(h.x, rect.y + view.rowH - 2, h.w, 2);
    }
    for (const h of view.header) {
      drawText(ctx, h.text, alignX(h), rect.y + textDy, { color: h.sorted ? c.accent : h.sortable ? c.text : c.textDim, size, align: h.align });
    }
  }
  for (const r of view.rows) {
    if (r.selected) {
      ctx.fillStyle = c.selection;
      ctx.fillRect(rect.x, r.y, rect.w, view.rowH);
      drawSelectionTrim(art, c.selection, c.accent, rect.x, r.y, rect.w, view.rowH);
      ctx.fillStyle = c.accent;
      ctx.fillRect(rect.x, r.y, Math.max(1, theme.textScale), view.rowH);
    } else if (r.index % 2 === 1) {
      // Zebra rows: a step toward the header tone, enough to follow a long row across the columns.
      ctx.fillStyle = zebraTone(theme);
      ctx.fillRect(rect.x, r.y, rect.w, view.rowH);
    }
    for (const cell of r.cells) {
      const tone = r.tone && cell.tone === 'normal' ? r.tone : cell.tone;
      if (cell.bar) {
        const label = measureText(cell.text, size).width + theme.gap <= cell.w / 2 ? cell.text : '';
        const barW = label ? cell.w - measureText(label, size).width - theme.gap : cell.w;
        drawRatingBar(ctx, theme, cell.x, r.y + textDy + 1, barW, theme.glyphH - 2, cell.bar.value, { max: cell.bar.max, marker: cell.bar.marker, tone: cell.bar.tone });
        if (label) drawText(ctx, label, cell.x + cell.w, r.y + textDy, { color: toneColor(theme, tone), size, align: 'right' });
        continue;
      }
      drawText(ctx, cell.text, alignX(cell), r.y + textDy, { color: r.selected && tone === 'normal' ? c.accent : toneColor(theme, tone), size, align: cell.align });
    }
  }
  if (view.empty !== null) {
    const y = rect.y + (view.header ? view.rowH : 0) + textDy;
    drawText(ctx, fitCell(view.empty, rect.w - theme.gap * 2, size), rect.x + rect.w / 2, y, { color: c.textDim, size, align: 'center' });
  }
  if (view.scrollUp) drawText(ctx, '▲', view.scrollUp.x + view.scrollUp.w - 1, view.scrollUp.y + textDy, { color: c.textDim, size, align: 'right' });
  if (view.scrollDown) drawText(ctx, '▼', view.scrollDown.x + view.scrollDown.w - 1, view.scrollDown.y + textDy, { color: c.textDim, size, align: 'right' });
  return view;
};
