/**
 * Main menu: procedural pixel-art title treatment over an animated night-game backdrop (title-backdrop.ts), a retro list of game
 * modes with the selected mode's description in a footer, and a hint bar. Items call the injected
 * MainMenuActions (the app wires every mode: quick game, franchise, season, playoffs, practice, tutorial,
 * custom game, watch mode, settings); a mode without an action shows a "coming in a later build" toast so nothing ever silently
 * does nothing. On a first launch (MainMenuOptions.tutorialOffer) the tutorial is offered in a prompt once the
 * menu has settled. Layout is derived from theme metrics so large-text mode simply scrolls the list.
 */
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import { drawSprite, generateBallSprite } from '../render/sprites';
import type { Theme } from '../theme';
import { MenuList } from '../widgets/menu';
import { drawHintBar, drawPanel, type UiCtx } from '../widgets/panel';
import { drawTitleBackdrop } from '../widgets/title-backdrop';
import type { ArtCtx } from '../widgets/ui-art';
import type { RenderContext, Screen, ScreenServices } from './screen';
import { PromptScreen } from './watch';

export type MainMenuItemId =
  | 'quickGame' | 'franchise' | 'season' | 'playoffs' | 'practice' | 'tutorial'
  | 'defensePractice' | 'offensePractice' | 'customGame' | 'watchMode' | 'settings';

/** Callbacks per menu entry; omitted entries are reported as not yet available. */
export type MainMenuActions = Partial<Record<MainMenuItemId, () => void>>;

export const MAIN_MENU_ITEMS: readonly { id: MainMenuItemId; label: string; description: string }[] = Object.freeze([
  { id: 'quickGame', label: 'QUICK GAME', description: 'Pick two teams and play' },
  { id: 'franchise', label: 'FRANCHISE', description: 'Run a team for seasons' },
  { id: 'season', label: 'SEASON', description: 'One year, one title' },
  { id: 'playoffs', label: 'PLAYOFFS', description: 'Straight to the bracket' },
  { id: 'practice', label: 'PRACTICE', description: 'Drills for every unit, no clock' },
  { id: 'tutorial', label: 'TUTORIAL', description: 'Learn the controls' },
  { id: 'defensePractice', label: 'DEFENSE PRACTICE', description: 'Coverage and tackling' },
  { id: 'offensePractice', label: 'OFFENSE PRACTICE', description: 'Passing, running, catching' },
  { id: 'customGame', label: 'CUSTOM GAME', description: 'Every rule, both sides' },
  { id: 'watchMode', label: 'WATCH MODE', description: 'Sit back and spectate' },
  { id: 'settings', label: 'SETTINGS', description: 'Controls, audio, access' },
]);

export const UNAVAILABLE_MESSAGE = 'Coming in a later build';
export const TITLE_LINE_1 = 'GRIDIRON';
export const TITLE_LINE_2 = 'LEGENDS';

/** First-launch tutorial offer (the app's TutorialProgressController satisfies it). */
export interface MainMenuTutorialOffer {
  /** True when the tutorial should be offered now (first launch, not completed / dismissed). */
  shouldOffer(): boolean;
  /** The player declined: `forever` = "don't ask again", otherwise only for this session. */
  decline(forever: boolean): void;
}

export interface MainMenuOptions {
  version?: string;
  /** Offers the tutorial once the menu has settled on a first launch; accepting runs the 'tutorial' action. */
  tutorialOffer?: MainMenuTutorialOffer;
}

/** Seconds the menu is up before the first-launch tutorial offer appears (so it never eats a quick key press). */
export const TUTORIAL_OFFER_DELAY = 0.75;

/** Height the title block occupies for a theme (used by layout and tests). */
export const titleHeight = (theme: Theme): number => 21 + theme.gap + 14 + theme.pad * 2;

