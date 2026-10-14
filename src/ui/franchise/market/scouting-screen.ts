/**
 * Scouting tab (from the start of the regular season until the draft). Every number is the user team's scouting
 * report (never the ground truth). Sections: Prospects (ranges, grade, confidence, points, interviews, board spot;
 * Confirm opens the full report), Combine (drills; PRO marks a pro day), My Board (Confirm for move / remove, or X
 * to pick a prospect up and move him with Up/Down) and Plan (this week's points plan; Confirm edits a line).
 * The menu plans points and interviews, applies the plan (applyScoutingPlan), builds a quick plan, edits the board
 * (including "board from my grades") and filters by position.
 */
import type { PlayerId } from '@/core/ids';
import { POSITIONS, type Position } from '@/players/types';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { ButtonHint, UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable } from '../kit/data-table-view';
import { ChoiceDialog, ConfirmDialog, StepperDialog } from '../kit/dialogs';
import { compactName, formatPercent, initialName, type ToneText } from '../kit/format';
import { DOWN_ACTIONS, RepeatAxis, SECONDARY_ACTIONS, UP_ACTIONS, pressed, type Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { MarketScreen, columnsFor, drawNotice, mark, type MarketAction } from './common';
import { DRILLS, ProspectScreen } from './prospect-detail';
import {
  EMPTY_PLAN, applyPlan, boardFromGrades, boardAdd, boardRemove, boardRows, boardShift, maxPlanPoints, planCost, prospectRows, quickPlan,
  scoutingStatus, togglePlanInterview, withPlanPoints, type ProspectRow, type ScoutPlan, type ScoutingStatus,
} from './scouting-model';

const interviewMark = (r: ProspectRow): ToneText => (r.interviewed ? mark(true) : r.plannedInterview ? { text: '+', tone: 'info' } : mark(false));
const pointsText = (r: ProspectRow): ToneText => (r.plannedPoints ? { text: `${r.invested}+${r.plannedPoints}`, tone: 'info' } : { text: String(r.invested) });

const PROSPECT_COLUMNS: readonly Column<ProspectRow>[] = [
  { key: 'rk', label: 'RK', width: 4, align: 'right', format: (r) => (r.consensusRank ? String(r.consensusRank) : '-'), sortValue: (r) => r.consensusRank, defaultDir: 'asc' },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 3, minWidth: 14, format: (r) => (r.redFlags.length ? { text: compactName(r.name, 13), tone: 'danger' } : compactName(r.name, 13)), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'age', label: 'AGE', width: 4, align: 'right', format: (r) => String(r.age), sortValue: (r) => r.age, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 6, align: 'right', format: (r) => r.overall, sortValue: (r) => (r.report ? r.report.overallRange[0] + r.report.overallRange[1] : null) },
  { key: 'pot', label: 'POT', width: 6, align: 'right', format: (r) => r.potential, sortValue: (r) => (r.report ? r.report.potentialRange[0] + r.report.potentialRange[1] : null) },
  { key: 'grd', label: 'GRD', width: 4, format: (r) => r.grade, sortValue: (r) => r.value },
  { key: 'conf', label: 'CONF', width: 5, align: 'right', format: (r) => formatPercent(r.confidence, 0), sortValue: (r) => r.confidence },
  { key: 'pts', label: 'PTS', width: 6, align: 'right', format: pointsText, sortValue: (r) => r.invested + r.plannedPoints },
  { key: 'int', label: 'INT', width: 4, align: 'center', format: interviewMark, sortValue: (r) => (r.interviewed ? 2 : r.plannedInterview ? 1 : 0) },
  { key: 'brd', label: 'BRD', width: 4, align: 'right', format: (r) => (r.boardRank ? String(r.boardRank) : '-'), sortValue: (r) => r.boardRank, defaultDir: 'asc' },
];

const COMBINE_COLUMNS: readonly Column<ProspectRow>[] = [
  { key: 'name', label: 'NAME', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  ...DRILLS.map((d): Column<ProspectRow> => ({
    key: d.key, label: { fortyYard: '40', benchReps: 'BNCH', vertical: 'VERT', broadJump: 'BRD', shuttle: 'SHTL', threeCone: '3CN' }[d.key], width: 6, align: 'right',
    format: (r) => (d.key === 'benchReps' || d.key === 'broadJump' ? String(Math.round(r.combine[d.key])) : r.combine[d.key].toFixed(d.key === 'vertical' ? 1 : 2)),
    sortValue: (r) => r.combine[d.key], defaultDir: d.key === 'fortyYard' || d.key === 'shuttle' || d.key === 'threeCone' ? 'asc' : 'desc',
  })),
  { key: 'pro', label: 'PRO', width: 4, align: 'center', format: (r) => mark(r.proDay !== null), sortValue: (r) => (r.proDay ? 1 : 0) },
];

const BOARD_COLUMNS: readonly Column<ProspectRow>[] = [
  { key: 'brd', label: '#', width: 3, align: 'right', format: (r) => String(r.boardRank ?? '-') },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position },
  { key: 'grd', label: 'GRD', width: 3, format: (r) => r.grade },
  { key: 'ovr', label: 'OVR', width: 5, align: 'right', format: (r) => r.overall },
  { key: 'pot', label: 'POT', width: 5, align: 'right', format: (r) => r.potential },
  { key: 'conf', label: 'CONF', width: 4, align: 'right', format: (r) => formatPercent(r.confidence, 0) },
];

