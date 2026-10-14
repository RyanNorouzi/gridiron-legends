/**
 * DataTable: the franchise UI's sortable, scrollable table widget (rosters, free agents, standings, stats...).
 *
 * Controls (all devices produce the same events):
 * - Up/Down (d-pad, W/S, arrows, analog stick; hold to repeat) move the row selection and scroll -> 'select'.
 * - Left/Right (menuLeft/menuRight or moveLeft/moveRight) move the SORT COLUMN to the previous/next sortable
 *   column, sorting by it in that column's default direction -> 'sort'.
 * - The secondary button X (action `showPlayArt`, keyboard J) flips the sort direction -> 'sort'.
 * - Confirm (A / Space / Enter) activates the selected row -> 'activate'. Back (B / L / Esc) -> 'back'.
 * - Mouse/touch: hovering (mouse) selects; a tap/click that is released on the same row selects and
 *   activates it; dragging vertically scrolls by rows (no activation); tapping a sortable header sorts by it
 *   (tapping the current sort column flips direction); tapping the ▲/▼ markers pages the list.
 *
 * Geometry comes from the last `layout()` (called by `drawDataTable`); pointer input is ignored before it.
 * Selection follows the row id across re-sorts and `setRows`.
 */
import type { InputState } from '../../input/types';
import type { Tone, ToneText } from './format';
import {
  DOWN_ACTIONS, LEFT_ACTIONS, RIGHT_ACTIONS, RepeatAxis, SECONDARY_ACTIONS, UP_ACTIONS, clampIndex, inRect, pressed,
  scrollToShow, sortRows, type Rect, type SortDir, type SortValue,
} from './list';

/** Text of a cell, optionally toned. */
export type CellValue = string | ToneText;

/** A rating bar drawn in a cell instead of its text. */
export interface CellBar {
  value: number;
  max?: number;
  marker?: number | null;
  tone?: Tone;
}

/** Column definition. Widths are in CHARACTER CELLS so they scale with large-text mode. */
export interface Column<R> {
  key: string;
  label: string;
  /** Fixed width in characters. */
  width?: number;
  /** Share of the width left after fixed columns (default 1 when `width` is absent). */
  flex?: number;
  /** Minimum characters for a flex column (default 3). */
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  format(row: R): CellValue;
  /** Present = sortable. */
  sortValue?(row: R): SortValue;
  /** Direction used when the column becomes the sort column (default 'desc': best/biggest first). */
  defaultDir?: SortDir;
  /** Draw a rating bar (plus the formatted text right of it when it fits) instead of plain text. */
  bar?(row: R): CellBar | null;
  /**
   * Optional column: when the table cannot give every shown flex column its `minWidth`, columns with a priority
   * are hidden, highest number first (large text keeps names readable by dropping side columns). Absent / 0 =
   * never hidden.
   */
  priority?: number;
  /** Shorter form of a cell's text, tried before "..." when the text does not fit (e.g. `shortName`). */
  shorten?(text: string): string;
}

/** Options for a DataTable. */
export interface DataTableOptions<R> {
  /** Stable id for selection tracking. */
  rowId(row: R): string;
  initialSort?: { key: string; dir?: SortDir } | null;
  /** Rows visible before the first layout (default 8). */
  visibleRows?: number;
  showHeader?: boolean;
  /** Up on the first row wraps to the last (default false). */
  wrap?: boolean;
  /** Shown when there are no rows. */
  emptyText?: string;
  /** Whole-row tone (e.g. dim injured players); null = default. */
  rowTone?(row: R): Tone | null;
  /** Row selected initially (by id). */
  initialRowId?: string;
}

/** Events returned by `DataTable.update`. */
export type DataTableEvent<R> =
  | { type: 'select'; row: R; index: number }
  | { type: 'activate'; row: R; index: number }
  | { type: 'sort'; key: string; dir: SortDir }
  | { type: 'back' };