/** Font-unit gap between the letters of the big word mark (wider than body text so the outline never fills it). */
const TITLE_SPACING = 2;
/** Near-black keyline and the dark gold extrude under the word mark. */
const TITLE_KEYLINE = '#140c02';
const TITLE_EXTRUDE = '#7a4f00';

/**
 * Draws the title treatment centred on `cx` with its top at `y`; returns the height used: the Chunky word mark as a
 * 16-bit logo (1-px near-black keyline, a 1-px dark gold extrude under each stroke, gold face with a pale upper
 * half) on a banner between two footballs, in the square pixels of the one 480x270 grid.
 */
export const drawTitle = (rc: RenderContext, cx: number, y: number): number => {
  const { ctx, theme } = rc;
  const c = theme.colors;
  const top = Math.round(y + theme.pad);
  const w1 = measureText(TITLE_LINE_1, 3, TITLE_SPACING).width;
  const x1 = Math.round(cx - w1 / 2);
  const line2Y = top + 21 + theme.gap;
  const w2 = measureText(TITLE_LINE_2, 2, 2).width;
  // banner behind the word mark
  ctx.fillStyle = c.shadow;
  ctx.fillRect(x1 - 8, top - 3, w1 + 16, 27);
  ctx.fillStyle = c.accent;
  ctx.fillRect(x1 - 8, top - 3, w1 + 16, 1);
  ctx.fillRect(x1 - 8, top + 23, w1 + 16, 1);
  // keyline: the word mark (and its extrude) stamped one pixel around in near-black
  const word = (dx: number, dy: number, color: string, reveal = 1): void => {
    drawText(ctx, TITLE_LINE_1, x1 + dx, top + dy, { size: 3, color, letterSpacing: TITLE_SPACING, reveal });
  };
  for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) word(dx, dy, TITLE_KEYLINE);
  word(0, 1, TITLE_EXTRUDE);
  word(0, 0, c.accent);
  word(0, 0, '#fff0a8', 0.45);
  drawText(ctx, TITLE_LINE_2, cx, line2Y, { size: 2, align: 'center', color: c.text, letterSpacing: 2, shadow: c.shadow });
  const ball = generateBallSprite(rc.sprites, { frame: Math.floor(rc.time * 6) % 4 });
  drawSprite(ctx, ball, cx - w2 / 2 - 12, line2Y + 7, { scale: 2 });
  drawSprite(ctx, ball, cx + w2 / 2 + 12, line2Y + 7, { scale: 2 });
  return titleHeight(theme);
};

/** Menu backdrop: the animated night-game scene (widgets/title-backdrop.ts); static with reduced motion. */
export const drawBackdrop = (ctx: UiCtx, theme: Theme, width: number, height: number, time: number): void => {
  ctx.fillStyle = theme.colors.bg;
  ctx.fillRect(0, 0, width, height);
  drawTitleBackdrop(ctx as ArtCtx, theme, width, height, time);
};

interface MenuLayout {
  panelX: number;
  panelY: number;
  panelW: number;
  panelH: number;
  hintH: number;
  /** Height reserved at the bottom of the panel for the description line. */
  descH: number;
  /** Rows of the list that fit above the description. */
  rowsThatFit: number;
}

/** Panel/list geometry for a viewport; shared by enter() and render() so both agree on what fits. */
export const menuLayout = (theme: Theme, width: number, height: number): MenuLayout => {
  const hintH = theme.glyphH + 4 * theme.textScale;
  const panelW = Math.min(width - theme.pad * 2, 220 * theme.textScale + theme.pad * 2);
  const panelX = Math.round((width - panelW) / 2);
  const panelY = titleHeight(theme);
  const panelH = height - panelY - hintH - theme.pad * 2;
  const descH = theme.glyphH + theme.gap;
  const contentH = panelH - 2 * (theme.border + theme.gap);
  return { panelX, panelY, panelW, panelH, hintH, descH, rowsThatFit: Math.max(3, Math.floor((contentH - descH) / theme.lineHeight)) };
};

