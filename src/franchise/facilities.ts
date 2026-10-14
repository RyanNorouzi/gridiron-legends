/**
 * Team facilities (levels 1..5): upgrade costs, maintenance and the effects other modules consume.
 *
 *   training     -> devMultiplier on every player's growth
 *   development  -> youngGrowthMultiplier for players up to youngMaxAge
 *   medical      -> fewer weeks out (injuryWeeksMultiplier) and fewer injuries (injuryChanceMultiplier), applied to
 *                   game injuries by week.ts and to camp injuries by training-camp.ts (treatedInjuryWeeks)
 *   scouting     -> extra draft scouting points
 *   stadium      -> capacity and atmosphere (applied to the Stadium record when the upgrade is built)
 *   analytics    -> scouting accuracy (report confidence), a small game-plan bonus, advanced stats unlocked
 *
 * Upgrades are built in the offseason phases, one level per offseason (two when the club is rich), paid in
 * cash. Money figures in src/data/facilities.json are authored against CONTRACT_DATA.referenceCap and scale
 * with the league's salary cap (economyScale). Pure: functions return new objects.
 */
import facilitiesJson from '@/data/facilities.json';
import type { TeamId } from '@/core/ids';
import { clamp } from '@/core/math';
import type { Player } from '@/players/types';
import type { Facilities, FacilityType, Stadium, Team } from '@/teams/types';
import { CONTRACT_DATA, OFFSEASON_PHASES, jsonArray, jsonNumber, jsonObject, leagueCapYear, roundMoney } from './contracts';
import { ensureClub, withClub } from './rivalries';
import type { League, LeagueSettings } from './types';

/** Every facility type, in display order. */
export const FACILITY_TYPES: readonly FacilityType[] = ['training', 'medical', 'scouting', 'stadium', 'development', 'analytics'];

/** One facility's data: label, costs to reach the next level (index = current level - 1), maintenance per level. */
export interface FacilityDefinition {
  label: string;
  upgradeCosts: number[];
  maintenance: number[];
  effects: Record<string, number[]>;
}

/** Validated facilities.json. */
export interface FacilityData {
  maxLevel: number;
  rules: { upgradesPerOffseason: number; richUpgradesPerOffseason: number; richCashThreshold: number; aiCashReserve: number };
  facilities: Record<FacilityType, FacilityDefinition>;
  youngMaxAge: number;
  advancedStatsLevel: number;
  aiPriority: FacilityType[];
}

const FILE = 'facilities.json';
const REQUIRED_EFFECTS: Record<FacilityType, readonly string[]> = {
  training: ['devMultiplier'],
  medical: ['injuryWeeksMultiplier', 'injuryChanceMultiplier'],
  scouting: ['scoutingPoints'],
  stadium: ['capacityPct', 'atmosphere'],
  development: ['youngGrowthMultiplier'],
  analytics: ['scoutingAccuracy', 'gameplanBonus'],
};

const numberList = (v: unknown, path: string, length: number): number[] => {
  const list = jsonArray(v, FILE, path);
  if (list.length !== length) throw new Error(`${FILE}: ${path} must have ${length} entries, got ${list.length}`);
  return list.map((x, i) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error(`${FILE}: ${path}[${i}] must be a non-negative number`);
    return x;
  });
};

