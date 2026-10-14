/**
 * Playbook tab. Views (Y or tap): Offense and Defense catalogues of every play, sorted with the team's
 * playbook first (IN column), each with its category and description, and the selected play drawn as play
 * art beside the table (drawPlayArt). Confirm / tap on a play offers Add / Remove (moving the team onto its
 * custom playbook, saved in League.customPlaybooks) and a full-screen diagram. The tab menu switches between
 * the bundled playbooks and the custom one and lists the validation messages from the playbook loader plus
 * coverage warnings. The summary names the playbook in use, its play counts and the issue count.
 */
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { drawPlayArt } from '../../game/play-art';
import type { FranchiseContext } from '../context';
import type { Column } from '../kit/data-table';
import { fitCell } from '../kit/data-table-view';
import { ChoiceDialog, type ChoiceOption } from '../kit/dialogs';
import type { ToneText } from '../kit/format';
import { pressed, type Rect } from '../kit/list';
import { plural } from './common';
import { ViewTable, type ViewSpec } from './layout';
import {
  bundledPlaybooks, choosePlaybook, currentPlaybook, customPlaybookId, findPlay, playRows, playbookIssues, playbookRegistry, togglePlay, usesCustom,
  type PlayRow, type PlaySide,
} from './playbook-model';
import { TableScreen, TeamTabScreen } from './tab-screen';

/** Columns of a play catalogue. */
export const playColumns = (wide: boolean): Column<PlayRow>[] => [
  { key: 'in', label: 'IN', width: 2, align: 'center', format: (r) => (r.inBook ? { text: '●', tone: 'success' } : { text: '·', tone: 'dim' }), sortValue: (r) => (r.inBook ? 1 : 0) },
  { key: 'name', label: 'PLAY', flex: 2, minWidth: 8, format: (r) => (r.custom ? { text: `${r.name}*`, tone: 'info' } : r.name), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'cat', label: 'TYPE', width: 7, format: (r) => ({ text: r.category, tone: r.category === 'Special' ? 'dim' : 'normal' }), sortValue: (r) => r.category, defaultDir: 'asc' },
  ...(wide ? [{ key: 'form', label: 'FORMATION', flex: 1, minWidth: 6, format: (r: PlayRow) => ({ text: r.formation, tone: 'dim' as const }), sortValue: (r: PlayRow) => r.formation, defaultDir: 'asc' } as Column<PlayRow>] : []),
];

/** Draws a play's diagram with its name and description in `rect`; false when the play cannot be drawn. */
export const drawPlayPanel = (ctx: UiCtx, theme: Theme, fc: FranchiseContext, row: PlayRow | null, rect: Rect): boolean => {
  const c = theme.colors;
  const size = theme.textScale;
  ctx.fillStyle = c.panel;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (!row) return false;
  const lh = theme.lineHeight;
  const pad = theme.gap;
  drawText(ctx, fitCell(row.name, rect.w - pad * 2, size), rect.x + pad, rect.y + pad, { color: c.accent, size });
  drawText(ctx, fitCell(row.description, rect.w - pad * 2, size), rect.x + pad, rect.y + rect.h - lh + pad / 2, { color: c.textDim, size });
  const play = findPlay(fc.league(), row.side, row.id);
  const box = { x: rect.x + pad, y: rect.y + lh + pad, w: rect.w - pad * 2, h: rect.h - lh * 2 - pad };
  if (!play || box.w < 16 || box.h < 16) return false;
  ctx.fillStyle = c.bg;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  return drawPlayArt(ctx, play, playbookRegistry(fc.league()), box, { theme, unitColor: row.side === 'offense' ? c.accent2 : c.danger, routeColor: c.text, yardsWide: 44 });
};

/** Full-screen diagram of one play (Back / Confirm / tap closes). */
export class PlayDiagramScreen implements Screen {
  readonly id = 'team-play-diagram';
  private services: ScreenServices | null = null;
  constructor(private readonly fc: FranchiseContext, readonly row: PlayRow) {}
  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  update(_dt: number, input: InputState): void {
    if (pressed(input, ['back', 'confirm']) || input.pointer?.justDown) this.fc.pop();
  }
  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    rc.ctx.fillStyle = theme.colors.bg;
    rc.ctx.fillRect(0, 0, rc.width, rc.height);
    drawPlayPanel(rc.ctx, theme, this.fc, this.row, { x: theme.pad, y: theme.pad, w: rc.width - theme.pad * 2, h: rc.height - theme.pad * 2 });
  }
}

/** The Playbook hub tab. */
export class PlaybookTab extends TeamTabScreen {
  readonly offense: ViewTable<PlayRow>;
  readonly defense: ViewTable<PlayRow>;

