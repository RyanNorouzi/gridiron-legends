/**
 * Pure view-models and actions of the trade builder: tradeable assets of both sides (players and owned draft
 * picks, future years included), the deal being built, the AI's live verdict (evaluateTrade: value balance,
 * reason, counter), the cap preview (tradeCapPreview), the window status (tradeWindowStatus), incoming AI offers
 * (League.pendingTrades) and the trade history. Actions return a new League and never mutate their input.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { capHit, capSpace, leagueCapYear } from '@/franchise/contracts';
import { assetKey } from '@/franchise/gm/roster-ai';
import { TRADE_VALUE, assetValue, currentDraftYear, isUntouchable } from '@/franchise/gm/valuation';
import {
  createTradeOffer, describeAsset, evaluateTrade, proposeTrade, respondToTrade, tradeCapPreview, tradeWindowStatus,
} from '@/franchise/trades';
import type { League, OfferStatus, TradeAsset, TradeEvaluation, TradeOffer } from '@/franchise/types';
import type { Player } from '@/players/types';
import type { DraftPick } from '@/teams/types';
import { formatDate, formatRecord, type Tone } from '../kit/format';
import { pickLabel, sentence, teamAbbr, teamName } from './common';

/** One tradeable asset as a table row. */
export interface AssetRow {
  key: string;
  asset: TradeAsset;
  side: 'user' | 'partner';
  label: string;
  position: string;
  age: number | null;
  overall: number | null;
  capHit: number;
  years: number | null;
  /** League trade value (gm/valuation assetValue). */
  value: number;
  included: boolean;
  untouchable: boolean;
  playerId: PlayerId | null;
}

/** The deal being built. */
export interface TradeDraft {
  partnerId: TeamId | null;
  give: TradeAsset[];
  get: TradeAsset[];
  /** Pending offer this deal answers (it is declined when the deal is submitted). */
  counterOf: string | null;
}

/** An empty deal (optionally with a partner and assets). */
export const emptyDraft = (partnerId: TeamId | null = null, give: TradeAsset[] = [], get: TradeAsset[] = []): TradeDraft => ({ partnerId, give, get, counterOf: null });

/** Picks a team may trade: owned, for this draft or later, not used. */
export const tradeablePicks = (league: League, teamId: TeamId): DraftPick[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const from = currentDraftYear(league);
  const used = new Set(league.draft?.selections.map((s) => s.pick.id) ?? []);
  return team.picks.filter((p) => p.ownerTeamId === teamId && p.year >= from && !used.has(p.id))
    .sort((a, b) => a.year - b.year || a.round - b.round || (a.overall ?? 999) - (b.overall ?? 999));
};

const playerRow = (league: League, p: Player, side: AssetRow['side'], inDeal: ReadonlySet<string>, year: number): AssetRow => {
  const asset: TradeAsset = { kind: 'player', playerId: p.id };
  return {
    key: p.id, asset, side, label: `${p.firstName} ${p.lastName}`, position: p.position, age: p.age, overall: p.overall,
    capHit: capHit(p.contract, year), years: p.contract ? p.contract.yearsRemaining : null, value: Math.round(assetValue(league, asset, year)),
    included: inDeal.has(p.id), untouchable: isUntouchable(p, year, league.settings), playerId: p.id,
  };
};

/** Every tradeable asset of `teamId` (roster players, then picks), marking those in the deal. */
export const assetRows = (league: League, teamId: TeamId, side: AssetRow['side'], deal: TradeDraft): AssetRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const year = leagueCapYear(league);
  const inDeal = new Set([...deal.give, ...deal.get].map(assetKey));
  const players = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p).map((p) => playerRow(league, p, side, inDeal, year));
  const picks = tradeablePicks(league, teamId).map((pick): AssetRow => {
    const asset: TradeAsset = { kind: 'pick', pick };
    return {
      key: pick.id, asset, side, label: pickLabel(league, pick), position: 'PICK', age: null, overall: null, capHit: 0, years: null,
      value: Math.round(assetValue(league, asset, year)), included: inDeal.has(pick.id), untouchable: false, playerId: null,
    };
  });
  return [...players, ...picks];
};

