/**
 * Draft room (draft phase). Sections: Best Available (the pool through your reports with your need at each
 * position and a "fit" that blends grade and need), My Board (your board, available players only), Order (every
 * pick with owners after trades; Confirm on one of your picks offers to trade it in the trade builder) and Picks
 * (the log, graded by your scouts). Confirm on a prospect drafts him when you are on the clock (after a confirm),
 * otherwise opens his report. The menu starts the draft, drafts / auto-picks, sims to your pick or to the end,
 * trades a pick and finishes the draft.
 */
import type { PlayerId } from '@/core/ids';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable } from '../kit/data-table-view';
import { ChoiceDialog, ConfirmDialog } from '../kit/dialogs';
import { initialName, ordinal, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { MarketScreen, columnsFor, drawNotice, pickLabel, type MarketAction } from './common';
import {
  autoPickUser, availableRows, closeDraft, draftProspect, draftRoomStatus, ensureDraftStarted, logRows, orderRows, simToEnd, simToMine,
  thisDraft, type AvailableRow, type DraftRoomStatus, type LogRow, type OrderRow,
} from './draft-model';
import { ProspectScreen } from './prospect-detail';
import { boardAdd, boardRemove } from './scouting-model';
import { tradeablePicks } from './trade-model';
import { TradesScreen } from './trades-screen';

const AVAILABLE_COLUMNS: readonly Column<AvailableRow>[] = [
  { key: 'rk', label: 'RK', width: 4, align: 'right', format: (r) => (r.consensusRank ? String(r.consensusRank) : '-'), sortValue: (r) => r.consensusRank, defaultDir: 'asc' },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 3, minWidth: 8, format: (r) => (r.redFlags.length ? { text: r.name, tone: 'danger' } : r.name), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'age', label: 'AGE', width: 4, align: 'right', format: (r) => String(r.age), sortValue: (r) => r.age, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 5, align: 'right', format: (r) => r.overall },
  { key: 'pot', label: 'POT', width: 5, align: 'right', format: (r) => r.potential },
  { key: 'grd', label: 'GRD', width: 4, format: (r) => r.grade, sortValue: (r) => r.value },
  { key: 'need', label: 'NEED', width: 5, format: (r) => r.needText, sortValue: (r) => r.need },
  { key: 'fit', label: 'FIT', width: 5, align: 'right', format: (r) => String(Math.round(r.fit)), sortValue: (r) => r.fit },
  { key: 'brd', label: 'BRD', width: 4, align: 'right', format: (r) => (r.boardRank ? String(r.boardRank) : '-'), sortValue: (r) => r.boardRank, defaultDir: 'asc' },
];

const BOARD_COLUMNS: readonly Column<AvailableRow>[] = [
  { key: 'brd', label: '#', width: 3, align: 'right', format: (r) => String(r.boardRank ?? '-') },
  ...AVAILABLE_COLUMNS.filter((c) => ['name', 'pos', 'ovr', 'pot', 'grd', 'need'].includes(c.key)).map((c) => ({ ...c, sortValue: undefined })),
];

const ORDER_COLUMNS: readonly Column<OrderRow>[] = [
  { key: 'no', label: '#', width: 3, align: 'right', format: (r) => String(r.overall) },
  { key: 'rp', label: 'RD-PK', width: 5, format: (r) => r.label },
  { key: 'team', label: 'TEAM', width: 4, format: (r) => r.ownerAbbr },
  { key: 'via', label: 'VIA', width: 4, format: (r) => ({ text: r.via ?? '', tone: 'dim' }) },
  { key: 'sel', label: 'SELECTION', flex: 3, minWidth: 8, format: (r) => (r.selection ? r.selection : r.isCurrent ? { text: 'On the clock', tone: 'warning' } : { text: '-', tone: 'dim' }) },
];

