/**
 * Shared chrome and helpers for the market tabs (trades, free agency, scouting, draft room).
 *
 * `MarketScreen` is the base of every market screen. It lays its area out as a status line, a section bar with a
 * MENU button at its right end, and a body the subclass fills (usually a DataTable). The same screen works
 * hosted by the hub (drawn inside `fc.contentRect()`, the hub keeps U/O and Back) or pushed full-screen
 * (`pushed`: a title row and a hint bar are added, U/O switch sections and Back closes it).
 *
 * Controls: Y (the tertiary button, keyboard I) cycles sections, a tap on a section selects it; LT (keyboard C / N),
 * Start (keyboard Enter; only when pushed, the hub keeps Start for its Advance menu) or a tap on MENU opens the
 * screen's action menu (a ChoiceDialog, so every action is reachable from keyboard, gamepad, mouse and touch). Up/Down, Left/Right, X and Confirm belong to the body table. A left mouse
 * click also produces a Confirm edge; `sanitizeInput` drops it so a click is handled once, by pointer hit-tests.
 */
import type { TeamId } from '@/core/ids';
import type { League } from '@/franchise/types';
import type { DraftPick } from '@/teams/types';
import type { Action, InputState } from '../../input/types';
import { drawText, fitLines, measureText, wrapText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import type { Theme } from '../../theme';
import { drawButtonHint, drawHintBar, measureButtonHint, type ButtonHint, type UiCtx } from '../../widgets/panel';
import type { CommitReason, FranchiseContext } from '../context';
import { DataTable, type CellBar, type CellValue, type Column } from '../kit/data-table';
import { charWidth, drawDataTable, fitCell, fitColumns } from '../kit/data-table-view';
import { ChoiceDialog } from '../kit/dialogs';
import { toneColor, type ToneText } from '../kit/format';
import { TERTIARY_ACTIONS, inRect, pressed, type Rect } from '../kit/list';
import { TabBar, drawTabBar, type TabSpec } from '../kit/tabbar';

/** One entry of a screen's action menu. */
export interface MarketAction {
  id: string;
  label: string;
  /** Why it is unavailable right now (the entry is shown disabled with this reason); null/absent = enabled. */
  disabledReason?: string | null;
}

/** The input without some actions' edges and held state (used to leave hub keys to the hub). */
export const stripActions = (input: InputState, actions: readonly Action[]): InputState => {
  if (!actions.some((a) => input.justPressed.has(a) || input.down.has(a))) return input;
  const keep = (set: ReadonlySet<Action>): Set<Action> => new Set([...set].filter((a) => !actions.includes(a)));
  return { ...input, justPressed: keep(input.justPressed), down: keep(input.down), justReleased: keep(input.justReleased) };
};

/**
 * Drops the Confirm edge a left mouse click produces alongside its pointer edge (the default mouse map binds the
 * left button to A), so tables and buttons react to a click exactly once, through their pointer hit-tests.
 */
export const sanitizeInput = (input: InputState): InputState => {
  const p = input.pointer;
  if (!p || !(p.justDown || p.justUp) || input.lastDevice !== 'mouse') return input;
  return stripActions(input, ['confirm']);
};

/** Message of a thrown engine error, without the "fnName: " prefix. */
export const errorText = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  const cut = msg.indexOf(': ');
  return cut > 0 && cut < 24 && !msg.slice(0, cut).includes(' ') ? msg.slice(cut + 2) : msg;
};

/** Capitalises the first letter. */
export const sentence = (s: string): string => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/** A team's abbreviation (the id when unknown). */
export const teamAbbr = (league: League, id: TeamId | null | undefined): string => (id ? league.teams[id]?.abbr ?? String(id) : 'FA');

/** "City Name" of a team. */
export const teamName = (league: League, id: TeamId): string => {
  const t = league.teams[id];
  return t ? `${t.city} ${t.name}` : String(id);
};

