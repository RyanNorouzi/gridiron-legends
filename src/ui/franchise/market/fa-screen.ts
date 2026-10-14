/**
 * Free Agency tab (free-agency phase). Sections: Free Agents (the pool with position / overall / age / ask filters;
 * the chips above the table cycle on tap, the menu offers every choice; Confirm opens the player's detail with his
 * ask and what he values), My Offers (this round's offers, counters to accept or decline, and every resolved
 * offer) and Signings (the league's signings log). The menu opens the market, makes offers, runs the next bidding
 * round (the last one closes the market) and finishes free agency. The status line keeps cap space live.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { League } from '@/franchise/types';
import type { InputState } from '../../input/types';
import { drawText, measureText } from '../../render/text';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable } from '../kit/data-table-view';
import { ChoiceDialog, ConfirmDialog } from '../kit/dialogs';
import { formatMoney, formatRating, initialName, type ToneText } from '../kit/format';
import { inRect, type Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { MIN_BODY_LINES, MarketScreen, columnsFor, drawNotice, type MarketAction } from './common';
import { FaDetailScreen, openOfferDialog } from './fa-detail';
import {
  DEFAULT_FA_FILTERS, FA_FILTER_CHOICES, acceptCounter, closeMarket, cycleFilter, declineCounter, ensureMarketOpen, faPoolRows, faStatus,
  filterLabel, runRound, signingRows, userOfferRows, withdrawOffer, type FaFilterKey, type FaFilters, type FaOfferRow, type FaPoolRow,
  type FaSigningRow, type FaStatus,
} from './fa-model';

const POOL_COLUMNS: readonly Column<FaPoolRow>[] = [
  // 14 characters hold any generated name in its initial form ("C. Blankenship").
  { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 14, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'age', label: 'AGE', width: 3, align: 'right', format: (r) => String(r.age), sortValue: (r) => r.age, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'pot', label: 'POT', width: 5, align: 'right', format: (r) => r.potential },
  { key: 'ask', label: 'ASK/YR', width: 6, align: 'right', format: (r) => formatMoney(r.ask.apy), sortValue: (r) => r.ask.apy },
  { key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r) => String(r.ask.years), sortValue: (r) => r.ask.years },
  // "Counter $9.5M" / "Offer $9.5M" fall back to the amount (the tone tells counter from offer).
  { key: 'offer', label: 'OFFER', width: 8, format: (r) => r.offerText, shorten: (t) => t.replace(/^(Counter|Offer) /, ''), sortValue: (r) => (r.offer === 'none' ? 0 : r.offer === 'pending' ? 1 : 2) },
  // Two priorities when they fit, else the top one (the detail line always has both).
  { key: 'cares', label: 'CARES ABOUT', flex: 2, minWidth: 12, format: (r) => ({ text: r.cares, tone: 'dim' }), shorten: (t) => t.split(', ')[0] ?? t },
];

const OFFER_COLUMNS: readonly Column<FaOfferRow>[] = [
  { key: 'rd', label: 'RD', width: 3, align: 'right', format: (r) => String(r.round), sortValue: (r) => r.round },
  { key: 'name', label: 'PLAYER', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position },
  { key: 'ovr', label: 'OVR', width: 4, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'apy', label: 'APY', width: 7, align: 'right', format: (r) => formatMoney(r.apy), sortValue: (r) => r.apy },
  { key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r) => String(r.years) },
  { key: 'status', label: 'STATUS', flex: 3, minWidth: 8, format: (r) => r.status },
];

const SIGNING_COLUMNS: readonly Column<FaSigningRow>[] = [
  { key: 'rd', label: 'RD', width: 3, align: 'right', format: (r) => String(r.round), sortValue: (r) => r.round },
  { key: 'name', label: 'PLAYER', shorten: initialName, flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 4, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'team', label: 'TEAM', width: 5, format: (r) => r.team, sortValue: (r) => r.team, defaultDir: 'asc' },
  { key: 'apy', label: 'APY', width: 7, align: 'right', format: (r) => formatMoney(r.apy), sortValue: (r) => r.apy },
  { key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r) => String(r.years) },
];

const FILTER_KEYS: readonly FaFilterKey[] = ['position', 'minOverall', 'maxAge', 'maxAsk'];

const sectionTabs = (s: FaStatus): TabSpec[] => [
  { id: 'pool', label: 'Free Agents' },
  { id: 'offers', label: 'My Offers', badge: s.counters > 0 ? '!' : s.pendingOffers > 0 ? String(s.pendingOffers) : null },
  { id: 'signings', label: 'Signings' },
];

/** The free-agency tab screen. */
/** Body of the "Finish free agency?" prompt; warns when the user's roster is still short of a season roster. */
export const finishMessage = (league: League, userId: TeamId): string => {
  const base = 'Pending offers are withdrawn, the other teams fill their rosters and everyone left drops to a minimum ask.';
  const have = league.teams[userId]?.rosterIds.length ?? 0;
  const need = league.settings.rosterSize;
  return have >= need ? base : `${base} Your roster is at ${have}/${need}: the draft adds some, then sign the rest from Roster > menu > Sign free agents.`;
};