const LOG_COLUMNS: readonly Column<LogRow>[] = [
  { key: 'no', label: '#', width: 4, align: 'right', format: (r) => String(r.overall), sortValue: (r) => r.overall, defaultDir: 'asc' },
  { key: 'rp', label: 'RD-PK', width: 5, format: (r) => r.label },
  { key: 'team', label: 'TEAM', width: 5, format: (r) => r.team, sortValue: (r) => r.team, defaultDir: 'asc' },
  { key: 'name', label: 'PLAYER', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'grd', label: 'YOUR GRD', width: 9, format: (r) => ({ text: r.grade, tone: r.gradeRank <= 2 ? 'success' : r.gradeRank <= 6 ? 'normal' : 'warning' }), sortValue: (r) => -r.gradeRank },
];

const SECTIONS: TabSpec[] = [
  { id: 'available', label: 'Best Available' }, { id: 'board', label: 'My Board' }, { id: 'order', label: 'Order' }, { id: 'log', label: 'Picks' },
];

/** The draft room tab screen. */
export class DraftRoomScreen extends MarketScreen {
  readonly id = 'market-draft';
  private statusValue: DraftRoomStatus;
  private large = false;
  available!: DataTable<AvailableRow>;
  board!: DataTable<AvailableRow>;
  order!: DataTable<OrderRow>;
  log!: DataTable<LogRow>;

  constructor(fc: FranchiseContext, opts: { pushed?: boolean; section?: string } = {}) {
    super(fc, SECTIONS, opts.pushed ?? false, opts.section);
    this.statusValue = draftRoomStatus(fc.league(), fc.userTeamId);
    this.makeTables(false);
    this.refresh();
  }

  get room(): DraftRoomStatus { return this.statusValue; }

  private makeTables(large: boolean): void {
    this.available = new DataTable(columnsFor(AVAILABLE_COLUMNS, ['name', 'pos', 'grd', 'need'], large), [], { rowId: (r) => r.id, initialSort: { key: 'grd' }, emptyText: 'No prospects left' });
    this.board = new DataTable(columnsFor(BOARD_COLUMNS, ['brd', 'name', 'pos', 'grd'], large), [], { rowId: (r) => r.id, emptyText: 'Nobody on your board is left' });
    this.order = new DataTable(columnsFor(ORDER_COLUMNS, ['no', 'team', 'sel'], large), [], { rowId: (r) => r.id, rowTone: (r) => (r.isCurrent ? 'accent' : r.isUser ? 'info' : null), emptyText: 'The order is set when the draft starts' });
    this.log = new DataTable(columnsFor(LOG_COLUMNS, ['no', 'team', 'name', 'grd'], large), [], { rowId: (r) => r.id, rowTone: (r) => (r.isUser ? 'accent' : null), emptyText: 'No picks yet' });
  }

  protected title(): string { return 'Draft Room'; }

  refresh(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const large = (this.services?.theme.textScale ?? 1) > 1;
    if (large !== this.large) {
      this.makeTables(large);
      this.large = large;
    }
    this.statusValue = draftRoomStatus(league, user);
    const rows = availableRows(league, user);
    this.available.setRows(rows);
    const d = thisDraft(league);
    const byId = new Map(rows.map((r) => [r.id, r]));
    this.board.setRows((d?.userBoard ?? []).map((id) => byId.get(id)).filter((r): r is AvailableRow => !!r));
    const hadSelection = this.order.selected !== null;
    const order = orderRows(league, user);
    this.order.setRows(order);
    const current = order.find((r) => r.isCurrent);
    if (current && (!hadSelection || this.section !== 'order')) this.order.selectById(current.id);
    this.log.setRows(logRows(league, user));
    this.bar.setTabs(SECTIONS.map((t) => (t.id === 'log' && this.log.rows.length ? { ...t, badge: String(this.log.rows.length) } : t)));
  }

