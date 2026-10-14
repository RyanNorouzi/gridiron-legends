/**
 * Play-call screen (overlay over the field). Offense: a SPECIAL tab (4th-down / kickoff / PAT shortcuts) when
 * the situation offers one, then formation tabs, each listing plays with type/concept and tags, the coach's
 * suggestion marked, and the selected play drawn as art. Defense: tabs by front (4-3, nickel, ...) listing
 * coverages / blitzes with a CONTROL row to pick the athlete you take (FS default; SS / MLB ...; confirm on the
 * row steps to the next role). On defense the showPlayArt button opens the assignment editor for the highlighted
 * play (advanced play calling: override any defender's assignment); edited plays are marked and their art shows
 * the changes. On offense the same button toggles NO HUDDLE (hurry-up tempo: the short pre-snap runoff instead of
 * a full huddle) for scrimmage plays; kicks and kneels always huddle. Tabs cycle with LB/RB or left/right; lists
 * use the MenuList widget so keyboard, gamepad, mouse and touch all work. The request's playbook complexity trims the lists (simple) and gates the editor.
 */
import type { PlaybookRegistry } from '@/playbook/loader';
import { playsByFormation } from '@/playbook/playbooks';
import type { DefAssignment, DefensivePlay, OffensivePlay } from '@/playbook/types';
import { applyOverrides } from '../game/assignment-options';
import { describeDefense, describeOffense, drawPlayArt } from '../game/play-art';
import type { PlayCall, PlaycallRequest, SpecialOption } from '../game/session-types';
import type { InputState } from '../input/types';
import { drawText, fitLines, fitSegments, measureText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { UI_SLAB } from '../render/palette';
import { drawSlab, drawTab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import { drawSmallText, measureSmallText } from '../widgets/text-fine';
import { BANNER_SECONDS } from '../game/banners';
import { AssignmentsScreen } from './assignments';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface PlayCallOptions {
  onCall: (call: PlayCall) => void;
  onPause?: () => void;
  /** Calls a timeout: false when none could be called; a string is the confirmation to show over the play call. */
  onTimeout?: () => boolean | string;
  /** Initially selected defensive control role. */
  defaultRole?: string | null;
  /** Offense: start with NO HUDDLE on (the game screen keeps the choice across a drive). */
  defaultHurryUp?: boolean;
}

interface Tab {
  id: string;
  label: string;
  items: MenuItem[];
}

/** First/last tab indices that fit in `room` px while always including `selected` (widths include spacing). */
export const visibleTabWindow = (widths: readonly number[], selected: number, room: number): { start: number; end: number } => {
  const n = widths.length;
  if (n === 0) return { start: 0, end: -1 };
  let start = 0;
  const span = (a: number, b: number): number => widths.slice(a, b + 1).reduce((t, w) => t + w, 0);
  while (start < selected && span(start, selected) > room) start++;
  let end = start;
  while (end + 1 < n && span(start, end + 1) <= room) end++;
  if (end < selected) end = selected;
  return { start, end };
};

const SPECIAL_TAB = '__special';
const CONTROL_ITEM = '__control';

const tagLine = (tags: readonly string[]): string => tags.filter((t) => t !== 'base').slice(0, 3).map((t) => t.replace(/([A-Z])/g, ' $1').toUpperCase()).join(' · ');

const formationLabel = (id: string, registry: PlaybookRegistry): string => {
  const off = registry.offensiveFormations[id];
  if (off) return off.name.toUpperCase();
  const def = registry.defensiveFormations[id];
  if (def) return def.base.toUpperCase();
  return id.replace(/[-_]/g, ' ').toUpperCase();
};

/**
 * A play's list label under its formation tab: the name without the formation's words when it starts with them
 * ("SINGLEBACK Y CROSS" under the SINGLEBACK tab reads "Y CROSS"), so rows stay distinct when large text cuts them.
 */
export const playRowLabel = (name: string, tabLabel: string): string => {
  const n = name.toUpperCase();
  const prefix = `${tabLabel.toUpperCase()} `;
  return n.startsWith(prefix) && n.length > prefix.length ? n.slice(prefix.length) : n;
};

/** Groups offensive plays into formation tabs (special shortcuts first when any). */
export const offenseTabs = (request: PlaycallRequest, registry: PlaybookRegistry): Tab[] => {
  const tabs: Tab[] = [];
  if (request.special.length > 0) {
    tabs.push({ id: SPECIAL_TAB, label: 'SPECIAL', items: request.special.map((o) => ({ id: `special:${o.id}`, label: `${`special:${o.id}` === request.suggestion ? '★ ' : ''}${o.label}`, subLabel: o.detail })) });
  }
  const groups = playsByFormation(request.offensePlays);
  for (const [formation, plays] of Object.entries(groups)) {
    const tab = formationLabel(formation, registry);
    tabs.push({
      id: formation,
      label: tab,
      items: plays.map((p) => {
        // The advanced playbook also names the primary read and the progression.
        const reads = request.complexity === 'advanced' && p.primary ? `READ ${[p.primary, ...p.progression.filter((r) => r !== p.primary)].slice(0, 3).join('>')}` : '';
        return { id: p.id, label: `${p.id === request.suggestion ? '★ ' : ''}${playRowLabel(p.name, tab)}`, subLabel: [describeOffense(p), reads, tagLine(p.tags)].filter((t) => t.length > 0).join(' · ') };
      }),
    });
  }
  return tabs;
};

/** Groups defensive plays into front tabs, each starting with the CONTROL row; plays with overrides are marked. */
export const defenseTabs = (request: PlaycallRequest, registry: PlaybookRegistry, role: string | null, edited: Readonly<Record<string, Readonly<Record<string, DefAssignment>>>> = {}): Tab[] => {
  const byBase: Record<string, DefensivePlay[]> = {};
  for (const p of request.defensePlays) {
    const base = registry.defensiveFormations[p.formation]?.base ?? p.formation;
    (byBase[base] ??= []).push(p);
  }
  const controlRow: MenuItem[] = request.controlRoles.length > 0 ? [{ id: CONTROL_ITEM, label: 'CONTROL', value: role ?? request.controlRoles[0] ?? '' }] : [];
  return Object.entries(byBase).map(([base, plays]) => ({
    id: base,
    label: base.toUpperCase(),
    items: [...controlRow, ...plays.map((p) => {
      const changed = Object.keys(edited[p.id] ?? {}).length;
      const mark = changed > 0 ? `${changed} ASSIGNMENT${changed === 1 ? '' : 'S'} CHANGED` : '';
      return { id: p.id, label: `${p.id === request.suggestion ? '★ ' : ''}${playRowLabel(p.name, base)}`, subLabel: [mark, describeDefense(p), tagLine(p.tags)].filter((t) => t.length > 0).join(' · ') };
    })],
  }));
};

/** The coach-pick badge's words on the play card. */
export const COACH_PICK_LABEL = '★ COACH PICK';

/** The badge text for a card `artW` wide: the words while they take at most half the card, else just the star. */
export const coachPickBadge = (labelWidth: number, artW: number): string => (labelWidth + 12 <= artW * 0.5 ? COACH_PICK_LABEL : '★');

export class PlayCallScreen implements Screen {
  readonly id = 'playcall';
  readonly overlay = true;
  private tabs: Tab[];
  private tabIndex = 0;
  private menu: MenuList;
  private role: string | null;
  private services: ScreenServices | null = null;
  private called = false;
  /** Rows the list shows at once; refitted to the panel height every frame (fewer in large text). */
  private rowsShown = 6;
  /** Defensive play id -> assignment overrides made in the editor. */
  private readonly edited: Record<string, Record<string, DefAssignment>> = {};
  /** Offense: the no-huddle (hurry-up) toggle. */
  private noHuddle: boolean;

  constructor(readonly request: PlaycallRequest, private readonly registry: PlaybookRegistry, private readonly opts: PlayCallOptions) {
    this.noHuddle = this.canHurryUp && opts.defaultHurryUp === true;
    this.role = request.unit === 'defense' ? (opts.defaultRole && request.controlRoles.includes(opts.defaultRole) ? opts.defaultRole : request.controlRoles[0] ?? null) : null;
    this.tabs = request.unit === 'offense' ? offenseTabs(request, registry) : defenseTabs(request, registry, this.role);
    if (this.tabs.length === 0) this.tabs = [{ id: 'none', label: 'NO PLAYS', items: [] }];
    this.menu = new MenuList(this.tabs[0]?.items ?? [], { maxVisible: 6 });
    if (request.situation.kind === 'scrimmage') this.selectSuggested();
  }

  get tab(): Tab {
    return this.tabs[this.tabIndex] as Tab;
  }

  get list(): MenuList {
    return this.menu;
  }

  get controlRole(): string | null {
    return this.role;
  }

  /** Assignment overrides made for a defensive play (empty when none). */
  overridesFor(playId: string): Record<string, DefAssignment> {
    return { ...this.edited[playId] };
  }

  /** True when the NO HUDDLE toggle is offered (offense, scrimmage down). */
  get canHurryUp(): boolean {
    return this.request.unit === 'offense' && this.request.situation.kind === 'scrimmage';
  }

  /** Current NO HUDDLE choice (always false when not offered). */
  get hurryUp(): boolean {
    return this.noHuddle;
  }

  /** Flips NO HUDDLE; false when the toggle is not offered here. */
  toggleHurryUp(): boolean {
    if (!this.canHurryUp) return false;
    this.noHuddle = !this.noHuddle;
    return true;
  }

  /** True when the assignment editor is offered (defense, and not the simple playbook). */
  get canEditAssignments(): boolean {
    return this.request.unit === 'defense' && (this.request.complexity ?? 'standard') !== 'simple';
  }

  /** Opens the assignment editor for the highlighted defensive play; false when none is highlighted. */
  openAssignments(services: ScreenServices): boolean {
    const play = this.selectedPlay();
    if (!this.canEditAssignments || !play || !('coverage' in play)) return false;
    services.stack.push(new AssignmentsScreen(play, this.registry, this.edited[play.id] ?? {}, {
      onDone: (overrides) => {
        if (Object.keys(overrides).length > 0) this.edited[play.id] = overrides;
        else delete this.edited[play.id];
        this.rebuildDefenseTabs();
      },
    }));
    return true;
  }

  private rebuildDefenseTabs(): void {
    this.tabs = defenseTabs(this.request, this.registry, this.role, this.edited);
    const sel = this.menu.selectedIndex;
    this.menu.setItems(this.tab.items);
    this.menu.select(sel);
  }

  private selectSuggested(): void {
    const s = this.request.suggestion;
    if (!s) return;
    const t = this.tabs.findIndex((tab) => tab.items.some((i) => i.id === s));
    if (t < 0) return;
    this.switchTab(t);
    const i = this.tab.items.findIndex((it) => it.id === s);
    if (i >= 0) this.menu.select(i);
  }

  switchTab(index: number): void {
    const n = this.tabs.length;
    this.tabIndex = ((index % n) + n) % n;
    this.menu = new MenuList(this.tab.items, { maxVisible: this.rowsShown });
  }

  /** Shows `rows` list rows at once (keeping the selection); the render pass fits this to the panel. */
  fitRows(rows: number): void {
    const want = Math.max(1, rows);
    if (want === this.rowsShown) return;
    this.rowsShown = want;
    this.menu = new MenuList(this.tab.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  /** The play (offense or defense) currently highlighted, for the art panel. */
  selectedPlay(): OffensivePlay | DefensivePlay | null {
    const id = this.menu.selected?.id;
    if (!id || id === CONTROL_ITEM) return null;
    if (id.startsWith('special:')) {
      const opt = this.request.special.find((o) => `special:${o.id}` === id);
      return opt?.playId ? this.findOffense(opt.playId) : null;
    }
    const def = this.request.defensePlays.find((p) => p.id === id);
    return this.findOffense(id) ?? (def ? applyOverrides(def, this.edited[def.id]) : null);
  }

  private findOffense(id: string): OffensivePlay | null {
    return this.request.offensePlays.find((p) => p.id === id) ?? this.setupPlay(id);
  }

  private setupPlay(id: string): OffensivePlay | null {
    // Special options reference plays outside the regular list (punt, FG, kickoff, XP).
    return this.request.special.map((o) => o.playId).includes(id) ? (this.registry.offensePlays[id] ?? null) : null;
  }

  private call(call: PlayCall): void {
    if (this.called) return;
    this.called = true;
    const services = this.services;
    if (services && services.stack.top === this) services.stack.pop();
    services?.audio?.onGameEvent({ type: 'menuSelect' });
    this.opts.onCall(call);
  }

  /** Activates a list item id (exported for tests). */
  activate(id: string): void {
    if (id === CONTROL_ITEM) {
      // Confirm on the CONTROL row steps to the next role (it used to do nothing, which looked like a hang).
      this.cycleRole(1);
      this.services?.audio?.onGameEvent({ type: 'menuMove' });
      return;
    }
    if (id.startsWith('special:')) {
      const opt = this.request.special.find((o) => `special:${o.id}` === id) as SpecialOption | undefined;
      if (!opt) return;
      if (opt.playId) this.call({ offensivePlayId: opt.playId, ...(this.noHuddle && { hurryUp: true }) });
      else if (this.tabs.length > 1) this.switchTab(1);
      return;
    }
    if (this.request.unit === 'offense') this.call({ offensivePlayId: id, ...(this.noHuddle && { hurryUp: true }) });
    else {
      const overrides = this.edited[id];
      this.call({ defensivePlayId: id, controlRole: this.role, ...(overrides && Object.keys(overrides).length > 0 ? { assignmentOverrides: { ...overrides } } : {}) });
    }
  }

  private cycleRole(delta: number): void {
    const roles = this.request.controlRoles;
    if (roles.length === 0) return;
    const i = Math.max(0, roles.indexOf(this.role ?? ''));
    this.role = roles[((i + delta) % roles.length + roles.length) % roles.length] ?? null;
    this.rebuildDefenseTabs();
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (input.justPressed.has('pause') && this.opts.onPause) {
      this.opts.onPause();
      return;
    }
    if (input.justPressed.has('callTimeout') && this.opts.onTimeout) {
      const called = this.opts.onTimeout();
      // The TIMEOUT banner is drawn under this panel: confirm it on top instead.
      if (!called) services.toast('No timeout available');
      else if (typeof called === 'string') services.toast(called, BANNER_SECONDS);
      return;
    }
    if (input.justPressed.has('showPlayArt') && this.openAssignments(services)) return;
    if (input.justPressed.has('showPlayArt') && this.toggleHurryUp()) {
      services.audio?.onGameEvent({ type: 'menuMove' });
      return;
    }
    const onValueRow = this.menu.selected?.id === CONTROL_ITEM;
    if (input.justPressed.has('menuTabLeft') || (!onValueRow && input.justPressed.has('menuLeft'))) {
      this.switchTab(this.tabIndex - 1);
      services.audio?.onGameEvent({ type: 'menuMove' });
      return;
    }
    if (input.justPressed.has('menuTabRight') || (!onValueRow && input.justPressed.has('menuRight'))) {
      this.switchTab(this.tabIndex + 1);
      services.audio?.onGameEvent({ type: 'menuMove' });
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'activate') this.activate(ev.item.id);
    else if (ev.type === 'change' && ev.item.id === CONTROL_ITEM) this.cycleRole(ev.delta);
    else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.45;
    ctx.fillStyle = c.overlay;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = prev;
    const hintH = theme.glyphH + 4 * s;
    const panelX = theme.pad;
    const panelY = theme.pad;
    const panelW = width - theme.pad * 2;
    const panelH = height - theme.pad * 3 - hintH;
    const title = `${this.request.unit === 'offense' ? 'OFFENSE' : 'DEFENSE'} · ${this.request.summary}${this.noHuddle ? ' · NO HUDDLE' : ''}`;
    const content = drawPanel(ctx, theme, panelX, panelY, panelW, panelH, { style: 'raised', alpha: 0.94, title });
    // tabs row: scrolls so the selected tab is always visible; arrows mark tabs hidden on either side
    const tabY = content.y;
    const arrowW = measureText('<', s).width + theme.gap;
    const widths = this.tabs.map((t) => measureText(t.label, s).width + theme.gap * 3);
    const room = content.w - arrowW * 2;
    const window = visibleTabWindow(widths, this.tabIndex, room);
    let tx = content.x + arrowW;
    if (window.start > 0) drawText(ctx, '<', content.x, tabY + Math.round(theme.gap / 2), { color: c.accent, size: s });
    const tabH = theme.glyphH + theme.gap;
    for (let i = window.start; i <= window.end; i++) {
      const t = this.tabs[i] as Tab;
      const w = (widths[i] as number) - theme.gap;
      const on = i === this.tabIndex;
      drawTab(ctx as ArtCtx, tx, tabY, w, tabH, on ? c.selection : c.panelLight, { cut: 2 * s });
      if (on) {
        ctx.fillStyle = c.accent;
        ctx.fillRect(tx, tabY + tabH - 1, w - 2 * s, 1);
      }
      drawText(ctx, t.label, tx + theme.gap, tabY + Math.round(theme.gap / 2), { color: on ? c.accent : c.textDim, size: s });
      tx += w + theme.gap;
    }
    if (window.end < this.tabs.length - 1) drawText(ctx, '>', content.x + content.w, tabY + Math.round(theme.gap / 2), { color: c.accent, size: s, align: 'right' });
    const listY = tabY + theme.glyphH + theme.gap * 2;
    const listW = Math.round(content.w * 0.56);
    // Every row carries a sub-label: fit as many as the panel holds so large text never spills past the border.
    const rowH = theme.lineHeight + theme.glyphH + 2 * s;
    this.fitRows(Math.floor((content.y + content.h - listY) / rowH));
    this.menu.draw(ctx, theme, content.x, listY, listW, { time: rc.time });
    // art panel
    const artX = content.x + listW + theme.pad;
    const artW = content.x + content.w - artX;
    const artH = Math.min(content.y + content.h - listY - theme.glyphH * 2 - theme.gap * 2, Math.round(artW * 0.9));
    const play = this.selectedPlay();
    if (play && artW > 20 && artH > 20) {
      const art = ctx as ArtCtx;
      // The card: a dark rim and a bevel around the chalkboard, the formation chalked in its corner.
      drawSlab(art, artX - 2, listY - 2, artW + 4, artH + 4, { fill: UI_SLAB.edge, bevel: UI_SLAB.bevelHi, texture: false, drop: true });
      drawPlayArt(ctx, play, this.registry, { x: artX, y: listY, w: artW, h: artH }, { theme });
      const formation = formationLabel(play.formation, this.registry);
      const picked = this.request.suggestion !== null && this.request.suggestion !== undefined && (this.menu.selected?.id === this.request.suggestion);
      // The badge shrinks to its star when the words would cover the board (large text on a small card); the
      // formation name is left out rather than drawn under it.
      const badge = picked ? coachPickBadge(measureSmallText(art, theme, COACH_PICK_LABEL).width, artW) : null;
      const bm = badge ? measureSmallText(art, theme, badge) : null;
      const room = artW - 8 - (bm ? bm.width + 12 : 0);
      const fm = measureSmallText(art, theme, formation);
      if (fm.width <= room) {
        // A slate chip under the chalked name, so a route drawn through the corner never runs across the letters.
        fillAlpha(art, UI_SLAB.chalkboard, 0.92, artX + 2, listY + 2, fm.width + 4, fm.height + 3);
        drawSmallText(art, theme, formation, artX + 4, listY + 4, { color: UI_SLAB.chalk });
      }
      if (badge && bm) {
        const bx = artX + artW - bm.width - 8;
        drawTab(art, bx - 2, listY + 2, bm.width + 8, bm.height + 4, c.accent, { cutLeft: 2 });
        drawSmallText(art, theme, badge, bx + 2, listY + 4, { color: c.textInverse });
      }
      const desc = 'coverage' in play ? describeDefense(play) : describeOffense(play);
      // One line each, cut to the art column so large text never runs past the panel border.
      const full = play.name.toUpperCase();
      const title = measureText(full, s).width <= artW ? full : playRowLabel(full, formation);
      drawText(ctx, fitLines(title, artW, 1, s)[0] ?? '', artX, listY + artH + theme.gap, { color: c.text, size: s });
      drawText(ctx, fitSegments(desc, artW, s), artX, listY + artH + theme.gap + theme.glyphH + 2, { color: c.textDim, size: s });
    } else if (artW > 20) {
      drawText(ctx, this.menu.selected?.subLabel ?? '', artX, listY, { color: c.textDim, size: s });
    }
    const input = this.services?.input;
    const hints = [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'CALL' },
      { glyph: `${input?.glyph('menuTabLeft') ?? 'LB'} ${input?.glyph('menuTabRight') ?? 'RB'}`, label: 'TABS' },
    ];
    if (this.canEditAssignments) hints.push({ glyph: input?.glyph('showPlayArt') ?? 'X', label: 'ASSIGN' });
    if (this.canHurryUp) hints.push({ glyph: input?.glyph('showPlayArt') ?? 'X', label: this.noHuddle ? 'HUDDLE' : 'NO HUDDLE' });
    if (this.opts.onTimeout) hints.push({ glyph: input?.glyph('callTimeout') ?? 'LT', label: 'TIMEOUT' });
    if (this.request.suggestion) hints.push({ glyph: '★', label: 'COACH PICK' });
    // Backdrop: the hints sit over the live field, where yard lines otherwise run straight through the labels.
    drawHintBar(ctx, theme, hints, width, height - hintH - theme.pad, 'right', { backdrop: true });
  }
}