/** Adds the asset to its side of the deal, or removes it when already there. */
export const toggleAsset = (deal: TradeDraft, row: Pick<AssetRow, 'asset' | 'side' | 'key'>): TradeDraft => {
  const list = row.side === 'user' ? deal.give : deal.get;
  const has = list.some((a) => assetKey(a) === row.key);
  const next = has ? list.filter((a) => assetKey(a) !== row.key) : [...list, row.asset];
  return row.side === 'user' ? { ...deal, give: next } : { ...deal, get: next };
};

/** Changes the partner; the partner-side assets are cleared. */
export const withPartner = (deal: TradeDraft, partnerId: TeamId | null): TradeDraft =>
  partnerId === deal.partnerId ? deal : { partnerId, give: deal.give, get: [], counterOf: null };

/** The offer the deal describes (user -> partner), or null without a partner or assets. */
export const draftOffer = (league: League, userId: TeamId, deal: TradeDraft): TradeOffer | null =>
  deal.partnerId && deal.give.length + deal.get.length > 0 ? createTradeOffer(league, userId, deal.partnerId, deal.give, deal.get, userId, 'ui') : null;

/* --------------------------------------------------------------- verdict */

/** What the partner's GM thinks of the deal right now. */
export type DealVerdict = 'empty' | 'accept' | 'counter' | 'reject' | 'blocked';

/** Live summary of the deal. */
export interface DealSummary {
  offer: TradeOffer | null;
  window: { open: boolean; reason: string };
  evaluation: TradeEvaluation | null;
  verdict: DealVerdict;
  verdictText: string;
  tone: Tone;
  /** Category + sentence from TradeEvaluation.reason ("value", "cap", ...). */
  reasonKind: string;
  reasonText: string;
  /** Value the AI receives, the value it would need, and a bar scale. */
  received: number;
  required: number;
  given: number;
  /** Cap room after the trade (null without an offer). */
  capAfter: { user: number; partner: number } | null;
  counter: TradeOffer | null;
  counterText: string | null;
}

/** The margin the AI demands from the user at the league's difficulty. */
export const userMargin = (league: League): number => TRADE_VALUE.userMarginByDifficulty[league.settings.difficulty.id] ?? 0.06;

/** Splits "category: message" (TradeEvaluation.reason) into its parts. */
export const splitReason = (reason: string): { kind: string; text: string } => {
  const i = reason.indexOf(': ');
  return i > 0 ? { kind: reason.slice(0, i), text: sentence(reason.slice(i + 2)) } : { kind: '', text: sentence(reason) };
};

/** Evaluates the deal as the partner would (pure; no League change). */
export const dealSummary = (league: League, userId: TeamId, deal: TradeDraft): DealSummary => {
  const window = tradeWindowStatus(league);
  const offer = draftOffer(league, userId, deal);
  const base: DealSummary = {
    offer, window, evaluation: null, verdict: 'empty', verdictText: deal.partnerId ? 'Add assets to build a deal' : 'Choose a trade partner',
    tone: 'dim', reasonKind: '', reasonText: '', received: 0, required: 0, given: 0, capAfter: null, counter: null, counterText: null,
  };
  if (!offer || !deal.partnerId) return base;
  const evaluation = evaluateTrade(league, offer);
  const reason = splitReason(evaluation.reason);
  const cap = tradeCapPreview(league, offer);
  const required = Math.round(evaluation.valueGiven * (1 + userMargin(league)));
  const blocked = ['invalid', 'window', 'roster', 'cap', 'depth'].includes(reason.kind);
  const verdict: DealVerdict = evaluation.accepted ? 'accept' : blocked ? 'blocked' : evaluation.counterOffer ? 'counter' : 'reject';
  const verdictText = verdict === 'accept' ? `${teamAbbr(league, deal.partnerId)} would accept` : verdict === 'counter' ? `${teamAbbr(league, deal.partnerId)} wants more`
    : verdict === 'blocked' ? 'This trade cannot happen' : `${teamAbbr(league, deal.partnerId)} would say no`;
  return {
    ...base, evaluation, verdict, verdictText, tone: verdict === 'accept' ? 'success' : verdict === 'counter' ? 'warning' : 'danger',
    reasonKind: reason.kind, reasonText: reason.text, received: evaluation.valueReceived, given: evaluation.valueGiven, required,
    capAfter: { user: cap[userId] ?? 0, partner: cap[deal.partnerId] ?? 0 },
    counter: evaluation.counterOffer, counterText: evaluation.counterSuggestion,
  };
};

