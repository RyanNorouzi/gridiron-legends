import { describe, expect, it } from 'vitest';
import { economyScale } from '@/franchise/facilities';
import { referenceTicketPrice } from '@/franchise/fans';
import {
  aiAdjustTicketPrice, applyWeekFinances, closeFinancialYear, isFinancialYearClosed, optimalTicketPrice, ownerConfidence, projectedAttendance,
  seasonFinanceReport, seasonalExpenses, setTicketPrice, weekFinanceLedger, weeklyHomeGameRevenue, type WeekLedger,
} from '@/franchise/finances';
import type { League } from '@/franchise/types';
import type { FanBase, Team } from '@/teams/types';
import { aiTeam, clubLeague, divisionPair, finishedGame, patchStanding, patchTeam, userTeamOf, withPhase } from './helpers';

const league = withPhase(clubLeague(), 'regularSeason', 1);
const team = userTeamOf(league);
const stadium = league.stadiums[team.stadiumId];
if (!stadium) throw new Error('no stadium');
const fans = (support: number, excitement: number): FanBase => ({ support, excitement, attendancePct: 0.9 });
const sumValues = (o: object): number => Object.values(o).reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0);
const setCash = (l: League, id: Team['id'], cash: number): League => patchTeam(l, id, (t) => ({ ...t, finances: { ...t.finances, cash } }));

describe('home gate', () => {
  const ref = referenceTicketPrice(team);
  const gate = (price: number, f: FanBase = fans(55, 50), rivalry = false, playoff = false) =>
    weeklyHomeGameRevenue(team, stadium, f, price, null, rivalry, playoff);

  it('attendance drops as the price rises', () => {
    const cheap = gate(ref * 0.9);
    const normal = gate(ref);
    const dear = gate(ref * 1.4);
    const gouge = gate(ref * 2.5);
    expect(normal.attendance).toBeLessThanOrEqual(cheap.attendance);
    expect(dear.attendance).toBeLessThan(normal.attendance);
    expect(gouge.attendance).toBeLessThan(dear.attendance);
    expect(gouge.attendancePct).toBeGreaterThan(0);
  });

  it('attendance rises with support and excitement, and never exceeds capacity', () => {
    const cold = gate(ref * 1.2, fans(30, 20));
    const warm = gate(ref * 1.2, fans(60, 60));
    const hot = gate(ref * 1.2, fans(95, 95));
    expect(warm.attendance).toBeGreaterThan(cold.attendance);
    expect(hot.attendance).toBeGreaterThanOrEqual(warm.attendance);
    expect(hot.attendance).toBeLessThanOrEqual(stadium.capacity);
    expect(gate(1).attendance).toBe(stadium.capacity);
  });

  it('rivalry and playoff games draw more; playoffs charge a premium; revenue lines are consistent', () => {
    const base = gate(ref * 1.3);
    const rivalry = gate(ref * 1.3, fans(55, 50), true);
    const playoff = gate(ref * 1.3, fans(55, 50), false, true);
    expect(rivalry.attendance).toBeGreaterThan(base.attendance);
    expect(playoff.attendance).toBeGreaterThan(base.attendance);
    expect(playoff.price).toBeGreaterThan(base.price);
    expect(base.tickets).toBe(Math.round(base.attendance * base.price));
    expect(base.concessions).toBeGreaterThan(0);
    expect(base.operations).toBeGreaterThan(0);
  });
});