/** Hit-test geometry recorded by the last layout. */
export interface TableHitMap {
  header: { key: string; rect: Rect }[];
  rows: { index: number; rect: Rect }[];
  rowH: number;
  scrollUp: Rect | null;
  scrollDown: Rect | null;
}

interface Press {
  index: number;
  startY: number;
  startScroll: number;
  dragging: boolean;
}

export class DataTable<R> {
  readonly columns: readonly Column<R>[];
  readonly showHeader: boolean;
  readonly emptyText: string;
  private readonly opts: DataTableOptions<R>;
  private source: R[] = [];
  private view: R[] = [];
  private selIndex = -1;
  private scrollTop = 0;
  private sortKeyValue: string | null = null;
  private sortDirValue: SortDir = 'desc';
  private visible: number;
  private readonly vertical = new RepeatAxis(UP_ACTIONS, DOWN_ACTIONS, 'y');
  private hits: TableHitMap | null = null;
  private press: Press | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private shownKeys: ReadonlySet<string> | null = null;

  constructor(columns: readonly Column<R>[], rows: readonly R[], opts: DataTableOptions<R>) {
    this.columns = columns;
    this.opts = opts;
    this.showHeader = opts.showHeader ?? true;
    this.emptyText = opts.emptyText ?? 'Nothing to show';
    this.visible = Math.max(1, opts.visibleRows ?? 8);
    const init = opts.initialSort;
    if (init && this.column(init.key)?.sortValue) {
      this.sortKeyValue = init.key;
      this.sortDirValue = init.dir ?? this.column(init.key)?.defaultDir ?? 'desc';
    }
    this.setRows(rows);
    if (opts.initialRowId !== undefined) this.selectById(opts.initialRowId);
  }

  /** Rows in display (sorted) order. */
  get rows(): readonly R[] { return this.view; }
  get selectedIndex(): number { return this.selIndex; }
  get selected(): R | null { return this.view[this.selIndex] ?? null; }
  get scroll(): number { return this.scrollTop; }
  get sortKey(): string | null { return this.sortKeyValue; }
  get sortDir(): SortDir { return this.sortDirValue; }
  /** Rows shown at once (from the last layout). */
  get visibleRows(): number { return this.visible; }
  /** Geometry of the last layout (null before the first). */
  get hitMap(): TableHitMap | null { return this.hits; }
  /** Id of a row. */
  idOf(row: R): string { return this.opts.rowId(row); }
  /** Whole-row tone. */
  toneOf(row: R): Tone | null { return this.opts.rowTone?.(row) ?? null; }

  /** Columns drawn by the last layout (all of them before the first). */
  get shownColumns(): readonly Column<R>[] {
    const keys = this.shownKeys;
    return keys ? this.columns.filter((c) => keys.has(c.key)) : this.columns;
  }

  /** Records which columns the layout could show (hidden columns leave the Left/Right sort cycle). */
  setShownColumns(keys: readonly string[]): void {
    this.shownKeys = keys.length === this.columns.length ? null : new Set(keys);
  }

  column(key: string): Column<R> | undefined {
    return this.columns.find((c) => c.key === key);
  }

  /** Replaces the rows (re-sorted), keeping the selection on the same id when it survives. */
  setRows(rows: readonly R[]): void {
    const prev = this.selected ? this.idOf(this.selected) : null;
    this.source = [...rows];
    this.applySort(prev);
  }

  /** Selects a display index (clamped); returns true when the selection changed. */
  select(index: number): boolean {
    const next = clampIndex(index, this.view.length);
    const changed = next !== this.selIndex;
    this.selIndex = next;
    this.scrollTop = scrollToShow(this.scrollTop, this.selIndex, this.visible, this.view.length);
    return changed;
  }

  /** Selects the row with `id`; false when absent. */
  selectById(id: string): boolean {
    const i = this.view.findIndex((r) => this.idOf(r) === id);
    if (i < 0) return false;
    this.select(i);
    return true;
  }

