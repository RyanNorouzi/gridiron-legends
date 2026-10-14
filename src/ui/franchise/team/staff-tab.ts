/**
 * Staff tab. Views (Y or tap): Staff — every role with its coach (or Vacant), role rating, traits, salary and
 * years; Confirm on a coach offers Fire (with the dead money he would still be owed, confirmed) or a search
 * for a replacement, Confirm on a vacancy opens the market for that role. Market — unattached coaches with
 * their ask (topped up with staff.ts coachMarket when empty); Confirm opens the hiring terms (salary and
 * years stepper, hiring fee shown) and, when the role is filled, confirms replacing the incumbent. Effects —
 * what the staff does for the team and the payroll. The tab menu refreshes the market and filters it by role.
 */
import type { CoachId } from '@/core/ids';
import { STAFF_TUNING, hiringFee, marketThin, staffEffects, staffPayroll } from '@/franchise/staff';
import type { StaffRole } from '@/franchise/types';
import { STAFF_ROLES } from '@/teams/coach-generator';
import type { FranchiseContext } from '../context';
import type { Column } from '../kit/data-table';
import { ChoiceDialog, ConfirmDialog, StepperDialog, type ChoiceOption } from '../kit/dialogs';
import { formatMoney, formatRating, initialName, type ToneText } from '../kit/format';
import { infoColumns, moneyPrecise, plural, type InfoLine } from './common';
import { ViewTable } from './layout';
import {
  ROLE_LABELS, ROLE_SHORT, coachDetail, defaultHireYears, effectLines, firePreview, fireStaff, hireStaff, incumbent, marketRows, minimumOffer, refreshMarket,
  signedPct, staffRows, type CoachRow,
} from './staff-model';
import { TeamTabScreen } from './tab-screen';

const roleCell = (wide: boolean) => (r: CoachRow): string => (wide ? ROLE_LABELS[r.role] : ROLE_SHORT[r.role]);

/** Traits that do not fit: the first one plus a count ("Aggressive +1"); the detail line lists them all. */
export const shortTraits = (text: string): string => {
  const parts = text.split(', ');
  return parts.length > 1 ? `${parts[0]} +${parts.length - 1}` : text;
};

/** Columns of the staff list. */
export const staffColumns = (wide: boolean): Column<CoachRow>[] => [
  { key: 'role', label: 'ROLE', width: wide ? 16 : 5, format: roleCell(wide), sortValue: (r) => STAFF_ROLES.indexOf(r.role), defaultDir: 'asc' },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: (r) => (r.coach ? r.name : { text: 'Vacant', tone: 'warning' }), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'rtg', label: 'RTG', width: 3, align: 'right', format: (r) => (r.rating === null ? { text: '-', tone: 'dim' } : formatRating(r.rating)), sortValue: (r) => r.rating },
  ...(wide ? [{ key: 'traits', label: 'TRAITS', flex: 1, minWidth: 6, format: (r: CoachRow) => ({ text: r.traits, tone: 'dim' as const }), shorten: shortTraits } as Column<CoachRow>] : []),
  { key: 'salary', label: 'SALARY', width: 6, align: 'right', format: (r) => (r.coach ? formatMoney(r.salary) : { text: '-', tone: 'dim' }), sortValue: (r) => r.salary },
  ...(wide ? [{ key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r: CoachRow) => (r.coach ? String(r.years) : '-'), sortValue: (r: CoachRow) => r.years } as Column<CoachRow>] : []),
];

/** Columns of the coach market. */
export const marketColumns = (wide: boolean): Column<CoachRow>[] => [
  { key: 'role', label: 'ROLE', width: wide ? 16 : 5, format: roleCell(wide), sortValue: (r) => STAFF_ROLES.indexOf(r.role), defaultDir: 'asc' },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  ...(wide ? [{ key: 'age', label: 'AGE', width: 3, align: 'right', format: (r: CoachRow) => String(r.age ?? '-'), sortValue: (r: CoachRow) => r.age, defaultDir: 'asc' } as Column<CoachRow>] : []),
  { key: 'rtg', label: 'RTG', width: 3, align: 'right', format: (r) => formatRating(r.rating), sortValue: (r) => r.rating },
  ...(wide ? [{ key: 'traits', label: 'TRAITS', flex: 1, minWidth: 6, format: (r: CoachRow) => ({ text: r.traits, tone: 'dim' as const }), shorten: shortTraits } as Column<CoachRow>] : []),
  { key: 'ask', label: 'ASK', width: 6, align: 'right', format: (r) => formatMoney(r.ask), sortValue: (r) => r.ask },
];

