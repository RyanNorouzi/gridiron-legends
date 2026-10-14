/**
 * THE read-only team page (pushed full-screen; every `fc.openTeam` in the franchise UI lands here): logo, name,
 * record, conference/division with rank, ratings and head coach in the title area; views Roster (sortable;
 * potential per the scouting visibility rule), Schedule (this season's games with results; opens the opponent),
 * Ratings (position units: starters' average with a bar, best player), Staff, Finances (season books, cap, club,
 * past seasons) and History (seasons, titles, rivalries). Confirm / tap opens the player card, an opponent's or a
 * rival's page or the best player of a unit. U/O or Y (or a tap on a chip) switch views; Back or CLOSE closes.
 */
import type { TeamId } from '@/core/ids';
import { drawTeamLogo } from '../../render/logo';
import type { SpriteCtx } from '../../render/sprites';
import { drawText, measureText } from '../../render/text';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import { fitCell } from '../kit/data-table-view';
import { formatAge, formatMoney, formatRating, initialName, ratingTone, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { carryTable } from './common';
import { FrameScreen, TableBody, type ViewBody } from './frame';
import { userScheduleRows, type ScheduleRow } from './schedule-model';
import { coachRows, financeLines, historyLines, rosterRows, teamHeader, unitRows, type CoachRow, type InfoLine, type RosterRow, type TeamHeader, type UnitRow } from './teams-model';

/** Roster columns (compact drops age, experience and contract). */
export const rosterColumns = (wide: boolean): Column<RosterRow>[] => [
  { key: 'no', label: '#', width: 2, align: 'right', format: (r) => ({ text: String(r.jersey), tone: 'dim' }), sortValue: (r) => r.jersey, defaultDir: 'asc' },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 2, minWidth: 8, format: (r) => (r.injured ? { text: r.name, tone: 'warning' } : r.name), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => r.posOrder, defaultDir: 'asc' },
  ...(wide ? [{ key: 'age', label: 'AGE', width: 3, align: 'right' as const, format: (r: RosterRow) => formatAge(r.age), sortValue: (r: RosterRow) => r.age, defaultDir: 'asc' as const }] : []),
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'pot', label: 'POT', width: 5, align: 'right', format: (r) => r.potential, sortValue: (r) => r.potentialSort },
  ...(wide ? [
    { key: 'exp', label: 'EXP', width: 3, align: 'right' as const, format: (r: RosterRow) => String(r.experience), sortValue: (r: RosterRow) => r.experience },
    { key: 'cap', label: 'CAP HIT', width: 7, align: 'right' as const, format: (r: RosterRow) => formatMoney(r.capHit), sortValue: (r: RosterRow) => r.capHit },
    { key: 'yrs', label: 'YRS', width: 3, align: 'right' as const, format: (r: RosterRow) => String(r.contractYears), sortValue: (r: RosterRow) => r.contractYears },
  ] : []),
];

const unitColumns: Column<UnitRow>[] = [
  { key: 'pos', label: 'POS', width: 3, format: (r) => ({ text: r.position, tone: 'accent' }) },
  { key: 'bar', label: 'STARTERS', flex: 2, minWidth: 6, format: (r) => String(r.average), bar: (r) => (r.average > 0 ? { value: r.average } : null), sortValue: (r) => r.average },
  { key: 'avg', label: 'AVG', width: 3, align: 'right', format: (r) => formatRating(r.average > 0 ? r.average : null), sortValue: (r) => r.average },
  { key: 'best', label: 'BEST', flex: 2, minWidth: 6, format: (r) => r.best, sortValue: (r) => r.bestOverall },
  { key: 'bovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.bestOverall > 0 ? r.bestOverall : null), sortValue: (r) => r.bestOverall },
];

const coachColumns = (wide: boolean): Column<CoachRow>[] => [
  { key: 'role', label: 'ROLE', width: 10, format: (r) => ({ text: r.role, tone: r.role === 'Head coach' ? 'accent' : 'dim' }) },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 2, minWidth: 8, format: (r) => r.name },
  ...(wide ? [
    { key: 'age', label: 'AGE', width: 3, align: 'right' as const, format: (r: CoachRow) => String(r.age) },
    { key: 'off', label: 'OFF', width: 3, align: 'right' as const, format: (r: CoachRow) => formatRating(r.offense) },
    { key: 'def', label: 'DEF', width: 3, align: 'right' as const, format: (r: CoachRow) => formatRating(r.defense) },
    { key: 'dev', label: 'DEV', width: 3, align: 'right' as const, format: (r: CoachRow) => formatRating(r.development) },
    { key: 'rec', label: 'REC', width: 7, align: 'right' as const, format: (r: CoachRow) => r.record },
  ] : [{ key: 'rec', label: 'REC', width: 7, align: 'right' as const, format: (r: CoachRow) => r.record }]),
];

