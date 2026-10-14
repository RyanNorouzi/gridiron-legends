/**
 * Club finances. Money is booked weekly into Team.finances (cash, seasonRevenue, seasonExpenses):
 *
 *   home games (preseason at a discount, regular season, playoffs at a premium; never the neutral-site final)
 *     tickets     = attendance x price, attendance = capacity x share (support, excitement, opponent draw,
 *                   rivalry, playoffs; price elasticity against the market's reference price)
 *     concessions = attendance x per-capita spend
 *     stadium ops = per game + per attendee
 *   every regular-season week (1/scheduleWeekCount of the season each)
 *     media (league broadcast share), merchandise (support x market x wins), sponsors (market x success)
 *     player salaries (cap hits + dead money), staff payroll (+ staff dead money), facility maintenance,
 *     stadium overhead
 *
 * Cash floor: a team that drops below the floor is topped up by its owner (ClubState.ownerSubsidy), which
 * weighs on `ownerConfidence`; AI teams re-price tickets toward the revenue-optimal price every week.
 * `closeFinancialYear` closes the books once per year (finance history, owner patience, counters reset);
 * events.ts closeClubSeason wraps it with the rest of the yearly club close. The attendance model and the
 * ticket tuning live in fans.ts. Tuning: src/data/finances.json, scaled by the league cap
 * (facilities.ts economyScale). Pure.
 */
import financesJson from '@/data/finances.json';
import type { GameId, TeamId } from '@/core/ids';
import { clamp, mean } from '@/core/math';
import type { FanBase, Stadium, Team } from '@/teams/types';
import { capHit, jsonNumber, jsonObject, leagueCapYear, teamDeadMoney } from './contracts';
import { economyScale, maintenanceCost } from './facilities';
import { TICKET_DATA, applyFanEvent, attendancePct, marketRecord, referenceTicketPrice, ticketPriceRange } from './fans';
import { teamSeasonRecord } from './history';
import { isChampionshipRound } from './playoffs';
import { ensureClub, rivalryEffects, rivalryIntensity, RIVALRY_TUNING, withClub } from './rivalries';
import { scheduleWeekCount } from './settings';
import { staffPayroll } from './staff';
import { gamesPlayed, winPct } from './standings';
import type { ClubFinanceRecord, League, ScheduledGame, SeasonPhase } from './types';

type Market = Team['marketSize'];
const FILE = 'finances.json';

/** Validated economy section of finances.json (money at the reference cap). */
export interface FinanceData {
  mediaPerSeason: number;
  concessions: { perCapita: number; playoffMultiplier: number };
  merchandise: { perSeason: Record<Market, number>; supportBase: number; supportWeight: number; winBase: number; winWeight: number };
  sponsors: { perSeason: Record<Market, number>; successBase: number; successWeight: number; offerChance: Record<Market, number>; offerShare: number };
  stadiumOps: { perHomeGame: number; perAttendee: number; weeklyOverhead: number };
  cash: { floor: number; aiCashTarget: number; aiMaxPriceStep: number };
  owner: Record<'baseline' | 'memory' | 'profitWeight' | 'cashWeight' | 'cashScale' | 'subsidyPenalty' | 'subsidyScale' | 'winWeight'
    | 'financialShare' | 'competitiveShare' | 'fanShare' | 'playoffBonus' | 'championBonus', number>;
}

const nums = <K extends string>(o: unknown, path: string, keys: readonly K[], min = 0, max = Infinity): Record<K, number> => {
  const obj = jsonObject(o, FILE, path);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = jsonNumber(obj, k, FILE, path, min, max);
  return out;
};

