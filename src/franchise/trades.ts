/**
 * Trades: the window rule, AI evaluation (package values with needs and direction, cap and roster feasibility
 * for both sides, untouchable cornerstones, actionable counters), execution (players move via roster.ts with
 * their contracts as-is, picks are re-owned in Team.picks and an active DraftState.order, traded players take
 * the 'traded' morale hit, optional hooks fire), AI proposals and the League.pendingTrades lifecycle.
 * Pure: League in, League out.
 */
import type { TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp01 } from '@/core/math';
import { adjustMorale } from '@/players/personality';
import type { Player } from '@/players/types';
import { STARTER_COUNTS } from '@/teams/depth-chart';
import type { DraftPick, Team } from '@/teams/types';
import type { League, SeasonPhase, TradeAsset, TradeEvaluation, TradeOffer } from '@/franchise/types';
import { OFFSEASON_PHASES, capHit, capSpace, leagueCapYear, teamCapHit } from '@/franchise/contracts';
import { assignPlayerInPlace, beginRosterEdit, isUserTeam, rosterLimitFor } from '@/franchise/roster';
import { teamNeeds } from '@/franchise/gm/needs';
import type { TeamNeeds } from '@/franchise/gm/needs';
import { TRADE_VALUE, assetValue, currentDraftYear, isUntouchable, packageValue } from '@/franchise/gm/valuation';
import { aiCutsToLimitInPlace, aiTradeProposals, assetKey } from '@/franchise/gm/roster-ai';
import { BLOCK_TUNING, blockDemand, isOnTradeBlock, refreshAiTradeBlocks, tradeBlockOf, withoutTradeBlock } from '@/franchise/gm/trade-block';
import type { TradeProposalOptions } from '@/franchise/gm/roster-ai';

/* ------------------------------------------------------------------ window */

/** Phases with an open trade window besides the regular season up to the deadline. */
export const TRADE_OPEN_PHASES: readonly SeasonPhase[] = [...OFFSEASON_PHASES, 'preseason'];

/** Whether trades are allowed now (regular season through tradeDeadlineWeek, preseason and the offseason). */
export const tradeWindowStatus = (league: Pick<League, 'season' | 'settings'>): { open: boolean; reason: string } => {
  const { phase, week } = league.season;
  const deadline = league.settings.tradeDeadlineWeek;
  if (phase === 'regularSeason') {
    return week <= deadline ? { open: true, reason: `open through week ${deadline}` } : { open: false, reason: `the trade deadline passed after week ${deadline}` };
  }
  return TRADE_OPEN_PHASES.includes(phase) ? { open: true, reason: `open during the ${phase}` } : { open: false, reason: `trades are closed during the ${phase}` };
};

/** True while the trade window is open. */
export const tradeWindowOpen = (league: Pick<League, 'season' | 'settings'>): boolean => tradeWindowStatus(league).open;

/* ---------------------------------------------------------------- offers */

/** Builds a pending offer (id derived from the teams, assets, date and `salt`). */
export const createTradeOffer = (
  league: Pick<League, 'year' | 'season'>, fromTeam: TeamId, toTeam: TeamId, fromAssets: TradeAsset[], toAssets: TradeAsset[],
  initiatedBy: TeamId = fromTeam, salt = '',
): TradeOffer => ({
  id: `tr-${league.year}-${league.season.phase}-${league.season.week}-${fromTeam}-${toTeam}-${[...fromAssets, ...toAssets].map(assetKey).join('.')}${salt ? `-${salt}` : ''}`,
  fromTeam, toTeam, fromAssets, toAssets, status: 'pending', year: league.year, week: league.season.week, initiatedBy,
});

/** Human-readable asset label. */
export const describeAsset = (league: League, a: TradeAsset): string => {
  if (a.kind === 'pick') return `${a.pick.year} round ${a.pick.round} pick (${league.teams[a.pick.originalTeamId]?.abbr ?? a.pick.originalTeamId})`;
  const p = league.players[a.playerId];
  return p ? `${p.firstName} ${p.lastName} (${p.position}, ${p.overall})` : a.playerId;
};