describe('weekly ledger', () => {
  const opp = divisionPair(league).far;
  const home = finishedGame(team.id, opp.id, 21, 17, { week: 1 });
  const away = finishedGame(opp.id, team.id, 21, 17, { week: 1 });

  it('a regular-season home week books gate and recurring money; an away week only recurring money', () => {
    const h = weekFinanceLedger(league, team.id, { games: [home], phase: 'regularSeason' });
    const a = weekFinanceLedger(league, team.id, { games: [away], phase: 'regularSeason' });
    expect(h.homeGameId).toBe(home.id);
    expect(h.revenue.tickets).toBeGreaterThan(0);
    expect(h.revenue.concessions).toBeGreaterThan(0);
    expect(a.homeGameId).toBeNull();
    expect(a.revenue.tickets).toBe(0);
    for (const l of [h, a]) {
      expect(l.revenue.media).toBeGreaterThan(0);
      expect(l.revenue.merchandise).toBeGreaterThan(0);
      expect(l.revenue.sponsors).toBeGreaterThan(0);
      expect(l.expenses.playerSalaries).toBeGreaterThan(0);
      expect(l.expenses.staffSalaries).toBeGreaterThan(0);
      expect(l.expenses.facilities).toBeGreaterThan(0);
    }
    expect(h.expenses.stadium).toBeGreaterThan(a.expenses.stadium);
    expect(h.net).toBe(sumValues(h.revenue) - sumValues(h.expenses));
  });

  it('preseason weeks only book the gate; salaries are prorated over the regular season', () => {
    const pre = weekFinanceLedger(league, team.id, { games: [{ ...home, isPreseason: true }], phase: 'preseason' });
    expect(pre.revenue.tickets).toBeGreaterThan(0);
    expect(pre.revenue.media).toBe(0);
    expect(pre.expenses.playerSalaries).toBe(0);
    const reg = weekFinanceLedger(league, team.id, { games: [], phase: 'regularSeason' });
    const season = seasonalExpenses(league, team.id);
    expect(reg.expenses.playerSalaries).toBeCloseTo(season.playerSalaries / 18, -2);
  });

  it('the season report sums the booked weeks and cash moves by the profit', () => {
    let l = league;
    const cashBefore = team.finances.cash;
    const ledgers: WeekLedger[] = [];
    for (let w = 1; w <= 6; w++) {
      const game = w % 2 === 1 ? finishedGame(team.id, opp.id, 20, 10, { week: w }) : finishedGame(opp.id, team.id, 20, 10, { week: w });
      const ledger = weekFinanceLedger(l, team.id, { games: [game], phase: 'regularSeason' });
      ledgers.push(ledger);
      l = applyWeekFinances(l, team.id, { games: [game], phase: 'regularSeason' });
    }
    const report = seasonFinanceReport(l, team.id);
    expect(report.totalRevenue).toBe(sumValues(report.revenue));
    expect(report.totalExpenses).toBe(sumValues(report.expenses));
    expect(report.totalRevenue).toBe(ledgers.reduce((s, x) => s + sumValues(x.revenue), 0));
    expect(report.totalExpenses).toBe(ledgers.reduce((s, x) => s + sumValues(x.expenses), 0));
    expect(report.profit).toBe(report.totalRevenue - report.totalExpenses);
    expect(report.homeGames).toBe(3);
    expect(report.averageAttendancePct).toBeGreaterThan(0);
    expect(report.ownerSubsidy).toBe(0);
    expect(l.teams[team.id]?.finances.cash).toBe(cashBefore + report.profit);
    expect(l.teams[team.id]?.fans.attendancePct).toBeGreaterThan(0);
  });
});