/** Validates the economy sections of finances.json. */
export const validateFinanceData = (raw: unknown): FinanceData => {
  const o = jsonObject(raw, FILE, '$');
  const m = jsonObject(o.merchandise, FILE, '$.merchandise');
  const s = jsonObject(o.sponsors, FILE, '$.sponsors');
  return {
    mediaPerSeason: jsonNumber(jsonObject(o.media, FILE, '$.media'), 'perSeason', FILE, '$.media', 0),
    concessions: nums(o.concessions, '$.concessions', ['perCapita', 'playoffMultiplier'] as const),
    merchandise: { perSeason: marketRecord(m.perSeason, '$.merchandise.perSeason'), ...nums(m, '$.merchandise', ['supportBase', 'supportWeight', 'winBase', 'winWeight'] as const) },
    sponsors: {
      perSeason: marketRecord(s.perSeason, '$.sponsors.perSeason'), offerChance: marketRecord(s.offerChance, '$.sponsors.offerChance', 0, 1),
      ...nums(s, '$.sponsors', ['successBase', 'successWeight', 'offerShare'] as const),
    },
    stadiumOps: nums(o.stadiumOps, '$.stadiumOps', ['perHomeGame', 'perAttendee', 'weeklyOverhead'] as const),
    cash: nums(o.cash, '$.cash', ['floor', 'aiCashTarget', 'aiMaxPriceStep'] as const, -1e12),
    owner: nums(o.owner, '$.owner', ['baseline', 'memory', 'profitWeight', 'cashWeight', 'cashScale', 'subsidyPenalty', 'subsidyScale', 'winWeight',
      'financialShare', 'competitiveShare', 'fanShare', 'playoffBonus', 'championBonus'] as const),
  };
};

/** Validated economy tuning. */
export const FINANCE_DATA: FinanceData = validateFinanceData(financesJson);

/* ---------------------------------------------------------------- home gate */

/** Gate of one home game. */
export interface HomeGameRevenue {
  capacity: number;
  attendance: number;
  attendancePct: number;
  /** Price actually charged (preseason discount / playoff premium applied). */
  price: number;
  tickets: number;
  concessions: number;
  /** Stadium operating cost of the game. */
  operations: number;
}

/**
 * Gate revenue of one home game: attendance from fan support/excitement, the opponent's draw, rivalry and
 * playoffs against price elasticity, capped by stadium capacity; concessions per attendee. `opts.scale` is
 * the league money scale (default 1), `opts.rivalryIntensity` refines the rivalry boost.
 */
export const weeklyHomeGameRevenue = (
  team: Pick<Team, 'marketSize'>, stadium: Pick<Stadium, 'capacity'>, fans: Pick<FanBase, 'support' | 'excitement'>, ticketPrice: number,
  opponent: Pick<Team, 'fans'> | null, isRivalry: boolean, isPlayoff: boolean,
  opts: { scale?: number; isPreseason?: boolean; rivalryIntensity?: number } = {},
): HomeGameRevenue => {
  const T = TICKET_DATA;
  const scale = opts.scale ?? 1;
  const intensity = isRivalry ? Math.max(RIVALRY_TUNING.threshold, opts.rivalryIntensity ?? 70) : 0;
  const pct = attendancePct({
    fans, ticketPrice, referencePrice: referenceTicketPrice(team, scale), opponentSupport: opponent?.fans.support,
    rivalryBoost: rivalryEffects(intensity).attendanceBoost, isPlayoff, isPreseason: opts.isPreseason ?? false,
  });
  const capacity = Math.max(0, Math.round(stadium.capacity));
  const attendance = Math.floor(capacity * pct);
  const price = ticketPrice * (opts.isPreseason ? T.preseasonPriceFactor : isPlayoff ? T.playoffPriceFactor : 1);
  const perCap = FINANCE_DATA.concessions.perCapita * scale * (isPlayoff ? FINANCE_DATA.concessions.playoffMultiplier : 1);
  return {
    capacity, attendance, attendancePct: capacity > 0 ? attendance / capacity : 0, price,
    tickets: Math.round(attendance * price), concessions: Math.round(attendance * perCap),
    operations: Math.round((FINANCE_DATA.stadiumOps.perHomeGame + FINANCE_DATA.stadiumOps.perAttendee * attendance) * scale),
  };
};

/* ------------------------------------------------------------ weekly ledger */

/** Revenue lines (TeamFinances.seasonRevenue keys plus media). */
export interface RevenueLines { tickets: number; merchandise: number; sponsors: number; concessions: number; media: number }
/** Expense lines (TeamFinances.seasonExpenses keys). */
export interface ExpenseLines { playerSalaries: number; staffSalaries: number; stadium: number; facilities: number }

/** One team's money for one week. */
export interface WeekLedger {
  teamId: TeamId;
  revenue: RevenueLines;
  expenses: ExpenseLines;
  net: number;
  homeGameId: GameId | null;
  attendance: number;
  attendancePct: number;
}

/** What applyWeekFinances needs to know about the week that was played. */
export interface WeekFinanceContext {
  /** Games finished this week (the team's home game is found here). */
  games?: readonly ScheduledGame[];
  /** Phase the week belonged to (default: the League's current phase). */
  phase?: SeasonPhase;
}

