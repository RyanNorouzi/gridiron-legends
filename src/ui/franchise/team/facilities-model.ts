/**
 * Facilities & finances view-models for the user's team: facility levels with the next upgrade's cost,
 * current and next effects, maintenance and canUpgradeFacility's verdict; ticket pricing (current price,
 * projectedAttendance at it, the revenue-optimal price, the market reference and the allowed range); the
 * season finance report (seasonFinanceReport revenue/expense lines, profit, cash, subsidy) with closed seasons;
 * and the fan base / owner confidence meters. Upgrades and price changes go through facilities.ts / finances.ts.
 */
import type { TeamId } from '@/core/ids';
import {
  FACILITY_DATA, FACILITY_TYPES, canUpgradeFacility, economyScale, facilityLevel, facilityMaintenance, upgradeCost, upgradeFacility,
  upgradesThisOffseason, type UpgradeCheck,
} from '@/franchise/facilities';
import { referenceTicketPrice, ticketPriceRange } from '@/franchise/fans';
import { optimalTicketPrice, ownerConfidence, projectedAttendance, seasonFinanceReport, setTicketPrice } from '@/franchise/finances';
import { ensureClub } from '@/franchise/rivalries';
import type { League } from '@/franchise/types';
import type { FacilityType } from '@/teams/types';
import { formatMoney, formatPercent, humanize, type ToneText } from '../kit/format';
import { done, infoHeading, meterTone, refused, type ActionResult, type InfoLine } from './common';

/** One facility row. */
export interface FacilityRow {
  id: FacilityType;
  label: string;
  level: number;
  maxLevel: number;
  /** Cost of the next level (null at the top). */
  cost: number | null;
  check: UpgradeCheck;
  effectNow: string;
  effectNext: string | null;
  maintenance: number;
  maintenanceNext: number | null;
}

const effectAt = (type: FacilityType, key: string, level: number): number => FACILITY_DATA.facilities[type].effects[key]?.[level - 1] ?? 0;

const pctText = (v: number): string => `${Math.round(v * 1000) / 10}%`;

/** What a facility does at a level, in words. */
export const facilityEffectText = (type: FacilityType, level: number): string => {
  const e = (k: string): number => effectAt(type, k, level);
  switch (type) {
    case 'training': return `Growth x${e('devMultiplier').toFixed(2)}`;
    case 'medical': return `Injury time -${pctText(1 - e('injuryWeeksMultiplier'))}, risk -${pctText(1 - e('injuryChanceMultiplier'))}`;
    case 'scouting': return `+${e('scoutingPoints')} scouting points`;
    case 'stadium': return `Capacity +${pctText(e('capacityPct'))}, atmosphere +${e('atmosphere')}`;
    case 'development': return `Young growth x${e('youngGrowthMultiplier').toFixed(2)}`;
    case 'analytics': return `Scouting accuracy +${pctText(e('scoutingAccuracy'))}, game plan +${pctText(e('gameplanBonus'))}`;
    default: return '';
  }
};

/** Facility rows of the team. */
export const facilityRows = (league: League, teamId: TeamId): FacilityRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const scale = economyScale(league.settings);
  const max = FACILITY_DATA.maxLevel;
  return FACILITY_TYPES.map((type) => {
    const level = facilityLevel(team.facilities, type);
    const top = level >= max;
    return {
      id: type, label: FACILITY_DATA.facilities[type].label, level, maxLevel: max, cost: upgradeCost(type, level, scale), check: canUpgradeFacility(league, teamId, type),
      effectNow: facilityEffectText(type, level), effectNext: top ? null : facilityEffectText(type, level + 1),
      maintenance: facilityMaintenance(type, level, scale), maintenanceNext: top ? null : facilityMaintenance(type, level + 1, scale),
    };
  });
};

/** Buys the next level of a facility. */
export const upgrade = (league: League, teamId: TeamId, type: FacilityType): ActionResult => {
  const r = upgradeFacility(league, teamId, type);
  if (!r.ok) return refused(league, r.reason ?? 'Cannot upgrade');
  return done(r.league, `${FACILITY_DATA.facilities[type].label} upgraded to level ${r.newLevel} (${formatMoney(r.cost ?? 0)})`);
};