/** First structural problem with an offer (unknown teams/assets, wrong owner, duplicates, used or past picks), or null. */
export const validateOffer = (league: League, offer: TradeOffer): string | null => {
  if (offer.fromTeam === offer.toTeam) return 'a team cannot trade with itself';
  const sides: [TeamId, TradeAsset[]][] = [[offer.fromTeam, offer.fromAssets], [offer.toTeam, offer.toAssets]];
  if (offer.fromAssets.length + offer.toAssets.length === 0) return 'the offer has no assets';
  const seen = new Set<string>();
  for (const [teamId, assets] of sides) {
    const team = league.teams[teamId];
    if (!team) return `unknown team ${teamId}`;
    for (const a of assets) {
      const key = assetKey(a);
      if (seen.has(key)) return `${key} appears twice`;
      seen.add(key);
      if (a.kind === 'player') {
        const p = league.players[a.playerId];
        if (!p || p.teamId !== teamId || !team.rosterIds.includes(a.playerId)) return `${key} is not on ${team.abbr}`;
      } else {
        const owned = team.picks.find((pk) => pk.id === a.pick.id);
        if (!owned || owned.ownerTeamId !== teamId) return `${team.abbr} does not own pick ${a.pick.id}`;
        if (league.draft?.selections.some((s) => s.pick.id === a.pick.id)) return `pick ${a.pick.id} has already been used`;
        if (owned.year < currentDraftYear(league)) return `pick ${a.pick.id} belongs to a past draft`;
      }
    }
  }
  return null;
};

/* -------------------------------------------------------------- evaluation */

const playersOf = (league: League, assets: readonly TradeAsset[]): Player[] =>
  assets.flatMap((a) => (a.kind === 'player' && league.players[a.playerId] ? [league.players[a.playerId] as Player] : []));

/**
 * A position the trade would leave `team` short of its required starters at (fewer than STARTER_COUNTS after the
 * trade, and fewer than before), or null. AI teams never strip themselves of their only kicker, punter or fullback.
 */
const depthShortfall = (league: League, team: Team, sent: readonly Player[], back: readonly Player[]): Player['position'] | null => {
  for (const pos of new Set(sent.map((p) => p.position))) {
    const before = team.rosterIds.filter((id) => league.players[id]?.position === pos).length;
    const after = before - sent.filter((p) => p.position === pos).length + back.filter((p) => p.position === pos).length;
    if (after < before && after < STARTER_COUNTS[pos]) return pos;
  }
  return null;
};

/** Value of one asset to `team` (needs, direction, whether an incoming player starts, what an outgoing one leaves). */
const valueTo = (league: League, team: Team, needs: TeamNeeds, a: TradeAsset, incoming: boolean, year: number): number => {
  const base = assetValue(league, a, year);
  if (a.kind === 'pick') return base * (needs.direction === 'rebuild' ? 1.2 : needs.direction === 'contend' ? 0.85 : 1);
  const p = league.players[a.playerId];
  if (!p) return 0;
  let v = base;
  if (needs.direction === 'rebuild') v *= p.age <= 25 ? 1.15 : p.age >= 29 ? 0.7 : 1;
  else if (needs.direction === 'contend' && p.overall >= 75) v *= 1.1;
  const peers = team.rosterIds.map((id) => league.players[id]).filter((q): q is Player => !!q && q.position === p.position && q.id !== p.id)
    .sort((x, y) => y.overall - x.overall);
  const starters = STARTER_COUNTS[p.position];
  if (incoming) {
    const rank = peers.filter((q) => q.overall > p.overall).length;
    v *= rank < starters ? 1 + 0.6 * needs.positions[p.position].need : rank === starters ? 0.85 : 0.6;
  } else if (peers.filter((q) => q.overall > p.overall).length < starters) {
    const next = peers[starters - 1];
    v *= 1 + 0.5 * clamp01((p.overall - (next?.overall ?? 40)) / 15);
  }
  // An AI team shopping a player (its trading block) asks a little less for him.
  if (!incoming && !isUserTeam(league, team) && isOnTradeBlock(league, p.id)) v *= BLOCK_TUNING.sellDiscount;
  return v;
};

