/**
 * Developer console overlay (developer mode only; the Game screen pushes it on devToggle). Left: a menu of cheats
 * (god mode, infinite stamina, freeze AI, fast-sim the drive), overlay toggles and engine commands (teleport the
 * controlled player to the cursor or the line, spawn the ball at him, force a touchdown or a turnover). Right: the
 * game-state inspector, paged with the tab buttons or left/right on its row. Commands close the console so the play
 * resumes and the result is visible; toggles keep it open. Every action goes through the DevController.
 */
import type { Vec2 } from '@/core/vec2';
import type { PlayState } from '@/game/play-types';
import type { GameState, TeamSide } from '@/game/types';
import type { DevController, FastSimSession } from '@/tools/dev-controller';
import { CHEAT_KEYS, CHEAT_LABELS, OVERLAY_KINDS, OVERLAY_LABELS, type CheatKey, type OverlayKind } from '@/tools/dev-state';
import { buildInspectorRows, paginate, type InspectorPage } from '@/tools/inspector';
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import type { Theme } from '../theme';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

/** What the console reads and drives; supplied by the Game screen. */
export interface DevConsoleContext {
  controller: DevController;
  /** Session driven by the fast-sim cheat. */
  session: FastSimSession;
  game: () => Readonly<GameState>;
  /** The play on screen (live or last finished), for the inspector. */
  play: () => PlayState | null;
  /** True while a live play accepts commands. */
  live: () => boolean;
  /** Remembered world point under the pointer (teleport target). */
  cursor: () => Vec2 | null;
  names?: Partial<Record<TeamSide, string>>;
}

/** Menu ids of the engine commands. */
export type DevCommandId = 'tpCursor' | 'tpLos' | 'spawnBall' | 'forceTd' | 'forceTurnover';

const COMMANDS: readonly { id: DevCommandId; label: string }[] = [
  { id: 'tpCursor', label: 'TELEPORT TO CURSOR' }, { id: 'tpLos', label: 'TELEPORT TO LOS' }, { id: 'spawnBall', label: 'SPAWN BALL AT PLAYER' },
  { id: 'forceTd', label: 'FORCE TOUCHDOWN' }, { id: 'forceTurnover', label: 'FORCE TURNOVER' },
];

const onOff = (on: boolean): string => (on ? 'ON' : 'OFF');

/** Trims `text` (adding '.') until it fits `maxW` pixels. */
const fit = (text: string, maxW: number, size: Theme['textScale']): string => {
  if (measureText(text, size).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && measureText(`${t}.`, size).width > maxW) t = t.slice(0, -1);
  return `${t}.`;
};

/** The developer console overlay screen. */
export class DevConsoleScreen implements Screen {
  readonly id = 'devConsole';
  readonly overlay = true;
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private page = 0;
  private pageSize = 8;

  constructor(private readonly ctx: DevConsoleContext) {
    this.menu = new MenuList(this.items(), { maxVisible: 12 });
  }

  get list(): MenuList {
    return this.menu;
  }

  /** The inspector page currently shown. */
  get inspectorPage(): InspectorPage {
    const c = this.ctx;
    const rows = buildInspectorRows(c.game(), c.play(), { names: c.names, pendingCommands: c.controller.pendingCommands });
    return paginate(rows, this.pageSize, this.page);
  }

  private commandEnabled(id: DevCommandId): boolean {
    const c = this.ctx;
    const play = c.play();
    if (!c.live() || !play || play.phase === 'dead') return false;
    if (id === 'tpCursor') return c.cursor() !== null && c.controller.controlledOf(play) !== null;
    if (id === 'tpLos' || id === 'spawnBall') return c.controller.controlledOf(play) !== null;
    return true;
  }

  private items(): MenuItem[] {
    const s = this.ctx.controller.state;
    const pg = this.inspectorPage;
    return [
      ...CHEAT_KEYS.map((k) => ({ id: `cheat:${k}`, label: CHEAT_LABELS[k], value: onOff(s.cheats[k]) })),
      ...OVERLAY_KINDS.map((k) => ({ id: `ovl:${k}`, label: `SHOW ${OVERLAY_LABELS[k]}`, value: onOff(s.overlays.has(k)) })),
      ...COMMANDS.map((c) => ({ id: c.id, label: c.label, disabled: !this.commandEnabled(c.id) })),
      { id: 'inspector', label: 'INSPECTOR PAGE', value: `${pg.page + 1}/${pg.pageCount}` },
      { id: 'close', label: 'CLOSE' },
    ];
  }

  private refresh(): void {
    this.menu.setItems(this.items());
  }

  /** Panel geometry for a canvas size. */
  private layout(theme: Theme, width: number, height: number): { top: number; leftW: number; panelH: number; rows: number } {
    const top = theme.pad;
    const panelH = height - theme.pad * 2 - theme.lineHeight;
    const leftW = Math.min(Math.round(width * 0.46), 220 * theme.textScale);
    // Title tab + border + gaps take roughly two rows of the panel.
    const rows = Math.max(3, Math.floor((panelH - theme.glyphH - theme.gap * 4 - theme.border * 2) / theme.lineHeight));
    return { top, leftW, panelH, rows };
  }