export class FreeAgencyScreen extends MarketScreen {
  readonly id = 'market-free-agency';
  private filtersValue: FaFilters = { ...DEFAULT_FA_FILTERS };
  private statusValue: FaStatus;
  private large = false;
  private chipRects: { key: FaFilterKey | 'clear'; rect: Rect }[] = [];
  pool: DataTable<FaPoolRow>;
  offers: DataTable<FaOfferRow>;
  signings: DataTable<FaSigningRow>;

  constructor(fc: FranchiseContext, opts: { pushed?: boolean; section?: 'pool' | 'offers' | 'signings' } = {}) {
    const status = faStatus(fc.league(), fc.userTeamId);
    super(fc, sectionTabs(status), opts.pushed ?? false, opts.section);
    this.statusValue = status;
    [this.pool, this.offers, this.signings] = this.makeTables(false);
    this.refresh();
  }

  get filters(): FaFilters { return this.filtersValue; }
  get marketStatus(): FaStatus { return this.statusValue; }
  /** Filter chip rectangles from the last render. */
  get chips(): readonly { key: FaFilterKey | 'clear'; rect: Rect }[] { return this.chipRects; }

  private makeTables(large: boolean): [DataTable<FaPoolRow>, DataTable<FaOfferRow>, DataTable<FaSigningRow>] {
    return [
      new DataTable(columnsFor(POOL_COLUMNS, ['name', 'pos', 'ovr', 'ask'], large), [], {
        rowId: (r) => r.id, initialSort: { key: 'ovr' }, emptyText: 'No free agents match the filters',
        rowTone: (r) => (r.offer === 'counter' ? 'warning' : r.offer === 'pending' ? 'info' : null),
      }),
      new DataTable(columnsFor(OFFER_COLUMNS, ['name', 'apy', 'status'], large), [], { rowId: (r) => r.id, emptyText: 'You have not made any offers' }),
      new DataTable(columnsFor(SIGNING_COLUMNS, ['name', 'ovr', 'team', 'apy'], large), [], { rowId: (r) => r.key, initialSort: { key: 'rd' }, emptyText: 'No signings yet', rowTone: (r) => (r.isUser ? 'accent' : null) }),
    ];
  }

  protected title(): string { return 'Free Agency'; }

  /** Replaces the filters. */
  setFilters(filters: FaFilters): void {
    this.filtersValue = filters;
    this.refresh();
  }

  refresh(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const large = (this.services?.theme.textScale ?? 1) > 1;
    if (large !== this.large) {
      [this.pool, this.offers, this.signings] = this.makeTables(large);
      this.large = large;
    }
    this.statusValue = faStatus(league, user);
    this.pool.setRows(faPoolRows(league, user, this.filtersValue));
    this.offers.setRows(userOfferRows(league, user));
    this.signings.setRows(signingRows(league, user));
    this.bar.setTabs(sectionTabs(this.statusValue));
  }

  status(): ToneText {
    const s = this.statusValue;
    const cap = `Cap ${formatMoney(s.capSpace)}`;
    const roster = `Roster ${s.roster}/${s.rosterLimit}`;
    if (!s.started) return { text: `Market not open · ${s.poolSize} free agents · ${s.expiring} of your deals expire · ${cap}`, tone: 'warning' };
    if (s.finished) return { text: `Free agency closed · ${cap} · ${roster}`, tone: 'dim' };
    const ifAll = s.pendingOffers ? ` (${formatMoney(s.capIfAllSign)} if all sign)` : '';
    const counters = s.counters ? ` · ${s.counters} counter${s.counters === 1 ? '' : 's'}` : '';
    return { text: `Round ${s.round} of ${s.maxRounds} · ${cap}${ifAll} · ${roster}${counters}`, tone: s.capIfAllSign < 0 ? 'danger' : s.counters ? 'warning' : 'normal' };
  }

