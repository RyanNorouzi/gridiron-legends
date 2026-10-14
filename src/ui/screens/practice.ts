/**
 * Practice drill picker and drill setup. The picker shows the drills of one category per tab (OFFENSE / DEFENSE /
 * SPECIAL TEAMS; the 'Offense Practice' and 'Defense Practice' menu entries open it locked to their category),
 * with each drill's goal. Choosing a drill opens its setup (difficulty plus the kicking options: distance, line,
 * hash, wind, aim), which starts the PracticeGameScreen. Options are remembered per drill while the picker lives.
 */
import { CATEGORIES, CATEGORY_LABELS, DEFAULT_DRILL_OPTIONS, cycleOption, drillGoal, drillsIn, OPTION_LABELS, optionValueText, type CyclableOption } from '@/game/practice/drills';
import type { DrillRepDeps } from '@/game/practice/runner';
import type { DrillCategory, DrillDefinition, DrillId, DrillOptions } from '@/game/practice/types';
import type { InputState } from '../input/types';
import { drawText, measureText, wrapText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawBackdrop } from './main-menu';
import { PracticeGameScreen } from './practice-game';
import { fitHints } from './practice-hud';
import type { RenderContext, Screen, ScreenServices } from './screen';
import { setupHints } from '../widgets/setup-hints';

/** How the drill picker was opened and where it leads. */
export interface PracticeMenuOptions {
  /** Lock the picker to one category ('Offense Practice' / 'Defense Practice'); null/omitted = every tab. */
  filter?: DrillCategory | null;
  /** Back to the main menu from inside a drill (default: back to this picker, then pop it). */
  onQuit?: () => void;
  /** Starts a drill; default pushes the PracticeGameScreen. */
  onStart?: (def: DrillDefinition, options: DrillOptions) => void;
  /** Engine / AI overrides for tests. */
  repDeps?: DrillRepDeps;
  /** Fixed session seed (tests). */
  seed?: number;
}

/** Title of the picker for a filter. */
export const practiceTitle = (filter: DrillCategory | null | undefined): string =>
  filter === 'offense' ? 'OFFENSE PRACTICE' : filter === 'defense' ? 'DEFENSE PRACTICE' : filter === 'specialTeams' ? 'SPECIAL TEAMS PRACTICE' : 'PRACTICE';

/** Tabs a filter shows. */
export const categoriesFor = (filter: DrillCategory | null | undefined): DrillCategory[] => (filter ? [filter] : [...CATEGORIES]);

/** Picker rows; the one-line summary rides under the name at normal text size (large text shows it in the goal panel only). */
const drillItems = (category: DrillCategory, withSummary = true): MenuItem[] =>
  drillsIn(category).map((d) => (withSummary ? { id: d.id, label: d.name, subLabel: d.summary } : { id: d.id, label: d.name }));

/** Drill picker with category tabs (see the file header). */
export class PracticeMenuScreen implements Screen {
  readonly id = 'practiceMenu';
  readonly categories: DrillCategory[];
  private tabIndex = 0;
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private readonly chosen = new Map<DrillId, DrillOptions>();

  constructor(private readonly opts: PracticeMenuOptions = {}) {
    this.categories = categoriesFor(opts.filter);
    this.menu = new MenuList(drillItems(this.categories[0] as DrillCategory));
  }

  get list(): MenuList {
    return this.menu;
  }

  get category(): DrillCategory {
    return this.categories[this.tabIndex] as DrillCategory;
  }

  /** Options last used for a drill (defaults otherwise). */
  optionsFor(id: DrillId): DrillOptions {
    return this.chosen.get(id) ?? { ...DEFAULT_DRILL_OPTIONS };
  }

