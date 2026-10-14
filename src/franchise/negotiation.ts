/**
 * Contract negotiation: what a player asks for (market bands from src/data/contract-market.json blended with
 * the development salary scale, scaled to the league cap), how much he likes an offer (PlayerPreferences
 * weighting money, playing time, winning, location, coach, role and chemistry), when he says yes, what he
 * counters with, and extension/holdout pressure. Pure and deterministic.
 */
import marketJson from '@/data/contract-market.json';
import { clamp, clamp01, lerp } from '@/core/math';
import { computeAskingSalary } from '@/players/development';
import { isDefensive, isOffensive, POSITIONS } from '@/players/types';
import type { ContractRole, Player, PlayerPreferences, Position } from '@/players/types';
import { STARTER_COUNTS } from '@/teams/depth-chart';
import type { Team } from '@/teams/types';
import type { FreeAgentOffer, League } from '@/franchise/types';
import {
  CONTRACT_DATA, capHit, contractApy, extend, jsonArray, jsonNumber, jsonObject, leagueCapYear, minimumSalaryFor, projectedCapSpace, roundMoney,
  termsFromApy, yearsRemainingAt,
} from '@/franchise/contracts';
import type { ContractTerms } from '@/franchise/contracts';

/* ------------------------------------------------------------------- data */

export type PositionTier = 'premium' | 'high' | 'mid' | 'low' | 'minimal' | 'specialist';
const TIERS: readonly PositionTier[] = ['premium', 'high', 'mid', 'low', 'minimal', 'specialist'];
const ROLES: readonly ContractRole[] = ['franchise', 'starter', 'rotation', 'backup', 'developmental'];

export interface MarketData {
  /** capPct of the cap by overall (ascending after validation; interpolated). */
  overallBands: { overall: number; capPct: number }[];
  positionTiers: Record<Position, PositionTier>;
  tierMultipliers: Record<PositionTier, number>;
  potentialWeight: number;
  potentialMaxAge: number;
  ageMultipliers: { maxAge: number; mult: number }[];
  askBlend: { market: number; development: number };
  yearsByAge: { maxAge: number; min: number; max: number }[];
  roleThresholds: { franchise: number; starter: number; rotation: number; backup: number };
  guaranteeByRole: Record<ContractRole, number>;
  bonusByRole: Record<ContractRole, number>;
  askDecayPerRound: number;
  askFloorFraction: number;
}

const F = 'contract-market.json';

/** Validates the `market` section of contract-market.json. */
export const validateMarketData = (raw: unknown): MarketData => {
  const m = jsonObject(raw, F, '$.market');
  const list = <T>(key: string, read: (o: Record<string, unknown>, p: string) => T): T[] => {
    const out = jsonArray(m[key], F, `$.market.${key}`).map((x, i) => read(jsonObject(x, F, `$.market.${key}[${i}]`), `$.market.${key}[${i}]`));
    if (out.length === 0) throw new Error(`${F}: $.market.${key} must not be empty`);
    return out;
  };
  const tiersRaw = jsonObject(m.positionTiers, F, '$.market.positionTiers');
  const positionTiers = {} as Record<Position, PositionTier>;
  for (const pos of POSITIONS) {
    const t = tiersRaw[pos];
    if (typeof t !== 'string' || !(TIERS as readonly string[]).includes(t)) throw new Error(`${F}: $.market.positionTiers.${pos} must be one of ${TIERS.join('/')}`);
    positionTiers[pos] = t as PositionTier;
  }
  const record = <K extends string>(key: string, keys: readonly K[], lo: number, hi: number): Record<K, number> => {
    const o = jsonObject(m[key], F, `$.market.${key}`);
    const out = {} as Record<K, number>;
    for (const k of keys) out[k] = jsonNumber(o, k, F, `$.market.${key}`, lo, hi);
    return out;
  };
  const blend = jsonObject(m.askBlend, F, '$.market.askBlend');
  const rt = record('roleThresholds', ['franchise', 'starter', 'rotation', 'backup'] as const, 1, 99);
  return {
    overallBands: list('overallBands', (o, p) => ({ overall: jsonNumber(o, 'overall', F, p, 1, 99), capPct: jsonNumber(o, 'capPct', F, p, 0, 1) }))
      .sort((a, b) => a.overall - b.overall),
    positionTiers,
    tierMultipliers: record('tierMultipliers', TIERS, 0, 5),
    potentialWeight: jsonNumber(m, 'potentialWeight', F, '$.market', 0, 1),
    potentialMaxAge: jsonNumber(m, 'potentialMaxAge', F, '$.market', 18, 45),
    ageMultipliers: list('ageMultipliers', (o, p) => ({ maxAge: jsonNumber(o, 'maxAge', F, p, 18, 99), mult: jsonNumber(o, 'mult', F, p, 0, 2) }))
      .sort((a, b) => a.maxAge - b.maxAge),
    askBlend: { market: jsonNumber(blend, 'market', F, '$.market.askBlend', 0, 1), development: jsonNumber(blend, 'development', F, '$.market.askBlend', 0, 1) },
    yearsByAge: list('yearsByAge', (o, p) => ({ maxAge: jsonNumber(o, 'maxAge', F, p, 18, 99), min: jsonNumber(o, 'min', F, p, 1, 7), max: jsonNumber(o, 'max', F, p, 1, 7) }))
      .sort((a, b) => a.maxAge - b.maxAge),
    roleThresholds: rt,
    guaranteeByRole: record('guaranteeByRole', ROLES, 0, 1),
    bonusByRole: record('bonusByRole', ROLES, 0, 1),
    askDecayPerRound: jsonNumber(m, 'askDecayPerRound', F, '$.market', 0, 0.5),
    askFloorFraction: jsonNumber(m, 'askFloorFraction', F, '$.market', 0.1, 1),
  };
};