  constructor(fc: FranchiseContext, opts: { view?: PlaySide } = {}) {
    super(fc, 'team-playbook');
    this.sideFraction = 0.38;
    const spec = (side: PlaySide): ViewSpec<PlayRow> => ({
      id: side, label: side === 'offense' ? 'Offense' : 'Defense', columns: playColumns,
      rows: () => playRows(this.fc.league(), this.fc.userTeamId, side),
      rowId: (r) => r.id,
      initialSort: { key: 'in', dir: 'desc' },
      emptyText: 'No plays',
      rowTone: (r) => (r.inBook ? null : 'dim'),
      detail: (r) => ({ text: `${r.inBook ? 'In playbook' : 'Not in playbook'} · ${r.description}`, tone: r.inBook ? 'success' : 'dim' }),
      activate: (r) => this.playAction(r),
    });
    this.offense = new ViewTable(spec('offense'));
    this.defense = new ViewTable(spec('defense'));
    this.init([this.offense, this.defense], opts.view);
  }

  /** The active catalogue. */
  get catalogue(): ViewTable<PlayRow> { return this.chips.current === 'defense' ? this.defense : this.offense; }

  /** Confirm on a play: add/remove or view its diagram. */
  playAction(r: PlayRow): ChoiceDialog {
    const dialog = new ChoiceDialog(r.name, r.description, [
      { id: 'toggle', label: r.inBook ? 'Remove from playbook' : 'Add to playbook' },
      { id: 'view', label: 'View diagram' },
    ], (id) => {
      if (id === 'toggle') this.apply(togglePlay(this.fc.league(), this.fc.userTeamId, r.side, r.id), 'edit');
      else if (id === 'view') this.fc.push(new PlayDiagramScreen(this.fc, r));
    });
    this.fc.push(dialog);
    return dialog;
  }

  protected override drawSide(ctx: UiCtx, theme: Theme, rect: Rect): void {
    drawPlayPanel(ctx, theme, this.fc, this.catalogue.table.selected, rect);
  }

  summary(): ToneText {
    const league = this.fc.league();
    const pb = currentPlaybook(league, this.fc.userTeamId);
    const issues = playbookIssues(league, this.fc.userTeamId).length;
    const text = `${pb.name} · ${pb.offensePlayIds.length} offense / ${pb.defensePlayIds.length} defense · ${issues === 0 ? 'valid' : plural(issues, 'issue')}`;
    return { text, tone: issues > 0 ? 'warning' : 'dim' };
  }

  override menu(): ChoiceOption[] {
    const league = this.fc.league();
    const hasCustom = league.customPlaybooks.some((p) => p.id === customPlaybookId(this.fc.userTeamId));
    const n = playbookIssues(league, this.fc.userTeamId).length;
    return [
      { id: 'base', label: 'Use a bundled playbook' },
      { id: 'custom', label: 'Use my custom playbook', disabled: !hasCustom || usesCustom(league, this.fc.userTeamId) },
      { id: 'issues', label: `Validation (${n})` },
    ];
  }

  override onMenu(id: string): void {
    const teamId = this.fc.userTeamId;
    if (id === 'base') {
      const current = currentPlaybook(this.fc.league(), teamId).id;
      const options = bundledPlaybooks().map((p) => ({ id: p.id, label: p.name, subLabel: `${p.offensePlayIds.length} off / ${p.defensePlayIds.length} def${p.id === current ? ' · in use' : ''}` }));
      this.fc.push(new ChoiceDialog('Bundled playbooks', 'Your custom playbook is kept', options, (pick) => {
        if (pick) this.apply(choosePlaybook(this.fc.league(), teamId, pick), 'edit');
      }));
    } else if (id === 'custom') {
      this.apply(choosePlaybook(this.fc.league(), teamId, customPlaybookId(teamId)), 'edit');
    } else if (id === 'issues') {
      const spec: ViewSpec<{ id: string; message: string }> = {
        id: 'playbook-issues', label: 'Validation',
        rows: () => playbookIssues(this.fc.league(), teamId).map((message, i) => ({ id: `m${i}`, message })),
        rowId: (r) => r.id,
        emptyText: 'The playbook is valid',
        columns: () => [{ key: 'msg', label: 'MESSAGE', flex: 1, format: (r) => ({ text: r.message, tone: 'warning' }) }],
        detail: (r) => r.message,
      };
      this.fc.push(new TableScreen(this.fc, 'Playbook validation', spec, { subtitle: currentPlaybook(this.fc.league(), teamId).name }));
    }
  }
}