  /** Moves the selection by `delta` rows (wrapping when enabled); true when it moved. */
  move(delta: number): boolean {
    const n = this.view.length;
    if (n === 0 || delta === 0) return false;
    let next = this.selIndex + delta;
    if (next < 0 || next >= n) {
      if (!this.opts.wrap) next = Math.max(0, Math.min(n - 1, next));
      else next = ((next % n) + n) % n;
    }
    return next !== this.selIndex && this.select(next);
  }

  /** Scrolls a page up (-1) or down (+1), moving the selection with it. */
  page(dir: -1 | 1): boolean {
    return this.move(dir * Math.max(1, this.visible - 1));
  }

  /** Sorts by a sortable column (dir defaults to the column default); false for unknown/unsortable keys. */
  sortBy(key: string, dir?: SortDir): boolean {
    const col = this.column(key);
    if (!col?.sortValue) return false;
    this.sortKeyValue = key;
    this.sortDirValue = dir ?? col.defaultDir ?? 'desc';
    this.applySort(this.selected ? this.idOf(this.selected) : null);
    return true;
  }

  /** Flips the sort direction of the current sort column; false when unsorted. */
  toggleSortDir(): boolean {
    if (!this.sortKeyValue) return false;
    return this.sortBy(this.sortKeyValue, this.sortDirValue === 'asc' ? 'desc' : 'asc');
  }

  /** Moves the sort column to the previous/next sortable column (wraps). */
  cycleSortColumn(delta: -1 | 1): boolean {
    const keys = this.shownColumns.filter((c) => c.sortValue).map((c) => c.key);
    if (keys.length === 0) return false;
    const cur = this.sortKeyValue ? keys.indexOf(this.sortKeyValue) : -1;
    const next = cur < 0 ? (delta > 0 ? 0 : keys.length - 1) : (((cur + delta) % keys.length) + keys.length) % keys.length;
    return this.sortBy(keys[next] as string);
  }

  /** Records layout geometry (called by the view); updates the visible row count. */
  setHitMap(hits: TableHitMap, visibleRows: number): void {
    this.hits = hits;
    this.visible = Math.max(1, visibleRows);
    this.scrollTop = scrollToShow(this.scrollTop, this.selIndex, this.visible, this.view.length);
  }

  /** Applies one tick of input. */
  update(dt: number, input: InputState): DataTableEvent<R> | null {
    const dir = this.vertical.step(dt, input);
    if (dir !== 0 && this.move(dir)) return this.selectEvent();
    if (pressed(input, LEFT_ACTIONS) && this.cycleSortColumn(-1)) return this.sortEvent();
    if (pressed(input, RIGHT_ACTIONS) && this.cycleSortColumn(1)) return this.sortEvent();
    if (pressed(input, SECONDARY_ACTIONS) && this.toggleSortDir()) return this.sortEvent();
    const pointerEvent = this.pointerUpdate(input);
    if (pointerEvent) return pointerEvent;
    if (pressed(input, ['back'])) return { type: 'back' };
    const row = this.selected;
    // A mouse press on a row is a tap (activates on release) or the start of a drag: its mapped confirm must
    // not open the row at once.
    if (row && pressed(input, ['confirm']) && !(this.press && input.pointer?.justDown)) return { type: 'activate', row, index: this.selIndex };
    return null;
  }

  /** Scrolls the list so `top` is its first row (clamped), pulling the selection into view. */
  private scrollTo(top: number): void {
    const maxScroll = Math.max(0, this.view.length - this.visible);
    this.scrollTop = Math.max(0, Math.min(maxScroll, top));
    const lo = this.scrollTop;
    const hi = this.scrollTop + this.visible - 1;
    if (this.selIndex < lo || this.selIndex > hi) this.selIndex = clampIndex(Math.max(lo, Math.min(hi, this.selIndex)), this.view.length);
  }

