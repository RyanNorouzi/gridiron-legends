/**
 * Coaching-staff view-models: the user's staff by role (vacant roles included) with role rating, all seven
 * ratings, traits, schemes, salary and years; the coach market (unattached coaches, optionally one role) with
 * each coach's ask; the staff-effects summary (development, injuries, scouting, game management, motivation,
 * conditioning, per-group coaching bonuses and payroll); and the hire / fire transforms over staff.ts.
 */
import type { CoachId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { CONTRACT_DATA, leagueCapYear } from '@/franchise/contracts';
import {
  STAFF_TUNING, availableCoaches, coachAsk, coachMarket, fireCoach, hireCoach, staffEffects, staffPayroll, teamStaff, turnoverPending,
} from '@/franchise/staff';
import type { League } from '@/franchise/types';
import { ROLE_PROFILES, STAFF_ROLES, roleRating } from '@/teams/coach-generator';
import type { Coach, CoachRatings, StaffRole } from '@/franchise/types';
import type { PositionGroup } from '@/players/types';
import { formatMoney, formatSigned, humanize, type ToneText } from '../kit/format';
import { done, infoHeading, meterTone, refused, type ActionResult, type InfoLine } from './common';

/** Display names of the staff roles. */
export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = Object.freeze({
  HC: 'Head Coach', OC: 'Off. Coordinator', DC: 'Def. Coordinator', QBCoach: 'QB Coach', RBCoach: 'RB Coach', WRCoach: 'WR Coach',
  OLCoach: 'OL Coach', DBCoach: 'DB Coach', LBCoach: 'LB Coach', StrengthCoach: 'Strength Coach', Scout: 'Head Scout',
});

/** Role codes for narrow (large-text) tables. */
export const ROLE_SHORT: Readonly<Record<StaffRole, string>> = Object.freeze({
  HC: 'HC', OC: 'OC', DC: 'DC', QBCoach: 'QB', RBCoach: 'RB', WRCoach: 'WR', OLCoach: 'OL', DBCoach: 'DB', LBCoach: 'LB', StrengthCoach: 'STR', Scout: 'SCOUT',
});

/** Short rating labels in CoachRatings order. */
export const RATING_ABBR: Readonly<Record<keyof CoachRatings, string>> = Object.freeze({
  offense: 'OFF', defense: 'DEF', playerDevelopment: 'DEV', motivation: 'MOT', gameManagement: 'GM', scouting: 'SCT', conditioning: 'CON',
});

/** One staff role (filled or vacant) or one market coach. */
export interface CoachRow {
  id: string;
  role: StaffRole;
  coach: Coach | null;
  name: string;
  age: number | null;
  rating: number | null;
  traits: string;
  salary: number;
  years: number;
  /** Market rows: the coach's ask per season. */
  ask: number;
}

const coachName = (c: Coach): string => `${c.firstName} ${c.lastName}`;

const row = (league: League, role: StaffRole, c: Coach | null, id: string): CoachRow => ({
  id, role, coach: c, name: c ? coachName(c) : 'Vacant', age: c?.age ?? null, rating: c ? Math.round(roleRating(c)) : null,
  traits: c && c.traits.length > 0 ? c.traits.map(humanize).join(', ') : '-', salary: c?.salary ?? 0, years: c?.contractYears ?? 0,
  ask: c ? coachAsk(league, c) : 0,
});

/** The staff by role, head coach first; vacant roles appear as 'Vacant'. */
export const staffRows = (league: League, teamId: TeamId): CoachRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const staff = teamStaff(league, team);
  return STAFF_ROLES.map((role) => row(league, role, staff[role] ?? null, `role-${role}`));
};

/** Unattached coaches (one role or all), best role rating first. */
export const marketRows = (league: League, role: StaffRole | null = null): CoachRow[] =>
  availableCoaches(league, role ?? undefined).map((c) => row(league, c.role, c, c.id));

/** All seven ratings as one line ("OFF 70 DEF 55 ..."). */
export const ratingsLine = (c: Coach): string => (Object.keys(RATING_ABBR) as (keyof CoachRatings)[]).map((k) => `${RATING_ABBR[k]} ${c.ratings[k]}`).join(' ');

/** Detail line of a coach row. */
export const coachDetail = (r: CoachRow): ToneText => {
  const c = r.coach;
  if (!c) return { text: `${ROLE_LABELS[r.role]} is vacant: hire one from the market`, tone: 'warning' };
  const scheme = r.role === 'OC' || r.role === 'HC' ? ` · ${humanize(c.offensiveScheme)}` : r.role === 'DC' ? ` · ${humanize(c.defensiveScheme)}` : '';
  return { text: `${ratingsLine(c)}${scheme} · ${c.careerWins}-${c.careerLosses}${c.championships > 0 ? ` · ${c.championships} titles` : ''}`, tone: 'info' };
};

/** Default contract length when hiring for a role. */
export const defaultHireYears = (role: StaffRole): number => Math.min(STAFF_TUNING.maxContractYears, ROLE_PROFILES[role].contractRange[1]);