/** Result of submitting a deal. */
export interface TradeResult {
  league: League;
  outcome: 'accepted' | 'countered' | 'rejected';
  message: string;
}

/** The league with the pending offer a deal answers declined (unchanged when it answers none or it is no longer pending). */
const declineAnswered = (league: League, deal: TradeDraft): League =>
  deal.counterOf && league.pendingTrades.some((t) => t.id === deal.counterOf && t.status === 'pending') ? respondToTrade(league, deal.counterOf, false) : league;

/** Proposes the deal (declining the offer it answers first). Throws without a partner/assets or on invalid offers. */
export const submitDeal = (league: League, userId: TeamId, deal: TradeDraft): TradeResult => {
  const offer = draftOffer(league, userId, deal);
  if (!offer || !deal.partnerId) throw new Error('submitDeal: choose a partner and add assets first');
  return proposeOffer(declineAnswered(league, deal), offer);
};

/** Accepts the AI's live counter to the deal (declining the pending offer the deal answers first, like submitDeal). */
export const acceptDealCounter = (league: League, deal: TradeDraft, counter: TradeOffer): TradeResult => proposeOffer(declineAnswered(league, deal), counter);

/** Proposes an offer the user makes (a built deal or the AI's live counter). */
export const proposeOffer = (league: League, offer: TradeOffer): TradeResult => {
  const partner = teamAbbr(league, offer.toTeam);
  const r = proposeTrade(league, offer);
  const ev = r.evaluation;
  if (ev?.accepted) return { league: r.league, outcome: 'accepted', message: `Trade completed with ${partner}` };
  if (ev?.counterOffer) return { league: r.league, outcome: 'countered', message: `${partner} countered: ${ev.counterSuggestion ?? 'see Offers'}` };
  return { league: r.league, outcome: 'rejected', message: `${partner} declined: ${ev ? splitReason(ev.reason).text : 'no answer'}` };
};

/* ---------------------------------------------------------------- offers */

/** A pending offer awaiting the user's answer. */
export interface IncomingRow {
  id: string;
  offer: TradeOffer;
  partnerId: TeamId;
  partner: string;
  kind: 'offer' | 'counter';
  /** What the user would receive / send. */
  get: TradeAsset[];
  give: TradeAsset[];
  getText: string;
  giveText: string;
  /** User cap room after accepting. */
  capAfter: number;
}

const describeAll = (league: League, assets: readonly TradeAsset[]): string => (assets.length ? assets.map((a) => describeAsset(league, a)).join(', ') : 'nothing');

/** Pending offers awaiting the user: AI proposals (toTeam = user) and AI counters to the user's proposals. */
export const pendingForUser = (league: League, userId: TeamId): TradeOffer[] =>
  league.pendingTrades.filter((t) => t.status === 'pending' && (t.toTeam === userId || (t.fromTeam === userId && t.initiatedBy !== userId)));

/** Rows for the pending offers awaiting the user. */
export const incomingRows = (league: League, userId: TeamId): IncomingRow[] =>
  pendingForUser(league, userId)
    .map((offer) => {
      const userIsFrom = offer.fromTeam === userId;
      const partnerId = userIsFrom ? offer.toTeam : offer.fromTeam;
      const get = userIsFrom ? offer.toAssets : offer.fromAssets;
      const give = userIsFrom ? offer.fromAssets : offer.toAssets;
      return {
        id: offer.id, offer, partnerId, partner: teamAbbr(league, partnerId), kind: userIsFrom ? 'counter' as const : 'offer' as const,
        get, give, getText: describeAll(league, get), giveText: describeAll(league, give), capAfter: tradeCapPreview(league, offer)[userId] ?? 0,
      };
    });

