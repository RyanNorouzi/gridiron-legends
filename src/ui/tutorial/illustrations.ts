/**
 * Procedural illustrations for the tutorial's info pages: a mini field, a play-call card with real play art,
 * a scoreboard clock, and the franchise diagrams (roster table, depth chart, cap bar, draft board, free-agent
 * offers, a trade). Everything is drawn with rectangles and the pixel font inside a box, scaled by the theme.
 */
import { loadPlaybookData } from '@/playbook/loader';
import { drawPlayArt } from '../game/play-art';
import { drawText, measureText } from '../render/text';
import type { Theme } from '../theme';
import type { UiCtx } from '../widgets/panel';

/** Illustrations the info pages can show. */
export type IllustrationId = 'field' | 'playcall' | 'clock' | 'roster' | 'depthChart' | 'cap' | 'draft' | 'freeAgency' | 'trade';

/** Every illustration id. */
export const ILLUSTRATIONS: readonly IllustrationId[] = Object.freeze(['field', 'playcall', 'clock', 'roster', 'depthChart', 'cap', 'draft', 'freeAgency', 'trade']);

/** Logical-pixel box an illustration is drawn into. */
export interface ArtBox { x: number; y: number; w: number; h: number }

/** The sample call the play-calling pages illustrate. */
export const SAMPLE_PLAY_ID = 'shotgun-slants';

const GOLD = '#d9a21b';
const SCOUT = '#3f78b5';

const frame = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  ctx.fillStyle = theme.colors.panelBorder;
  ctx.fillRect(b.x, b.y, b.w, 1);
  ctx.fillRect(b.x, b.y + b.h - 1, b.w, 1);
  ctx.fillRect(b.x, b.y, 1, b.h);
  ctx.fillRect(b.x + b.w - 1, b.y, 1, b.h);
};

const label = (ctx: UiCtx, theme: Theme, text: string, x: number, y: number, color = theme.colors.text): void => {
  drawText(ctx, text, x, y, { color, size: theme.textScale });
};

const drawField = (ctx: UiCtx, theme: Theme, b: ArtBox, time: number): void => {
  ctx.fillStyle = '#2f6b34';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  const ez = Math.round(b.w * 0.08);
  ctx.fillStyle = GOLD;
  ctx.fillRect(b.x, b.y, ez, b.h);
  ctx.fillStyle = SCOUT;
  ctx.fillRect(b.x + b.w - ez, b.y, ez, b.h);
  ctx.fillStyle = '#e8f0e8';
  for (let i = 0; i <= 10; i++) ctx.fillRect(Math.round(b.x + ez + ((b.w - 2 * ez) * i) / 10), b.y, 1, b.h);
  const los = Math.round(b.x + b.w * 0.45);
  ctx.fillStyle = theme.colors.los;
  ctx.fillRect(los, b.y, 1, b.h);
  const bob = theme.reducedMotion ? 0 : Math.round(Math.sin(time * 3));
  for (let i = 0; i < 5; i++) {
    const y = Math.round(b.y + (b.h * (i + 1)) / 6);
    ctx.fillStyle = GOLD;
    ctx.fillRect(los - 5, y + bob, 3, 3);
    ctx.fillStyle = SCOUT;
    ctx.fillRect(los + 3, y - bob, 3, 3);
  }
};

const drawPlaycallCard = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  ctx.fillStyle = theme.colors.bgAlt;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  const registry = loadPlaybookData();
  const play = registry.offensePlays[SAMPLE_PLAY_ID];
  const titleH = theme.glyphH + theme.gap;
  label(ctx, theme, play ? play.name.toUpperCase() : 'SAMPLE CALL', b.x + theme.gap, b.y + theme.gap, theme.colors.accent);
  if (play) drawPlayArt(ctx, play, registry, { x: b.x + 2, y: b.y + titleH + theme.gap, w: b.w - 4, h: b.h - titleH - theme.gap - 2 }, { theme, highlightRole: play.primary });
};

