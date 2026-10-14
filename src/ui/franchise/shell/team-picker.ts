/**
 * Team picker: a sortable table of teams (overall, offense, defense, market, optional note such as a playoff
 * seed) beside a preview card of the highlighted team (logo, colours, conference and division, market, rivals).
 * Up/Down pick, Left/Right change the sort column, X flips it, Confirm (or a tap on the highlighted row; the first
 * tap on another row only highlights it) chooses, Back leaves.
 * Used by the new-franchise wizard and the Season / Playoffs modes. `teamRows` is the pure row builder.
 */
import type { TeamId } from '@/core/ids';
import type { Team } from '@/teams/types';
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { drawHintBar, drawPanel } from '../../widgets/panel';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable, fitCell } from '../kit/data-table-view';
import { formatRating, humanize } from '../kit/format';
import { glyphOf, hintBarHeight, drawTeamBadge } from './widgets';

/** One row of the picker. */
export interface TeamRow {
  id: TeamId;
  abbr: string;
  label: string;
  overall: number;
  offense: number;
  defense: number;
  market: Team['marketSize'];
  note: string | null;
  team: Team;
}

const pressedConfirm = (input: InputState): boolean => input.justPressed.has('confirm');

const MARKET_ORDER: Record<Team['marketSize'], number> = { small: 1, medium: 2, large: 3 };

/** Rows for a set of teams (`note` adds an extra column, e.g. "#2 AFC"). */
export const teamRows = (teams: readonly Team[], note?: (t: Team) => string | null): TeamRow[] =>
  teams.map((t) => ({
    id: t.id, abbr: t.abbr, label: `${t.city} ${t.name}`, overall: t.overall, offense: t.offenseRating, defense: t.defenseRating,
    market: t.marketSize, note: note?.(t) ?? null, team: t,
  }));

/**
 * Picker columns. In a narrow table (large text) the market column goes first and team names fall back to their
 * abbreviation ("CHI") instead of being cut to "CH..." (so the name column may shrink to 4 characters and the
 * rating columns keep their width and header labels).
 */
const columns = (withNote: boolean, rows: readonly TeamRow[]): Column<TeamRow>[] => {
  const abbrOf = new Map(rows.map((r) => [r.label, r.abbr]));
  return [
    { key: 'team', label: 'TEAM', flex: 1, minWidth: 4, format: (r) => r.label, shorten: (text) => abbrOf.get(text) ?? text, sortValue: (r) => r.label, defaultDir: 'asc' },
    ...(withNote ? [{ key: 'note', label: 'SEED', width: 6, format: (r: TeamRow) => ({ text: r.note ?? '-', tone: 'accent' as const }), sortValue: (r: TeamRow) => r.note, defaultDir: 'asc' as const }] : []),
    { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
    { key: 'off', label: 'OFF', width: 3, align: 'right', format: (r) => formatRating(r.offense), sortValue: (r) => r.offense },
    { key: 'def', label: 'DEF', width: 3, align: 'right', format: (r) => formatRating(r.defense), sortValue: (r) => r.defense },
    { key: 'mkt', label: 'MKT', width: 3, priority: 1, format: (r) => r.market.slice(0, 3).toUpperCase(), sortValue: (r) => MARKET_ORDER[r.market] },
  ];
};

/** Options of the picker. */
export interface TeamPickOptions {
  title: string;
  /** Short line under the title. */
  subtitle?: string;
  teams: readonly Team[];
  onPick(team: Team): void;
  /** Default: pop the picker. */
  onBack?(): void;
  note?(t: Team): string | null;
  /** Names of rival teams for the preview. */
  rivalNames?(t: Team): string[];
  initialId?: TeamId;
}

/** Full-screen team picker. */
export class TeamPickScreen implements Screen {
  readonly id = 'franchise-team-pick';
  private services: ScreenServices | null = null;
  readonly table: DataTable<TeamRow>;

  constructor(private readonly opts: TeamPickOptions) {
    const rows = teamRows(opts.teams, opts.note);
    const withNote = !!opts.note;
    this.table = new DataTable(columns(withNote, rows), rows, {
      rowId: (r) => r.id, initialSort: withNote ? { key: 'note', dir: 'asc' } : { key: 'ovr' }, ...(opts.initialId ? { initialRowId: opts.initialId } : {}),
    });
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }

  /** Chooses the highlighted team (exported for tests and scripted flows). */
  pick(): Team | null {
    const row = this.table.selected;
    if (!row) return null;
    this.opts.onPick(row.team);
    return row.team;
  }

  private back(): void {
    if (this.opts.onBack) this.opts.onBack();
    else if (this.services?.stack.top === this) this.services.stack.pop();
  }

  /**
   * A tap selects AND activates a table row, which would pick a team before its preview card was ever seen on a
   * touch screen; so a pointer activation only picks the row that was already highlighted (tap once to preview,
   * again to choose). Mouse hover highlights first, and Confirm always acts on the highlighted row.
   */
  update(dt: number, input: InputState): void {
    const before = this.table.selected?.id ?? null;
    const ev = this.table.update(dt, input);
    if (ev?.type === 'activate') {
      if (input.pointer && !pressedConfirm(input) && ev.row.id !== before) return;
      this.pick();
    } else if (ev?.type === 'back') this.back();
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, fitCell(this.opts.title, width - theme.pad * 2, size), width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    let top = theme.pad + theme.lineHeight;
    if (this.opts.subtitle) {
      drawText(ctx, fitCell(this.opts.subtitle, width - theme.pad * 2, size), width / 2, top, { size, align: 'center', color: c.textDim });
      top += theme.lineHeight;
    }
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    const previewW = Math.round(Math.min(190, width * 0.38));
    const tableW = width - theme.pad * 3 - previewW;
    drawDataTable(ctx, theme, this.table, { x: theme.pad, y: top, w: tableW, h: bottom - top });
    this.drawPreview(rc, theme.pad * 2 + tableW, top, previewW, bottom - top);
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Choose' },
      { glyph: glyphOf(input, 'showPlayArt'), label: 'Sort' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }

  private drawPreview(rc: RenderContext, x: number, y: number, w: number, h: number): void {
    const theme = this.services?.theme ?? rc.theme;
    const t = this.table.selected?.team;
    const content = drawPanel(rc.ctx, theme, x, y, w, h, { style: 'raised' });
    if (!t) return;
    const logo = Math.min(32, theme.lineHeight * 3);
    const used = drawTeamBadge(rc.ctx, theme, t, content.x, content.y, content.w, logo, [t.abbr]);
    const size = theme.textScale;
    let ly = content.y + used + theme.gap;
    const lines = [
      `${t.conference} ${t.division}`,
      `Market: ${humanize(t.marketSize)}`,
      `OVR ${t.overall}  OFF ${t.offenseRating}  DEF ${t.defenseRating}`,
      ...(this.opts.rivalNames ? [`Rivals: ${this.opts.rivalNames(t).join(', ') || '-'}`] : []),
    ];
    for (const line of lines) {
      if (ly + theme.glyphH > content.y + content.h) break;
      drawText(rc.ctx, fitCell(line, content.w, size), content.x, ly, { color: theme.colors.text, size });
      ly += theme.lineHeight;
    }
    const sw = Math.max(6, Math.floor(content.w / 8));
    if (ly + sw <= content.y + content.h) {
      [t.colors.primary, t.colors.secondary, t.colors.accent].forEach((col, i) => {
        rc.ctx.fillStyle = col;
        rc.ctx.fillRect(content.x + i * (sw + theme.gap), ly, sw, sw);
      });
    }
  }
}

