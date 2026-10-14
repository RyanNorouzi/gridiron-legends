/**
 * Drill HUD: a pure projection of the DrillSession (goal, rep count, success rate, streak and multiplier, points,
 * the last rep's result) plus the context-sensitive button hints, and the drawing of both. Layout derives from
 * theme metrics, so large-text mode simply grows the panels.
 */
import { drillGoal, OPTION_CHOICES } from '@/game/practice/drills';
import type { RepRecord, DrillSession } from '@/game/practice/session';
import type { DrillDefinition } from '@/game/practice/types';
import type { PlayInputContext } from '../game/play-input';
import type { Action } from '../input/types';
import { drawText, measureText, wrapText } from '../render/text';
import type { Theme } from '../theme';
import { drawPanel, measureButtonHint, type ButtonHint, type UiCtx } from '../widgets/panel';

/** Everything the drill HUD shows, projected from the session. */
export interface DrillHudData {
  title: string;
  goal: string;
  difficulty: string;
  /** 1-based number of the rep in progress. */
  rep: number;
  reps: number;
  successes: number;
  /** 0..100, rounded. */
  ratePct: number;
  streak: number;
  /** Multiplier the next success earns. */
  multiplier: number;
  points: number;
  bestStreak: number;
  last: { success: boolean; headline: string; detail: string; points: number } | null;
}

const DIFFICULTY_TEXT: Readonly<Record<(typeof OPTION_CHOICES.difficulty)[number], string>> = { rookie: 'ROOKIE', pro: 'PRO', allPro: 'ALL-PRO', legend: 'LEGEND' };

/** HUD data for a session (the rep in progress is `reps + 1`). */
export const buildDrillHud = (session: DrillSession, last: RepRecord | null = null): DrillHudData => ({
  title: session.def.name,
  goal: drillGoal(session.def, session.options),
  difficulty: DIFFICULTY_TEXT[session.options.difficulty],
  rep: session.reps + 1,
  reps: session.reps,
  successes: session.successes,
  ratePct: Math.round(session.successRate * 100),
  streak: session.streak,
  multiplier: session.nextMultiplier,
  points: session.totalPoints,
  bestStreak: session.bestStreak,
  last: last ? { success: last.verdict.success, headline: last.verdict.headline, detail: last.verdict.detail, points: last.points } : null,
});

/** "x1.75" style multiplier text. */
export const multiplierText = (m: number): string => `X${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(2).replace(/0$/, '')}`;

/** The leading hints that fit in one bar across `width` (long glyphs or large text drop the least important). */
export const fitHints = (theme: Theme, hints: readonly ButtonHint[], width: number): ButtonHint[] => {
  const out: ButtonHint[] = [];
  let used = 0;
  for (const h of hints) {
    const w = measureButtonHint(theme, h) + (out.length > 0 ? theme.pad : 0);
    if (used + w > width - theme.pad * 2) break;
    out.push(h);
    used += w;
  }
  return out;
};

/** Button hints for the user's current play context in a drill (glyphs from the live input manager). */
export const drillHints = (def: DrillDefinition, context: PlayInputContext, glyph: (a: Action) => string): ButtonHint[] => {
  const h = (a: Action, label: string): ButtonHint => ({ glyph: glyph(a), label });
  const out: ButtonHint[] = [];
  switch (context) {
    case 'presnapOffense':
      out.push(h('snap', 'SNAP'));
      if (def.userUnit === 'offense' && def.control === 'engine' && def.evaluator === 'completion') out.push(h('showPlayArt', 'ROUTES'));
      break;
    case 'presnapDefense': out.push(h('switchPlayer', 'SWITCH')); break;
    // Horizontal field: a kick's lateral aim runs across the field, i.e. up / down on screen.
    case 'kick': out.push(h('kick', 'KICK METER'), { glyph: `${glyph('moveUp')}${glyph('moveDown')}`, label: 'AIM' }); break;
    case 'qb': out.push(h('throw1', 'PRIMARY'), h('throwAway', 'THROW AWAY'), h('sprint', 'SCRAMBLE')); break;
    case 'carrier': out.push(h('sprint', 'SPRINT'), h('juke', 'JUKE'), h('spin', 'SPIN'), h('stiffArm', 'STIFF ARM')); break;
    case 'receiver': out.push(h('sprint', 'SPRINT'), h('jumpSwat', 'GO UP'), h('dive', 'DIVE')); break;
    case 'defense': out.push(h('tackle', 'TACKLE'), h('hitStick', 'HIT STICK'), h('switchPlayer', 'SWITCH'), h('jumpSwat', 'JUMP')); break;
    case 'returner': out.push(h('fairCatch', 'FAIR CATCH'), h('sprint', 'SPRINT')); break;
    default: break;
  }
  out.push(h('pause', 'MENU'));
  return out;
};

/** Draws the goal panel (top-left) and the scoreboard (top-right). */
export const drawDrillHud = (ctx: UiCtx, theme: Theme, data: DrillHudData, width: number): void => {
  const c = theme.colors;
  const s = theme.textScale;
  const pad = theme.gap;
  const lineH = theme.glyphH + theme.gap;
  // Scoreboard first so the goal panel knows how much width is left.
  const rows = [
    `REP ${data.rep}  ${data.difficulty}`,
    `${data.successes}/${data.reps}  ${data.ratePct}%`,
    `STREAK ${data.streak} ${multiplierText(data.multiplier)}`,
    `PTS ${data.points}`,
  ];
  const boardW = Math.max(...rows.map((r) => measureText(r, s).width)) + pad * 2 + theme.border * 2;
  const boardH = rows.length * lineH + pad + theme.border * 2;
  const boardX = width - boardW - theme.pad;
  drawPanel(ctx, theme, boardX, theme.pad, boardW, boardH, { style: 'solid', alpha: 0.85 });
  rows.forEach((r, i) => {
    const color = i === 2 && data.streak > 0 ? c.accent : i === 3 ? c.success : c.text;
    drawText(ctx, r, boardX + theme.border + pad, theme.pad + theme.border + pad + i * lineH, { color, size: s });
  });
  const goalW = Math.max(80 * s, boardX - theme.pad * 2);
  const goalLines = wrapText(data.goal, goalW - pad * 2 - theme.border * 2, s).slice(0, 3);
  const goalH = (goalLines.length + 1) * lineH + pad + theme.border * 2;
  drawPanel(ctx, theme, theme.pad, theme.pad, goalW, goalH, { style: 'solid', alpha: 0.85 });
  const gx = theme.pad + theme.border + pad;
  let gy = theme.pad + theme.border + pad;
  drawText(ctx, data.title, gx, gy, { color: c.accent, size: s, shadow: c.shadow });
  gy += lineH;
  for (const line of goalLines) {
    drawText(ctx, line, gx, gy, { color: c.text, size: s });
    gy += lineH;
  }
};
