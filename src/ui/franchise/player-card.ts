/**
 * Read-only player card screen. Header: jersey, name, position, team, overall and potential (potential per
 * the scouting visibility rule in kit/player-view.ts). Sections on a tab bar (U/O or LB/RB, tap a tab):
 * Overview (bio, contract, health, morale, traits, flags), Ratings (every attribute with a rating bar,
 * position-relevant ones first; sortable), one table per relevant stat category (season by season, the
 * current season marked "*", career totals last; sortable) and History (progression, awards, injuries).
 * Up/Down scroll, Left/Right change the sort column, X flips it, Confirm on the Team line opens the team,
 * Back closes. For players on the user's roster an Actions section is appended (and Y opens the same list
 * as a menu from any section): negotiate an extension, restructure, release, franchise/transition tag,
 * trading block, training focus and a comparison with his teammates at the position (team/player-actions.ts,
 * team/player-action-flows.ts). The card rebuilds after every action it commits.
 */
import type { PlayerId } from '@/core/ids';
import type { InputState } from '../input/types';
import { drawText, measureText } from '../render/text';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import type { Theme } from '../theme';
import { drawHintBar, type ButtonHint } from '../widgets/panel';
import type { FranchiseContext } from './context';
import { DataTable, type Column } from './kit/data-table';
import { drawDataTable, fitCell } from './kit/data-table-view';
import { ChoiceDialog } from './kit/dialogs';
import { ratingTone, toneColor, type Tone } from './kit/format';
import { TERTIARY_ACTIONS, pressed } from './kit/list';
import { buildPlayerCard, type CardLine, type PlayerCardView, type RatingLine, type StatRow } from './kit/player-view';
import { STAT_GROUP_LABELS, statColumns, type StatGroup } from './kit/stat-columns';
import { TabBar, drawTabBar, type TabSpec } from './kit/tabbar';
import { runPlayerAction } from './team/player-action-flows';
import { playerActions, type PlayerAction } from './team/player-actions';

export { buildPlayerCard, potentialVisibility, type PlayerCardView } from './kit/player-view';

/** Card sections: fixed ones plus `stats:<group>` per relevant stat category. */
export type CardSectionId = 'overview' | 'ratings' | 'history' | `stats:${StatGroup}`;

/** Tabs for a card view. */
export const cardSections = (view: PlayerCardView): TabSpec[] => [
  { id: 'overview', label: 'Overview' },
  { id: 'ratings', label: 'Ratings' },
  ...view.statGroups.map((g) => ({ id: `stats:${g}`, label: STAT_GROUP_LABELS[g] })),
  { id: 'history', label: 'History' },
];

/** Tabs of the card screen: the card sections plus Actions when the viewer may act on the player. */
export const cardTabs = (view: PlayerCardView, withActions: boolean): TabSpec[] =>
  withActions ? [...cardSections(view), { id: 'actions', label: 'Actions' }] : cardSections(view);

const actionColumns: Column<PlayerAction>[] = [
  { key: 'action', label: 'Action', flex: 2, minWidth: 8, format: (a) => ({ text: a.label, tone: a.enabled ? 'normal' : 'dim' }) },
  { key: 'detail', label: 'Detail', flex: 3, minWidth: 8, format: (a) => a.detail },
];

/** The Actions section table. */
export const actionsTable = (actions: readonly PlayerAction[]): DataTable<PlayerAction> =>
  new DataTable(actionColumns, actions, { rowId: (a) => a.id, showHeader: false, emptyText: 'No actions', rowTone: (a) => (a.enabled ? null : 'dim') });

const lineColumns: Column<CardLine>[] = [
  { key: 'label', label: 'Item', flex: 2, format: (l) => (l.heading ? { text: l.label, tone: 'accent' } : { text: l.label, tone: 'dim' }) },
  { key: 'value', label: 'Value', flex: 3, format: (l) => l.value },
];

const importanceMark = (r: RatingLine): { text: string; tone: Tone } =>
  r.importance === 'primary' ? { text: '★', tone: 'accent' } : r.importance === 'secondary' ? { text: '·', tone: 'normal' } : { text: '', tone: 'dim' };