export class MainMenuScreen implements Screen {
  readonly id = 'mainMenu';
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private elapsed = 0;
  private offered = false;

  constructor(private readonly actions: MainMenuActions, private readonly opts: MainMenuOptions = {}) {
    this.menu = new MenuList(MAIN_MENU_ITEMS.map((i) => ({ id: i.id, label: i.label })));
  }

  /** The list widget, exposed for tests and for screens that want to preselect an entry. */
  get list(): MenuList {
    return this.menu;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.refit(menuLayout(services.theme, services.width, services.height).rowsThatFit);
  }

  /** Shows `fit` rows (all when they fit), keeping the selection; re-run on render so a text-size change applies. */
  private refit(fit: number): void {
    const want = fit >= MAIN_MENU_ITEMS.length ? 0 : fit;
    if (this.menu.maxVisible === want) return;
    this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  exit(): void {
    this.services = null;
  }

  /** Runs the action for an item or reports it as unavailable. */
  activate(id: MainMenuItemId, services: ScreenServices): boolean {
    const fn = this.actions[id];
    // The first confirmed gesture is also what unlocks browser audio.
    void services.audio?.resume().catch(() => undefined);
    services.audio?.onGameEvent({ type: 'menuSelect' });
    if (fn) {
      fn();
      return true;
    }
    services.toast(`${MAIN_MENU_ITEMS.find((i) => i.id === id)?.label ?? id}: ${UNAVAILABLE_MESSAGE}`);
    return false;
  }

  /** Shows the first-launch tutorial prompt when the offer says so; returns true when it was pushed. */
  maybeOfferTutorial(services: ScreenServices): boolean {
    const offer = this.opts.tutorialOffer;
    if (!offer || this.offered || this.elapsed < TUTORIAL_OFFER_DELAY || !offer.shouldOffer()) return false;
    this.offered = true;
    services.stack.push(new PromptScreen({
      title: 'WELCOME, COACH',
      lines: ['New to Gridiron Legends?', 'The tutorial teaches every control in a few minutes.'],
      choices: [
        { id: 'yes', label: 'PLAY THE TUTORIAL' },
        { id: 'later', label: 'MAYBE LATER' },
        { id: 'never', label: "DON'T ASK AGAIN" },
      ],
      backChoice: 'later',
      onChoose: (id) => {
        if (id === 'yes') this.activate('tutorial', services);
        else offer.decline(id === 'never');
      },
    }));
    return true;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.elapsed += dt;
    if (this.maybeOfferTutorial(services)) return;
    const ev = this.menu.update(dt, input);
    if (ev?.type === 'activate') this.activate(ev.item.id as MainMenuItemId, services);
    else if (ev?.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    drawBackdrop(ctx, theme, width, height, rc.time);
    drawTitle(rc, width / 2, 0);
    const l = menuLayout(theme, width, height);
    this.refit(l.rowsThatFit);
    const content = drawPanel(ctx, theme, l.panelX, l.panelY, l.panelW, l.panelH, { style: 'raised', alpha: 0.92 });
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: this.elapsed });
    const selected = MAIN_MENU_ITEMS.find((i) => i.id === this.menu.selected?.id);
    if (selected) {
      const descY = content.y + content.h - theme.glyphH;
      ctx.fillStyle = theme.colors.panelBorder;
      ctx.fillRect(content.x, descY - theme.gap, content.w, 1);
      drawText(ctx, selected.description, content.x + theme.gap, descY, { color: theme.colors.textDim, size: theme.textScale });
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: input?.glyph('confirm') ?? 'ENTER', label: 'SELECT' },
      { glyph: `${input?.glyph('menuUp') ?? '↑'} ${input?.glyph('menuDown') ?? '↓'}`, label: 'MOVE' },
    ], width, height - l.hintH - theme.pad);
    if (this.opts.version) drawText(ctx, `V${this.opts.version}`, theme.pad, height - theme.glyphH - theme.pad, { color: theme.colors.textDim, size: theme.textScale });
  }
}