const zeroRevenue = (): RevenueLines => ({ tickets: 0, merchandise: 0, sponsors: 0, concessions: 0, media: 0 });
const zeroExpenses = (): ExpenseLines => ({ playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 });
const sumLines = (o: object): number => Object.values(o).reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0);

/** Season success 0..1 for sponsors: this season's win% once games are played, blended with last season. */
export const teamSuccess = (league: League, teamId: TeamId): number => {
  const st = league.season.standings[teamId];
  const team = league.teams[teamId];
  const last = team ? [...team.history].filter((h) => h.year < league.season.year).sort((a, b) => b.year - a.year)[0] : undefined;
  const lastPct = last && last.wins + last.losses + last.ties > 0 ? (last.wins + last.ties / 2) / (last.wins + last.losses + last.ties) : 0.5;
  const bonus = last?.champion ? 0.15 : last?.madePlayoffs ? 0.05 : 0;
  const current = st && gamesPlayed(st) > 0 ? winPct(st) : lastPct;
  return clamp(0.6 * current + 0.4 * lastPct + bonus, 0, 1);
};

/** Season-long recurring revenue at the league scale (media, merchandise, sponsors), before weekly proration. */
export const seasonalRevenue = (league: League, teamId: TeamId): Pick<RevenueLines, 'media' | 'merchandise' | 'sponsors'> => {
  const team = league.teams[teamId];
  if (!team) return { media: 0, merchandise: 0, sponsors: 0 };
  const F = FINANCE_DATA;
  const scale = economyScale(league.settings);
  const st = league.season.standings[teamId];
  const pct = st && gamesPlayed(st) > 0 ? winPct(st) : 0.5;
  const M = F.merchandise;
  return {
    media: F.mediaPerSeason * scale,
    merchandise: M.perSeason[team.marketSize] * scale * (M.supportBase + (M.supportWeight * team.fans.support) / 100) * (M.winBase + M.winWeight * pct),
    sponsors: F.sponsors.perSeason[team.marketSize] * scale * (F.sponsors.successBase + F.sponsors.successWeight * teamSuccess(league, teamId)),
  };
};

/** Season-long running costs (players incl. dead money, staff incl. dead money, facilities, stadium overhead). */
export const seasonalExpenses = (league: League, teamId: TeamId): ExpenseLines => {
  const team = league.teams[teamId];
  if (!team) return zeroExpenses();
  const year = leagueCapYear(league);
  const scale = economyScale(league.settings);
  let players = teamDeadMoney(team, year);
  for (const id of team.rosterIds) players += capHit(league.players[id]?.contract, year);
  return {
    playerSalaries: players,
    staffSalaries: staffPayroll(league, teamId, year).total,
    facilities: maintenanceCost(team, scale),
    stadium: FINANCE_DATA.stadiumOps.weeklyOverhead * scale * scheduleWeekCount(league.settings),
  };
};

/** The team's gate for a finished home game (null for away games, byes and the neutral-site final). */
export const homeGameGate = (league: League, teamId: TeamId, game: ScheduledGame): HomeGameRevenue | null => {
  const team = league.teams[teamId];
  if (!team || game.home !== teamId || !game.result) return null;
  if (game.isPlayoff && game.playoffRound !== null && isChampionshipRound(league.settings, game.playoffRound)) return null;
  const stadium = league.stadiums[team.stadiumId];
  if (!stadium) return null;
  const intensity = rivalryIntensity(league, game.home, game.away);
  return weeklyHomeGameRevenue(team, stadium, team.fans, team.finances.ticketPrice, league.teams[game.away] ?? null, intensity >= RIVALRY_TUNING.threshold, game.isPlayoff, {
    scale: economyScale(league.settings), isPreseason: game.isPreseason, rivalryIntensity: intensity,
  });
};