const PLAN_COLUMNS: readonly Column<ProspectRow>[] = [
  { key: 'name', label: 'NAME', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position },
  { key: 'grd', label: 'GRD', width: 4, format: (r) => r.grade, sortValue: (r) => r.value },
  { key: 'have', label: 'HAVE', width: 5, align: 'right', format: (r) => String(r.invested), sortValue: (r) => r.invested },
  { key: 'add', label: '+PTS', width: 5, align: 'right', format: (r) => ({ text: `+${r.plannedPoints}`, tone: 'info' }), sortValue: (r) => r.plannedPoints },
  { key: 'int', label: 'INT', width: 3, align: 'center', format: interviewMark },
];

const sectionTabs = (s: ScoutingStatus, planned: number): TabSpec[] => [
  { id: 'prospects', label: 'Prospects' }, { id: 'combine', label: 'Combine' },
  { id: 'board', label: 'My Board', badge: s.board ? String(s.board) : null }, { id: 'plan', label: 'Plan', badge: planned ? String(planned) : null },
];

/** The scouting tab screen. */
export class ScoutingScreen extends MarketScreen {
  readonly id = 'market-scouting';
  private planValue: ScoutPlan = EMPTY_PLAN;
  private positionValue: Position | null = null;
  private statusValue: ScoutingStatus;
  private large = false;
  private moving = false;
  /** Up/Down (hold to repeat, analog too) while a board prospect is picked up. */
  private readonly moveAxis = new RepeatAxis(UP_ACTIONS, DOWN_ACTIONS, 'y');
  prospects: DataTable<ProspectRow>;
  combine: DataTable<ProspectRow>;
  board: DataTable<ProspectRow>;
  planTable: DataTable<ProspectRow>;

  constructor(fc: FranchiseContext, opts: { pushed?: boolean; section?: string } = {}) {
    const status = scoutingStatus(fc.league(), fc.userTeamId);
    super(fc, sectionTabs(status, 0), opts.pushed ?? false, opts.section);
    this.statusValue = status;
    [this.prospects, this.combine, this.board, this.planTable] = this.makeTables(false);
    this.refresh();
  }

  get plan(): ScoutPlan { return this.planValue; }
  get position(): Position | null { return this.positionValue; }
  get scouting(): ScoutingStatus { return this.statusValue; }
  /** True while a board prospect is picked up (Up/Down move him). */
  get movingOnBoard(): boolean { return this.moving; }

  private makeTables(large: boolean): DataTable<ProspectRow>[] {
    const id = (r: ProspectRow): string => r.id;
    return [
      new DataTable(columnsFor(PROSPECT_COLUMNS, ['name', 'pos', 'ovr', 'pot', 'grd'], large), [], { rowId: id, initialSort: { key: 'grd' }, emptyText: 'No prospects' }),
      new DataTable(columnsFor(COMBINE_COLUMNS, ['name', 'pos', 'fortyYard', 'benchReps', 'vertical'], large), [], { rowId: id, initialSort: { key: 'fortyYard' } }),
      new DataTable(columnsFor(BOARD_COLUMNS, ['brd', 'name', 'pos', 'grd'], large), [], { rowId: id, emptyText: 'Your board is empty: add prospects or build it from your grades' }),
      new DataTable(columnsFor(PLAN_COLUMNS, ['name', 'add', 'int'], large), [], { rowId: id, emptyText: 'No points planned: plan from Prospects or use Quick plan' }),
    ];
  }

  protected title(): string { return 'Scouting'; }

  /** Replaces the plan. */
  setPlan(plan: ScoutPlan): void {
    this.planValue = plan;
    this.refresh();
  }

  /** Filters the prospect lists to one position (null = all). */
  setPosition(position: Position | null): void {
    this.positionValue = position;
    this.refresh();
  }