  /** Rebuilds the menu when the number of rows that fit changes (keeps the selection). */
  private fitMenu(rows: number): void {
    if (this.menu.maxVisible === rows) return;
    this.menu = new MenuList(this.items(), { maxVisible: rows, initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  enter(services: ScreenServices): void {
    this.services = services;
    if (!this.ctx.controller.enabled) {
      services.stack.pop();
      return;
    }
    this.fitMenu(this.layout(services.theme, services.width, services.height).rows);
    this.refresh();
  }

  exit(): void {
    this.services = null;
  }

  /** Moves the inspector by `delta` pages (clamped). */
  turnPage(delta: number): void {
    this.page = Math.max(0, Math.min(this.inspectorPage.pageCount - 1, this.page + delta));
    this.refresh();
  }

  private runCommand(id: DevCommandId): boolean {
    const c = this.ctx;
    const dev = c.controller;
    const play = c.play();
    switch (id) {
      case 'tpCursor': return dev.teleportControlled(play, c.cursor());
      case 'tpLos': return dev.teleportControlledToLos(play);
      case 'spawnBall': return dev.spawnBallAtControlled(play);
      case 'forceTd': return dev.forceTouchdown(play);
      case 'forceTurnover': return dev.forceTurnover(play);
    }
  }

  /** Runs a menu item (exported for tests and hardware shortcuts). */
  activate(id: string): void {
    const services = this.services;
    const dev = this.ctx.controller;
    if (id.startsWith('cheat:')) dev.toggleCheat(id.slice(6) as CheatKey, this.ctx.session);
    else if (id.startsWith('ovl:')) dev.toggleOverlay(id.slice(4) as OverlayKind);
    else if (id === 'inspector') {
      // Confirm steps forward and wraps back to the first page.
      const pg = this.inspectorPage;
      this.turnPage(pg.page + 1 >= pg.pageCount ? -pg.page : 1);
    }
    else if (id === 'close') services?.stack.pop();
    else if (COMMANDS.some((c) => c.id === id)) {
      const ok = this.commandEnabled(id as DevCommandId) && this.runCommand(id as DevCommandId);
      services?.toast(ok ? `DEV: ${id.toUpperCase()}` : 'DEV: NOT AVAILABLE NOW', 1.2);
      if (ok) {
        services?.stack.pop();
        return;
      }
    }
    if (this.services) this.refresh();
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (input.justPressed.has('devToggle') || input.justPressed.has('pause')) {
      services.stack.pop();
      return;
    }
    if (input.justPressed.has('menuTabLeft')) this.turnPage(-1);
    if (input.justPressed.has('menuTabRight')) this.turnPage(1);
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') services.stack.pop();
    else if (ev.type === 'activate') this.activate(ev.item.id);
    else if (ev.type === 'change') {
      if (ev.item.id === 'inspector') this.turnPage(ev.delta);
      else this.activate(ev.item.id);
    }
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.55;
    ctx.fillStyle = theme.colors.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const pad = theme.pad;
    const { top, leftW, panelH, rows } = this.layout(theme, width, height);
    this.fitMenu(rows);
    const menuPanel = drawPanel(ctx, theme, pad, top, leftW, panelH, { style: 'raised', title: 'DEV CONSOLE' });
    this.menu.draw(ctx, theme, menuPanel.x, menuPanel.y, menuPanel.w, { time: rc.time });
    const rightX = pad * 2 + leftW;
    const rightW = width - rightX - pad;
    if (rightW >= 80 * theme.textScale) {
      const insp = drawPanel(ctx, theme, rightX, top, rightW, panelH, { style: 'raised', title: 'INSPECTOR' });
      this.pageSize = Math.max(1, Math.floor(insp.h / theme.lineHeight) - 1);
      const pg = this.inspectorPage;
      const labelW = measureText('POSSESSION ', theme.textScale).width;
      pg.rows.forEach((r, i) => {
        const y = insp.y + i * theme.lineHeight;
        drawText(ctx, r.label, insp.x, y, { color: r.section === 'game' ? theme.colors.accent2 : theme.colors.success, size: theme.textScale });
        drawText(ctx, fit(r.value, insp.w - labelW, theme.textScale), insp.x + labelW, y, { color: theme.colors.text, size: theme.textScale });
      });
      drawText(ctx, `PAGE ${pg.page + 1}/${pg.pageCount}`, insp.x + insp.w, insp.y + insp.h - theme.glyphH, { color: theme.colors.textDim, size: theme.textScale, align: 'right' });
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'TOGGLE' },
      { glyph: input?.glyph('menuTabRight') ?? 'RB', label: 'PAGE' },
      { glyph: input?.glyph('back') ?? 'B', label: 'CLOSE' },
    ], width, height - pad - theme.glyphH);
  }
}
