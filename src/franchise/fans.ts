/**
 * Fan base: support (long-run loyalty, 0..100) and excitement (hype for the current season, 0..100).
 *
 * Reactions (`updateFans`) come from results, rivalries, signings, trades, the draft, titles and ticket
 * hikes. Every change is damped by market size (big markets are harder to move) and by headroom (gains
 * shrink near 100, losses near 0). Each week support drifts back toward a baseline set by market size,
 * titles and recent seasons, and excitement toward neutral. Excitement is reset each season from the last
 * season's finish. The attendance model (`attendancePct`: support, excitement, opponent draw, rivalry and
 * playoffs against ticket-price elasticity) lives here too; finances.ts turns it into gate revenue.
 * Tuning: the `fans` and `tickets` sections of src/data/finances.json. Pure.
 */
import financesJson from '@/data/finances.json';
import type { TeamId } from '@/core/ids';
import { clamp, mean } from '@/core/math';
import { MARKET_DEFAULTS } from '@/teams/generator';
import type { FanBase, Team, TeamSeasonRecord } from '@/teams/types';
import { jsonArray, jsonNumber, jsonObject } from './contracts';
import { isChampionshipRound } from './playoffs';
import { rivalryEffects, rivalryIntensity, RIVALRY_TUNING } from './rivalries';
import type { League, ScheduledGame } from './types';

/** Everything that moves a fan base. */
export type FanEvent =
  | 'win' | 'loss' | 'bigSigning' | 'draftPick' | 'rivalryWin' | 'rivalryLoss' | 'championship'
  | 'playoffs' | 'losingStreak' | 'starTraded' | 'ticketHike';

/** Every FanEvent. */
export const FAN_EVENTS: readonly FanEvent[] = [
  'win', 'loss', 'bigSigning', 'draftPick', 'rivalryWin', 'rivalryLoss', 'championship', 'playoffs', 'losingStreak', 'starTraded', 'ticketHike',
];

type Market = Team['marketSize'];

/** Validated `fans` section of finances.json. */
export interface FanData {
  damping: Record<Market, number>;
  effects: Record<FanEvent, { support: number; excitement: number }>;
  decay: { support: number; excitement: number };
  excitementBaseline: number;
  championshipBaselineBonus: number;
  championshipBaselineCap: number;
  historyWeight: number;
  historySeasons: number;
  baselineRange: [number, number];
  reset: { winWeight: number; playoffs: number; champion: number; supportWeight: number };
  losingStreakLength: number;
}

const FILE = 'finances.json';

/** Reads a {small, medium, large} number record. */
export const marketRecord = (v: unknown, path: string, min = 0, max = Infinity): Record<Market, number> => {
  const o = jsonObject(v, FILE, path);
  return { small: jsonNumber(o, 'small', FILE, path, min, max), medium: jsonNumber(o, 'medium', FILE, path, min, max), large: jsonNumber(o, 'large', FILE, path, min, max) };
};