/** Facilities summary: cash and the offseason upgrade window. */
export const facilitySummary = (league: League, teamId: TeamId): ToneText => {
  const team = league.teams[teamId];
  if (!team) return { text: 'No team', tone: 'danger' };
  const open = facilityRows(league, teamId).some((r) => r.check.ok);
  const used = upgradesThisOffseason(league, teamId);
  const window = open ? `upgrades available (${used} bought this offseason)` : 'upgrades open in the offseason';
  return { text: `Cash ${formatMoney(team.finances.cash)} · ${window}`, tone: open ? 'success' : 'dim' };
};

/* --------------------------------- tickets --------------------------------- */

/** An info line that may carry a ticket action. */
export interface TicketLine extends InfoLine {
  action?: 'price' | 'optimal';
}

/** Ticket-pricing lines (the first two are actionable). */
export const ticketLines = (league: League, teamId: TeamId): TicketLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const scale = economyScale(league.settings);
  const price = team.finances.ticketPrice;
  const optimal = optimalTicketPrice(league, teamId);
  const [lo, hi] = ticketPriceRange(scale);
  const att = projectedAttendance(league, teamId, price);
  const attOpt = projectedAttendance(league, teamId, optimal);
  const capacity = league.stadiums[team.stadiumId]?.capacity ?? 0;
  return [
    { id: 'price', label: '▶ Ticket price', value: { text: `$${price}`, tone: 'accent' }, action: 'price' },
    { id: 'optimal', label: '▶ Use optimal price', value: { text: `$${optimal}${optimal === price ? ' (current)' : ''}`, tone: 'info' }, action: 'optimal' },
    infoHeading('h-proj', 'Projection (typical game)'),
    { id: 'att', label: 'Attendance at your price', value: { text: formatPercent(att), tone: meterTone(att * 100) }, bar: { value: att * 100, max: 100, tone: meterTone(att * 100) } },
    { id: 'attOpt', label: 'Attendance at optimal', value: formatPercent(attOpt), bar: { value: attOpt * 100, max: 100, tone: 'info' } },
    { id: 'gate', label: 'Gate per home game', value: formatMoney(capacity * att * price) },
    { id: 'gateOpt', label: 'Gate at optimal price', value: formatMoney(capacity * attOpt * optimal) },
    infoHeading('h-market', 'Market'),
    { id: 'ref', label: 'Market reference', value: `$${Math.round(referenceTicketPrice(team, scale))} (${humanize(team.marketSize)} market)` },
    { id: 'range', label: 'Allowed range', value: `$${lo} - $${hi}` },
    { id: 'capacity', label: 'Stadium capacity', value: capacity.toLocaleString('en-US') },
  ];
};

/** Stepper spec of the ticket price. */
export const ticketField = (league: League, teamId: TeamId): { id: string; label: string; min: number; max: number; step: number; bigStep: number; value: number; format: (v: number) => string } => {
  const [lo, hi] = ticketPriceRange(economyScale(league.settings));
  const price = league.teams[teamId]?.finances.ticketPrice ?? lo;
  return { id: 'price', label: 'Ticket price', min: lo, max: hi, step: 1, bigStep: 10, value: Math.max(lo, Math.min(hi, price)), format: (v) => `$${v}` };
};

/** Sets the ticket price. */
export const changeTicketPrice = (league: League, teamId: TeamId, price: number): ActionResult => {
  const r = setTicketPrice(league, teamId, price);
  if (!r.ok) return refused(league, r.reason ?? 'Invalid price');
  return done(r.league, `Tickets now $${Math.round(price)} · projected attendance ${formatPercent(r.projectedAttendancePct)}`);
};

/* --------------------------------- finances -------------------------------- */

