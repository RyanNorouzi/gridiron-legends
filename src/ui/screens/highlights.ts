/**
 * Highlights overlay: the current game's highlight reel (touchdowns, turnovers, long gains, sacks, big hits,
 * game winners) as a list; Confirm / a tap plays one in the replay screen, Back closes. Opened from the pause
 * menu.
 */
import type { Highlight } from '../game/highlights';
import type { InputState } from '../input/types';
import { drawText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface HighlightsOptions {
  highlights: () => readonly Highlight[];
  /** Plays one highlight (pushes the replay screen). */
  onPlay: (h: Highlight) => void;
}

export class HighlightsScreen implements Screen {
  readonly id = 'highlights';
  readonly overlay = true;
  private menu: MenuList;
  private services: ScreenServices | null = null;

  constructor(private readonly opts: HighlightsOptions) {
    this.menu = new MenuList(this.items(), { maxVisible: 6 });
  }

  get list(): MenuList {
    return this.menu;
  }

  private items(): MenuItem[] {
    const hs = this.opts.highlights();
    if (hs.length === 0) return [{ id: 'none', label: 'NO HIGHLIGHTS YET', disabled: true }, { id: 'close', label: 'CLOSE' }];
    return [...hs.map((h) => ({ id: h.id, label: h.title, subLabel: h.detail })), { id: 'close', label: 'CLOSE' }];
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.menu = new MenuList(this.items(), { maxVisible: services.theme.textScale > 1 ? 3 : 6 });
  }

  exit(): void {
    this.services = null;
  }

  /** Plays the highlight with `id` (or closes for 'close'). */
  activate(id: string, services: ScreenServices): void {
    if (id === 'close') {
      services.stack.pop();
      return;
    }
    const h = this.opts.highlights().find((x) => x.id === id);
    if (h) this.opts.onPlay(h);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (input.justPressed.has('pause')) {
      services.stack.pop();
      return;
    }
    const ev = this.menu.update(dt, input);
    if (ev?.type === 'activate') this.activate(ev.item.id, services);
    else if (ev?.type === 'back') services.stack.pop();
  }

  render(rc: RenderContext): void {
    const { ctx, width, height } = rc;
    const theme = this.services?.theme ?? rc.theme;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.7;
    ctx.fillStyle = theme.colors.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const hintH = theme.glyphH + 4 * theme.textScale;
    const panelW = Math.min(width - theme.pad * 2, 260 * theme.textScale);
    const panelH = Math.min(height - hintH - theme.pad * 3, this.menu.measure(theme) + theme.glyphH + theme.gap * 4 + theme.border * 2 + theme.pad);
    const x = Math.round((width - panelW) / 2);
    const y = Math.max(theme.pad, Math.round((height - hintH - panelH) / 2));
    const content = drawPanel(ctx, theme, x, y, panelW, panelH, { style: 'raised', title: 'HIGHLIGHTS' });
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const n = this.opts.highlights().length;
    if (n > 0) drawText(ctx, `${n} PLAY${n === 1 ? '' : 'S'}`, x + panelW - theme.pad, y + theme.gap, { color: theme.colors.textDim, size: theme.textScale, align: 'right' });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'WATCH' },
      { glyph: input?.glyph('back') ?? 'B', label: 'CLOSE' },
    ], width, height - hintH - theme.pad);
  }
}