interface CapCheck { ok: boolean; team: Team; over: number }

const capCheck = (league: League, teamId: TeamId, outgoing: readonly Player[], incoming: readonly Player[], year: number): CapCheck => {
  const team = league.teams[teamId] as Team;
  const out = outgoing.reduce((s, p) => s + capHit(p.contract, year), 0);
  const inc = incoming.reduce((s, p) => s + capHit(p.contract, year), 0);
  const space = capSpace(team, league.players, league.settings, year) + out - inc;
  return { ok: space >= 0 || inc <= out, team, over: Math.max(0, -space) };
};

/** Required edge for the evaluating AI: difficulty-scaled against the user, a small margin against other AIs. */
const marginFor = (league: League, from: Team): number =>
  isUserTeam(league, from) ? TRADE_VALUE.userMarginByDifficulty[league.settings.difficulty.id] ?? 0.06 : TRADE_VALUE.aiMargin;

export interface EvaluateOptions {
  /** Build a counter when the value falls short (default true). */
  counter?: boolean;
}

const verdict = (accepted: boolean, valueGiven: number, valueReceived: number, reason: string, counterOffer: TradeOffer | null = null, counterSuggestion: string | null = null): TradeEvaluation =>
  ({ accepted, valueGiven: Math.round(valueGiven), valueReceived: Math.round(valueReceived), reason, counterSuggestion, counterOffer });

/** Players a side may end up over its roster limit after a trade (AI sides release them on execution). */
export const MAX_TRADE_ROSTER_OVERFLOW = 3;

/**
 * Why the trade cannot happen regardless of value, or null: invalid offer, closed window, a roster more than
 * MAX_TRADE_ROSTER_OVERFLOW over the limit, or a side over the cap that would add salary.
 */
export const tradeFeasibility = (league: League, offer: TradeOffer): string | null => {
  const problem = validateOffer(league, offer);
  if (problem) return `invalid: ${problem}`;
  const window = tradeWindowStatus(league);
  if (!window.open) return `window: ${window.reason}`;
  const year = leagueCapYear(league);
  const from = league.teams[offer.fromTeam] as Team;
  const to = league.teams[offer.toTeam] as Team;
  const sent = playersOf(league, offer.fromAssets);
  const back = playersOf(league, offer.toAssets);
  const limit = rosterLimitFor(league);
  for (const [team, gain] of [[from, back.length - sent.length], [to, sent.length - back.length]] as const) {
    const after = team.rosterIds.length + gain;
    if (gain > 0 && after > limit + MAX_TRADE_ROSTER_OVERFLOW) return `roster: ${team.abbr} would carry ${after} players (limit ${limit})`;
  }
  for (const c of [capCheck(league, from.id, sent, back, year), capCheck(league, to.id, back, sent, year)]) {
    if (!c.ok) return `cap: ${c.team.abbr} would be $${Math.round(c.over).toLocaleString('en-US')} over the cap`;
  }
  return null;
};

/**
 * The receiving team's (offer.toTeam) verdict. Rejections, in order: tradeFeasibility (invalid, window, roster,
 * cap), an AI side left short of required starters at a position (depthShortfall), an untouchable without a big overpay, not enough value (received >= given x (1 + margin)); value
 * shortfalls come with an actionable counter asking for more.
 */
