/**
 * GM AI roster management: re-signing decisions, cuts to the roster limit, cap compliance (restructures then
 * cuts), depth-chart refreshes and trade proposals. Trade proposals take the evaluator as an argument
 * (trades.ts passes `evaluateTrade`) so this module never imports trades.ts. Pure: League in, League out;
 * the `...InPlace` helpers operate on a roster.ts working copy.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { ageCurve } from '@/players/development';
import { POSITIONS } from '@/players/types';
import type { Contract, Player, Position } from '@/players/types';
import { ROSTER_COMPOSITION, STARTER_COUNTS } from '@/teams/depth-chart';
import type { Team } from '@/teams/types';
import type { League, TradeAsset, TradeEvaluation, TradeOffer } from '@/franchise/types';
import {
  capHit, capSpace, contractEndYear, deadMoney, extend, leagueCapYear, maxRestructureAmount, minimumSalaryFor, restructure,
  restructureSavings, yearsRemainingAt,
} from '@/franchise/contracts';
import type { ContractTerms } from '@/franchise/contracts';
import { loyaltyBonus, marketSalary, playerAsk, playerPatience, preferenceScore, projectedDepthRank, willAccept } from '@/franchise/negotiation';
import { beginRosterEdit, cutPlayerInPlace, isUserTeam, positionDepth, refreshTeamInPlace, rosterPlayers } from '@/franchise/roster';
import { MAJOR_NEED, teamNeeds } from '@/franchise/gm/needs';
import type { TeamNeeds } from '@/franchise/gm/needs';
import { assetValue, isUntouchable, packageValue, playerTradeValue } from '@/franchise/gm/valuation';
import { BLOCK_TUNING, isOnTradeBlock } from '@/franchise/gm/trade-block';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/* --------------------------------------------------------------- re-signing */

export type ResignAction = 'extend' | 'decline' | 'refused';

export interface ResignDecision {
  playerId: PlayerId;
  /** extend = team offers and player agrees; decline = team lets him walk; refused = player turns the team down. */
  action: ResignAction;
  terms: ContractTerms | null;
  reason: string;
}

/** Share of the cap kept free while re-signing (rookies, in-season moves). */
export const RESIGN_CAP_RESERVE = 0.04;

/** Oldest age the AI re-signs at a position (two seasons before the position's decline end). */
export const maxResignAge = (pos: Position): number => ageCurve(pos).declineEnd - 2;

/**
 * Re-signing plan for `team`'s players whose contracts end with season `year` or earlier (default the league
 * year: expired deals in the offseason, final-year deals in season). The team keeps core players (starters,
 * the first backup, young high-potential players, or anyone at a major need) who are not too old, not priced
 * far above market and fit the cap; the player then accepts or refuses by preferenceScore with loyalty.
 */
export const aiResignDecisions = (league: League, team: Team, year: number, rng: Rng): ResignDecision[] => {
  const startYear = leagueCapYear(league);
  const needs = teamNeeds(league, team);
  const candidates = rosterPlayers(league, team.id)
    .filter((p) => p.contract && contractEndYear(p.contract) <= year)
    .map((p) => ({ p, v: playerTradeValue(p, startYear, league.settings) }))
    .sort((a, b) => b.v - a.v || byId(a.p, b.p));
  // Every departing slot, and every slot already open, is reserved at a veteran minimum so the roster can always be
  // refilled to the roster size (without the open slots a team that re-signed up to the cap could not fill out).
  const fill = minimumSalaryFor(3, league.settings);
  const openSlots = Math.max(0, league.settings.rosterSize - team.rosterIds.length);
  let space = capSpace(team, league.players, league.settings, startYear) - league.settings.salaryCap * RESIGN_CAP_RESERVE - (candidates.length + openSlots) * fill;
  const out: ResignDecision[] = [];
  for (const { p } of candidates) {
    const pos = p.position;
    const rank = projectedDepthRank(league, team, p);
    const core = rank < STARTER_COUNTS[pos] + (ROSTER_COMPOSITION[pos] >= 3 ? 1 : 0) || (p.age <= 25 && p.potential >= 72);
    const ask = playerAsk(p, league, team, startYear);
    const cost = ask.apy - capHit(p.contract, startYear) - fill;
    let reject: string | null = null;
    if (p.age > maxResignAge(pos)) reject = 'too old to commit to';
    else if (!core && needs.positions[pos].need < MAJOR_NEED) reject = 'depth is covered';
    else if (ask.apy > marketSalary(p, league.settings.salaryCap) * 1.35 && p.overall < 85) reject = 'asking price above market';
    else if (cost > space) reject = 'no cap room';
    if (reject) {
      out.push({ playerId: p.id, action: 'decline', terms: null, reason: reject });
      continue;
    }
    const score = preferenceScore(p, team, ask, league, { ask, loyalty: loyaltyBonus(p) }) + rng.gaussian(0, 0.04);
    if (!willAccept(score, playerPatience(p, 1, 3))) {
      out.push({ playerId: p.id, action: 'refused', terms: null, reason: 'wants to test free agency' });
      continue;
    }
    space -= cost;
    const { salary, years, guaranteed, signingBonus, role } = ask;
    out.push({ playerId: p.id, action: 'extend', terms: { salary, years, guaranteed, signingBonus, role }, reason: 'core player' });
  }
  return out;
};

