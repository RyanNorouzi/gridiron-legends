/**
 * Modal dialogs for franchise screens, pushed as overlay Screens. Each pops itself BEFORE invoking its
 * callback, so the callback may push another screen.
 * - ConfirmDialog: yes/no. Confirm picks the highlighted option; Back = "no".
 * - ChoiceDialog: pick one of several options (disabled options are skipped); Back = null.
 * - StepperDialog: one or more numeric fields (contract salary/years, ticket price...). Up/Down focus a field,
 *   Left/Right step it (hold to repeat), U/O (menuTabLeft/Right) take the big step, Confirm submits when
 *   valid, Back cancels. Touch/mouse: tap ◀ / ▶ beside a field, or the OK / CANCEL buttons.
 * - TextEntryDialog: on-screen letter grid. D-pad moves, Confirm presses the key, X (secondary) deletes,
 *   Start (pause) submits, Back deletes or cancels when empty. Touch/mouse: tap keys; CANCEL button.
 */
import type { InputState } from '../../input/types';
import { drawText, measureText, wrapText } from '../../render/text';
import type { Theme } from '../../theme';
import { MenuList, type MenuItem } from '../../widgets/menu';
import { drawPanel, type ContentRect, type UiCtx } from '../../widgets/panel';
import { UI_SLAB, lighten } from '../../render/palette';
import { drawSelectionTrim } from '../../widgets/menu';
import type { ArtCtx } from '../../widgets/ui-art';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { fitCell } from './data-table-view';
import { LetterGridModel, StepperModel, type LetterGridOptions, type StepperSpec } from './dialog-models';
import { DOWN_ACTIONS, LEFT_ACTIONS, RIGHT_ACTIONS, RepeatAxis, SECONDARY_ACTIONS, UP_ACTIONS, inRect, pressed, type Rect } from './list';

/** Shared overlay behaviour: services capture, self-pop, dimmed backdrop and a centred panel. */
abstract class DialogBase implements Screen {
  abstract readonly id: string;
  readonly overlay = true;
  protected services: ScreenServices | null = null;
  protected closed = false;

  constructor(readonly title: string, readonly message: string) {}

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  abstract update(dt: number, input: InputState, services: ScreenServices): void;
  abstract render(rc: RenderContext): void;

  /** Pops this dialog if it is on top; returns false when it was already closed. */
  protected close(): boolean {
    if (this.closed) return false;
    this.closed = true;
    const s = this.services;
    if (s && s.stack.top === this) s.stack.pop();
    return true;
  }

  protected themeOf(rc: RenderContext): Theme {
    return this.services?.theme ?? rc.theme;
  }

  /** Backdrop + panel of `bodyH` content height; returns the content rect below the wrapped message. */
  protected frame(rc: RenderContext, bodyH: number, width = 300): { content: ContentRect; body: Rect } {
    const theme = this.themeOf(rc);
    const { ctx } = rc;
    const w = Math.min(rc.width - theme.pad * 2, Math.max(width, measureText(this.title, theme.textScale).width + theme.pad * 4));
    const lines = this.message ? wrapText(this.message, w - theme.pad * 2 - theme.border * 2, theme.textScale) : [];
    const msgH = lines.length * theme.lineHeight;
    const h = Math.min(rc.height - theme.pad, msgH + bodyH + theme.lineHeight + theme.pad * 2 + theme.gap * 2);
    const x = Math.round((rc.width - w) / 2);
    const y = Math.round((rc.height - h) / 2);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.6;
    ctx.fillStyle = theme.colors.overlay;
    ctx.fillRect(0, 0, rc.width, rc.height);
    ctx.globalAlpha = prev;
    const content = drawPanel(ctx, theme, x, y, w, h, { title: this.title, style: 'raised', border: theme.colors.accent });
    lines.forEach((line, i) => drawText(ctx, line, content.x, content.y + i * theme.lineHeight, { color: theme.colors.text, size: theme.textScale }));
    return { content, body: { x: content.x, y: content.y + msgH + theme.gap, w: content.w, h: Math.max(0, content.h - msgH - theme.gap) } };
  }
}

/* --------------------------------- confirm --------------------------------- */