  private get summaries(): boolean {
    return (this.services?.theme.textScale ?? 1) === 1;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.menu = new MenuList(drillItems(this.category, this.summaries), { initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  exit(): void {
    this.services = null;
  }

  /** Switches tab by `delta` (wraps); no-op with a single category. */
  switchTab(delta: 1 | -1): void {
    if (this.categories.length < 2) return;
    this.tabIndex = (this.tabIndex + delta + this.categories.length) % this.categories.length;
    this.menu = new MenuList(drillItems(this.category, this.summaries));
    this.services?.audio?.onGameEvent({ type: 'menuMove' });
  }

  /** Opens the setup screen for a drill. */
  openSetup(def: DrillDefinition): void {
    const services = this.services;
    if (!services) return;
    services.stack.push(new PracticeSetupScreen(def, this.optionsFor(def.id), {
      onStart: (options) => this.startDrill(def, options),
      onChange: (options) => this.chosen.set(def.id, options),
    }));
  }

  /** Starts a drill (replacing the setup screen when it is on top). */
  startDrill(def: DrillDefinition, options: DrillOptions): void {
    this.chosen.set(def.id, options);
    if (this.opts.onStart) {
      this.opts.onStart(def, options);
      return;
    }
    const services = this.services;
    if (!services) return;
    const game = new PracticeGameScreen(def, options, {
      onChangeDrill: () => services.stack.popTo(this),
      onQuit: () => {
        if (this.opts.onQuit) this.opts.onQuit();
        else {
          services.stack.popTo(this);
          services.stack.pop();
        }
      },
      repDeps: this.opts.repDeps,
      seed: this.opts.seed,
    });
    if (services.stack.top instanceof PracticeSetupScreen) services.stack.replace(game);
    else services.stack.push(game);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.services = services;
    const p = input.justPressed;
    if (p.has('menuTabLeft') || p.has('menuLeft')) this.switchTab(-1);
    else if (p.has('menuTabRight') || p.has('menuRight')) this.switchTab(1);
    const ev = this.menu.update(dt, input);
    if (ev?.type === 'activate') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      const def = drillsIn(this.category).find((d) => d.id === ev.item.id);
      if (def) this.openSetup(def);
    } else if (ev?.type === 'back') services.stack.pop();
    else if (ev?.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    drawBackdrop(ctx, theme, width, height, rc.time);
    drawText(ctx, practiceTitle(this.opts.filter), width / 2, theme.pad, { size: Math.min(3, s + 1) as 1 | 2 | 3, align: 'center', color: c.accent, shadow: c.shadow });
    // Tabs
    let tx = theme.pad * 2;
    const tabY = theme.pad * 2 + theme.glyphH * 2;
    this.categories.forEach((cat, i) => {
      const label = CATEGORY_LABELS[cat];
      const w = measureText(label, s).width + theme.gap * 2;
      const active = i === this.tabIndex;
      ctx.fillStyle = active ? c.selection : c.panel;
      ctx.fillRect(tx, tabY, w, theme.glyphH + theme.gap * 2);
      drawText(ctx, label, tx + theme.gap, tabY + theme.gap, { color: active ? c.accent : c.textDim, size: s });
      tx += w + theme.gap;
    });
    const hintH = theme.glyphH + 4 * s;
    const panelY = tabY + theme.glyphH + theme.gap * 2;
    const panelH = height - panelY - hintH - theme.pad * 2;
    const listW = Math.round((width - theme.pad * 3) * 0.55);
    const list = drawPanel(ctx, theme, theme.pad, panelY, listW, panelH, { style: 'raised', alpha: 0.92 });
    this.menu.draw(ctx, theme, list.x, list.y, list.w, { time: rc.time });
    const infoX = theme.pad * 2 + listW;
    const info = drawPanel(ctx, theme, infoX, panelY, width - infoX - theme.pad, panelH, { style: 'solid', alpha: 0.9, title: 'GOAL' });
    const def = drillsIn(this.category).find((d) => d.id === this.menu.selected?.id);
    if (def) {
      // Summary, goal and unit, wrapped and clipped to the panel (large text wraps a lot).
      const bottom = info.y + info.h;
      const rows: { text: string; color: string }[] = [
        ...wrapText(def.summary.toUpperCase(), info.w, s).map((text) => ({ text, color: c.accent })),
        ...wrapText(drillGoal(def, this.optionsFor(def.id)), info.w, s).map((text) => ({ text, color: c.text })),
        { text: def.userUnit === 'offense' ? 'YOU PLAY OFFENSE' : 'YOU PLAY DEFENSE', color: c.textDim },
      ];
      let y = info.y;
      for (const row of rows) {
        if (y + theme.glyphH > bottom) break;
        drawText(ctx, row.text, info.x, y, { color: row.color, size: s });
        y += theme.glyphH + theme.gap;
      }
    }
    const input = this.services?.input;
    const hints = [{ glyph: input?.glyph('confirm') ?? 'A', label: 'SELECT' }, { glyph: input?.glyph('back') ?? 'B', label: 'BACK' }];
    if (this.categories.length > 1) hints.unshift({ glyph: `${input?.glyph('menuTabLeft') ?? 'LB'} ${input?.glyph('menuTabRight') ?? 'RB'}`, label: 'CATEGORY' });
    drawHintBar(ctx, theme, fitHints(theme, hints, width), width, height - hintH - theme.pad);
  }
}

/** Callbacks of the drill setup screen. */
export interface PracticeSetupActions {
  onStart: (options: DrillOptions) => void;
  /** Called whenever an option changes (the picker remembers it). */
  onChange?: (options: DrillOptions) => void;
}

/** Option rows a drill's setup screen shows: difficulty, then the drill's own options. */
export const setupKeys = (def: DrillDefinition): CyclableOption[] => ['difficulty', ...def.options];

/** One drill's options (difficulty, kicking spot / hash / wind / aim) and START. */
export class PracticeSetupScreen implements Screen {
  readonly id = 'practiceSetup';
  private menu: MenuList;
  private services: ScreenServices | null = null;

  constructor(readonly def: DrillDefinition, private optionsValue: DrillOptions, private readonly actions: PracticeSetupActions) {
    this.menu = new MenuList(this.items());
  }

  get options(): DrillOptions {
    return this.optionsValue;
  }

  get list(): MenuList {
    return this.menu;
  }

  private items(): MenuItem[] {
    // Wind speed means nothing in calm air: the row greys out instead of showing "CALM" beside "10 MPH".
    const calm = this.optionsValue.wind === 'calm';
    const rows: MenuItem[] = setupKeys(this.def).map((k) => (k === 'windMph' && calm
      ? { id: k, label: OPTION_LABELS[k], value: '—', disabled: true }
      : { id: k, label: OPTION_LABELS[k], value: optionValueText(this.optionsValue, k) }));
    rows.push({ id: 'start', label: 'START DRILL' }, { id: 'back', label: 'BACK' });
    return rows;
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  /** Steps one option through its choices. */
  change(key: CyclableOption, delta: 1 | -1): void {
    this.optionsValue = cycleOption(this.optionsValue, key, delta);
    this.menu.setItems(this.items());
    this.actions.onChange?.(this.optionsValue);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.services = services;
    // The start button (Enter) starts the drill from any row; confirm on a value row steps that value.
    if (input.justPressed.has('pause')) {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      this.actions.onStart(this.optionsValue);
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'change') {
      this.change(ev.item.id as CyclableOption, ev.delta);
      services.audio?.onGameEvent({ type: 'menuMove' });
    } else if (ev.type === 'activate') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      if (ev.item.id === 'start') this.actions.onStart(this.optionsValue);
      else if (ev.item.id === 'back') services.stack.pop();
      else this.change(ev.item.id as CyclableOption, 1);
    } else if (ev.type === 'back') services.stack.pop();
    else services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    drawBackdrop(ctx, theme, width, height, rc.time);
    const hintH = theme.glyphH + 4 * s;
    const panelW = Math.min(width - theme.pad * 2, 320 * s);
    const x = Math.round((width - panelW) / 2);
    // The card is as tall as its goal and option rows (never taller than the screen), centred above the hints.
    const maxH = height - hintH - theme.pad * 3;
    const goal = wrapText(drillGoal(this.def, this.optionsValue), panelW - 2 * (theme.border + theme.pad), s);
    const titleH = measureText(this.def.name, s).height + theme.gap * 2;
    const needH = titleH + goal.length * (theme.glyphH + theme.gap) + theme.gap + this.menu.measure(theme) + theme.border + theme.gap + theme.pad;
    const panelH = Math.min(maxH, needH);
    const top = theme.pad + Math.round((maxH - panelH) / 2);
    const content = drawPanel(ctx, theme, x, top, panelW, panelH, { style: 'raised', title: this.def.name });
    let y = content.y;
    for (const line of goal) {
      drawText(ctx, line, content.x, y, { color: c.text, size: s });
      y += theme.glyphH + theme.gap;
    }
    y += theme.gap;
    this.menu.draw(ctx, theme, content.x, y, content.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, fitHints(theme, setupHints(input ?? null, this.menu.selected?.id === 'start', 'START DRILL'), width), width, height - hintH - theme.pad);
  }
}
