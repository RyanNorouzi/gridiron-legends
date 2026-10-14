/**
 * Pure view-models and actions of the free-agency tab: the pool with filters (position / overall / age / ask),
 * each player's ask of the user's team (playerAsk), what he cares about (preferenceWeights) and how the user's
 * team scores on each (preferenceBreakdown), the user's offers per round (stored as pending FreeAgentOffers in
 * League.freeAgency.offers so they survive screen changes and saves), round and finish controls, the signings log
 * and live cap space. User offers of the current round are the ones submitted to runFreeAgencyRound; a player's
 * counter from an earlier round is submitted only when the user accepts it (its round is moved to the current).
 *
 * The player's exact signing bar is never shown: the offer read is the staff's banded, noisy estimate
 * (franchise/fa-talks.ts faInterestEstimate), and each refused round wears his patience with the user's team down
 * until he walks away, so an offer cannot be tuned to the bar by probing.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { markTask } from '@/franchise/awards';
import { MAX_CONTRACT_YEARS, capSpace, contractApy, leagueCapYear, minimumSalaryFor, type ContractTerms } from '@/franchise/contracts';
import type { InterestBand } from '@/franchise/extension-talks';
import { faInterestEstimate, faPatienceText, faTalks, walkedAway } from '@/franchise/fa-talks';
import { expiredContractIds, finishFreeAgency, isFreeAgencyOpen, makeFreeAgentOffer, runFreeAgencyRound, startFreeAgency } from '@/franchise/free-agency';
import {
  PREFERENCE_KEYS, playerAsk, playerPatience, preferenceBreakdown, preferenceScore, preferenceWeights, type ContractAsk, type PreferenceKey,
} from '@/franchise/negotiation';
import { rosterLimitFor } from '@/franchise/roster';
import type { FreeAgentOffer, League, OfferStatus } from '@/franchise/types';
import { POSITIONS, type ContractRole, type Player, type Position } from '@/players/types';
import type { StepperSpec } from '../kit/dialog-models';
import { formatMoney, humanize, type Tone, type ToneText } from '../kit/format';
import { potentialVisibility } from '../kit/player-view';
import { teamAbbr } from './common';

/* ---------------------------------------------------------------- filters */

/** Pool filters (null / 0 = any). */
export interface FaFilters {
  position: Position | null;
  minOverall: number;
  maxAge: number | null;
  maxAsk: number | null;
}

/** No filter: every free agent. */
export const DEFAULT_FA_FILTERS: Readonly<FaFilters> = Object.freeze({ position: null, minOverall: 0, maxAge: null, maxAsk: null });

/** Choices offered for each filter, in cycling order. */
export const FA_FILTER_CHOICES = {
  position: [null, ...POSITIONS] as readonly (Position | null)[],
  minOverall: [0, 55, 60, 65, 70, 75, 80, 85] as readonly number[],
  maxAge: [null, 23, 25, 27, 29, 31, 33] as readonly (number | null)[],
  maxAsk: [null, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 20_000_000] as readonly (number | null)[],
};

/** Filter keys. */
export type FaFilterKey = keyof FaFilters;

/** Short label of a filter value ("Pos QB", "OVR 70+", "Age 25-", "Ask $5.0M-", "... any"). */
export const filterLabel = (key: FaFilterKey, value: FaFilters[FaFilterKey]): string => {
  switch (key) {
    case 'position': return `Pos ${value ?? 'any'}`;
    case 'minOverall': return value ? `OVR ${value}+` : 'OVR any';
    case 'maxAge': return value ? `Age ${value}-` : 'Age any';
    default: return value ? `Ask ${formatMoney(value as number)}-` : 'Ask any';
  }
};

/** The next choice of one filter (wraps). */
export const cycleFilter = (filters: FaFilters, key: FaFilterKey, delta = 1): FaFilters => {
  const options = FA_FILTER_CHOICES[key] as readonly FaFilters[FaFilterKey][];
  const i = Math.max(0, options.indexOf(filters[key]));
  return { ...filters, [key]: options[(((i + delta) % options.length) + options.length) % options.length] };
};