export const evaluateTrade = (league: League, offer: TradeOffer, opts: EvaluateOptions = {}): TradeEvaluation => {
  const blocked = tradeFeasibility(league, offer);
  if (blocked) return verdict(false, 0, 0, blocked);
  const year = leagueCapYear(league);
  const from = league.teams[offer.fromTeam] as Team;
  const to = league.teams[offer.toTeam] as Team;
  const back = playersOf(league, offer.toAssets);
  const sent = playersOf(league, offer.fromAssets);
  for (const [team, out, inc] of [[to, back, sent], [from, sent, back]] as const) {
    const short = isUserTeam(league, team) ? null : depthShortfall(league, team, out, inc);
    if (short) return verdict(false, 0, 0, `depth: the ${team.name} would be left without enough at ${short}`);
  }
  const needs = teamNeeds(league, to);
  const received = packageValue(offer.fromAssets.map((a) => valueTo(league, to, needs, a, true, year)));
  const given = packageValue(offer.toAssets.map((a) => valueTo(league, to, needs, a, false, year)));
  const star = back.find((p) => isUntouchable(p, year, league.settings));
  if (star && received < given * TRADE_VALUE.untouchablePremium) {
    return verdict(false, given, received, `untouchable: ${star.firstName} ${star.lastName} is a cornerstone of the ${to.name}`, null, `${star.firstName} ${star.lastName} is not available`);
  }
  const required = given * (1 + marginFor(league, from));
  if (received >= required) return verdict(true, given, received, `accepted: fair value (${Math.round(received)} for ${Math.round(given)})`);
  const counter = opts.counter === false ? null : buildCounter(league, offer, to, needs, required, year);
  return verdict(false, given, received, `value: not enough value (${Math.round(received)} for ${Math.round(given)})`,
    counter?.offer ?? null, counter ? `Add ${counter.added.map((a) => describeAsset(league, a)).join(' and ')}` : 'Offer significantly more value');
};

/** Most single-asset counters buildCounter checks before it tries a two-asset one. */
const COUNTER_SINGLES_TRIED = 8;

/** Counter asking `offer.fromTeam` for up to two more of its assets (picks or non-cornerstone players) to close the gap. */
const buildCounter = (league: League, offer: TradeOffer, to: Team, needs: TeamNeeds, required: number, year: number): { offer: TradeOffer; added: TradeAsset[] } | null => {
  const from = league.teams[offer.fromTeam] as Team;
  const inOffer = new Set([...offer.fromAssets, ...offer.toAssets].map(assetKey));
  const pool: { a: TradeAsset; v: number }[] = [
    ...from.picks.filter((pk) => pk.ownerTeamId === from.id).map((pick): TradeAsset => ({ kind: 'pick', pick })),
    ...from.rosterIds.map((playerId): TradeAsset => ({ kind: 'player', playerId })),
  ].filter((a) => !inOffer.has(assetKey(a)) && !(a.kind === 'player' && isUntouchable(league.players[a.playerId] as Player, year, league.settings)))
    .map((a) => ({ a, v: valueTo(league, to, needs, a, true, year) }))
    .filter((x) => x.v > 1)
    .sort((x, y) => x.v - y.v || assetKey(x.a).localeCompare(assetKey(y.a)));
  const base = offer.fromAssets.map((a) => valueTo(league, to, needs, a, true, year));
  const total = (extra: readonly { v: number }[]): number => packageValue([...base, ...extra.map((e) => e.v)]);
  const tries: { a: TradeAsset; v: number }[][] = [];
  // The cheapest few qualifying singles in order: the very cheapest can fail (e.g. its cap hit breaks the cap).
  for (const x of pool.filter((y) => total([y]) >= required).slice(0, COUNTER_SINGLES_TRIED)) tries.push([x]);
  const biggest = pool[pool.length - 1];
  if (biggest) {
    const second = pool.find((x) => x !== biggest && total([biggest, x]) >= required);
    if (second) tries.push([second, biggest]);
  }
  for (const extra of tries) {
    const added = extra.map((x) => x.a);
    const candidate: TradeOffer = { ...offer, id: `${offer.id}-counter`, fromAssets: [...offer.fromAssets, ...added], status: 'pending', initiatedBy: offer.toTeam };
    if (evaluateTrade(league, candidate, { counter: false }).accepted) return { offer: candidate, added };
  }
  return null;
};