/** Options for ConfirmDialog. */
export interface ConfirmOptions {
  yesLabel?: string;
  noLabel?: string;
  /** Start on "no" (for destructive actions). */
  defaultNo?: boolean;
  onResult(confirmed: boolean): void;
}

/** Yes/no confirmation. */
export class ConfirmDialog extends DialogBase {
  readonly id = 'franchise-confirm';
  readonly list: MenuList;

  constructor(title: string, message: string, private readonly opts: ConfirmOptions) {
    super(title, message);
    this.list = new MenuList([{ id: 'yes', label: opts.yesLabel ?? 'Yes' }, { id: 'no', label: opts.noLabel ?? 'No' }], { initialIndex: opts.defaultNo ? 1 : 0 });
  }

  /** Resolves the dialog (exported for tests and scripted flows). */
  choose(confirmed: boolean): void {
    if (this.close()) this.opts.onResult(confirmed);
  }

  update(dt: number, input: InputState): void {
    const ev = this.list.update(dt, input);
    if (ev?.type === 'activate') this.choose(ev.item.id === 'yes');
    else if (ev?.type === 'back') this.choose(false);
  }

  render(rc: RenderContext): void {
    const theme = this.themeOf(rc);
    const { body } = this.frame(rc, this.list.measure(theme));
    this.list.draw(rc.ctx, theme, body.x, body.y, body.w, { time: rc.time });
  }
}

/* --------------------------------- choice --------------------------------- */

/** One option of a ChoiceDialog. */
export interface ChoiceOption {
  id: string;
  label: string;
  subLabel?: string;
  disabled?: boolean;
}

/** Pick one of several options; null when cancelled. */
export class ChoiceDialog extends DialogBase {
  readonly id = 'franchise-choice';
  readonly list: MenuList;

  constructor(title: string, message: string, choices: readonly ChoiceOption[], private readonly onResult: (id: string | null) => void, opts: { maxVisible?: number } = {}) {
    super(title, message);
    const items: MenuItem[] = choices.map((c) => ({ ...c }));
    this.list = new MenuList(items, { maxVisible: opts.maxVisible ?? 6 });
  }

  choose(id: string | null): void {
    if (this.close()) this.onResult(id);
  }

  update(dt: number, input: InputState): void {
    const ev = this.list.update(dt, input);
    if (ev?.type === 'activate' && !ev.item.disabled) this.choose(ev.item.id);
    else if (ev?.type === 'back') this.choose(null);
  }

  render(rc: RenderContext): void {
    const theme = this.themeOf(rc);
    // Large text widens the dialog (up to the screen) so option labels and their sub-labels keep their words.
    const { body } = this.frame(rc, this.list.measure(theme), 320 * theme.textScale);
    this.list.draw(rc.ctx, theme, body.x, body.y, body.w, { time: rc.time });
  }
}

/* --------------------------------- stepper --------------------------------- */

/** Options for StepperDialog. */
export interface StepperDialogOptions {
  /** Summary line under the fields (e.g. the contract summary). */
  summary?(values: Record<string, number>): string;
  /** Error text blocks submission; null when valid. */
  validate?(values: Record<string, number>): string | null;
  confirmLabel?: string;
  onResult(values: Record<string, number> | null): void;
}

/** Pointer targets of a laid-out stepper dialog. */
export interface StepperHits {
  fields: { index: number; row: Rect; minus: Rect; plus: Rect }[];
  ok: Rect;
  cancel: Rect;
}

/** Numeric entry for one or more fields. */
export class StepperDialog extends DialogBase {
  readonly id = 'franchise-stepper';
  readonly model: StepperModel;
  private readonly vertical = new RepeatAxis(UP_ACTIONS, DOWN_ACTIONS, 'y');
  private readonly horizontal = new RepeatAxis(LEFT_ACTIONS, RIGHT_ACTIONS, 'x', 0.3, 0.06);
  private hits: StepperHits | null = null;

  constructor(title: string, message: string, fields: readonly StepperSpec[], private readonly opts: StepperDialogOptions) {
    super(title, message);
    this.model = new StepperModel(fields);
  }

  get error(): string | null { return this.opts.validate?.(this.model.values()) ?? null; }
  get summary(): string | null { return this.opts.summary?.(this.model.values()) ?? null; }
  get hitMap(): StepperHits | null { return this.hits; }

