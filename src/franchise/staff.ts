/**
 * Coaching staff: what the staff does for a team (staffEffects), the coach market, hiring and firing
 * (salaries, contract years, dead money), payroll for the finances, the yearly staff turnover (aging,
 * retirement, expiring deals, AI firings and hires), head-coach playoff records and the Coach of the Year
 * inputs.
 *
 * Contract convention: Coach.contractYears counts the seasons left INCLUDING the current league year until
 * the offseason's staff turnover (advanceStaffYear, once per offseason: ClubState.staffYear) decrements it;
 * from then on it counts from next season. So between the end of the season (awards phase) and the turnover
 * the finished season is still counted: a hire in that window is stored with one extra year (the turnover
 * takes it off) and a firing owes only the seasons after the finished one (turnoverPending). Firing a coach
 * owes STAFF_TUNING.fireGuaranteeShare of the remaining salary, spread evenly over the remaining years in
 * ClubState.staffDeadMoney and paid weekly with the payroll.
 * Regular-season career wins/losses and championships are credited by history.ts (finalizeSeason /
 * crownChampion); the playoff ledger, the live coach record and the Coach of the Year inputs live in
 * rivalries.ts (club ledgers) and are re-exported here. Pure.
 */
import type { CoachId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp, mean } from '@/core/math';
import { adjustMorale } from '@/players/personality';
import { createNamePool } from '@/players/names';
import { POSITION_GROUP, type Player, type Position, type PositionGroup } from '@/players/types';
import { ROLE_PROFILES, STAFF_ROLES, coachSalary, generateCoach, roleRating } from '@/teams/coach-generator';
import type { Coach, CoachRatings, StaffRole, Team } from '@/teams/types';
import { OFFSEASON_PHASES, leagueCapYear, roundMoney } from './contracts';
import { economyScale, formatMoney } from './facilities';
import { ensureClub, withClub } from './rivalries';
export { coachOfYearInputs, coachRecord, recordCoachPlayoffResults, type CoachOfYearInput, type CoachRecord } from './rivalries';
import { winPct } from './standings';
import type { League } from './types';

/** Staff tuning. */
export const STAFF_TUNING = Object.freeze({
  /** Rating assumed for a vacant role. */
  replacementRating: 35,
  developmentBonusRange: 0.12,
  positionBonusRange: 0.1,
  injuryRecoveryMax: 0.15,
  scoutingPointsRange: 20,
  traitBonus: 5,
  /** One-off hiring fee as a share of the first-year salary, paid in cash. */
  hiringFeeShare: 0.1,
  /** Offers below this share of the coach's ask are refused. */
  minimumOfferShare: 0.9,
  maxContractYears: 5,
  /** Share of the remaining salary still owed after a firing. */
  fireGuaranteeShare: 0.6,
  retirementAge: 62,
  retirementBase: 0.12,
  retirementPerYear: 0.08,
  forcedRetirementAge: 76,
  /** Available coaches kept on the market per role (HC/OC/DC get more). */
  marketSize: { HC: 6, OC: 4, DC: 4, other: 3 } as const,
  /** AI teams release expiring coaches below this role rating. */
  aiRenewRating: 55,
  /** AI teams fire a head coach after a season below this win% ... */
  aiFireWinPct: 0.3,
  /** ... or when owner confidence drops below this. */
  aiFireConfidence: 28,
});

/** What a team's staff does for it. Fractions are added to 1 by consumers; ratings are 1..99. */
export interface StaffEffects {
  /** Growth bonus for every player (about -0.12..+0.12). */
  developmentBonus: number;
  /** Staff development rating 1..99 (progressPlayer ctx.coachDevelopment when no position is known). */
  developmentRating: number;
  /** Share of injury weeks saved by the strength/conditioning staff (0..0.15). */
  injuryRecoveryBonus: number;
  /** Extra draft scouting points (about -20..+20). */
  scoutingBonus: number;
  /** Head coach game management 1..99 (4th downs, clock, challenges). */
  gameManagement: number;
  /** Staff motivation 1..99 (scales morale swings). */
  motivation: number;
  /** Staff conditioning 1..99 (fatigue recovery). */
  conditioning: number;
  /** Growth bonus per position group from its position coach and coordinator (about -0.1..+0.1). */
  positionCoachBonus: Record<PositionGroup, number>;
}