/** Validates facilities.json; throws a descriptive error on any problem. */
export const validateFacilityData = (raw: unknown): FacilityData => {
  const o = jsonObject(raw, FILE, '$');
  const maxLevel = jsonNumber(o, 'maxLevel', FILE, '$', 2, 10);
  const r = jsonObject(o.rules, FILE, '$.rules');
  const fac = jsonObject(o.facilities, FILE, '$.facilities');
  const facilities = {} as Record<FacilityType, FacilityDefinition>;
  for (const type of FACILITY_TYPES) {
    const p = `$.facilities.${type}`;
    const f = jsonObject(fac[type], FILE, p);
    if (typeof f.label !== 'string' || !f.label) throw new Error(`${FILE}: ${p}.label must be a non-empty string`);
    const e = jsonObject(f.effects, FILE, `${p}.effects`);
    const effects: Record<string, number[]> = {};
    for (const key of REQUIRED_EFFECTS[type]) effects[key] = numberList(e[key], `${p}.effects.${key}`, maxLevel);
    const upgradeCosts = numberList(f.upgradeCosts, `${p}.upgradeCosts`, maxLevel - 1);
    const maintenance = numberList(f.maintenance, `${p}.maintenance`, maxLevel);
    facilities[type] = { label: f.label, upgradeCosts, maintenance, effects };
  }
  const aiPriority = jsonArray(o.aiPriority, FILE, '$.aiPriority').map((t, i) => {
    if (!FACILITY_TYPES.includes(t as FacilityType)) throw new Error(`${FILE}: $.aiPriority[${i}] is not a facility type`);
    return t as FacilityType;
  });
  return {
    maxLevel,
    rules: {
      upgradesPerOffseason: jsonNumber(r, 'upgradesPerOffseason', FILE, '$.rules', 1, 5),
      richUpgradesPerOffseason: jsonNumber(r, 'richUpgradesPerOffseason', FILE, '$.rules', 1, 10),
      richCashThreshold: jsonNumber(r, 'richCashThreshold', FILE, '$.rules', 0),
      aiCashReserve: jsonNumber(r, 'aiCashReserve', FILE, '$.rules', 0),
    },
    facilities,
    youngMaxAge: jsonNumber(o, 'youngMaxAge', FILE, '$', 18, 40),
    advancedStatsLevel: jsonNumber(o, 'advancedStatsLevel', FILE, '$', 1, maxLevel),
    aiPriority,
  };
};

/** Validated facility data. */
export const FACILITY_DATA: FacilityData = validateFacilityData(facilitiesJson);