  /** True when a point is over the table (header or rows). */
  private over(x: number, y: number): boolean {
    const hits = this.hits;
    if (!hits) return false;
    const rects = [...hits.header.map((h) => h.rect), ...hits.rows.map((r) => r.rect)];
    if (rects.length === 0) return false;
    const top = Math.min(...rects.map((r) => r.y));
    const bottom = Math.max(...rects.map((r) => r.y + r.h)) + hits.rowH * Math.max(0, this.visible - hits.rows.length);
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  private selectEvent(): DataTableEvent<R> | null {
    const row = this.selected;
    return row ? { type: 'select', row, index: this.selIndex } : null;
  }

  private sortEvent(): DataTableEvent<R> {
    return { type: 'sort', key: this.sortKeyValue ?? '', dir: this.sortDirValue };
  }

  private rowAt(x: number, y: number): number {
    return this.hits?.rows.find((r) => inRect(r.rect, x, y))?.index ?? -1;
  }

  private pointerUpdate(input: InputState): DataTableEvent<R> | null {
    const p = input.pointer;
    const hits = this.hits;
    if (!p || !hits) {
      this.lastPointer = null;
      if (!p) this.press = null;
      return null;
    }
    const moved = !this.lastPointer || this.lastPointer.x !== p.x || this.lastPointer.y !== p.y;
    this.lastPointer = { x: p.x, y: p.y };
    if (p.wheel && this.over(p.x, p.y)) {
      const before = this.selIndex;
      this.scrollTo(this.scrollTop + p.wheel);
      return this.selIndex !== before ? this.selectEvent() : null;
    }
    if (p.justDown) {
      this.press = null;
      if (hits.scrollUp && inRect(hits.scrollUp, p.x, p.y)) return this.page(-1) ? this.selectEvent() : null;
      if (hits.scrollDown && inRect(hits.scrollDown, p.x, p.y)) return this.page(1) ? this.selectEvent() : null;
      const head = hits.header.find((h) => inRect(h.rect, p.x, p.y));
      if (head) {
        const changed = head.key === this.sortKeyValue ? this.toggleSortDir() : this.sortBy(head.key);
        return changed ? this.sortEvent() : null;
      }
      const index = this.rowAt(p.x, p.y);
      if (index >= 0) this.press = { index, startY: p.y, startScroll: this.scrollTop, dragging: false };
    }
    const press = this.press;
    if (press && (p.down || p.justUp)) {
      const rows = Math.trunc((p.y - press.startY) / Math.max(1, hits.rowH));
      if (rows !== 0) press.dragging = true;
      if (press.dragging) this.scrollTo(press.startScroll - rows);
    }
    if (press && p.justUp) {
      this.press = null;
      const index = this.rowAt(p.x, p.y);
      if (!press.dragging && index === press.index && index >= 0) {
        this.select(index);
        const row = this.selected;
        return row ? { type: 'activate', row, index } : null;
      }
      return null;
    }
    if (!this.press && moved && !p.down && input.lastDevice === 'mouse') {
      const index = this.rowAt(p.x, p.y);
      if (index >= 0 && index !== this.selIndex && this.select(index)) return this.selectEvent();
    }
    return null;
  }

  private applySort(keepId: string | null): void {
    const col = this.sortKeyValue ? this.column(this.sortKeyValue) : undefined;
    const sortValue = col?.sortValue;
    this.view = sortValue ? sortRows(this.source, (r) => sortValue(r), this.sortDirValue) : [...this.source];
    const i = keepId === null ? -1 : this.view.findIndex((r) => this.idOf(r) === keepId);
    this.selIndex = i >= 0 ? i : clampIndex(this.selIndex < 0 ? 0 : this.selIndex, this.view.length);
    this.scrollTop = scrollToShow(this.scrollTop, this.selIndex, this.visible, this.view.length);
  }
}