/** Compact pick label: "2027 Rd 1 #12 (via NYC)". */
export const pickLabel = (league: League, pick: DraftPick): string => {
  const via = pick.originalTeamId !== pick.ownerTeamId ? ` (via ${teamAbbr(league, pick.originalTeamId)})` : '';
  return `${pick.year} Rd ${pick.round}${pick.overall ? ` #${pick.overall}` : ''}${via}`;
};

/**
 * Actions that open a market screen's action menu. The hub consumes 'pause' (Start / Enter) for its Advance menu
 * before a hosted tab sees the input, so hosted screens answer `callTimeout` (LT, keyboard C / N) too.
 */
export const MARKET_MENU_ACTIONS: readonly Action[] = ['callTimeout', 'pause'];

/** Rectangles of a market screen's frame. */
export interface MarketLayout {
  title: Rect | null;
  status: Rect;
  bar: Rect;
  menu: Rect;
  body: Rect;
  hints: Rect | null;
}

/** The status text laid out for a frame `width` wide: one line when it fits, else wrapped (large text) up to MAX_STATUS_LINES. */
export const statusLines = (theme: Theme, text: string, width: number): string[] => {
  const w = Math.max(0, width - theme.pad * 2);
  const lines = fitLines(text, w, MAX_STATUS_LINES, theme.textScale).filter((l) => l.length > 0);
  return lines.length > 0 ? lines : [fitCell(text, w, theme.textScale)];
};

/** Hint bar height (matches drawHintBar). */
const hintHeight = (theme: Theme): number => theme.glyphH + 4 * theme.textScale;

/** Most lines the status line may wrap onto (large text) before it is cut with an ellipsis. */
export const MAX_STATUS_LINES = 2;

/** Table lines (header + rows) the body keeps before status lines are given up (large text, short content areas). */
export const MIN_BODY_LINES = 4;

/**
 * Pure frame layout inside `rect`; `pushed` adds a title row on top and a hint bar at the bottom. `statusLines`
 * (1..MAX_STATUS_LINES) is how many lines the status text needs (see statusLines). `menuWidth` overrides the
 * MENU button width (default: the word MENU plus padding). When the body would drop below MIN_BODY_LINES lines the
 * status gives up lines, down to none (status.h 0): the table's rows matter more than the summary.
 */
export const marketLayout = (theme: Theme, rect: Rect, pushed: boolean, statusLines = 1, menuWidth?: number): MarketLayout => {
  const lh = theme.lineHeight;
  let y = rect.y;
  const title = pushed ? { x: rect.x, y, w: rect.w, h: lh } : null;
  if (title) y += lh;
  const barH = TabBar.height(theme);
  const hintRoom = pushed ? hintHeight(theme) + theme.gap : 0;
  const bodyLines = (status: number): number => Math.floor((rect.y + rect.h - y - status * lh - barH - theme.gap - hintRoom) / lh);
  let lines = Math.max(1, Math.min(MAX_STATUS_LINES, Math.floor(statusLines)));
  while (lines > 0 && bodyLines(lines) < MIN_BODY_LINES) lines--;
  const status = { x: rect.x, y, w: rect.w, h: lh * lines };
  y += status.h;
  const menuW = Math.min(rect.w, menuWidth ?? measureText('MENU', theme.textScale).width + theme.pad * 2);
  const bar = { x: rect.x, y, w: Math.max(0, rect.w - menuW), h: barH };
  const menu = { x: rect.x + rect.w - menuW, y, w: menuW, h: barH };
  y += barH + theme.gap;
  const body = { x: rect.x + theme.gap, y, w: Math.max(0, rect.w - theme.gap * 2), h: Math.max(theme.lineHeight, rect.y + rect.h - y - hintRoom) };
  const hints = pushed ? { x: rect.x, y: rect.y + rect.h - hintRoom + theme.gap, w: rect.w, h: hintRoom - theme.gap } : null;
  return { title, status, bar, menu, body, hints };
};

/**
 * Base class of the market screens (see the module header). Subclasses rebuild their view-models in `refresh`
 * (called on enter, resume and after their own commits), describe their actions for the menu and draw the body.
 */
