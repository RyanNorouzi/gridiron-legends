/**
 * Depth Chart tab: one slot at a time (QB..P, KR, PR) chosen with Left/Right, Y or a tap on the slot chips
 * (chips carry "!" for slots with errors and the warning count otherwise). Rows are in playing order with the
 * starters marked. Confirm / tap on a player opens his moves (up, down, to the top, swap, remove an extra
 * listing, player card). "Swap with..." arms swap mode: the next Confirm/tap on another player of the slot
 * swaps them, X cancels. The tab menu (LT / keyboard C, or tap) rebuilds the chart automatically, adds a player to the
 * slot (returners for KR/PR, cross-position backups elsewhere) and lists every validation issue.
 */
import type { PlayerId } from '@/core/ids';
import { DEPTH_SLOTS, type DepthChartIssue } from '@/teams/depth-chart';
import type { DepthSlot } from '@/teams/types';
import type { InputState } from '../../input/types';
import type { ButtonHint } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import type { Column } from '../kit/data-table';
import { ChoiceDialog, ConfirmDialog, type ChoiceOption } from '../kit/dialogs';
import { formatRating, initialName, type ToneText } from '../kit/format';
import { LEFT_ACTIONS, RIGHT_ACTIONS, pressed } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { plural } from './common';
import {
  addCandidates, addToSlot, autoDepth, depthChips, depthIssues, isReturnSlot, moveInSlot, removeBlocker, removeFromSlot, setRankInSlot,
  slotName, slotRows, swapInSlot, type DepthRow,
} from './depth-model';
import { ViewTable, type ViewSpec } from './layout';
import { fatigueCell, injuryCell } from './roster-model';
import { TableScreen, TeamTabScreen, secondaryPressed } from './tab-screen';

/** Columns of a slot list (no sorting: the order is the depth). */
export const depthColumns = (slot: DepthSlot, wide: boolean): Column<DepthRow>[] => {
  const cols: Column<DepthRow>[] = [
    { key: 'rank', label: '#', width: 3, format: (r) => ({ text: `${r.rank + 1}`, tone: r.starter ? 'accent' : 'dim' }) },
    { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: (r) => (r.issue?.severity === 'error' ? { text: r.name, tone: 'danger' } : r.outOfPosition ? { text: r.name, tone: 'warning' } : r.name) },
    { key: 'pos', label: 'POS', width: 3, format: (r) => (r.outOfPosition ? { text: r.position, tone: 'warning' } : r.position) },
    { key: 'rtg', label: isReturnSlot(slot) ? 'RET' : 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.rating) },
    { key: 'inj', label: 'INJ', width: 3, align: 'right', format: (r) => injuryCell(r.injury) },
  ];
  if (wide) {
    cols.splice(4, 0, { key: 'ovr', label: isReturnSlot(slot) ? 'OVR' : 'ROLE', width: 7, format: (r) => (isReturnSlot(slot) ? formatRating(r.overall) : r.starter ? { text: 'Starter', tone: 'accent' } : { text: 'Backup', tone: 'dim' }) });
    cols.push({ key: 'fat', label: 'FAT', width: 4, align: 'right', format: (r) => fatigueCell(r.fatigue) });
  }
  return cols;
};

/** The Depth Chart hub tab. */
export class DepthTab extends TeamTabScreen {
  readonly slotView: ViewTable<DepthRow>;
  private swapFrom: PlayerId | null = null;

  constructor(fc: FranchiseContext, opts: { slot?: DepthSlot } = {}) {
    super(fc, 'team-depth');
    this.slotView = new ViewTable<DepthRow>({
      id: 'depth',
      label: 'Depth chart',
      columns: (wide) => depthColumns(this.slot, wide),
      rows: () => slotRows(this.fc.league(), this.fc.userTeamId, this.slot),
      rowId: (r) => r.id,
      emptyText: 'Nobody listed',
      rowTone: (r) => (r.id === this.swapFrom ? 'accent' : r.available ? null : 'dim'),
      detail: (r) => this.rowDetail(r),
      activate: (r) => this.activate(r),
    });
    this.init([this.slotView], opts.slot ?? 'QB');
    this.slotView.rebuild();
  }