  /** Submits when valid; returns false (and toasts the error) otherwise. */
  submit(): boolean {
    const err = this.error;
    if (err) {
      this.services?.toast(err);
      return false;
    }
    if (this.close()) this.opts.onResult(this.model.values());
    return true;
  }

  cancel(): void {
    if (this.close()) this.opts.onResult(null);
  }

  update(dt: number, input: InputState): void {
    const dy = this.vertical.step(dt, input);
    if (dy !== 0) this.model.moveFocus(dy);
    const dx = this.horizontal.step(dt, input);
    if (dx !== 0) this.model.step(dx);
    if (pressed(input, ['menuTabLeft'])) this.model.step(-1, true);
    if (pressed(input, ['menuTabRight'])) this.model.step(1, true);
    const p = input.pointer;
    if (p?.justDown && this.hits) {
      if (inRect(this.hits.ok, p.x, p.y)) return void this.submit();
      if (inRect(this.hits.cancel, p.x, p.y)) return this.cancel();
      for (const f of this.hits.fields) {
        if (inRect(f.minus, p.x, p.y) || inRect(f.plus, p.x, p.y)) {
          this.model.setFocus(f.index);
          this.model.step(inRect(f.minus, p.x, p.y) ? -1 : 1);
          return;
        }
        if (inRect(f.row, p.x, p.y)) this.model.setFocus(f.index);
      }
    }
    if (pressed(input, ['confirm'])) this.submit();
    else if (pressed(input, ['back'])) this.cancel();
  }

  render(rc: RenderContext): void {
    const theme = this.themeOf(rc);
    const size = theme.textScale;
    const c = theme.colors;
    const lh = theme.lineHeight;
    const n = this.model.specs.length;
    const { body } = this.frame(rc, (n + 3) * lh, 320);
    const ctx = rc.ctx;
    const arrowW = measureText('◀', size).width + theme.gap * 2;
    const valueW = Math.max(...this.model.specs.map((_, i) => measureText(this.model.display(i), size).width), measureText('00000', size).width);
    const fields: StepperHits['fields'] = [];
    this.model.specs.forEach((spec, i) => {
      const y = body.y + i * lh;
      const focused = i === this.model.focus;
      if (focused) {
        ctx.fillStyle = c.selection;
        ctx.fillRect(body.x, y, body.w, lh);
        drawSelectionTrim(ctx as ArtCtx, c.selection, c.accent, body.x, y, body.w, lh);
      }
      const ty = y + Math.floor((lh - theme.glyphH) / 2);
      const right = body.x + body.w;
      const plus = { x: right - arrowW, y, w: arrowW, h: lh };
      const minus = { x: right - arrowW * 2 - valueW - theme.gap * 2, y, w: arrowW, h: lh };
      drawText(ctx, fitCell(spec.label, minus.x - body.x - theme.gap * 2, size), body.x + theme.gap, ty, { color: focused ? c.accent : c.text, size });
      drawText(ctx, '◀', minus.x + theme.gap, ty, { color: this.model.atMin(i) ? c.textDim : c.text, size });
      drawText(ctx, this.model.display(i), minus.x + arrowW + theme.gap + valueW, ty, { color: focused ? c.accent : c.text, size, align: 'right' });
      drawText(ctx, '▶', plus.x + theme.gap, ty, { color: this.model.atMax(i) ? c.textDim : c.text, size });
      fields.push({ index: i, row: { x: body.x, y, w: body.w, h: lh }, minus, plus });
    });
    let y = body.y + n * lh + theme.gap;
    const summary = this.summary;
    if (summary) drawText(ctx, fitCell(summary, body.w, size), body.x, y, { color: c.accent2, size });
    y += lh;
    const err = this.error;
    if (err) drawText(ctx, fitCell(err, body.w, size), body.x, y, { color: c.warning, size });
    y += lh;
    const okLabel = this.opts.confirmLabel ?? 'OK';
    const okW = measureText(okLabel, size).width + theme.pad * 2;
    const cancelW = measureText('CANCEL', size).width + theme.pad * 2;
    const ok = { x: body.x + body.w - okW, y, w: okW, h: lh };
    const cancel = { x: ok.x - theme.gap * 2 - cancelW, y, w: cancelW, h: lh };
    drawButton(ctx, theme, ok, okLabel, !err);
    drawButton(ctx, theme, cancel, 'CANCEL', true);
    this.hits = { fields, ok, cancel };
  }
}

