import { describe, expect, it } from 'vitest';
import {
  FACILITY_DATA, FACILITY_TYPES, aiFacilityUpgrades, canUpgradeFacility, economyScale, facilityEffects, facilityGrowthMultiplier, facilityMaintenance,
  maintenanceCost, medicalInjuryWeeks, progressionFacilityLevel, upgradeCost, upgradeFacility, upgradesThisOffseason, validateFacilityData,
} from '@/franchise/facilities';
import { defaultFacilities } from '@/teams/generator';
import type { Team } from '@/teams/types';
import { aiTeam, clubLeague, patchTeam, userTeamOf, withPhase } from './helpers';

const league = clubLeague();
const team = userTeamOf(league);
const offseason = withPhase(league, 'offseason', 0);
const setCash = (l: typeof league, id: Team['id'], cash: number): typeof league => patchTeam(l, id, (t) => ({ ...t, finances: { ...t.finances, cash } }));
const setLevels = (l: typeof league, id: Team['id'], level: number): typeof league => patchTeam(l, id, { facilities: defaultFacilities(level) });

describe('facility data', () => {
  it('upgrade costs rise level by level and stop at the top level', () => {
    for (const type of FACILITY_TYPES) {
      const costs = [1, 2, 3, 4].map((l) => upgradeCost(type, l) ?? 0);
      for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeGreaterThan(costs[i - 1] ?? 0);
      expect(upgradeCost(type, FACILITY_DATA.maxLevel)).toBeNull();
      expect(upgradeCost(type, 2, 2)).toBe((upgradeCost(type, 2) ?? 0) * 2);
    }
  });

  it('maintenance rises with level and scales with the league cap', () => {
    for (const type of FACILITY_TYPES) expect(facilityMaintenance(type, 5)).toBeGreaterThan(facilityMaintenance(type, 1));
    expect(maintenanceCost({ facilities: defaultFacilities(4) })).toBeGreaterThan(maintenanceCost({ facilities: defaultFacilities(2) }));
    expect(economyScale({ salaryCap: league.settings.salaryCap * 2 })).toBeCloseTo(economyScale(league.settings) * 2);
  });

  it('effects improve with level', () => {
    const lo = facilityEffects({ facilities: defaultFacilities(1) });
    const hi = facilityEffects({ facilities: defaultFacilities(5) });
    expect(hi.devMultiplier).toBeGreaterThan(lo.devMultiplier);
    expect(hi.youngGrowthMultiplier).toBeGreaterThan(lo.youngGrowthMultiplier);
    expect(hi.injuryWeeksMultiplier).toBeLessThan(lo.injuryWeeksMultiplier);
    expect(hi.injuryChanceMultiplier).toBeLessThan(lo.injuryChanceMultiplier);
    expect(hi.scoutingPoints).toBeGreaterThan(lo.scoutingPoints);
    expect(hi.capacityPct).toBeGreaterThan(lo.capacityPct);
    expect(hi.atmosphereBonus).toBeGreaterThan(lo.atmosphereBonus);
    expect(hi.scoutingAccuracy).toBeGreaterThan(lo.scoutingAccuracy);
    expect(hi.gameplanBonus).toBeGreaterThan(lo.gameplanBonus);
    expect(lo.advancedStats).toBe(false);
    expect(hi.advancedStats).toBe(true);
  });

  it('progression helpers lean on the development center for young players', () => {
    const t = { facilities: { ...defaultFacilities(1), development: 5 } };
    expect(progressionFacilityLevel(t, { age: 22 })).toBeGreaterThan(progressionFacilityLevel(t, { age: 30 }));
    expect(facilityGrowthMultiplier(t, { age: 22 })).toBeGreaterThan(facilityGrowthMultiplier(t, { age: 30 }));
    expect(medicalInjuryWeeks({ facilities: defaultFacilities(5) }, 8)).toBeLessThan(medicalInjuryWeeks({ facilities: defaultFacilities(1) }, 8));
    expect(medicalInjuryWeeks({ facilities: defaultFacilities(5) }, 1)).toBe(1);
    expect(medicalInjuryWeeks({ facilities: defaultFacilities(5) }, 0)).toBe(0);
  });

  it('rejects malformed data', () => {
    expect(() => validateFacilityData({ maxLevel: 5 })).toThrow(/facilities.json/);
    const broken = JSON.parse(JSON.stringify({ ...FACILITY_DATA, aiPriority: ['pool'] })) as unknown;
    expect(() => validateFacilityData(broken)).toThrow(/aiPriority/);
  });
});