  /** The slot being edited. */
  get slot(): DepthSlot {
    const id = this.chips.current;
    return DEPTH_SLOTS.find((s) => s === id) ?? 'QB';
  }

  /** Player picked for a swap (null outside swap mode). */
  get swapping(): PlayerId | null { return this.swapFrom; }

  protected override chipSpecs(): TabSpec[] {
    return depthChips(this.fc.league(), this.fc.userTeamId);
  }

  /** Shows a slot (rebuilding the table with that slot's columns). */
  showSlot(slot: DepthSlot): boolean {
    return this.showView(slot);
  }

  protected override onViewChange(): void {
    this.swapFrom = null;
    this.slotView.rebuild();
  }

  protected override handleInput(_dt: number, input: InputState): boolean {
    if (this.swapFrom && secondaryPressed(input)) {
      this.swapFrom = null;
      this.fc.toast('Swap cancelled');
      return true;
    }
    const delta = pressed(input, LEFT_ACTIONS) ? -1 : pressed(input, RIGHT_ACTIONS) ? 1 : 0;
    if (delta !== 0) {
      if (this.chips.cycle(delta)) this.onViewChange();
      return true;
    }
    return false;
  }

  private rowDetail(r: DepthRow): ToneText {
    if (r.issue) return { text: r.issue.message, tone: r.issue.severity === 'error' ? 'danger' : 'warning' };
    const role = r.starter ? `Starter (${this.slot}${r.rank + 1})` : `Backup (${this.slot}${r.rank + 1})`;
    return { text: `${r.name} · ${r.position} · ${role}${r.injury ? ` · injured ${r.injury.weeksRemaining} wk` : ''}`, tone: r.available ? 'info' : 'warning' };
  }

  private commitEdit(result: ReturnType<typeof moveInSlot>): boolean {
    return this.apply(result, 'edit');
  }

  /** Confirm on a row: completes a swap, or opens the row's moves. */
  activate(row: DepthRow): void {
    const slot = this.slot;
    if (this.swapFrom) {
      const from = this.swapFrom;
      this.swapFrom = null;
      if (from === row.id) {
        this.fc.toast('Swap cancelled');
        return;
      }
      this.commitEdit(swapInSlot(this.fc.league(), this.fc.userTeamId, slot, from, row.id));
      return;
    }
    const count = slotRows(this.fc.league(), this.fc.userTeamId, slot).length;
    const removeWhy = removeBlocker(this.fc.league(), this.fc.userTeamId, slot, row.id);
    const options: ChoiceOption[] = [
      { id: 'up', label: 'Move up', disabled: row.rank === 0 },
      { id: 'down', label: 'Move down', disabled: row.rank >= count - 1 },
      { id: 'top', label: `Make ${slot}1`, disabled: row.rank === 0 },
      { id: 'swap', label: 'Swap with...', disabled: count < 2 },
      { id: 'remove', label: `Remove from ${slot}`, disabled: removeWhy !== null, subLabel: removeWhy ?? undefined },
      { id: 'card', label: 'Player card' },
    ];
    this.fc.push(new ChoiceDialog(`${slot}${row.rank + 1}: ${row.name}`, '', options, (id) => this.rowAction(id, row), { maxVisible: 6 }));
  }

  /** Runs one of a row's moves. */
  rowAction(id: string | null, row: DepthRow): void {
    const league = this.fc.league();
    const team = this.fc.userTeamId;
    const slot = this.slot;
    switch (id) {
      case 'up': this.commitEdit(moveInSlot(league, team, slot, row.id, -1)); break;
      case 'down': this.commitEdit(moveInSlot(league, team, slot, row.id, 1)); break;
      case 'top': this.commitEdit(setRankInSlot(league, team, slot, row.id, 0)); break;
      case 'remove': this.commitEdit(removeFromSlot(league, team, slot, row.id)); break;
      case 'card': this.fc.openPlayer(row.id); break;
      case 'swap':
        this.swapFrom = row.id;
        this.fc.toast(`Pick the player to swap with ${row.name}`);
        break;
      default: break;
    }
  }

