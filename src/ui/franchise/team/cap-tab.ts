/**
 * Contracts & Cap tab. Views (Y or tap the chips): Cap table (this year and the next seasons via
 * projectedCapSpace), Contracts (biggest cap hits first), Expiring (final-season and expired deals, flagged
 * when the player wants a new deal) and Dead money (player cap charges and staff cash owed per season). The
 * summary line is the cap status for the league cap year. Confirm / tap on a contract opens the player card,
 * where extensions, restructures, releases and tags are made.
 */
import type { FranchiseContext } from '../context';
import { formatMoney, type ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import {
  capColumns, capSummary, capTableRows, contractColumns, contractDetail, contractRows, deadMoneyColumns, deadMoneyRows, expiringColumns, expiringRows,
  type CapYearRow, type ContractRow, type DeadMoneyRow,
} from './cap-model';
import { ViewTable } from './layout';
import { TeamTabScreen } from './tab-screen';

/** The Contracts & Cap hub tab. */
export class CapTab extends TeamTabScreen {
  readonly years: ViewTable<CapYearRow>;
  readonly contracts: ViewTable<ContractRow>;
  readonly expiring: ViewTable<ContractRow>;
  readonly dead: ViewTable<DeadMoneyRow>;

  constructor(fc: FranchiseContext, opts: { view?: string } = {}) {
    super(fc, 'team-cap');
    const league = (): ReturnType<FranchiseContext['league']> => this.fc.league();
    this.years = new ViewTable<CapYearRow>({
      id: 'cap', label: 'Cap table', columns: capColumns,
      rows: () => capTableRows(league(), this.fc.userTeamId),
      rowId: (r) => r.id,
      initialSort: { key: 'year', dir: 'asc' },
      detail: (r) => ({ text: `${r.year}: ${r.players} under contract · committed ${formatMoney(r.committed)} · dead ${formatMoney(r.deadMoney)} · space ${formatMoney(r.space)}`, tone: r.space < 0 ? 'danger' : 'info' }),
    });
    this.contracts = new ViewTable<ContractRow>({
      id: 'contracts', label: 'Contracts', columns: contractColumns,
      rows: () => contractRows(league(), this.fc.userTeamId),
      rowId: (r) => r.id,
      initialSort: { key: 'hit', dir: 'desc' },
      emptyText: 'No contracts',
      detail: contractDetail,
      activate: (r) => this.fc.openPlayer(r.id),
    });
    this.expiring = new ViewTable<ContractRow>({
      id: 'expiring', label: 'Expiring', columns: expiringColumns,
      rows: () => expiringRows(league(), this.fc.userTeamId),
      rowId: (r) => r.id,
      initialSort: { key: 'ovr', dir: 'desc' },
      emptyText: 'No expiring contracts',
      rowTone: (r) => (r.wantsDeal ? 'warning' : null),
      detail: contractDetail,
      activate: (r) => this.fc.openPlayer(r.id),
    });
    this.dead = new ViewTable<DeadMoneyRow>({
      id: 'dead', label: 'Dead money', columns: deadMoneyColumns,
      rows: () => deadMoneyRows(league(), this.fc.userTeamId),
      rowId: (r) => r.id,
      initialSort: { key: 'year', dir: 'asc' },
      emptyText: 'No dead money',
      detail: (r) => ({ text: `${r.year}: ${formatMoney(r.player)} against the cap, ${formatMoney(r.staff)} owed to fired coaches`, tone: 'info' }),
    });
    this.init([this.years, this.contracts, this.expiring, this.dead], opts.view);
  }

  protected override chipSpecs(): TabSpec[] {
    const n = expiringRows(this.fc.league(), this.fc.userTeamId).length;
    return super.chipSpecs().map((c) => (c.id === 'expiring' && n > 0 ? { ...c, badge: String(n) } : c));
  }

  summary(): ToneText {
    return capSummary(this.fc.league(), this.fc.userTeamId);
  }
}
