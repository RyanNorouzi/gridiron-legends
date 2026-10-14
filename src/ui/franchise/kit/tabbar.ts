/**
 * Grouped, scrolling tab bar for the franchise hub and multi-section screens (player card, team pages).
 * Tabs switch with menuTabLeft/menuTabRight (U / O, LB / RB; wraps, skips disabled tabs) or a tap/click on a
 * tab or on the ◀ ▶ overflow markers. When the tabs are wider than the bar, a window that always contains
 * the active tab is shown (`tabWindow`, same contract as the play-call screen's visibleTabWindow). Tabs of
 * different groups are separated by a divider; an optional caption shows the active tab's group.
 * `layoutTabBar` is the pure view-model; `drawTabBar` paints it.
 */
import type { InputState } from '../../input/types';
import { drawText, measureText } from '../../render/text';
import { UI_SLAB } from '../../render/palette';
import { drawSelectionTrim } from '../../widgets/menu';
import type { ArtCtx } from '../../widgets/ui-art';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { fitCell } from './data-table-view';
import { inRect, pressed, type Rect } from './list';

/** One tab. */
export interface TabSpec {
  id: string;
  label: string;
  group?: string;
  /** Small counter/alert text drawn after the label ("3", "!"); null = none. */
  badge?: string | null;
  disabled?: boolean;
}

/** Tab bar options. */
export interface TabBarOptions {
  initialId?: string;
  /** Caption per group id, drawn at the left for the active tab's group. */
  groupLabels?: Readonly<Record<string, string>>;
}

/** Emitted when the active tab changes. */
export interface TabBarEvent {
  type: 'change';
  tab: TabSpec;
  index: number;
}

/** First/last tab indices that fit in `room` px while always including `selected` (widths include spacing). */
export const tabWindow = (widths: readonly number[], selected: number, room: number): { start: number; end: number } => {
  const n = widths.length;
  if (n === 0) return { start: 0, end: -1 };
  const span = (a: number, b: number): number => widths.slice(a, b + 1).reduce((t, w) => t + w, 0);
  let start = 0;
  while (start < selected && span(start, selected) > room) start++;
  let end = start;
  while (end + 1 < n && span(start, end + 1) <= room) end++;
  if (end < selected) end = selected;
  return { start, end };
};

/** Laid-out tab. */
export interface TabView {
  index: number;
  x: number;
  w: number;
  label: string;
  badge: string | null;
  active: boolean;
  disabled: boolean;
  /** Draw a group divider before this tab. */
  divider: boolean;
}

/** Pure view-model of the bar. */
export interface TabBarView {
  rect: Rect;
  caption: string | null;
  tabs: TabView[];
  moreLeft: Rect | null;
  moreRight: Rect | null;
}

export class TabBar {
  private list: TabSpec[] = [];
  private active = -1;
  private readonly opts: TabBarOptions;
  private hits: { tabs: { index: number; rect: Rect }[]; left: Rect | null; right: Rect | null } | null = null;

  constructor(tabs: readonly TabSpec[], opts: TabBarOptions = {}) {
    this.opts = opts;
    this.setTabs(tabs);
    if (opts.initialId) this.selectById(opts.initialId);
  }

  get tabs(): readonly TabSpec[] { return this.list; }
  get index(): number { return this.active; }
  get current(): TabSpec | null { return this.list[this.active] ?? null; }

  /** Replaces the tabs, keeping the active tab by id when it is still present and enabled. */
  setTabs(tabs: readonly TabSpec[]): void {
    const prev = this.current?.id;
    this.list = [...tabs];
    this.active = -1;
    if (!(prev && this.selectById(prev))) {
      const first = this.list.findIndex((t) => !t.disabled);
      this.active = first;
    }
  }

  /** Activates an enabled tab by index. */
  select(index: number): boolean {
    const t = this.list[index];
    if (!t || t.disabled) return false;
    this.active = index;
    return true;
  }

  selectById(id: string): boolean {
    return this.select(this.list.findIndex((t) => t.id === id));
  }

  /** Moves to the previous/next enabled tab (wraps); true when it changed. */
  move(delta: -1 | 1): boolean {
    const n = this.list.length;
    let i = this.active;
    for (let tries = 0; tries < n; tries++) {
      i = (((i + delta) % n) + n) % n;
      if (!this.list[i]?.disabled) {
        if (i === this.active) return false;
        this.active = i;
        return true;
      }
    }
    return false;
  }

  /** Applies one tick of input; returns a change event when the active tab moved. */
  update(_dt: number, input: InputState): TabBarEvent | null {
    let changed = false;
    if (pressed(input, ['menuTabLeft'])) changed = this.move(-1);
    else if (pressed(input, ['menuTabRight'])) changed = this.move(1);
    const p = input.pointer;
    if (!changed && p?.justDown && this.hits) {
      if (this.hits.left && inRect(this.hits.left, p.x, p.y)) changed = this.move(-1);
      else if (this.hits.right && inRect(this.hits.right, p.x, p.y)) changed = this.move(1);
      else {
        const hit = this.hits.tabs.find((t) => inRect(t.rect, p.x, p.y));
        if (hit && hit.index !== this.active) changed = this.select(hit.index);
      }
    }
    const tab = this.current;
    return changed && tab ? { type: 'change', tab, index: this.active } : null;
  }