const GROUP_COACHES: Readonly<Record<PositionGroup, readonly (readonly [StaffRole, number])[]>> = {
  QB: [['QBCoach', 0.6], ['OC', 0.4]],
  RB: [['RBCoach', 0.6], ['OC', 0.4]],
  WR: [['WRCoach', 0.6], ['OC', 0.4]],
  TE: [['WRCoach', 0.3], ['OLCoach', 0.3], ['OC', 0.4]],
  OL: [['OLCoach', 0.6], ['OC', 0.4]],
  DL: [['LBCoach', 0.3], ['DC', 0.7]],
  LB: [['LBCoach', 0.6], ['DC', 0.4]],
  DB: [['DBCoach', 0.6], ['DC', 0.4]],
  ST: [['HC', 0.5], ['StrengthCoach', 0.5]],
};
const POSITION_COACHES: readonly StaffRole[] = ['QBCoach', 'RBCoach', 'WRCoach', 'OLCoach', 'DBCoach', 'LBCoach'];
const GROUPS = Object.keys(GROUP_COACHES) as PositionGroup[];

/** Result of a staff move; the League is unchanged when `ok` is false. */
export interface StaffResult {
  ok: boolean;
  reason: string | null;
  league: League;
  /** Cash paid now (hiring fee). */
  cashPaid: number;
  /** Total dead money created (firing). */
  deadMoney: number;
}

const fail = (league: League, reason: string): StaffResult => ({ ok: false, reason, league, cashPaid: 0, deadMoney: 0 });
const r99 = (v: number): number => clamp(Math.round(v), 1, 99);

/** The team's coach in each role (the head coach from headCoachId first; the best-rated one when a role is doubled). */
export const teamStaff = (league: Pick<League, 'coaches'>, team: Pick<Team, 'id' | 'staffIds' | 'headCoachId'>): Partial<Record<StaffRole, Coach>> => {
  const out: Partial<Record<StaffRole, Coach>> = {};
  for (const id of team.staffIds) {
    const c = league.coaches[id];
    if (!c || c.teamId !== team.id) continue;
    const held = out[c.role];
    if (!held || roleRating(c) > roleRating(held)) out[c.role] = c;
  }
  const hc = team.headCoachId ? league.coaches[team.headCoachId] : undefined;
  if (hc && hc.teamId === team.id) out.HC = hc;
  return out;
};

const ratingOf = (staff: Partial<Record<StaffRole, Coach>>, role: StaffRole, key: keyof CoachRatings): number =>
  staff[role]?.ratings[key] ?? STAFF_TUNING.replacementRating;
const hasTrait = (staff: Partial<Record<StaffRole, Coach>>, role: StaffRole, trait: Coach['traits'][number]): boolean =>
  staff[role]?.traits.includes(trait) ?? false;

const groupRating = (staff: Partial<Record<StaffRole, Coach>>, group: PositionGroup): number =>
  GROUP_COACHES[group].reduce((s, [role, w]) => s + w * ratingOf(staff, role, 'playerDevelopment'), 0);

