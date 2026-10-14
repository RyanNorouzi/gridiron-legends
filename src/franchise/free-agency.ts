/**
 * Free agency: expiring deals become free agents, then N bidding rounds. Each round AI teams bid on the players
 * that fit their needs, cap and roster (valued by gm/valuation, priced off the player's ask), user offers compete
 * on equal terms, and every player (best first) weighs his offers with preferenceScore: the best one is accepted
 * when it clears his patience-scaled bar, otherwise he counters it (the team may take the counter next round).
 * Offers the user submits also run through fa-talks.ts: his bar for the user's team creeps up per refused round,
 * refusals (lowballs more) wear his patience down, and once he walks away the team's later offers are withdrawn.
 * Unsigned players' asks decay each round. finishFreeAgency drops the rest into a minimum-salary pool and AI
 * teams are settled at the roster size (gm/roster-fill). All signings go through roster.ts. Pure and
 * deterministic per Rng.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { Player, Position } from '@/players/types';
import { ROSTER_COMPOSITION, STARTER_COUNTS } from '@/teams/depth-chart';
import type { Team } from '@/teams/types';
import type { FreeAgentOffer, League } from '@/franchise/types';
import {
  MAX_CONTRACT_YEARS, capSpace, contractApy, contractEndYear, createContract, leagueCapYear, minimumSalaryFor, roundMoney,
  termsFromApy,
} from '@/franchise/contracts';
import type { ContractTerms } from '@/franchise/contracts';
import {
  MARKET, ROLE_RANK, acceptThreshold, counterOffer, expectedRole, higherRole, playerAsk, playerPatience, preferenceScore, projectedDepthRank,
} from '@/franchise/negotiation';
import { assignPlayerInPlace, beginRosterEdit, canSign, isUserTeam, positionDepth, rosterLimitFor, signPlayerInPlace } from '@/franchise/roster';
import { teamNeeds } from '@/franchise/gm/needs';
import { settleRosterInPlace } from '@/franchise/gm/roster-fill';
import { playerTradeValue } from '@/franchise/gm/valuation';
import { faTalks, recordRefusal, talksBar, talksKey, walkedAway } from '@/franchise/fa-talks';

/** Bidding rounds when startFreeAgency is not told otherwise. */
export const DEFAULT_FREE_AGENCY_ROUNDS = 5;
/** Share of the cap AI teams keep free during free agency (draft class, in-season moves). */
export const FA_CAP_RESERVE = 0.03;
/** Most new offers one AI team makes per round. */
export const MAX_AI_OFFERS_PER_ROUND = 4;

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** True between startFreeAgency and finishFreeAgency. */
export const isFreeAgencyOpen = (league: Pick<League, 'freeAgency'>): boolean =>
  league.freeAgency !== null && league.freeAgency.round <= league.freeAgency.maxRounds;

/** Rostered players whose contracts ended before the cap year (or who have none): they hit free agency. */
export const expiredContractIds = (league: League): PlayerId[] => {
  const capYear = leagueCapYear(league);
  return Object.values(league.teams).sort(byId).flatMap((t) =>
    t.rosterIds.filter((id) => {
      const c = league.players[id]?.contract;
      return !c || contractEndYear(c) < capYear;
    }));
};

/** Refreshes the askingSalary snapshot of every free agent (market ask in the current round). */
const refreshAsks = (work: League): void => {
  const capYear = leagueCapYear(work);
  for (const id of work.freeAgentIds) {
    const p = work.players[id];
    if (p) work.players[id] = { ...p, askingSalary: playerAsk(p, work, null, capYear).apy };
  }
};

/**
 * Opens free agency (after re-signing): every expired contract is cleared and its player released to the pool,
 * asks are refreshed and FreeAgencyState starts at round 1 of `maxRounds`.
 */
export const startFreeAgency = (league: League, opts: { maxRounds?: number } = {}): League => {
  if (isFreeAgencyOpen(league)) throw new Error('startFreeAgency: free agency is already running');
  const maxRounds = opts.maxRounds ?? DEFAULT_FREE_AGENCY_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`startFreeAgency: maxRounds must be >= 1, got ${maxRounds}`);
  const work = beginRosterEdit(league);
  for (const id of expiredContractIds(league)) {
    const p = work.players[id] as Player;
    work.players[id] = { ...p, contract: null };
    assignPlayerInPlace(work, id, null);
  }
  for (const id of work.freeAgentIds) {
    const p = work.players[id];
    if (p?.contract) work.players[id] = { ...p, contract: null };
  }
  work.freeAgency = { round: 1, maxRounds, offers: [], signings: [] };
  refreshAsks(work);
  return work;
};

