/**
 * Layout pieces of the hub-hosted team tabs.
 * - ChipBar: a row of view/filter chips built on the kit TabBar's layout and drawing. The hub keeps U/O
 *   (menuTabLeft/Right) for its own tabs, so chips cycle with the tertiary button Y (keyboard I) and respond
 *   to taps/clicks on a chip or on the ◀ ▶ overflow markers.
 * - tabLayout: pure split of the hub content rect into chip row, tab-menu button, summary line, table,
 *   detail line, key hints and an optional side panel. When the table would drop below MIN_TABLE_ROWS rows
 *   (large text, short content areas) the hints, then the summary, then the detail line are dropped.
 * - ViewTable: one DataTable-backed view of a tab (its columns switch to a compact set when the table is
 *   narrow), with activation/detail callbacks, behind the non-generic ActiveView interface.
 */
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { DataTable, type CellValue, type Column, type DataTableEvent } from '../kit/data-table';
import { charWidth, drawDataTable } from '../kit/data-table-view';
import type { Tone } from '../kit/format';
import { TERTIARY_ACTIONS, inRect, pressed, type Rect, type SortDir } from '../kit/list';
import { TabBar, drawTabBar, type TabBarView, type TabSpec } from '../kit/tabbar';

/* --------------------------------- chips --------------------------------- */

/** View/filter chips: Y cycles forward, taps select. */
export class ChipBar {
  readonly bar: TabBar;
  private view: TabBarView | null = null;

  constructor(chips: readonly TabSpec[], initialId?: string) {
    this.bar = new TabBar(chips, initialId ? { initialId } : {});
  }

  /** Active chip id ('' when there are no chips). */
  get current(): string { return this.bar.current?.id ?? ''; }

  /** Replaces the chips, keeping the active one when it survives. */
  setChips(chips: readonly TabSpec[]): void { this.bar.setTabs(chips); }

  select(id: string): boolean { return this.bar.selectById(id); }

  /** Moves to the next/previous chip (wraps); true when it changed. */
  cycle(delta: -1 | 1): boolean { return this.bar.move(delta); }

  /** Applies one tick of input; returns the newly active chip id, or null when unchanged. */
  update(input: InputState): string | null {
    if (pressed(input, TERTIARY_ACTIONS)) return this.cycle(1) ? this.current : null;
    const p = input.pointer;
    const v = this.view;
    if (!p?.justDown || !v || !inRect(v.rect, p.x, p.y)) return null;
    if (v.moreLeft && inRect(v.moreLeft, p.x, p.y)) return this.cycle(-1) ? this.current : null;
    if (v.moreRight && inRect(v.moreRight, p.x, p.y)) return this.cycle(1) ? this.current : null;
    const hit = v.tabs.find((t) => p.x >= t.x && p.x < t.x + t.w);
    if (!hit || hit.index === this.bar.index) return null;
    return this.bar.select(hit.index) ? this.current : null;
  }

  /** Draws the chips in `rect` and records their geometry for pointer input. */
  draw(ctx: UiCtx, theme: Theme, rect: Rect): TabBarView {
    this.view = drawTabBar(ctx, theme, this.bar, rect);
    return this.view;
  }

  /** Geometry of the last draw (null before the first). */
  get lastView(): TabBarView | null { return this.view; }
}

/* --------------------------------- layout -------------------------------- */

/** Rows the table keeps before optional lines are dropped. */
export const MIN_TABLE_ROWS = 4;

/** Where each part of a team tab goes. Null parts are not shown. */
export interface TabLayout {
  chips: Rect;
  menu: Rect | null;
  summary: Rect | null;
  table: Rect;
  detail: Rect | null;
  hints: Rect | null;
  side: Rect | null;
}

/** Options for tabLayout. */
export interface TabLayoutOptions {
  /** Width of the tab-menu button at the right of the chip row (0 = no button). */
  menuW: number;
  /** Share of the width given to a side panel right of the table (0 = none). */
  side?: number;
  /** Height of the key-hint row (0 = none). */
  hintH?: number;
}