/** Validated market tuning. */
export const MARKET: MarketData = validateMarketData(jsonObject(marketJson, F, '$').market);

/* ----------------------------------------------------------------- market */

/** Pay tier of a position. */
export const positionTier = (position: Position): PositionTier => MARKET.positionTiers[position];

/** Share of the cap an overall commands at a premium position (linear between bands, clamped at the ends). */
export const marketCapPct = (overall: number): number => {
  const bands = MARKET.overallBands;
  const first = bands[0] as { overall: number; capPct: number };
  if (overall <= first.overall) return first.capPct;
  for (let i = 1; i < bands.length; i++) {
    const lo = bands[i - 1] as { overall: number; capPct: number };
    const hi = bands[i] as { overall: number; capPct: number };
    if (overall <= hi.overall) return lerp(lo.capPct, hi.capPct, (overall - lo.overall) / (hi.overall - lo.overall));
  }
  return (bands[bands.length - 1] as { capPct: number }).capPct;
};

const ageMultiplier = (age: number): number => (MARKET.ageMultipliers.find((b) => age <= b.maxAge) ?? MARKET.ageMultipliers[MARKET.ageMultipliers.length - 1])?.mult ?? 1;

/** Overall credited for pay: young players sell part of their upside. */
export const marketOverall = (p: Pick<Player, 'overall' | 'potential' | 'age'>): number => {
  const youth = p.age <= MARKET.potentialMaxAge ? 1 : clamp01(1 - (p.age - MARKET.potentialMaxAge) / 4);
  return p.overall + MARKET.potentialWeight * Math.max(0, p.potential - p.overall) * youth;
};

/**
 * League-wide price level on veteran pay by market overall (multiplies market salaries and asks; the rookie scale
 * and minimum deals are unaffected). The bundled bands price the league at roughly 70% of the cap, which left AI
 * teams $50-90M under it after free agency even though every 70+ free agent signed. The level lifts the middle of
 * the market most, leaves fringe players (60 and below) at their price and stars least, so a 99 QB still asks ~25%
 * of the cap. Piecewise linear through `points` ([overall, level]). Measured in tests/franchise/market/cap-usage.test.ts.
 */
export const MARKET_PRICE_LEVEL: Readonly<{ points: readonly (readonly [number, number])[] }> = Object.freeze({
  points: [[60, 1], [72, 1.5], [80, 1.5], [95, 1.15]],
});

/** Price level for a market overall (piecewise linear through MARKET_PRICE_LEVEL.points, flat beyond the ends). */
export const marketPriceLevel = (overall: number): number => {
  const pts = MARKET_PRICE_LEVEL.points;
  const first = pts[0] as readonly [number, number];
  if (overall <= first[0]) return first[1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1] as readonly [number, number];
    const [x1, y1] = pts[i] as readonly [number, number];
    if (overall <= x1) return lerp(y0, y1, (overall - x0) / (x1 - x0));
  }
  return (pts[pts.length - 1] as readonly [number, number])[1];
};