/** Answers a pending offer; the message says what happened (a stale offer is withdrawn). */
export const answerOffer = (league: League, offerId: string, accept: boolean): { league: League; message: string; executed: boolean } => {
  const next = respondToTrade(league, offerId, accept);
  const status = next.pendingTrades.find((t) => t.id === offerId)?.status;
  if (!accept) return { league: next, message: 'Offer declined', executed: false };
  const offer = league.pendingTrades.find((t) => t.id === offerId);
  if (status === 'accepted' && offer) return { league: next, message: 'Trade completed', executed: true };
  return { league: next, message: 'The offer is no longer valid and was withdrawn', executed: false };
};

/** A deal pre-filled from a pending offer, for the user to change and send back. */
export const counterDraft = (row: IncomingRow): TradeDraft => ({ partnerId: row.partnerId, give: [...row.give], get: [...row.get], counterOf: row.id });

/* --------------------------------------------------------------- history */

/** One resolved trade offer. */
export interface HistoryRow {
  id: string;
  date: string;
  sortKey: number;
  teams: string;
  summary: string;
  status: OfferStatus;
  tone: Tone;
  involvesUser: boolean;
}

const STATUS_TONE: Record<OfferStatus, Tone> = { pending: 'info', accepted: 'success', rejected: 'danger', withdrawn: 'dim', countered: 'warning' };

/** Resolved offers kept in League.pendingTrades, newest first. */
export const historyRows = (league: League, userId: TeamId): HistoryRow[] =>
  league.pendingTrades
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status !== 'pending')
    .map(({ t, i }) => ({
      id: t.id, date: t.week > 0 ? formatDate(t.year, t.week) : `${t.year} Offseason`, sortKey: t.year * 10000 + t.week * 100 + i,
      teams: `${teamAbbr(league, t.fromTeam)} / ${teamAbbr(league, t.toTeam)}`,
      summary: `${teamAbbr(league, t.fromTeam)} gets ${describeAll(league, t.toAssets)}; ${teamAbbr(league, t.toTeam)} gets ${describeAll(league, t.fromAssets)}`,
      status: t.status, tone: STATUS_TONE[t.status], involvesUser: t.fromTeam === userId || t.toTeam === userId,
    }))
    .sort((a, b) => b.sortKey - a.sortKey);

/* --------------------------------------------------------------- partners */

/** A possible trade partner. */
export interface PartnerRow {
  id: TeamId;
  abbr: string;
  name: string;
  /** Team name without the city (narrow tables, next to the abbreviation). */
  nickname: string;
  record: string;
  overall: number;
  capSpace: number;
  players: number;
}

/** Every other team as a partner candidate. */
export const partnerRows = (league: League, userId: TeamId): PartnerRow[] => {
  const year = leagueCapYear(league);
  return Object.values(league.teams).filter((t) => t.id !== userId).map((t) => {
    const s = league.season.standings[t.id];
    const space = capSpace(t, league.players, league.settings, year);
    return { id: t.id, abbr: t.abbr, name: teamName(league, t.id), nickname: t.name, record: s ? formatRecord(s) : '0-0', overall: t.overall, capSpace: space, players: t.rosterIds.length };
  });
};

/** Badge for the Trades tab: pending offers awaiting the user, or null. */
export const tradeBadge = (league: League): string | null => {
  const user = league.userTeamId;
  if (!user) return null;
  const n = pendingForUser(league, user).length;
  return n > 0 ? String(n) : null;
};

/** The Trades tab shows while the window is open, or while offers involving the user still wait for an answer. */
export const tradesTabAvailable = (league: League): boolean =>
  tradeWindowStatus(league).open || (league.userTeamId !== null && pendingForUser(league, league.userTeamId).length > 0);