const drawClock = (ctx: UiCtx, theme: Theme, b: ArtBox, time: number): void => {
  const c = theme.colors;
  ctx.fillStyle = c.shadow;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  const s = Math.min(3, theme.textScale + 1) as 1 | 2 | 3;
  const secs = theme.reducedMotion ? 42 : 42 - (Math.floor(time) % 40);
  const text = `Q4  0:${String(Math.max(2, secs)).padStart(2, '0')}`;
  drawText(ctx, text, b.x + b.w / 2, b.y + theme.pad, { size: s, align: 'center', color: c.accent });
  const pipY = b.y + theme.pad * 2 + measureText(text, s).height;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < 2 ? c.warning : c.textDim;
    ctx.fillRect(Math.round(b.x + b.w / 2 - 14 + i * 10), pipY, 6, 3);
  }
  label(ctx, theme, 'TIMEOUTS', Math.round(b.x + b.w / 2 - measureText('TIMEOUTS', theme.textScale).width / 2), pipY + theme.gap + 3, c.textDim);
};

const ROSTER_ROWS: readonly (readonly [string, string, string, string])[] = [['QB', '84', '27', 'STAR'], ['RB', '77', '23', 'RISING'], ['WR', '81', '30', 'VETERAN'], ['CB', '69', '21', 'ROOKIE']];

const drawRoster = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  const c = theme.colors;
  const lineH = theme.glyphH + theme.gap;
  const cols = [0, 0.22, 0.42, 0.62].map((f) => Math.round(b.x + theme.gap + (b.w - theme.gap * 2) * f));
  ['POS', 'OVR', 'AGE', 'NOTE'].forEach((h, i) => label(ctx, theme, h, cols[i] as number, b.y + theme.gap, c.textDim));
  ROSTER_ROWS.forEach((row, r) => {
    const y = b.y + theme.gap + lineH * (r + 1);
    if (r % 2 === 0) {
      ctx.fillStyle = c.panelLight;
      ctx.fillRect(b.x + 1, y - 1, b.w - 2, lineH);
    }
    row.forEach((v, i) => label(ctx, theme, v, cols[i] as number, y, i === 1 ? c.success : c.text));
  });
};

const drawDepth = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  const c = theme.colors;
  const lineH = theme.glyphH + theme.gap * 2;
  const rows: [string, string, string][] = [['QB', '1 STARTER', '2 BACKUP'], ['RB', '1 STARTER', '2 CHANGE-UP'], ['WR', '1 X', '2 Z']];
  rows.forEach(([pos, a, bb], i) => {
    const y = b.y + theme.gap + i * lineH;
    label(ctx, theme, pos, b.x + theme.gap, y, c.accent);
    const x1 = b.x + Math.round(b.w * 0.2);
    ctx.fillStyle = c.selection;
    ctx.fillRect(x1 - 2, y - 2, Math.round(b.w * 0.36), theme.glyphH + 4);
    label(ctx, theme, a, x1, y);
    label(ctx, theme, bb, b.x + Math.round(b.w * 0.6), y, c.textDim);
  });
};

const drawCap = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  const c = theme.colors;
  const barY = b.y + Math.round(b.h * 0.35);
  const barH = Math.max(8, Math.round(b.h * 0.25));
  const inner = b.w - theme.gap * 2;
  const segs: [number, string][] = [[0.38, c.accent], [0.22, c.accent2], [0.26, c.warning]];
  let x = b.x + theme.gap;
  for (const [f, col] of segs) {
    const w = Math.round(inner * f);
    ctx.fillStyle = col;
    ctx.fillRect(x, barY, w - 1, barH);
    x += w;
  }
  const capX = b.x + theme.gap + Math.round(inner * 0.94);
  ctx.fillStyle = c.danger;
  ctx.fillRect(capX, barY - theme.gap, 1, barH + theme.gap * 2);
  label(ctx, theme, 'SALARIES', b.x + theme.gap, b.y + theme.gap, c.textDim);
  label(ctx, theme, 'CAP', capX - measureText('CAP', theme.textScale).width, barY + barH + theme.gap * 2, c.danger);
  label(ctx, theme, 'SPACE', b.x + theme.gap + Math.round(inner * 0.86) - measureText('SPACE', theme.textScale).width, b.y + theme.gap, c.success);
};