/** Schedule columns (compact drops the opponent's record). */
export const scheduleColumns = (wide: boolean): Column<ScheduleRow>[] => [
  { key: 'week', label: 'WEEK', width: 7, format: (r) => ({ text: r.week, tone: r.current ? 'accent' : 'normal' }) },
  { key: 'opp', label: 'OPP', flex: 1, minWidth: 6, format: (r) => r.opponent },
  { key: 'result', label: 'RESULT', width: 9, format: (r) => r.result },
  ...(wide ? [{ key: 'orec', label: 'OPP REC', width: 7, format: (r: ScheduleRow) => ({ text: r.oppRecord, tone: 'dim' as const }) }] : []),
  { key: 'rec', label: 'REC', width: 6, format: (r) => ({ text: r.record, tone: 'dim' }) },
];

const infoColumns: Column<InfoLine>[] = [
  { key: 'label', label: 'ITEM', flex: 2, minWidth: 6, format: (l) => ({ text: l.label, tone: l.heading ? 'accent' : 'dim' }) },
  { key: 'value', label: 'VALUE', flex: 5, minWidth: 8, format: (l) => l.value },
];

/** A read-only page about one team. */
export class TeamViewScreen extends FrameScreen {
  private rosterBody: TableBody<RosterRow> | null = null;
  private scheduleBody: TableBody<ScheduleRow> | null = null;
  private unitBody: TableBody<UnitRow> | null = null;
  private staffBody: TableBody<CoachRow> | null = null;
  private infoBody: TableBody<InfoLine> | null = null;
  /** Header lines, rebuilt with the body (the division rank needs the tiebreakers, too slow for every frame). */
  private headerValue: TeamHeader | null = null;

  constructor(fc: FranchiseContext, readonly teamId: TeamId, opts: { view?: string } = {}) {
    super(fc, 'league-team-view', true);
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [{ id: 'roster', label: 'Roster' }, { id: 'schedule', label: 'Schedule' }, { id: 'ratings', label: 'Ratings' }, { id: 'staff', label: 'Staff' }, { id: 'finances', label: 'Finances' }, { id: 'history', label: 'History' }];
  }

  get rosterTable(): DataTable<RosterRow> | null { return this.rosterBody?.table ?? null; }
  get scheduleTable(): DataTable<ScheduleRow> | null { return this.scheduleBody?.table ?? null; }
  /** Current header (null for a team that no longer exists). */
  header(): TeamHeader | null { return this.headerValue; }
  get unitTable(): DataTable<UnitRow> | null { return this.unitBody?.table ?? null; }
  get staffTable(): DataTable<CoachRow> | null { return this.staffBody?.table ?? null; }
  get infoTable(): DataTable<InfoLine> | null { return this.infoBody?.table ?? null; }