  summary(): ToneText {
    if (this.swapFrom) return { text: `Swap: pick another ${this.slot} (${this.glyph('showPlayArt')} cancels)`, tone: 'accent' };
    const issues = depthIssues(this.fc.league(), this.fc.userTeamId);
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.length - errors;
    const here = slotRows(this.fc.league(), this.fc.userTeamId, this.slot).length;
    const text = `${slotName(this.slot)} · ${plural(here, 'listed', 'listed')} · ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;
    return { text, tone: errors > 0 ? 'danger' : warnings > 0 ? 'warning' : 'dim' };
  }

  override menu(): ChoiceOption[] {
    const n = depthIssues(this.fc.league(), this.fc.userTeamId).length;
    const candidates = addCandidates(this.fc.league(), this.fc.userTeamId, this.slot).length;
    return [
      { id: 'auto', label: 'Auto depth chart' },
      { id: 'add', label: `Add player to ${this.slot}`, disabled: candidates === 0 },
      { id: 'issues', label: `All issues (${n})`, disabled: n === 0 },
    ];
  }

  override onMenu(id: string): void {
    if (id === 'auto') {
      this.fc.push(new ConfirmDialog('Auto depth chart', 'Rebuild every slot from the best available players? Manual changes are lost.', {
        yesLabel: 'Rebuild', noLabel: 'Cancel', defaultNo: true,
        onResult: (yes) => {
          if (yes) this.commitEdit(autoDepth(this.fc.league(), this.fc.userTeamId));
        },
      }));
    } else if (id === 'add') {
      const slot = this.slot;
      const options = addCandidates(this.fc.league(), this.fc.userTeamId, slot).map((p) => ({ id: p.id, label: `${p.firstName} ${p.lastName}`, subLabel: `${p.position} · OVR ${p.overall}` }));
      this.fc.push(new ChoiceDialog(`Add to ${slot}`, isReturnSlot(slot) ? 'Returners come from RB, WR, CB and FS' : 'Cross-position backups show a warning', options, (pid) => {
        if (pid) this.commitEdit(addToSlot(this.fc.league(), this.fc.userTeamId, slot, pid as PlayerId));
      }, { maxVisible: 6 }));
    } else if (id === 'issues') {
      this.fc.push(new TableScreen(this.fc, 'Depth chart issues', this.issueSpec(), { subtitle: 'Confirm jumps to the slot' }));
    }
  }

  /** Drill-down of every validation issue; Confirm closes it and jumps to the slot. */
  issueSpec(): ViewSpec<DepthChartIssue & { id: string }> {
    return {
      id: 'depth-issues', label: 'Issues',
      rows: () => depthIssues(this.fc.league(), this.fc.userTeamId).map((i, n) => ({ ...i, id: `i${n}` })),
      rowId: (r) => r.id,
      emptyText: 'No issues',
      columns: () => [
        { key: 'slot', label: 'SLOT', width: 4, format: (r) => r.slot, sortValue: (r) => DEPTH_SLOTS.indexOf(r.slot), defaultDir: 'asc' },
        { key: 'sev', label: 'LEVEL', width: 7, format: (r) => (r.severity === 'error' ? { text: 'Error', tone: 'danger' } : { text: 'Warning', tone: 'warning' }), sortValue: (r) => r.severity, defaultDir: 'asc' },
        { key: 'msg', label: 'ISSUE', flex: 1, minWidth: 10, format: (r) => r.message },
      ],
      initialSort: { key: 'sev', dir: 'asc' },
      detail: (r) => r.message,
      activate: (r) => {
        this.fc.pop();
        this.showSlot(r.slot);
      },
    };
  }

  override hints(): ButtonHint[] {
    if (this.swapFrom) return [{ glyph: this.glyph('confirm'), label: 'Swap here' }, { glyph: this.glyph('showPlayArt'), label: 'Cancel' }];
    return [
      { glyph: this.glyph('confirm'), label: 'Move' },
      { glyph: `${this.glyph('menuLeft')} ${this.glyph('menuRight')}`, label: 'Slot' },
    ];
  }
}