/** Offer id for a team/player in the current round. */
const offerId = (league: League, round: number, teamId: TeamId, playerId: PlayerId): string => `fa-${league.year}-r${round}-${teamId}-${playerId}`;

/** A pending offer from `teamId` to free agent `playerId` for the current round (what the UI submits). */
export const makeFreeAgentOffer = (league: League, teamId: TeamId, playerId: PlayerId, terms: ContractTerms): FreeAgentOffer => {
  const fa = league.freeAgency;
  if (!fa || !isFreeAgencyOpen(league)) throw new Error('makeFreeAgentOffer: free agency is not open');
  if (!league.teams[teamId]) throw new Error(`makeFreeAgentOffer: unknown team ${teamId}`);
  if (!league.freeAgentIds.includes(playerId)) throw new Error(`makeFreeAgentOffer: ${playerId} is not a free agent`);
  return { id: offerId(league, fa.round, teamId, playerId), teamId, playerId, ...terms, round: fa.round, status: 'pending' };
};

const validTerms = (o: ContractTerms): boolean =>
  Number.isInteger(o.years) && o.years >= 1 && o.years <= MAX_CONTRACT_YEARS && [o.salary, o.guaranteed, o.signingBonus].every((v) => Number.isFinite(v) && v >= 0);

/** Cap room an AI team will spend now: space minus the draft/in-season reserve and minimum fills for open slots. */
const aiBudget = (work: League, team: Team, capYear: number, plannedSignings: number): number => {
  const open = Math.max(0, work.settings.rosterSize - team.rosterIds.length - plannedSignings);
  return capSpace(team, work.players, work.settings, capYear) - work.settings.salaryCap * FA_CAP_RESERVE - open * minimumSalaryFor(3, work.settings);
};

/** Premium a cap-rich AI team adds to its bids (bad teams with room overpay to land talent, as real ones must). */
export const FA_RICH_PREMIUM = 0.35;
/** Ceiling of an AI bid as a multiple of the player's ask (a user offer above it always outbids the AI on money). */
export const FA_MAX_AI_BID_OVER_ASK = 1.4;

/** 0..1: how cap-rich a team is, from its free-agency budget (0 at 15% of the cap or less, 1 at 50% or more). */
const capRichness = (budget: number, salaryCap: number): number => Math.min(1, Math.max(0, (budget / salaryCap - 0.15) / 0.35));

/** Whether a free agent would start for `team`, fill a thin position, or neither. */
const fitOf = (work: League, team: Team, p: Player, heldAtPos: number): { start: boolean; thin: boolean } => {
  const start = projectedDepthRank(work, team, p) < STARTER_COUNTS[p.position];
  return { start, thin: heldAtPos < ROSTER_COMPOSITION[p.position] };
};

