/**
 * Defensive assignment editor (advanced play calling): opened from the defensive play-call screen on the highlighted
 * play. One row per defender (role, position) whose value cycles with left / right through the choices in
 * game/assignment-options (AS CALLED, man on a receiver, zones, blitz / rush / fill, contain, spy); the art on the
 * right shows the play with the changes, the edited defender highlighted. DONE (or back) hands the overrides to
 * the play-call screen; RESET puts every defender back on the call.
 */
import type { PlaybookRegistry } from '@/playbook/loader';
import type { DefAssignment, DefensivePlay, FormationSlot } from '@/playbook/types';
import { applyOverrides, assignmentLabel, assignmentOptionsFor, normalizeOverrides, type AssignmentOption } from '../game/assignment-options';
import { drawPlayArt } from '../game/play-art';
import type { InputState } from '../input/types';
import { drawText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { UI_SLAB } from '../render/palette';
import { drawSlab, type ArtCtx } from '../widgets/ui-art';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface AssignmentsOptions {
  /** Called once with the final overrides (empty = the play as called). */
  onDone: (overrides: Record<string, DefAssignment>) => void;
}

const DONE = '__done';
const RESET = '__reset';

export class AssignmentsScreen implements Screen {
  readonly id = 'assignments';
  readonly overlay = true;
  private readonly slots: FormationSlot[];
  private readonly options: Record<string, AssignmentOption[]>;
  private overrides: Record<string, DefAssignment>;
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private finished = false;
  private rowsShown = 0;

  constructor(readonly play: DefensivePlay, private readonly registry: PlaybookRegistry, initial: Readonly<Record<string, DefAssignment>>, private readonly opts: AssignmentsOptions) {
    const formation = registry.defensiveFormations[play.formation];
    this.slots = formation ? formation.slots.filter((s) => play.assignments[s.role] !== undefined) : Object.keys(play.assignments).map((role) => ({ role, position: 'MLB', x: 0, y: 5 }));
    this.options = Object.fromEntries(this.slots.map((s) => [s.role, assignmentOptionsFor(s)]));
    this.overrides = { ...initial };
    this.menu = new MenuList(this.items());
  }

  get list(): MenuList {
    return this.menu;
  }

  /** Current overrides (only real changes). */
  get current(): Record<string, DefAssignment> {
    return normalizeOverrides(this.play, this.overrides);
  }

  private valueFor(role: string): string {
    const o = this.overrides[role];
    return o ? assignmentLabel(o) : `${assignmentLabel(this.play.assignments[role])}`;
  }

  private items(): MenuItem[] {
    const rows: MenuItem[] = this.slots.map((s) => ({ id: s.role, label: `${this.overrides[s.role] ? '* ' : ''}${s.role}`, value: this.valueFor(s.role) }));
    return [...rows, { id: RESET, label: 'RESET TO CALL' }, { id: DONE, label: 'DONE' }];
  }

  private refresh(): void {
    this.menu.setItems(this.items());
  }

  /** Steps defender `role` through its choices by `delta` (wraps). */
  cycle(role: string, delta: number): void {
    const opts = this.options[role];
    if (!opts || opts.length === 0) return;
    const cur = this.overrides[role];
    const key = cur ? JSON.stringify(cur) : null;
    let i = key === null ? 0 : opts.findIndex((o) => o.assignment !== null && JSON.stringify(o.assignment) === key);
    if (i < 0) i = 0;
    const next = opts[((i + delta) % opts.length + opts.length) % opts.length] as AssignmentOption;
    if (next.assignment === null || JSON.stringify(next.assignment) === JSON.stringify(this.play.assignments[role])) delete this.overrides[role];
    else this.overrides[role] = next.assignment;
    this.refresh();
  }

  /** Every defender back on the play call. */
  reset(): void {
    this.overrides = {};
    this.refresh();
  }

  /** Closes the editor and reports the overrides. */
  done(): void {
    if (this.finished) return;
    this.finished = true;
    const services = this.services;
    if (services && services.stack.top === this) services.stack.pop();
    services?.audio?.onGameEvent({ type: 'menuSelect' });
    this.opts.onDone(this.current);
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') this.done();
    else if (ev.type === 'change') {
      this.cycle(ev.item.id, ev.delta);
      services.audio?.onGameEvent({ type: 'menuMove' });
    } else if (ev.type === 'activate') {
      if (ev.item.id === DONE) this.done();
      else if (ev.item.id === RESET) this.reset();
      else this.cycle(ev.item.id, 1);
    } else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.5;
    ctx.fillStyle = c.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const hintH = theme.glyphH + 4 * s;
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - theme.pad * 3 - hintH, { style: 'raised', alpha: 1, title: `ASSIGNMENTS · ${this.play.name.toUpperCase()}` });
    // Large text gives the list more of the panel so assignment names are not cut to a few letters.
    const listW = Math.round(content.w * (s > 1 ? 0.7 : 0.58));
    const rows = Math.max(1, Math.floor(content.h / theme.lineHeight));
    const want = rows >= this.menu.items.length ? 0 : rows;
    if (want !== this.rowsShown) {
      this.rowsShown = want;
      this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
    }
    this.menu.draw(ctx, theme, content.x, content.y, listW, { time: rc.time });
    const artX = content.x + listW + theme.pad;
    const artW = content.x + content.w - artX;
    const artH = Math.min(content.h - theme.lineHeight, Math.round(artW * 0.9));
    const role = this.menu.selected?.id ?? null;
    if (artW > 20 && artH > 20) {
      // The chalkboard card of the play call: a dark rim with a lit bevel around the board.
      drawSlab(ctx as ArtCtx, artX - 2, content.y - 2, artW + 4, artH + 4, { fill: UI_SLAB.edge, bevel: UI_SLAB.bevelHi, texture: false, drop: true });
      drawPlayArt(ctx, applyOverrides(this.play, this.current), this.registry, { x: artX, y: content.y, w: artW, h: artH }, { theme, highlightRole: role });
      const changed = Object.keys(this.current).length;
      drawText(ctx, changed === 0 ? 'AS CALLED' : `${changed} CHANGED`, artX, content.y + artH + theme.gap, { color: changed === 0 ? c.textDim : c.accent, size: s });
    }
    const input = this.services?.input;
    // An opaque strip: the play-call screen's own hint bar underneath must not show through this one.
    drawSlab(ctx as ArtCtx, 0, height - hintH - theme.pad - s * 2, width, hintH + theme.pad + s * 2, { fill: c.bg, texture: false });
    drawHintBar(ctx, theme, [
      { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'CHANGE' },
      { glyph: input?.glyph('back') ?? 'B', label: 'DONE' },
    ], width, height - hintH - theme.pad);
  }
}