  refresh(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const large = (this.services?.theme.textScale ?? 1) > 1;
    if (large !== this.large) {
      [this.prospects, this.combine, this.board, this.planTable] = this.makeTables(large);
      this.large = large;
    }
    const draft = league.draft;
    if (draft) this.planValue = this.prunePlan(this.planValue);
    this.statusValue = scoutingStatus(league, user, this.planValue);
    const rows = draft ? prospectRows(draft, user, this.planValue, this.positionValue) : [];
    this.prospects.setRows(rows);
    this.combine.setRows(rows);
    this.board.setRows(draft ? boardRows(draft, user, this.planValue) : []);
    const all = draft ? prospectRows(draft, user, this.planValue) : [];
    this.planTable.setRows(all.filter((r) => r.plannedPoints > 0 || r.plannedInterview));
    this.bar.setTabs(sectionTabs(this.statusValue, this.planValue.invest.size + this.planValue.interviews.size));
  }

  /** Drops plan lines for prospects that left the pool or were interviewed meanwhile. */
  private prunePlan(plan: ScoutPlan): ScoutPlan {
    const draft = this.fc.league().draft;
    if (!draft || plan === EMPTY_PLAN) return plan;
    const inPool = new Set<string>(draft.prospects.map((p) => p.player.id));
    const reports = draft.reports[this.fc.userTeamId] ?? {};
    return {
      invest: new Map([...plan.invest].filter(([id]) => inPool.has(id))),
      interviews: new Set([...plan.interviews].filter((id) => inPool.has(id) && !reports[id]?.interviewed)),
    };
  }

  status(): ToneText {
    const s = this.statusValue;
    if (!s.open) return { text: 'Scouting is closed until the next class is open', tone: 'dim' };
    if (this.moving) return { text: 'Moving: Up/Down to move, Confirm to drop', tone: 'accent' };
    const pos = this.positionValue ? ` · ${this.positionValue} only` : '';
    return { text: `Points ${Math.floor(s.points)} (+${s.perWeek}/wk) · plan ${s.planCost} · left ${Math.floor(s.remaining)}${pos}`, tone: s.remaining < 0 ? 'danger' : 'normal' };
  }

  private selected(): ProspectRow | null {
    switch (this.section) {
      case 'combine': return this.combine.selected;
      case 'board': return this.board.selected;
      case 'plan': return this.planTable.selected;
      default: return this.prospects.selected;
    }
  }

  actions(): MarketAction[] {
    const s = this.statusValue;
    const r = this.selected();
    const closed = s.open ? null : 'scouting closed';
    const out: MarketAction[] = [];
    if (r) {
      out.push({ id: 'detail', label: `Report: ${r.name}` });
      out.push({ id: 'plan-points', label: 'Plan scouting points', disabledReason: closed });
      out.push({ id: 'plan-interview', label: r.plannedInterview ? 'Cancel planned interview' : 'Plan interview', disabledReason: closed ?? (r.interviewed ? 'already interviewed' : null) });
      out.push(r.boardRank ? { id: 'board-remove', label: 'Remove from board' } : { id: 'board-add', label: 'Add to board' });
      if (this.section === 'board') out.push({ id: 'board-up', label: 'Move up' }, { id: 'board-down', label: 'Move down' }, { id: 'board-top', label: 'Move to top' });
    }
    out.push({ id: 'apply', label: `Apply plan (${s.planCost} pts)`, disabledReason: closed ?? (s.planCost <= 0 ? 'plan is empty' : s.remaining < 0 ? 'not enough points' : null) });
    out.push({ id: 'quick', label: 'Quick plan (spread points)', disabledReason: closed ?? (s.points < 1 ? 'no points' : null) });
    if (s.planCost > 0) out.push({ id: 'clear-plan', label: 'Clear plan' });
    out.push({ id: 'board-grades', label: 'Build board from my grades' }, { id: 'filter', label: `Position: ${this.positionValue ?? 'all'}` });
    return out;
  }

  private stepPlanPoints(r: ProspectRow): void {
    const draft = this.fc.league().draft;
    if (!draft) return;
    const max = maxPlanPoints(draft, this.fc.userTeamId, this.planValue, r.id);
    if (max <= 0 && r.plannedPoints <= 0) return this.fc.toast('No points left for him');
    this.fc.push(new StepperDialog(`Scout ${r.name}`, `Has ${r.invested} points; you have ${Math.floor(this.statusValue.remaining + r.plannedPoints)} to plan`,
      [{ id: 'points', label: 'Planned points', min: 0, max: Math.max(max, r.plannedPoints), step: 1, bigStep: 10, value: r.plannedPoints || Math.min(10, max) }], {
        confirmLabel: 'PLAN',
        onResult: (v) => { if (v) this.setPlan(withPlanPoints(this.planValue, r.id, v.points ?? 0)); },
      }));
  }

