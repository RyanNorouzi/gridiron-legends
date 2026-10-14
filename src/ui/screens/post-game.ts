/**
 * Post-game screen: final score header, tabs for the team stat comparison, leaders per side, the scoring
 * summary and a scrollable play log, and two actions (play again / main menu). Tabs cycle with LB/RB or
 * left/right, the log scrolls with up/down, the actions toggle with left/right on the bottom row.
 */
import type { PostGameData } from '../game/box-score';
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawScreenBackdrop } from '../widgets/title-backdrop';
import { drawDisplayText } from '../widgets/text-display';
import { drawSlabButton, drawStripTab } from '../widgets/headers';
import { fillAlpha, type ArtCtx } from '../widgets/ui-art';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface PostGameActions {
  onPlayAgain: () => void;
  onMenu: () => void;
}

export type PostGameTab = 'team' | 'leaders' | 'scoring' | 'log';
export const POST_GAME_TABS: readonly { id: PostGameTab; label: string }[] = [
  { id: 'team', label: 'TEAM STATS' }, { id: 'leaders', label: 'LEADERS' }, { id: 'scoring', label: 'SCORING' }, { id: 'log', label: 'PLAY LOG' },
];

export class PostGameScreen implements Screen {
  readonly id = 'postGame';
  private tabIndex = 0;
  private scroll = 0;
  private action = 0;
  private services: ScreenServices | null = null;

  constructor(readonly data: PostGameData, private readonly actions: PostGameActions) {}

  get tab(): PostGameTab {
    return (POST_GAME_TABS[this.tabIndex] as { id: PostGameTab }).id;
  }

  get scrollOffset(): number {
    return this.scroll;
  }

  enter(services: ScreenServices): void {
    this.services = services;
  }

  exit(): void {
    this.services = null;
  }

  setTab(index: number): void {
    const n = POST_GAME_TABS.length;
    this.tabIndex = ((index % n) + n) % n;
    this.scroll = 0;
  }

