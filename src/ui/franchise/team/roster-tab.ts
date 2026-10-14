/**
 * Roster tab: the user's roster as a sortable DataTable with position-group filter chips (Y or tap).
 * Confirm / tap opens the player card (where contract and roster actions live). The tab menu (LT / keyboard C, or tap)
 * lists the roster-rule issues that gate phase moves and, outside the free-agency market, signs free agents.
 */
import type { RosterRuleIssue } from '@/franchise/roster-rules';
import { userRosterIssues } from '@/franchise/roster-rules';
import type { ButtonHint } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import type { ChoiceOption } from '../kit/dialogs';
import { humanize, type ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { openStreetFreeAgents, streetMarketOpen } from '../market/street-fa';
import { ViewTable, type ViewSpec } from './layout';
import { ROSTER_FILTERS, filterRoster, rosterColumns, rosterDetail, rosterRows, rosterSummary, type RosterRow } from './roster-model';
import { TableScreen, TeamTabScreen } from './tab-screen';

/** Rows of the roster-issues drill-down. */
export const rosterIssueSpec = (issues: () => readonly RosterRuleIssue[]): ViewSpec<RosterRuleIssue & { id: string }> => ({
  id: 'roster-issues',
  label: 'Roster issues',
  rows: () => issues().map((i, n) => ({ ...i, id: `issue-${n}` })),
  rowId: (r) => r.id,
  emptyText: 'No roster issues',
  columns: () => [
    { key: 'sev', label: 'LEVEL', width: 8, format: (r) => (r.severity === 'blocking' ? { text: 'Blocking', tone: 'danger' } : { text: 'Warning', tone: 'warning' }), sortValue: (r) => (r.severity === 'blocking' ? 0 : 1), defaultDir: 'asc' },
    { key: 'kind', label: 'KIND', width: 12, format: (r) => humanize(r.kind), sortValue: (r) => r.kind, defaultDir: 'asc' },
    { key: 'msg', label: 'ISSUE', flex: 1, minWidth: 10, format: (r) => r.message },
  ],
  detail: (r) => r.message,
});

/** The Roster hub tab. */
export class RosterTab extends TeamTabScreen {
  readonly roster: ViewTable<RosterRow>;

  constructor(fc: FranchiseContext) {
    super(fc, 'team-roster');
    this.roster = new ViewTable<RosterRow>({
      id: 'roster',
      label: 'Roster',
      columns: rosterColumns,
      rows: () => filterRoster(rosterRows(this.fc.league(), this.fc.userTeamId), this.chips.current),
      rowId: (r) => r.id,
      initialSort: { key: 'pos', dir: 'asc' },
      emptyText: 'No players in this group',
      rowTone: (r) => (r.injury ? 'dim' : null),
      detail: rosterDetail,
      activate: (r) => this.fc.openPlayer(r.id),
    });
    this.init([this.roster]);
  }

  protected override chipSpecs(): TabSpec[] {
    return [...ROSTER_FILTERS];
  }

  protected override onViewChange(): void {
    this.roster.refresh();
  }

  summary(): ToneText {
    return rosterSummary(this.fc.league(), this.fc.userTeamId);
  }

  override menu(): ChoiceOption[] {
    const n = userRosterIssues(this.fc.league(), this.fc.userTeamId).length;
    return [
      { id: 'issues', label: `Roster issues (${n})`, disabled: n === 0 },
      // Outside the free-agency market the user signs unsigned players here (a short roster is fixed by hand).
      ...(streetMarketOpen(this.fc.league()) ? [{ id: 'sign', label: 'Sign free agents' }] : []),
    ];
  }

  override onMenu(id: string): void {
    if (id === 'sign') {
      openStreetFreeAgents(this.fc);
      return;
    }
    if (id !== 'issues') return;
    const spec = rosterIssueSpec(() => userRosterIssues(this.fc.league(), this.fc.userTeamId));
    this.fc.push(new TableScreen(this.fc, 'Roster issues', spec, { subtitle: 'Blocking issues stop the season from advancing' }));
  }

  override hints(): ButtonHint[] {
    return [
      { glyph: this.glyph('confirm'), label: 'Card' },
      { glyph: this.glyph('audible'), label: 'Filter' },
      { glyph: this.glyph('showPlayArt'), label: 'Sort' },
    ];
  }
}