/** Applies the 'extend' decisions (new deals start in the league cap year). Throws if a player left the team. */
export const applyResignDecisions = (league: League, teamId: TeamId, decisions: readonly ResignDecision[]): League => {
  const startYear = leagueCapYear(league);
  const players = { ...league.players };
  for (const d of decisions) {
    if (d.action !== 'extend' || !d.terms) continue;
    const p = players[d.playerId];
    if (!p || p.teamId !== teamId) throw new Error(`applyResignDecisions: ${d.playerId} is not on ${teamId}`);
    players[d.playerId] = extend(p, d.terms, startYear);
  }
  return { ...league, players };
};

/**
 * Runs re-signing for every AI team; the user's team is left to the user unless `includeUser` (a hands-off user
 * whose re-signing the AI handles). Deterministic per rng.
 */
export const runAiResigning = (league: League, rng: Rng, opts: { includeUser?: boolean } = {}): League => {
  let out = league;
  for (const team of Object.values(league.teams).sort(byId)) {
    if (!opts.includeUser && isUserTeam(league, team)) continue;
    const current = out.teams[team.id] as Team;
    out = applyResignDecisions(out, team.id, aiResignDecisions(out, current, league.year, rng.fork(`resign:${team.id}`)));
  }
  return out;
};

/* -------------------------------------------------------------------- cuts */

/** Fewest players the AI keeps at a position when cutting. */
export const minKeep = (pos: Position): number => Math.min(ROSTER_COMPOSITION[pos], STARTER_COUNTS[pos] + 1);

/** How much the AI wants to keep a player (value, starter bonus, overstaffed penalty, sunk dead money). */
const keepScore = (league: League, p: Player, year: number, count: number, rank: number): number => {
  const value = playerTradeValue(p, year, league.settings);
  const over = count > ROSTER_COMPOSITION[p.position] ? 0.7 : 1;
  const starter = rank < STARTER_COUNTS[p.position] ? 1.5 : 1;
  return value * over * starter + (deadMoney(p.contract, year) / 1e6) * 4;
};

/** Lowest keepScore player at a position above its minimum (optionally only cuts that save cap). */
const worstKeep = (work: League, team: Team, year: number, mustSave: boolean): PlayerId | null => {
  const depth = positionDepth(work, team);
  let best: { id: PlayerId; score: number } | null = null;
  for (const pos of POSITIONS) {
    const list = depth[pos];
    if (list.length <= minKeep(pos)) continue;
    for (let rank = 0; rank < list.length; rank++) {
      const p = list[rank] as Player;
      if (mustSave && capHit(p.contract, year) - deadMoney(p.contract, year) <= 0) continue;
      const score = keepScore(work, p, year, list.length, rank);
      if (!best || score < best.score || (score === best.score && p.id < best.id)) best = { id: p.id, score };
    }
  }
  return best ? best.id : null;
};

/** Cuts the least valuable players until the roster is at `limit`, respecting position minimums. Returns the cut ids. */
export const aiCutsToLimitInPlace = (work: League, teamId: TeamId, limit = work.settings.rosterSize): PlayerId[] => {
  const cut: PlayerId[] = [];
  const year = leagueCapYear(work);
  while ((work.teams[teamId]?.rosterIds.length ?? 0) > limit) {
    const id = worstKeep(work, work.teams[teamId] as Team, year, false);
    if (!id) break;
    cutPlayerInPlace(work, teamId, id, year);
    cut.push(id);
  }
  return cut;
};

/** Pure: AI cuts down to `limit` (default settings.rosterSize). */
export const aiCutsToLimit = (league: League, teamId: TeamId, limit = league.settings.rosterSize): League => {
  const work = beginRosterEdit(league);
  aiCutsToLimitInPlace(work, teamId, limit);
  return work;
};

/**
 * Gets a team under the cap for the league cap year: restructures the deal with the biggest saving first
 * (two or more seasons left, not yet restructured), then cuts the lowest-value player whose release saves cap.
 */