/* ------------------------------------------------------------------- pool */

/** One free agent as a table row. */
export interface FaPoolRow {
  id: PlayerId;
  name: string;
  position: Position;
  age: number;
  overall: number;
  potential: ToneText;
  ask: ContractAsk;
  offer: 'none' | 'pending' | 'counter';
  offerText: ToneText;
  /** His two biggest priorities ("Money, Winning"). */
  cares: string;
}

const PREF_LABELS: Record<PreferenceKey, string> = {
  money: 'Money', playingTime: 'Playing time', winning: 'Winning', location: 'Location', coach: 'Coach', role: 'Role', chemistry: 'Chemistry',
};

/** Preference keys by the weight the player gives them, biggest first. */
export const priorities = (p: Pick<Player, 'preferences'>): PreferenceKey[] => {
  const w = preferenceWeights(p.preferences);
  return [...PREFERENCE_KEYS].sort((a, b) => w[b] - w[a]);
};

const userTeam = (league: League, userId: TeamId) => {
  const team = league.teams[userId];
  if (!team) throw new Error(`free agency: unknown team ${userId}`);
  return team;
};

/** The user's pending offers of the current round and the counters awaiting him. */
export const userPending = (league: League, userId: TeamId): { current: FreeAgentOffer[]; counters: FreeAgentOffer[] } => {
  const fa = league.freeAgency;
  const mine = fa ? fa.offers.filter((o) => o.teamId === userId && o.status === 'pending') : [];
  return { current: mine.filter((o) => o.round === fa?.round), counters: mine.filter((o) => o.round !== fa?.round) };
};

/** The pool (free agents, best first) with the user's ask, offer state and filters applied. */
export const faPoolRows = (league: League, userId: TeamId, filters: FaFilters = DEFAULT_FA_FILTERS): FaPoolRow[] => {
  const team = userTeam(league, userId);
  const year = leagueCapYear(league);
  const { current, counters } = userPending(league, userId);
  const rows: FaPoolRow[] = [];
  for (const id of league.freeAgentIds) {
    const p = league.players[id];
    if (!p || p.retired) continue;
    if (filters.position && p.position !== filters.position) continue;
    if (p.overall < filters.minOverall) continue;
    if (filters.maxAge !== null && p.age > filters.maxAge) continue;
    const ask = playerAsk(p, league, team, year);
    if (filters.maxAsk !== null && ask.apy > filters.maxAsk) continue;
    const counter = counters.find((o) => o.playerId === id);
    const pending = current.find((o) => o.playerId === id);
    const offer = counter ? 'counter' : pending ? 'pending' : 'none';
    const offerText: ToneText = counter ? { text: `Counter ${formatMoney(contractApy(counter))}`, tone: 'warning' }
      : pending ? { text: `Offer ${formatMoney(contractApy(pending))}`, tone: 'info' }
        : walkedAway(league, userId, id) ? { text: 'Walked away', tone: 'danger' } : { text: '-', tone: 'dim' };
    rows.push({
      id, name: `${p.firstName} ${p.lastName}`, position: p.position, age: p.age, overall: p.overall, potential: potentialVisibility(league, p, userId).text,
      ask, offer, offerText, cares: priorities(p).slice(0, 2).map((k) => PREF_LABELS[k]).join(', '),
    });
  }
  return rows.sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
};

/* ----------------------------------------------------------------- status */

/** Market state for the status line and the action menu. */
export interface FaStatus {
  started: boolean;
  open: boolean;
  finished: boolean;
  round: number;
  maxRounds: number;
  capSpace: number;
  /** APY of the user's current-round offers. */
  pendingApy: number;
  capIfAllSign: number;
  roster: number;
  rosterLimit: number;
  pendingOffers: number;
  counters: number;
  poolSize: number;
  /** The user's players whose deals expire when the market opens (before it starts). */
  expiring: number;
}

