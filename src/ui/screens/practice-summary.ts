/**
 * Practice summary: the drill's letter grade, reps, success rate, best streak and points, plus the last reps as a
 * result log, with RUN IT AGAIN / CHANGE DRILL / MAIN MENU.
 */
import type { DrillSummary } from '@/game/practice/session';
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import { MenuList } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawBackdrop } from './main-menu';
import { fitHints } from './practice-hud';
import type { RenderContext, Screen, ScreenServices } from './screen';

/** Where the summary screen goes next. */
export interface PracticeSummaryActions {
  onAgain: () => void;
  onChangeDrill: () => void;
  onQuit: () => void;
}

/** Rows of the summary's stat block (label, value), most important first (large text shows as many as fit). */
export const summaryRows = (s: DrillSummary): [string, string][] => [
  ['SUCCESS', `${s.successes}/${s.reps}  ${Math.round(s.successRate * 100)}%`],
  ['POINTS', String(s.totalPoints)],
  ['BEST STREAK', String(s.bestStreak)],
  ['REPS', String(s.reps)],
  ['AVG / REP', String(s.averagePoints)],
];

/** Shows a finished drill's summary with replay / change / menu choices. */
export class PracticeSummaryScreen implements Screen {
  readonly id = 'practiceSummary';
  private readonly menu = new MenuList([
    { id: 'again', label: 'RUN IT AGAIN' },
    { id: 'change', label: 'CHANGE DRILL' },
    { id: 'quit', label: 'MAIN MENU' },
  ]);
  private services: ScreenServices | null = null;

  constructor(readonly summary: DrillSummary, private readonly actions: PracticeSummaryActions) {}

  get list(): MenuList {
    return this.menu;
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  activate(id: string): void {
    if (id === 'again') this.actions.onAgain();
    else if (id === 'change') this.actions.onChangeDrill();
    else if (id === 'quit') this.actions.onQuit();
  }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (ev?.type === 'activate') this.activate(ev.item.id);
    else if (ev?.type === 'back') this.actions.onChangeDrill();
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    drawBackdrop(ctx, theme, width, height, rc.time);
    const panelW = Math.min(width - theme.pad * 2, 300 * s);
    const x = Math.round((width - panelW) / 2);
    const content = drawPanel(ctx, theme, x, theme.pad, panelW, height - theme.pad * 3 - theme.glyphH - 4 * s, { style: 'raised', title: 'DRILL COMPLETE' });
    const sum = this.summary;
    drawText(ctx, sum.name, content.x, content.y, { color: c.accent, size: s, shadow: c.shadow });
    const gradeSize = Math.min(3, s + 2) as 1 | 2 | 3;
    const gw = measureText(sum.grade, gradeSize).width;
    const gradeColor = sum.grade === 'A' || sum.grade === 'B' ? c.success : sum.grade === 'F' || sum.grade === 'D' ? c.danger : c.warning;
    drawText(ctx, sum.grade, content.x + content.w - gw, content.y, { color: gradeColor, size: gradeSize, shadow: c.shadow });
    const lineH = theme.glyphH + theme.gap;
    // The menu is anchored to the bottom; stats, then the latest reps, fill what is left above it.
    const menuY = content.y + content.h - this.menu.measure(theme);
    const fits = (y: number): boolean => y + theme.glyphH <= menuY - theme.gap;
    let y = content.y + Math.max(lineH, measureText(sum.grade, gradeSize).height) + theme.gap;
    for (const [label, value] of summaryRows(sum)) {
      if (!fits(y)) break;
      drawText(ctx, label, content.x, y, { color: c.textDim, size: s });
      drawText(ctx, value, content.x + Math.round(content.w * 0.45), y, { color: c.text, size: s });
      y += lineH;
    }
    y += theme.gap;
    for (const r of sum.records.slice(-4)) {
      if (!fits(y)) break;
      drawText(ctx, `${r.index + 1}. ${r.verdict.success ? '+' : 'X'} ${r.verdict.headline}`, content.x, y, { color: r.verdict.success ? c.success : c.danger, size: s });
      if (r.points > 0) drawText(ctx, `+${r.points}`, content.x + content.w, y, { color: c.text, size: s, align: 'right' });
      y += lineH;
    }
    this.menu.draw(ctx, theme, content.x, menuY, content.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, fitHints(theme, [{ glyph: input?.glyph('confirm') ?? 'A', label: 'SELECT' }, { glyph: input?.glyph('back') ?? 'B', label: 'DRILLS' }], width), width, height - theme.pad - theme.glyphH - 4 * s);
  }
}