/** The Staff hub tab. */
export class StaffTab extends TeamTabScreen {
  readonly staff: ViewTable<CoachRow>;
  readonly market: ViewTable<CoachRow>;
  readonly effects: ViewTable<InfoLine>;
  private roleFilter: StaffRole | null = null;

  constructor(fc: FranchiseContext, opts: { view?: string } = {}) {
    super(fc, 'team-staff');
    this.staff = new ViewTable<CoachRow>({
      id: 'staff', label: 'Staff', columns: staffColumns,
      rows: () => staffRows(this.fc.league(), this.fc.userTeamId),
      rowId: (r) => r.id,
      initialSort: { key: 'role', dir: 'asc' },
      rowTone: (r) => (r.coach ? null : 'warning'),
      detail: coachDetail,
      activate: (r) => this.staffAction(r),
    });
    this.market = new ViewTable<CoachRow>({
      id: 'market', label: 'Market', columns: marketColumns,
      rows: () => marketRows(this.fc.league(), this.roleFilter),
      rowId: (r) => r.id,
      initialSort: { key: 'rtg', dir: 'desc' },
      emptyText: 'No coaches available: refresh the market',
      detail: coachDetail,
      activate: (r) => this.hire(r),
    });
    this.effects = new ViewTable<InfoLine>({
      id: 'effects', label: 'Effects', columns: () => infoColumns(3, 2),
      rows: () => effectLines(this.fc.league(), this.fc.userTeamId),
      rowId: (l) => l.id,
      showHeader: false,
    });
    this.init([this.staff, this.market, this.effects], opts.view);
  }

  /** Market role filter (null = all roles). */
  get marketRole(): StaffRole | null { return this.roleFilter; }

  /** Shows the market for one role (null = every role), refreshing it when empty. */
  openMarket(role: StaffRole | null): void {
    this.roleFilter = role;
    this.showView('market');
  }

  protected override onViewChange(id: string): void {
    // Topped up whenever a role runs short (firing a coach leaves him as the only one on an empty market).
    if (id === 'market' && marketThin(this.fc.league())) this.apply(refreshMarket(this.fc.league(), this.fc.rng('coach-market')), 'edit');
    this.market.refresh();
  }

  /** Confirm on a staff row. */
  staffAction(r: CoachRow): void {
    const coach = r.coach;
    if (!coach) {
      this.openMarket(r.role);
      return;
    }
    const prev = firePreview(this.fc.league(), this.fc.userTeamId, coach.id);
    this.fc.push(new ChoiceDialog(`${ROLE_LABELS[r.role]}: ${r.name}`, '', [
      { id: 'fire', label: 'Fire', subLabel: prev.ok ? `Still owed ${formatMoney(prev.deadMoney)}` : prev.reason ?? undefined, disabled: !prev.ok },
      { id: 'replace', label: 'Find a replacement' },
    ], (id) => {
      if (id === 'fire') this.confirmFire(coach.id, r.name, prev.deadMoney);
      else if (id === 'replace') this.openMarket(r.role);
    }));
  }

  private confirmFire(coachId: CoachId, name: string, dead: number): void {
    this.fc.push(new ConfirmDialog('Fire coach?', `${name} leaves now. The team still owes him ${formatMoney(dead)} over his remaining years.`, {
      yesLabel: 'Fire', noLabel: 'Keep', defaultNo: true,
      onResult: (yes) => {
        if (yes) this.apply(fireStaff(this.fc.league(), this.fc.userTeamId, coachId), 'signing');
      },
    }));
  }