  private selectedPlayer(): PlayerId | null {
    if (this.section === 'pool') return this.pool.selected?.id ?? null;
    if (this.section === 'offers') return this.offers.selected?.playerId ?? null;
    return this.signings.selected?.playerId ?? null;
  }

  actions(): MarketAction[] {
    const s = this.statusValue;
    const out: MarketAction[] = [];
    if (!s.started) out.push({ id: 'open', label: 'Open free agency' });
    const pid = this.selectedPlayer();
    const offerRow = this.section === 'offers' ? this.offers.selected : null;
    if (offerRow?.kind === 'counter') out.push({ id: 'counter-accept', label: `Accept ${offerRow.name}'s counter` }, { id: 'counter-decline', label: 'Decline the counter' });
    if (offerRow?.kind === 'current') out.push({ id: 'withdraw', label: `Withdraw offer to ${offerRow.name}` });
    if (this.section === 'pool' && pid) out.push({ id: 'offer', label: 'Make offer', disabledReason: s.finished ? 'market closed' : null });
    if (pid) out.push({ id: 'detail', label: 'Player details' }, { id: 'card', label: 'Player card' });
    out.push({ id: 'round', label: s.started ? `Run round ${s.round} of ${s.maxRounds}` : 'Run round 1', disabledReason: s.finished ? 'market closed' : null });
    out.push({ id: 'finish', label: 'Finish free agency', disabledReason: !s.started ? 'not open yet' : s.finished ? 'already closed' : null });
    if (this.section === 'pool') {
      for (const key of FILTER_KEYS) out.push({ id: `filter:${key}`, label: `Filter: ${filterLabel(key, this.filtersValue[key])}` });
      out.push({ id: 'filter:clear', label: 'Clear filters' });
    }
    return out;
  }

  private openFilter(key: FaFilterKey): void {
    const options = FA_FILTER_CHOICES[key] as readonly FaFilters[FaFilterKey][];
    this.fc.push(new ChoiceDialog('Filter', '', options.map((v, i) => ({ id: String(i), label: filterLabel(key, v) })), (id) => {
      if (id === null) return;
      this.setFilters({ ...this.filtersValue, [key]: options[Number(id)] ?? null });
    }, { maxVisible: (this.services?.theme.textScale ?? 1) > 1 ? 4 : 7 }));
  }

  runAction(id: string): void {
    const user = this.fc.userTeamId;
    const league = this.fc.league();
    if (id.startsWith('filter:')) {
      const key = id.slice(7);
      if (key === 'clear') return this.setFilters({ ...DEFAULT_FA_FILTERS });
      return this.openFilter(key as FaFilterKey);
    }
    const pid = this.selectedPlayer();
    const offerRow = this.offers.selected;
    switch (id) {
      case 'open':
        this.attempt(() => this.commit(ensureMarketOpen(league), 'signing', 'Free agency is open'));
        return;
      case 'offer':
        if (pid) openOfferDialog(this.fc, pid, () => this.refresh());
        return;
      case 'detail':
        if (pid) this.fc.push(new FaDetailScreen(this.fc, pid));
        return;
      case 'card':
        if (pid) this.fc.openPlayer(pid);
        return;
      case 'counter-accept':
        if (offerRow) this.attempt(() => this.commit(acceptCounter(league, user, offerRow.id), 'edit', `Counter accepted: it goes in with round ${this.statusValue.round}`));
        return;
      case 'counter-decline':
        if (offerRow) this.attempt(() => this.commit(declineCounter(league, user, offerRow.id), 'edit', 'Counter declined'));
        return;
      case 'withdraw':
        if (offerRow) this.attempt(() => this.commit(withdrawOffer(league, user, offerRow.id), 'edit', 'Offer withdrawn'));
        return;
      case 'round':
        this.attempt(() => {
          const r = runRound(league, user, this.fc.rng('fa-round'));
          this.commit(r.league, r.closed ? 'phaseChange' : 'signing', r.message);
        });
        return;
      case 'finish':
        this.fc.push(new ConfirmDialog('Finish free agency?', finishMessage(league, user), {
          defaultNo: true,
          onResult: (ok) => { if (ok) this.attempt(() => this.commit(closeMarket(this.fc.league()), 'phaseChange', 'Free agency is closed')); },
        }));
        return;
      default:
    }
  }

