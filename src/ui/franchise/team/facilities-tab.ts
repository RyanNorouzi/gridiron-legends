/**
 * Facilities & Finances tab. Views (Y or tap): Facilities — level meter, next upgrade cost, effect now and
 * next level, maintenance; Confirm buys the upgrade after a confirmation (or toasts canUpgradeFacility's
 * reason: offseason only, cash, one per offseason). Tickets — the price (Confirm opens a stepper previewing
 * projected attendance and the gate at each price), the revenue-optimal price (Confirm applies it) and the
 * projections. Finances — seasonFinanceReport revenue/expense lines, profit, cash, subsidy and past seasons.
 * Fans — support, excitement, attendance, owner confidence and the stadium.
 */
import { optimalTicketPrice, projectedAttendance, seasonFinanceReport } from '@/franchise/finances';
import type { FranchiseContext } from '../context';
import type { Column } from '../kit/data-table';
import { ConfirmDialog, StepperDialog } from '../kit/dialogs';
import { formatMoney, formatPercent, type ToneText } from '../kit/format';
import { infoColumns, type InfoLine } from './common';
import {
  changeTicketPrice, facilityRows, facilitySummary, fanLines, fanSummary, financeLines, ticketField, ticketLines, upgrade,
  type FacilityRow, type TicketLine,
} from './facilities-model';
import { ViewTable } from './layout';
import { TeamTabScreen } from './tab-screen';

/** Table name of a facility: long words abbreviated ("Scouting Dept", "Player Dev Center") so names fit their column. */
export const facilityShortLabel = (label: string): string => label.replace(/\bDepartment\b/g, 'Dept').replace(/\bDevelopment\b/g, 'Dev');

/** Facility columns. */
export const facilityColumns = (wide: boolean): Column<FacilityRow>[] => [
  { key: 'name', label: 'FACILITY', flex: 1, minWidth: 8, format: (r) => facilityShortLabel(r.label), sortValue: (r) => r.label, defaultDir: 'asc' },
  { key: 'level', label: 'LEVEL', width: wide ? 8 : 5, format: (r) => `${r.level}/${r.maxLevel}`, sortValue: (r) => r.level, bar: (r) => ({ value: r.level, max: r.maxLevel, tone: r.level >= r.maxLevel ? 'accent' : 'info' }) },
  { key: 'cost', label: 'NEXT', width: 7, align: 'right', format: (r) => (r.cost === null ? { text: 'Max', tone: 'accent' } : { text: formatMoney(r.cost), tone: r.check.ok ? 'success' : 'normal' }), sortValue: (r) => r.cost },
  ...(wide ? [
    { key: 'effect', label: 'EFFECT', flex: 2, minWidth: 8, format: (r: FacilityRow) => ({ text: r.effectNow, tone: 'dim' as const }) } as Column<FacilityRow>,
    { key: 'maint', label: 'UPKEEP', width: 6, align: 'right', format: (r: FacilityRow) => formatMoney(r.maintenance), sortValue: (r: FacilityRow) => r.maintenance } as Column<FacilityRow>,
  ] : []),
];

/** Detail of a facility row. */
export const facilityDetail = (r: FacilityRow): ToneText => {
  if (r.effectNext === null) return { text: `${r.effectNow} · top level`, tone: 'accent' };
  const next = `Next: ${r.effectNext} (upkeep ${formatMoney(r.maintenanceNext ?? 0)})`;
  return r.check.ok ? { text: next, tone: 'success' } : { text: `${next} · ${r.check.reason ?? ''}`, tone: 'warning' };
};

/** The Facilities & Finances hub tab. */
export class FacilitiesTab extends TeamTabScreen {
  readonly facilities: ViewTable<FacilityRow>;
  readonly tickets: ViewTable<TicketLine>;
  readonly finances: ViewTable<InfoLine>;
  readonly fans: ViewTable<InfoLine>;