/** One team's money for the week just played (pure; nothing is applied). */
export const weekFinanceLedger = (league: League, teamId: TeamId, ctx: WeekFinanceContext = {}): WeekLedger => {
  const revenue = zeroRevenue();
  const expenses = zeroExpenses();
  const game = (ctx.games ?? []).find((g) => g.home === teamId && g.result);
  const gate = game ? homeGameGate(league, teamId, game) : null;
  if (gate) {
    revenue.tickets += gate.tickets;
    revenue.concessions += gate.concessions;
    expenses.stadium += gate.operations;
  }
  if ((ctx.phase ?? league.season.phase) === 'regularSeason') {
    const weeks = scheduleWeekCount(league.settings);
    const rev = seasonalRevenue(league, teamId);
    const exp = seasonalExpenses(league, teamId);
    revenue.media += rev.media / weeks;
    revenue.merchandise += rev.merchandise / weeks;
    revenue.sponsors += rev.sponsors / weeks;
    expenses.playerSalaries += exp.playerSalaries / weeks;
    expenses.staffSalaries += exp.staffSalaries / weeks;
    expenses.facilities += exp.facilities / weeks;
    expenses.stadium += exp.stadium / weeks;
  }
  for (const k of Object.keys(revenue) as (keyof RevenueLines)[]) revenue[k] = Math.round(revenue[k]);
  for (const k of Object.keys(expenses) as (keyof ExpenseLines)[]) expenses[k] = Math.round(expenses[k]);
  return {
    teamId, revenue, expenses, net: sumLines(revenue) - sumLines(expenses),
    homeGameId: gate && game ? game.id : null, attendance: gate?.attendance ?? 0, attendancePct: gate?.attendancePct ?? 0,
  };
};

/** Tops a team up to the cash floor from the owner's pocket (recorded as ownerSubsidy). Non-finite cash is reset to the floor. */
export const enforceCashFloor = (league: League, teamId: TeamId): League => {
  const team = league.teams[teamId];
  const floor = FINANCE_DATA.cash.floor * economyScale(league.settings);
  if (!team || team.finances.cash >= floor) return league;
  const gap = Number.isFinite(team.finances.cash) ? floor - team.finances.cash : 0;
  const club = ensureClub(league);
  const topped = { ...league, teams: { ...league.teams, [teamId]: { ...team, finances: { ...team.finances, cash: floor } } } };
  return withClub(topped, { ownerSubsidy: { ...club.ownerSubsidy, [teamId]: (club.ownerSubsidy[teamId] ?? 0) + gap } });
};

/** Books a ledger into the team's finances (cash, season lines, attendance), then enforces the cash floor. */
export const applyLedger = (league: League, ledger: WeekLedger): League => {
  const team = league.teams[ledger.teamId];
  if (!team) return league;
  const f = team.finances;
  const r = f.seasonRevenue;
  const e = f.seasonExpenses;
  const next: Team = {
    ...team,
    fans: ledger.homeGameId ? { ...team.fans, attendancePct: Math.round(ledger.attendancePct * 1000) / 1000 } : team.fans,
    finances: {
      ...f,
      cash: f.cash + ledger.net,
      seasonRevenue: {
        tickets: r.tickets + ledger.revenue.tickets, merchandise: r.merchandise + ledger.revenue.merchandise,
        sponsors: r.sponsors + ledger.revenue.sponsors, concessions: r.concessions + ledger.revenue.concessions, media: (r.media ?? 0) + ledger.revenue.media,
      },
      seasonExpenses: {
        playerSalaries: e.playerSalaries + ledger.expenses.playerSalaries, staffSalaries: e.staffSalaries + ledger.expenses.staffSalaries,
        stadium: e.stadium + ledger.expenses.stadium, facilities: e.facilities + ledger.expenses.facilities,
      },
    },
  };
  let out: League = { ...league, teams: { ...league.teams, [team.id]: next } };
  if (ledger.homeGameId) {
    const club = ensureClub(out);
    const a = club.attendance[team.id] ?? { games: 0, pctSum: 0 };
    out = withClub(out, { attendance: { ...club.attendance, [team.id]: { games: a.games + 1, pctSum: a.pctSum + ledger.attendancePct } } });
  }
  return enforceCashFloor(out, team.id);
};

/** Books one team's week (home gate, prorated recurring revenue and costs) and enforces the cash floor. */
export const applyWeekFinances = (league: League, teamId: TeamId, ctx: WeekFinanceContext = {}): League =>
  applyLedger(league, weekFinanceLedger(league, teamId, ctx));

/** Books every team's week; AI teams then re-price their tickets. */
export const applyAllWeekFinances = (league: League, ctx: WeekFinanceContext = {}): League => {
  let out = league;
  for (const id of Object.keys(league.teams) as TeamId[]) out = applyWeekFinances(out, id, ctx);
  for (const t of Object.values(out.teams)) if (!t.isUserControlled && t.id !== out.userTeamId) out = aiAdjustTicketPrice(out, t.id);
  return out;
};

