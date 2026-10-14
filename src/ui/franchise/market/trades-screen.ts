/**
 * Trades tab: the trade builder, incoming offers and the trade history.
 *
 * Sections (Y or tap to switch): You Give (your players and picks; Confirm adds/removes one), You Get (first the
 * partner list, Confirm picks a partner; then the partner's players and picks), Deal (live AI verdict with the
 * value balance bar, reason, counter you can accept, cap room after, window status, the assets, Submit), Offers
 * (pending AI offers and counters: accept, decline or counter them in the builder) and History. The action menu
 * (Start / MENU) repeats every action. Pushed full-screen (e.g. from the draft room to trade a pick) Back closes it.
 */
import type { TeamId } from '@/core/ids';
import type { TradeAsset } from '@/franchise/types';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable } from '../kit/data-table-view';
import { ChoiceDialog, ConfirmDialog } from '../kit/dialogs';
import { formatMoney, formatRating, humanize, initialName, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import type { TabSpec } from '../kit/tabbar';
import { InfoView, MarketScreen, actionRow, columnsFor, heading, info, mark, teamAbbr, type InfoRow, type MarketAction } from './common';
import {
  acceptDealCounter, answerOffer, assetRows, counterDraft, dealSummary, emptyDraft, historyRows, incomingRows, partnerRows, submitDeal,
  toggleAsset, tradeablePicks, withPartner, type AssetRow, type DealSummary, type HistoryRow, type IncomingRow, type PartnerRow, type TradeDraft,
} from './trade-model';
import { assetKey } from '@/franchise/gm/roster-ai';

/** Sections of the trades screen. */
export type TradeSection = 'give' | 'get' | 'deal' | 'offers' | 'history';

/** Options of TradesScreen. */
export interface TradesScreenOptions {
  /** Pushed full-screen (Back closes it) instead of hosted by the hub. */
  pushed?: boolean;
  partnerId?: TeamId | null;
  /** Assets of the user's team pre-loaded into the deal (e.g. a draft pick). */
  give?: TradeAsset[];
  section?: TradeSection;
}

const sectionTabs = (offers: number): TabSpec[] => [
  { id: 'give', label: 'You Give' }, { id: 'get', label: 'You Get' }, { id: 'deal', label: 'Deal' },
  { id: 'offers', label: 'Offers', badge: offers > 0 ? String(offers) : null }, { id: 'history', label: 'History' },
];

const ASSET_COLUMNS: readonly Column<AssetRow>[] = [
  { key: 'in', label: 'IN', width: 2, align: 'center', format: (r) => mark(r.included), sortValue: (r) => (r.included ? 1 : 0) },
  { key: 'name', label: 'NAME', shorten: (t) => (/^\d/.test(t) ? t : initialName(t)), flex: 3, minWidth: 8, format: (r) => (r.untouchable ? { text: r.label, tone: 'warning' } : r.label), sortValue: (r) => r.label, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 4, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'age', label: 'AGE', width: 4, align: 'right', format: (r) => (r.age === null ? '-' : String(r.age)), sortValue: (r) => r.age, defaultDir: 'asc' },
  { key: 'ovr', label: 'OVR', width: 4, align: 'right', format: (r) => (r.overall === null ? '-' : formatRating(r.overall)), sortValue: (r) => r.overall },
  { key: 'cap', label: 'CAP', width: 6, align: 'right', format: (r) => (r.capHit ? formatMoney(r.capHit) : '-'), sortValue: (r) => r.capHit },
  { key: 'yrs', label: 'YRS', width: 4, align: 'right', format: (r) => (r.years === null ? '-' : String(r.years)), sortValue: (r) => r.years },
  { key: 'val', label: 'VALUE', width: 6, align: 'right', format: (r) => String(r.value), sortValue: (r) => r.value },
];

const PARTNER_COLUMNS: readonly Column<PartnerRow>[] = [
  { key: 'abbr', label: 'TM', width: 5, format: (r) => r.abbr, sortValue: (r) => r.abbr, defaultDir: 'asc' },
  { key: 'name', label: 'TEAM', flex: 3, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'nick', label: 'TEAM', flex: 3, minWidth: 8, format: (r) => r.nickname, sortValue: (r) => r.nickname, defaultDir: 'asc' },
  { key: 'rec', label: 'REC', width: 6, format: (r) => r.record },
  { key: 'ovr', label: 'OVR', width: 4, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'cap', label: 'CAP ROOM', width: 8, align: 'right', format: (r) => ({ text: formatMoney(r.capSpace), tone: r.capSpace < 0 ? 'danger' : 'normal' }), sortValue: (r) => r.capSpace },
];

const OFFER_COLUMNS: readonly Column<IncomingRow>[] = [
  { key: 'from', label: 'TEAM', width: 4, format: (r) => r.partner, sortValue: (r) => r.partner, defaultDir: 'asc' },
  { key: 'kind', label: 'TYPE', width: 7, format: (r) => (r.kind === 'counter' ? { text: 'Counter', tone: 'warning' } : { text: 'Offer', tone: 'info' }) },
  { key: 'get', label: 'YOU GET', flex: 3, format: (r) => r.getText },
  { key: 'give', label: 'YOU GIVE', flex: 3, format: (r) => r.giveText },
];

const HISTORY_COLUMNS: readonly Column<HistoryRow>[] = [
  { key: 'date', label: 'DATE', width: 10, format: (r) => r.date, sortValue: (r) => r.sortKey },
  { key: 'teams', label: 'TEAMS', width: 9, format: (r) => (r.involvesUser ? { text: r.teams, tone: 'accent' } : r.teams) },
  { key: 'deal', label: 'DEAL', flex: 4, format: (r) => r.summary },
  { key: 'status', label: 'STATUS', width: 9, format: (r) => ({ text: humanize(r.status), tone: r.tone }), sortValue: (r) => r.status, defaultDir: 'asc' },
];

interface Tables {
  give: DataTable<AssetRow>;
  get: DataTable<AssetRow>;
  partners: DataTable<PartnerRow>;
  deal: InfoView;
  offers: DataTable<IncomingRow>;
  history: DataTable<HistoryRow>;
}

const makeTables = (large: boolean): Tables => {
  const assetCols = columnsFor(ASSET_COLUMNS, ['in', 'name', 'pos', 'ovr', 'cap'], large);
  return {
    give: new DataTable(assetCols, [], { rowId: (r) => r.key, initialSort: { key: 'val' } }),
    get: new DataTable(assetCols, [], { rowId: (r) => r.key, initialSort: { key: 'val' } }),
    partners: new DataTable((large ? columnsFor(PARTNER_COLUMNS, ['abbr', 'nick', 'cap'], true) : PARTNER_COLUMNS.filter((c) => c.key !== 'nick')), [], { rowId: (r) => r.id, initialSort: { key: 'abbr' } }),
    deal: new InfoView(),
    offers: new DataTable(columnsFor(OFFER_COLUMNS, ['from', 'get', 'give'], large), [], { rowId: (r) => r.id, emptyText: 'No offers waiting for you' }),
    history: new DataTable(columnsFor(HISTORY_COLUMNS, ['teams', 'deal', 'status'], large), [], { rowId: (r) => r.id, initialSort: { key: 'date' }, emptyText: 'No trades yet' }),
  };
};

/** The trades tab screen. */
export class TradesScreen extends MarketScreen {
  readonly id = 'market-trades';
  private dealValue: TradeDraft;
  private summaryValue: DealSummary | null = null;
  private large = false;
  private tablesValue: Tables = makeTables(false);

  constructor(fc: FranchiseContext, opts: TradesScreenOptions = {}) {
    super(fc, sectionTabs(0), opts.pushed ?? false, opts.section ?? (opts.give?.length ? 'get' : 'give'));
    this.dealValue = emptyDraft(opts.partnerId ?? null, opts.give ?? []);
    this.refresh();
  }

  get deal(): TradeDraft { return this.dealValue; }
  get summary(): DealSummary { return this.summaryValue ?? dealSummary(this.fc.league(), this.fc.userTeamId, this.dealValue); }
  get tables(): Tables { return this.tablesValue; }

  protected title(): string { return 'Trade Builder'; }

  /** Replaces the deal (and refreshes). */
  setDeal(deal: TradeDraft): void {
    this.dealValue = deal;
    this.refresh();
  }

  refresh(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const large = (this.services?.theme.textScale ?? 1) > 1;
    if (large !== this.large) {
      this.tablesValue = makeTables(large);
      this.large = large;
    }
    this.dealValue = this.pruned(this.dealValue);
    const deal = this.dealValue;
    this.summaryValue = dealSummary(league, user, deal);
    const t = this.tablesValue;
    t.give.setRows(assetRows(league, user, 'user', deal));
    t.get.setRows(deal.partnerId ? assetRows(league, deal.partnerId, 'partner', deal) : []);
    t.partners.setRows(partnerRows(league, user));
    t.deal.setRows(this.dealRows(t.get.rows));
    const incoming = incomingRows(league, user);
    t.offers.setRows(incoming);
    t.history.setRows(historyRows(league, user));
    this.bar.setTabs(sectionTabs(incoming.length));
  }

  /** The deal without assets its side no longer owns (after trades, cuts or picks being used). */
  private pruned(deal: TradeDraft): TradeDraft {
    const league = this.fc.league();
    const owns = (teamId: TeamId | null, a: TradeAsset): boolean => {
      if (!teamId) return false;
      return a.kind === 'player' ? league.players[a.playerId]?.teamId === teamId : tradeablePicks(league, teamId).some((p) => p.id === a.pick.id);
    };
    const give = deal.give.filter((a) => owns(this.fc.userTeamId, a));
    const get = deal.get.filter((a) => owns(deal.partnerId, a));
    return give.length === deal.give.length && get.length === deal.get.length ? deal : { ...deal, give, get };
  }

  private dealRows(partnerRowsNow: readonly AssetRow[] = this.tablesValue.get.rows): InfoRow[] {
    const s = this.summary;
    const league = this.fc.league();
    const deal = this.dealValue;
    const rows: InfoRow[] = [info('verdict', 'Verdict', { text: s.verdictText, tone: s.tone })];
    if (s.reasonText) rows.push(info('reason', 'Reason', s.reasonText));
    if (s.evaluation && s.verdict !== 'blocked') {
      const max = Math.max(1, s.received, s.required) * 1.2;
      const tone = s.received >= s.required ? 'success' : 'warning';
      rows.push(info('value', 'Value vs need', { text: `${s.received}/${s.required}`, tone }, { value: s.received, max, marker: s.required, tone }));
      rows.push(info('balance', 'Balance', `They value your side at ${s.received} and theirs at ${s.given}; they need ${s.required}`));
    }
    if (s.counter) rows.push(actionRow('accept-counter', 'Accept counter', s.counterText ?? ''));
    if (s.capAfter && deal.partnerId) {
      const tone = s.capAfter.user < 0 ? 'danger' : 'normal';
      rows.push(info('cap', 'Cap room after', { text: `You ${formatMoney(s.capAfter.user)} / ${teamAbbr(league, deal.partnerId)} ${formatMoney(s.capAfter.partner)}`, tone }));
    }
    rows.push(info('window', 'Window', { text: s.window.reason, tone: s.window.open ? 'success' : 'danger' }));
    const lookup = new Map([
      ...(deal.give.length ? this.tablesValue.give.rows : []),
      ...(deal.get.length ? partnerRowsNow : []),
    ].map((r) => [`${r.side}:${r.key}`, r]));
    const assetLine = (side: 'give' | 'get', a: TradeAsset): InfoRow => {
      const row = lookup.get(`${side === 'give' ? 'user' : 'partner'}:${assetKey(a)}`);
      const value = row ? `${row.position}${row.overall !== null ? ` ${row.overall}` : ''}${row.capHit ? ` · ${formatMoney(row.capHit)}` : ''} · value ${row.value}` : '';
      return { id: `${side}:${assetKey(a)}`, label: row?.label ?? assetKey(a), value, kind: 'info', action: `remove:${assetKey(a)}` };
    };
    rows.push(heading('give-h', `You give (${deal.give.length})`), ...deal.give.map((a) => assetLine('give', a)));
    rows.push(heading('get-h', `You get (${deal.get.length})`), ...deal.get.map((a) => assetLine('get', a)));
    if (s.offer) rows.push(actionRow('submit', 'Submit offer', s.window.open ? '' : { text: 'window closed', tone: 'danger' }));
    rows.push(actionRow('partner', 'Change partner', deal.partnerId ? teamAbbr(league, deal.partnerId) : 'none'));
    if (deal.give.length + deal.get.length > 0) rows.push(actionRow('clear', 'Clear deal'));
    return rows;
  }

  status(): ToneText {
    const league = this.fc.league();
    const s = this.summary;
    if (!s.window.open && this.section !== 'history') return { text: `Trades closed: ${s.window.reason}`, tone: 'danger' };
    if (this.section === 'offers') {
      const n = this.tablesValue.offers.rows.length;
      return { text: n ? `${n} offer${n === 1 ? '' : 's'} waiting for your answer` : 'No offers waiting', tone: n ? 'warning' : 'dim' };
    }
    if (this.section === 'history') return { text: `${this.tablesValue.history.rows.length} recent trade offers`, tone: 'dim' };
    const d = this.dealValue;
    const partner = d.partnerId ? teamAbbr(league, d.partnerId) : 'no partner';
    return { text: `${partner} · give ${d.give.length} · get ${d.get.length} · ${s.verdictText}`, tone: s.tone };
  }

  private selectedAsset(): AssetRow | null {
    if (this.section === 'give') return this.tablesValue.give.selected;
    if (this.section === 'get' && this.dealValue.partnerId) return this.tablesValue.get.selected;
    return null;
  }

  actions(): MarketAction[] {
    const s = this.summary;
    const out: MarketAction[] = [];
    const asset = this.selectedAsset();
    if (asset) out.push({ id: 'toggle', label: asset.included ? `Remove ${asset.label}` : `Add ${asset.label}` });
    if (asset?.playerId) out.push({ id: 'card', label: 'Player card' });
    const offer = this.section === 'offers' ? this.tablesValue.offers.selected : null;
    if (offer) out.push({ id: 'offer-accept', label: `Accept ${offer.partner} ${offer.kind}` }, { id: 'offer-decline', label: 'Decline it' }, { id: 'offer-counter', label: 'Counter it' });
    const closed = s.window.open ? null : 'window closed';
    out.push({ id: 'submit', label: 'Submit offer', disabledReason: s.offer ? closed : 'deal is empty' });
    if (s.counter) out.push({ id: 'accept-counter', label: 'Accept counter', disabledReason: closed });
    out.push({ id: 'partner', label: 'Change partner' }, { id: 'review', label: 'Review deal' });
    if (this.dealValue.give.length + this.dealValue.get.length > 0) out.push({ id: 'clear', label: 'Clear deal' });
    return out;
  }

  private confirm(title: string, message: string, yes: () => void): void {
    this.fc.push(new ConfirmDialog(title, message, { onResult: (ok) => { if (ok) yes(); } }));
  }

  runAction(id: string): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const s = this.summary;
    if (id.startsWith('remove:')) {
      const key = id.slice(7);
      const d = this.dealValue;
      return this.setDeal({ ...d, give: d.give.filter((a) => assetKey(a) !== key), get: d.get.filter((a) => assetKey(a) !== key) });
    }
    switch (id) {
      case 'toggle': {
        const row = this.selectedAsset();
        if (row) this.setDeal(toggleAsset(this.dealValue, row));
        return;
      }
      case 'card': {
        const pid = this.selectedAsset()?.playerId;
        if (pid) this.fc.openPlayer(pid);
        return;
      }
      case 'submit':
        if (!s.offer) return this.fc.toast('Add assets to the deal first');
        if (!s.window.open) return this.fc.toast(`Trades closed: ${s.window.reason}`);
        return this.confirm('Send offer?', `${s.verdictText}. If ${teamAbbr(league, this.dealValue.partnerId)} accepts, the trade happens at once.`, () => {
          this.attempt(() => {
            const r = submitDeal(this.fc.league(), user, this.dealValue);
            this.dealValue = r.outcome === 'accepted' ? emptyDraft(this.dealValue.partnerId) : { ...this.dealValue, counterOf: null };
            this.commit(r.league, r.outcome === 'accepted' ? 'trade' : 'edit', r.message);
            if (r.outcome === 'countered') this.showSection('offers');
          });
        });
      case 'accept-counter': {
        const counter = s.counter;
        if (!counter) return;
        return this.confirm('Accept counter?', `${s.counterText ?? 'Their counter'}. The trade happens at once.`, () => {
          this.attempt(() => {
            const r = acceptDealCounter(this.fc.league(), this.dealValue, counter);
            this.dealValue = r.outcome === 'accepted' ? emptyDraft(this.dealValue.partnerId) : { ...this.dealValue, counterOf: null };
            this.commit(r.league, r.outcome === 'accepted' ? 'trade' : 'edit', r.message);
          });
        });
      }
      case 'partner':
        this.dealValue = withPartner(this.dealValue, null);
        this.showSection('get');
        return this.refresh();
      case 'review':
        this.showSection('deal');
        return;
      case 'clear':
        return this.setDeal(emptyDraft(this.dealValue.partnerId));
      case 'offer-accept':
      case 'offer-decline':
      case 'offer-counter': {
        const row = this.tablesValue.offers.selected;
        if (row) this.answer(row, id === 'offer-accept' ? 'accept' : id === 'offer-decline' ? 'decline' : 'counter');
        return;
      }
      default:
    }
  }

  /** Accepts, declines or counters a pending offer. */
  answer(row: IncomingRow, how: 'accept' | 'decline' | 'counter'): void {
    if (how === 'counter') {
      this.dealValue = counterDraft(row);
      this.showSection('deal');
      return this.refresh();
    }
    this.attempt(() => {
      const r = answerOffer(this.fc.league(), row.id, how === 'accept');
      this.commit(r.league, r.executed ? 'trade' : 'edit', r.message);
    });
  }

  private openOffer(row: IncomingRow): void {
    const msg = `You get: ${row.getText}. You give: ${row.giveText}. Your cap room after: ${formatMoney(row.capAfter)}.`;
    this.fc.push(new ChoiceDialog(`${row.partner} ${row.kind}`, msg, [
      { id: 'accept', label: 'Accept' }, { id: 'decline', label: 'Decline' }, { id: 'counter', label: 'Counter in builder' }, { id: 'cancel', label: 'Not now' },
    ], (id) => {
      if (id === 'accept' || id === 'decline' || id === 'counter') this.answer(row, id);
    }));
  }

  protected override onSectionChange(): void {
    this.tablesValue.deal.setRows(this.dealRows());
  }

  protected updateBody(dt: number, input: InputState): void {
    const t = this.tablesValue;
    switch (this.section) {
      case 'give':
      case 'get': {
        if (this.section === 'get' && !this.dealValue.partnerId) {
          const ev = t.partners.update(dt, input);
          if (ev?.type === 'back') return this.close();
          if (ev?.type === 'activate') this.setDeal(withPartner(this.dealValue, ev.row.id));
          return;
        }
        const ev = (this.section === 'give' ? t.give : t.get).update(dt, input);
        if (ev?.type === 'back') return this.close();
        if (ev?.type === 'activate') this.setDeal(toggleAsset(this.dealValue, ev.row));
        return;
      }
      case 'deal': {
        const ev = t.deal.table.update(dt, input);
        if (ev?.type === 'back') return this.close();
        if (ev?.type === 'activate' && ev.row.action) this.runAction(ev.row.action);
        return;
      }
      case 'offers': {
        const ev = t.offers.update(dt, input);
        if (ev?.type === 'back') return this.close();
        if (ev?.type === 'activate') this.openOffer(ev.row);
        return;
      }
      default: {
        const ev = t.history.update(dt, input);
        if (ev?.type === 'back') return this.close();
        if (ev?.type === 'activate') this.fc.push(new ChoiceDialog(`${ev.row.date} · ${humanize(ev.row.status)}`, ev.row.summary, [{ id: 'ok', label: 'OK' }], () => undefined));
      }
    }
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    const t = this.tablesValue;
    switch (this.section) {
      case 'give': drawDataTable(ctx, theme, t.give, body); break;
      case 'get':
        if (this.dealValue.partnerId) drawDataTable(ctx, theme, t.get, body);
        else drawDataTable(ctx, theme, t.partners, body);
        break;
      case 'deal': t.deal.draw(ctx, theme, body); break;
      case 'offers': drawDataTable(ctx, theme, t.offers, body); break;
      default: drawDataTable(ctx, theme, t.history, body);
    }
  }
}