/** Staff effects of a team from its coaches' ratings and traits (vacant roles count as replacement level). */
export const staffEffects = (league: Pick<League, 'coaches'>, team: Pick<Team, 'id' | 'staffIds' | 'headCoachId'>): StaffEffects => {
  const T = STAFF_TUNING;
  const staff = teamStaff(league, team);
  const developer = hasTrait(staff, 'HC', 'developer') ? T.traitBonus : 0;
  const developmentRating = r99(
    0.3 * ratingOf(staff, 'HC', 'playerDevelopment') + 0.2 * mean([ratingOf(staff, 'OC', 'playerDevelopment'), ratingOf(staff, 'DC', 'playerDevelopment')])
    + 0.5 * mean(POSITION_COACHES.map((r) => ratingOf(staff, r, 'playerDevelopment'))) + developer,
  );
  const positionCoachBonus = {} as Record<PositionGroup, number>;
  for (const g of GROUPS) positionCoachBonus[g] = ((clamp(groupRating(staff, g) + developer, 1, 99) - 50) / 49) * T.positionBonusRange;
  const conditioning = r99(0.7 * ratingOf(staff, 'StrengthCoach', 'conditioning') + 0.3 * ratingOf(staff, 'HC', 'conditioning'));
  return {
    developmentBonus: ((developmentRating - 50) / 49) * T.developmentBonusRange,
    developmentRating,
    injuryRecoveryBonus: clamp((conditioning - 40) / 59, 0, 1) * T.injuryRecoveryMax,
    scoutingBonus: Math.round(((0.8 * ratingOf(staff, 'Scout', 'scouting') + 0.2 * ratingOf(staff, 'HC', 'scouting') - 50) / 49) * T.scoutingPointsRange),
    gameManagement: r99(ratingOf(staff, 'HC', 'gameManagement') + (hasTrait(staff, 'HC', 'clockManager') ? T.traitBonus : 0)),
    motivation: r99(0.75 * ratingOf(staff, 'HC', 'motivation') + 0.25 * ratingOf(staff, 'StrengthCoach', 'motivation')
      + (hasTrait(staff, 'HC', 'motivator') ? T.traitBonus : 0) + (hasTrait(staff, 'HC', 'playersCoach') ? 2 : 0)),
    conditioning,
    positionCoachBonus,
  };
};

/** Coach development rating 1..99 for one player's position (progressPlayer ctx.coachDevelopment). */
export const coachDevelopmentFor = (league: Pick<League, 'coaches'>, team: Pick<Team, 'id' | 'staffIds' | 'headCoachId'>, position: Position): number => {
  const staff = teamStaff(league, team);
  const developer = hasTrait(staff, 'HC', 'developer') ? STAFF_TUNING.traitBonus : 0;
  return r99(0.75 * groupRating(staff, POSITION_GROUP[position]) + 0.25 * ratingOf(staff, 'HC', 'playerDevelopment') + developer);
};

/* ------------------------------------------------------------------ money */

/** What a coach asks per season at the league's money scale (titles add up to 30%). */
export const coachAsk = (league: Pick<League, 'settings'>, coach: Pick<Coach, 'role' | 'ratings' | 'championships'>): number =>
  roundMoney(coachSalary(coach.role, coach.ratings) * (1 + Math.min(0.3, 0.05 * coach.championships)) * economyScale(league.settings));

/** A team's staff payroll for a season: active salaries plus dead money owed to fired coaches. */
export const staffPayroll = (league: League, teamId: TeamId, year = leagueCapYear(league)): { active: number; dead: number; total: number } => {
  const team = league.teams[teamId];
  if (!team) return { active: 0, dead: 0, total: 0 };
  const seen = new Set<CoachId>();
  let active = 0;
  for (const id of [...team.staffIds, ...(team.headCoachId ? [team.headCoachId] : [])]) {
    const c = league.coaches[id];
    if (!c || c.teamId !== teamId || seen.has(id)) continue;
    seen.add(id);
    active += c.salary;
  }
  const dead = ensureClub(league).staffDeadMoney[teamId]?.[year] ?? 0;
  return { active, dead, total: active + dead };
};

/* ------------------------------------------------------------------ market */

/** Coach ids still referenced by events or awards (they are never deleted). */
export const referencedCoachIds = (league: League): Set<string> => {
  const out = new Set<string>();
  for (const e of league.events) if (e.coachId) out.add(e.coachId);
  for (const a of league.season.awards) if (a.coachId) out.add(a.coachId);
  for (const h of league.history) for (const a of h.awards) if (a.coachId) out.add(a.coachId);
  return out;
};

/** Unattached, non-retired coaches, best role rating first (optionally one role). */
export const availableCoaches = (league: League, role?: StaffRole): Coach[] => {
  const retired = new Set(ensureClub(league).retiredCoachIds);
  return Object.values(league.coaches)
    .filter((c) => c.teamId === null && !retired.has(c.id) && (role === undefined || c.role === role))
    .sort((a, b) => roleRating(b) - roleRating(a) || (a.id < b.id ? -1 : 1));
};

const marketTarget = (role: StaffRole): number => {
  const m = STAFF_TUNING.marketSize;
  return role === 'HC' ? m.HC : role === 'OC' ? m.OC : role === 'DC' ? m.DC : m.other;
};

