/**
 * Substitutions screen (pause menu): one row per formation role the user's team fields, showing who plays there
 * (the manual sub, or AUTO = the depth chart / fatigue rotation) with his remaining energy. Left / right (or
 * confirm) steps through AUTO and then the healthy players who can take the role, and sends the choice in from
 * the next snap; stepping back onto AUTO removes the manual override.
 */
import type { PlayerId } from '@/core/ids';
import type { Player } from '@/players/types';
import { AUTO_SUB, depthStarter, playerSubLabel, roleSlotIndex, sendSubstitution, substitutionCandidates, substitutionRoles, type SubRole } from '../game/substitutions';
import type { GameSession } from '../game/session-types';
import type { InputState } from '../input/types';
import { drawText, fitLines } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

export class SubstitutionsScreen implements Screen {
  readonly id = 'substitutions';
  readonly overlay = true;
  private readonly roles: SubRole[];
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private rowsShown = 0;

  constructor(private readonly session: GameSession) {
    const side = session.userSide;
    this.roles = side ? substitutionRoles(session.setup, side, session.registry) : [];
    this.menu = new MenuList(this.items());
  }

  get list(): MenuList {
    return this.menu;
  }

  private subs(): Readonly<Record<string, PlayerId>> {
    return this.session.userSubstitutions?.() ?? {};
  }

  private playerOf(id: PlayerId | undefined): Player | null {
    const side = this.session.userSide;
    return side && id ? this.session.setup[side].players[id] ?? null : null;
  }

  private items(): MenuItem[] {
    const side = this.session.userSide;
    if (!side) return [{ id: '__back', label: 'NO TEAM TO MANAGE' }];
    const subs = this.subs();
    const fatigue = this.session.state.fatigue;
    const claimed = new Set(Object.values(subs));
    const rows = this.roles.map((r) => {
      const manual = this.playerOf(subs[r.role]);
      const auto = depthStarter(this.session.setup, side, r.position, this.session.state, roleSlotIndex(r.role), claimed);
      const value = manual ? playerSubLabel(manual, fatigue) : auto ? `AUTO · ${playerSubLabel(auto, fatigue)}` : 'AUTO';
      return { id: r.role, label: `${manual ? '* ' : ''}${r.unit === 'offense' ? 'O' : 'D'} ${r.role}`, value };
    });
    return [...rows, { id: '__back', label: 'DONE' }];
  }

  /**
   * Steps `role` to the next (delta +1) or previous choice in [AUTO, ...healthy candidates] and sends it in; returns
   * the player now assigned, AUTO_SUB when the role went back to AUTO, or null when nothing changed.
   */
  cycle(role: string, delta: number): PlayerId | typeof AUTO_SUB | null {
    const side = this.session.userSide;
    const r = this.roles.find((x) => x.role === role);
    if (!side || !r || !this.session.substitute) return null;
    // A player already sent in at another role is not offered again (each man fills one role).
    const elsewhere = new Set(Object.entries(this.subs()).filter(([k]) => k !== role).map(([, id]) => id));
    const cands = substitutionCandidates(this.session.setup, side, r.position, this.session.state).filter((p) => !elsewhere.has(p.id));
    if (cands.length === 0) return null;
    const choices: (Player | null)[] = [null, ...cands];
    const manual = this.subs()[role] ?? null;
    // No override (or an override the list no longer holds, e.g. he got hurt) counts as sitting on AUTO.
    const i = Math.max(0, choices.findIndex((p) => (p?.id ?? null) === manual));
    const next = choices[((i + delta) % choices.length + choices.length) % choices.length] ?? null;
    if (!sendSubstitution(this.session, role, next?.id ?? null)) {
      this.services?.toast(next ? `${next.lastName.toUpperCase()} CANNOT COME IN` : 'CANNOT RETURN TO AUTO');
      return null;
    }
    this.menu.setItems(this.items());
    return next?.id ?? AUTO_SUB;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.menu.setItems(this.items());
  }

  exit(): void {
    this.services = null;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (input.justPressed.has('pause')) {
      services.stack.pop();
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back' || (ev.type === 'activate' && ev.item.id === '__back')) {
      services.audio?.onGameEvent({ type: 'menuBack' });
      services.stack.pop();
    } else if (ev.type === 'change' || ev.type === 'activate') {
      if (this.cycle(ev.item.id, ev.type === 'change' ? ev.delta : 1)) services.audio?.onGameEvent({ type: 'menuSelect' });
    } else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.6;
    ctx.fillStyle = theme.colors.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const hintH = theme.glyphH + 4 * theme.textScale;
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - theme.pad * 3 - hintH, { style: 'raised', alpha: 0.95, title: 'SUBSTITUTIONS' });
    const rows = Math.max(1, Math.floor((content.h - theme.lineHeight) / theme.lineHeight));
    const want = rows >= this.menu.items.length ? 0 : rows;
    if (want !== this.rowsShown) {
      this.rowsShown = want;
      this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
    }
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const footer = fitLines('SUBS TAKE EFFECT AT THE NEXT SNAP · * = MANUAL', content.w, 1, theme.textScale)[0] ?? '';
    drawText(ctx, footer, content.x, content.y + content.h - theme.glyphH, { color: theme.colors.textDim, size: theme.textScale });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'SWAP' },
      { glyph: input?.glyph('back') ?? 'B', label: 'DONE' },
    ], width, height - hintH - theme.pad);
  }
}
