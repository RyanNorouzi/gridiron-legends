/**
 * Season summary (the end of Season mode and of Playoffs mode): the champion and runner-up, the user's record
 * and playoff finish, and the season awards when they have been handed out. `seasonSummary` is the pure
 * view-model; the screen shows it with the champion's logo and a scrollable list, and CONTINUE / Confirm / Back
 * run `onClose` (e.g. back to the main menu).
 */
import type { TeamId } from '@/core/ids';
import { playoffResultLabel, runnerUp } from '@/franchise/playoffs';
import type { League } from '@/franchise/types';
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { drawHintBar, drawPanel } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable, fitCell } from '../kit/data-table-view';
import { formatRecord } from '../kit/format';
import { inRect, pressed, type Rect } from '../kit/list';
import type { RecapLine } from './recap-model';
import { drawButton, drawTeamBadge, glyphOf, hintBarHeight } from './widgets';

/** Season summary view-model. */
export interface SeasonSummaryView {
  title: string;
  champion: TeamId | null;
  championName: string;
  lines: RecapLine[];
}

const teamName = (league: League, id: TeamId | null): string => {
  const t = id ? league.teams[id] : undefined;
  return t ? `${t.city} ${t.name}` : 'No champion yet';
};

/** Builds the summary of the league's current season from the user's point of view. */
export const seasonSummary = (league: League, userTeamId: TeamId | null): SeasonSummaryView => {
  const s = league.season;
  const champion = s.champion ?? s.bracket?.champion ?? null;
  const lines: RecapLine[] = [];
  lines.push({ id: 'champ', text: `Champion: ${teamName(league, champion)}`, tone: champion === userTeamId && champion ? 'success' : 'accent', ...(champion ? { teamId: champion } : {}) });
  const ru = runnerUp(s.bracket);
  if (ru) lines.push({ id: 'runner', text: `Runner-up: ${teamName(league, ru)}`, tone: ru === userTeamId ? 'warning' : 'normal', teamId: ru });
  if (userTeamId) {
    const st = s.standings[userTeamId];
    lines.push({ id: 'record', text: `Your record: ${st ? formatRecord(st) : '0-0'} (${st?.pointsFor ?? 0} PF, ${st?.pointsAgainst ?? 0} PA)`, tone: 'normal' });
    const finish = playoffResultLabel(s.bracket, userTeamId, league.settings.playoff.roundNames);
    lines.push({ id: 'finish', text: finish ? `Playoffs: ${finish}` : 'Playoffs: missed', tone: champion === userTeamId ? 'success' : finish ? 'normal' : 'warning' });
  }
  for (const a of s.awards) {
    const player = a.playerId ? league.players[a.playerId] ?? league.retiredPlayers[a.playerId] : undefined;
    lines.push({ id: `award:${a.award}`, text: `${a.award}: ${a.summary}`, tone: a.teamId === userTeamId ? 'success' : 'normal', ...(player ? { playerId: player.id } : { teamId: a.teamId }) });
  }
  return { title: `${s.year} Season Summary`, champion, championName: teamName(league, champion), lines };
};

const columns: Column<RecapLine>[] = [{ key: 'text', label: '', flex: 1, format: (l) => ({ text: l.text, tone: l.tone }) }];

/** Full-screen season summary. */
export class SeasonSummaryScreen implements Screen {
  readonly id = 'franchise-season-summary';
  private services: ScreenServices | null = null;
  readonly view: SeasonSummaryView;
  readonly table: DataTable<RecapLine>;
  private continueRect: Rect | null = null;
  private closed = false;
  private readonly label: string;

  constructor(private readonly fc: FranchiseContext, private readonly onClose: () => void, opts: { continueLabel?: string } = {}) {
    this.view = seasonSummary(fc.league(), fc.userTeamId);
    this.table = new DataTable(columns, this.view.lines, { rowId: (l) => l.id, showHeader: false });
    this.label = opts.continueLabel ?? 'CONTINUE';
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }

  /** Runs the close callback once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  update(dt: number, input: InputState): void {
    const p = input.pointer;
    if (p?.justDown && this.continueRect && inRect(this.continueRect, p.x, p.y)) return this.close();
    if (pressed(input, ['pause'])) return this.close();
    const ev = this.table.update(dt, input);
    if (ev?.type === 'back') this.close();
    else if (ev?.type === 'activate') {
      if (ev.row.playerId) this.fc.openPlayer(ev.row.playerId);
      else if (ev.row.teamId) this.fc.openTeam(ev.row.teamId);
    }
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, fitCell(this.view.title, width - theme.pad * 2, size), width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    let y = theme.pad + theme.lineHeight;
    const champ = this.view.champion ? this.fc.league().teams[this.view.champion] : undefined;
    if (champ) {
      const logo = Math.min(32, theme.lineHeight * 2);
      const box = drawPanel(ctx, theme, theme.pad, y, width - theme.pad * 2, Math.max(logo, theme.lineHeight * 2) + theme.pad + theme.lineHeight, { style: 'raised', title: 'CHAMPION', border: c.accent });
      drawTeamBadge(ctx, theme, champ, box.x, box.y, box.w, logo);
      y = box.y + box.h + theme.gap * 2;
    }
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad;
    drawDataTable(ctx, theme, this.table, { x: theme.pad, y, w: width - theme.pad * 2, h: bottom - y - theme.gap });
    this.continueRect = drawButton(ctx, theme, this.label, width - theme.pad, bottom + 1, true, 'right');
    const input = this.services?.input;
    drawHintBar(ctx, theme, [{ glyph: glyphOf(input, 'back'), label: 'Continue' }], width - this.continueRect.w - theme.pad * 2, bottom + 1, 'left');
  }
}
