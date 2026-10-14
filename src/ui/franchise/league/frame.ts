/**
 * FrameScreen: the common chrome of the league-info screens. The same class serves hub-hosted tabs (drawn in
 * `fc.contentRect()`; the hub keeps U/O, Start and Back) and pushed drill-downs (`pushed`: full canvas, a title
 * row with a CLOSE button and a hint bar; U/O also switch views and Back or CLOSE closes the screen).
 *
 * Layout, top to bottom: [title] · view chips + OPTIONS button · status line (an optional "◀ label ▶" pager and a
 * summary) · the view body (a DataTable) · detail line for the selected row · key hints. When the table would
 * show fewer than MIN_BODY_ROWS rows (large text) the hints and then the detail line are dropped.
 *
 * Controls (every one reachable by keyboard, gamepad, mouse and touch):
 * - Y (keyboard I) cycles the views; a tap on a chip selects it (pushed: U/O too).
 * - LT (keyboard C) or a tap on OPTIONS opens the options menu (ChoiceDialogs: option, then value).
 * - Left/Right page the pager when the body has no sortable columns; a tap on ◀ / ▶ always pages.
 * - Up/Down select, Left/Right change the sort column and X flips it on sortable tables; Confirm or a tap
 *   (release on the same row) activates the selected row. A mouse click's extra Confirm edge is dropped.
 * - Pushed screens close with Back (keyboard L/Esc, gamepad B) or a tap on the CLOSE button of the title row.
 */