/* --------------------------------------------------------------- execution */

export interface TradeHooks {
  onPlayerMoved?: (player: Player, from: TeamId, to: TeamId) => void;
  onPickMoved?: (pick: DraftPick, from: TeamId, to: TeamId) => void;
  onExecuted?: (league: League, offer: TradeOffer) => void;
}

/** Most resolved offers kept in League.pendingTrades (pending ones are always kept). */
export const RESOLVED_TRADES_KEPT = 20;

/** Keeps every pending offer and the latest RESOLVED_TRADES_KEPT resolved ones. */
export const prunePendingTrades = (trades: readonly TradeOffer[]): TradeOffer[] => {
  const resolved = trades.filter((t) => t.status !== 'pending');
  const keep = new Set(resolved.slice(-RESOLVED_TRADES_KEPT));
  return trades.filter((t) => t.status === 'pending' || keep.has(t));
};

/** Records `offer` with `status` in pendingTrades (replacing an entry with the same id). */
const recordOffer = (trades: readonly TradeOffer[], offer: TradeOffer, status: TradeOffer['status']): TradeOffer[] => {
  const entry = { ...offer, status };
  return prunePendingTrades(trades.some((t) => t.id === offer.id) ? trades.map((t) => (t.id === offer.id ? entry : t)) : [...trades, entry]);
};

/** Moves a pick between teams by id (Team.picks is canonical; the draft order copy follows). */
const movePick = (work: League, pickId: string, from: TeamId, to: TeamId): DraftPick => {
  const src = work.teams[from] as Team;
  const pick = src.picks.find((pk) => pk.id === pickId) as DraftPick;
  const moved: DraftPick = { ...pick, ownerTeamId: to };
  work.teams[from] = { ...src, picks: src.picks.filter((pk) => pk.id !== pickId) };
  const dest = work.teams[to] as Team;
  work.teams[to] = { ...dest, picks: [...dest.picks.filter((pk) => pk.id !== pickId), moved] };
  if (work.draft && !work.draft.complete) {
    work.draft = { ...work.draft, order: work.draft.order.map((pk) => (pk.id === pickId ? { ...pk, ownerTeamId: to } : pk)) };
  }
  return moved;
};

/**
 * Executes a (validated) trade: players change teams with their contracts and a 'traded' morale hit, picks change
 * owners, AI sides over the roster limit release their lowest-value players (the user's side is left to the user,
 * see roster.ts needsCutsTo), the offer is recorded as accepted and other pending offers that include a moved asset
 * are withdrawn. Throws when the offer is structurally invalid; does NOT re-run the AI evaluation.
 */
export const executeTrade = (league: League, offer: TradeOffer, hooks: TradeHooks = {}): League => {
  const problem = validateOffer(league, offer);
  if (problem) throw new Error(`executeTrade: ${problem}`);
  const work = beginRosterEdit(league);
  const legs: [TeamId, TeamId, TradeAsset[]][] = [[offer.fromTeam, offer.toTeam, offer.fromAssets], [offer.toTeam, offer.fromTeam, offer.toAssets]];
  for (const [src, dst, assets] of legs) {
    for (const a of assets) {
      if (a.kind === 'pick') {
        // Move first, then notify: an optional call skips its arguments when no hook is set.
        const moved = movePick(work, a.pick.id, src, dst);
        hooks.onPickMoved?.(moved, src, dst);
        continue;
      }
      assignPlayerInPlace(work, a.playerId, dst);
      const p = work.players[a.playerId] as Player;
      work.players[a.playerId] = { ...p, morale: adjustMorale(p, { type: 'traded' }) };
      hooks.onPlayerMoved?.(work.players[a.playerId] as Player, src, dst);
    }
  }
  // A traded player is off the trading block: his new team did not list him (gm/trade-block.ts).
  const cleared = withoutTradeBlock(work, [...offer.fromAssets, ...offer.toAssets].flatMap((a) => (a.kind === 'player' ? [a.playerId] : [])));
  if (cleared.club) work.club = cleared.club;
  for (const teamId of [offer.fromTeam, offer.toTeam]) {
    if (!isUserTeam(work, work.teams[teamId] as Team)) aiCutsToLimitInPlace(work, teamId, rosterLimitFor(work));
  }
  const moved = new Set([...offer.fromAssets, ...offer.toAssets].map(assetKey));
  const others = league.pendingTrades.map((t) =>
    t.id !== offer.id && t.status === 'pending' && [...t.fromAssets, ...t.toAssets].some((a) => moved.has(assetKey(a))) ? { ...t, status: 'withdrawn' as const } : t);
  work.pendingTrades = recordOffer(others, offer, 'accepted');
  hooks.onExecuted?.(work, offer);
  return work;
};

