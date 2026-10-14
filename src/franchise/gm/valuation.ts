/**
 * Trade valuation on one point scale shared by players and picks (the #1 overall pick is worth 3000 points,
 * a Jimmy-Johnson-style curve from src/data/contract-market.json `tradeValue`). Player value = talent (overall
 * with young upside, position premium) x age curve x contract surplus x control x health. Pick value = the
 * chart at its projected overall slot, discounted per year in the future. Pure and deterministic.
 */
import marketJson from '@/data/contract-market.json';
import type { TeamId } from '@/core/ids';
import { clamp, clamp01, lerp } from '@/core/math';
import { ageCurve } from '@/players/development';
import { countSevereInjuries } from '@/players/injuries';
import type { Player } from '@/players/types';
import type { DraftPick } from '@/teams/types';
import type { League, LeagueSettings, TradeAsset } from '@/franchise/types';
import { capHit, isActiveIn, jsonArray, jsonNumber, jsonObject, minimumSalaryFor, yearsRemainingAt } from '@/franchise/contracts';
import { marketSalary, positionTier, teamWinPct } from '@/franchise/negotiation';
import type { PositionTier } from '@/franchise/negotiation';

/* ------------------------------------------------------------------- data */

export interface TradeValueData {
  /** [overall slot, points] anchors, ascending by slot; log-linear between anchors. */
  pickChart: [number, number][];
  futurePickDiscount: number;
  talentScale: number;
  talentFloorOverall: number;
  talentExponent: number;
  positionPremium: Record<PositionTier, number>;
  youthPotentialWeight: number;
  contractSurplusWeight: number;
  packageDecay: number;
  packageFloor: number;
  aiMargin: number;
  userMarginByDifficulty: Record<string, number>;
  untouchableOverall: number;
  untouchableMaxAge: number;
  untouchablePremium: number;
}

const F = 'contract-market.json';
const TIERS: readonly PositionTier[] = ['premium', 'high', 'mid', 'low', 'minimal', 'specialist'];

/** Validates the `tradeValue` section of contract-market.json (the chart must be strictly decreasing). */
export const validateTradeValueData = (raw: unknown): TradeValueData => {
  const o = jsonObject(raw, F, '$.tradeValue');
  const p = '$.tradeValue';
  const pickChart = jsonArray(o.pickChart, F, `${p}.pickChart`).map((x, i): [number, number] => {
    if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'number' || typeof x[1] !== 'number' || x[0] < 1 || x[1] <= 0) {
      throw new Error(`${F}: ${p}.pickChart[${i}] must be [slot >= 1, points > 0]`);
    }
    return [x[0], x[1]];
  });
  pickChart.forEach(([slot, v], i) => {
    const prev = pickChart[i - 1];
    if (prev && (slot <= prev[0] || v >= prev[1])) throw new Error(`${F}: ${p}.pickChart must ascend by slot and descend by value (index ${i})`);
  });
  if (pickChart.length < 2) throw new Error(`${F}: ${p}.pickChart needs at least two anchors`);
  const prem = jsonObject(o.positionPremium, F, `${p}.positionPremium`);
  const positionPremium = {} as Record<PositionTier, number>;
  for (const t of TIERS) positionPremium[t] = jsonNumber(prem, t, F, `${p}.positionPremium`, 0, 5);
  const marginsRaw = jsonObject(o.userMarginByDifficulty, F, `${p}.userMarginByDifficulty`);
  const userMarginByDifficulty: Record<string, number> = {};
  for (const k of Object.keys(marginsRaw)) userMarginByDifficulty[k] = jsonNumber(marginsRaw, k, F, `${p}.userMarginByDifficulty`, 0, 1);
  const n = (k: string, lo: number, hi: number): number => jsonNumber(o, k, F, p, lo, hi);
  return {
    pickChart, positionPremium, userMarginByDifficulty,
    futurePickDiscount: n('futurePickDiscount', 0.1, 1),
    talentScale: n('talentScale', 0, 1),
    talentFloorOverall: n('talentFloorOverall', 1, 90),
    talentExponent: n('talentExponent', 1, 8),
    youthPotentialWeight: n('youthPotentialWeight', 0, 1),
    contractSurplusWeight: n('contractSurplusWeight', 0, 1),
    packageDecay: n('packageDecay', 0, 0.5),
    packageFloor: n('packageFloor', 0.1, 1),
    aiMargin: n('aiMargin', 0, 0.5),
    untouchableOverall: n('untouchableOverall', 50, 99),
    untouchableMaxAge: n('untouchableMaxAge', 20, 45),
    untouchablePremium: n('untouchablePremium', 1, 5),
  };
};