const ratingColumns: Column<RatingLine>[] = [
  { key: 'imp', label: 'KEY', width: 3, align: 'center', format: importanceMark, sortValue: (r) => r.weight, defaultDir: 'desc' },
  { key: 'attr', label: 'ATTRIBUTE', flex: 3, minWidth: 8, format: (r) => ({ text: r.label, tone: r.importance === 'other' ? 'dim' : 'normal' }), sortValue: (r) => r.label, defaultDir: 'asc' },
  { key: 'bar', label: '', flex: 2, minWidth: 6, format: () => '', bar: (r) => ({ value: r.value }) },
  { key: 'value', label: 'RTG', width: 3, align: 'right', format: (r) => ({ text: String(r.value), tone: ratingTone(r.value) }), sortValue: (r) => r.value },
];

const statTableColumns = (group: StatGroup): Column<StatRow>[] => [
  { key: 'year', label: 'YEAR', width: 5, format: (r) => (r.total ? { text: r.year, tone: 'accent' } : r.year), sortValue: (r) => (r.total ? null : Number.parseInt(r.year, 10)), defaultDir: 'asc' },
  { key: 'team', label: 'TM', width: 4, format: (r) => r.team },
  ...statColumns<StatRow>(group, (r) => r.line),
];

/** Builds the DataTable for one section of the card. */
export const sectionTable = (view: PlayerCardView, section: string): DataTable<CardLine> | DataTable<RatingLine> | DataTable<StatRow> => {
  if (section === 'ratings') return new DataTable(ratingColumns, view.ratings, { rowId: (r) => r.key, initialSort: { key: 'imp' } });
  if (section.startsWith('stats:')) {
    const group = section.slice(6) as StatGroup;
    return new DataTable(statTableColumns(group), view.statRows, { rowId: (r) => r.id, emptyText: 'No games played' });
  }
  const lines = section === 'history' ? view.history : view.overview;
  return new DataTable(lineColumns, lines, { rowId: (l) => l.id, showHeader: false });
};

type AnyTable = DataTable<CardLine> | DataTable<RatingLine> | DataTable<StatRow> | DataTable<PlayerAction>;

/** The read-only player card. */
export class PlayerCardScreen implements Screen {
  readonly id = 'player-card';
  private services: ScreenServices | null = null;
  private cardView: PlayerCardView | null;
  private bar: TabBar;
  private tableValue: AnyTable | null = null;
  private actionList: PlayerAction[] = [];

  constructor(private readonly fc: FranchiseContext, readonly playerId: PlayerId, opts: { section?: string } = {}) {
    this.cardView = buildPlayerCard(fc.league(), playerId, fc.userTeamId);
    this.actionList = playerActions(fc.league(), fc.userTeamId, playerId);
    this.bar = new TabBar(this.cardView ? cardTabs(this.cardView, this.actionList.length > 0) : [], { initialId: opts.section });
    this.rebuildTable();
  }

  /** Actions available on this player (empty unless he is on the user's roster). */
  get actions(): readonly PlayerAction[] { return this.actionList; }

  /** Current view-model (null when the player does not exist). */
  get view(): PlayerCardView | null { return this.cardView; }
  get tabs(): TabBar { return this.bar; }
  get table(): AnyTable | null { return this.tableValue; }
  get section(): string { return this.bar.current?.id ?? 'overview'; }

  /** Rebuilds from the current League (after a commit or on resume), keeping the section. */
  refresh(): void {
    this.cardView = buildPlayerCard(this.fc.league(), this.playerId, this.fc.userTeamId);
    this.actionList = playerActions(this.fc.league(), this.fc.userTeamId, this.playerId);
    this.bar.setTabs(this.cardView ? cardTabs(this.cardView, this.actionList.length > 0) : []);
    this.rebuildTable();
  }

  /** Runs an action by id (a disabled action toasts its reason instead). */
  runAction(id: PlayerAction['id']): boolean {
    const action = this.actionList.find((a) => a.id === id);
    if (!action) return false;
    if (!action.enabled) {
      this.fc.toast(action.reason ?? 'Not available');
      return false;
    }
    runPlayerAction(this.fc, this.playerId, action.id, () => this.refresh());
    return true;
  }

  /** Opens the actions as a menu (Y from any section). */
  openActionMenu(): ChoiceDialog | null {
    if (this.actionList.length === 0) return null;
    const dialog = new ChoiceDialog('Player actions', this.cardView?.name ?? '', this.actionList.map((a) => ({
      id: a.id, label: a.label, subLabel: a.enabled ? undefined : a.reason ?? undefined, disabled: !a.enabled,
    })), (id) => {
      const action = this.actionList.find((a) => a.id === id);
      if (action) this.runAction(action.id);
    }, { maxVisible: 7 });
    this.fc.push(dialog);
    return dialog;
  }