/** Fair market APY for a player under `salaryCap` (position tier x overall band x age), before personal factors. */
export const marketSalary = (p: Pick<Player, 'position' | 'overall' | 'potential' | 'age'>, salaryCap: number): number =>
  roundMoney(marketCapPct(marketOverall(p)) * marketPriceLevel(marketOverall(p)) * MARKET.tierMultipliers[positionTier(p.position)] * ageMultiplier(p.age) * salaryCap);

/** Contract length a player wants: the age band, longer for better players. */
export const desiredYears = (p: Pick<Player, 'age' | 'overall'>): number => {
  const band = MARKET.yearsByAge.find((b) => p.age <= b.maxAge) ?? MARKET.yearsByAge[MARKET.yearsByAge.length - 1];
  if (!band) return 1;
  return Math.round(lerp(band.min, band.max, clamp01((p.overall - 60) / 30)));
};

/** Role rank: franchise 4 > starter 3 > rotation 2 > backup/developmental 1. */
export const ROLE_RANK: Readonly<Record<ContractRole, number>> = { franchise: 4, starter: 3, rotation: 2, backup: 1, developmental: 1 };

/** The more prominent of two roles. */
export const higherRole = (a: ContractRole, b: ContractRole): ContractRole => (ROLE_RANK[b] > ROLE_RANK[a] ? b : a);

/** Role a player expects from his overall (young upside players accept developmental deals). */
export const expectedRole = (p: Pick<Player, 'overall' | 'potential' | 'age'>): ContractRole => {
  const t = MARKET.roleThresholds;
  if (p.overall >= t.franchise) return 'franchise';
  if (p.overall >= t.starter) return 'starter';
  if (p.overall >= t.rotation) return 'rotation';
  if (p.age <= 24 && p.potential >= t.starter) return 'developmental';
  return 'backup';
};

/** 0-based rank the player would hold at his position on `team` (teammates with a higher overall ahead of him). */
export const projectedDepthRank = (league: Pick<League, 'players'>, team: Pick<Team, 'rosterIds'>, player: Pick<Player, 'id' | 'position' | 'overall'>): number =>
  team.rosterIds.reduce((n, id) => {
    const q = league.players[id];
    return q && id !== player.id && q.position === player.position && q.overall > player.overall ? n + 1 : n;
  }, 0);

/** Cap in `year` projected from the league's current cap year. */
export const capForYear = (league: Pick<League, 'settings' | 'year' | 'season'>, year: number): number =>
  Math.round(league.settings.salaryCap * Math.pow(1 + league.settings.capGrowthRate, Math.max(0, year - leagueCapYear(league))));

/* -------------------------------------------------------------------- ask */

/** An ask: negotiable terms plus the APY they add up to and the first season they cover. */
export interface ContractAsk extends ContractTerms {
  apy: number;
  year: number;
}

/**
 * Ask decay factor for an unsigned free agent: decays per free-agency round, and stays at the floor once free
 * agency has closed (leftovers are the cheap pool). 1 for rostered players and before any free agency ran.
 */
export const freeAgencyAskFactor = (league: Pick<League, 'freeAgency'>, player: Pick<Player, 'teamId'>): number => {
  const fa = league.freeAgency;
  if (!fa || player.teamId !== null) return 1;
  if (fa.round > fa.maxRounds) return MARKET.askFloorFraction;
  return Math.max(MARKET.askFloorFraction, 1 - MARKET.askDecayPerRound * (fa.round - 1));
};

/** Personality and relationship multiplier on the ask (hometown discounts, unhappy players, competitors). */
const personalAskFactor = (player: Player, team: Pick<Team, 'id'> | null): number => {
  let f = 1;
  if (player.traits.includes('competitive')) f *= 1.04;
  if (player.traits.includes('leader')) f *= 1.02;
  if (team && player.teamId === team.id) {
    if (player.traits.includes('teamPlayer')) f *= 0.94;
    if (player.morale.morale < 40) f *= 1.12;
    if (player.morale.coachRelationship >= 75) f *= 0.96;
  }
  return f;
};

/**
 * What the player asks `team` (null = the open market) for a deal starting in `year`: APY blended from the
 * market band and the development scale (scaled to that year's cap), personal factors, the free-agency decay,
 * never below his minimum; years from age/quality; role raised to starter when he would start there.
 */