const drawDraft = (ctx: UiCtx, theme: Theme, b: ArtBox, time: number): void => {
  const c = theme.colors;
  const cols = 4;
  const rows = 3;
  const cw = Math.floor((b.w - theme.gap * 2) / cols);
  const ch = Math.floor((b.h - theme.gap * 2) / rows);
  const onClock = 5;
  const blink = theme.reducedMotion || Math.floor(time * 2) % 2 === 0;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const i = r * cols + k;
      const x = b.x + theme.gap + k * cw;
      const y = b.y + theme.gap + r * ch;
      ctx.fillStyle = i < onClock ? c.panelLight : i === onClock && blink ? c.accent : c.panel;
      ctx.fillRect(x, y, cw - 2, ch - 2);
      label(ctx, theme, `${r + 1}.${k + 1}`, x + 2, y + 2, i === onClock ? c.bg : i < onClock ? c.textDim : c.text);
    }
  }
};

const drawFreeAgency = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  const c = theme.colors;
  const lineH = theme.glyphH + theme.gap * 2;
  const offers: [string, number, string][] = [['YOU', 0.8, GOLD], ['TEAM B', 0.65, SCOUT], ['TEAM C', 0.5, c.textDim]];
  label(ctx, theme, 'OFFERS FOR WR #81', b.x + theme.gap, b.y + theme.gap, c.accent);
  offers.forEach(([name, f, col], i) => {
    const y = b.y + theme.gap + lineH * (i + 1);
    label(ctx, theme, name, b.x + theme.gap, y);
    const x = b.x + Math.round(b.w * 0.35);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, Math.round((b.w * 0.6) * f), theme.glyphH);
  });
};

const drawTrade = (ctx: UiCtx, theme: Theme, b: ArtBox): void => {
  const c = theme.colors;
  const half = Math.round(b.w / 2);
  const card = (x: number, title: string, lines: string[], col: string): void => {
    ctx.fillStyle = col;
    ctx.fillRect(x + theme.gap, b.y + theme.gap, half - theme.gap * 3, 2);
    label(ctx, theme, title, x + theme.gap, b.y + theme.gap * 2, col);
    lines.forEach((l, i) => label(ctx, theme, l, x + theme.gap, b.y + theme.gap * 3 + (theme.glyphH + theme.gap) * (i + 1)));
  };
  card(b.x, 'YOU SEND', ['RB 74', '2ND ROUND'], GOLD);
  card(b.x + half, 'YOU GET', ['DE 80'], SCOUT);
  const midY = b.y + Math.round(b.h * 0.7);
  drawText(ctx, '◀ ▶', b.x + half, midY, { color: c.accent, size: theme.textScale, align: 'center' });
};

/** Draws an illustration inside `box`. */
export const drawIllustration = (ctx: UiCtx, theme: Theme, id: IllustrationId, box: ArtBox, time = 0): void => {
  const b = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
  if (b.w < 8 || b.h < 8) return;
  ctx.fillStyle = theme.colors.panel;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  switch (id) {
    case 'field': drawField(ctx, theme, b, time); break;
    case 'playcall': drawPlaycallCard(ctx, theme, b); break;
    case 'clock': drawClock(ctx, theme, b, time); break;
    case 'roster': drawRoster(ctx, theme, b); break;
    case 'depthChart': drawDepth(ctx, theme, b); break;
    case 'cap': drawCap(ctx, theme, b); break;
    case 'draft': drawDraft(ctx, theme, b, time); break;
    case 'freeAgency': drawFreeAgency(ctx, theme, b); break;
    case 'trade': drawTrade(ctx, theme, b); break;
  }
  frame(ctx, theme, b);
};
