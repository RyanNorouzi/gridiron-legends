/**
 * Home-group hub tabs.
 * - Home: the next-opponent card (logos, records, rating comparison, weather forecast, rivalry flag) or the
 *   current offseason phase, the user's division table, and an action list: Advance (the hub's default Advance
 *   option), scout the opponent, the inbox, then the league headlines (latest results with the user's game
 *   first, records set this season, injured players) - Confirm on a headline opens its team / player.
 * - Inbox (badge = unread count): the user team's franchise events, newest first, unread marked; Confirm opens
 *   the event detail with its choices (resolveEvent -> commit). Sort with Left/Right and X like every table.
 * Both are hosted by the hub inside fc.contentRect(); U/O and Back belong to the hub.
 */
import type { TeamId } from '@/core/ids';
import { phaseLabel as seasonPhaseLabel } from '@/franchise/phase';
import type { League } from '@/franchise/types';
import type { InputState } from '../input/types';
import { drawText, fitLines } from '../render/text';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { FranchiseContext, HubTab } from './context';
import { DataTable, type Column } from './kit/data-table';
import { drawDataTable, fitCell } from './kit/data-table-view';
import { toneColor } from './kit/format';
import { EventDetailScreen } from './shell/event-detail';
import { matchupCard, nextUserGame, type MatchupCard } from './shell/game-day-model';
import { divisionRows, homeHeadlines, inboxRows, openDecisions, unreadCount, type InboxRow } from './shell/home-model';
import { advanceOptions, phaseDetail, type HubMode } from './shell/hub-model';
import type { RecapLine } from './shell/recap-model';
import { drawTeamBadge, glyphOf, hintBarHeight, refitMenu, rowsThatFit } from './shell/widgets';

/** What the Home tab asks of the hub. */
export interface HomeActions {
  openAdvanceMenu(): void;
  selectTab(id: string): boolean;
  readonly mode: HubMode;
}

/** Home tab screen. */
export class HomeTabScreen implements Screen {
  readonly id = 'franchise-home';
  private services: ScreenServices | null = null;
  private menu: MenuList = new MenuList([]);
  private lines: RecapLine[] = [];
  private cardValue: MatchupCard | null = null;

  constructor(private readonly fc: FranchiseContext, private readonly actions: () => HomeActions | null) {
    this.rebuild();
  }

  get list(): MenuList { return this.menu; }
  get card(): MatchupCard | null { return this.cardValue; }
  get headlines(): readonly RecapLine[] { return this.lines; }