export const playerAsk = (player: Player, league: League, team: Team | null, year: number): ContractAsk => {
  const cap = capForYear(league, year);
  const dev = (computeAskingSalary(player.position, player.overall, player.potential, player.age) * cap * marketPriceLevel(marketOverall(player))) / CONTRACT_DATA.referenceCap;
  const blended = MARKET.askBlend.market * marketSalary(player, cap) + MARKET.askBlend.development * dev;
  const floor = minimumSalaryFor(player.experience, league.settings);
  const apy = Math.max(floor, roundMoney(blended * personalAskFactor(player, team) * freeAgencyAskFactor(league, player)));
  let role = expectedRole(player);
  if (team && projectedDepthRank(league, team, player) < STARTER_COUNTS[player.position]) role = higherRole(role, 'starter');
  const years = desiredYears(player);
  return { ...termsFromApy(apy, years, role, MARKET.guaranteeByRole[role], MARKET.bonusByRole[role]), apy, year };
};

/* ------------------------------------------------------------ preferences */

export type PreferenceKey = keyof PlayerPreferences;
export const PREFERENCE_KEYS: readonly PreferenceKey[] = ['money', 'playingTime', 'winning', 'location', 'coach', 'role', 'chemistry'];

export interface PreferenceContext {
  /** The player's ask of this team (computed when absent). */
  ask?: ContractAsk;
  /** Richest APY on the table from any team; offers below it lose money appeal. */
  bestCompetingApy?: number;
  /** Additive bonus for staying with his current team (0..0.2). */
  loyalty?: number;
}

/** Weight every player puts on money on top of his preference (free agents always care about pay). */
export const MONEY_WEIGHT_FLOOR = 0.2;
const BASE_WEIGHT = 0.02;
const MARKET_LOCATION: Readonly<Record<Team['marketSize'], number>> = { large: 0.45, medium: 0.3, small: 0.18 };

/** Win percentage from this season's standings, else the latest history entry, else .500. */
export const teamWinPct = (league: Pick<League, 'season'>, team: Pick<Team, 'id' | 'history'>): number => {
  const s = league.season.standings[team.id];
  const games = s ? s.wins + s.losses + s.ties : 0;
  if (s && games > 0) return (s.wins + 0.5 * s.ties) / games;
  const last = team.history[team.history.length - 1];
  const lastGames = last ? last.wins + last.losses + last.ties : 0;
  return last && lastGames > 0 ? (last.wins + 0.5 * last.ties) / lastGames : 0.5;
};

const moneyScore = (offer: ContractTerms, ask: ContractAsk, best: number | undefined): number => {
  const apy = contractApy(offer);
  const ratio = apy / Math.max(1, ask.apy);
  const vsAsk = clamp01(0.75 + (ratio - 1) * 2);
  const askSecure = ask.guaranteed + ask.signingBonus;
  const secure = askSecure > 0 ? clamp01(0.5 + 0.5 * ((offer.guaranteed + offer.signingBonus) / askSecure - 1)) : 0.75;
  const lengthFit = clamp01(1 - 0.06 * Math.abs(offer.years - ask.years));
  const competition = best !== undefined && best > apy ? Math.pow(apy / best, 2) : 1;
  return clamp01((0.8 * vsAsk + 0.2 * secure) * lengthFit * competition);
};

const coachScore = (player: Player, league: Pick<League, 'coaches'>, team: Team): number => {
  const coach = team.headCoachId ? league.coaches[team.headCoachId] : undefined;
  if (!coach) return 0.4;
  const r = coach.ratings;
  const side = isOffensive(player.position) ? r.offense : isDefensive(player.position) ? r.defense : (r.offense + r.defense) / 2;
  const devWeight = player.age <= 25 ? 0.4 : 0.15;
  let s = (r.motivation * 0.3 + r.playerDevelopment * devWeight + side * 0.3) / (99 * (0.6 + devWeight));
  if (coach.traits.includes('playersCoach')) s += 0.12;
  if (coach.traits.includes('developer') && player.age <= 25) s += 0.1;
  if (coach.traits.includes('motivator')) s += 0.05;
  if (coach.traits.includes('disciplinarian')) s += player.traits.some((t) => t === 'hotHeaded' || t === 'lazy') ? -0.15 : player.traits.includes('workhorse') ? 0.05 : 0;
  if (player.teamId === team.id) s = 0.5 * s + 0.5 * (player.morale.coachRelationship / 100);
  return clamp01(s);
};