/** Free-agency status for the user team. */
export const faStatus = (league: League, userId: TeamId): FaStatus => {
  const team = userTeam(league, userId);
  const fa = league.freeAgency;
  const space = capSpace(team, league.players, league.settings, leagueCapYear(league));
  const { current, counters } = userPending(league, userId);
  const pendingApy = current.reduce((s, o) => s + contractApy(o), 0);
  const started = fa !== null;
  return {
    started, open: isFreeAgencyOpen(league), finished: started && !isFreeAgencyOpen(league), round: fa ? Math.min(fa.round, fa.maxRounds) : 0, maxRounds: fa?.maxRounds ?? 0,
    capSpace: space, pendingApy, capIfAllSign: space - pendingApy, roster: team.rosterIds.length, rosterLimit: rosterLimitFor(league),
    pendingOffers: current.length, counters: counters.length, poolSize: league.freeAgentIds.length,
    expiring: started ? 0 : expiredContractIds(league).filter((id) => team.rosterIds.includes(id)).length,
  };
};

/** Badge for the Free Agency tab: "!" when counters wait, else the round ("R2"), or null before it opens. */
export const faBadge = (league: League): string | null => {
  const user = league.userTeamId;
  if (!user || !league.freeAgency || !isFreeAgencyOpen(league)) return null;
  return userPending(league, user).counters.length > 0 ? '!' : `R${league.freeAgency.round}`;
};

/* ----------------------------------------------------------------- offers */

/** One of the user's offers. */
export interface FaOfferRow {
  id: string;
  offer: FreeAgentOffer;
  playerId: PlayerId;
  name: string;
  position: string;
  overall: number;
  round: number;
  apy: number;
  years: number;
  kind: 'current' | 'counter' | 'resolved';
  status: ToneText;
}

const STATUS_TONE: Record<OfferStatus, Tone> = { pending: 'info', accepted: 'success', rejected: 'danger', withdrawn: 'dim', countered: 'warning' };

/** Every offer the user made this free agency (current round and counters first, then by round, newest first). */
export const userOfferRows = (league: League, userId: TeamId): FaOfferRow[] => {
  const fa = league.freeAgency;
  if (!fa) return [];
  const kindOrder = { counter: 0, current: 1, resolved: 2 } as const;
  return fa.offers.filter((o) => o.teamId === userId).map((o): FaOfferRow => {
    const p = league.players[o.playerId];
    const kind = o.status !== 'pending' ? 'resolved' : o.round === fa.round ? 'current' : 'counter';
    const status: ToneText = kind === 'counter' ? { text: 'Countered - your call', tone: 'warning' } : kind === 'current' ? { text: `Offered (round ${o.round})`, tone: 'info' }
      : { text: humanize(o.status), tone: STATUS_TONE[o.status] };
    return {
      id: o.id, offer: o, playerId: o.playerId, name: p ? `${p.firstName} ${p.lastName}` : o.playerId, position: p?.position ?? '?', overall: p?.overall ?? 0,
      round: o.round, apy: contractApy(o), years: o.years, kind, status,
    };
  }).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.round - a.round || (a.id < b.id ? -1 : 1));
};

/** One completed signing. */
export interface FaSigningRow {
  key: string;
  round: number;
  playerId: PlayerId;
  name: string;
  position: string;
  overall: number;
  team: string;
  apy: number;
  years: number;
  isUser: boolean;
}

/** The league's signings this free agency, newest round first. */
export const signingRows = (league: League, userId: TeamId): FaSigningRow[] =>
  (league.freeAgency?.signings ?? []).map((s, i): FaSigningRow => {
    const p = league.players[s.playerId] ?? league.retiredPlayers[s.playerId];
    return {
      key: `${s.round}-${s.playerId}-${i}`, round: s.round, playerId: s.playerId, name: p ? `${p.firstName} ${p.lastName}` : s.playerId, position: p?.position ?? '?',
      overall: p?.overall ?? 0, team: teamAbbr(league, s.teamId), apy: p?.contract ? contractApy(p.contract) : 0, years: p?.contract?.years ?? 0, isUser: s.teamId === userId,
    };
  }).sort((a, b) => b.round - a.round || b.overall - a.overall);

