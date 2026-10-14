/**
 * Franchise event detail (from the Inbox): title, date, the wrapped description and, while unresolved, the
 * event's choices (label + description). Choosing asks for confirmation, then resolveEvent applies the effects
 * and the League is committed. Opening an unread event marks it read. A "View player" entry opens the player the
 * event is about. Up/Down pick, Confirm / tap choose, Back closes.
 */
import { markEventRead, resolveEvent } from '@/franchise/events';
import type { FranchiseEvent } from '@/franchise/types';
import type { InputState } from '../../input/types';
import { drawText, wrapText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { MenuList, type MenuItem } from '../../widgets/menu';
import { drawHintBar, drawPanel } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { fitCell } from '../kit/data-table-view';
import { ConfirmDialog } from '../kit/dialogs';
import { toneColor } from '../kit/format';
import { eventStatus } from './home-model';
import { glyphOf, hintBarHeight, refitMenu, rowsThatFit } from './widgets';

/** Full-screen event detail. */
export class EventDetailScreen implements Screen {
  readonly id = 'franchise-event-detail';
  private services: ScreenServices | null = null;
  private menu: MenuList;

  constructor(private readonly fc: FranchiseContext, readonly eventId: string) {
    this.menu = new MenuList(this.items());
  }

  /** The event (null when it no longer exists). */
  event(): FranchiseEvent | null {
    return this.fc.league().events.find((e) => e.id === this.eventId) ?? null;
  }

  get list(): MenuList { return this.menu; }

  private items(): MenuItem[] {
    const e = this.event();
    if (!e) return [{ id: 'back', label: 'Back' }];
    const out: MenuItem[] = e.resolvedChoice === null ? e.choices.map((c) => ({ id: `choice:${c.id}`, label: c.label, subLabel: c.description })) : [];
    if (e.playerId) out.push({ id: 'player', label: 'View player' });
    out.push({ id: 'back', label: 'Back' });
    return out;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    const e = this.event();
    if (e && !e.read) this.fc.commit(markEventRead(this.fc.league(), e.id), 'edit');
  }

  exit(): void { this.services = null; }
  resume(): void { this.menu.setItems(this.items()); }

  /** Applies a choice immediately (no confirmation; the screen's own flow confirms first). */
  resolve(choiceId: string): boolean {
    const e = this.event();
    if (!e || e.resolvedChoice !== null) return false;
    try {
      this.fc.commit(resolveEvent(this.fc.league(), e.id, choiceId), 'edit');
    } catch (err) {
      this.fc.toast(err instanceof Error ? err.message : 'That choice is not available');
      return false;
    }
    const label = e.choices.find((c) => c.id === choiceId)?.label ?? choiceId;
    this.fc.toast(`Decision: ${label}`);
    this.menu.setItems(this.items());
    return true;
  }

  private close(): void {
    if (this.services?.stack.top === this) this.fc.pop();
  }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') return this.close();
    if (ev.type !== 'activate') return;
    const id = ev.item.id;
    if (id === 'back') this.close();
    else if (id === 'player') {
      const pid = this.event()?.playerId;
      if (pid) this.fc.openPlayer(pid);
    } else if (id.startsWith('choice:')) {
      const choiceId = id.slice(7);
      const choice = this.event()?.choices.find((c) => c.id === choiceId);
      if (!choice) return;
      this.fc.push(new ConfirmDialog(choice.label, choice.description, { yesLabel: 'Decide', noLabel: 'Not yet', onResult: (yes) => { if (yes) this.resolve(choiceId); } }));
    }
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const e = this.event();
    if (!e) {
      drawText(ctx, 'Event not found', width / 2, height / 2, { color: c.textDim, size, align: 'center' });
      return;
    }
    drawText(ctx, fitCell(e.title, width - theme.pad * 2, size), theme.pad, theme.pad, { size, color: c.accent, shadow: c.shadow });
    const st = eventStatus(e);
    drawText(ctx, fitCell(`${e.year}${e.week > 0 ? ` Week ${e.week}` : ''} - ${st.text}`, width - theme.pad * 2, size), theme.pad, theme.pad + theme.lineHeight, { size, color: toneColor(theme, st.tone) });
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    let y = theme.pad + theme.lineHeight * 2 + theme.gap;
    const menuRows = Math.min(this.menu.items.length, size > 1 ? 2 : 4);
    const rowH = this.menu.items.some((i) => i.subLabel) ? theme.lineHeight + theme.glyphH + 2 * size : theme.lineHeight;
    const menuH = menuRows * rowH + theme.border * 2 + theme.gap * 2;
    const lines = wrapText(e.description, width - theme.pad * 2, size);
    const room = Math.max(1, Math.floor((bottom - menuH - theme.gap - y) / theme.lineHeight));
    const shown = lines.length > room ? [...lines.slice(0, room - 1), fitCell(`${lines[room - 1] ?? ''} ...`, width - theme.pad * 2, size)] : lines;
    for (const line of shown) {
      drawText(ctx, line, theme.pad, y, { color: c.text, size });
      y += theme.lineHeight;
    }
    const panel = drawPanel(ctx, theme, theme.pad, bottom - menuH, width - theme.pad * 2, menuH, { style: 'raised' });
    this.menu = refitMenu(this.menu, Math.max(1, Math.min(menuRows, rowsThatFit(theme, panel.h, 1))));
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Choose' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }
}