  /** Rebuilds every view-model from the current League. */
  rebuild(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const next = nextUserGame(league, user);
    this.cardValue = next ? matchupCard(league, next, user) : null;
    this.lines = homeHeadlines(league, user);
    const first = advanceOptions(league, user, this.actions()?.mode ?? 'franchise')[0];
    const opp = this.cardValue ? (this.cardValue.userSide === 'home' ? this.cardValue.away : this.cardValue.home) : null;
    const unread = unreadCount(league, user);
    const open = openDecisions(league, user);
    const items: MenuItem[] = [
      { id: 'advance', label: first?.label ?? 'Advance' },
      ...(opp ? [{ id: 'opponent', label: `Scout ${opp.city} ${opp.name}` }] : []),
      { id: 'inbox', label: `Inbox: ${unread} unread${open > 0 ? `, ${open} to decide` : ''}` },
      { id: 'hl', label: '- Headlines -', disabled: true },
      ...this.lines.map((l) => ({ id: `line:${l.id}`, label: l.text })),
    ];
    this.menu.setItems(items);
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.rebuild(); }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (ev?.type !== 'activate') return;
    const id = ev.item.id;
    const actions = this.actions();
    if (id === 'advance') actions?.openAdvanceMenu();
    else if (id === 'inbox') {
      if (!actions?.selectTab('inbox')) this.fc.toast('Inbox unavailable');
    } else if (id === 'opponent' && this.cardValue) {
      const c = this.cardValue;
      this.fc.openTeam(c.userSide === 'home' ? c.away.teamId : c.home.teamId);
    } else if (id.startsWith('line:')) {
      const line = this.lines.find((l) => `line:${l.id}` === id);
      if (line?.playerId) this.fc.openPlayer(line.playerId);
      else if (line?.teamId) this.fc.openTeam(line.teamId);
    }
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const r = this.fc.contentRect();
    // Large text: the card and the action list stack at full width (side by side both were cut to a few letters);
    // the division panel is left to the Standings tab.
    if (theme.textScale > 1) {
      const cardH = this.drawCard(rc, r.x, r.y, r.w, Math.round(r.h * 0.45), true);
      const below = r.y + cardH + theme.gap;
      this.drawActions(rc, r.x, below, r.w, r.y + r.h - below);
      return;
    }
    const leftW = Math.round(r.w * 0.46);
    const rightX = r.x + leftW + theme.gap * 2;
    const cardH = this.drawCard(rc, r.x, r.y, leftW, Math.round(r.h * 0.58));
    this.drawDivision(rc, r.x, r.y + cardH + theme.gap, leftW, r.h - cardH - theme.gap);
    this.drawActions(rc, rightX, r.y, r.x + r.w - rightX, r.h);
  }

  /** The action list panel. */
  private drawActions(rc: RenderContext, x: number, y: number, w: number, h: number): void {
    const theme = this.services?.theme ?? rc.theme;
    const panel = drawPanel(rc.ctx, theme, x, y, w, h, { style: 'raised' });
    this.menu = refitMenu(this.menu, rowsThatFit(theme, panel.h, 2));
    this.menu.draw(rc.ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
  }

  /** Next opponent (or phase) card; returns its height. `compact` (large text) lists text lines without the badge. */
  private drawCard(rc: RenderContext, x: number, y: number, w: number, h: number, compact = false): number {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx } = rc;
    const c = this.cardValue;
    const league: League = this.fc.league();
    const size = theme.textScale;
    const title = c ? `NEXT: ${c.title}` : seasonPhaseLabel(league.season.phase).toUpperCase();
    const content = drawPanel(ctx, theme, x, y, w, h, { style: 'raised', title: fitCell(title, w - theme.pad * 3, size), border: c?.rivalry ? theme.colors.warning : theme.colors.panelBorder });
    if (!c) {
      // Wrapped (not cut) inside the card: the phase detail, then the Advance reminder, within the rows that fit.
      const maxRows = Math.max(1, Math.floor(content.h / theme.lineHeight));
      const detail = fitLines(phaseDetail(league.season.phase), content.w, maxRows, size);
      const hint = maxRows > detail.length ? fitLines('Advance to continue the offseason', content.w, maxRows - detail.length, size) : [];
      [...detail.map((t) => ({ t, color: theme.colors.text })), ...hint.map((t) => ({ t, color: theme.colors.textDim }))].forEach((line, i) => {
        drawText(ctx, line.t, content.x, content.y + i * theme.lineHeight, { color: line.color, size });
      });
      return h;
    }
    const opp = c.userSide === 'home' ? c.away : c.home;
    const logo = Math.min(24, theme.lineHeight * 2);
    const matchup = `${c.userSide === 'home' ? 'vs' : 'at'} ${opp.abbr} ${opp.record}`;
    // The matchup line sits under the name only when three badge lines fit the card.
    const used = compact ? 0 : drawTeamBadge(ctx, theme, opp, content.x, content.y, content.w, logo, theme.lineHeight * 3 <= content.h ? [matchup] : []);
    let ly = compact ? content.y : content.y + used + theme.gap;
    const lines: { text: string; color: string }[] = [
      compact ? { text: `${matchup} · ${c.edge.text}`, color: toneColor(theme, c.edge.tone) } : { text: c.edge.text, color: toneColor(theme, c.edge.tone) },
      ...(c.rivalry ? [{ text: 'RIVALRY GAME', color: theme.colors.warning }] : []),
      { text: c.weather, color: theme.colors.textDim },
    ];
    for (const line of lines) {
      if (ly + theme.glyphH > content.y + content.h) break;
      drawText(ctx, fitCell(line.text, content.w, size), content.x, ly, { color: line.color, size });
      ly += theme.lineHeight;
    }
    return h;
  }

  private drawDivision(rc: RenderContext, x: number, y: number, w: number, h: number): void {
    const theme = this.services?.theme ?? rc.theme;
    const league = this.fc.league();
    const team = league.teams[this.fc.userTeamId];
    const content = drawPanel(rc.ctx, theme, x, y, w, h, { style: 'raised', title: fitCell(team ? team.division : 'Division', w - theme.pad * 3, theme.textScale) });
    const rows = divisionRows(league, this.fc.userTeamId);
    let ly = content.y;
    for (const row of rows) {
      if (ly + theme.glyphH > content.y + content.h) break;
      const text = `${row.rank}. ${row.abbr} ${row.record}`;
      drawText(rc.ctx, fitCell(text, content.w, theme.textScale), content.x, ly, { color: row.user ? theme.colors.accent : theme.colors.text, size: theme.textScale });
      ly += theme.lineHeight;
    }
  }
}