import type { InputState } from '../../input/types';
import type { SpriteCtx } from '../../render/sprites';
import { drawText, measureText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import type { Theme } from '../../theme';
import { drawHintBar, type ButtonHint, type UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import type { CellValue, DataTable } from '../kit/data-table';
import { charWidth, drawDataTable, fitCell } from '../kit/data-table-view';
import { ChoiceDialog } from '../kit/dialogs';
import { toneColor, type ToneText } from '../kit/format';
import { LEFT_ACTIONS, RIGHT_ACTIONS, TERTIARY_ACTIONS, inRect, pressed, type Rect } from '../kit/list';
import { TabBar, drawTabBar, type TabBarView, type TabSpec } from '../kit/tabbar';
import { glyphOf, sanitizeInput } from './common';

/** Table rows kept before optional lines are dropped. */
export const MIN_BODY_ROWS = 3;

/** Characters a table needs before screens use their wide column sets. */
export const WIDE_CHARS = 56;

/** Actions opening the options menu (LT / keyboard C or N). */
export const OPTIONS_ACTIONS = ['callTimeout'] as const;

/** Text of the options button. */
export const OPTIONS_LABEL = 'OPTIONS';

/** Text of the close button of pushed screens (the touch way back; keyboard/gamepad use Back). */
export const CLOSE_LABEL = 'CLOSE';

/** The body of a view: a table (or anything drawn and driven the same way). */
export interface ViewBody {
  /** True when Left/Right belong to the body (sort columns) rather than the pager. */
  readonly sortable: boolean;
  update(dt: number, input: InputState): void;
  draw(ctx: UiCtx, theme: Theme, rect: Rect): void;
  /** One line about the selected row. */
  detail(): CellValue | null;
  /** True when Confirm on the selected row does something (drives the "Open" hint). */
  canActivate(): boolean;
}

/** A DataTable body with an activation callback (optionally limited to some rows) and an optional detail line. */
export class TableBody<R> implements ViewBody {
  constructor(
    readonly table: DataTable<R>,
    private readonly handlers: { activate?(row: R): void; detail?(row: R): CellValue | null; can?(row: R): boolean } = {},
  ) {}

  canActivate(): boolean {
    const row = this.table.selected;
    return !!row && !!this.handlers.activate && (this.handlers.can?.(row) ?? true);
  }

  get sortable(): boolean { return this.table.columns.some((c) => !!c.sortValue); }

  update(dt: number, input: InputState): void {
    const ev = this.table.update(dt, input);
    if (ev?.type === 'activate') this.handlers.activate?.(ev.row);
  }

  /** Activates the selected row (scripted flows / tests). */
  activateSelected(): boolean {
    const row = this.table.selected;
    if (!row || !this.handlers.activate) return false;
    this.handlers.activate(row);
    return true;
  }

  draw(ctx: UiCtx, theme: Theme, rect: Rect): void { drawDataTable(ctx, theme, this.table, rect); }

  detail(): CellValue | null {
    const row = this.table.selected;
    return row && this.handlers.detail ? this.handlers.detail(row) : null;
  }
}

/** One option of a screen (a value picked from a list). */
export interface FrameOption {
  id: string;
  label: string;
  value: string;
  choices: readonly { id: string; label: string }[];
}

/** A pager shown at the start of the status line. */
export interface Pager {
  label: string;
  /** What Left/Right page through, for the key hint ("Week"). */
  noun: string;
  canPrev: boolean;
  canNext: boolean;
}

/** Where each part of a frame goes (null = not shown). */
export interface FrameLayout {
  title: Rect | null;
  /** CLOSE button at the right of the title row (pushed screens only). */
  close: Rect | null;
  chips: Rect;
  options: Rect | null;
  status: Rect | null;
  body: Rect;
  detail: Rect | null;
  hints: Rect | null;
}

/** Height of a hint row (matches drawHintBar). */
export const hintRowHeight = (theme: Theme): number => theme.glyphH + 4 * theme.textScale;

/** Width of the CLOSE button. */
export const closeButtonWidth = (theme: Theme): number => measureText(CLOSE_LABEL, theme.textScale).width + theme.pad * 2;

/** Width of the OPTIONS button. */
export const optionsButtonWidth = (theme: Theme): number => measureText(OPTIONS_LABEL, theme.textScale).width + theme.pad * 2;

/**
 * Pure layout of a frame inside `rect`. When the table would show fewer than MIN_BODY_ROWS rows the hints, then
 * the detail line, then (unless it carries a pager, `keepStatus`) the status line are dropped.
 */
export const frameLayout = (theme: Theme, rect: Rect, o: { pushed: boolean; titleLines?: number; options: boolean; keepStatus?: boolean }): FrameLayout => {
  const lh = theme.lineHeight;
  const gap = theme.gap;
  let y = rect.y;
  const titleH = o.pushed ? lh * Math.max(1, o.titleLines ?? 1) + gap : 0;
  const closeW = o.pushed ? Math.min(closeButtonWidth(theme), Math.floor(rect.w / 4)) : 0;
  const title = o.pushed ? { x: rect.x, y, w: rect.w - closeW - gap, h: titleH } : null;
  const close = o.pushed ? { x: rect.x + rect.w - closeW, y, w: closeW, h: lh } : null;
  y += titleH;
  const chipH = TabBar.height(theme);
  const optW = o.options ? Math.min(optionsButtonWidth(theme), Math.floor(rect.w / 3)) : 0;
  const chips = { x: rect.x, y, w: rect.w - (optW > 0 ? optW + gap : 0), h: chipH };
  const options = optW > 0 ? { x: rect.x + rect.w - optW, y, w: optW, h: chipH } : null;
  y += chipH + gap;
  const hintH = hintRowHeight(theme) + gap;
  let showHints = true;
  let showDetail = true;
  let showStatus = true;
  const bodyH = (): number => rect.y + rect.h - y - (showStatus ? lh : 0) - (showDetail ? lh + gap : 0) - (showHints ? hintH : 0);
  const rows = (): number => Math.floor(bodyH() / lh) - 1;
  if (!o.pushed && rows() < MIN_BODY_ROWS) showHints = false;
  if (rows() < MIN_BODY_ROWS) showDetail = false;
  if (!o.keepStatus && rows() < MIN_BODY_ROWS) showStatus = false;
  const height = Math.max(lh, bodyH());
  const status = showStatus ? { x: rect.x, y, w: rect.w, h: lh } : null;
  if (status) y += lh;
  const body = { x: rect.x, y, w: rect.w, h: height };
  y += body.h + gap;
  const detail = showDetail ? { x: rect.x + gap, y, w: rect.w - gap * 2, h: lh } : null;
  const hints = showHints ? { x: rect.x, y: rect.y + rect.h - hintRowHeight(theme), w: rect.w, h: hintRowHeight(theme) } : null;
  return { title, close, chips, options, status, body, detail, hints };
};

/** Pager hit areas and the room left for the summary in a status row. */
export const pagerLayout = (theme: Theme, status: Rect, label: string): { prev: Rect; next: Rect; labelX: number; label: string; rest: Rect } => {
  const size = theme.textScale;
  const arrowW = measureText('◀', size).width + theme.gap * 2;
  const maxLabel = Math.max(0, Math.floor(status.w * 0.6) - arrowW * 2);
  const text = fitCell(label, maxLabel, size);
  const labelW = measureText(text, size).width;
  const prev = { x: status.x, y: status.y, w: arrowW, h: status.h };
  const next = { x: status.x + arrowW + labelW + theme.gap, y: status.y, w: arrowW, h: status.h };
  const restX = next.x + next.w + theme.gap;
  return { prev, next, labelX: status.x + arrowW, label: text, rest: { x: restX, y: status.y, w: Math.max(0, status.x + status.w - restX), h: status.h } };
};

/**
 * Base of every league-info screen. Subclasses install their chips (`this.chips.setTabs(this.views())`), pick the
 * initial view and call `rebuild()` at the end of their constructor; `enter`/`resume` re-read the League.
 */
export abstract class FrameScreen implements Screen {
  protected services: ScreenServices | null = null;
  readonly chips = new TabBar([]);
  private chipView: TabBarView | null = null;
  private layoutValue: FrameLayout | null = null;
  private pagerHits: { prev: Rect; next: Rect } | null = null;

  protected constructor(protected readonly fc: FranchiseContext, readonly id: string, readonly pushed = false) {}

  /** The views (chips). */
  protected abstract views(): TabSpec[];
  /** Rebuilds the current view's body from the League and options. */
  protected abstract rebuild(): void;
  /** The current view's body. */
  abstract body(): ViewBody | null;
  /** Options of the current view (empty = no OPTIONS button). */
  options(): FrameOption[] { return []; }
  /** Applies an option value (the frame rebuilds afterwards). */
  protected applyOption(_id: string, _value: string): void { /* no options by default */ }
  /** Pager of the current view. */
  pager(): Pager | null { return null; }
  /** Pages by one step; true when it moved (the frame rebuilds afterwards). */
  protected turnPage(_delta: -1 | 1): boolean { return false; }
  /** Status text after the pager. */
  summary(): ToneText { return { text: '' }; }
  /** Title of a pushed screen. */
  protected title(): ToneText { return { text: this.id }; }
  /** Lines the title area uses (pushed screens). */
  protected titleLines(): number { return 1; }
  /** Draws the title area (pushed screens); default: the title text on a panel strip. */
  protected drawTitle(ctx: UiCtx & SpriteCtx, theme: Theme, rect: Rect): void {
    const t = this.title();
    drawText(ctx, fitCell(t.text, rect.w - theme.pad * 2, theme.textScale), rect.x + theme.pad, rect.y + Math.floor((theme.lineHeight - theme.glyphH) / 2), { color: toneColor(theme, t.tone ?? 'accent'), size: theme.textScale });
  }
  /** Called when the view changed (before the rebuild). */
  protected onViewChange(_id: string): void { /* hook */ }

  /** Current view id ('' when none). */
  get view(): string { return this.chips.current?.id ?? ''; }

  /** The active theme. */
  protected get theme(): Theme { return this.services?.theme ?? this.fc.services.theme; }

  /** Character cells a full-width table offers at the current text size. */
  tableChars(): number {
    const theme = this.theme;
    const w = this.pushed ? this.fc.services.width - theme.pad * 2 : this.fc.contentRect().w;
    return Math.floor(w / charWidth(theme.textScale));
  }

  /** True when a full-width table has room for the wide column set (normal text); false in large text. */
  isWide(minChars = WIDE_CHARS): boolean { return this.tableChars() >= minChars; }
  /** Last layout (null before the first render). */
  get lastLayout(): FrameLayout | null { return this.layoutValue; }

  /** Re-reads the League: chips, then the body. */
  refresh(): void {
    this.chips.setTabs(this.views());
    this.rebuild();
  }

  /** Switches to a view by id. */
  showView(id: string): boolean {
    if (!this.chips.selectById(id)) return false;
    this.onViewChange(id);
    this.rebuild();
    return true;
  }

  /** Sets an option and rebuilds; false for an unknown option or value. */
  setOption(id: string, value: string): boolean {
    const o = this.options().find((x) => x.id === id);
    if (!o || !o.choices.some((c) => c.id === value)) return false;
    this.applyOption(id, value);
    this.rebuild();
    return true;
  }

  /** Pages the pager; true when it moved. */
  page(delta: -1 | 1): boolean {
    const p = this.pager();
    if (!p || (delta < 0 ? !p.canPrev : !p.canNext)) return false;
    if (!this.turnPage(delta)) return false;
    this.rebuild();
    return true;
  }

  /** Opens the options menu (one option: its values directly). False when there are no options. */
  openOptions(): boolean {
    const opts = this.options();
    if (opts.length === 0) return false;
    const only = opts.length === 1 ? opts[0] : undefined;
    if (only) return this.openOptionValues(only.id);
    this.fc.push(new ChoiceDialog('Options', '', opts.map((o) => ({ id: o.id, label: o.label, subLabel: o.choices.find((c) => c.id === o.value)?.label ?? o.value })), (id) => {
      if (id) this.openOptionValues(id);
    }, { maxVisible: this.dialogRows() }));
    return true;
  }

  /** Opens the value list of one option. */
  openOptionValues(id: string): boolean {
    const o = this.options().find((x) => x.id === id);
    if (!o) return false;
    this.fc.push(new ChoiceDialog(o.label, '', o.choices.map((c) => ({ id: c.id, label: c.id === o.value ? `${c.label} *` : c.label })), (v) => {
      if (v) this.setOption(id, v);
    }, { maxVisible: this.dialogRows() }));
    return true;
  }

  private dialogRows(): number { return (this.services?.theme.textScale ?? 1) > 1 ? 4 : 7; }

  enter(services: ScreenServices): void {
    this.services = services;
    this.refresh();
  }

  exit(): void { this.services = null; }
  resume(): void { this.refresh(); }

  private chipUpdate(input: InputState): boolean {
    const cycle = (delta: -1 | 1): boolean => {
      if (!this.chips.move(delta)) return false;
      this.onViewChange(this.view);
      this.rebuild();
      return true;
    };
    if (pressed(input, TERTIARY_ACTIONS)) return cycle(1);
    if (this.pushed && pressed(input, ['menuTabLeft'])) return cycle(-1);
    if (this.pushed && pressed(input, ['menuTabRight'])) return cycle(1);
    const p = input.pointer;
    const v = this.chipView;
    if (!p?.justDown || !v || !inRect(v.rect, p.x, p.y)) return false;
    if (v.moreLeft && inRect(v.moreLeft, p.x, p.y)) return cycle(-1);
    if (v.moreRight && inRect(v.moreRight, p.x, p.y)) return cycle(1);
    const hit = v.tabs.find((t) => p.x >= t.x && p.x < t.x + t.w);
    if (!hit || hit.index === this.chips.index || !this.chips.select(hit.index)) return true;
    this.onViewChange(this.view);
    this.rebuild();
    return true;
  }

  update(dt: number, raw: InputState): void {
    const input = sanitizeInput(raw);
    if (this.pushed && pressed(input, ['back'])) {
      this.fc.pop();
      return;
    }
    const p = input.pointer;
    const layout = this.layoutValue;
    if (this.pushed && p?.justDown && layout?.close && inRect(layout.close, p.x, p.y)) {
      this.fc.pop();
      return;
    }
    if (p?.justDown && layout?.options && inRect(layout.options, p.x, p.y)) {
      this.openOptions();
      return;
    }
    if (pressed(input, OPTIONS_ACTIONS) && this.openOptions()) return;
    if (this.chipUpdate(input)) return;
    if (p?.justDown && this.pagerHits) {
      if (inRect(this.pagerHits.prev, p.x, p.y)) return void this.page(-1);
      if (inRect(this.pagerHits.next, p.x, p.y)) return void this.page(1);
    }
    const body = this.body();
    if (this.pager() && !body?.sortable) {
      if (pressed(input, LEFT_ACTIONS)) return void this.page(-1);
      if (pressed(input, RIGHT_ACTIONS)) return void this.page(1);
    }
    body?.update(dt, input);
  }

  /** Key hints for the current view and device. */
  hints(): ButtonHint[] {
    const g = (a: Parameters<typeof glyphOf>[1]): string => glyphOf(this.services?.input, a);
    const out: ButtonHint[] = [];
    if (this.chips.tabs.length > 1) out.push({ glyph: this.pushed ? `${g('menuTabLeft')} ${g('menuTabRight')}` : g('audible'), label: 'View' });
    if (this.options().length > 0) out.push({ glyph: g('callTimeout'), label: 'Options' });
    const pager = this.pager();
    const body = this.body();
    if (pager && !body?.sortable) out.push({ glyph: `${g('menuLeft')} ${g('menuRight')}`, label: pager.noun });
    if (body?.sortable) out.push({ glyph: g('showPlayArt'), label: 'Sort' });
    if (body?.canActivate()) out.push({ glyph: g('confirm'), label: 'Open' });
    if (this.pushed) out.push({ glyph: g('back'), label: 'Back' });
    return out;
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const ctx = rc.ctx;
    const rect = this.pushed ? { x: theme.pad, y: 0, w: rc.width - theme.pad * 2, h: rc.height - theme.gap } : this.fc.contentRect();
    const c = theme.colors;
    const size = theme.textScale;
    if (this.pushed) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, rc.width, rc.height);
    } else {
      ctx.fillStyle = c.bg;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    const layout = frameLayout(theme, rect, { pushed: this.pushed, titleLines: this.titleLines(), options: this.options().length > 0, keepStatus: this.pager() !== null });
    this.layoutValue = layout;
    if (layout.title) {
      ctx.fillStyle = c.panel;
      ctx.fillRect(0, layout.title.y, rc.width, layout.title.h - theme.gap);
      this.drawTitle(ctx, theme, layout.title);
    }
    if (layout.close) this.drawButton(ctx, theme, layout.close, CLOSE_LABEL);
    this.chipView = drawTabBar(ctx, theme, this.chips, layout.chips);
    if (layout.options) this.drawButton(ctx, theme, layout.options, OPTIONS_LABEL);
    this.pagerHits = null;
    if (layout.status) this.drawStatus(ctx, theme, layout.status);
    const body = this.body();
    if (body) body.draw(ctx, theme, layout.body);
    if (layout.detail && body) {
      const d = body.detail();
      const t: ToneText = d === null ? { text: '' } : typeof d === 'string' ? { text: d } : d;
      drawText(ctx, fitCell(t.text, layout.detail.w, size), layout.detail.x, layout.detail.y + Math.floor((theme.lineHeight - theme.glyphH) / 2), { color: toneColor(theme, t.tone ?? 'info'), size });
    }
    if (layout.hints) drawHintBar(ctx, theme, this.hints(), layout.hints.x + layout.hints.w + theme.pad, layout.hints.y, 'right');
  }

  private drawButton(ctx: UiCtx, theme: Theme, r: Rect, label: string): void {
    const c = theme.colors;
    ctx.fillStyle = c.panelLight;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = c.panelBorder;
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    drawText(ctx, fitCell(label, r.w, theme.textScale), r.x + r.w / 2, r.y + Math.floor((r.h - theme.glyphH) / 2), { color: c.text, size: theme.textScale, align: 'center' });
  }

  private drawStatus(ctx: UiCtx, theme: Theme, status: Rect): void {
    const size = theme.textScale;
    const c = theme.colors;
    const ty = status.y + Math.floor((status.h - theme.glyphH) / 2);
    const pager = this.pager();
    let rest = status;
    if (pager) {
      const pl = pagerLayout(theme, status, pager.label);
      this.pagerHits = { prev: pl.prev, next: pl.next };
      drawText(ctx, '◀', pl.prev.x + theme.gap, ty, { color: pager.canPrev ? c.accent : c.textDim, size });
      drawText(ctx, pl.label, pl.labelX, ty, { color: c.text, size });
      drawText(ctx, '▶', pl.next.x + theme.gap, ty, { color: pager.canNext ? c.accent : c.textDim, size });
      rest = pl.rest;
    }
    const s = this.summary();
    if (s.text) drawText(ctx, fitCell(s.text, rest.w - theme.gap, size), rest.x + (pager ? 0 : theme.gap), ty, { color: toneColor(theme, s.tone ?? 'dim'), size });
  }
}