/** Pure layout of a team tab inside the hub content rect. */
export const tabLayout = (theme: Theme, rect: Rect, opts: TabLayoutOptions): TabLayout => {
  const gap = theme.gap;
  const lh = theme.lineHeight;
  const chipH = TabBar.height(theme);
  const menuW = Math.min(opts.menuW, Math.floor(rect.w / 3));
  const chips: Rect = { x: rect.x, y: rect.y, w: rect.w - (menuW > 0 ? menuW + gap : 0), h: chipH };
  const menu: Rect | null = menuW > 0 ? { x: rect.x + rect.w - menuW, y: rect.y, w: menuW, h: chipH } : null;
  let showSummary = true;
  let showDetail = true;
  let showHints = (opts.hintH ?? 0) > 0;
  const bodyH = (): number => {
    let h = rect.h - chipH - gap;
    if (showSummary) h -= lh;
    if (showDetail) h -= lh + gap;
    if (showHints) h -= (opts.hintH ?? 0) + gap;
    return h;
  };
  const rowsFit = (): number => Math.floor(bodyH() / lh) - 1;
  if (rowsFit() < MIN_TABLE_ROWS) showHints = false;
  if (rowsFit() < MIN_TABLE_ROWS) showSummary = false;
  if (rowsFit() < MIN_TABLE_ROWS) showDetail = false;
  let y = rect.y + chipH + gap;
  const summary = showSummary ? { x: rect.x + gap, y, w: rect.w - gap * 2, h: lh } : null;
  if (summary) y += lh;
  const tableH = Math.max(lh, bodyH());
  const sideW = opts.side && opts.side > 0 ? Math.floor(rect.w * Math.min(0.6, opts.side)) : 0;
  const table: Rect = { x: rect.x, y, w: rect.w - (sideW > 0 ? sideW + gap : 0), h: tableH };
  const side: Rect | null = sideW > 0 ? { x: rect.x + rect.w - sideW, y, w: sideW, h: tableH } : null;
  y += tableH + gap;
  const detail = showDetail ? { x: rect.x + gap, y, w: rect.w - gap * 2, h: lh } : null;
  if (detail) y += lh + gap;
  const hints = showHints ? { x: rect.x, y, w: rect.w, h: opts.hintH ?? 0 } : null;
  return { chips, menu, summary, table, detail, hints, side };
};

/* ------------------------------ view tables ------------------------------ */

/** Characters a table must offer before the full (wide) column set is used. */
export const WIDE_TABLE_CHARS = 58;

/** True when a table `width` px wide shows the full column set at the theme's text scale. */
export const isWide = (theme: Theme, width: number): boolean => width / charWidth(theme.textScale) >= WIDE_TABLE_CHARS;

/** Definition of one DataTable view of a tab. */
export interface ViewSpec<R> {
  id: string;
  label: string;
  /** Column set for a wide or narrow (large text) table. */
  columns(wide: boolean): readonly Column<R>[];
  /** Current rows (read from the League each refresh). */
  rows(): readonly R[];
  rowId(row: R): string;
  initialSort?: { key: string; dir?: SortDir } | null;
  emptyText?: string;
  showHeader?: boolean;
  rowTone?(row: R): Tone | null;
  /** One line about the selected row shown under the table. */
  detail?(row: R): CellValue | null;
  /** Confirm / tap on a row. */
  activate?(row: R): void;
}

/** Non-generic face of a view, used by the tab base class. */
export interface ActiveView {
  readonly id: string;
  readonly label: string;
  refresh(): void;
  setWide(wide: boolean): void;
  update(dt: number, input: InputState): void;
  draw(ctx: UiCtx, theme: Theme, rect: Rect): void;
  /** Detail of the selected row, or null. */
  detail(): CellValue | null;
}

/** A DataTable over a ViewSpec. */
export class ViewTable<R> implements ActiveView {
  private tableValue: DataTable<R>;
  private wide = true;

  constructor(readonly spec: ViewSpec<R>) {
    this.tableValue = this.build(null);
  }

  get id(): string { return this.spec.id; }
  get label(): string { return this.spec.label; }
  get table(): DataTable<R> { return this.tableValue; }
  get isWide(): boolean { return this.wide; }

  private build(prev: DataTable<R> | null): DataTable<R> {
    const columns = this.spec.columns(this.wide);
    const keepSort = prev?.sortKey && columns.some((c) => c.key === prev.sortKey && c.sortValue) ? { key: prev.sortKey, dir: prev.sortDir } : null;
    const selected = prev?.selected ?? null;
    return new DataTable(columns, this.spec.rows(), {
      rowId: (r) => this.spec.rowId(r),
      initialSort: keepSort ?? this.spec.initialSort ?? null,
      emptyText: this.spec.emptyText,
      showHeader: this.spec.showHeader,
      rowTone: this.spec.rowTone ? (r) => this.spec.rowTone?.(r) ?? null : undefined,
      ...(selected ? { initialRowId: this.spec.rowId(selected) } : {}),
    });
  }

  /** Re-reads the rows (selection follows the row id). */
  refresh(): void { this.tableValue.setRows(this.spec.rows()); }

  /** Rebuilds the table from scratch (columns that depend on outside state changed); selection resets. */
  rebuild(): void {
    this.tableValue = this.build(null);
  }

  /** Switches between the wide and narrow column sets (rebuilds only on change). */
  setWide(wide: boolean): void {
    if (wide === this.wide) return;
    this.wide = wide;
    this.tableValue = this.build(this.tableValue);
  }

  update(dt: number, input: InputState): DataTableEvent<R> | null {
    const ev = this.tableValue.update(dt, input);
    if (ev?.type === 'activate') this.spec.activate?.(ev.row);
    return ev;
  }

  draw(ctx: UiCtx, theme: Theme, rect: Rect): void {
    drawDataTable(ctx, theme, this.tableValue, rect);
  }

  detail(): CellValue | null {
    const row = this.tableValue.selected;
    return row && this.spec.detail ? this.spec.detail(row) : null;
  }
}