/** True when some role has fewer available coaches than the market keeps (e.g. only a coach just fired). */
export const marketThin = (league: League): boolean => STAFF_ROLES.some((role) => availableCoaches(league, role).length < marketTarget(role));

/** Cash fee for hiring a coach at `salary` (a share of the first-year salary, money-rounded). */
export const hiringFee = (salary: number): number => roundMoney(salary * STAFF_TUNING.hiringFeeShare);

/**
 * Refreshes the coach market: every role is topped up to its target with newly generated coaches (asking
 * the league-scale salary) and trimmed to twice the target by releasing the weakest unreferenced ones.
 * Returns the League and the market (every available coach).
 */
export const coachMarket = (league: League, rng: Rng): { league: League; market: Coach[] } => {
  const names = createNamePool();
  const coaches = { ...league.coaches };
  const referenced = referencedCoachIds(league);
  for (const role of STAFF_ROLES) {
    const roleRng = rng.fork(`coach-market:${role}`);
    const pool = availableCoaches({ ...league, coaches }, role);
    for (let i = pool.length; i < marketTarget(role); i++) {
      let c = generateCoach(roleRng, role, { names, quality: roleRng.range(0.15, 0.9) });
      for (let tries = 0; coaches[c.id] && tries < 5; tries++) c = generateCoach(roleRng, role, { names, quality: roleRng.range(0.15, 0.9) });
      if (coaches[c.id]) continue;
      coaches[c.id] = { ...c, salary: coachAsk(league, c), contractYears: 0 };
    }
    const excess = pool.slice(marketTarget(role) * 2).filter((c) => !referenced.has(c.id));
    for (const c of excess) delete coaches[c.id];
  }
  const next = { ...league, coaches };
  return { league: next, market: availableCoaches(next) };
};

/* ------------------------------------------------------------ hire / fire */

const withoutCoach = (team: Team, coachId: CoachId): Team => ({
  ...team,
  staffIds: team.staffIds.filter((id) => id !== coachId),
  headCoachId: team.headCoachId === coachId ? null : team.headCoachId,
});

/** Every rostered player's morale after a head-coaching change. */
const coachChangeMorale = (league: League, team: Team): League['players'] => {
  const players = { ...league.players };
  for (const id of team.rosterIds) {
    const p = players[id];
    if (p) players[id] = { ...p, morale: adjustMorale(p, { type: 'coachChange' }) } as Player;
  }
  return players;
};

/** True between the end of the season and this offseason's staff turnover (contractYears still count the finished season). */
export const turnoverPending = (league: Pick<League, 'season' | 'club'>): boolean =>
  (league.season.phase === 'awards' || OFFSEASON_PHASES.includes(league.season.phase)) && ensureClub(league).staffYear !== league.season.year;

/**
 * Fires a coach: he leaves the team (head coach cleared), becomes available, and the team owes
 * fireGuaranteeShare of his remaining salary as staff dead money spread over his remaining years.
 * A head-coach firing unsettles the roster (coachChange morale).
 */
export const fireCoach = (league: League, teamId: TeamId, coachId: CoachId): StaffResult => {
  const team = league.teams[teamId];
  const coach = league.coaches[coachId];
  if (!team) return fail(league, `Unknown team ${teamId}`);
  if (!coach || coach.teamId !== teamId) return fail(league, 'That coach is not on this staff');
  const pending = turnoverPending(league);
  // Seasons still owed after this one; a deal ending with the finished season owes nothing.
  const years = pending ? Math.max(0, coach.contractYears - 1) : Math.max(1, coach.contractYears);
  const total = roundMoney(coach.salary * years * STAFF_TUNING.fireGuaranteeShare);
  const perYear = years > 0 ? roundMoney(total / years) : 0;
  const club = ensureClub(league);
  const owed = { ...(club.staffDeadMoney[teamId] ?? {}) };
  const start = pending ? league.season.year + 1 : leagueCapYear(league);
  for (let y = start; y < start + years; y++) owed[y] = (owed[y] ?? 0) + perYear;
  const nextTeam = withoutCoach(team, coachId);
  const base: League = {
    ...league,
    teams: { ...league.teams, [teamId]: nextTeam },
    coaches: { ...league.coaches, [coachId]: { ...coach, teamId: null, contractYears: 0 } },
  };
  const moved = coach.role === 'HC' ? { ...base, players: coachChangeMorale(base, nextTeam) } : base;
  return { ok: true, reason: null, league: withClub(moved, { staffDeadMoney: { ...club.staffDeadMoney, [teamId]: owed } }), cashPaid: 0, deadMoney: perYear * years };
};