/** Per-preference appeal (each 0..1) of `offer` from `team`. */
export const preferenceBreakdown = (player: Player, team: Team, offer: ContractTerms, league: League, ctx: PreferenceContext = {}): Record<PreferenceKey, number> => {
  const ask = ctx.ask ?? playerAsk(player, league, team, leagueCapYear(league));
  const starters = STARTER_COUNTS[player.position];
  const rank = projectedDepthRank(league, team, player);
  const playingTime = rank < starters ? 1 : rank === starters ? 0.55 : rank === starters + 1 ? 0.3 : 0.12;
  const winning = clamp01(0.65 * clamp01((team.overall - 58) / 30) + 0.35 * teamWinPct(league, team));
  const location = player.homeRegion === team.region ? 1 : MARKET_LOCATION[team.marketSize];
  const expected = expectedRole(player);
  const gap = ROLE_RANK[expected] - ROLE_RANK[offer.role];
  let role = gap <= 0 ? 1 : gap === 1 ? 0.5 : gap === 2 ? 0.2 : 0.05;
  if (offer.role === 'developmental' && player.age <= 24 && ROLE_RANK[expected] <= 2) role = Math.max(role, 0.8);
  let chemistry = team.chemistry / 100;
  if (player.traits.includes('hotHeaded')) chemistry = 0.5 + 0.5 * (chemistry - 0.5);
  return {
    money: moneyScore(offer, ask, ctx.bestCompetingApy),
    playingTime, winning, location,
    coach: coachScore(player, league, team),
    role: clamp01(role),
    chemistry: clamp01(chemistry),
  };
};

/** Normalised preference weights (money floored at MONEY_WEIGHT_FLOOR). */
export const preferenceWeights = (prefs: PlayerPreferences): Record<PreferenceKey, number> => {
  const out = {} as Record<PreferenceKey, number>;
  for (const k of PREFERENCE_KEYS) out[k] = clamp01(prefs[k]) + BASE_WEIGHT + (k === 'money' ? MONEY_WEIGHT_FLOOR : 0);
  return out;
};

/** Overall appeal 0..1 of `offer` from `team`: breakdown weighted by the player's preferences, plus loyalty. */
export const preferenceScore = (player: Player, team: Team, offer: ContractTerms, league: League, ctx: PreferenceContext = {}): number => {
  const parts = preferenceBreakdown(player, team, offer, league, ctx);
  const w = preferenceWeights(player.preferences);
  let total = 0;
  let weight = 0;
  for (const k of PREFERENCE_KEYS) {
    total += w[k] * parts[k];
    weight += w[k];
  }
  return clamp01(total / weight + clamp(ctx.loyalty ?? 0, 0, 0.2));
};

/** Score a player needs to sign: 0.42 when desperate (patience 0) up to 0.70 when fully patient. */
export const acceptThreshold = (patience: number): number => 0.42 + 0.28 * clamp01(patience);

/** True when an offer scoring `score` clears the player's bar at `patience`. */
export const willAccept = (score: number, patience: number): boolean => score >= acceptThreshold(patience);

/** How long a player is willing to wait (0..1): stars and competitors wait, veterans lock in, patience fades by the round. */
export const playerPatience = (player: Pick<Player, 'overall' | 'age' | 'traits'>, round: number, maxRounds: number): number => {
  let base = 0.55;
  if (player.overall >= 85) base += 0.2;
  else if (player.overall >= 78) base += 0.1;
  if (player.age >= 31) base -= 0.15;
  if (player.traits.includes('competitive')) base += 0.08;
  if (player.traits.includes('teamPlayer')) base -= 0.05;
  if (player.traits.includes('quiet')) base -= 0.05;
  const fade = maxRounds <= 1 ? 0 : clamp01(1 - (round - 1) / (maxRounds - 1));
  return clamp01(base * fade);
};

/**
 * The terms the player would sign for with this team: at least his ask (plus up to 15% when the team is a poor
 * fit on everything but money), his preferred length, and the more prominent of the offered and asked roles.
 * Returned as a pending FreeAgentOffer (id `${offer.id}-c`) the team can accept.
 */
export const counterOffer = (player: Player, team: Team, offer: FreeAgentOffer, league: League, year: number): FreeAgentOffer => {
  const ask = playerAsk(player, league, team, year);
  const parts = preferenceBreakdown(player, team, offer, league, { ask });
  const w = preferenceWeights(player.preferences);
  let fit = 0;
  let weight = 0;
  for (const k of PREFERENCE_KEYS) {
    if (k === 'money') continue;
    fit += w[k] * parts[k];
    weight += w[k];
  }
  const premium = clamp((0.6 - fit / Math.max(weight, 1e-9)) * 0.3, 0, 0.15);
  const apy = roundMoney(Math.max(contractApy(offer), ask.apy * (1 + premium)));
  const role = higherRole(offer.role, ask.role);
  const terms = termsFromApy(apy, ask.years, role, MARKET.guaranteeByRole[role], MARKET.bonusByRole[role]);
  return { id: `${offer.id}-c`, teamId: team.id, playerId: player.id, ...terms, round: offer.round, status: 'pending' };
};

