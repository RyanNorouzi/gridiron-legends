/**
 * Week recap screen (pushed full-screen after a played or simulated week / stretch). Sections on a tab bar:
 * Your Game (box score and leaders, when the user played one game), Results (his games over a longer stretch),
 * Scoreboard (the last week's games) and Headlines. U/O or LB/RB switch sections (or tap a tab), Up/Down scroll,
 * Confirm on a line about a player or team opens it, Back / Start / the CONTINUE button close the recap.
 */
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { drawHintBar } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable, fitCell } from '../kit/data-table-view';
import { inRect, pressed, type Rect } from '../kit/list';
import { TabBar, drawTabBar, type TabSpec } from '../kit/tabbar';
import type { RecapLine, RecapView, ScoreRow } from './recap-model';
import { drawButton, glyphOf, hintBarHeight } from './widgets';

type BoxRow = { id: string; label: string; away: string; home: string; tone: RecapLine['tone'] };
type AnyTable = DataTable<BoxRow> | DataTable<RecapLine> | DataTable<ScoreRow>;

/** Sections the recap offers for a view (Headlines always). */
export const recapSections = (v: RecapView): TabSpec[] => [
  ...(v.box ? [{ id: 'box', label: 'Your Game' }] : []),
  ...(v.results.length > (v.box ? 1 : 0) ? [{ id: 'results', label: 'Results' }] : []),
  ...(v.scoreboard.length > 0 ? [{ id: 'scores', label: 'Scoreboard' }] : []),
  { id: 'headlines', label: 'Headlines' },
];

const lineColumns: Column<RecapLine>[] = [{ key: 'text', label: '', flex: 1, format: (l) => ({ text: l.text, tone: l.tone }) }];

const scoreColumns: Column<ScoreRow>[] = [
  { key: 'away', label: 'AWAY', width: 4, format: (r) => ({ text: r.away, tone: r.winner === 'away' ? 'success' : 'normal' }) },
  { key: 'as', label: 'PTS', width: 3, align: 'right', format: (r) => String(r.awayScore) },
  { key: 'home', label: 'HOME', width: 4, format: (r) => ({ text: r.home, tone: r.winner === 'home' ? 'success' : 'normal' }) },
  { key: 'hs', label: 'PTS', width: 3, align: 'right', format: (r) => String(r.homeScore) },
  { key: 'note', label: '', flex: 1, minWidth: 5, format: (r) => ({ text: r.user ? `${r.note} *` : r.note, tone: r.user ? 'accent' : 'dim' }) },
];

const boxColumns = (v: NonNullable<RecapView['box']>): Column<BoxRow>[] => [
  { key: 'label', label: 'STAT', flex: 1, format: (r) => ({ text: r.label, tone: r.tone }) },
  { key: 'away', label: v.awayAbbr, width: 7, align: 'right', format: (r) => r.away },
  { key: 'home', label: v.homeAbbr, width: 7, align: 'right', format: (r) => r.home },
];

/** Builds the table of one recap section. */
export const recapTable = (v: RecapView, section: string): AnyTable => {
  if (section === 'box' && v.box) {
    const rows: BoxRow[] = [...v.box.rows.map((r) => ({ ...r, tone: 'normal' as const })), ...v.box.leaders.map((l) => ({ id: l.id, label: l.text, away: '', home: '', tone: 'dim' as const }))];
    return new DataTable(boxColumns(v.box), rows, { rowId: (r) => r.id });
  }
  if (section === 'scores') return new DataTable(scoreColumns, v.scoreboard, { rowId: (r) => r.id });
  const lines = section === 'results' ? v.results : v.headlines;
  return new DataTable(lineColumns, lines, { rowId: (l) => l.id, showHeader: false, emptyText: 'Nothing notable' });
};

/** Full-screen recap; `onClose` runs after it popped itself. */
export class WeekRecapScreen implements Screen {
  readonly id = 'franchise-recap';
  private services: ScreenServices | null = null;
  private readonly bar: TabBar;
  private tableValue: AnyTable;
  private continueRect: Rect | null = null;
  private closed = false;

  constructor(private readonly fc: FranchiseContext, readonly view: RecapView, private readonly onClose: () => void = () => undefined) {
    this.bar = new TabBar(recapSections(view));
    this.tableValue = recapTable(view, this.section);
  }

  get section(): string { return this.bar.current?.id ?? 'headlines'; }
  get table(): AnyTable { return this.tableValue; }
  get tabs(): TabBar { return this.bar; }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }

  /** Pops the recap and runs the close callback (once). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const s = this.services;
    if (s && s.stack.top === this) s.stack.pop();
    this.onClose();
  }

  update(dt: number, input: InputState): void {
    if (this.bar.update(dt, input)) {
      this.tableValue = recapTable(this.view, this.section);
      return;
    }
    const p = input.pointer;
    if (p?.justDown && this.continueRect && inRect(this.continueRect, p.x, p.y)) return this.close();
    if (pressed(input, ['pause'])) return this.close();
    const ev = (this.tableValue as DataTable<BoxRow | RecapLine | ScoreRow>).update(dt, input);
    if (ev?.type === 'back') this.close();
    else if (ev?.type === 'activate') {
      const row = ev.row as Partial<RecapLine>;
      if (row.playerId) this.fc.openPlayer(row.playerId);
      else if (row.teamId) this.fc.openTeam(row.teamId);
    }
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const titleY = theme.pad;
    drawText(ctx, fitCell(this.view.title, width - theme.pad * 2, theme.textScale), width / 2, titleY, { size: theme.textScale, align: 'center', color: c.accent, shadow: c.shadow });
    let y = titleY + theme.lineHeight;
    if (this.view.box && this.section === 'box') {
      drawText(ctx, fitCell(this.view.box.title, width - theme.pad * 2, theme.textScale), width / 2, y, { size: theme.textScale, align: 'center', color: c.text });
      y += theme.lineHeight;
    }
    const tabH = TabBar.height(theme);
    drawTabBar(ctx, theme, this.bar, { x: 0, y, w: width, h: tabH });
    y += tabH + theme.gap;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad;
    drawDataTable(ctx, theme, this.tableValue as DataTable<BoxRow | RecapLine | ScoreRow>, { x: theme.pad, y, w: width - theme.pad * 2, h: bottom - y - theme.gap });
    const input = this.services?.input;
    this.continueRect = drawButton(ctx, theme, 'CONTINUE', width - theme.pad, bottom + 1, true, 'right');
    // The Continue key is spelled out for keyboard / gamepad players; large text drops 'Open' to keep clear of the button.
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuTabLeft')} ${glyphOf(input, 'menuTabRight')}`, label: 'Section' },
      ...(theme.textScale > 1 ? [] : [{ glyph: glyphOf(input, 'confirm'), label: 'Open' }]),
      { glyph: glyphOf(input, 'pause'), label: 'Continue' },
    ], width - (this.continueRect.w + theme.pad * 2), bottom + 1, 'left');
  }
}