/* ------------------------------------------------------------ preferences */

/** One preference: how much he cares (share of his weights) and how the team scores on it (0..1). */
export interface PreferenceLine {
  key: PreferenceKey;
  label: string;
  share: number;
  appeal: number;
}

/** The staff's read of an offer (never his exact bar). */
export interface OfferRead {
  band: InterestBand | 'walkedAway' | 'none';
  text: ToneText;
}

/** The state of the user's talks with him: "Round 2 · Wearing thin". */
export interface FaTalksLine {
  rounds: number;
  walkedAway: boolean;
  text: ToneText;
}

/** The player's view of an offer from the user's team. */
export interface PreferenceView {
  lines: PreferenceLine[];
  /** His appeal score of the offer (the bar it must clear is not shown). */
  score: number;
  /** Market patience 0..1 (how long he is willing to wait for offers; fades by round). */
  patience: number;
  /** The staff's banded read of the offer. */
  read: OfferRead;
  talks: FaTalksLine;
  ask: ContractAsk;
}

const READ_TEXT: Readonly<Record<InterestBand, ToneText>> = {
  likely: { text: 'Likely to sign', tone: 'success' }, close: { text: 'Close', tone: 'warning' }, far: { text: 'Far apart', tone: 'danger' },
};

/** The staff's read of `terms` to free agent `player` (banded and noisy; see franchise/fa-talks.ts). */
export const offerRead = (league: League, player: Player, userId: TeamId, terms: ContractTerms): OfferRead => {
  if (walkedAway(league, userId, player.id)) return { band: 'walkedAway', text: { text: 'Walked away from your talks', tone: 'danger' } };
  const read = faInterestEstimate(league, userId, player.id, terms);
  return read ? { band: read.band, text: READ_TEXT[read.band] } : { band: 'none', text: { text: 'Not a free agent', tone: 'dim' } };
};

/** Round and patience of the user's talks with him. */
export const faTalksLine = (league: League, player: Player, userId: TeamId): FaTalksLine => {
  const t = faTalks(league, userId, player.id);
  if (!t) return { rounds: 0, walkedAway: false, text: { text: '-', tone: 'dim' } };
  const tone: Tone = t.walkedAway || t.patience < 0.35 ? 'danger' : t.patience < 0.7 ? 'warning' : 'success';
  return { rounds: t.rounds, walkedAway: t.walkedAway, text: { text: `${t.rounds === 0 ? 'No offer refused' : `${t.rounds} refused`} · ${faPatienceText(t)}`, tone } };
};

/** Preferences, the team's appeal per preference and the staff's read of `terms` (default: his ask). */
export const preferenceView = (league: League, player: Player, userId: TeamId, terms?: ContractTerms): PreferenceView => {
  const team = userTeam(league, userId);
  const ask = playerAsk(player, league, team, leagueCapYear(league));
  const offer = terms ?? ask;
  const weights = preferenceWeights(player.preferences);
  const total = PREFERENCE_KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  const parts = preferenceBreakdown(player, team, offer, league, { ask });
  const score = preferenceScore(player, team, offer, league, { ask });
  const fa = league.freeAgency;
  const patience = playerPatience(player, fa ? Math.min(fa.round, fa.maxRounds) : 1, fa?.maxRounds ?? 5);
  const lines = priorities(player).map((key) => ({ key, label: PREF_LABELS[key], share: weights[key] / total, appeal: parts[key] }));
  return { lines, score, patience, read: offerRead(league, player, userId, offer), talks: faTalksLine(league, player, userId), ask };
};

/* ---------------------------------------------------------- offer entry */

/** Contract roles from least to most prominent (the stepper's role scale). */
export const ROLE_ORDER: readonly ContractRole[] = ['developmental', 'backup', 'rotation', 'starter', 'franchise'];

const MONEY_STEP = 50_000;
const roundUp = (v: number, step: number): number => Math.ceil(v / step) * step;