/** Validated trade-value tuning. */
export const TRADE_VALUE: TradeValueData = validateTradeValueData(jsonObject(marketJson, F, '$').tradeValue);

/* ---------------------------------------------------------------- players */

/** Overall credited for value: young players get part of their remaining upside (more for star dev traits). */
export const valueOverall = (p: Pick<Player, 'overall' | 'potential' | 'age' | 'devTrait'>): number => {
  const youth = clamp01((27 - p.age) / 5);
  const trait = p.devTrait === 'superstar' ? 2 : p.devTrait === 'star' ? 1 : p.devTrait === 'bust' ? -1 : 0;
  return p.overall + TRADE_VALUE.youthPotentialWeight * Math.max(0, p.potential - p.overall) * youth + trait * youth;
};

/** Raw talent points for an overall at a position (before age, contract and health). */
export const talentValue = (p: Pick<Player, 'overall' | 'potential' | 'age' | 'devTrait' | 'position'>): number => {
  const t = TRADE_VALUE;
  const above = Math.max(0, valueOverall(p) - t.talentFloorOverall);
  return t.talentScale * Math.pow(above, t.talentExponent) * t.positionPremium[positionTier(p.position)];
};

/** Seasons of useful play left (by the position's age curve) mapped to a 0.08..1 multiplier. */
export const ageValueFactor = (p: Pick<Player, 'age' | 'position'>): number => {
  const curve = ageCurve(p.position);
  return clamp((curve.declineEnd - p.age + 1) / 8, 0.08, 1);
};

/** Contract multiplier: surplus (market value - cap hit) raises value, overpay lowers it; short control trims it. */
export const contractValueFactor = (player: Player, year: number, settings: Pick<LeagueSettings, 'salaryCap' | 'minimumSalary'>): number => {
  const c = player.contract;
  if (!c || !(isActiveIn(c, year) || year < c.signedYear)) return 1;
  const market = Math.max(1, marketSalary(player, settings.salaryCap), minimumSalaryFor(player.experience, settings));
  const hit = capHit(c, Math.max(year, c.signedYear));
  const yrs = Math.min(3, yearsRemainingAt(c, year));
  const surplus = clamp((market - hit) / market, -1.5, 0.9);
  const control = 0.8 + 0.2 * (yrs / 3);
  return clamp(1 + TRADE_VALUE.contractSurplusWeight * surplus * (0.5 + 0.5 * (yrs / 3)), 0.4, 1.6) * control;
};

/** Health multiplier: current injury, severe injury history, the injuryProne trait. */
export const healthValueFactor = (p: Pick<Player, 'injury' | 'injuryHistory' | 'traits'>): number => {
  let f = 1;
  if (p.injury) {
    if (p.injury.severity === 'careerThreatening') f *= 0.5;
    else if (p.injury.severity === 'seasonEnding' || p.injury.weeksRemaining >= 8) f *= 0.7;
    else if (p.injury.weeksRemaining >= 3) f *= 0.9;
  }
  f *= 1 - 0.07 * Math.min(4, countSevereInjuries(p));
  if (p.traits.includes('injuryProne')) f *= 0.9;
  return f;
};

/** Trade value (points, >= 1) of a player for a deal in cap year `year`. */
export const playerTradeValue = (player: Player, year: number, settings: Pick<LeagueSettings, 'salaryCap' | 'minimumSalary'>): number =>
  Math.max(1, Math.round(talentValue(player) * ageValueFactor(player) * contractValueFactor(player, year, settings) * healthValueFactor(player)));

/* ------------------------------------------------------------------ picks */

/** Chart points at an overall slot (log-linear between anchors; the last anchor's value beyond the chart). */
export const pickChartValue = (slot: number): number => {
  const chart = TRADE_VALUE.pickChart;
  const s = Math.max(1, slot);
  const first = chart[0] as [number, number];
  if (s <= first[0]) return first[1];
  for (let i = 1; i < chart.length; i++) {
    const [s1, v1] = chart[i] as [number, number];
    const [s0, v0] = chart[i - 1] as [number, number];
    if (s <= s1) return Math.exp(lerp(Math.log(v0), Math.log(v1), (s - s0) / (s1 - s0)));
  }
  return (chart[chart.length - 1] as [number, number])[1];
};

export interface PickValueOptions {
  /** Year of the next draft to be held; later picks are discounted per year. */
  currentDraftYear: number;
  teamCount: number;
}

/**
 * Value of a pick: chart points at `projectedOrderSlot` (overall pick number; mid-round when null) discounted by
 * futurePickDiscount per year beyond the current draft.
 */
