/**
 * Touch overlay: draws the virtual stick and action buttons from the touch source's layout, labelling each
 * button for the current play context (offense: SPRINT / JUKE / SPIN / DIVE + receiver taps; defense: SWITCH /
 * TACKLE / HIT / SWAT; kick: KICK; pre-snap: SNAP / ART / AUD). Whether it shows follows the setting
 * ('auto' = only when the last device was touch).
 */
import type { Settings } from '@/core/settings';
import type { Action, Button, ControlScheme, InputState } from '../input/types';
import type { TouchLayout } from '../input/touch';
import { markTouchOverlay } from '../input/touch-frame';
import { drawText, measureText, type FillCtx } from '../render/text';
import type { Theme } from '../theme';
import { pixelEllipse } from './pixel-draw';
import { UI_SLAB, darken, lighten } from '../render/palette';
import { artEllipse, artLine, drawSlab, type ArtCtx } from '../widgets/ui-art';
import { drawSmallText, measureSmallText } from '../widgets/text-fine';
import { scoreBugRect } from './hud';
import type { PlayInputContext } from './play-input';

export type TouchContext = PlayInputContext | 'menu' | 'watch' | 'postPlay';

/** Actions (in priority order) whose label a button shows, per context. */
const CONTEXT_ACTIONS: Readonly<Record<TouchContext, readonly Action[]>> = Object.freeze({
  presnapOffense: ['snap', 'showPlayArt', 'audible', 'callTimeout', 'pause'],
  presnapDefense: ['switchPlayer', 'showPlayArt', 'audible', 'callTimeout', 'pause'],
  kick: ['kick', 'pause'],
  qb: ['throw1', 'throw2', 'throw3', 'throw4', 'throw5', 'sprint', 'throwAway', 'throwModifier', 'pause'],
  carrier: ['sprint', 'juke', 'spin', 'stiffArm', 'hurdle', 'dive', 'pause'],
  receiver: ['sprint', 'jumpSwat', 'dive', 'pause'],
  defense: ['switchPlayer', 'tackle', 'hitStick', 'strip', 'jumpSwat', 'defSprint', 'strafe', 'pause'],
  returner: ['fairCatch', 'switchPlayer', 'defSprint', 'juke', 'spin', 'pause'],
  spectator: ['skipPlay', 'simSpeedUp', 'simSpeedDown', 'pause'],
  watch: ['jumpIn', 'skipPlay', 'simSpeedUp', 'simSpeedDown', 'pause'],
  dead: ['confirm', 'challenge', 'pause'],
  postPlay: ['confirm', 'challenge', 'showPlayArt', 'callTimeout', 'pause'],
  menu: ['confirm', 'back', 'pause'],
});

const LABELS: Readonly<Partial<Record<Action, string>>> = Object.freeze({
  snap: 'SNAP', showPlayArt: 'ART', audible: 'AUD', callTimeout: 'T.O.', pause: 'MENU', switchPlayer: 'SWITCH', kick: 'KICK',
  throw1: 'WR1', throw2: 'WR2', throw3: 'WR3', throw4: 'WR4', throw5: 'WR5', sprint: 'SPRINT', throwAway: 'AWAY', throwModifier: 'MOD',
  juke: 'JUKE', spin: 'SPIN', stiffArm: 'STIFF', hurdle: 'HURDLE', dive: 'DIVE', jumpSwat: 'SWAT', tackle: 'TACKLE', hitStick: 'HIT',
  strip: 'STRIP', defSprint: 'SPRINT', strafe: 'STRAFE', fairCatch: 'FAIR', skipPlay: 'SKIP', simSpeedUp: 'FAST', simSpeedDown: 'SLOW',
  jumpIn: 'JUMP IN', confirm: 'OK', back: 'BACK', challenge: 'FLAG',
});

/** Context-specific wording (the play-art button replays the play on the post-play card). */
const CONTEXT_LABELS: Readonly<Partial<Record<TouchContext, Partial<Record<Action, string>>>>> = Object.freeze({
  postPlay: { showPlayArt: 'REPLAY' },
});

/** Label for each touch button in a context, from the scheme (first context action bound to the button). */
export const touchLabelsFor = (context: TouchContext, scheme: ControlScheme, buttons: readonly Button[]): Partial<Record<Button, string>> => {
  const out: Partial<Record<Button, string>> = {};
  for (const button of buttons) {
    for (const action of CONTEXT_ACTIONS[context]) {
      if (scheme[action]?.includes(button)) {
        out[button] = CONTEXT_LABELS[context]?.[action] ?? LABELS[action] ?? action.toUpperCase();
        break;
      }
    }
  }
  return out;
};

/** Whether the overlay should be shown for a setting and the last device that produced input. */
export const shouldShowTouch = (setting: Settings['showTouchControls'], lastDevice: InputState['lastDevice']): boolean =>
  setting === 'on' || (setting === 'auto' && lastDevice === 'touch');

/** Receiver glyphs for the throw1..5 prompts on touch (tap the receiver) vs other devices (button glyphs). */
export const receiverGlyphs = (device: InputState['lastDevice'], glyph: (a: Action) => string, count: number): string[] => {
  const actions: Action[] = ['throw1', 'throw2', 'throw3', 'throw4', 'throw5'];
  return actions.slice(0, count).map((a, i) => (device === 'touch' ? String(i + 1) : glyph(a)));
};