/** Stepper fields for an offer, starting from `base` terms (salary, years, guarantee, bonus, role). */
export const offerFields = (league: League, base: ContractTerms): StepperSpec[] => {
  const cap = league.settings.salaryCap;
  const moneyMax = roundUp(Math.max(cap * 0.3, base.salary * 2, base.signingBonus * 2), MONEY_STEP);
  const money = (v: number): string => formatMoney(v);
  return [
    { id: 'salary', label: 'Salary / yr', min: 0, max: moneyMax, step: MONEY_STEP, bigStep: 1_000_000, value: base.salary, format: money },
    { id: 'years', label: 'Years', min: 1, max: MAX_CONTRACT_YEARS, step: 1, bigStep: 2, value: base.years },
    { id: 'guaranteed', label: 'Guaranteed', min: 0, max: moneyMax * MAX_CONTRACT_YEARS, step: 100_000, bigStep: 1_000_000, value: base.guaranteed, format: money },
    { id: 'bonus', label: 'Signing bonus', min: 0, max: moneyMax * 3, step: 100_000, bigStep: 1_000_000, value: base.signingBonus, format: money },
    { id: 'role', label: 'Role', min: 0, max: ROLE_ORDER.length - 1, step: 1, bigStep: 1, value: Math.max(0, ROLE_ORDER.indexOf(base.role)), format: (i) => humanize(ROLE_ORDER[i] ?? 'backup') },
  ];
};

/** Contract terms from stepper values (guarantee capped at the total salary). */
export const termsFromValues = (v: Record<string, number>): ContractTerms => {
  const salary = Math.max(0, Math.round(v.salary ?? 0));
  const years = Math.max(1, Math.min(MAX_CONTRACT_YEARS, Math.round(v.years ?? 1)));
  return {
    salary, years, guaranteed: Math.min(Math.round(v.guaranteed ?? 0), salary * years), signingBonus: Math.max(0, Math.round(v.bonus ?? 0)),
    role: ROLE_ORDER[Math.round(v.role ?? 1)] ?? 'backup',
  };
};

/** Why the offer cannot be made, or null. Checks the market, the minimum, cap room for this deal and roster room. */
export const offerProblem = (league: League, userId: TeamId, player: Player, terms: ContractTerms): string | null => {
  const fa = league.freeAgency;
  if (fa && !isFreeAgencyOpen(league)) return 'free agency has closed';
  if (player.teamId !== null || !league.freeAgentIds.includes(player.id)) return `${player.firstName} ${player.lastName} is not a free agent`;
  if (walkedAway(league, userId, player.id)) return `${player.firstName} ${player.lastName} walked away from talks with you`;
  const apy = contractApy(terms);
  const min = minimumSalaryFor(player.experience, league.settings);
  if (apy < min) return `below his minimum of ${formatMoney(min)} a year`;
  const status = faStatus(league, userId);
  if (apy > status.capSpace) return `${formatMoney(apy - status.capSpace)} over your cap space`;
  const others = userPending(league, userId).current.filter((o) => o.playerId !== player.id).length;
  if (status.roster + others >= status.rosterLimit) return `your roster is full (${status.rosterLimit})`;
  return null;
};

/* ---------------------------------------------------------------- actions */

/** Opens the market when it has not started yet (a finished market is left alone). */
export const ensureMarketOpen = (league: League): League => (league.freeAgency ? league : startFreeAgency(league));

const withOffers = (league: League, offers: FreeAgentOffer[]): League => {
  const fa = league.freeAgency;
  if (!fa) throw new Error('free agency has not started');
  return { ...league, freeAgency: { ...fa, offers } };
};

/** Records the user's offer for this round (replacing his other pending offers to the player). */
export const placeOffer = (league: League, userId: TeamId, playerId: PlayerId, terms: ContractTerms): League => {
  const open = ensureMarketOpen(league);
  const player = open.players[playerId];
  if (!player) throw new Error(`placeOffer: unknown player ${playerId}`);
  const problem = offerProblem(open, userId, player, terms);
  if (problem) throw new Error(`placeOffer: ${problem}`);
  const offer = makeFreeAgentOffer(open, userId, playerId, terms);
  const fa = open.freeAgency as NonNullable<League['freeAgency']>;
  const rest = fa.offers.filter((o) => o.id !== offer.id)
    .map((o) => (o.teamId === userId && o.playerId === playerId && o.status === 'pending' ? { ...o, status: 'withdrawn' as const } : o));
  return withOffers(open, [...rest, offer]);
};