export const aiCapComplianceInPlace = (work: League, teamId: TeamId): { restructured: PlayerId[]; cut: PlayerId[] } => {
  const year = leagueCapYear(work);
  const done = { restructured: [] as PlayerId[], cut: [] as PlayerId[] };
  for (let guard = 0; guard < 120; guard++) {
    const team = work.teams[teamId] as Team;
    const space = capSpace(team, work.players, work.settings, year);
    if (space >= 0) break;
    let best: { p: Player; c: Contract; amount: number; saving: number; min: number } | null = null;
    for (const id of team.rosterIds) {
      const p = work.players[id];
      const c = p?.contract;
      if (!p || !c || c.restructured || yearsRemainingAt(c, year) < 2 || !(year >= c.signedYear)) continue;
      const min = minimumSalaryFor(p.experience, work.settings);
      const left = yearsRemainingAt(c, year);
      const amount = Math.min(maxRestructureAmount(c, min, year), Math.ceil(-space / (1 - 1 / left)));
      const saving = amount > 0 ? restructureSavings(c, amount, year) : 0;
      if (saving > 0 && (!best || saving > best.saving)) best = { p, c, amount, saving, min };
    }
    if (best) {
      work.players[best.p.id] = { ...best.p, contract: restructure(best.c, best.amount, { minimumSalary: best.min, year }) };
      done.restructured.push(best.p.id);
      continue;
    }
    const id = worstKeep(work, team, year, true);
    if (!id) break;
    cutPlayerInPlace(work, teamId, id, year);
    done.cut.push(id);
  }
  return done;
};

/** Pure wrapper of aiCapComplianceInPlace. */
export const aiCapCompliance = (league: League, teamId: TeamId): League => {
  const work = beginRosterEdit(league);
  aiCapComplianceInPlace(work, teamId);
  return work;
};

/** Rebuilds a team's depth chart by availability and overall (and refreshes its cached ratings). */
export const aiDepthChartRefresh = (league: League, teamId: TeamId): League => {
  const work = beginRosterEdit(league);
  refreshTeamInPlace(work, teamId, true);
  return work;
};

/* ------------------------------------------------------------------ trades */

/** Evaluates an offer from the receiving team's side (trades.ts evaluateTrade). */
export type TradeEvaluator = (league: League, offer: TradeOffer) => TradeEvaluation;

export interface ValuedAsset {
  asset: TradeAsset;
  value: number;
}

/**
 * Assets a team is willing to move: all owned picks, backups worth something, starters at surplus positions and
 * (for rebuilding teams) veteran starters. Never its untouchables or a starter at one of its needs.
 */
export const tradeableAssets = (league: League, team: Team, needs: TeamNeeds = teamNeeds(league, team)): ValuedAsset[] => {
  const year = leagueCapYear(league);
  const out: ValuedAsset[] = team.picks
    .filter((pk) => pk.ownerTeamId === team.id)
    .map((pick) => ({ asset: { kind: 'pick' as const, pick }, value: assetValue(league, { kind: 'pick', pick }, year) }));
  const depth = positionDepth(league, team);
  for (const pos of POSITIONS) {
    depth[pos].forEach((p, rank) => {
      const starter = rank < STARTER_COUNTS[pos];
      if (isUntouchable(p, year, league.settings)) return;
      if (starter && needs.positions[pos].need >= MAJOR_NEED * 0.6) return;
      const movable = !starter || needs.surplus.includes(pos) || (needs.direction === 'rebuild' && p.age >= 29);
      const value = playerTradeValue(p, year, league.settings);
      if (movable && value >= 10) out.push({ asset: { kind: 'player', playerId: p.id }, value });
    });
  }
  return out.sort((a, b) => b.value - a.value || assetKey(a.asset).localeCompare(assetKey(b.asset)));
};

/** Stable key of an asset (player id or pick id). */
export const assetKey = (a: TradeAsset): string => (a.kind === 'player' ? a.playerId : a.pick.id);

/**
 * Greedy package worth at least `aim` from `pool` (best first): the cheapest single asset within [aim, 1.5 aim],
 * else the largest assets below the aim plus a closer. Null when the pool cannot reach 95% of the aim.
 */
