/**
 * Pause overlay: resume, replay the last play (when a recording exists), the game's highlights, call a timeout (when allowed),
 * manual substitutions,
 * open settings, and quit to the main menu (asks once more). The Game screen supplies the callbacks so the
 * overlay stays free of session knowledge.
 */
import type { InputState } from '../input/types';
import { drawText, fitLines } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawSlab, type ArtCtx } from '../widgets/ui-art';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface PauseActions {
  /** Whether a replay of the last play is available right now. */
  hasReplay: () => boolean;
  onReplay: () => void;
  /** Whether the user can call a timeout right now. */
  canTimeout: () => boolean;
  /** Returns false when the controller refused (no timeouts / bad phase). */
  onTimeout: () => boolean;
  onSettings: () => void;
  onQuit: () => void;
  /** Warning shown while quit awaits its second press (default: the unsaved-game warning). */
  quitWarning?: string;
  /** The game's highlight reel (optional). */
  hasHighlights?: () => boolean;
  onHighlights?: () => void;
  /** Manual substitutions (omitted when the user has no team on the field). */
  onSubstitutions?: () => void;
  /** Watch-mode extras: resume spectating / jump in. Omitted when not applicable. */
  onToggleWatch?: () => void;
  watchLabel?: () => string;
}

export type PauseItemId = 'resume' | 'replay' | 'highlights' | 'timeout' | 'subs' | 'watch' | 'settings' | 'quit';

export class PauseScreen implements Screen {
  readonly id = 'pause';
  readonly overlay = true;
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private confirmQuit = false;

  constructor(private readonly actions: PauseActions) {
    this.menu = new MenuList(this.items());
  }

  get list(): MenuList {
    return this.menu;
  }

  /** The warning shown above the panel while quit awaits its second press, else null. */
  get warning(): string | null {
    return this.confirmQuit ? (this.actions.quitWarning ?? 'UNSAVED GAME WILL BE LOST').toUpperCase() : null;
  }

  private items(): MenuItem[] {
    const a = this.actions;
    const items: MenuItem[] = [
      { id: 'resume', label: 'RESUME' },
      { id: 'replay', label: 'REPLAY LAST PLAY', disabled: !a.hasReplay() },
      ...(a.onHighlights ? [{ id: 'highlights', label: 'HIGHLIGHTS', disabled: !(a.hasHighlights?.() ?? true) }] : []),
      { id: 'timeout', label: 'CALL TIMEOUT', disabled: !a.canTimeout() },
      ...(a.onSubstitutions ? [{ id: 'subs', label: 'SUBSTITUTIONS' }] : []),
    ];
    if (a.onToggleWatch) items.push({ id: 'watch', label: a.watchLabel?.() ?? 'WATCH MODE' });
    items.push({ id: 'settings', label: 'SETTINGS' }, { id: 'quit', label: this.confirmQuit ? 'QUIT? PRESS AGAIN' : 'QUIT TO MENU' });
    return items;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.menu.setItems(this.items());
  }

  exit(): void {
    this.services = null;
  }

  resume(): void {
    this.confirmQuit = false;
    this.menu.setItems(this.items());
  }

  /** Runs an item; exported for tests and for hardware pause buttons. */
  activate(id: PauseItemId): void {
    const services = this.services;
    const a = this.actions;
    if (id !== 'quit') this.confirmQuit = false;
    switch (id) {
      case 'resume':
        services?.stack.pop();
        break;
      case 'replay':
        if (a.hasReplay()) {
          services?.stack.pop();
          a.onReplay();
        }
        break;
      case 'highlights':
        if (a.hasHighlights?.() ?? true) a.onHighlights?.();
        break;
      case 'timeout':
        if (a.canTimeout() && a.onTimeout()) services?.stack.pop();
        else services?.toast('No timeout available');
        break;
      case 'subs':
        a.onSubstitutions?.();
        break;
      case 'watch':
        services?.stack.pop();
        a.onToggleWatch?.();
        break;
      case 'settings':
        a.onSettings();
        break;
      case 'quit':
        if (this.confirmQuit) {
          services?.stack.pop();
          a.onQuit();
        } else {
          this.confirmQuit = true;
          this.menu.setItems(this.items());
        }
        break;
    }
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (input.justPressed.has('pause')) {
      services.stack.pop();
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'activate') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      this.activate(ev.item.id as PauseItemId);
    } else if (ev.type === 'back') {
      services.audio?.onGameEvent({ type: 'menuBack' });
      services.stack.pop();
    } else if (ev.type === 'select') {
      this.confirmQuit = false;
      this.menu.setItems(this.items());
      services.audio?.onGameEvent({ type: 'menuMove' });
    }
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.6;
    ctx.fillStyle = theme.colors.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const panelW = Math.min(width - theme.pad * 2, 180 * theme.textScale);
    // The quit warning sits inside the panel (drawn over the dimmed play list it was unreadable).
    const warning = this.warning;
    const warnLines = warning ? fitLines(warning, panelW - theme.pad * 2 - theme.border * 2, 2, theme.textScale) : [];
    const warnH = warnLines.length * theme.lineHeight + (warnLines.length > 0 ? theme.gap : 0);
    const panelH = this.menu.measure(theme) + theme.glyphH + theme.gap * 4 + theme.border * 2 + theme.pad + warnH;
    const x = Math.round((width - panelW) / 2);
    const y = Math.round((height - panelH) / 2);
    const content = drawPanel(ctx, theme, x, y, panelW, panelH, { style: 'raised', title: 'PAUSED' });
    warnLines.forEach((line, i) => drawText(ctx, line, content.x + content.w / 2, content.y + i * theme.lineHeight, { color: theme.colors.danger, size: theme.textScale, align: 'center' }));
    this.menu.draw(ctx, theme, content.x, content.y + warnH, content.w, { time: rc.time });
    // A screen opened from the menu (substitutions, settings) draws its own hints: ours would show through.
    if (this.services && this.services.stack.top !== this) return;
    const input = this.services?.input;
    // Own hint strip along the bottom edge (over the dimmed screen's hints), never over the scene under the panel.
    const hintH = theme.glyphH + 4 * theme.textScale;
    const hintY = height - hintH - theme.pad;
    drawSlab(ctx as ArtCtx, 0, hintY - 1, width, height - hintY + 1, { fill: theme.colors.bg, texture: false });
    drawHintBar(ctx, theme, [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'SELECT' },
      { glyph: input?.glyph('pause') ?? 'START', label: 'RESUME' },
    ], width, hintY);
  }
}
