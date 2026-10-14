/**
 * Base class of the hub-hosted team tabs, plus a generic full-screen table screen for drill-downs.
 *
 * TeamTabScreen draws inside `fc.contentRect()`: a chip row choosing the view (Y / tap), a tab-menu button
 * (LT / keyboard C, or tap; Start / Enter too when the hub does not keep it) opening a ChoiceDialog of
 * tab-level actions, a summary line, the active view's
 * DataTable (Up/Down select, Left/Right sort column, X flip sort, Confirm or tap = row action), a detail line
 * for the selected row and key hints. The hub keeps U/O, Back and Start / Enter (its Advance menu) and never
 * forwards them, so the tab menu also answers TAB_MENU_ACTIONS' `callTimeout` (LT, keyboard C / N). Views re-read
 * the League on every commit and in `resume` (called when a pushed screen above closes).
 *
 * TableScreen is a pushed, full-canvas screen over one ViewSpec (compare players, validation lists): Back pops.
 */
import type { Action, InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import type { Theme } from '../../theme';
import { drawButtonHint, drawHintBar, measureButtonHint, type ButtonHint, type UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import type { CellValue } from '../kit/data-table';
import { fitCell } from '../kit/data-table-view';
import { ChoiceDialog, type ChoiceOption } from '../kit/dialogs';
import { toneColor, type ToneText } from '../kit/format';
import { inRect, pressed, SECONDARY_ACTIONS, type Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import type { ActionResult } from './common';
import { ChipBar, isWide, tabLayout, ViewTable, type ActiveView, type TabLayout, type ViewSpec } from './layout';

type GlyphAction = Parameters<ScreenServices['input']['glyph']>[0];

const cellParts = (v: CellValue | null): ToneText => (v === null ? { text: '' } : typeof v === 'string' ? { text: v } : v);

/**
 * Actions that open a team tab's menu. The hub consumes 'pause' (Start / Enter) for its Advance menu before
 * the hosted tab sees the input, so keyboard and gamepad users reach the tab menu with `callTimeout` (LT,
 * keyboard C / N); 'pause' still works wherever the tab is not hosted by the hub.
 */
export const TAB_MENU_ACTIONS: readonly Action[] = ['callTimeout', 'pause'];

/** Hint-row height for a theme. */
export const hintRowHeight = (theme: Theme): number => theme.glyphH + 4 * theme.textScale;

/** Common behaviour of the team tabs. Subclasses call `init(views)` at the end of their constructor. */
export abstract class TeamTabScreen implements Screen {
  protected services: ScreenServices | null = null;
  protected viewList: ActiveView[] = [];
  readonly chips = new ChipBar([]);
  private layoutValue: TabLayout | null = null;
  /** Share of the width used by the side panel (0 = none). */
  protected sideFraction = 0;

  protected constructor(protected readonly fc: FranchiseContext, readonly id: string) {}

  /** Installs the views (one chip each) and selects `initialId` (default the first). */
  protected init(views: ActiveView[], initialId?: string): void {
    this.viewList = views;
    this.chips.setChips(this.chipSpecs());
    if (initialId) this.chips.select(initialId);
    for (const v of views) v.refresh();
  }

  /** Chip specs (override to add badges). */
  protected chipSpecs(): TabSpec[] {
    return this.viewList.map((v) => ({ id: v.id, label: v.label }));
  }

  /** The active view. */
  get view(): ActiveView {
    const v = this.viewList.find((x) => x.id === this.chips.current) ?? this.viewList[0];
    if (!v) throw new Error(`${this.id}: no views`);
    return v;
  }

  /** Last computed layout (null before the first render). */
  get lastLayout(): TabLayout | null { return this.layoutValue; }

  /** Summary line above the table. */
  abstract summary(): ToneText;

  /** Tab-level actions for the tab menu (TAB_MENU_ACTIONS or the menu button; empty = no menu button). */
  menu(): ChoiceOption[] { return []; }

  /** Runs a tab-menu action. */
  onMenu(_id: string): void { /* no tab menu by default */ }

  /** Called after the active chip changed. */
  protected onViewChange(_id: string): void { /* hook */ }

  /** Extra input handled before the table (true = consumed this tick). */
  protected handleInput(_dt: number, _input: InputState): boolean { return false; }

  /** Draws the side panel (when sideFraction > 0). */
  protected drawSide(_ctx: UiCtx, _theme: Theme, _rect: Rect): void { /* hook */ }

  /** Re-reads every view from the League. */
  refresh(): void {
    this.chips.setChips(this.chipSpecs());
    for (const v of this.viewList) v.refresh();
  }

  /** Switches to a view by id. */
  showView(id: string): boolean {
    if (!this.chips.select(id)) return false;
    this.onViewChange(id);
    return true;
  }

  /** Commits a successful result (toasting its message) or toasts the refusal; returns result.ok. */
  protected apply(result: ActionResult, reason: Parameters<FranchiseContext['commit']>[1]): boolean {
    if (result.ok) this.fc.commit(result.league, reason);
    this.fc.toast(result.message);
    this.refresh();
    return result.ok;
  }

  /** Opens the tab menu; false (nothing opened) when the tab has no menu actions. */
  openMenu(): boolean {
    const options = this.menu();
    if (options.length === 0) return false;
    this.fc.push(new ChoiceDialog(this.view.label, '', options, (id) => {
      if (id) this.onMenu(id);
    }));
    return true;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.refresh();
  }

  exit(): void { this.services = null; }
  resume(): void { this.refresh(); }

  protected glyph(action: GlyphAction): string {
    return this.services?.input.glyph(action) ?? '?';
  }

  update(dt: number, input: InputState): void {
    const p = input.pointer;
    const menuRect = this.layoutValue?.menu;
    const menuTap = !!(p?.justDown && menuRect && inRect(menuRect, p.x, p.y));
    if ((pressed(input, TAB_MENU_ACTIONS) || menuTap) && this.openMenu()) return;
    const changed = this.chips.update(input);
    if (changed) {
      this.onViewChange(changed);
      return;
    }
    if (this.handleInput(dt, input)) return;
    this.view.update(dt, input);
  }

  /** Key hints for the current device (the hub may show them; the tab draws them when there is room). */
  hints(): ButtonHint[] {
    const out: ButtonHint[] = [{ glyph: this.glyph('confirm'), label: 'Select' }];
    if (this.viewList.length > 1) out.push({ glyph: this.glyph('audible'), label: 'View' });
    out.push({ glyph: this.glyph('showPlayArt'), label: 'Sort' });
    return out;
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const ctx = rc.ctx;
    const rect = this.fc.contentRect();
    const c = theme.colors;
    const size = theme.textScale;
    const hasMenu = this.menu().length > 0;
    const menuHint = { glyph: this.glyph('callTimeout'), label: 'Menu' };
    const layout = tabLayout(theme, rect, { menuW: hasMenu ? measureButtonHint(theme, menuHint) + theme.gap * 2 : 0, side: this.sideFraction, hintH: hintRowHeight(theme) });
    this.layoutValue = layout;
    ctx.fillStyle = c.bg;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    this.chips.draw(ctx, theme, layout.chips);
    if (layout.menu) {
      ctx.fillStyle = c.bgAlt;
      ctx.fillRect(layout.menu.x, layout.menu.y, layout.menu.w, layout.menu.h);
      drawButtonHint(ctx, theme, menuHint, layout.menu.x + theme.gap, layout.menu.y + Math.max(0, Math.floor((layout.menu.h - hintRowHeight(theme)) / 2)));
    }
    if (layout.summary) {
      const s = this.summary();
      drawText(ctx, fitCell(s.text, layout.summary.w, size), layout.summary.x, layout.summary.y + Math.floor((theme.lineHeight - theme.glyphH) / 2), { color: toneColor(theme, s.tone ?? 'dim'), size });
    }
    const view = this.view;
    view.setWide(isWide(theme, layout.table.w));
    view.draw(ctx, theme, layout.table);
    if (layout.side) this.drawSide(ctx, theme, layout.side);
    if (layout.detail) {
      const d = cellParts(view.detail());
      drawText(ctx, fitCell(d.text, layout.detail.w, size), layout.detail.x, layout.detail.y + Math.floor((theme.lineHeight - theme.glyphH) / 2), { color: toneColor(theme, d.tone ?? 'info'), size });
    }
    if (layout.hints) drawHintBar(ctx, theme, this.hints(), layout.hints.x + layout.hints.w, layout.hints.y, 'right');
  }
}

/* ------------------------------ table screen ------------------------------ */

/** Options for TableScreen. */
export interface TableScreenOptions {
  /** Line under the title. */
  subtitle?: string;
}

/** A pushed full-canvas table (drill-downs). Back pops; Confirm/tap runs the spec's activate. */
export class TableScreen<R> implements Screen {
  readonly id: string;
  readonly view: ViewTable<R>;
  private services: ScreenServices | null = null;

  constructor(private readonly fc: FranchiseContext, readonly title: string, spec: ViewSpec<R>, private readonly opts: TableScreenOptions = {}) {
    this.id = `team-table:${spec.id}`;
    this.view = new ViewTable(spec);
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.view.refresh(); }

  update(dt: number, input: InputState): void {
    if (pressed(input, ['back'])) {
      this.fc.pop();
      return;
    }
    this.view.update(dt, input);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    const lh = theme.lineHeight;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, 0, width, lh * (this.opts.subtitle ? 2 : 1) + theme.gap);
    const pad = theme.pad;
    drawText(ctx, fitCell(this.title, width - pad * 2, size), pad, theme.gap, { color: c.accent, size });
    if (this.opts.subtitle) drawText(ctx, fitCell(this.opts.subtitle, width - pad * 2, size), pad, theme.gap + lh, { color: c.textDim, size });
    const top = lh * (this.opts.subtitle ? 2 : 1) + theme.gap * 2;
    const hintH = hintRowHeight(theme) + theme.gap;
    const rect = { x: pad, y: top, w: width - pad * 2, h: height - top - hintH - theme.gap };
    this.view.setWide(isWide(theme, rect.w));
    this.view.draw(ctx, theme, rect);
    const glyph = (a: GlyphAction): string => this.services?.input.glyph(a) ?? '?';
    const hints: ButtonHint[] = [{ glyph: glyph('showPlayArt'), label: 'Sort' }, { glyph: glyph('back'), label: 'Back' }];
    drawHintBar(ctx, theme, hints, width, height - hintH);
  }
}

/** True when the secondary button (X) was pressed this tick. */
export const secondaryPressed = (input: InputState): boolean => pressed(input, SECONDARY_ACTIONS);