  status(): ToneText {
    const s = this.statusValue;
    if (!s.started) return { text: 'The draft has not started: start it from the menu', tone: 'warning' };
    if (s.complete) return { text: `The draft is complete · ${this.log.rows.length} picks made`, tone: 'dim' };
    const where = `Rd ${s.round} pick ${s.pickInRound} (#${s.overall})`;
    if (s.userOnClock) return { text: `You are on the clock · ${where}`, tone: 'accent' };
    const next = s.nextUserOverall ? ` · your next: #${s.nextUserOverall} (${s.picksUntilUser} away)` : ' · you have no picks left';
    return { text: `${where} · ${s.onClockAbbr} on the clock${next}`, tone: 'normal' };
  }

  private selectedProspect(): AvailableRow | null {
    return this.section === 'available' ? this.available.selected : this.section === 'board' ? this.board.selected : null;
  }

  actions(): MarketAction[] {
    const s = this.statusValue;
    const r = this.selectedProspect();
    const live = s.started && !s.complete;
    const out: MarketAction[] = [];
    if (!s.started && !s.complete) out.push({ id: 'start', label: 'Start the draft' });
    if (r) out.push({ id: 'draft', label: `Draft ${r.name}`, disabledReason: s.userOnClock ? null : 'not on the clock' });
    out.push({ id: 'auto', label: 'Auto-pick for me', disabledReason: s.userOnClock ? null : 'not on the clock' });
    out.push({ id: 'sim-mine', label: 'Sim to my pick', disabledReason: s.complete ? 'draft complete' : s.userOnClock ? 'you are on the clock' : null });
    out.push({ id: 'sim-end', label: 'Sim to the end', disabledReason: s.complete ? 'draft complete' : null });
    out.push({ id: 'trade-pick', label: 'Trade a pick' });
    if (r) out.push({ id: 'report', label: 'View report' }, r.boardRank ? { id: 'board-remove', label: 'Remove from board' } : { id: 'board-add', label: 'Add to board' });
    if (live && s.pickIndex >= s.totalPicks) out.push({ id: 'finish', label: 'Finish the draft' });
    return out;
  }

  /** Asks to confirm, then drafts the prospect with the pick on the clock. */
  draftWithConfirm(id: PlayerId): void {
    const row = this.available.rows.find((r) => r.id === id);
    if (!this.statusValue.userOnClock || !row) return this.fc.toast('You are not on the clock');
    this.fc.push(new ConfirmDialog('Make the pick?', `Draft ${row.name} (${row.position}, grade ${row.grade}) with the ${ordinal(this.statusValue.overall ?? 0)} pick?`, {
      onResult: (ok) => { if (ok) this.draftNow(id); },
    }));
  }

  /** Drafts at once (no confirm). */
  draftNow(id: PlayerId): void {
    this.attempt(() => {
      const league = this.fc.league();
      const name = this.available.rows.find((r) => r.id === id)?.name ?? 'the prospect';
      const pick = this.statusValue.overall;
      this.commit(draftProspect(league, this.fc.userTeamId, id, this.fc.rng('draft-pick')), 'draftPick', `You drafted ${name} (#${pick})`);
    });
  }

  private openTradePick(pickId?: string): void {
    const league = this.fc.league();
    const picks = tradeablePicks(league, this.fc.userTeamId);
    const open = (id: string): void => {
      const pick = picks.find((p) => p.id === id);
      if (pick) this.fc.push(new TradesScreen(this.fc, { pushed: true, give: [{ kind: 'pick', pick }], section: 'get' }));
    };
    if (pickId) return open(pickId);
    if (picks.length === 0) return this.fc.toast('You have no picks to trade');
    this.fc.push(new ChoiceDialog('Trade which pick?', '', picks.map((p) => ({ id: p.id, label: pickLabel(league, p) })), (id) => { if (id) open(id); }, { maxVisible: this.large ? 4 : 7 }));
  }