export const pickValue = (pick: Pick<DraftPick, 'year' | 'round' | 'overall'>, projectedOrderSlot: number | null, opts: PickValueOptions): number => {
  const slot = projectedOrderSlot ?? pick.overall ?? (pick.round - 1) * opts.teamCount + Math.ceil(opts.teamCount / 2);
  const ahead = Math.max(0, pick.year - opts.currentDraftYear);
  return Math.max(1, Math.round(pickChartValue(slot) * Math.pow(TRADE_VALUE.futurePickDiscount, ahead)));
};

/** Year of the next draft: this league year until the draft is done, then next year. */
export const currentDraftYear = (league: Pick<League, 'year' | 'season' | 'draft'>): number => {
  const done = league.draft ? league.draft.complete && league.draft.year === league.year : false;
  return done || league.season.phase === 'postDraft' || league.season.phase === 'trainingCamp' ? league.year + 1 : league.year;
};

/** Team strength ordering key (worst first): win pct blended with the cached overall. */
const strengthKey = (league: League, teamId: TeamId): number => {
  const t = league.teams[teamId];
  if (!t) return 0.5;
  return 0.6 * teamWinPct(league, t) + 0.4 * clamp01((t.overall - 55) / 35);
};

/**
 * Projected overall slot of a pick: its resolved `overall`, else its place in an active draft order, else the
 * original team's strength rank (worst team picks first), regressed to mid-round for later years.
 */
export const projectedPickSlot = (league: League, pick: DraftPick): number => {
  if (pick.overall !== null) return pick.overall;
  const draft = league.draft;
  if (draft && !draft.complete && draft.year === pick.year) {
    const idx = draft.order.findIndex((p) => p.id === pick.id);
    if (idx >= 0) return idx + 1;
  }
  const ids = Object.keys(league.teams) as TeamId[];
  const count = Math.max(1, ids.length);
  const sorted = ids.map((id) => ({ id, k: strengthKey(league, id) })).sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : 1));
  const rank = Math.max(0, sorted.findIndex((x) => x.id === pick.originalTeamId)) + 1;
  const ahead = Math.max(0, pick.year - currentDraftYear(league));
  const slotInRound = Math.round(lerp(rank, (count + 1) / 2, clamp01(0.5 * ahead)));
  return (pick.round - 1) * count + slotInRound;
};

/** Value of any trade asset in the league context (players at the league cap year). */
export const assetValue = (league: League, asset: TradeAsset, year: number): number => {
  if (asset.kind === 'pick') {
    return pickValue(asset.pick, projectedPickSlot(league, asset.pick), { currentDraftYear: currentDraftYear(league), teamCount: Object.keys(league.teams).length });
  }
  const p = league.players[asset.playerId];
  return p ? playerTradeValue(p, year, league.settings) : 0;
};

/* --------------------------------------------------------------- packages */

/** Package value with a consolidation premium: best asset counts fully, each next one a little less (floored). */
export const packageValue = (values: readonly number[]): number => {
  const sorted = [...values].filter((v) => v > 0).sort((a, b) => b - a);
  return Math.round(sorted.reduce((s, v, i) => s + v * Math.max(TRADE_VALUE.packageFloor, 1 - TRADE_VALUE.packageDecay * i), 0));
};

/** Package value of trade assets in the league context (assetValue each, then packageValue). */
export const assetsPackageValue = (league: League, assets: readonly TradeAsset[], year: number): number =>
  packageValue(assets.map((a) => assetValue(league, a, year)));

/** Both sides of a swap valued as packages: gap = received - given, ratio = received / given. */
export const valueGap = (given: readonly number[], received: readonly number[]): { given: number; received: number; gap: number; ratio: number } => {
  const g = packageValue(given);
  const r = packageValue(received);
  return { given: g, received: r, gap: r - g, ratio: g > 0 ? r / g : r > 0 ? Infinity : 1 };
};

/**
 * Franchise cornerstones the AI will not move without a big overpay: young stars (overall >= untouchableOverall,
 * age <= untouchableMaxAge) who are not themselves badly overpaid (cap hit > 1.35x market).
 */
export const isUntouchable = (player: Player, year: number, settings: Pick<LeagueSettings, 'salaryCap'>): boolean => {
  if (player.overall < TRADE_VALUE.untouchableOverall || player.age > TRADE_VALUE.untouchableMaxAge) return false;
  const hit = capHit(player.contract, year);
  return hit <= 1.35 * marketSalary(player, settings.salaryCap);
};