/** Sets the status of one of the user's pending offers. */
const resolveOwn = (league: League, userId: TeamId, offerId: string, status: OfferStatus): League => {
  const fa = league.freeAgency;
  const offer = fa?.offers.find((o) => o.id === offerId && o.teamId === userId && o.status === 'pending');
  if (!fa || !offer) throw new Error(`no pending offer ${offerId}`);
  return withOffers(league, fa.offers.map((o) => (o.id === offerId ? { ...o, status } : o)));
};

/** Withdraws one of the user's current offers. */
export const withdrawOffer = (league: League, userId: TeamId, offerId: string): League => resolveOwn(league, userId, offerId, 'withdrawn');

/** Declines a player's counter. */
export const declineCounter = (league: League, userId: TeamId, offerId: string): League => resolveOwn(league, userId, offerId, 'rejected');

/** Accepts a player's counter: it is submitted with this round's offers (other offers to him are withdrawn). */
export const acceptCounter = (league: League, userId: TeamId, offerId: string): League => {
  const fa = league.freeAgency;
  const counter = fa?.offers.find((o) => o.id === offerId && o.teamId === userId && o.status === 'pending');
  if (!fa || !counter || !isFreeAgencyOpen(league)) throw new Error(`acceptCounter: no open counter ${offerId}`);
  return withOffers(league, fa.offers.map((o) => {
    if (o.id === offerId) return { ...o, round: fa.round };
    return o.teamId === userId && o.playerId === counter.playerId && o.status === 'pending' ? { ...o, status: 'withdrawn' as const } : o;
  }));
};

/** Closes free agency (AI rosters settled, leftovers to minimum asks) and marks the phase's work done. */
export const closeMarket = (league: League): League => markTask(finishFreeAgency(league), league.season.year, 'freeAgency');

/** What a round produced for the user. */
export interface RoundResult {
  league: League;
  round: number;
  signed: PlayerId[];
  counters: number;
  /** Players who walked away from the user's talks this round. */
  walkedAway: PlayerId[];
  closed: boolean;
  message: string;
}

/** Runs the current bidding round with the user's offers; the last round also closes the market. */
export const runRound = (league: League, userId: TeamId, rng: Rng): RoundResult => {
  const open = ensureMarketOpen(league);
  const fa = open.freeAgency as NonNullable<League['freeAgency']>;
  if (!isFreeAgencyOpen(open)) throw new Error('runRound: every round has been played');
  const round = fa.round;
  const next = runFreeAgencyRound(open, rng, userPending(open, userId).current);
  const signed = (next.freeAgency?.signings ?? []).filter((s) => s.round === round && s.teamId === userId).map((s) => s.playerId);
  const counters = userPending(next, userId).counters.length;
  const left = Object.values(next.freeAgency?.talks ?? {}).filter((t) => t.teamId === userId && t.walkedAway && t.lastRound === round).map((t) => t.playerId);
  const closed = !isFreeAgencyOpen(next);
  const out = closed ? closeMarket(next) : next;
  const nameOf = (id: PlayerId): string => { const p = out.players[id]; return p ? `${p.firstName} ${p.lastName}` : id; };
  const names = signed.map(nameOf);
  const gone = left.length ? `, ${left.map(nameOf).join(', ')} walked away` : '';
  const message = `Round ${round}: ${names.length ? `signed ${names.join(', ')}` : 'no signings for you'}${counters ? `, ${counters} counter${counters === 1 ? '' : 's'}` : ''}${gone}${closed ? '. Free agency is closed' : ''}`;
  return { league: out, round, signed, counters, walkedAway: left, closed, message };
};