  runAction(id: string): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const r = this.selectedProspect();
    switch (id) {
      case 'start':
        this.attempt(() => this.commit(ensureDraftStarted(league, this.fc.rng('draft-start')), 'draftPick', 'The draft is under way'));
        return;
      case 'draft':
        if (r) this.draftWithConfirm(r.id);
        return;
      case 'auto':
        this.attempt(() => {
          const res = autoPickUser(league, user, this.fc.rng('draft-auto'));
          const p = res.league.players[res.playerId];
          this.commit(res.league, 'draftPick', `Auto-pick: ${p ? `${p.firstName} ${p.lastName}` : res.playerId}`);
        });
        return;
      case 'sim-mine':
        this.attempt(() => {
          const next = simToMine(league, this.fc.rng('draft-sim'));
          const made = (next.draft?.selections.length ?? 0) - (league.draft?.selections.length ?? 0);
          const mine = next.draft?.complete ? 'the draft is complete' : 'you are on the clock';
          this.commit(next, 'draftPick', `${made} pick${made === 1 ? '' : 's'} made: ${mine}`);
          this.showSection('available');
        });
        return;
      case 'sim-end':
        this.fc.push(new ConfirmDialog('Sim to the end?', 'Your remaining picks are made from your board, then your grades.', {
          defaultNo: true, onResult: (ok) => { if (ok) this.attempt(() => this.commit(simToEnd(this.fc.league(), this.fc.rng('draft-end')), 'draftPick', 'The draft is complete')); },
        }));
        return;
      case 'trade-pick':
        return this.openTradePick();
      case 'report':
        if (r) this.openReport(r.id);
        return;
      case 'board-add':
        if (r) this.attempt(() => this.commit(boardAdd(league, r.id), 'edit'));
        return;
      case 'board-remove':
        if (r) this.attempt(() => this.commit(boardRemove(league, r.id), 'edit'));
        return;
      case 'finish':
        this.attempt(() => this.commit(closeDraft(league, this.fc.rng('draft-finish')), 'draftPick', 'The draft is complete'));
        return;
      default:
    }
  }

  private openReport(id: PlayerId): void {
    this.fc.push(new ProspectScreen(this.fc, id, { mode: 'draft', canDraft: () => draftRoomStatus(this.fc.league(), this.fc.userTeamId).userOnClock, onDraft: (pid) => { this.fc.pop(); this.refresh(); this.draftWithConfirm(pid); } }));
  }

  private activateProspect(row: AvailableRow): void {
    if (!this.statusValue.userOnClock) return this.openReport(row.id);
    this.fc.push(new ChoiceDialog(row.name, `${row.position} · grade ${row.grade} · OVR ${row.overall.text} · POT ${row.potential.text}`, [
      { id: 'draft', label: 'Draft him' }, { id: 'report', label: 'View report' }, { id: 'cancel', label: 'Not now' },
    ], (id) => {
      if (id === 'draft') this.draftWithConfirm(row.id);
      else if (id === 'report') this.openReport(row.id);
    }));
  }

  protected updateBody(dt: number, input: InputState): void {
    switch (this.section) {
      case 'available':
      case 'board': {
        const ev = (this.section === 'available' ? this.available : this.board).update(dt, input);
        if (ev?.type === 'back') this.close();
        else if (ev?.type === 'activate') this.activateProspect(ev.row);
        return;
      }
      case 'order': {
        const ev = this.order.update(dt, input);
        if (ev?.type === 'back') this.close();
        else if (ev?.type === 'activate' && ev.row.isUser && !ev.row.made) this.openTradePick(ev.row.id);
        return;
      }
      default: {
        const ev = this.log.update(dt, input);
        if (ev?.type === 'back') this.close();
        else if (ev?.type === 'activate') this.fc.openPlayer(ev.row.playerId);
      }
    }
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    if (!this.statusValue.started && !this.statusValue.complete && this.section !== 'available' && this.section !== 'board') {
      return drawNotice(ctx, theme, body, { text: 'Start the draft from the menu to set the order', tone: 'dim' });
    }
    const table = this.section === 'available' ? this.available : this.section === 'board' ? this.board : this.section === 'order' ? this.order : this.log;
    drawDataTable(ctx, theme, table as DataTable<AvailableRow | OrderRow | LogRow>, body);
  }
}