/** Validates the fans section of finances.json. */
export const validateFanData = (raw: unknown): FanData => {
  const root = jsonObject(raw, FILE, '$');
  const o = jsonObject(root.fans, FILE, '$.fans');
  const e = jsonObject(o.effects, FILE, '$.fans.effects');
  const effects = {} as FanData['effects'];
  for (const ev of FAN_EVENTS) {
    const x = jsonObject(e[ev], FILE, `$.fans.effects.${ev}`);
    effects[ev] = { support: jsonNumber(x, 'support', FILE, `$.fans.effects.${ev}`, -50, 50), excitement: jsonNumber(x, 'excitement', FILE, `$.fans.effects.${ev}`, -60, 60) };
  }
  const decay = jsonObject(o.decay, FILE, '$.fans.decay');
  const range = jsonArray(o.baselineRange, FILE, '$.fans.baselineRange');
  const lo = range[0];
  const hi = range[1];
  if (typeof lo !== 'number' || typeof hi !== 'number' || lo < 0 || hi > 100 || lo >= hi) throw new Error(`${FILE}: $.fans.baselineRange must be [lo, hi] within 0..100`);
  const reset = jsonObject(o.reset, FILE, '$.fans.reset');
  return {
    damping: marketRecord(o.damping, '$.fans.damping', 0.1, 3),
    effects,
    decay: { support: jsonNumber(decay, 'support', FILE, '$.fans.decay', 0, 1), excitement: jsonNumber(decay, 'excitement', FILE, '$.fans.decay', 0, 1) },
    excitementBaseline: jsonNumber(o, 'excitementBaseline', FILE, '$.fans', 0, 100),
    championshipBaselineBonus: jsonNumber(o, 'championshipBaselineBonus', FILE, '$.fans', 0, 20),
    championshipBaselineCap: jsonNumber(o, 'championshipBaselineCap', FILE, '$.fans', 0, 50),
    historyWeight: jsonNumber(o, 'historyWeight', FILE, '$.fans', 0, 100),
    historySeasons: jsonNumber(o, 'historySeasons', FILE, '$.fans', 1, 20),
    baselineRange: [lo, hi],
    reset: {
      winWeight: jsonNumber(reset, 'winWeight', FILE, '$.fans.reset', 0, 100),
      playoffs: jsonNumber(reset, 'playoffs', FILE, '$.fans.reset', 0, 50),
      champion: jsonNumber(reset, 'champion', FILE, '$.fans.reset', 0, 50),
      supportWeight: jsonNumber(reset, 'supportWeight', FILE, '$.fans.reset', 0, 1),
    },
    losingStreakLength: jsonNumber(o, 'losingStreakLength', FILE, '$.fans', 2, 17),
  };
};

/** Validated fan tuning. */
export const FAN_DATA: FanData = validateFanData(financesJson);

const clampFan = (v: number): number => clamp(Math.round(v * 10) / 10, 0, 100);

/** Headroom factor: gains shrink as the value nears 100, losses as it nears 0. */
const headroom = (value: number, delta: number): number => clamp((delta >= 0 ? 100 - value : value) / 50, 0.25, 1.25);

/**
 * The fan base after one event. `magnitude` scales the base effect (0..5; e.g. a ticket hike passes the
 * percentage raised / 10). Market damping and headroom apply; attendancePct is left to the finances.
 */
export const updateFans = (team: Pick<Team, 'fans' | 'marketSize'>, event: FanEvent, magnitude = 1): FanBase => {
  const fx = FAN_DATA.effects[event];
  const m = clamp(Number.isFinite(magnitude) ? magnitude : 0, 0, 5) * FAN_DATA.damping[team.marketSize];
  const f = team.fans;
  const ds = fx.support * m;
  const de = fx.excitement * m;
  return { ...f, support: clampFan(f.support + ds * headroom(f.support, ds)), excitement: clampFan(f.excitement + de * headroom(f.excitement, de)) };
};

/** Win% of a season record (null without games). */
const recordPct = (h: Pick<TeamSeasonRecord, 'wins' | 'losses' | 'ties'>): number | null => {
  const g = h.wins + h.losses + h.ties;
  return g === 0 ? null : (h.wins + h.ties / 2) / g;
};

/** Long-run support level a fan base drifts toward: market, titles and the last few seasons. */
export const fanBaseline = (team: Pick<Team, 'marketSize' | 'championships' | 'history'>): number => {
  const D = FAN_DATA;
  const recent = [...team.history].sort((a, b) => b.year - a.year).slice(0, D.historySeasons).map(recordPct).filter((p): p is number => p !== null);
  const history = recent.length ? (mean(recent) - 0.5) * D.historyWeight : 0;
  const titles = Math.min(D.championshipBaselineCap, team.championships * D.championshipBaselineBonus);
  return clamp(MARKET_DEFAULTS[team.marketSize].support + titles + history, D.baselineRange[0], D.baselineRange[1]);
};