  runAction(id: string): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const r = this.selected();
    const draft = league.draft;
    switch (id) {
      case 'detail':
        if (r) this.fc.push(new ProspectScreen(this.fc, r.id, { mode: 'scouting' }));
        return;
      case 'plan-points':
        if (r) this.stepPlanPoints(r);
        return;
      case 'plan-interview':
        if (r && draft) this.attempt(() => this.setPlan(togglePlanInterview(draft, user, this.planValue, r.id)));
        return;
      case 'apply': {
        const cost = planCost(this.planValue);
        this.attempt(() => {
          const next = applyPlan(league, user, this.planValue);
          this.planValue = EMPTY_PLAN;
          this.commit(next, 'edit', `Scouting plan applied (${cost} points)`);
        });
        return;
      }
      case 'quick':
        if (draft) this.setPlan(quickPlan(draft, user));
        if (this.section !== 'plan') this.showSection('plan');
        return;
      case 'clear-plan':
        return this.setPlan(EMPTY_PLAN);
      case 'board-add':
        if (r) this.attempt(() => this.commit(boardAdd(league, r.id), 'edit', `${r.name} added to your board`));
        return;
      case 'board-remove':
        if (r) this.attempt(() => this.commit(boardRemove(league, r.id), 'edit', `${r.name} removed from your board`));
        return;
      case 'board-up':
      case 'board-down':
      case 'board-top':
        if (r) this.shift(r.id, id === 'board-up' ? -1 : id === 'board-down' ? 1 : 'top');
        return;
      case 'board-grades': {
        const build = (): void => { this.attempt(() => this.commit(boardFromGrades(this.fc.league(), user), 'edit', 'Board built from your grades')); };
        if ((draft?.userBoard.length ?? 0) === 0) return build();
        this.fc.push(new ConfirmDialog('Replace your board?', 'Your board will be rebuilt from your own scouting grades.', { defaultNo: true, onResult: (ok) => { if (ok) build(); } }));
        return;
      }
      case 'filter': {
        const options: (Position | null)[] = [null, ...POSITIONS];
        this.fc.push(new ChoiceDialog('Position', '', options.map((p, i) => ({ id: String(i), label: p ?? 'All positions' })), (choice) => {
          if (choice !== null) this.setPosition(options[Number(choice)] ?? null);
        }, { maxVisible: this.large ? 4 : 7 }));
        return;
      }
      default:
    }
  }

  /** Moves a board prospect and keeps him selected. */
  private shift(id: PlayerId, delta: number | 'top'): void {
    this.attempt(() => {
      this.fc.commit(boardShift(this.fc.league(), id, delta), 'edit');
      this.refresh();
      this.board.selectById(id);
    });
  }

  private boardChoice(r: ProspectRow): void {
    this.fc.push(new ChoiceDialog(r.name, `Board spot ${r.boardRank ?? '-'} · grade ${r.grade}`, [
      { id: 'board-up', label: 'Move up' }, { id: 'board-down', label: 'Move down' }, { id: 'board-top', label: 'Move to top' },
      { id: 'board-remove', label: 'Remove from board' }, { id: 'detail', label: 'View report' },
    ], (id) => { if (id) this.runAction(id); }));
  }

  protected override onSectionChange(): void { this.moving = false; }

  /** On the board X picks a prospect up instead of sorting. */
  override hints(): ButtonHint[] {
    const hints = super.hints();
    return this.section === 'board' ? hints.map((h) => (h.label === 'Sort' ? { ...h, label: this.moving ? 'Drop' : 'Move' } : h)) : hints;
  }

  protected updateBody(dt: number, input: InputState): void {
    if (this.section === 'board') {
      const sel = this.board.selected;
      if (pressed(input, SECONDARY_ACTIONS) && sel) {
        this.moving = !this.moving;
        return;
      }
      if (this.moving) {
        const dir = this.moveAxis.step(dt, input);
        if (!sel || pressed(input, ['confirm', 'back'])) this.moving = false;
        else if (dir !== 0) this.shift(sel.id, dir);
        return;
      }
      const ev = this.board.update(dt, input);
      if (ev?.type === 'back') this.close();
      else if (ev?.type === 'activate') this.boardChoice(ev.row);
      return;
    }
    const table = this.section === 'combine' ? this.combine : this.section === 'plan' ? this.planTable : this.prospects;
    const ev = table.update(dt, input);
    if (ev?.type === 'back') this.close();
    else if (ev?.type === 'activate') {
      if (this.section === 'plan') this.stepPlanPoints(ev.row);
      else this.fc.push(new ProspectScreen(this.fc, ev.row.id, { mode: 'scouting' }));
    }
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    if (!this.fc.league().draft) return drawNotice(ctx, theme, body, { text: 'No draft class is open yet', tone: 'dim' });
    const table = this.section === 'combine' ? this.combine : this.section === 'board' ? this.board : this.section === 'plan' ? this.planTable : this.prospects;
    drawDataTable(ctx, theme, table, body);
  }
}
