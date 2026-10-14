import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { TeamId } from '@/core/ids';
import type { Coach, CoachRatings, StaffRole } from '@/teams/types';
import {
  COACH_TRAITS, DEFENSIVE_SCHEMES, OFFENSIVE_SCHEMES, RATING_KEYS, ROLE_PROFILES, STAFF_ROLES,
  coachSalary, coachTraitsConflict, generateCoach, generateStaff, headCoachOf, roleRating, rollCoachRatings, rollCoachTraits,
} from '@/teams/coach-generator';
import { mean, testNames } from '../players/helpers';

const TEAM = 't_test0001' as TeamId;
const sample = (role: StaffRole, n: number, quality?: number, seed = 1): Coach[] => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => generateCoach(rng, role, { names: testNames, ...(quality === undefined ? {} : { quality }) }));
};
const meanOf = (coaches: Coach[], keys: readonly (keyof CoachRatings)[]): number => mean(coaches.flatMap((c) => keys.map((k) => c.ratings[k])));

describe('generateCoach', () => {
  it('is deterministic per seed', () => {
    const a = generateCoach(createRng(42), 'HC', { names: testNames });
    const b = generateCoach(createRng(42), 'HC', { names: testNames });
    const c = generateCoach(createRng(43), 'HC', { names: testNames });
    expect(a).toEqual(b);
    expect(a.id).not.toBe(c.id);
  });
  it('produces a complete, in-range coach for every role', () => {
    for (const role of STAFF_ROLES) {
      const profile = ROLE_PROFILES[role];
      for (const coach of sample(role, 12, undefined, 7)) {
        expect(coach.role).toBe(role);
        expect(coach.id.startsWith('c_')).toBe(true);
        expect(coach.firstName.length).toBeGreaterThan(0);
        expect(coach.lastName.length).toBeGreaterThan(0);
        expect(coach.age).toBeGreaterThanOrEqual(profile.ageRange[0]);
        expect(coach.age).toBeLessThanOrEqual(profile.ageRange[1]);
        for (const key of RATING_KEYS) {
          expect(Number.isInteger(coach.ratings[key])).toBe(true);
          expect(coach.ratings[key]).toBeGreaterThanOrEqual(1);
          expect(coach.ratings[key]).toBeLessThanOrEqual(99);
        }
        expect(coach.salary).toBeGreaterThanOrEqual(profile.salaryRange[0]);
        expect(coach.salary).toBeLessThanOrEqual(profile.salaryRange[1]);
        expect(coach.salary % 10_000).toBe(0);
        expect(coach.contractYears).toBeGreaterThanOrEqual(profile.contractRange[0]);
        expect(coach.contractYears).toBeLessThanOrEqual(profile.contractRange[1]);
        expect(coach.traits.length).toBeLessThanOrEqual(2);
        expect(new Set(coach.traits).size).toBe(coach.traits.length);
        for (const t of coach.traits) expect(COACH_TRAITS).toContain(t);
        if (coach.traits.length === 2) expect(coachTraitsConflict(coach.traits[0]!, coach.traits[1]!)).toBe(false);
        expect(OFFENSIVE_SCHEMES).toContain(coach.offensiveScheme);
        expect(DEFENSIVE_SCHEMES).toContain(coach.defensiveScheme);
        expect(coach.teamId).toBeNull();
        expect(coach.careerWins).toBeGreaterThanOrEqual(0);
        expect(coach.careerLosses).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('skews ratings toward the role\'s primary skills', () => {
    for (const role of STAFF_ROLES) {
      const coaches = sample(role, 60, 0.5, 11);
      const { primary, secondary } = ROLE_PROFILES[role];
      const rest = RATING_KEYS.filter((k) => !primary.includes(k) && !secondary.includes(k));
      expect(meanOf(coaches, primary)).toBeGreaterThan(meanOf(coaches, rest) + 15);
      expect(meanOf(coaches, primary)).toBeGreaterThan(meanOf(coaches, secondary) + 3);
    }
  });
  it('quality lifts the whole rating profile and the salary', () => {
    const good = sample('OC', 40, 0.95, 21);
    const bad = sample('OC', 40, 0.05, 22);
    expect(mean(good.map(roleRating)) - mean(bad.map(roleRating))).toBeGreaterThan(25);
    expect(mean(good.map((c) => c.salary))).toBeGreaterThan(mean(bad.map((c) => c.salary)) * 1.5);
  });
  it('coachSalary is monotonic in the primary rating and bounded by the role band', () => {
    const flat = (v: number): CoachRatings => ({ offense: v, defense: v, playerDevelopment: v, motivation: v, gameManagement: v, scouting: v, conditioning: v });
    expect(coachSalary('HC', flat(1))).toBe(ROLE_PROFILES.HC.salaryRange[0]);
    expect(coachSalary('HC', flat(99))).toBe(ROLE_PROFILES.HC.salaryRange[1]);
    expect(coachSalary('HC', flat(80))).toBeGreaterThan(coachSalary('HC', flat(60)));
    expect(coachSalary('Scout', flat(80))).toBeLessThan(coachSalary('HC', flat(80)));
  });
  it('only head coaches carry a career record, always a whole number of 17-game seasons', () => {
    for (const hc of sample('HC', 30, undefined, 31)) {
      expect((hc.careerWins + hc.careerLosses) % 17).toBe(0);
      const seasons = (hc.careerWins + hc.careerLosses) / 17;
      expect(hc.championships).toBeLessThanOrEqual(seasons);
    }
    expect(sample('HC', 30, undefined, 31).some((hc) => hc.careerWins > 0)).toBe(true);
    for (const oc of sample('OC', 10, undefined, 32)) expect([oc.careerWins, oc.careerLosses, oc.championships]).toEqual([0, 0, 0]);
  });
  it('honours explicit team, age and schemes, and validates inputs', () => {
    const c = generateCoach(createRng(1), 'DC', { names: testNames, teamId: TEAM, age: 50, offensiveScheme: 'airRaid', defensiveScheme: 'runStuff' });
    expect(c.teamId).toBe(TEAM);
    expect(c.age).toBe(50);
    expect(c.offensiveScheme).toBe('airRaid');
    expect(c.defensiveScheme).toBe('runStuff');
    expect(() => generateCoach(createRng(1), 'GM' as StaffRole, { names: testNames })).toThrow(/unknown role/);
    expect(() => generateCoach(createRng(1), 'HC', { names: testNames, quality: 2 })).toThrow(/quality/);
    expect(() => generateCoach(createRng(1), 'HC', { names: testNames, age: 19 })).toThrow(/age/);
  });
  it('falls back to the shipped name pool when no names are given', () => {
    const c = generateCoach(createRng(3), 'Scout');
    expect(c.firstName.length).toBeGreaterThan(0);
  });
});

describe('trait and rating rolls', () => {
  it('never rolls conflicting traits', () => {
    const rng = createRng(5);
    for (let i = 0; i < 300; i++) {
      const traits = rollCoachTraits(rng);
      expect(traits.length).toBeLessThanOrEqual(2);
      if (traits.length === 2) expect(coachTraitsConflict(traits[0]!, traits[1]!)).toBe(false);
    }
    expect(coachTraitsConflict('aggressive', 'conservative')).toBe(true);
    expect(coachTraitsConflict('conservative', 'aggressive')).toBe(true);
    expect(coachTraitsConflict('playersCoach', 'disciplinarian')).toBe(true);
    expect(coachTraitsConflict('innovator', 'developer')).toBe(false);
  });
  it('rollCoachRatings clamps into 1..99 at the extremes', () => {
    const rng = createRng(6);
    for (let i = 0; i < 50; i++) {
      for (const v of Object.values(rollCoachRatings(rng, 'StrengthCoach', 1))) expect(v).toBeLessThanOrEqual(99);
      for (const v of Object.values(rollCoachRatings(rng, 'StrengthCoach', 0))) expect(v).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('generateStaff', () => {
  const staff = generateStaff(createRng(77), TEAM, { names: testNames, quality: 0.6 });
  it('fills all 11 roles once, head coach first, every coach attached to the team', () => {
    expect(staff).toHaveLength(STAFF_ROLES.length);
    expect(staff.map((c) => c.role)).toEqual(STAFF_ROLES);
    expect(staff[0]?.role).toBe('HC');
    expect(new Set(staff.map((c) => c.id)).size).toBe(staff.length);
    for (const c of staff) expect(c.teamId).toBe(TEAM);
    expect(headCoachOf(staff)).toBe(staff[0]);
    expect(headCoachOf([])).toBeUndefined();
  });
  it('coordinators inherit the head coach\'s schemes', () => {
    const head = headCoachOf(staff)!;
    for (const c of staff) {
      expect(c.offensiveScheme).toBe(head.offensiveScheme);
      expect(c.defensiveScheme).toBe(head.defensiveScheme);
    }
  });
  it('is deterministic and staff quality shows in the ratings', () => {
    expect(generateStaff(createRng(77), TEAM, { names: testNames, quality: 0.6 })).toEqual(staff);
    const elite = generateStaff(createRng(78), TEAM, { names: testNames, quality: 1 });
    const poor = generateStaff(createRng(78), TEAM, { names: testNames, quality: 0 });
    expect(mean(elite.map(roleRating))).toBeGreaterThan(mean(poor.map(roleRating)) + 20);
  });
});