/** A lit disc: dark rim, face, a lighter upper crescent and a darker foot (art-pixel ellipses). */
const drawDisc = (ctx: ArtCtx, x: number, y: number, r: number, face: string): void => {
  artEllipse(ctx, x, y + 0.5, r + 0.5, r + 0.5, UI_SLAB.edge, true);
  artEllipse(ctx, x, y, r, r, darken(face, 0.35), true);
  artEllipse(ctx, x, y - 0.5, r - 0.5, r - 1, face, true);
  artEllipse(ctx, x, y - r * 0.35, r * 0.62, r * 0.4, lighten(face, 0.25), true);
};

/**
 * True for a button with nothing to do in this context whose disc would sit on the score bug (the top-left BACK
 * button in play): it is left undrawn so no ghost disc covers the emblem and abbreviation. Its hit area is unchanged.
 */
export const hiddenUnderScoreBug = (b: { x: number; y: number; r: number }, active: boolean, theme: Theme): boolean => {
  if (active) return false;
  const bug = scoreBugRect(theme, 480);
  return b.x + b.r > bug.x && b.x - b.r < bug.x + bug.w && b.y + b.r > bug.y && b.y - b.r < bug.y + bug.h;
};

/**
 * A button's label: the Chunky font centred on the disc when it fits inside it; a longer word (SWITCH, SPRINT,
 * TACKLE ...) is set in the FINE face on a small ink chip centred on the disc and kept on screen, so it never spills
 * past the rim into the screen edge or a neighbouring button unreadably.
 */
const drawButtonLabel = (ctx: ArtCtx, theme: Theme, text: string, b: { x: number; y: number; r: number; pressed: boolean }, color: string, screenW: number): void => {
  const size = theme.textScale;
  const m = measureText(text, size);
  const shadow = b.pressed ? null : UI_SLAB.edge;
  if (m.width <= b.r * 2 - 2) {
    drawText(ctx, text, b.x, Math.round(b.y - m.height / 2), { color, size, align: 'center', shadow });
    return;
  }
  const sm = measureSmallText(ctx, theme, text);
  const w = sm.width + 4;
  const h = sm.height + 4;
  const left = Math.round(Math.min(screenW - 1 - w, Math.max(1, b.x - w / 2)));
  const top = Math.round(b.y - h / 2);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * 0.85;
  drawSlab(ctx, left, top, w, h, { fill: UI_SLAB.ink, outline: UI_SLAB.edge, texture: false });
  ctx.globalAlpha = prev;
  drawSmallText(ctx, theme, text, left + 2, top + 2, { color, shadow });
};

/** Draws the stick zone/knob and the labelled buttons (hit areas are the layout's, unchanged). */
export const drawTouchOverlay = (ctx: FillCtx & { globalAlpha: number }, theme: Theme, layout: TouchLayout, labels: Partial<Record<Button, string>>): void => {
  markTouchOverlay();
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const prev = ctx.globalAlpha;
  const stick = layout.stick;
  const origin = stick.origin ?? { x: stick.zone.x + stick.zone.w * 0.35, y: stick.zone.y + stick.zone.h * 0.62 };
  ctx.globalAlpha = prev * (stick.active ? 0.3 : 0.16);
  artEllipse(art, origin.x, origin.y, stick.radius, stick.radius, UI_SLAB.edge, true);
  ctx.globalAlpha = prev * (stick.active ? 0.55 : 0.28);
  pixelEllipse(ctx, origin.x, origin.y, stick.radius, stick.radius, c.text, false);
  // Four direction ticks on the ring.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    artLine(art, origin.x + dx * (stick.radius - 3), origin.y + dy * (stick.radius - 3), origin.x + dx * (stick.radius - 1), origin.y + dy * (stick.radius - 1), c.text, 2);
  }
  const knob = stick.knob ?? origin;
  ctx.globalAlpha = prev * (stick.active ? 0.85 : 0.4);
  drawDisc(art, knob.x, knob.y, Math.max(3, stick.radius * 0.35), c.accent);
  for (const b of layout.buttons) {
    const label = labels[b.button];
    const active = label !== undefined;
    if (hiddenUnderScoreBug(b, active, theme)) continue;
    ctx.globalAlpha = prev * (b.pressed ? 0.92 : active ? 0.62 : 0.22);
    drawDisc(art, b.x, b.y + (b.pressed ? 0.5 : 0), b.r, b.pressed ? c.accent : c.panelLight);
    pixelEllipse(ctx, b.x, b.y, b.r, b.r, b.pressed ? lighten(c.accent, 0.3) : c.text, false);
    ctx.globalAlpha = prev * (active ? 1 : 0.45);
    drawButtonLabel(art, theme, label ?? b.label, b, b.pressed ? c.textInverse : c.text, layout.width);
  }
  ctx.globalAlpha = prev;
};

/**
 * Widest centred strip along the bottom of the screen that clears the touch buttons in the lower half (the LT / RT
 * column and the face buttons), so the caption never runs under a button.
 */
export const captionWidthClearOf = (layout: TouchLayout, width: number, height: number, margin: number): number => {
  const low = layout.buttons.filter((b) => b.y > height / 2);
  if (low.length === 0) return width;
  const right = Math.min(...low.filter((b) => b.x > width / 2).map((b) => b.x - b.r), width);
  const left = Math.max(...low.filter((b) => b.x <= width / 2).map((b) => b.x + b.r), 0);
  const half = Math.min(right - width / 2, width / 2 - left) - margin;
  return Math.max(0, Math.round(half * 2));
};