/** Terms for hireCoach; defaults are the coach's ask and the role's longest standard deal. */
export interface HireTerms {
  salary?: number;
  years?: number;
  /** Fire the incumbent in the same role first (dead money applies). */
  replace?: boolean;
}

/**
 * Hires an available coach. Refused for unknown/attached/retired coaches, an occupied role (unless
 * `replace`), offers under minimumOfferShare of the ask, contract lengths outside 1..maxContractYears and
 * teams that cannot pay the hiring fee in cash. A new head coach resets the players' coach relationship.
 */
export const hireCoach = (league: League, teamId: TeamId, coachId: CoachId, terms: HireTerms = {}): StaffResult => {
  const T = STAFF_TUNING;
  const coach = league.coaches[coachId];
  if (!league.teams[teamId]) return fail(league, `Unknown team ${teamId}`);
  if (!coach) return fail(league, `Unknown coach ${coachId}`);
  if (coach.teamId !== null) return fail(league, `${coach.firstName} ${coach.lastName} is under contract elsewhere`);
  if (ensureClub(league).retiredCoachIds.includes(coachId)) return fail(league, `${coach.firstName} ${coach.lastName} has retired`);
  let work = league;
  const incumbent = teamStaff(league, league.teams[teamId] as Team)[coach.role];
  const ask = coachAsk(league, coach);
  const salary = roundMoney(terms.salary ?? ask);
  const years = terms.years ?? ROLE_PROFILES[coach.role].contractRange[1];
  if (salary < ask * T.minimumOfferShare) return fail(league, `${coach.lastName} wants at least ${formatMoney(ask * T.minimumOfferShare)} per season`);
  if (!Number.isInteger(years) || years < 1 || years > T.maxContractYears) return fail(league, `Contract length must be 1-${T.maxContractYears} years`);
  const fee = hiringFee(salary);
  if ((league.teams[teamId] as Team).finances.cash < fee) return fail(league, 'Not enough cash to pay the hiring fee');
  let dead = 0;
  if (incumbent) {
    if (!terms.replace) return fail(league, `The ${coach.role} job is filled; fire ${incumbent.lastName} first`);
    const fired = fireCoach(league, teamId, incumbent.id);
    work = fired.league;
    dead = fired.deadMoney;
  }
  const team = work.teams[teamId] as Team;
  const nextTeam: Team = {
    ...team,
    staffIds: team.staffIds.includes(coachId) ? team.staffIds : [...team.staffIds, coachId],
    headCoachId: coach.role === 'HC' ? coachId : team.headCoachId,
    finances: { ...team.finances, cash: team.finances.cash - fee },
  };
  const hired: League = {
    ...work,
    teams: { ...work.teams, [teamId]: nextTeam },
    // Before the turnover the stored length also counts the finished season, which the turnover takes off.
    coaches: { ...work.coaches, [coachId]: { ...coach, teamId, salary, contractYears: years + (turnoverPending(work) ? 1 : 0) } },
  };
  const out = coach.role === 'HC' && !incumbent ? { ...hired, players: coachChangeMorale(hired, nextTeam) } : hired;
  return { ok: true, reason: null, league: out, cashPaid: fee, deadMoney: dead };
};

/* --------------------------------------------------------- yearly turnover */

/** What happened in one offseason's staff turnover. */
export interface StaffYearReport {
  retired: CoachId[];
  released: CoachId[];
  renewed: CoachId[];
  fired: CoachId[];
  hired: { teamId: TeamId; coachId: CoachId }[];
}

/** Chance a coach of this age retires this offseason. */
export const retirementChance = (age: number): number => {
  const T = STAFF_TUNING;
  if (age >= T.forcedRetirementAge) return 1;
  return age < T.retirementAge ? 0 : clamp(T.retirementBase + T.retirementPerYear * (age - T.retirementAge), 0, 1);
};