/** One week of drift: support toward the baseline, excitement toward neutral. */
export const weeklyFanDecay = (team: Pick<Team, 'fans' | 'marketSize' | 'championships' | 'history'>): FanBase => {
  const f = team.fans;
  const base = fanBaseline(team);
  return {
    ...f,
    support: clampFan(f.support + (base - f.support) * FAN_DATA.decay.support),
    excitement: clampFan(f.excitement + (FAN_DATA.excitementBaseline - f.excitement) * FAN_DATA.decay.excitement),
  };
};

/**
 * Excitement for a new season from the last one: win% around .500, playoff trip, title, and the level of
 * support. Without a finished season (no record) excitement returns to neutral shaded by support.
 */
export const seasonFanReset = (team: Pick<Team, 'fans'>, lastSeason: Pick<TeamSeasonRecord, 'wins' | 'losses' | 'ties' | 'madePlayoffs' | 'champion'> | null): FanBase => {
  const R = FAN_DATA.reset;
  const pct = lastSeason ? recordPct(lastSeason) : null;
  const excitement = FAN_DATA.excitementBaseline + (pct === null ? 0 : (pct - 0.5) * R.winWeight)
    + (lastSeason?.madePlayoffs ? R.playoffs : 0) + (lastSeason?.champion ? R.champion : 0) + (team.fans.support - 50) * R.supportWeight;
  return { ...team.fans, excitement: clampFan(excitement) };
};

/** A League with one team's fans updated by an event. Unknown teams leave the League unchanged. */
export const applyFanEvent = (league: League, teamId: TeamId, event: FanEvent, magnitude = 1): League => {
  const team = league.teams[teamId];
  if (!team) return league;
  return { ...league, teams: { ...league.teams, [teamId]: { ...team, fans: updateFans(team, event, magnitude) } } };
};

/** The fan events one finished game produces for each side (preseason games produce none). */
export const gameFanEvents = (league: League, game: ScheduledGame): { teamId: TeamId; event: FanEvent; magnitude: number }[] => {
  const r = game.result;
  if (!r || game.isPreseason || r.homeScore === r.awayScore) return [];
  const intensity = rivalryIntensity(league, game.home, game.away);
  const rivalry = intensity >= RIVALRY_TUNING.threshold;
  const mult = rivalryEffects(intensity).fanMultiplier;
  const winner = r.homeScore > r.awayScore ? game.home : game.away;
  const loser = winner === game.home ? game.away : game.home;
  const out: { teamId: TeamId; event: FanEvent; magnitude: number }[] = [];
  if (game.isPlayoff) {
    out.push({ teamId: winner, event: 'win', magnitude: 1.5 }, { teamId: loser, event: 'loss', magnitude: 0.5 });
    if (game.playoffRound !== null && isChampionshipRound(league.settings, game.playoffRound)) out.push({ teamId: winner, event: 'championship', magnitude: 1 });
  } else if (rivalry) {
    out.push({ teamId: winner, event: 'rivalryWin', magnitude: mult / 2 }, { teamId: loser, event: 'rivalryLoss', magnitude: mult / 2 });
  } else {
    const blowout = Math.abs(r.homeScore - r.awayScore) >= 21 ? 1.3 : 1;
    out.push({ teamId: winner, event: 'win', magnitude: blowout }, { teamId: loser, event: 'loss', magnitude: blowout });
  }
  const streak = league.season.standings[loser]?.streak ?? 0;
  if (!game.isPlayoff && streak <= -FAN_DATA.losingStreakLength) out.push({ teamId: loser, event: 'losingStreak', magnitude: 1 + (Math.abs(streak) - FAN_DATA.losingStreakLength) * 0.25 });
  return out;
};