/** A money amount for event text: $1.2M, $850K, $900. */
export const formatMoney = (amount: number): string => {
  const a = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1_000)}K`;
  return `${sign}$${Math.round(a)}`;
};

/** Money scale of the club data files: league cap over the cap they were authored against. */
export const economyScale = (settings: Pick<LeagueSettings, 'salaryCap'>): number => settings.salaryCap / CONTRACT_DATA.referenceCap;

/** A facility level clamped to 1..maxLevel. */
export const facilityLevel = (facilities: Facilities, type: FacilityType): number =>
  clamp(Math.round(facilities[type] ?? 1), 1, FACILITY_DATA.maxLevel);

const effectAt = (type: FacilityType, key: string, level: number): number =>
  FACILITY_DATA.facilities[type].effects[key]?.[clamp(Math.round(level), 1, FACILITY_DATA.maxLevel) - 1] ?? 0;

/** Everything a team's facilities do, read by development, injuries, scouting, finances and the game setup. */
export interface FacilityEffects {
  /** training: multiplier on every player's growth. */
  devMultiplier: number;
  /** development: extra multiplier on growth for players aged youngMaxAge or less. */
  youngGrowthMultiplier: number;
  youngMaxAge: number;
  /** medical: multiplier on weeks out. */
  injuryWeeksMultiplier: number;
  /** medical: multiplier on the chance of getting hurt. */
  injuryChanceMultiplier: number;
  /** scouting: extra scouting points per draft class. */
  scoutingPoints: number;
  /** stadium: capacity bonus share over the base stadium (already built into Stadium.capacity by upgrades). */
  capacityPct: number;
  /** stadium: atmosphere bonus (already built into Stadium.atmosphere by upgrades). */
  atmosphereBonus: number;
  /** analytics: added to scouting-report confidence (0..1 scale). */
  scoutingAccuracy: number;
  /** analytics: small game-plan edge (fraction). */
  gameplanBonus: number;
  /** analytics: advanced stats pages unlocked. */
  advancedStats: boolean;
}

/** The effects of a team's current facility levels. */
export const facilityEffects = (team: Pick<Team, 'facilities'>): FacilityEffects => {
  const lv = (t: FacilityType): number => facilityLevel(team.facilities, t);
  return {
    devMultiplier: effectAt('training', 'devMultiplier', lv('training')),
    youngGrowthMultiplier: effectAt('development', 'youngGrowthMultiplier', lv('development')),
    youngMaxAge: FACILITY_DATA.youngMaxAge,
    injuryWeeksMultiplier: effectAt('medical', 'injuryWeeksMultiplier', lv('medical')),
    injuryChanceMultiplier: effectAt('medical', 'injuryChanceMultiplier', lv('medical')),
    scoutingPoints: effectAt('scouting', 'scoutingPoints', lv('scouting')),
    capacityPct: effectAt('stadium', 'capacityPct', lv('stadium')),
    atmosphereBonus: effectAt('stadium', 'atmosphere', lv('stadium')),
    scoutingAccuracy: effectAt('analytics', 'scoutingAccuracy', lv('analytics')),
    gameplanBonus: effectAt('analytics', 'gameplanBonus', lv('analytics')),
    advancedStats: lv('analytics') >= FACILITY_DATA.advancedStatsLevel,
  };
};

/**
 * Facility level to feed players/development progressPlayer (1..5): young players lean on the development
 * center, veterans on the training complex.
 */
export const progressionFacilityLevel = (team: Pick<Team, 'facilities'>, player: Pick<Player, 'age'>): number => {
  const training = facilityLevel(team.facilities, 'training');
  const development = facilityLevel(team.facilities, 'development');
  return player.age <= FACILITY_DATA.youngMaxAge ? (training + 2 * development) / 3 : training;
};

/** Combined facility growth multiplier for one player (training, plus development for the young). */
export const facilityGrowthMultiplier = (team: Pick<Team, 'facilities'>, player: Pick<Player, 'age'>): number => {
  const fx = facilityEffects(team);
  return fx.devMultiplier * (player.age <= fx.youngMaxAge ? fx.youngGrowthMultiplier : 1);
};

/** Weeks out after the medical staff's work (at least 1 for any real injury). */
export const medicalInjuryWeeks = (team: Pick<Team, 'facilities'>, weeks: number): number =>
  weeks <= 0 ? 0 : Math.max(1, Math.round(weeks * facilityEffects(team).injuryWeeksMultiplier));

/**
 * Weeks out after treatment: the medical center's injuryWeeksMultiplier and the strength/conditioning staff's
 * recovery share (staff.ts StaffEffects.injuryRecoveryBonus, 0..0.15). At least 1 week for any real injury.
 */
export const treatedInjuryWeeks = (team: Pick<Team, 'facilities'>, weeks: number, staffRecoveryBonus = 0): number =>
  weeks <= 0 ? 0 : Math.max(1, Math.round(weeks * facilityEffects(team).injuryWeeksMultiplier * (1 - clamp(staffRecoveryBonus, 0, 0.5))));

/** Cost (dollars at the league's scale) to take a facility from `level` to level + 1; null at the top level. */
export const upgradeCost = (type: FacilityType, level: number, scale = 1): number | null => {
  const l = clamp(Math.round(level), 1, FACILITY_DATA.maxLevel);
  if (l >= FACILITY_DATA.maxLevel) return null;
  const base = FACILITY_DATA.facilities[type].upgradeCosts[l - 1];
  return base === undefined ? null : roundMoney(base * scale);
};

/** Per-season maintenance of one facility at a level (dollars at the league's scale). */
export const facilityMaintenance = (type: FacilityType, level: number, scale = 1): number =>
  roundMoney((FACILITY_DATA.facilities[type].maintenance[clamp(Math.round(level), 1, FACILITY_DATA.maxLevel) - 1] ?? 0) * scale);

/** Per-season maintenance of all of a team's facilities. */
export const maintenanceCost = (team: Pick<Team, 'facilities'>, scale = 1): number =>
  FACILITY_TYPES.reduce((s, t) => s + facilityMaintenance(t, facilityLevel(team.facilities, t), scale), 0);

/** Upgrade eligibility, with the reason when refused. */
export interface UpgradeCheck {
  ok: boolean;
  reason: string | null;
  cost: number | null;
}

/** Result of upgradeFacility: the League is unchanged when `ok` is false. */
export interface FacilityUpgradeResult extends UpgradeCheck {
  league: League;
  newLevel: number;
}

/** Upgrades already bought this offseason (the offseason is keyed by the cap year). */
export const upgradesThisOffseason = (league: League, teamId: TeamId): number => {
  const entry = ensureClub(league).facilityUpgrades[teamId];
  return entry && entry.year === leagueCapYear(league) ? entry.count : 0;
};

/**
 * Whether a team may upgrade a facility now: offseason phases only, below the top level, one upgrade per
 * offseason (richUpgradesPerOffseason while cash after the purchase stays above the rich threshold), and
 * enough cash to pay without dropping below zero.
 */
export const canUpgradeFacility = (league: League, teamId: TeamId, type: FacilityType): UpgradeCheck => {
  const team = league.teams[teamId];
  if (!team) return { ok: false, reason: `Unknown team ${teamId}`, cost: null };
  if (!FACILITY_TYPES.includes(type)) return { ok: false, reason: `Unknown facility ${String(type)}`, cost: null };
  const scale = economyScale(league.settings);
  const level = facilityLevel(team.facilities, type);
  const cost = upgradeCost(type, level, scale);
  if (cost === null) return { ok: false, reason: `${FACILITY_DATA.facilities[type].label} is already at the top level`, cost: null };
  if (!OFFSEASON_PHASES.includes(league.season.phase)) return { ok: false, reason: 'Facilities can only be upgraded during the offseason', cost };
  if (team.finances.cash < cost) return { ok: false, reason: `Not enough cash: the upgrade costs ${formatMoney(cost)}`, cost };
  const done = upgradesThisOffseason(league, teamId);
  const R = FACILITY_DATA.rules;
  const rich = team.finances.cash - cost >= R.richCashThreshold * scale;
  const allowed = rich ? Math.max(R.upgradesPerOffseason, R.richUpgradesPerOffseason) : R.upgradesPerOffseason;
  if (done >= allowed) return { ok: false, reason: `Only ${allowed} facility upgrade${allowed === 1 ? '' : 's'} per offseason`, cost };
  return { ok: true, reason: null, cost };
};

/** A stadium after its facility went from `from` to `to`: capacity and atmosphere gain the level difference. */
export const upgradedStadium = (stadium: Stadium, from: number, to: number): Stadium => {
  const cap = (l: number): number => effectAt('stadium', 'capacityPct', l);
  const atm = (l: number): number => effectAt('stadium', 'atmosphere', l);
  return {
    ...stadium,
    capacity: Math.round((stadium.capacity * (1 + cap(to))) / (1 + cap(from))),
    atmosphere: clamp(Math.round(stadium.atmosphere + atm(to) - atm(from)), 1, 99),
    level: clamp(Math.max(stadium.level, to), 1, FACILITY_DATA.maxLevel),
  };
};

/**
 * Buys one facility level: cash is paid, the level rises, the offseason upgrade count is recorded and a
 * stadium upgrade is built into the Stadium record. Returns the unchanged League with the reason when refused.
 */
export const upgradeFacility = (league: League, teamId: TeamId, type: FacilityType): FacilityUpgradeResult => {
  const check = canUpgradeFacility(league, teamId, type);
  const team = league.teams[teamId];
  if (!check.ok || check.cost === null || !team) return { ...check, league, newLevel: team ? facilityLevel(team.facilities, type) : 0 };
  const from = facilityLevel(team.facilities, type);
  const to = from + 1;
  const nextTeam: Team = {
    ...team,
    facilities: { ...team.facilities, [type]: to },
    finances: { ...team.finances, cash: team.finances.cash - check.cost },
  };
  const stadium = league.stadiums[team.stadiumId];
  const stadiums = type === 'stadium' && stadium ? { ...league.stadiums, [stadium.id]: upgradedStadium(stadium, from, to) } : league.stadiums;
  const club = ensureClub(league);
  const year = leagueCapYear(league);
  const facilityUpgrades = { ...club.facilityUpgrades, [teamId]: { year, count: upgradesThisOffseason(league, teamId) + 1 } };
  const next = withClub({ ...league, teams: { ...league.teams, [teamId]: nextTeam }, stadiums }, { facilityUpgrades });
  return { ok: true, reason: null, cost: check.cost, league: next, newLevel: to };
};

/**
 * AI facility spending for one offseason: every AI team with cash above the reserve buys the lowest
 * facility (ties broken by FACILITY_DATA.aiPriority) while it can afford it and the per-offseason limit allows.
 */
export const aiFacilityUpgrades = (league: League): League => {
  let current = league;
  const reserveScale = economyScale(league.settings);
  for (const team of Object.values(league.teams)) {
    if (team.isUserControlled || team.id === league.userTeamId) continue;
    for (let guard = 0; guard < 3; guard++) {
      const t = current.teams[team.id];
      if (!t) break;
      const options = FACILITY_DATA.aiPriority
        .map((type, i) => ({ type, i, level: facilityLevel(t.facilities, type), check: canUpgradeFacility(current, team.id, type) }))
        .filter((o) => o.check.ok && o.check.cost !== null && t.finances.cash - o.check.cost >= FACILITY_DATA.rules.aiCashReserve * reserveScale)
        .sort((a, b) => a.level - b.level || a.i - b.i);
      const choice = options[0];
      if (!choice) break;
      current = upgradeFacility(current, team.id, choice.type).league;
    }
  }
  return current;
};