const isAi = (league: League, team: Team): boolean => !team.isUserControlled && team.id !== league.userTeamId;

/**
 * One offseason of staff turnover (call once per year, in the offseason): coaches age; old coaches may
 * retire (kept only when events/awards reference them); contract years tick down and expiring deals are
 * renewed (user team and good AI coaches) or released; AI owners fire failing head coaches; the market is
 * refreshed and AI teams fill every vacancy with the best coach they can pay. Records the season in
 * ClubState.staffYear (events.ts closeClubSeason and retirement.ts runCoachCarousel skip a season already done).
 */
export const advanceStaffYear = (league: League, rng: Rng): { league: League; report: StaffYearReport } => {
  const report: StaffYearReport = { retired: [], released: [], renewed: [], fired: [], hired: [] };
  const club = ensureClub(league);
  const referenced = referencedCoachIds(league);
  const teams = { ...league.teams };
  const coaches: Record<CoachId, Coach> = {};
  const retiredIds = new Set(club.retiredCoachIds);
  const turnRng = rng.fork('staff-year');
  for (const c0 of Object.values(league.coaches)) {
    if (retiredIds.has(c0.id)) {
      coaches[c0.id] = c0;
      continue;
    }
    const c: Coach = { ...c0, age: c0.age + 1, contractYears: c0.teamId ? c0.contractYears - 1 : c0.contractYears };
    if (turnRng.chance(retirementChance(c.age))) {
      report.retired.push(c.id);
      const team = c.teamId ? teams[c.teamId] : undefined;
      if (team) teams[team.id] = withoutCoach(team, c.id);
      if (referenced.has(c.id)) {
        coaches[c.id] = { ...c, teamId: null, contractYears: 0 };
        retiredIds.add(c.id);
      }
      continue;
    }
    const team = c.teamId ? teams[c.teamId] : undefined;
    if (team && c.contractYears <= 0) {
      const keep = !isAi(league, team) || roleRating(c) >= STAFF_TUNING.aiRenewRating;
      if (keep) {
        report.renewed.push(c.id);
        coaches[c.id] = { ...c, salary: Math.max(c.salary, coachAsk(league, c)), contractYears: turnRng.int(ROLE_PROFILES[c.role].contractRange[0], ROLE_PROFILES[c.role].contractRange[1]) };
      } else {
        report.released.push(c.id);
        teams[team.id] = withoutCoach(team, c.id);
        coaches[c.id] = { ...c, teamId: null, contractYears: 0 };
      }
      continue;
    }
    coaches[c.id] = c;
  }
  // Contracts now count from next season: firings and hires below must not treat the turnover as pending.
  let work: League = withClub({ ...league, teams, coaches }, { retiredCoachIds: [...retiredIds], staffYear: league.season.year });
  for (const team of Object.values(work.teams)) {
    if (!isAi(work, team) || !team.headCoachId) continue;
    const st = work.season.standings[team.id];
    const pct = st ? winPct(st) : 0.5;
    const confidence = club.ownerConfidence[team.id] ?? 60;
    if (st && (pct < STAFF_TUNING.aiFireWinPct || confidence < STAFF_TUNING.aiFireConfidence)) {
      const fired = fireCoach(work, team.id, team.headCoachId);
      if (fired.ok) {
        report.fired.push(team.headCoachId);
        work = fired.league;
      }
    }
  }
  work = coachMarket(work, rng.fork('staff-market')).league;
  for (const team of Object.values(work.teams)) {
    if (!isAi(work, team)) continue;
    for (const role of STAFF_ROLES) {
      const current = work.teams[team.id] as Team;
      if (teamStaff(work, current)[role]) continue;
      const choice = availableCoaches(work, role).find((c) => current.finances.cash >= hiringFee(coachAsk(work, c)));
      if (!choice) continue;
      const hired = hireCoach(work, team.id, choice.id, { years: ROLE_PROFILES[role].contractRange[0] + 1 });
      if (hired.ok) {
        work = hired.league;
        report.hired.push({ teamId: team.id, coachId: choice.id });
      }
    }
  }
  return { league: work, report };
};