  private activateOffer(row: FaOfferRow): void {
    const choices = row.kind === 'counter' ? [{ id: 'counter-accept', label: 'Accept counter' }, { id: 'counter-decline', label: 'Decline counter' }]
      : row.kind === 'current' ? [{ id: 'edit', label: 'Change offer' }, { id: 'withdraw', label: 'Withdraw offer' }] : [];
    const msg = `${row.name}: ${formatMoney(row.apy)}/yr for ${row.years} yrs. ${row.status.text}.`;
    this.fc.push(new ChoiceDialog(row.name, msg, [...choices, { id: 'detail', label: 'Player details' }, { id: 'cancel', label: 'Close' }], (id) => {
      if (id === 'edit') openOfferDialog(this.fc, row.playerId, () => this.refresh());
      else if (id && id !== 'cancel') this.runAction(id);
    }));
  }

  protected updateBody(dt: number, input: InputState): void {
    const p = input.pointer;
    if (this.section === 'pool' && p?.justDown) {
      const chip = this.chipRects.find((c) => inRect(c.rect, p.x, p.y));
      if (chip) return this.setFilters(chip.key === 'clear' ? { ...DEFAULT_FA_FILTERS } : cycleFilter(this.filtersValue, chip.key));
    }
    if (this.section === 'pool') {
      const ev = this.pool.update(dt, input);
      if (ev?.type === 'back') this.close();
      else if (ev?.type === 'activate') this.fc.push(new FaDetailScreen(this.fc, ev.row.id));
    } else if (this.section === 'offers') {
      const ev = this.offers.update(dt, input);
      if (ev?.type === 'back') this.close();
      else if (ev?.type === 'activate') this.activateOffer(ev.row);
    } else {
      const ev = this.signings.update(dt, input);
      if (ev?.type === 'back') this.close();
      else if (ev?.type === 'activate') this.fc.openPlayer(ev.row.playerId);
    }
  }

  /** Lays out and draws the filter chips; returns their height. */
  private drawChips(ctx: UiCtx, theme: Theme, body: Rect): number {
    const size = theme.textScale;
    const h = theme.lineHeight;
    let x = body.x;
    this.chipRects = [];
    const items: { key: FaFilterKey | 'clear'; label: string; active: boolean }[] = [
      ...FILTER_KEYS.map((key) => ({ key, label: filterLabel(key, this.filtersValue[key]), active: this.filtersValue[key] !== DEFAULT_FA_FILTERS[key] })),
      { key: 'clear' as const, label: 'Clear', active: false },
    ];
    for (const item of items) {
      const w = measureText(item.label, size).width + theme.gap * 2;
      if (x + w > body.x + body.w) break;
      const rect = { x, y: body.y, w, h: h - 2 };
      ctx.fillStyle = item.active ? theme.colors.selection : theme.colors.panelLight;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      drawText(ctx, item.label, x + theme.gap, body.y + Math.floor((h - 2 - theme.glyphH) / 2), { color: item.active ? theme.colors.accent : theme.colors.text, size });
      this.chipRects.push({ key: item.key, rect });
      x += w + theme.gap;
    }
    return h;
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    if (this.section === 'pool') {
      // The filter chips give way when they would leave the table fewer than MIN_BODY_LINES lines (filters stay in MENU).
      const room = Math.floor((body.h - theme.lineHeight) / theme.lineHeight) >= MIN_BODY_LINES;
      if (!room) this.chipRects = [];
      const used = room ? this.drawChips(ctx, theme, body) : 0;
      drawDataTable(ctx, theme, this.pool, { x: body.x, y: body.y + used, w: body.w, h: body.h - used });
      return;
    }
    this.chipRects = [];
    if (this.section === 'offers') {
      if (!this.statusValue.started) return drawNotice(ctx, theme, body, { text: 'Open the market and make offers from the Free Agents list', tone: 'dim' });
      drawDataTable(ctx, theme, this.offers, body);
      return;
    }
    drawDataTable(ctx, theme, this.signings, body);
  }
}