  constructor(fc: FranchiseContext, opts: { view?: string } = {}) {
    super(fc, 'team-facilities');
    const team = (): typeof fc.userTeamId => this.fc.userTeamId;
    this.facilities = new ViewTable<FacilityRow>({
      id: 'facilities', label: 'Facilities', columns: facilityColumns,
      rows: () => facilityRows(this.fc.league(), team()),
      rowId: (r) => r.id,
      detail: facilityDetail,
      activate: (r) => this.upgradeFlow(r),
    });
    this.tickets = new ViewTable<TicketLine>({
      id: 'tickets', label: 'Tickets', columns: () => infoColumns(3, 2),
      rows: () => ticketLines(this.fc.league(), team()),
      rowId: (l) => l.id, showHeader: false,
      activate: (l) => this.ticketAction(l),
    });
    this.finances = new ViewTable<InfoLine>({
      id: 'finances', label: 'Finances', columns: () => infoColumns(2, 3),
      rows: () => financeLines(this.fc.league(), team()),
      rowId: (l) => l.id, showHeader: false,
    });
    this.fans = new ViewTable<InfoLine>({
      id: 'fans', label: 'Fans', columns: () => infoColumns(2, 3),
      rows: () => fanLines(this.fc.league(), team()),
      rowId: (l) => l.id, showHeader: false,
    });
    this.init([this.facilities, this.tickets, this.finances, this.fans], opts.view);
  }

  /** Confirm on a facility: confirmation, then upgradeFacility; refusals toast the reason. */
  upgradeFlow(r: FacilityRow): ConfirmDialog | null {
    if (!r.check.ok || r.cost === null) {
      this.fc.toast(r.check.reason ?? 'Cannot upgrade');
      return null;
    }
    const dialog = new ConfirmDialog(`Upgrade ${r.label}?`, `Level ${r.level + 1} for ${formatMoney(r.cost)}. ${r.effectNext ?? ''}. Upkeep becomes ${formatMoney(r.maintenanceNext ?? 0)} a season.`, {
      yesLabel: 'Upgrade', noLabel: 'Cancel',
      onResult: (yes) => {
        if (yes) this.apply(upgrade(this.fc.league(), this.fc.userTeamId, r.id), 'edit');
      },
    });
    this.fc.push(dialog);
    return dialog;
  }

  /** Confirm on a ticket line. */
  ticketAction(l: TicketLine): StepperDialog | null {
    const league = this.fc.league();
    const teamId = this.fc.userTeamId;
    if (l.action === 'optimal') {
      this.apply(changeTicketPrice(league, teamId, optimalTicketPrice(league, teamId)), 'edit');
      return null;
    }
    if (l.action !== 'price') return null;
    const stadiumId = league.teams[teamId]?.stadiumId;
    const capacity = stadiumId ? league.stadiums[stadiumId]?.capacity ?? 0 : 0;
    const dialog = new StepperDialog('Ticket price', `Revenue-optimal: $${optimalTicketPrice(league, teamId)}`, [ticketField(league, teamId)], {
      confirmLabel: 'SET',
      summary: (v) => {
        const price = v.price ?? 0;
        const att = projectedAttendance(this.fc.league(), teamId, price);
        return `Attendance ${formatPercent(att)} · gate ${formatMoney(capacity * att * price)}`;
      },
      onResult: (v) => {
        if (v) this.apply(changeTicketPrice(this.fc.league(), teamId, v.price ?? 0), 'edit');
      },
    });
    this.fc.push(dialog);
    return dialog;
  }

  summary(): ToneText {
    const league = this.fc.league();
    const teamId = this.fc.userTeamId;
    const team = league.teams[teamId];
    if (!team) return { text: 'No team', tone: 'danger' };
    switch (this.chips.current) {
      case 'tickets': return { text: `Tickets $${team.finances.ticketPrice} · projected attendance ${formatPercent(projectedAttendance(league, teamId, team.finances.ticketPrice))}`, tone: 'dim' };
      case 'finances': {
        const r = seasonFinanceReport(league, teamId);
        return { text: `${r.year} profit ${formatMoney(r.profit)} · cash ${formatMoney(r.cash)}`, tone: r.profit >= 0 ? 'success' : 'warning' };
      }
      case 'fans': return fanSummary(league, teamId);
      default: return facilitySummary(league, teamId);
    }
  }
}