const inboxColumns: Column<InboxRow>[] = [
  { key: 'new', label: '', width: 1, format: (r) => (r.unread ? { text: '●', tone: 'accent' } : ''), sortValue: (r) => (r.unread ? 1 : 0) },
  { key: 'date', label: 'DATE', width: 10, format: (r) => ({ text: r.date, tone: 'dim' }), sortValue: (r) => r.sortKey },
  { key: 'title', label: 'EVENT', flex: 2, minWidth: 8, format: (r) => r.title, sortValue: (r) => r.title, defaultDir: 'asc' },
  // Flexible so an answer ("Auto: Accept the deal") stays readable instead of "Auto: A...".
  { key: 'status', label: 'STATUS', flex: 1, minWidth: 6, format: (r) => ({ text: r.status, tone: r.statusTone }), sortValue: (r) => r.status, defaultDir: 'asc' },
];

/** Inbox tab screen. */
export class InboxTabScreen implements Screen {
  readonly id = 'franchise-inbox';
  private services: ScreenServices | null = null;
  readonly table: DataTable<InboxRow>;

  constructor(private readonly fc: FranchiseContext) {
    this.table = new DataTable(inboxColumns, inboxRows(fc.league(), fc.userTeamId), { rowId: (r) => r.id, initialSort: { key: 'date', dir: 'desc' }, emptyText: 'No news yet' });
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.table.setRows(inboxRows(this.fc.league(), this.fc.userTeamId)); }

  /** Opens an event's detail. */
  open(eventId: string): void {
    this.fc.push(new EventDetailScreen(this.fc, eventId));
  }

  update(dt: number, input: InputState): void {
    const ev = this.table.update(dt, input);
    if (ev?.type === 'activate') this.open(ev.row.id);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const rect = this.fc.contentRect();
    const hintH = hintBarHeight(theme);
    // Key hints under the table when it still shows a few rows (large text keeps the rows instead).
    const room = rect.h - hintH - theme.gap >= theme.lineHeight * 4;
    drawDataTable(rc.ctx, theme, this.table, room ? { ...rect, h: rect.h - hintH - theme.gap } : rect);
    if (!room) return;
    const input = this.services?.input;
    drawHintBar(rc.ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Open' },
      { glyph: glyphOf(input, 'showPlayArt'), label: 'Sort' },
    ], rect.x + rect.w + theme.pad, rect.y + rect.h - hintH);
  }
}

/** The home-group tabs; `actions` resolves the hub (null when hosted elsewhere). */
export const createHomeTabs = (actions: () => HomeActions | null): HubTab[] => [
  { id: 'home', label: 'Overview', group: 'home', create: (fc) => new HomeTabScreen(fc, actions) },
  {
    id: 'inbox', label: 'Inbox', group: 'home',
    badge: (league) => {
      const user = league.userTeamId as TeamId | null;
      const n = user ? unreadCount(league, user) : 0;
      return n > 0 ? String(n) : null;
    },
    create: (fc) => new InboxTabScreen(fc),
  },
];