/* ------------------------------------------------------------ ticket pricing */

/** Projected share of seats sold at `price` for a typical regular-season game (league-average opponent). */
export const projectedAttendance = (league: League, teamId: TeamId, price: number): number => {
  const team = league.teams[teamId];
  if (!team) return 0;
  const opp = mean(Object.values(league.teams).filter((t) => t.id !== teamId).map((t) => t.fans.support));
  return attendancePct({ fans: team.fans, ticketPrice: price, referencePrice: referenceTicketPrice(team, economyScale(league.settings)), opponentSupport: opp });
};

/** The price maximising tickets + concessions for a typical game (scanned over 40%..200% of the reference). */
export const optimalTicketPrice = (league: League, teamId: TeamId): number => {
  const team = league.teams[teamId];
  if (!team) return 0;
  const scale = economyScale(league.settings);
  const ref = referenceTicketPrice(team, scale);
  const [lo, hi] = ticketPriceRange(scale);
  let best = ref;
  let bestValue = -1;
  for (let f = 0.4; f <= 2.0001; f += 0.02) {
    const price = clamp(Math.round(ref * f), lo, hi);
    const pct = projectedAttendance(league, teamId, price);
    const value = pct * (price + FINANCE_DATA.concessions.perCapita * scale);
    if (value > bestValue + 1e-9) {
      bestValue = value;
      best = price;
    }
  }
  return best;
};

/** Result of setTicketPrice (League unchanged when refused). */
export interface TicketPriceResult {
  ok: boolean;
  reason: string | null;
  league: League;
  projectedAttendancePct: number;
}

/**
 * Sets a team's base ticket price (whole dollars within the allowed range). A raise above the hike
 * threshold upsets the fans (ticketHike with magnitude = percent raised / 10).
 */
export const setTicketPrice = (league: League, teamId: TeamId, price: number): TicketPriceResult => {
  const team = league.teams[teamId];
  if (!team) return { ok: false, reason: `Unknown team ${teamId}`, league, projectedAttendancePct: 0 };
  const [lo, hi] = ticketPriceRange(economyScale(league.settings));
  if (!Number.isFinite(price) || price < lo || price > hi) return { ok: false, reason: `Ticket price must be between $${lo} and $${hi}`, league, projectedAttendancePct: projectedAttendance(league, teamId, team.finances.ticketPrice) };
  const p = Math.round(price);
  const raise = (p - team.finances.ticketPrice) / Math.max(1, team.finances.ticketPrice);
  let out: League = { ...league, teams: { ...league.teams, [teamId]: { ...team, finances: { ...team.finances, ticketPrice: p } } } };
  if (raise > TICKET_DATA.hikeThreshold) out = applyFanEvent(out, teamId, 'ticketHike', (raise * 100) / 10);
  return { ok: true, reason: null, league: out, projectedAttendancePct: projectedAttendance(out, teamId, p) };
};

/**
 * AI pricing: move toward the revenue-optimal price by at most aiMaxPriceStep per call; a cash-poor club
 * prices at the optimum, a comfortable club with unhappy fans a little under it.
 */
export const aiAdjustTicketPrice = (league: League, teamId: TeamId): League => {
  const team = league.teams[teamId];
  if (!team) return league;
  const scale = economyScale(league.settings);
  const comfortable = team.finances.cash >= FINANCE_DATA.cash.aiCashTarget * scale;
  const target = optimalTicketPrice(league, teamId) * (comfortable && team.fans.support < 40 ? 0.95 : 1);
  const current = team.finances.ticketPrice;
  const step = FINANCE_DATA.cash.aiMaxPriceStep;
  const next = Math.round(clamp(target, current * (1 - step), current * (1 + step)));
  if (next === current) return league;
  const r = setTicketPrice(league, teamId, next);
  return r.ok ? r.league : league;
};

/* ------------------------------------------------------------- season books */

/** A team's season to date. */
export interface FinanceReport {
  teamId: TeamId;
  year: number;
  revenue: RevenueLines;
  expenses: ExpenseLines;
  totalRevenue: number;
  totalExpenses: number;
  profit: number;
  cash: number;
  ownerSubsidy: number;
  ownerConfidence: number;
  homeGames: number;
  averageAttendancePct: number;
}