/** New AI offers for one team this round (at most MAX_AI_OFFERS_PER_ROUND, within budget and roster room). */
const aiOffers = (work: League, team: Team, candidates: readonly { p: Player; value: number }[], pool: readonly FreeAgentOffer[], round: number, rng: Rng): FreeAgentOffer[] => {
  const capYear = leagueCapYear(work);
  const mine = pool.filter((o) => o.teamId === team.id);
  let budget = aiBudget(work, team, capYear, mine.length) - mine.reduce((s, o) => s + contractApy(o), 0);
  const slots = Math.min(MAX_AI_OFFERS_PER_ROUND, work.settings.rosterSize - team.rosterIds.length - mine.length);
  if (slots <= 0 || budget < minimumSalaryFor(0, work.settings)) return [];
  const premium = 1 + FA_RICH_PREMIUM * capRichness(budget, work.settings.salaryCap);
  const needs = teamNeeds(work, team);
  const depth = positionDepth(work, team);
  const held = {} as Record<Position, number>;
  for (const pos of Object.keys(depth) as Position[]) held[pos] = depth[pos].length;
  for (const o of mine) {
    const pos = work.players[o.playerId]?.position;
    if (pos) held[pos] += 1;
  }
  const bids = new Map<PlayerId, number>();
  for (const o of pool) bids.set(o.playerId, (bids.get(o.playerId) ?? 0) + 1);
  // Scouting taste (noise) and crowding (offers already on the table) spread the league's bids across the pool.
  const ranked = candidates
    .filter(({ p }) => !mine.some((o) => o.playerId === p.id) && held[p.position] <= ROSTER_COMPOSITION[p.position])
    .map(({ p, value }) => {
      const fit = fitOf(work, team, p, held[p.position]);
      const need = needs.positions[p.position].need;
      const base = fit.start || fit.thin ? value * (fit.start ? 1 + need : 0.35 + need) : 0;
      return { p, fit, need, score: (base * rng.range(0.75, 1.25)) / (1 + 0.6 * (bids.get(p.id) ?? 0)) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byId(a.p, b.p));
  const out: FreeAgentOffer[] = [];
  for (const { p, fit, need } of ranked) {
    if (out.length >= slots) break;
    if (held[p.position] >= ROSTER_COMPOSITION[p.position] + (fit.start ? 1 : 0)) continue;
    const ask = playerAsk(p, work, team, capYear);
    const lean = needs.direction === 'contend' ? 0.04 : needs.direction === 'rebuild' && p.age >= 30 ? -0.1 : 0;
    let apy = roundMoney(ask.apy * Math.min(FA_MAX_AI_BID_OVER_ASK, (0.95 + 0.25 * need + lean + rng.range(-0.03, 0.05)) * premium));
    apy = Math.max(apy, minimumSalaryFor(p.experience, work.settings));
    if (apy > budget) {
      if (budget < ask.apy * 0.85) continue;
      apy = roundMoney(budget - 5_000);
    }
    const years = needs.direction === 'rebuild' && p.age >= 30 ? Math.min(ask.years, 2) : ask.years;
    const exp = expectedRole(p);
    const role = fit.start ? higherRole(exp, 'starter') : ROLE_RANK[exp] > 2 ? 'rotation' : exp;
    const terms = termsFromApy(apy, years, role, MARKET.guaranteeByRole[role], MARKET.bonusByRole[role]);
    out.push({ id: offerId(work, round, team.id, p.id), teamId: team.id, playerId: p.id, ...terms, round, status: 'pending' });
    budget -= apy;
    held[p.position] += 1;
  }
  return out;
};

/** AI answer to a player's counter: take it when the team can afford it and still has a use for him. */
const aiTakesCounter = (work: League, team: Team, p: Player, counter: FreeAgentOffer): boolean => {
  const capYear = leagueCapYear(work);
  const depthCount = team.rosterIds.filter((id) => work.players[id]?.position === p.position).length;
  const fit = fitOf(work, team, p, depthCount);
  if (!fit.start && !fit.thin) return false;
  const ask = playerAsk(p, work, team, capYear);
  return contractApy(counter) <= ask.apy * 1.25 && contractApy(counter) <= aiBudget(work, team, capYear, 0);
};

/** His market bar in `round`: what an offer must score to be signed (negotiation.ts willAccept's rule). */
const acceptBar = (player: Player, round: number, maxRounds: number): number => acceptThreshold(playerPatience(player, round, maxRounds));

/** Options of the whole-market helpers. */
export interface FreeAgencyAiOptions {
  /** Let the AI bid for, take counters for and settle the user's team too (a hands-off user). Default false. */
  includeUser?: boolean;
}

/** Whether the AI runs `team` in the market: every AI team, and the user's only with `includeUser`. */
const aiRuns = (work: League, team: Team, opts: FreeAgencyAiOptions): boolean => opts.includeUser === true || !isUserTeam(work, team);

/**
 * One bidding round. `userOffers` (from makeFreeAgentOffer, or a counter re-submitted with its id) compete with
 * the AI's. Returns the league with signings applied, offers resolved (accepted / rejected / countered /
 * withdrawn), counters pending for next round, asks decayed and the round advanced. No-op once all rounds ran.
 */
export const runFreeAgencyRound = (league: League, rng: Rng, userOffers: readonly FreeAgentOffer[] = [], opts: FreeAgencyAiOptions = {}): League => {
  const fa = league.freeAgency;
  if (!fa) throw new Error('runFreeAgencyRound: free agency has not started');
  if (fa.round > fa.maxRounds) return league;
  const round = fa.round;
  const capYear = leagueCapYear(league);
  const work = beginRosterEdit(league);
  const history: FreeAgentOffer[] = [];
  const pool: FreeAgentOffer[] = [];
  const resubmitted = new Set(userOffers.map((o) => o.id));

  for (const o of fa.offers) {
    if (o.status !== 'pending') { history.push(o); continue; }
    const team = work.teams[o.teamId];
    const p = work.players[o.playerId];
    if (team && isUserTeam(work, team) && resubmitted.has(o.id)) continue;
    const taken = team && p && p.teamId === null && aiRuns(work, team, opts) && aiTakesCounter(work, team, p, o);
    if (taken) pool.push({ ...o, round });
    else history.push({ ...o, status: 'withdrawn' });
  }
  const talks = { ...(fa.talks ?? {}) };
  const submitted = new Set<string>();
  // A counter he made that the user accepts is his own terms: it faces his market bar and a refusal (outbid, or
  // the round moved on) is not a refused talks round, so accepting it can never wear his patience or drive him off.
  const acceptedCounters = new Set(userOffers.filter((o) => o.id.endsWith('-c')
    && fa.offers.some((x) => x.id === o.id && x.teamId === o.teamId && x.status === 'pending')).map((o) => o.id));
  for (const o of userOffers) {
    if (!work.teams[o.teamId]) throw new Error(`runFreeAgencyRound: unknown team ${o.teamId}`);
    if (!work.players[o.playerId]) throw new Error(`runFreeAgencyRound: unknown player ${o.playerId}`);
    if (!validTerms(o)) throw new Error(`runFreeAgencyRound: invalid terms in offer ${o.id}`);
    const entry: FreeAgentOffer = { ...o, round, status: 'pending' };
    const gone = work.players[o.playerId]?.teamId !== null || !work.freeAgentIds.includes(o.playerId);
    if (gone || walkedAway(league, o.teamId, o.playerId)) history.push({ ...entry, status: 'withdrawn' });
    else {
      pool.push(entry);
      submitted.add(entry.id);
    }
  }

  const valued = work.freeAgentIds
    .map((id) => work.players[id])
    .filter((p): p is Player => p !== undefined && !p.retired)
    .map((p) => ({ p, value: playerTradeValue(p, capYear, work.settings) }))
    .sort((a, b) => b.value - a.value || byId(a.p, b.p));
  const aiTeams = rng.shuffle(Object.values(work.teams).filter((t) => aiRuns(work, t, opts)).sort(byId));
  for (const team of aiTeams) pool.push(...aiOffers(work, team, valued, pool, round, rng.fork(`bids:${team.id}`)));

  const byPlayer = new Map<PlayerId, FreeAgentOffer[]>();
  for (const o of pool) byPlayer.set(o.playerId, [...(byPlayer.get(o.playerId) ?? []), o]);
  const valueOf = new Map(valued.map((v) => [v.p.id, v.value]));
  const order = [...byPlayer.keys()].sort((a, b) => (valueOf.get(b) ?? 0) - (valueOf.get(a) ?? 0) || (a < b ? -1 : 1));
  const signings: { playerId: PlayerId; teamId: TeamId; round: number }[] = [];
  const counters: FreeAgentOffer[] = [];
  const limit = rosterLimitFor(work);
  for (const pid of order) {
    const player = work.players[pid] as Player;
    const live: { o: FreeAgentOffer; team: Team; contract: ReturnType<typeof createContract> }[] = [];
    for (const o of byPlayer.get(pid) ?? []) {
      const contract = createContract({ ...o, year: capYear });
      if (canSign(work, o.teamId, pid, contract, { year: capYear, rosterLimit: limit }).ok) live.push({ o, team: work.teams[o.teamId] as Team, contract });
      else history.push({ ...o, status: 'withdrawn' });
    }
    if (live.length === 0) continue;
    const best = Math.max(...live.map((x) => contractApy(x.o)));
    const scored = live
      .map((x) => ({ ...x, score: preferenceScore(player, x.team, x.o, work, { ask: playerAsk(player, work, x.team, capYear), bestCompetingApy: best }) }))
      .sort((a, b) => b.score - a.score || contractApy(b.o) - contractApy(a.o) || (a.o.teamId < b.o.teamId ? -1 : 1));
    const top = scored[0] as (typeof scored)[number];
    for (const x of scored.slice(1)) history.push({ ...x.o, status: 'rejected' });
    // A user's offer is judged against his bar for that team in talks (it creeps up per refused round).
    const barFor = (x: (typeof scored)[number]): number =>
      submitted.has(x.o.id) && !acceptedCounters.has(x.o.id) ? talksBar(player, fa, faTalks(league, x.o.teamId, pid)) : acceptBar(player, round, fa.maxRounds);
    if (top.score >= barFor(top)) {
      signPlayerInPlace(work, top.o.teamId, pid, top.contract, { year: capYear });
      history.push({ ...top.o, status: 'accepted' });
      signings.push({ playerId: pid, teamId: top.o.teamId, round });
      continue;
    }
    history.push({ ...top.o, status: 'countered' });
    const leftTalks = new Set<TeamId>();
    for (const x of scored) {
      if (!submitted.has(x.o.id) || acceptedCounters.has(x.o.id)) continue;
      const bar = barFor(x);
      if (x.score >= bar) continue;
      const update = recordRefusal(faTalks(league, x.o.teamId, pid) as NonNullable<ReturnType<typeof faTalks>>, x.score, bar, round);
      talks[talksKey(x.o.teamId, pid)] = update.talks;
      if (update.talks.walkedAway) leftTalks.add(x.o.teamId);
    }
    if (round < fa.maxRounds && !leftTalks.has(top.o.teamId)) counters.push(counterOffer(player, top.team, top.o, work, capYear));
  }
  work.freeAgency = {
    round: round + 1, maxRounds: fa.maxRounds, offers: [...history, ...counters], signings: [...fa.signings, ...signings],
    ...(Object.keys(talks).length > 0 ? { talks } : {}),
  };
  refreshAsks(work);
  return work;
};

/**
 * Closes free agency: pending offers are withdrawn, remaining free agents drop into the minimum-salary pool,
 * every AI team is settled at settings.rosterSize (gm/roster-fill settleRosterInPlace: empty required positions and
 * thin positions filled with minimum deals, cuts down to the roster size, cap compliance). The user's roster is left to
 * the user unless `opts.includeUser`.
 */
export const finishFreeAgency = (league: League, opts: FreeAgencyAiOptions = {}): League => {
  const fa = league.freeAgency;
  if (!fa) throw new Error('finishFreeAgency: free agency has not started');
  const capYear = leagueCapYear(league);
  const work = beginRosterEdit(league);
  const minimumAsks = (): void => {
    for (const id of work.freeAgentIds) {
      const p = work.players[id];
      if (p && p.askingSalary !== minimumSalaryFor(p.experience, work.settings)) work.players[id] = { ...p, askingSalary: minimumSalaryFor(p.experience, work.settings) };
    }
  };
  minimumAsks();
  for (const t of Object.values(work.teams).sort(byId)) {
    if (aiRuns(work, t, opts)) settleRosterInPlace(work, t.id, work.settings.rosterSize, capYear);
  }
  // Players cut while settling (and generated street free agents left over) join the minimum-salary pool too.
  minimumAsks();
  const offers = fa.offers.map((o) => (o.status === 'pending' ? { ...o, status: 'withdrawn' as const } : o));
  work.freeAgency = { ...fa, round: fa.maxRounds + 1, offers };
  return work;
};

/** Whole free agency without user input: start (if needed), every round, finish. */
export const runFreeAgency = (league: League, rng: Rng, opts: { maxRounds?: number } & FreeAgencyAiOptions = {}): League => {
  let out = isFreeAgencyOpen(league) ? league : startFreeAgency(league, opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {});
  while (isFreeAgencyOpen(out)) out = runFreeAgencyRound(out, rng.fork(`fa-round:${out.freeAgency?.round ?? 0}`), [], opts);
  return finishFreeAgency(out, opts);
};
