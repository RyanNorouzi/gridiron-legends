import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { assetKey } from '@/franchise/gm/roster-ai';
import { createTradeOffer, evaluateTrade, tradeCapPreview, tradeWindowStatus } from '@/franchise/trades';
import type { League, TradeAsset } from '@/franchise/types';
import { ChoiceDialog, ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import {
  acceptDealCounter, answerOffer, assetRows, counterDraft, dealSummary, emptyDraft, historyRows, incomingRows, partnerRows, submitDeal, toggleAsset, tradeBadge,
  tradeablePicks, tradesTabAvailable, withPartner, type AssetRow, type TradeDraft,
} from '@/ui/franchise/market/trade-model';
import { TradesScreen } from '@/ui/franchise/market/trades-screen';
import { centre, contextFor, mount, press, rcFor, regularSeasonLeague, tap } from './fixtures';

let base: League;
let user: TeamId;
let partner: TeamId;

beforeAll(() => {
  const l = regularSeasonLeague();
  base = { ...l, pendingTrades: [] };
  user = l.userTeamId as TeamId;
  partner = (Object.keys(l.teams) as TeamId[]).sort().find((id) => id !== user) as TeamId;
});

const rowsOf = (teamId: TeamId, side: AssetRow['side'], deal: TradeDraft = emptyDraft(partner)): AssetRow[] => assetRows(base, teamId, side, deal);
const players = (rows: AssetRow[]): AssetRow[] => rows.filter((r) => r.playerId !== null).sort((a, b) => a.value - b.value);
const picks = (rows: AssetRow[]): AssetRow[] => rows.filter((r) => r.playerId === null);

/** User sends his two earliest first-round picks for the partner's least valuable player: an easy yes. */
const generousDeal = (): TradeDraft => {
  const firsts = picks(rowsOf(user, 'user')).filter((r) => r.label.includes('Rd 1')).slice(0, 2);
  const cheap = players(rowsOf(partner, 'partner')).find((r) => r.position === 'WR') as AssetRow;
  return { partnerId: partner, give: firsts.map((r) => r.asset), get: [cheap.asset], counterOf: null };
};

/** User sends his latest pick for the partner's most valuable player he can fit under the cap: a no. */
const cheekyDeal = (): TradeDraft => {
  const late = picks(rowsOf(user, 'user')).sort((a, b) => a.value - b.value)[0] as AssetRow;
  const deals = players(rowsOf(partner, 'partner')).reverse().map((star): TradeDraft => ({ partnerId: partner, give: [late.asset], get: [star.asset], counterOf: null }));
  const deal = deals.find((d) => dealSummary(base, user, d).verdict !== 'blocked');
  if (!deal) throw new Error('no feasible cheeky deal');
  return deal;
};

describe('trade view-models', () => {
  it('lists every tradeable asset of a side, future picks included', () => {
    const rows = rowsOf(user, 'user');
    const team = base.teams[user];
    expect(players(rows)).toHaveLength(team?.rosterIds.length ?? -1);
    const pk = tradeablePicks(base, user);
    expect(picks(rows).map((r) => r.key)).toEqual(pk.map((p) => p.id));
    expect(pk.some((p) => p.year > base.year)).toBe(true);
    expect(rows.every((r) => !r.included && r.value > 0)).toBe(true);
    const first = rows[0] as AssetRow;
    const deal = toggleAsset(emptyDraft(partner), first);
    expect(deal.give.map(assetKey)).toEqual([first.key]);
    expect(assetRows(base, user, 'user', deal).find((r) => r.key === first.key)?.included).toBe(true);
    expect(toggleAsset(deal, first).give).toEqual([]);
    const withGet = toggleAsset(deal, rowsOf(partner, 'partner')[0] as AssetRow);
    expect(withGet.get).toHaveLength(1);
    expect(withPartner(withGet, null)).toEqual({ partnerId: null, give: deal.give, get: [], counterOf: null });
    expect(partnerRows(base, user).map((r) => r.id)).not.toContain(user);
  });

  it('evaluates deals live exactly like the AI would', () => {
    expect(dealSummary(base, user, emptyDraft()).verdict).toBe('empty');
    const yes = dealSummary(base, user, generousDeal());
    const offer = yes.offer;
    if (!offer) throw new Error('no offer');
    const ev = evaluateTrade(base, offer);
    expect(yes.verdict).toBe('accept');
    expect(yes.tone).toBe('success');
    expect(yes.received).toBe(ev.valueReceived);
    expect(yes.given).toBe(ev.valueGiven);
    expect(yes.received).toBeGreaterThanOrEqual(yes.required);
    expect(yes.capAfter).toEqual({ user: tradeCapPreview(base, offer)[user], partner: tradeCapPreview(base, offer)[partner] });
    expect(yes.window).toEqual(tradeWindowStatus(base));
    const no = dealSummary(base, user, cheekyDeal());
    expect(['counter', 'reject']).toContain(no.verdict);
    expect(no.received).toBeLessThan(no.required);
    expect(no.reasonText.length).toBeGreaterThan(0);
  });

  it('submits a deal: accepted trades execute and land in the history', () => {
    const deal = generousDeal();
    const r = submitDeal(base, user, deal);
    expect(r.outcome).toBe('accepted');
    const got = deal.get[0] as TradeAsset & { kind: 'player' };
    expect(r.league.players[got.playerId]?.teamId).toBe(user);
    const sent = deal.give[0] as TradeAsset & { kind: 'pick' };
    expect(r.league.teams[partner]?.picks.some((p) => p.id === sent.pick.id)).toBe(true);
    const hist = historyRows(r.league, user);
    expect(hist[0]?.status).toBe('accepted');
    expect(hist[0]?.involvesUser).toBe(true);
    expect(() => submitDeal(base, user, emptyDraft(partner))).toThrow();
  });

  it('answers incoming offers: accept, decline and counter', () => {
    const theirs = players(rowsOf(partner, 'partner'))[3] as AssetRow;
    const mine = picks(rowsOf(user, 'user'))[0] as AssetRow;
    const offer = createTradeOffer(base, partner, user, [theirs.asset], [mine.asset], partner);
    const league: League = { ...base, pendingTrades: [offer] };
    const rows = incomingRows(league, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('offer');
    expect(rows[0]?.getText).toContain(theirs.label);
    expect(tradeBadge(league)).toBe('1');
    const accepted = answerOffer(league, offer.id, true);
    expect(accepted.executed).toBe(true);
    expect(accepted.league.players[theirs.playerId as PlayerId]?.teamId).toBe(user);
    expect(accepted.league.teams[partner]?.picks.find((p) => p.id === mine.key)?.ownerTeamId).toBe(partner);
    expect(accepted.league.teams[user]?.picks.some((p) => p.id === mine.key)).toBe(false);
    const declined = answerOffer(league, offer.id, false);
    expect(declined.league.pendingTrades[0]?.status).toBe('rejected');
    expect(tradeBadge(declined.league)).toBeNull();
    const draft = counterDraft(rows[0] as (typeof rows)[number]);
    expect(draft).toMatchObject({ partnerId: partner, counterOf: offer.id });
    expect(draft.get.map(assetKey)).toEqual([theirs.key]);
    const sent = submitDeal(league, user, { ...draft, give: [...draft.give, ...(picks(rowsOf(user, 'user')).slice(1, 3).map((r) => r.asset))] });
    expect(sent.league.pendingTrades.find((t) => t.id === offer.id)?.status).toBe('rejected');
  });

  it('reports a closed window and hides the tab unless offers wait', () => {
    const closed: League = { ...base, season: { ...base.season, week: base.settings.tradeDeadlineWeek + 1 } };
    const s = dealSummary(closed, user, generousDeal());
    expect(s.window.open).toBe(false);
    expect(s.verdict).toBe('blocked');
    expect(tradesTabAvailable(closed)).toBe(false);
    expect(tradesTabAvailable(base)).toBe(true);
    const fc = contextFor(closed);
    const screen = mount(fc, new TradesScreen(fc));
    expect(screen.status().tone).toBe('danger');
    screen.setDeal(generousDeal());
    expect(screen.actions().find((a) => a.id === 'submit')?.disabledReason).toBe('window closed');
  });
});

describe('TradesScreen', () => {
  it('builds and submits a deal with the keyboard (hub keys are left to the hub)', () => {
    const fc = contextFor(base);
    const screen = mount(fc, new TradesScreen(fc));
    expect(screen.section).toBe('give');
    screen.update(1 / 60, press('menuTabRight'));
    screen.update(1 / 60, press('back'));
    expect(screen.section).toBe('give');
    expect(fc.pops()).toBe(0);
    screen.update(1 / 60, press('confirm'));
    expect(screen.deal.give).toHaveLength(1);
    screen.update(1 / 60, press('audible'));
    expect(screen.section).toBe('get');
    screen.update(1 / 60, press('confirm'));
    expect(screen.deal.partnerId).toBe(screen.tables.partners.rows[0]?.id);
    screen.update(1 / 60, press('confirm'));
    expect(screen.deal.get).toHaveLength(1);
    screen.setDeal(generousDeal());
    screen.showSection('deal');
    expect(screen.tables.deal.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['verdict', 'value', 'cap', 'window', 'submit']));
    screen.runAction('submit');
    const dialog = fc.stack.top;
    expect(dialog).toBeInstanceOf(ConfirmDialog);
    (dialog as ConfirmDialog).choose(true);
    expect(fc.commits.at(-1)?.reason).toBe('trade');
    expect(fc.toasts.at(-1)).toContain('completed');
    expect(screen.deal.give).toEqual([]);
    screen.render(rcFor(fc));
  });

  it('opens the action menu with Start or a tap on MENU, and switches sections by tap', () => {
    const fc = contextFor(base);
    const screen = mount(fc, new TradesScreen(fc));
    screen.update(1 / 60, press('pause'));
    const menu = fc.stack.top;
    expect(menu).toBeInstanceOf(ChoiceDialog);
    (menu as ChoiceDialog).choose('review');
    expect(screen.section).toBe('deal');
    const lay = screen.frameLayout;
    if (!lay) throw new Error('no layout');
    tap((i) => screen.update(1 / 60, i), ...centre(lay.menu));
    expect(fc.stack.top).toBeInstanceOf(ChoiceDialog);
    (fc.stack.top as ChoiceDialog).choose(null);
    // LT (keyboard C / N) also opens it: the hub keeps Start for its Advance menu.
    screen.update(1 / 60, press('callTimeout'));
    expect(fc.stack.top).toBeInstanceOf(ChoiceDialog);
    (fc.stack.top as ChoiceDialog).choose(null);
    const tabs = screen.bar.layout(fc.services.theme, lay.bar).tabs;
    const history = tabs.find((t) => screen.bar.tabs[t.index]?.id === 'history');
    if (!history) throw new Error('history tab not visible');
    tap((i) => screen.update(1 / 60, i), history.x + 2, lay.bar.y + 2);
    expect(screen.section).toBe('history');
  });

  it('toggles an asset once per mouse click and once per touch tap', () => {
    const fc = contextFor(base);
    const screen = mount(fc, new TradesScreen(fc, { partnerId: partner }));
    const hit = screen.tables.give.hitMap?.rows[1];
    if (!hit) throw new Error('no row geometry');
    const key = screen.tables.give.rows[1]?.key;
    tap((i) => screen.update(1 / 60, i), ...centre(hit.rect), 'mouse');
    expect(screen.deal.give.map(assetKey)).toEqual([key]);
    screen.render(rcFor(fc));
    tap((i) => screen.update(1 / 60, i), ...centre(hit.rect), 'touch');
    expect(screen.deal.give).toEqual([]);
  });

  it('accepts and counters incoming offers from the Offers section', () => {
    const theirs = players(rowsOf(partner, 'partner'))[2] as AssetRow;
    const mine = picks(rowsOf(user, 'user'))[0] as AssetRow;
    const offer = createTradeOffer(base, partner, user, [theirs.asset], [mine.asset], partner);
    const fc = contextFor({ ...base, pendingTrades: [offer] });
    const screen = mount(fc, new TradesScreen(fc, { section: 'offers' }));
    expect(screen.bar.tabs.find((t) => t.id === 'offers')?.badge).toBe('1');
    screen.update(1 / 60, press('confirm'));
    const dialog = fc.stack.top as ChoiceDialog;
    expect(dialog).toBeInstanceOf(ChoiceDialog);
    dialog.choose('counter');
    expect(screen.section).toBe('deal');
    expect(screen.deal.counterOf).toBe(offer.id);
    screen.showSection('offers');
    screen.answer(incomingRows(fc.league(), user)[0] as ReturnType<typeof incomingRows>[number], 'accept');
    expect(fc.commits.at(-1)?.reason).toBe('trade');
    expect(fc.league().players[theirs.playerId as PlayerId]?.teamId).toBe(user);
  });

  it('accepts the AI counter to a lopsided ask when one is offered', () => {
    const third = picks(rowsOf(user, 'user')).find((r) => r.label.startsWith(`${base.year} Rd 3`)) as AssetRow;
    const targets = players(rowsOf(partner, 'partner')).reverse();
    let found: TradeDraft | null = null;
    for (const t of targets) {
      const d: TradeDraft = { partnerId: partner, give: [third.asset], get: [t.asset], counterOf: null };
      if (dealSummary(base, user, d).verdict === 'counter') { found = d; break; }
    }
    if (!found) throw new Error('no counter found');
    const fc = contextFor(base);
    const screen = mount(fc, new TradesScreen(fc, { section: 'deal' }));
    screen.setDeal(found);
    expect(screen.tables.deal.rows.some((r) => r.id === 'accept-counter')).toBe(true);
    screen.runAction('accept-counter');
    (fc.stack.top as ConfirmDialog).choose(true);
    expect(fc.commits.at(-1)?.reason).toBe('trade');
    expect(fc.league().teams[partner]?.picks.some((p) => p.id === (third.asset as TradeAsset & { kind: 'pick' }).pick.id)).toBe(true);
  });

  it('declines the offer a deal answers when the user takes the live counter instead', () => {
    const third = picks(rowsOf(user, 'user')).find((r) => r.label.startsWith(`${base.year} Rd 3`)) as AssetRow;
    const found = players(rowsOf(partner, 'partner')).reverse()
      .map((t): TradeDraft => ({ partnerId: partner, give: [third.asset], get: [t.asset], counterOf: null }))
      .find((d) => dealSummary(base, user, d).verdict === 'counter');
    if (!found) throw new Error('no counter found');
    const cheap = players(rowsOf(user, 'user'))[0] as AssetRow;
    const theirs = players(rowsOf(partner, 'partner'))[0] as AssetRow;
    const incoming = createTradeOffer(base, partner, user, [theirs.asset], [cheap.asset], partner);
    const league: League = { ...base, pendingTrades: [incoming] };
    const deal: TradeDraft = { ...found, counterOf: incoming.id };
    const counter = dealSummary(league, user, deal).counter;
    if (!counter) throw new Error('no live counter');
    const r = acceptDealCounter(league, deal, counter);
    expect(r.league.pendingTrades.find((t) => t.id === incoming.id)?.status).toBe('rejected');
    expect(r.league.pendingTrades.some((t) => t.status === 'pending' && t.id === incoming.id)).toBe(false);
    expect(league.pendingTrades[0]?.status).toBe('pending');
    const fc = contextFor(league);
    const screen = mount(fc, new TradesScreen(fc, { section: 'deal' }));
    screen.setDeal(deal);
    screen.runAction('accept-counter');
    (fc.stack.top as ConfirmDialog).choose(true);
    expect(fc.league().pendingTrades.find((t) => t.id === incoming.id)?.status).toBe('rejected');
    expect(screen.deal.counterOf).toBeNull();
  });

  it('works pushed full-screen (U/O switch sections, Back closes) and in large text', () => {
    const fc = contextFor(base, true);
    const pick = tradeablePicks(base, user)[0];
    if (!pick) throw new Error('no pick');
    const screen = new TradesScreen(fc, { pushed: true, give: [{ kind: 'pick', pick }] });
    fc.push(screen);
    screen.render(rcFor(fc));
    expect(screen.section).toBe('get');
    expect(screen.deal.give).toHaveLength(1);
    expect(screen.tables.give.columns.map((c) => c.key)).toEqual(['in', 'name', 'pos', 'ovr', 'cap']);
    fc.tick(press('menuTabRight'));
    expect(screen.section).toBe('deal');
    screen.render(rcFor(fc));
    const lay = screen.frameLayout;
    if (!lay) throw new Error('no layout');
    expect(lay.hints).not.toBeNull();
    expect(lay.body.y + lay.body.h).toBeLessThanOrEqual((lay.hints?.y ?? 0) + 1);
    for (const r of screen.tables.deal.table.hitMap?.rows ?? []) expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(lay.body.y + lay.body.h);
    fc.tick(press('back'));
    expect(fc.pops()).toBe(1);
  });
});
