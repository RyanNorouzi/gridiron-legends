/**
 * Watch-mode overlays: a generic modal PromptScreen (title, lines, a short choice list) used for the
 * "3rd & 7 — Jump in? YES / SIMULATE" prompt as well as coin toss, penalty and free-kick decisions, plus the
 * 'DEFENSE SIMULATING…' status pill and sim-speed badge the Game screen draws while plays auto-run.
 */
import type { InputState } from '../input/types';
import { drawText, measureText, wrapSegments } from '../render/text';
import type { Theme } from '../theme';
import { MenuList } from '../widgets/menu';
import { drawHintBar, drawPanel, type UiCtx } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface PromptChoice {
  id: string;
  label: string;
  detail?: string;
}

export interface PromptOptions {
  title: string;
  lines?: string[];
  choices: PromptChoice[];
  onChoose: (id: string) => void;
  /** Seconds left, drawn as a countdown when provided; when it reaches 0 `timeoutChoice` is chosen. */
  countdown?: () => number | null;
  timeoutChoice?: string;
  /** Seconds this prompt waits on its own before taking `timeoutChoice` (a self-driven countdown, shown like
   *  `countdown`); lets an unattended watch-mode game keep going. */
  timeoutSeconds?: number;
  /** Choice taken when the user presses back (none = back is ignored). */
  backChoice?: string;
  /** Tone colour of the title (defaults to the accent). */
  tone?: 'accent' | 'warning' | 'danger' | 'success';
}

/** Modal choice dialog; pops itself before invoking the callback. */
export class PromptScreen implements Screen {
  readonly id = 'prompt';
  readonly overlay = true;
  private readonly menu: MenuList;
  private services: ScreenServices | null = null;
  private answered = false;
  private selfRemaining: number | null;

  constructor(private readonly opts: PromptOptions) {
    this.menu = new MenuList(opts.choices.map((c) => ({ id: c.id, label: c.label, subLabel: c.detail })));
    this.selfRemaining = opts.timeoutSeconds ?? null;
  }

  /** Seconds left before the timeout choice is taken (null when the prompt waits forever). */
  get remaining(): number | null {
    return this.opts.countdown?.() ?? this.selfRemaining;
  }

  get list(): MenuList {
    return this.menu;
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  /** Answers with a choice id (pops this screen first so the callback can push another). */
  choose(id: string): void {
    if (this.answered) return;
    this.answered = true;
    const services = this.services;
    if (services && services.stack.top === this) services.stack.pop();
    services?.audio?.onGameEvent({ type: 'menuSelect' });
    this.opts.onChoose(id);
  }

  update(dt: number, input: InputState): void {
    if (this.selfRemaining !== null) this.selfRemaining -= dt;
    const remaining = this.remaining;
    if (remaining !== null && remaining <= 0 && this.opts.timeoutChoice) {
      this.choose(this.opts.timeoutChoice);
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'activate') this.choose(ev.item.id);
    else if (ev.type === 'back' && this.opts.backChoice) this.choose(this.opts.backChoice);
    else if (ev.type === 'select') this.services?.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.55;
    ctx.fillStyle = c.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const s = theme.textScale;
    const panelW = Math.min(width - theme.pad * 2, 240 * s);
    const lines = (this.opts.lines ?? []).flatMap((l) => wrapSegments(l, panelW - theme.pad * 4, s));
    const lineH = theme.glyphH + theme.gap;
    const listH = this.menu.measure(theme);
    const panelH = theme.border * 2 + theme.gap * 3 + theme.glyphH + lines.length * lineH + listH + theme.pad * 2 + (this.remaining !== null ? lineH : 0);
    const x = Math.round((width - panelW) / 2);
    const y = Math.round((height - panelH) / 2);
    const content = drawPanel(ctx, theme, x, y, panelW, panelH, { style: 'raised' });
    const tone = this.opts.tone ?? 'accent';
    const titleColor = tone === 'warning' ? c.warning : tone === 'danger' ? c.danger : tone === 'success' ? c.success : c.accent;
    drawText(ctx, this.opts.title, width / 2, content.y, { color: titleColor, size: s, align: 'center', shadow: c.shadow });
    let ly = content.y + theme.glyphH + theme.gap;
    for (const line of lines) {
      drawText(ctx, line, width / 2, ly, { color: c.text, size: s, align: 'center' });
      ly += lineH;
    }
    const remaining = this.remaining;
    if (remaining !== null) {
      drawText(ctx, `${Math.max(0, Math.ceil(remaining))}s`, width / 2, ly, { color: remaining <= 3 ? c.danger : c.textDim, size: s, align: 'center' });
      ly += lineH;
    }
    this.menu.draw(ctx, theme, content.x, ly + theme.gap, content.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [{ glyph: input?.glyph('confirm') ?? 'A', label: 'CHOOSE' }], width, y + panelH + theme.gap, 'right', { backdrop: true });
  }
}

/** Status pill ("DEFENSE SIMULATING…") centred at `y` with animated dots unless motion is reduced. */
export const drawWatchStatus = (ctx: UiCtx, theme: Theme, text: string, width: number, y: number, time: number): void => {
  const dots = theme.reducedMotion ? '…' : '.'.repeat(1 + (Math.floor(time * 2) % 3));
  const label = `${text}${dots}`;
  const s = theme.textScale;
  const m = measureText(label, s);
  const w = m.width + theme.pad * 2;
  const x = Math.round((width - w) / 2);
  ctx.fillStyle = theme.colors.shadow;
  ctx.fillRect(x, Math.round(y) - theme.gap, w, m.height + theme.gap * 2);
  ctx.fillStyle = theme.colors.accent2;
  ctx.fillRect(x, Math.round(y) - theme.gap, w, 1);
  drawText(ctx, label, width / 2, y, { color: theme.colors.text, size: s, align: 'center' });
};

/** Sim-speed badge ("x4") in the top-right corner. */
export const drawSpeedBadge = (ctx: UiCtx, theme: Theme, speed: number, width: number): void => {
  const label = `x${speed}`;
  const s = theme.textScale;
  const m = measureText(label, s);
  const x = width - theme.pad - m.width - theme.gap * 2;
  ctx.fillStyle = theme.colors.shadow;
  ctx.fillRect(x, theme.pad, m.width + theme.gap * 2, m.height + theme.gap);
  drawText(ctx, label, x + theme.gap, theme.pad + Math.round(theme.gap / 2), { color: speed > 1 ? theme.colors.accent : theme.colors.textDim, size: s });
};