  /** Confirm on a market coach: hiring terms, then a replace confirmation when the role is filled. */
  hire(r: CoachRow): StepperDialog | null {
    const coach = r.coach;
    if (!coach) return null;
    const league = this.fc.league();
    const min = minimumOffer(league, coach);
    const current = incumbent(league, this.fc.userTeamId, coach.role);
    const cash = league.teams[this.fc.userTeamId]?.finances.cash ?? 0;
    const dialog = new StepperDialog(`Hire ${r.name}`, `${ROLE_LABELS[coach.role]} · asks ${formatMoney(r.ask)}/season`, [
      { id: 'salary', label: 'Salary / season', min, max: Math.max(min, r.ask * 2), step: 50_000, bigStep: 500_000, value: r.ask, format: moneyPrecise },
      { id: 'years', label: 'Years', min: 1, max: STAFF_TUNING.maxContractYears, step: 1, value: defaultHireYears(coach.role) },
    ], {
      confirmLabel: 'HIRE',
      // The same rounded fee hireCoach charges.
      summary: (v) => `Fee ${formatMoney(hiringFee(v.salary ?? 0))} · cash ${formatMoney(cash)}${current ? ` · replaces ${current.lastName}` : ''}`,
      validate: (v) => (hiringFee(v.salary ?? 0) > cash ? 'Not enough cash for the hiring fee' : null),
      onResult: (v) => {
        if (!v) return;
        const salary = v.salary ?? r.ask;
        const years = v.years ?? defaultHireYears(coach.role);
        if (!current) {
          this.apply(hireStaff(this.fc.league(), this.fc.userTeamId, coach.id, salary, years, false), 'signing');
          return;
        }
        const owed = firePreview(this.fc.league(), this.fc.userTeamId, current.id).deadMoney;
        this.fc.push(new ConfirmDialog('Replace coach?', `${current.firstName} ${current.lastName} is fired and still owed ${formatMoney(owed)}.`, {
          yesLabel: 'Replace', noLabel: 'Cancel', defaultNo: true,
          onResult: (yes) => {
            if (yes) this.apply(hireStaff(this.fc.league(), this.fc.userTeamId, coach.id, salary, years, true), 'signing');
          },
        }));
      },
    });
    this.fc.push(dialog);
    return dialog;
  }

  summary(): ToneText {
    const league = this.fc.league();
    const team = league.teams[this.fc.userTeamId];
    if (!team) return { text: 'No team', tone: 'danger' };
    const id = this.chips.current;
    if (id === 'market') {
      const n = marketRows(league, this.roleFilter).length;
      return { text: `${plural(n, 'coach', 'coaches')} available (${this.roleFilter ? ROLE_LABELS[this.roleFilter] : 'all roles'}) · cash ${formatMoney(team.finances.cash)}`, tone: 'dim' };
    }
    if (id === 'effects') {
      const fx = staffEffects(league, team);
      return { text: `Growth ${signedPct(fx.developmentBonus).text} · game management ${fx.gameManagement} · motivation ${fx.motivation}`, tone: 'dim' };
    }
    const vacant = staffRows(league, this.fc.userTeamId).filter((r) => !r.coach).length;
    const pay = staffPayroll(league, this.fc.userTeamId);
    return { text: `Staff payroll ${formatMoney(pay.total)} · ${vacant === 0 ? 'every role filled' : plural(vacant, 'vacancy', 'vacancies')}`, tone: vacant > 0 ? 'warning' : 'dim' };
  }

  override menu(): ChoiceOption[] {
    return [
      { id: 'refresh', label: 'Refresh coach market' },
      { id: 'role', label: 'Filter market by role' },
    ];
  }

  override onMenu(id: string): void {
    if (id === 'refresh') {
      this.apply(refreshMarket(this.fc.league(), this.fc.rng('coach-market')), 'edit');
      this.showView('market');
    } else if (id === 'role') {
      const options: ChoiceOption[] = [{ id: 'all', label: 'All roles' }, ...STAFF_ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] }))];
      this.fc.push(new ChoiceDialog('Market role', '', options, (pick) => {
        if (pick) this.openMarket(STAFF_ROLES.find((r) => r === pick) ?? null);
      }, { maxVisible: 7 }));
    }
  }
}