/** The season's books plus closed seasons as info lines. */
export const financeLines = (league: League, teamId: TeamId): InfoLine[] => {
  if (!league.teams[teamId]) return [];
  const r = seasonFinanceReport(league, teamId);
  const signed = (v: number): ToneText => ({ text: formatMoney(v), tone: v >= 0 ? 'success' : 'danger' });
  const lines: InfoLine[] = [
    infoHeading('h-rev', `${r.year} revenue`),
    { id: 'rev-tickets', label: 'Tickets', value: formatMoney(r.revenue.tickets) },
    { id: 'rev-concessions', label: 'Concessions', value: formatMoney(r.revenue.concessions) },
    { id: 'rev-merch', label: 'Merchandise', value: formatMoney(r.revenue.merchandise) },
    { id: 'rev-sponsors', label: 'Sponsors', value: formatMoney(r.revenue.sponsors) },
    { id: 'rev-media', label: 'Media', value: formatMoney(r.revenue.media) },
    { id: 'rev-total', label: 'Total revenue', value: { text: formatMoney(r.totalRevenue), tone: 'accent' } },
    infoHeading('h-exp', `${r.year} expenses`),
    { id: 'exp-players', label: 'Player salaries', value: formatMoney(r.expenses.playerSalaries) },
    { id: 'exp-staff', label: 'Staff salaries', value: formatMoney(r.expenses.staffSalaries) },
    { id: 'exp-stadium', label: 'Stadium', value: formatMoney(r.expenses.stadium) },
    { id: 'exp-facilities', label: 'Facilities', value: formatMoney(r.expenses.facilities) },
    { id: 'exp-total', label: 'Total expenses', value: { text: formatMoney(r.totalExpenses), tone: 'accent' } },
    infoHeading('h-net', 'Bottom line'),
    { id: 'profit', label: 'Profit', value: signed(r.profit) },
    { id: 'cash', label: 'Cash', value: signed(r.cash) },
    { id: 'subsidy', label: 'Owner subsidy', value: r.ownerSubsidy > 0 ? { text: formatMoney(r.ownerSubsidy), tone: 'warning' } : { text: '-', tone: 'dim' } },
    { id: 'games', label: 'Home games', value: `${r.homeGames} (avg ${formatPercent(r.averageAttendancePct)} full)` },
  ];
  const history = [...(ensureClub(league).financeHistory[teamId] ?? [])].reverse();
  if (history.length > 0) {
    lines.push(infoHeading('h-hist', 'Past seasons'));
    for (const h of history) lines.push({ id: `hist-${h.year}`, label: String(h.year), value: { text: `Profit ${formatMoney(h.profit)} · cash ${formatMoney(h.cashEnd)}`, tone: h.profit >= 0 ? 'success' : 'danger' } });
  }
  return lines;
};

/** Fans, attendance, owner confidence and stadium as info lines. */
export const fanLines = (league: League, teamId: TeamId): InfoLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const meter = (id: string, label: string, v: number): InfoLine => ({ id, label, value: { text: String(Math.round(v)), tone: meterTone(v) }, bar: { value: v, max: 100, tone: meterTone(v) } });
  const stadium = league.stadiums[team.stadiumId];
  const owner = ownerConfidence(league, teamId);
  return [
    infoHeading('h-fans', 'Fans'),
    meter('support', 'Fan support', team.fans.support),
    meter('excitement', 'Excitement', team.fans.excitement),
    meter('attendance', 'Attendance', team.fans.attendancePct * 100),
    infoHeading('h-owner', 'Front office'),
    meter('owner', 'Owner confidence', owner),
    { id: 'market', label: 'Market size', value: humanize(team.marketSize) },
    ...(stadium ? [
      infoHeading('h-stadium', stadium.name),
      { id: 'st-capacity', label: 'Capacity', value: stadium.capacity.toLocaleString('en-US') },
      meter('st-atmosphere', 'Atmosphere', stadium.atmosphere),
      { id: 'st-type', label: 'Roof / field', value: `${humanize(stadium.roof)} / ${humanize(stadium.fieldType)}` },
    ] : []),
  ];
};

/** Fans summary line. */
export const fanSummary = (league: League, teamId: TeamId): ToneText => {
  const team = league.teams[teamId];
  if (!team) return { text: 'No team', tone: 'danger' };
  const owner = ownerConfidence(league, teamId);
  return { text: `Support ${Math.round(team.fans.support)} · excitement ${Math.round(team.fans.excitement)} · owner confidence ${Math.round(owner)}`, tone: meterTone(owner) };
};