/* ------------------------------------------------------------ user flow */

/** The same trade seen from the other side (from/to swapped) so the initiating team can be evaluated. */
export const reverseOffer = (offer: TradeOffer): TradeOffer =>
  ({ ...offer, fromTeam: offer.toTeam, toTeam: offer.fromTeam, fromAssets: offer.toAssets, toAssets: offer.fromAssets });

/**
 * Submits an offer. To an AI team: evaluated now — accepted trades execute, value shortfalls leave the original
 * 'countered' plus the AI's counter pending for the user, anything else is 'rejected'. To the user's team: stored
 * pending for respondToTrade.
 */
export const proposeTrade = (league: League, offer: TradeOffer): { league: League; evaluation: TradeEvaluation | null } => {
  const to = league.teams[offer.toTeam];
  if (to && isUserTeam(league, to)) {
    const problem = validateOffer(league, offer);
    if (problem) throw new Error(`proposeTrade: ${problem}`);
    return { league: { ...league, pendingTrades: recordOffer(league.pendingTrades, offer, 'pending') }, evaluation: null };
  }
  const evaluation = evaluateTrade(league, offer);
  if (evaluation.accepted) return { league: executeTrade(league, offer), evaluation };
  let trades = recordOffer(league.pendingTrades, offer, evaluation.counterOffer ? 'countered' : 'rejected');
  if (evaluation.counterOffer) trades = recordOffer(trades, evaluation.counterOffer, 'pending');
  return { league: { ...league, pendingTrades: trades }, evaluation };
};

/**
 * The non-initiating side answers a pending offer. Accepting re-checks feasibility (validity, window, rosters,
 * cap) and, for an AI counter, that the AI still agrees; a stale offer becomes 'withdrawn'. Declining marks it
 * 'rejected'.
 */
export const respondToTrade = (league: League, offerId: string, accept: boolean): League => {
  const offer = league.pendingTrades.find((t) => t.id === offerId && t.status === 'pending');
  if (!offer) throw new Error(`respondToTrade: no pending trade ${offerId}`);
  if (!accept) return { ...league, pendingTrades: recordOffer(league.pendingTrades, offer, 'rejected') };
  const receiver = league.teams[offer.toTeam];
  const aiReceives = offer.initiatedBy === offer.toTeam && receiver !== undefined && !isUserTeam(league, receiver);
  const stillOk = tradeFeasibility(league, offer) === null && (!aiReceives || evaluateTrade(league, offer, { counter: false }).accepted);
  if (!stillOk) return { ...league, pendingTrades: recordOffer(league.pendingTrades, offer, 'withdrawn') };
  return executeTrade(league, offer);
};

/** Withdraws every pending offer once the window has closed. */
export const expireTrades = (league: League): League =>
  tradeWindowOpen(league) || !league.pendingTrades.some((t) => t.status === 'pending')
    ? league
    : { ...league, pendingTrades: prunePendingTrades(league.pendingTrades.map((t) => (t.status === 'pending' ? { ...t, status: 'withdrawn' as const } : t))) };

/* ---------------------------------------------------------------- AI flow */