describe('ticket pricing', () => {
  it('setTicketPrice validates the range and hikes upset the fans', () => {
    const current = team.finances.ticketPrice;
    expect(setTicketPrice(league, team.id, 0).ok).toBe(false);
    expect(setTicketPrice(league, team.id, 100_000).ok).toBe(false);
    const hike = setTicketPrice(league, team.id, Math.round(current * 1.3));
    expect(hike.ok).toBe(true);
    expect(hike.league.teams[team.id]?.fans.support).toBeLessThan(team.fans.support);
    expect(hike.projectedAttendancePct).toBeLessThan(projectedAttendance(league, team.id, current) + 1e-9);
    const cut = setTicketPrice(league, team.id, Math.round(current * 0.8));
    expect(cut.league.teams[team.id]?.fans.support).toBe(team.fans.support);
    expect(cut.league.teams[team.id]?.finances.ticketPrice).toBe(Math.round(current * 0.8));
  });

  it('the optimal price beats clearly worse prices', () => {
    const best = optimalTicketPrice(league, team.id);
    const value = (p: number): number => projectedAttendance(league, team.id, p) * (p + 22 * economyScale(league.settings));
    expect(value(best)).toBeGreaterThanOrEqual(value(best * 1.5));
    expect(value(best)).toBeGreaterThanOrEqual(value(best * 0.6));
  });

  it('AI re-pricing keeps a broke club at or above zero cash while moving toward the optimum', () => {
    const ai = aiTeam(league, 3);
    const opp = aiTeam(league, 4);
    const absurd = Math.round(referenceTicketPrice(ai) * 3);
    let l = patchTeam(setCash(league, ai.id, 500_000), ai.id, (t) => ({ ...t, fans: fans(30, 20), finances: { ...t.finances, ticketPrice: absurd } }));
    // A crippling buy-out owed to fired coaches makes every week a loss.
    l = { ...l, club: { rivalries: {}, playerFlags: {}, facilityUpgrades: {}, ownerSubsidy: {}, staffDeadMoney: { [ai.id]: { [l.year]: 250_000_000 } } } };
    const optimum = optimalTicketPrice(l, ai.id);
    let price = absurd;
    for (let w = 1; w <= 12; w++) {
      const game = w % 2 ? finishedGame(ai.id, opp.id, 10, 20, { week: w }) : finishedGame(opp.id, ai.id, 20, 10, { week: w });
      l = applyWeekFinances(l, ai.id, { games: [game], phase: 'regularSeason' });
      expect(l.teams[ai.id]?.finances.cash).toBeGreaterThanOrEqual(0);
      l = aiAdjustTicketPrice(l, ai.id);
      const next = l.teams[ai.id]?.finances.ticketPrice ?? 0;
      expect(Math.abs(next - optimum)).toBeLessThanOrEqual(Math.abs(price - optimum));
      price = next;
    }
    expect(price).toBeLessThan(absurd * 0.5);
    expect(l.club?.ownerSubsidy[ai.id] ?? 0).toBeGreaterThan(0);
  });
});

describe('owner and season close', () => {
  it('owner confidence falls with losing, losses and subsidies', () => {
    const winning = patchStanding(league, team.id, { wins: 10, losses: 2, streak: 3 });
    const losing = patchStanding(league, team.id, { wins: 2, losses: 10, streak: -3 });
    expect(ownerConfidence(winning, team.id)).toBeGreaterThan(ownerConfidence(losing, team.id));
    const bailedOut: League = { ...losing, club: { rivalries: {}, playerFlags: {}, staffDeadMoney: {}, facilityUpgrades: {}, ownerSubsidy: { [team.id]: 30_000_000 } } };
    expect(ownerConfidence(bailedOut, team.id)).toBeLessThan(ownerConfidence(losing, team.id));
    expect(ownerConfidence(league, team.id)).toBeGreaterThan(0);
  });

  it('closeFinancialYear stores history and owner patience, resets counters, and runs once', () => {
    let l = league;
    const opp = aiTeam(league, 0);
    for (let w = 1; w <= 3; w++) l = applyWeekFinances(l, team.id, { games: [finishedGame(team.id, opp.id, 21, 3, { week: w })], phase: 'regularSeason' });
    const report = seasonFinanceReport(l, team.id);
    const closed = closeFinancialYear(l);
    expect(isFinancialYearClosed(closed)).toBe(true);
    const history = closed.club?.financeHistory?.[team.id] ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ year: l.season.year, revenue: report.totalRevenue, expenses: report.totalExpenses, profit: report.profit });
    expect(closed.club?.ownerConfidence?.[team.id]).toBeGreaterThan(0);
    const t = closed.teams[team.id];
    expect(sumValues(t?.finances.seasonRevenue ?? {})).toBe(0);
    expect(sumValues(t?.finances.seasonExpenses ?? {})).toBe(0);
    expect(t?.finances.cash).toBe(l.teams[team.id]?.finances.cash);
    expect(closeFinancialYear(closed)).toBe(closed);
  });
});