  protected rebuild(): void {
    const league = this.fc.league();
    const wide = this.isWide();
    const id = this.teamId;
    this.headerValue = teamHeader(league, id);
    switch (this.view) {
      case 'schedule': {
        const table = carryTable(this.scheduleBody?.table ?? null, scheduleColumns(wide), userScheduleRows(league, id), { rowId: (r) => r.id, emptyText: 'No games scheduled' });
        this.scheduleBody = new TableBody(table, {
          activate: (r) => { if (r.opponentId) this.fc.openTeam(r.opponentId); },
          can: (r) => r.opponentId !== null,
          detail: (r) => (r.bye ? `${r.week}: bye week` : `${r.week} ${r.opponent} (${r.oppRecord}) ${typeof r.result === 'string' ? r.result : r.result.text}`),
        });
        return;
      }
      case 'ratings': {
        const table = carryTable(this.unitBody?.table ?? null, unitColumns, unitRows(league, id), { rowId: (r) => r.id, emptyText: 'No players' });
        this.unitBody = new TableBody(table, {
          activate: (r) => { if (r.bestId) this.fc.openPlayer(r.bestId); },
          can: (r) => r.bestId !== null,
          detail: (r) => `${r.position}: ${r.count} on roster, ${r.starters} starting (avg ${r.average}); best ${r.best} ${r.bestOverall}`,
        });
        return;
      }
      case 'staff': {
        const table = carryTable(this.staffBody?.table ?? null, coachColumns(wide), coachRows(league, id), { rowId: (r) => r.id, emptyText: 'No staff' });
        this.staffBody = new TableBody(table, {
          detail: (r) => `${r.name} (${r.age}): OFF ${r.offense} DEF ${r.defense} DEV ${r.development} MOT ${r.motivation} · ${r.titles} titles · ${r.about}`,
        });
        return;
      }
      case 'finances':
      case 'history': {
        const rows = this.view === 'finances' ? financeLines(league, id) : historyLines(league, id);
        const table = carryTable(this.infoBody?.table ?? null, infoColumns, rows, { rowId: (l) => l.id, showHeader: false, emptyText: 'Nothing to show' }, (l) => !l.heading);
        this.infoBody = new TableBody(table, {
          activate: (l) => { if (l.teamId && l.teamId !== this.teamId) this.fc.openTeam(l.teamId); },
          can: (l) => !!l.teamId && l.teamId !== this.teamId,
          detail: (l) => (l.teamId ? 'Open the rival team' : typeof l.value === 'string' ? `${l.label} ${l.value}` : `${l.label} ${l.value.text}`),
        });
        return;
      }
      default: {
        const table = carryTable(this.rosterBody?.table ?? null, rosterColumns(wide), rosterRows(league, id, this.fc.userTeamId), { rowId: (r) => r.id, initialSort: { key: 'pos', dir: 'asc' }, emptyText: 'No players' });
        this.rosterBody = new TableBody(table, {
          activate: (r) => this.fc.openPlayer(r.id),
          detail: (r) => (r.injured ? { text: `${r.name}: ${r.injury.text}`, tone: 'warning' } : `${r.name}, ${r.position}, age ${r.age}, ${r.experience} yrs, cap hit ${formatMoney(r.capHit)}`),
        });
      }
    }
  }

  body(): ViewBody | null {
    switch (this.view) {
      case 'schedule': return this.scheduleBody;
      case 'ratings': return this.unitBody;
      case 'staff': return this.staffBody;
      case 'finances':
      case 'history': return this.infoBody;
      default: return this.rosterBody;
    }
  }

  protected override titleLines(): number { return 2; }

  protected override title(): ToneText {
    const h = this.headerValue;
    return h ? { text: h.title, tone: 'accent' } : { text: 'Team not found', tone: 'danger' };
  }

  protected override drawTitle(ctx: UiCtx & SpriteCtx, theme: Theme, rect: Rect): void {
    const league = this.fc.league();
    const team = league.teams[this.teamId];
    const h = this.headerValue;
    const size = theme.textScale;
    const lh = theme.lineHeight;
    const ty = rect.y + Math.floor((lh - theme.glyphH) / 2);
    let x = rect.x + theme.pad;
    if (team) {
      ctx.fillStyle = team.colors.primary;
      ctx.fillRect(0, rect.y, Math.max(2, theme.gap), rect.h - theme.gap);
      const logo = Math.max(8, Math.min(lh * 2 - theme.gap, 24 * size));
      drawTeamLogo(ctx, team.logoSeed, team.colors, logo, x, rect.y + Math.floor((lh * 2 - logo) / 2));
      x += logo + theme.gap;
    }
    const room = rect.x + rect.w - x;
    const title = h ? (measureText(h.title, size).width <= room ? h.title : h.shortTitle) : 'Team not found';
    drawText(ctx, fitCell(title, room, size), x, ty, { color: theme.colors.accent, size });
    if (h) drawText(ctx, fitCell(h.subtitle, room, size), x, ty + lh, { color: theme.colors.textDim, size });
  }

  override summary(): ToneText {
    const team = this.fc.league().teams[this.teamId];
    if (!team) return { text: '' };
    if (this.view === 'roster') return { text: `${team.rosterIds.length} players · chemistry ${team.chemistry}`, tone: 'dim' };
    if (this.view === 'ratings') return { text: `OVR ${team.overall} · OFF ${team.offenseRating} · DEF ${team.defenseRating}`, tone: ratingTone(team.overall) };
    if (this.view === 'schedule') return { text: this.headerValue?.subtitle.split(' · ')[0] ?? '', tone: 'dim' };
    return { text: `${team.city} ${team.name} · ${this.headerValue?.market ?? ''}`, tone: 'dim' };
  }
}