describe('upgrades', () => {
  it('are only built in the offseason', () => {
    const inSeason = setLevels(withPhase(league, 'regularSeason', 4), team.id, 2);
    const r = upgradeFacility(inSeason, team.id, 'training');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/offseason/);
    expect(r.league).toBe(inSeason);
  });

  it('cost cash, raise the level and are limited to one per offseason', () => {
    const l = setCash(setLevels(offseason, team.id, 2), team.id, 50_000_000);
    const cost = upgradeCost('training', 2, economyScale(l.settings)) ?? 0;
    const r = upgradeFacility(l, team.id, 'training');
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(cost);
    expect(r.newLevel).toBe(3);
    expect(r.league.teams[team.id]?.facilities.training).toBe(3);
    expect(r.league.teams[team.id]?.finances.cash).toBe(50_000_000 - cost);
    expect(upgradesThisOffseason(r.league, team.id)).toBe(1);
    const second = upgradeFacility(r.league, team.id, 'medical');
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/per offseason/);
    // A new offseason (next year) resets the allowance.
    const nextYear = { ...r.league, year: r.league.year + 1, season: { ...r.league.season, year: r.league.season.year + 1 } };
    expect(canUpgradeFacility(nextYear, team.id, 'medical').ok).toBe(true);
  });

  it('rich clubs may build two per offseason', () => {
    const l = setCash(setLevels(offseason, team.id, 2), team.id, 400_000_000);
    const one = upgradeFacility(l, team.id, 'training');
    const two = upgradeFacility(one.league, team.id, 'medical');
    expect(two.ok).toBe(true);
    const three = upgradeFacility(two.league, team.id, 'scouting');
    expect(three.ok).toBe(false);
  });

  it('respect the level cap and the cash on hand', () => {
    const maxed = setCash(setLevels(offseason, team.id, 5), team.id, 500_000_000);
    const top = upgradeFacility(maxed, team.id, 'analytics');
    expect(top.ok).toBe(false);
    expect(top.reason).toMatch(/top level/);
    const poor = setCash(setLevels(offseason, team.id, 3), team.id, 1_000_000);
    expect(upgradeFacility(poor, team.id, 'stadium').ok).toBe(false);
  });

  it('stadium upgrades are built into the stadium record', () => {
    const l = setCash(setLevels(offseason, team.id, 2), team.id, 100_000_000);
    const before = l.stadiums[team.stadiumId];
    const r = upgradeFacility(l, team.id, 'stadium');
    const after = r.league.stadiums[team.stadiumId];
    expect(r.ok).toBe(true);
    expect(after?.capacity).toBeGreaterThan(before?.capacity ?? 0);
    expect(after?.atmosphere).toBeGreaterThan(before?.atmosphere ?? 0);
    expect(l.stadiums[team.stadiumId]).toBe(before);
  });

  it('AI teams spend only above their cash reserve and never for the user team', () => {
    const rich = aiTeam(offseason, 0);
    const poor = aiTeam(offseason, 1);
    let l = setCash(setLevels(offseason, rich.id, 2), rich.id, 90_000_000);
    l = setCash(setLevels(l, poor.id, 2), poor.id, 20_000_000);
    l = setCash(setLevels(l, team.id, 2), team.id, 300_000_000);
    const out = aiFacilityUpgrades(l);
    const richAfter = out.teams[rich.id];
    expect(Object.values(richAfter?.facilities ?? {}).reduce((s, v) => s + v, 0)).toBeGreaterThan(12);
    expect(richAfter?.finances.cash).toBeGreaterThanOrEqual(FACILITY_DATA.rules.aiCashReserve * economyScale(l.settings));
    expect(out.teams[poor.id]?.facilities).toEqual(defaultFacilities(2));
    expect(out.teams[team.id]?.facilities).toEqual(defaultFacilities(2));
  });
});