export abstract class MarketScreen implements Screen {
  abstract readonly id: string;
  protected services: ScreenServices | null = null;
  readonly bar: TabBar;
  private layoutValue: MarketLayout | null = null;
  /** League the view-models were last rebuilt from (a different one, e.g. after the hub advanced a week, triggers a refresh). */
  private seen: League | null = null;

  constructor(protected readonly fc: FranchiseContext, sections: readonly TabSpec[], readonly pushed = false, initialSection?: string) {
    this.bar = new TabBar(sections, initialSection ? { initialId: initialSection } : {});
  }

  /** Id of the current section. */
  get section(): string { return this.bar.current?.id ?? ''; }
  /** Frame geometry of the last render (null before the first). */
  get frameLayout(): MarketLayout | null { return this.layoutValue; }

  /** Title drawn when pushed full-screen. */
  protected abstract title(): string;
  /** Rebuilds view-models from `fc.league()`. */
  abstract refresh(): void;
  /** The status line. */
  abstract status(): ToneText;
  /** Entries of the action menu for the current section and selection. */
  abstract actions(): MarketAction[];
  /** Runs an action by id (from the menu, a table row or a test). */
  abstract runAction(id: string): void;
  protected abstract updateBody(dt: number, input: InputState): void;
  protected abstract renderBody(ctx: UiCtx, theme: Theme, body: Rect, time: number): void;
  /** Called after the section changed. */
  protected onSectionChange(): void {}

  /** Switches to a section by id. */
  showSection(id: string): boolean {
    if (this.section === id) return true;
    if (!this.bar.selectById(id)) return false;
    this.onSectionChange();
    return true;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.resync();
  }

  exit(): void { this.services = null; }

  resume(): void { this.resync(); }

  /** Refreshes and remembers the League the view-models reflect. */
  private resync(): void {
    this.seen = this.fc.league();
    this.refresh();
  }

  /** Commits a new League, toasts `message` and refreshes. */
  protected commit(next: League, reason: CommitReason, message?: string): void {
    this.fc.commit(next, reason);
    if (message) this.fc.toast(message);
    this.resync();
  }