/** Owner confidence 0..100: stored patience blended with this season's profit, cash, subsidy, results and fans. */
export const ownerConfidence = (league: League, teamId: TeamId): number => {
  const team = league.teams[teamId];
  if (!team) return 0;
  const O = FINANCE_DATA.owner;
  const club = ensureClub(league);
  const scale = economyScale(league.settings);
  const stored = club.ownerConfidence[teamId] ?? O.baseline;
  const revenue = sumLines(team.finances.seasonRevenue);
  const expenses = sumLines(team.finances.seasonExpenses);
  const margin = revenue > 0 ? (revenue - expenses) / revenue : 0;
  const subsidy = club.ownerSubsidy[teamId] ?? 0;
  const financial = clamp(50 + margin * O.profitWeight + clamp(team.finances.cash / (O.cashScale * scale), -1, 1) * O.cashWeight - (subsidy / (O.subsidyScale * scale)) * O.subsidyPenalty, 0, 100);
  const st = league.season.standings[teamId];
  const competitive = st && gamesPlayed(st) > 0 ? 50 + (winPct(st) - 0.5) * O.winWeight : stored;
  const live = O.financialShare * financial + O.competitiveShare * competitive + O.fanShare * team.fans.support;
  return Math.round(clamp(O.memory * stored + (1 - O.memory) * live, 0, 100) * 10) / 10;
};

/** The season's books so far for one team. */
export const seasonFinanceReport = (league: League, teamId: TeamId): FinanceReport => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`seasonFinanceReport: unknown team ${teamId}`);
  const r = team.finances.seasonRevenue;
  const revenue: RevenueLines = { tickets: r.tickets, merchandise: r.merchandise, sponsors: r.sponsors, concessions: r.concessions, media: r.media ?? 0 };
  const expenses: ExpenseLines = { ...team.finances.seasonExpenses };
  const club = ensureClub(league);
  const att = club.attendance[teamId] ?? { games: 0, pctSum: 0 };
  const totalRevenue = sumLines(revenue);
  const totalExpenses = sumLines(expenses);
  return {
    teamId, year: league.season.year, revenue, expenses, totalRevenue, totalExpenses, profit: totalRevenue - totalExpenses, cash: team.finances.cash,
    ownerSubsidy: club.ownerSubsidy[teamId] ?? 0, ownerConfidence: ownerConfidence(league, teamId),
    homeGames: att.games, averageAttendancePct: att.games > 0 ? att.pctSum / att.games : 0,
  };
};

/** True once the season's books were closed. */
export const isFinancialYearClosed = (league: League): boolean =>
  Object.values(ensureClub(league).financeHistory).some((list) => list.some((r) => r.year === league.season.year));

/**
 * Closes the season's books once (no-op when already closed): every team's report goes into the finance
 * history (last 10 kept), owner patience is stored (plus playoff / title bonuses), and the season counters,
 * owner subsidy and attendance tallies reset.
 */
export const closeFinancialYear = (league: League): League => {
  if (isFinancialYearClosed(league)) return league;
  const O = FINANCE_DATA.owner;
  const club = ensureClub(league);
  const financeHistory = { ...club.financeHistory };
  const confidence = { ...club.ownerConfidence };
  const teams = { ...league.teams };
  for (const t of Object.values(league.teams)) {
    const rep = seasonFinanceReport(league, t.id);
    const rec = teamSeasonRecord(league, t.id);
    const stored = clamp(rep.ownerConfidence + (rec.madePlayoffs ? O.playoffBonus : 0) + (rec.champion ? O.championBonus : 0), 0, 100);
    confidence[t.id] = stored;
    const entry: ClubFinanceRecord = {
      year: rep.year, revenue: rep.totalRevenue, expenses: rep.totalExpenses, profit: rep.profit, cashEnd: rep.cash,
      ownerSubsidy: rep.ownerSubsidy, ownerConfidence: stored, averageAttendancePct: Math.round(rep.averageAttendancePct * 1000) / 1000,
    };
    financeHistory[t.id] = [...(financeHistory[t.id] ?? []).filter((r) => r.year !== rep.year), entry].slice(-10);
    teams[t.id] = {
      ...t,
      finances: { ...t.finances, seasonRevenue: { tickets: 0, merchandise: 0, sponsors: 0, concessions: 0, media: 0 }, seasonExpenses: { playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 } },
    };
  }
  return withClub({ ...league, teams }, { financeHistory, ownerConfidence: confidence, ownerSubsidy: {}, attendance: {} });
};