  /** Switches to a section by id. */
  showSection(id: string): boolean {
    if (!this.bar.selectById(id)) return false;
    this.rebuildTable();
    return true;
  }

  private rebuildTable(): void {
    const prevSel = this.tableValue?.selectedIndex ?? 0;
    if (this.section === 'actions') {
      this.tableValue = actionsTable(this.actionList);
      this.tableValue.select(prevSel);
      return;
    }
    this.tableValue = this.cardView ? sectionTable(this.cardView, this.section) : null;
    if (this.tableValue && this.section === 'overview') this.tableValue.select(prevSel);
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.refresh(); }

  update(dt: number, input: InputState): void {
    if (this.bar.update(dt, input)) {
      this.rebuildTable();
      return;
    }
    const table = this.tableValue;
    if (!table) {
      if (input.justPressed.has('back') || input.justPressed.has('confirm') || input.pointer?.justDown) this.fc.pop();
      return;
    }
    if (pressed(input, TERTIARY_ACTIONS) && this.openActionMenu()) return;
    const ev = (table as DataTable<CardLine | RatingLine | StatRow | PlayerAction>).update(dt, input);
    if (ev?.type === 'back') this.fc.pop();
    else if (ev?.type === 'activate' && this.section === 'actions') this.runAction((ev.row as PlayerAction).id);
    else if (ev?.type === 'activate' && this.section === 'overview' && (ev.row as CardLine).id === 'team' && this.cardView?.teamId) {
      this.fc.openTeam(this.cardView.teamId);
    }
  }

  /** Button hints for the current device. */
  hints(): ButtonHint[] {
    const glyph = (a: Parameters<ScreenServices['input']['glyph']>[0]): string => this.services?.input.glyph(a) ?? '?';
    const hints: ButtonHint[] = [{ glyph: `${glyph('menuTabLeft')} ${glyph('menuTabRight')}`, label: 'Section' }];
    if (this.section !== 'overview' && this.section !== 'history' && this.section !== 'actions') hints.push({ glyph: glyph('showPlayArt'), label: 'Sort' });
    if (this.actionList.length > 0) hints.push({ glyph: glyph('audible'), label: 'Actions' });
    hints.push({ glyph: glyph('back'), label: 'Back' });
    return hints;
  }

  render(rc: RenderContext): void {
    const theme: Theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const v = this.cardView;
    if (!v) {
      drawText(ctx, 'Player not found', width / 2, height / 2, { color: c.textDim, size, align: 'center' });
      return;
    }
    const pad = theme.pad;
    const headerH = theme.lineHeight * 2 + theme.gap;
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, 0, width, headerH + theme.gap);
    const team = v.teamId ? this.fc.league().teams[v.teamId] : undefined;
    if (team) {
      ctx.fillStyle = team.colors.primary;
      ctx.fillRect(0, 0, Math.max(2, theme.gap), headerH + theme.gap);
    }
    const badgeW = measureText('POT 99', size).width + theme.gap * 2;
    const nameRoom = width - pad * 2 - badgeW * 2 - theme.gap;
    drawText(ctx, fitCell(`${v.jersey} ${v.name}`, nameRoom, size), pad, theme.gap, { color: c.text, size });
    drawText(ctx, fitCell(`${v.position} · ${v.teamLabel}`, nameRoom, size), pad, theme.gap + theme.lineHeight, { color: c.textDim, size });
    const badge = (label: string, value: { text: string; tone?: Tone }, x: number): void => {
      drawText(ctx, label, x, theme.gap, { color: c.textDim, size });
      drawText(ctx, value.text, x, theme.gap + theme.lineHeight, { color: toneColor(theme, value.tone), size });
    };
    badge('OVR', v.overall, width - pad - badgeW * 2);
    badge('POT', v.potential, width - pad - badgeW);
    const tabY = headerH + theme.gap;
    const tabH = TabBar.height(theme);
    drawTabBar(ctx, theme, this.bar, { x: 0, y: tabY, w: width, h: tabH });
    const hintH = theme.glyphH + 4 * theme.textScale + theme.gap;
    const tableY = tabY + tabH + theme.gap;
    if (this.tableValue) {
      drawDataTable(ctx, theme, this.tableValue as DataTable<CardLine | RatingLine | StatRow | PlayerAction>, { x: pad, y: tableY, w: width - pad * 2, h: height - tableY - hintH - theme.gap });
    }
    drawHintBar(ctx, theme, this.hints(), width, height - hintH);
  }
}