  /** Runs `fn`, toasting a thrown engine error instead of propagating it; true when it did not throw. */
  protected attempt(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.fc.toast(sentence(errorText(err)));
      return false;
    }
  }

  /** Closes a pushed screen (no-op when hosted by the hub). */
  close(): void {
    if (this.pushed) this.fc.pop();
  }

  /** Opens the action menu. */
  openActions(): void {
    const actions = this.actions();
    if (actions.length === 0) return;
    const large = (this.services?.theme.textScale ?? 1) > 1;
    const choices = actions.map((a) => ({ id: a.id, label: a.disabledReason ? `${a.label} (${a.disabledReason})` : a.label, disabled: !!a.disabledReason }));
    this.fc.push(new ChoiceDialog('Actions', '', choices, (id) => {
      if (id) this.runAction(id);
    }, { maxVisible: large ? 4 : 7 }));
  }

  update(dt: number, raw: InputState): void {
    if (this.fc.league() !== this.seen) this.resync();
    const input = sanitizeInput(raw);
    const hubKeys: Action[] = this.pushed ? [] : ['menuTabLeft', 'menuTabRight', 'back'];
    const own = stripActions(input, hubKeys);
    if (this.bar.update(dt, own)) return this.onSectionChange();
    if (pressed(own, TERTIARY_ACTIONS) && this.bar.move(1)) return this.onSectionChange();
    const p = own.pointer;
    const menu = this.layoutValue?.menu;
    if (pressed(own, MARKET_MENU_ACTIONS) || (p?.justDown && menu && inRect(menu, p.x, p.y))) return this.openActions();
    this.updateBody(dt, own);
  }

  /** The MENU button's key hint when hosted by the hub (its hint bar lacks the menu key); null = plain MENU label. */
  private menuHint(): ButtonHint | null {
    const input = this.services?.input;
    return !this.pushed && input ? { glyph: input.glyph('callTimeout'), label: 'Menu' } : null;
  }

  /** Button hints for the current device. */
  hints(): ButtonHint[] {
    const glyph = (a: Action): string => this.services?.input.glyph(a) ?? '?';
    const out: ButtonHint[] = [
      { glyph: glyph('audible'), label: 'Section' },
      { glyph: glyph('pause'), label: 'Menu' },
      { glyph: glyph('confirm'), label: 'Select' },
      { glyph: glyph('showPlayArt'), label: 'Sort' },
    ];
    if (this.pushed) out.push({ glyph: glyph('back'), label: 'Back' });
    return out;
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const ctx = rc.ctx;
    const c = theme.colors;
    const size = theme.textScale;
    const rect = this.pushed ? { x: 0, y: 0, w: rc.width, h: rc.height } : this.fc.contentRect();
    const status = this.status();
    const lines = statusLines(theme, status.text, rect.w);
    const menuHint = this.menuHint();
    const lay = marketLayout(theme, rect, this.pushed, lines.length, menuHint ? measureButtonHint(theme, menuHint) + theme.gap * 2 : undefined);
    this.layoutValue = lay;
    ctx.fillStyle = c.bg;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    const dy = Math.floor((theme.lineHeight - theme.glyphH) / 2);
    if (lay.title) {
      ctx.fillStyle = c.panel;
      ctx.fillRect(lay.title.x, lay.title.y, lay.title.w, lay.title.h);
      drawText(ctx, fitCell(this.title(), lay.title.w - theme.pad * 2, size), lay.title.x + theme.pad, lay.title.y + dy, { color: c.accent, size });
    }
    const room = Math.floor(lay.status.h / theme.lineHeight);
    // Fewer lines than the text needs (short content area): one line, cut with "...".
    const shown = room >= lines.length ? lines : room > 0 ? [fitCell(status.text, rect.w - theme.pad * 2, size)] : [];
    shown.forEach((line, i) => {
      drawText(ctx, line, lay.status.x + theme.pad, lay.status.y + i * theme.lineHeight + dy, { color: toneColor(theme, status.tone), size });
    });
    drawTabBar(ctx, theme, this.bar, lay.bar);
    ctx.fillStyle = c.panelLight;
    ctx.fillRect(lay.menu.x, lay.menu.y, lay.menu.w, lay.menu.h);
    ctx.fillStyle = c.panelBorder;
    ctx.fillRect(lay.menu.x, lay.menu.y + lay.menu.h - 1, lay.menu.w, 1);
    if (menuHint) drawButtonHint(ctx, theme, menuHint, lay.menu.x + theme.gap, lay.menu.y + Math.max(0, Math.floor((lay.menu.h - hintHeight(theme)) / 2)));
    else drawText(ctx, 'MENU', lay.menu.x + lay.menu.w / 2, lay.menu.y + Math.floor((lay.menu.h - theme.glyphH) / 2), { color: c.accent, size, align: 'center' });
    this.renderBody(ctx, theme, lay.body, rc.time);
    if (lay.hints) drawHintBar(ctx, theme, this.hints(), rect.w, lay.hints.y);
  }
}

/* ------------------------------------------------------------ info tables */

/** One label/value row of a detail table (summaries, player detail, reports). */
export interface InfoRow {
  id: string;
  label: string;
  value: CellValue;
  kind: 'info' | 'heading' | 'action';
  /** A bar drawn in the value cell (e.g. preference weights, value balance). */
  bar?: CellBar | null;
  /** Action run when the row is activated. */
  action?: string;
}

/** Columns of an info table: dim label, value (optionally a bar). */
export const INFO_COLUMNS: readonly Column<InfoRow>[] = [
  {
    key: 'label', label: 'Item', flex: 2, minWidth: 6,
    format: (r) => (r.kind === 'heading' ? { text: r.label, tone: 'accent' } : r.kind === 'action' ? { text: `▶ ${r.label}`, tone: 'info' } : { text: r.label, tone: 'dim' }),
  },
  { key: 'value', label: 'Value', flex: 3, minWidth: 6, format: (r) => r.value, bar: (r) => r.bar ?? null },
];