const drawButton = (ctx: UiCtx, theme: Theme, r: Rect, label: string, enabled: boolean): void => {
  ctx.fillStyle = enabled ? theme.colors.panelLight : theme.colors.bgAlt;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = lighten(enabled ? theme.colors.panelLight : theme.colors.bgAlt, 0.25);
  ctx.fillRect(r.x, r.y, r.w, 1);
  ctx.fillStyle = theme.colors.panelBorder;
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  drawText(ctx, label, r.x + r.w / 2, r.y + Math.floor((r.h - theme.glyphH) / 2), { color: enabled ? theme.colors.text : theme.colors.textDim, size: theme.textScale, align: 'center' });
};

/* ------------------------------- text entry ------------------------------- */

/** Key rectangles of a letter grid inside `rect` (rows centred). Pure. */
export const letterGridLayout = (model: LetterGridModel, theme: Theme, rect: Rect): { row: number; col: number; key: string; rect: Rect }[] => {
  const size = theme.textScale;
  const cell = measureText('W', size).width + theme.gap * 2;
  const keyW = (k: string): number => (k.length > 1 ? measureText(k, size).width + theme.gap * 2 : cell);
  const out: { row: number; col: number; key: string; rect: Rect }[] = [];
  model.keys.forEach((row, r) => {
    const widths = row.map(keyW);
    const total = widths.reduce((a, b) => a + b, 0) + (row.length - 1);
    let x = Math.round(rect.x + (rect.w - total) / 2);
    row.forEach((key, c) => {
      out.push({ row: r, col: c, key, rect: { x, y: rect.y + r * theme.lineHeight, w: widths[c] ?? cell, h: theme.lineHeight - 1 } });
      x += (widths[c] ?? cell) + 1;
    });
  });
  return out;
};

/** `text` fitted to `width` by dropping its START ("...LES_"), so the end being typed stays in view. */
export const fitTail = (text: string, width: number, size: Theme['textScale']): string => {
  if (measureText(text, size).width <= width) return text;
  for (let i = 1; i < text.length; i++) {
    const t = `...${text.slice(i)}`;
    if (measureText(t, size).width <= width) return t;
  }
  return '';
};

/** Text entry through an on-screen letter grid or the physical keyboard; null when cancelled. */
export class TextEntryDialog extends DialogBase {
  readonly id = 'franchise-text-entry';
  readonly model: LetterGridModel;
  private readonly vertical = new RepeatAxis(UP_ACTIONS, DOWN_ACTIONS, 'y');
  private readonly horizontal = new RepeatAxis(LEFT_ACTIONS, RIGHT_ACTIONS, 'x');
  private keyRects: ReturnType<typeof letterGridLayout> = [];
  private cancelRect: Rect | null = null;

  constructor(title: string, message: string, grid: LetterGridOptions, private readonly onResult: (text: string | null) => void) {
    super(title, message);
    this.model = new LetterGridModel(grid);
  }

  /** Key rectangles from the last render. */
  get keys(): readonly { row: number; col: number; key: string; rect: Rect }[] { return this.keyRects; }
  get cancelButton(): Rect | null { return this.cancelRect; }

  submit(): boolean {
    const err = this.model.error;
    if (err) {
      this.services?.toast(err);
      return false;
    }
    if (this.close()) this.onResult(this.model.result());
    return true;
  }

  cancel(): void {
    if (this.close()) this.onResult(null);
  }

  private pressKey(): void {
    const r = this.model.press();
    if (r === 'submit') this.submit();
    else if (r === 'invalid') this.services?.toast(this.model.error ?? 'Invalid');
  }