/** Lowest salary a coach accepts (minimumOfferShare of his ask, rounded up to the money step). */
export const minimumOffer = (league: League, coach: Coach): number => {
  const step = CONTRACT_DATA.moneyStep;
  return Math.ceil((coachAsk(league, coach) * STAFF_TUNING.minimumOfferShare) / step) * step;
};

/** Fire preview: dead money he would be owed. */
export const firePreview = (league: League, teamId: TeamId, coachId: CoachId): { ok: boolean; reason: string | null; deadMoney: number } => {
  const r = fireCoach(league, teamId, coachId);
  return { ok: r.ok, reason: r.reason, deadMoney: r.deadMoney };
};

/** Fires a coach (dead money booked by staff.ts). */
export const fireStaff = (league: League, teamId: TeamId, coachId: CoachId): ActionResult => {
  const c = league.coaches[coachId];
  const r = fireCoach(league, teamId, coachId);
  if (!r.ok) return refused(league, r.reason ?? 'Cannot fire');
  return done(r.league, `Fired ${c ? coachName(c) : coachId}${r.deadMoney > 0 ? ` (${formatMoney(r.deadMoney)} still owed)` : ''}`);
};

/** Hires a coach with terms, replacing the incumbent in his role when `replace`. */
export const hireStaff = (league: League, teamId: TeamId, coachId: CoachId, salary: number, years: number, replace: boolean): ActionResult => {
  const c = league.coaches[coachId];
  const r = hireCoach(league, teamId, coachId, { salary, years, replace });
  if (!r.ok) return refused(league, r.reason ?? 'Cannot hire');
  return done(r.league, `Hired ${c ? coachName(c) : coachId} as ${c ? ROLE_LABELS[c.role] : 'coach'} (fee ${formatMoney(r.cashPaid)})`);
};

/** Tops up the coach market (staff.ts coachMarket with a UI rng). */
export const refreshMarket = (league: League, rng: Rng): ActionResult => {
  const r = coachMarket(league, rng);
  return done(r.league, `${r.market.length} coaches available`);
};

/** The incumbent in a role, if any. */
export const incumbent = (league: League, teamId: TeamId, role: StaffRole): Coach | null => {
  const team = league.teams[teamId];
  return team ? teamStaff(league, team)[role] ?? null : null;
};

/** A signed percentage with one decimal ("+3.4%"), toned by sign. */
export const signedPct = (fraction: number): ToneText => {
  const v = Math.round(fraction * 1000) / 10;
  return { text: `${v > 0 ? '+' : ''}${v.toFixed(1)}%`, tone: v > 0 ? 'success' : v < 0 ? 'danger' : 'normal' };
};

const GROUP_LABELS: Readonly<Record<PositionGroup, string>> = {
  QB: 'Quarterbacks', RB: 'Running backs', WR: 'Receivers', TE: 'Tight ends', OL: 'Offensive line', DL: 'Defensive line', LB: 'Linebackers', DB: 'Secondary', ST: 'Special teams',
};

/** Staff effects and payroll as info lines. */
export const effectLines = (league: League, teamId: TeamId): InfoLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const fx = staffEffects(league, team);
  const pay = staffPayroll(league, teamId, leagueCapYear(league));
  const rating = (id: string, label: string, v: number): InfoLine => ({ id, label, value: { text: String(v), tone: meterTone(v) }, bar: { value: v, max: 99, tone: meterTone(v) } });
  return [
    infoHeading('h-dev', 'Development'),
    { id: 'devBonus', label: 'Growth bonus', value: signedPct(fx.developmentBonus) },
    rating('devRating', 'Development rating', fx.developmentRating),
    ...(Object.keys(fx.positionCoachBonus) as PositionGroup[]).map((g) => ({ id: `grp-${g}`, label: GROUP_LABELS[g], value: signedPct(fx.positionCoachBonus[g]) })),
    infoHeading('h-game', 'Game day'),
    rating('gm', 'Game management', fx.gameManagement),
    rating('mot', 'Motivation', fx.motivation),
    rating('con', 'Conditioning', fx.conditioning),
    { id: 'inj', label: 'Injury recovery', value: { text: `${(fx.injuryRecoveryBonus * 100).toFixed(1)}% faster`, tone: fx.injuryRecoveryBonus > 0 ? 'success' : 'dim' } },
    { id: 'scout', label: 'Scouting points', value: { text: formatSigned(fx.scoutingBonus), tone: fx.scoutingBonus >= 0 ? 'success' : 'danger' } },
    infoHeading('h-pay', 'Payroll'),
    { id: 'payActive', label: 'Staff salaries', value: formatMoney(pay.active) },
    { id: 'payDead', label: 'Owed to fired coaches', value: pay.dead > 0 ? { text: formatMoney(pay.dead), tone: 'warning' } : { text: '-', tone: 'dim' } },
    { id: 'payTotal', label: 'Total this season', value: { text: formatMoney(pay.total), tone: 'accent' } },
    { id: 'turnover', label: 'Contract years', value: { text: turnoverPending(league) ? 'Count the finished season until turnover' : 'Count from this season', tone: 'dim' } },
  ];
};