/** Single full-width value column (notes, long text lists). */
export const TEXT_COLUMNS: readonly Column<InfoRow>[] = [{ key: 'value', label: 'Text', flex: 1, format: (r) => r.value }];

/**
 * A header-less info table whose long values wrap onto continuation rows sized to the value column when drawn, so
 * large text stays readable instead of being cut off. `rows` are the logical rows; `table` holds the wrapped ones
 * (continuation rows keep the original's action, so activating any line of an entry acts on it).
 */
export class InfoView {
  readonly table: DataTable<InfoRow>;
  private source: readonly InfoRow[] = [];
  private fittedFor = '';

  constructor(private readonly columns: readonly Column<InfoRow>[] = INFO_COLUMNS, emptyText = 'Nothing to show') {
    this.table = new DataTable(columns, [], { rowId: (r) => r.id, showHeader: false, emptyText });
  }

  /** The logical (unwrapped) rows. */
  get rows(): readonly InfoRow[] { return this.source; }

  setRows(rows: readonly InfoRow[]): void {
    this.source = rows;
    this.fittedFor = '';
    this.table.setRows(rows);
  }

  /** Re-wraps values for `rect` (same column math as layoutTable); a no-op while the width and text size hold. */
  fit(theme: Theme, rect: Rect): void {
    const key = `${theme.textScale}:${rect.w}`;
    if (key === this.fittedFor) return;
    this.fittedFor = key;
    const size = theme.textScale;
    const markerW = measureText('▲', size).width + theme.gap;
    const widths = fitColumns(this.columns, Math.max(0, rect.w - theme.gap * 2 - markerW), charWidth(size), theme.gap * 2);
    const valueW = widths[widths.length - 1] ?? 0;
    const out: InfoRow[] = [];
    for (const r of this.source) {
      const v: ToneText = typeof r.value === 'string' ? { text: r.value } : r.value;
      if (r.bar || valueW <= 0 || measureText(v.text, size).width <= valueW) {
        out.push(r);
        continue;
      }
      wrapText(v.text, valueW, size).forEach((line, i) => {
        out.push(i === 0 ? { ...r, value: { ...v, text: line } }
          : { id: `${r.id}~${i}`, label: '', value: { ...v, text: line }, kind: 'info', ...(r.action ? { action: r.action } : {}) });
      });
    }
    this.table.setRows(out);
  }

  /** Fits and draws the table in `rect`. */
  draw(ctx: UiCtx, theme: Theme, rect: Rect): void {
    this.fit(theme, rect);
    drawDataTable(ctx, theme, this.table, rect);
  }
}

/** Heading row helper. */
export const heading = (id: string, label: string): InfoRow => ({ id, label, value: '', kind: 'heading' });
/** Info row helper. */
export const info = (id: string, label: string, value: CellValue, bar?: CellBar | null): InfoRow => ({ id, label, value, kind: 'info', ...(bar ? { bar } : {}) });
/** Action row helper. */
export const actionRow = (id: string, label: string, value: CellValue = ''): InfoRow => ({ id, label, value, kind: 'action', action: id });

/** Draws a centred dim message in a rect (empty states). */
export const drawNotice = (ctx: UiCtx, theme: Theme, rect: Rect, text: ToneText): void => {
  drawText(ctx, fitCell(text.text, rect.w - theme.pad * 2, theme.textScale), rect.x + rect.w / 2, rect.y + theme.gap, { color: toneColor(theme, text.tone ?? 'dim'), size: theme.textScale, align: 'center' });
};

/** All columns in normal text; only `compactKeys` (in that order) in large-text mode, so rows stay readable. */
export const columnsFor = <R>(all: readonly Column<R>[], compactKeys: readonly string[], large: boolean): Column<R>[] =>
  large ? compactKeys.map((k) => all.find((c) => c.key === k)).filter((c): c is Column<R> => !!c) : [...all];

/** "●" when on, dim "○" when off. */
export const mark = (on: boolean): ToneText => (on ? { text: '●', tone: 'accent' } : { text: '○', tone: 'dim' });