export const buildPackage = (pool: readonly ValuedAsset[], aim: number, maxAssets = 3): ValuedAsset[] | null => {
  const single = [...pool].reverse().find((v) => v.value >= aim && v.value <= aim * 1.5);
  if (single) return [single];
  const chosen: ValuedAsset[] = [];
  let remaining = [...pool];
  while (chosen.length < maxAssets) {
    const have = packageValue(chosen.map((c) => c.value));
    if (have >= aim) break;
    const gap = aim - have;
    const closer = [...remaining].reverse().find((v) => packageValue([...chosen, v].map((c) => c.value)) >= aim);
    const pick = closer ?? remaining.find((v) => v.value < gap) ?? remaining[remaining.length - 1];
    if (!pick) break;
    chosen.push(pick);
    remaining = remaining.filter((v) => v !== pick);
  }
  return packageValue(chosen.map((c) => c.value)) >= aim * 0.95 ? chosen : null;
};

export interface TradeProposalOptions {
  /** Most offers returned (default 2). */
  max?: number;
  /** Teams to target (default: every other team; the user's team only with includeUserTeam). */
  partnerIds?: readonly TeamId[];
  includeUserTeam?: boolean;
}

/**
 * 0..`max` offers from `teamId` for upgrades at its biggest needs: targets on partner teams clearly better than its
 * weakest starter (age-appropriate for its direction, affordable, not the partner's untouchable), paid for with a
 * package from tradeableAssets aimed slightly above the target's value; only offers `evaluate` accepts are kept.
 * Players on a partner's trading block (gm/trade-block.ts) are preferred: a lower bar, a boosted score, and they are
 * tried first among the shortlisted targets.
 */
export const aiTradeProposals = (league: League, teamId: TeamId, rng: Rng, evaluate: TradeEvaluator, opts: TradeProposalOptions = {}): TradeOffer[] => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`aiTradeProposals: unknown team ${teamId}`);
  const year = leagueCapYear(league);
  const needs = teamNeeds(league, team);
  const max = opts.max ?? 2;
  const partners = new Set(opts.partnerIds ?? Object.values(league.teams)
    .filter((t) => t.id !== teamId && (opts.includeUserTeam || !isUserTeam(league, t))).map((t) => t.id));
  partners.delete(teamId);
  let pool = tradeableAssets(league, team, needs);
  const space = capSpace(team, league.players, league.settings, year);
  const maxAge = needs.direction === 'rebuild' ? 27 : needs.direction === 'retool' ? 30 : 33;
  const out: TradeOffer[] = [];
  for (const pos of needs.ranked.filter((p) => needs.positions[p].need >= 0.3).slice(0, 3)) {
    if (out.length >= max) break;
    const bar = needs.positions[pos].weakestStarter + 4;
    const listed = (p: Player): boolean => isOnTradeBlock(league, p.id);
    const targets = Object.values(league.players)
      .filter((p) => p.position === pos && p.teamId !== null && partners.has(p.teamId) && p.overall >= bar - (listed(p) ? BLOCK_TUNING.barRelief : 0) && p.age <= maxAge && p.injury === null)
      .filter((p) => !isUntouchable(p, year, league.settings) && capHit(p.contract, year) <= Math.max(0, space) + league.settings.salaryCap * 0.05)
      .map((p) => ({ p, v: playerTradeValue(p, year, league.settings) }))
      .map((x) => ({ ...x, score: (Math.max(1, x.p.overall - bar + 5) / Math.sqrt(x.v)) * (listed(x.p) ? BLOCK_TUNING.targetScoreBoost : 1) }))
      .sort((a, b) => b.score - a.score || byId(a.p, b.p));
    const shortlist = rng.shuffle(targets.slice(0, 4));
    for (const { p, v } of [...shortlist.filter((x) => listed(x.p)), ...shortlist.filter((x) => !listed(x.p))]) {
      const pkg = buildPackage(pool, v * 1.08);
      if (!pkg) continue;
      const offer: TradeOffer = {
        id: `tr-${league.year}-${league.season.phase}-${league.season.week}-${teamId}-${p.id}-${rng.int(0, 46655).toString(36)}`,
        fromTeam: teamId, toTeam: p.teamId as TeamId, fromAssets: pkg.map((x) => x.asset), toAssets: [{ kind: 'player', playerId: p.id }],
        status: 'pending', year: league.year, week: league.season.week, initiatedBy: teamId,
      };
      const ev = evaluate(league, offer);
      let chosen: TradeOffer | null = ev.accepted ? offer : null;
      if (!chosen && ev.counterOffer && packageValue(ev.counterOffer.fromAssets.map((a) => assetValue(league, a, year))) <= v * 1.35) {
        chosen = evaluate(league, ev.counterOffer).accepted ? { ...ev.counterOffer, initiatedBy: teamId } : null;
      }
      if (!chosen) continue;
      out.push(chosen);
      const used = new Set(chosen.fromAssets.map(assetKey));
      pool = pool.filter((x) => !used.has(assetKey(x.asset)));
      break;
    }
  }
  return out;
};