  /** Height the bar occupies. */
  static height(theme: Theme): number {
    return theme.lineHeight + 2;
  }

  /** Pure layout in `rect`; records hit rectangles for pointer input. */
  layout(theme: Theme, rect: Rect): TabBarView {
    const size = theme.textScale;
    const pad = theme.gap;
    const groupGap = theme.gap * 2;
    const current = this.current;
    const captionText = current?.group ? this.opts.groupLabels?.[current.group] ?? null : null;
    const captionW = captionText ? measureText(`${captionText} `, size).width + pad : 0;
    const arrowW = measureText('◀', size).width + pad;
    const labelOf = (t: TabSpec): string => t.label;
    const badgeW = (t: TabSpec): number => (t.badge ? measureText(t.badge, size).width + pad * 2 : 0);
    const widths = this.list.map((t, i) => {
      const divider = i > 0 && t.group !== this.list[i - 1]?.group;
      return measureText(labelOf(t), size).width + pad * 2 + badgeW(t) + (divider ? groupGap : 0) + 1;
    });
    const full = widths.reduce((a, b) => a + b, 0);
    const room = rect.w - captionW;
    let overflow = full > room;
    let win = overflow ? tabWindow(widths, Math.max(0, this.active), room - arrowW * 2) : { start: 0, end: this.list.length - 1 };
    // The caption must sit right before its own group's tabs (not before the Home tabs, where it read as their
    // label): earlier groups scroll behind the left arrow.
    const groupStart = captionText ? this.list.findIndex((t) => t.group === current?.group) : -1;
    if (groupStart > win.start && this.active >= groupStart) {
      overflow = true;
      const rest = tabWindow(widths.slice(groupStart), this.active - groupStart, room - arrowW * 2);
      win = { start: groupStart + rest.start, end: groupStart + rest.end };
    }
    let x = rect.x + captionW + (overflow ? arrowW : 0);
    const tabs: TabView[] = [];
    for (let i = win.start; i <= win.end; i++) {
      const t = this.list[i] as TabSpec;
      const divider = i > win.start && t.group !== this.list[i - 1]?.group;
      if (divider) x += groupGap;
      const w = (widths[i] ?? 0) - (i > 0 && t.group !== this.list[i - 1]?.group ? groupGap : 0) - 1;
      const maxLabel = Math.max(0, rect.x + rect.w - (overflow ? arrowW : 0) - x - pad * 2 - badgeW(t));
      tabs.push({ index: i, x, w: Math.min(w, rect.x + rect.w - x), label: fitCell(labelOf(t), maxLabel, size), badge: t.badge ?? null, active: i === this.active, disabled: !!t.disabled, divider });
      x += w + 1;
    }
    const moreLeft = overflow && win.start > 0 ? { x: rect.x + captionW, y: rect.y, w: arrowW, h: rect.h } : null;
    const moreRight = overflow && win.end < this.list.length - 1 ? { x: rect.x + rect.w - arrowW, y: rect.y, w: arrowW, h: rect.h } : null;
    this.hits = { tabs: tabs.map((t) => ({ index: t.index, rect: { x: t.x, y: rect.y, w: t.w, h: rect.h } })), left: moreLeft, right: moreRight };
    return { rect, caption: captionText, tabs, moreLeft, moreRight };
  }
}

/** Lays out and draws the tab bar; returns its view-model. */
export const drawTabBar = (ctx: UiCtx, theme: Theme, bar: TabBar, rect: Rect): TabBarView => {
  const view = bar.layout(theme, rect);
  const c = theme.colors;
  const size = theme.textScale;
  const ty = rect.y + Math.floor((rect.h - theme.glyphH) / 2);
  const art = ctx as ArtCtx;
  ctx.fillStyle = c.bgAlt;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = UI_SLAB.bevel;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillStyle = c.panelBorder;
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  if (view.caption) drawText(ctx, view.caption, rect.x + theme.gap, ty, { color: c.textDim, size });
  for (const t of view.tabs) {
    if (t.divider) {
      ctx.fillStyle = c.panelBorder;
      ctx.fillRect(t.x - theme.gap - 1, rect.y + 2, 1, rect.h - 4);
    }
    if (t.active) {
      ctx.fillStyle = c.selection;
      ctx.fillRect(t.x, rect.y, t.w, rect.h);
      drawSelectionTrim(art, c.selection, c.accent, t.x, rect.y, t.w, rect.h - 2);
      ctx.fillStyle = c.accent;
      ctx.fillRect(t.x, rect.y + rect.h - 2, t.w, 2);
    }
    const color = t.disabled ? c.textDim : t.active ? c.accent : c.text;
    const m = drawText(ctx, t.label, t.x + theme.gap, ty, { color, size });
    if (t.badge) drawText(ctx, t.badge, t.x + theme.gap * 2 + m.width, ty, { color: c.warning, size });
  }
  if (view.moreLeft) drawText(ctx, '◀', view.moreLeft.x + 1, ty, { color: c.textDim, size });
  if (view.moreRight) drawText(ctx, '▶', view.moreRight.x + view.moreRight.w - 1, ty, { color: c.textDim, size, align: 'right' });
  return view;
};