  /**
   * Physical-keyboard typing: characters go straight into the text, Backspace deletes, Enter submits and only
   * Escape cancels. A tick with typed text ignores the key's game bindings (L, J, I... are letters here).
   */
  typeText(text: readonly string[]): void {
    for (const ch of text) {
      if (ch === '\b') this.model.backspace();
      else if (ch === '\n') { this.submit(); return; }
      else if (ch === '\x1b') { this.cancel(); return; }
      else if (!this.model.type(ch)) this.services?.toast(this.model.text.length >= this.model.maxLength ? 'Name is full' : `"${ch}" is not allowed`);
    }
  }

  update(dt: number, input: InputState): void {
    if (input.text && input.text.length > 0) return this.typeText(input.text);
    const dy = this.vertical.step(dt, input);
    const dx = this.horizontal.step(dt, input);
    if (dx !== 0 || dy !== 0) this.model.move(dx, dy);
    const p = input.pointer;
    if (p?.justDown) {
      if (this.cancelRect && inRect(this.cancelRect, p.x, p.y)) return this.cancel();
      const hit = this.keyRects.find((k) => inRect(k.rect, p.x, p.y));
      if (hit) {
        this.model.focus(hit.row, hit.col);
        return this.pressKey();
      }
    }
    if (pressed(input, ['confirm'])) this.pressKey();
    else if (pressed(input, SECONDARY_ACTIONS)) this.model.backspace();
    else if (pressed(input, ['pause'])) this.submit();
    else if (pressed(input, ['back']) && !this.model.backspace()) this.cancel();
  }

  render(rc: RenderContext): void {
    const theme = this.themeOf(rc);
    const size = theme.textScale;
    const c = theme.colors;
    const lh = theme.lineHeight;
    const ctx = rc.ctx;
    const rows = this.model.keys.length;
    const { body } = this.frame(rc, (rows + 3) * lh, 340);
    const blink = theme.reducedMotion || Math.floor(rc.time * 2) % 2 === 0;
    const shown = `${this.model.text}${blink && this.model.text.length < this.model.maxLength ? '_' : ''}`;
    ctx.fillStyle = c.bg;
    ctx.fillRect(body.x, body.y, body.w, lh);
    // The counter keeps its corner; the text gets the rest (large text used to draw one over the other).
    const counter = `${this.model.text.length}/${this.model.maxLength}`;
    const textRoom = body.w - theme.gap * 4 - measureText(counter, size).width;
    drawText(ctx, fitTail(shown, textRoom, size), body.x + theme.gap, body.y + Math.floor((lh - theme.glyphH) / 2), { color: c.text, size });
    drawText(ctx, counter, body.x + body.w - theme.gap, body.y + Math.floor((lh - theme.glyphH) / 2), { color: c.textDim, size, align: 'right' });
    this.keyRects = letterGridLayout(this.model, theme, { x: body.x, y: body.y + lh + theme.gap, w: body.w, h: rows * lh });
    for (const k of this.keyRects) {
      const focused = k.row === this.model.row && k.col === this.model.col;
      const face = focused ? c.selection : c.panelLight;
      ctx.fillStyle = face;
      ctx.fillRect(k.rect.x, k.rect.y, k.rect.w, k.rect.h);
      // Keycap lighting: bright top art row, dark foot, a gold underline on the focused key.
      ctx.fillStyle = lighten(face, 0.28);
      ctx.fillRect(k.rect.x, k.rect.y, k.rect.w, 1);
      ctx.fillStyle = focused ? c.accent : UI_SLAB.edge;
      ctx.fillRect(k.rect.x, k.rect.y + k.rect.h - 1, k.rect.w, 1);
      const disabled = k.key === 'OK' && !this.model.canSubmit;
      drawText(ctx, k.key, k.rect.x + k.rect.w / 2, k.rect.y + Math.floor((k.rect.h - theme.glyphH) / 2), { color: focused ? c.accent : disabled ? c.textDim : c.text, size, align: 'center' });
    }
    const y = body.y + lh + theme.gap + rows * lh + theme.gap;
    const err = this.model.error;
    if (err) drawText(ctx, fitCell(err, body.w / 2, size), body.x, y, { color: c.warning, size });
    const cancelW = measureText('CANCEL', size).width + theme.pad * 2;
    this.cancelRect = { x: body.x + body.w - cancelW, y, w: cancelW, h: lh };
    drawButton(ctx, theme, this.cancelRect, 'CANCEL', true);
  }
}