  private rowsFor(tab: PostGameTab): string[] {
    const d = this.data;
    switch (tab) {
      case 'team': return d.teamRows.map((r) => `${r.label}|${r.away}|${r.home}`);
      case 'leaders': {
        const out: string[] = [];
        for (const side of ['away', 'home'] as const) {
          out.push(`== ${d.abbr[side]} ==`);
          const l = d.leaders[side];
          const cat = (label: string, rows: { name: string; position: string; line: string }[]): void => {
            for (const r of rows) out.push(`${label} ${r.name} (${r.position}): ${r.line}`);
          };
          cat('PASS', l.passing);
          cat('RUSH', l.rushing);
          cat('REC', l.receiving);
          cat('DEF', l.defense);
          cat('K', l.kicking);
        }
        return out;
      }
      case 'scoring': return d.scoring.length ? d.scoring.map((s) => `Q${s.quarter} ${s.clock} ${d.abbr[s.side]} · ${s.text} (${d.abbr.away} ${s.score.away} - ${d.abbr.home} ${s.score.home})`) : ['NO SCORING'];
      case 'log': return d.playLog.length ? d.playLog : ['NO PLAYS'];
    }
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    void dt;
    if (input.justPressed.has('menuTabLeft')) this.setTab(this.tabIndex - 1);
    if (input.justPressed.has('menuTabRight')) this.setTab(this.tabIndex + 1);
    if (input.justPressed.has('menuLeft')) this.action = 0;
    if (input.justPressed.has('menuRight')) this.action = 1;
    const rows = this.rowsFor(this.tab).length;
    if (input.justPressed.has('menuUp') || input.axis.y < -0.5) this.scroll = Math.max(0, this.scroll - 1);
    if (input.justPressed.has('menuDown') || input.axis.y > 0.5) this.scroll = Math.max(0, Math.min(Math.max(0, rows - 1), this.scroll + 1));
    if (input.justPressed.has('confirm')) {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      if (this.action === 0) this.actions.onPlayAgain();
      else this.actions.onMenu();
    } else if (input.justPressed.has('back')) {
      services.audio?.onGameEvent({ type: 'menuBack' });
      this.actions.onMenu();
    }
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const c = theme.colors;
    const s = theme.textScale;
    const d = this.data;
    const art = ctx as ArtCtx;
    drawScreenBackdrop(art, theme, width, height, rc.time);
    const hintH = theme.glyphH + 4 * s;
    const header = `${d.abbr.away} ${d.score.away}  ·  ${d.abbr.home} ${d.score.home}`;
    drawDisplayText(art, header, width / 2, Math.max(2, theme.pad - 4 * s), { k: Math.min(3, s + 1), align: 'center', color: c.accent });
    const sub = `FINAL${d.overtime ? ' · OT' : ''}  ·  ${d.winner ? `${d.names[d.winner].toUpperCase()} WIN` : 'TIE'}`;
    drawText(ctx, sub, width / 2, theme.pad + theme.glyphH * 2, { size: s, align: 'center', color: c.textDim });
    const panelY = theme.pad + theme.glyphH * 3 + theme.gap;
    const panelH = height - panelY - hintH - theme.pad * 2 - theme.lineHeight;
    const content = drawPanel(ctx, theme, theme.pad, panelY, width - theme.pad * 2, panelH, { style: 'raised' });
    let tx = content.x;
    POST_GAME_TABS.forEach((t, i) => {
      const m = measureText(t.label, s);
      drawStripTab(art, theme, t.label, tx, content.y, m.width + theme.gap * 2, i === this.tabIndex);
      tx += m.width + theme.gap * 3;
    });
    const listY = content.y + theme.glyphH + theme.gap * 2;
    const lineH = theme.glyphH + theme.gap;
    const visible = Math.max(1, Math.floor((content.y + content.h - listY) / lineH));
    const rows = this.rowsFor(this.tab);
    const start = Math.min(this.scroll, Math.max(0, rows.length - visible));
    if (this.tab === 'team') {
      drawText(ctx, d.abbr.away, content.x + content.w * 0.62, listY - lineH, { color: c.textDim, size: s, align: 'right' });
      drawText(ctx, d.abbr.home, content.x + content.w - theme.gap, listY - lineH, { color: c.textDim, size: s, align: 'right' });
    }
    rows.slice(start, start + visible).forEach((row, i) => {
      const y = listY + i * lineH;
      // Zebra rows (the table style of the franchise kit).
      if ((start + i) % 2 === 1) fillAlpha(art, c.bgAlt, 0.9, content.x, y - Math.floor(theme.gap / 2), content.w, lineH);
      if (this.tab === 'team') {
        const [label, away, home] = row.split('|') as [string, string, string];
        drawText(ctx, label, content.x + theme.gap, y, { color: c.text, size: s });
        drawText(ctx, away, content.x + content.w * 0.62, y, { color: c.text, size: s, align: 'right' });
        drawText(ctx, home, content.x + content.w - theme.gap, y, { color: c.text, size: s, align: 'right' });
      } else {
        const maxChars = Math.floor(content.w / (6 * s)) - 1;
        const text = row.length > maxChars ? `${row.slice(0, maxChars - 1)}…` : row;
        drawText(ctx, text, content.x + theme.gap, y, { color: row.startsWith('==') ? c.accent : c.text, size: s });
      }
    });
    if (rows.length > visible) drawText(ctx, `${start + 1}-${Math.min(rows.length, start + visible)} / ${rows.length}`, content.x + content.w - theme.gap, content.y, { color: c.textDim, size: s, align: 'right' });
    const buttons = ['PLAY AGAIN', 'MAIN MENU'];
    const by = panelY + panelH + theme.gap;
    buttons.forEach((label, i) => {
      const bx = width / 2 + (i === 0 ? -1 : 1) * (width * 0.18);
      drawSlabButton(art, theme, label, bx, by, i === this.action);
    });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'SELECT' },
      { glyph: `${input?.glyph('menuTabLeft') ?? 'LB'} ${input?.glyph('menuTabRight') ?? 'RB'}`, label: 'TABS' },
      { glyph: `${input?.glyph('menuUp') ?? '↑'} ${input?.glyph('menuDown') ?? '↓'}`, label: 'SCROLL' },
    ], width, height - hintH - theme.pad);
  }
}