/** Applies every finished game's fan events (standings must already include the games). */
export const applyGamesToFans = (league: League, games: readonly ScheduledGame[]): League => {
  let out = league;
  for (const g of games) for (const e of gameFanEvents(league, g)) out = applyFanEvent(out, e.teamId, e.event, e.magnitude);
  return out;
};

/** Weekly drift for every team. */
export const decayAllFans = (league: League): League => {
  const teams = { ...league.teams };
  for (const t of Object.values(league.teams)) teams[t.id] = { ...t, fans: weeklyFanDecay(t) };
  return { ...league, teams };
};

/* ------------------------------------------------------------------ attendance */

/** Validated `tickets` section of finances.json (prices at the reference cap). */
export interface TicketData {
  referencePrice: Record<Market, number>;
  minPrice: number; maxPrice: number; elasticity: number; baseDemand: number; supportWeight: number; excitementWeight: number;
  opponentWeight: number; playoffBoost: number; minAttendancePct: number; preseasonPriceFactor: number; preseasonDemandFactor: number;
  playoffPriceFactor: number; hikeThreshold: number;
}

const TICKET_KEYS = ['minPrice', 'maxPrice', 'elasticity', 'baseDemand', 'supportWeight', 'excitementWeight', 'opponentWeight', 'playoffBoost',
  'minAttendancePct', 'preseasonPriceFactor', 'preseasonDemandFactor', 'playoffPriceFactor', 'hikeThreshold'] as const;

/** Validates the tickets section of finances.json. */
export const validateTicketData = (raw: unknown): TicketData => {
  const t = jsonObject(jsonObject(raw, FILE, '$').tickets, FILE, '$.tickets');
  const out = { referencePrice: marketRecord(t.referencePrice, '$.tickets.referencePrice', 1) } as TicketData;
  for (const k of TICKET_KEYS) out[k] = jsonNumber(t, k, FILE, '$.tickets', 0);
  if (out.minPrice >= out.maxPrice) throw new Error(`${FILE}: $.tickets.minPrice must be below maxPrice`);
  return out;
};

/** Validated ticket tuning. */
export const TICKET_DATA: TicketData = validateTicketData(financesJson);

/** The market's reference ticket price at the league's money scale. */
export const referenceTicketPrice = (team: Pick<Team, 'marketSize'>, scale = 1): number => TICKET_DATA.referencePrice[team.marketSize] * scale;

/** Allowed ticket price range at the league's money scale. */
export const ticketPriceRange = (scale = 1): [number, number] => [Math.round(TICKET_DATA.minPrice * scale), Math.round(TICKET_DATA.maxPrice * scale)];

/** Context of one home game for the attendance model. */
export interface AttendanceInputs {
  fans: Pick<FanBase, 'support' | 'excitement'>;
  /** Base (regular-season) ticket price. */
  ticketPrice: number;
  referencePrice: number;
  opponentSupport?: number;
  rivalryBoost?: number;
  isPlayoff?: boolean;
  isPreseason?: boolean;
}

/**
 * Share of seats sold (minAttendancePct..1): demand from support, excitement, the opponent's draw, rivalry
 * and playoffs, divided by (price / reference)^elasticity. Preseason and playoff prices are scaled together
 * with the reference, so only the base price the club sets matters.
 */
export const attendancePct = (i: AttendanceInputs): number => {
  const T = TICKET_DATA;
  let demand = T.baseDemand + (T.supportWeight * clamp(i.fans.support, 0, 100)) / 100 + (T.excitementWeight * clamp(i.fans.excitement, 0, 100)) / 100
    + T.opponentWeight * (clamp(i.opponentSupport ?? 50, 0, 100) / 100 - 0.5) + (i.rivalryBoost ?? 0) + (i.isPlayoff ? T.playoffBoost : 0);
  if (i.isPreseason) demand *= T.preseasonDemandFactor;
  const ratio = Math.max(0.05, i.ticketPrice / Math.max(1, i.referencePrice));
  return clamp(demand * ratio ** -T.elasticity, T.minAttendancePct, 1);
};