/** One AI proposal from `teamId` that its partner would accept (gm/roster-ai aiTradeProposals + evaluateTrade), or null. */
export const proposeAiTrade = (league: League, teamId: TeamId, rng: Rng, opts: TradeProposalOptions = {}): TradeOffer | null =>
  tradeWindowOpen(league) ? aiTradeProposals(league, teamId, rng, (l, o) => evaluateTrade(l, o), { ...opts, max: 1 })[0] ?? null : null;

export interface AiTradeActivityOptions {
  /** AI-to-AI trades executed at most (default 2). */
  maxTrades?: number;
  /** Chance each AI team shops this call (default 0.25). */
  activity?: number;
  /** AI offers left pending for the user (default 1). */
  offersToUser?: number;
}

/**
 * AI trade activity for one step: AI teams re-list their trading blocks (gm/trade-block.ts), a few AI-AI trades are
 * executed (teams with a need a listed player fills shop more often) and offers to the user are left pending, from
 * the teams most interested in his trading block first. Deterministic per rng.
 */
export const runAiTradeActivity = (league: League, rng: Rng, opts: AiTradeActivityOptions = {}): League => {
  if (!tradeWindowOpen(league)) return expireTrades(league);
  let out = refreshAiTradeBlocks(league);
  let trades = 0;
  const ai = rng.shuffle(Object.values(league.teams).filter((t) => !isUserTeam(league, t)).map((t) => t.id).sort());
  const demand = new Map(ai.map((id) => [id, blockDemand(out, out.teams[id] as Team)]));
  for (const teamId of ai) {
    if (trades >= (opts.maxTrades ?? 2)) break;
    const chance = (opts.activity ?? 0.25) * ((demand.get(teamId) ?? 0) > 0 ? BLOCK_TUNING.shopBoost : 1);
    if (!rng.chance(Math.min(1, chance))) continue;
    const offer = proposeAiTrade(out, teamId, rng.fork(`trade:${teamId}`));
    if (offer) {
      out = executeTrade(out, offer);
      trades += 1;
    }
  }
  const user = league.userTeamId;
  let toUser = opts.offersToUser ?? 1;
  const userBlock = user ? new Set(tradeBlockOf(out, user)) : new Set<string>();
  const wants = (teamId: TeamId): number => {
    const needs = teamNeeds(out, out.teams[teamId] as Team);
    return [...userBlock].filter((id) => {
      const p = out.players[id as Player['id']];
      return p !== undefined && needs.positions[p.position].need >= 0.3;
    }).length;
  };
  const suitors = userBlock.size > 0 ? [...ai].sort((a, b) => wants(b) - wants(a)) : ai;
  for (const teamId of suitors) {
    if (!user || toUser <= 0) break;
    const offer = proposeAiTrade(out, teamId, rng.fork(`offer:${teamId}`), { partnerIds: [user], includeUserTeam: true });
    if (offer) {
      out = { ...out, pendingTrades: recordOffer(out.pendingTrades, offer, 'pending') };
      toUser -= 1;
    }
  }
  return out;
};

/** Cap room each side would have after `offer` (for trade screens). */
export const tradeCapPreview = (league: League, offer: TradeOffer): Record<string, number> => {
  const year = leagueCapYear(league);
  const sent = playersOf(league, offer.fromAssets);
  const back = playersOf(league, offer.toAssets);
  const after = (teamId: TeamId, out: readonly Player[], inc: readonly Player[]): number => {
    const team = league.teams[teamId] as Team;
    return league.settings.salaryCap + team.finances.capCarryover - (team.finances.deadMoney[year] ?? 0)
      - (teamCapHit(team, league.players, year) - out.reduce((s, p) => s + capHit(p.contract, year), 0) + inc.reduce((s, p) => s + capHit(p.contract, year), 0));
  };
  return { [offer.fromTeam]: after(offer.fromTeam, sent, back), [offer.toTeam]: after(offer.toTeam, back, sent) };
};