/* ------------------------------------------------------ extensions/holdouts */

/** Loyalty bonus toward his own team (morale, coach relationship, team-player trait), 0..0.2. */
export const loyaltyBonus = (p: Player): number =>
  clamp(0.04 + (p.morale.morale - 50) / 500 + (p.morale.coachRelationship - 50) / 500 + (p.traits.includes('teamPlayer') ? 0.05 : 0), 0, 0.2);

/** Cap years an extension must fit: the league cap year and the next one. */
export const EXTENSION_CAP_YEARS = 2;

/**
 * Why `terms` would break the team's cap, or null: the deal (applied with contracts.ts `extend`, so rolled bonus
 * and guarantees count) may not leave the team over the cap in the cap year or the next one (projectedCapSpace,
 * cap grown by capGrowthRate). A team already over the cap may still sign a deal that does not make it worse.
 */
export const extensionCapIssue = (league: League, teamId: Team['id'], player: Player, terms: ContractTerms, year = leagueCapYear(league)): string | null => {
  const team = league.teams[teamId];
  if (!team) return `unknown team ${teamId}`;
  const before = projectedCapSpace(team, league.players, league.settings, year, EXTENSION_CAP_YEARS);
  const after = projectedCapSpace(team, { ...league.players, [player.id]: extend(player, terms, year) }, league.settings, year, EXTENSION_CAP_YEARS);
  for (const [i, a] of after.entries()) {
    const b = before[i];
    if (a.space < 0 && (!b || a.space < b.space)) {
      return `${team.abbr} would be $${Math.round(-a.space).toLocaleString('en-US')} over the ${a.year} cap ($${Math.round(a.cap).toLocaleString('en-US')})`;
    }
  }
  return null;
};

/* offerExtension (round-by-round talks with memory) lives in ./extension-talks.ts. */

/**
 * True when the player wants a new deal now: he is in the final season of his contract (overall 65+, not an
 * aging non-specialist), or — when `salaryCap` is given — he is a 78+ player badly underpaid with two years left.
 */
export const wantsExtension = (player: Player, year: number, salaryCap?: number): boolean => {
  const c = player.contract;
  if (!c || player.retired) return false;
  const yr = yearsRemainingAt(c, year);
  if (yr === 0) return false;
  const specialist = player.position === 'QB' || player.position === 'K' || player.position === 'P';
  if (player.age >= 34 && !specialist) return false;
  if (yr <= 1 && player.overall >= 65) return true;
  return salaryCap !== undefined && yr <= 2 && player.overall >= 78 && marketSalary(player, salaryCap) > capHit(c, year) * 1.3;
};

/** 0..1 chance-like pressure that an underpaid player holds out (rookie deals and team players rarely do). */
export const holdoutRisk = (player: Player, league: League, year: number): number => {
  const c = player.contract;
  if (!c || player.overall < 75) return 0;
  const hit = Math.max(1, capHit(c, year));
  const under = marketSalary(player, capForYear(league, year)) / hit;
  let risk = clamp01((under - 1.4) / 2);
  const traitMult: Partial<Record<string, number>> = { hotHeaded: 1.5, competitive: 1.2, teamPlayer: 0.4, quiet: 0.6, leader: 0.7 };
  for (const t of player.traits) risk *= traitMult[t] ?? 1;
  if (player.morale.morale < 50) risk *= 1.3;
  if (player.age > 30) risk *= 0.5;
  if (player.experience < 3) risk *= 0.25;
  return clamp01(risk);
};

/** Extension ask from his current team, starting in `year`: his ask plus 5% leverage in a final season. */
export const extensionAsk = (player: Player, league: League, team: Team, year: number): ContractAsk => {
  const ask = playerAsk(player, league, team, year);
  const final = player.contract ? yearsRemainingAt(player.contract, year) <= 1 : false;
  if (!final) return ask;
  const apy = roundMoney(ask.apy * 1.05);
  return { ...termsFromApy(apy, ask.years, ask.role, MARKET.guaranteeByRole[ask.role], MARKET.bonusByRole[ask.role]), apy, year };
};
