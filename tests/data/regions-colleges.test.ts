import { describe, expect, it } from 'vitest';
import regionsJson from '@/data/regions.json';
import collegesJson from '@/data/colleges.json';
import {
  DataValidationError,
  collegesInRegion,
  loadColleges,
  loadRegions,
  validateColleges,
  validateRegions,
} from '@/teams/data';

type RawRegion = Record<string, unknown>;
type RawCollege = Record<string, unknown>;
const rawRegions = (): RawRegion[] => structuredClone(regionsJson) as unknown as RawRegion[];
const rawColleges = (): RawCollege[] => structuredClone(collegesJson) as unknown as RawCollege[];

describe('regions.json content', () => {
  const regions = loadRegions();

  it('defines around ten regions with unique ids and names', () => {
    expect(regions.length).toBeGreaterThanOrEqual(8);
    expect(regions.length).toBeLessThanOrEqual(14);
    expect(new Set(regions.map((r) => r.id)).size).toBe(regions.length);
    expect(new Set(regions.map((r) => r.name)).size).toBe(regions.length);
    for (const r of regions) expect(r.id).toMatch(/^[a-z][A-Za-z]+$/);
  });

  it('gives every region states, cities and at least one climate', () => {
    for (const r of regions) {
      expect(r.states.length, r.id).toBeGreaterThan(0);
      for (const s of r.states) expect(s).toMatch(/^[A-Z]{2}$/);
      expect(r.cities.length, r.id).toBeGreaterThanOrEqual(4);
      expect(r.climates.length, r.id).toBeGreaterThan(0);
    }
  });

  it('never lists one city or state under two regions', () => {
    const cities = regions.flatMap((r) => r.cities);
    expect(new Set(cities).size).toBe(cities.length);
    const states = regions.flatMap((r) => r.states);
    expect(new Set(states).size).toBe(states.length);
  });

  it('returns fresh arrays on every load', () => {
    const a = loadRegions();
    a[0]!.cities.push('Mutated');
    expect(loadRegions()[0]!.cities).not.toContain('Mutated');
  });
});

describe('validateRegions error classes', () => {
  const expectError = (raw: unknown, pattern: RegExp): void => {
    expect(() => validateRegions(raw)).toThrow(DataValidationError);
    expect(() => validateRegions(raw)).toThrow(pattern);
  };

  it('rejects non-array roots and empty lists', () => {
    expectError({}, /regions: expected an array/);
    expectError([], /at least one region/);
  });

  it('rejects duplicate ids', () => {
    const c = rawRegions();
    c[1]!['id'] = c[0]!['id'];
    expectError(c, /regions\[1\]\.id: duplicate region id/);
  });

  it('rejects unknown climates and empty city/state lists', () => {
    const c = rawRegions();
    c[0]!['climates'] = ['tropical'];
    expectError(c, /regions\[0\]\.climates\[0\]: unknown climate "tropical"/);
    const d = rawRegions();
    d[0]!['cities'] = [];
    expectError(d, /regions\[0\]\.cities: expected at least 1 entries/);
    const e = rawRegions();
    e[0]!['states'] = 'TX';
    expectError(e, /regions\[0\]\.states: expected an array/);
  });

  it('rejects a city claimed by two regions', () => {
    const c = rawRegions();
    (c[2]!['cities'] as string[]).push((c[0]!['cities'] as string[])[0]!);
    expectError(c, /regions\[2\]\.cities: city ".*" is already listed under region/);
  });

  it('rejects a state claimed by two regions and malformed state codes', () => {
    const c = rawRegions();
    (c[3]!['states'] as string[]).push((c[1]!['states'] as string[])[0]!);
    expectError(c, /regions\[3\]\.states: state ".*" is already listed under region/);
    const d = rawRegions();
    (d[0]!['states'] as string[]).push('Texas');
    expectError(d, /regions\[0\]\.states: "Texas" is not a two-letter state code/);
  });

  it('rejects missing names', () => {
    const c = rawRegions();
    delete c[0]!['name'];
    expectError(c, /regions\[0\]\.name: expected a non-empty string/);
  });
});

describe('colleges.json content', () => {
  const regions = loadRegions();
  const colleges = loadColleges();

  it('ships at least 80 unique fictional colleges', () => {
    expect(colleges.length).toBeGreaterThanOrEqual(80);
    expect(new Set(colleges.map((c) => c.name)).size).toBe(colleges.length);
    for (const c of colleges) expect(c.name.length).toBeGreaterThan(5);
  });

  it('maps every college to a known region and every region has colleges', () => {
    const ids = new Set(regions.map((r) => r.id));
    for (const c of colleges) expect(ids, c.name).toContain(c.region);
    for (const r of regions) expect(collegesInRegion(r.id, colleges).length, r.id).toBeGreaterThanOrEqual(5);
    expect(collegesInRegion('nowhere', colleges)).toEqual([]);
  });

  it('does not reuse recognisable real-world university names', () => {
    const banned = /\b(Alabama|Ohio State|Michigan|Notre Dame|Clemson|Oklahoma|Texas|Georgia|Florida State|LSU|Penn State|USC|Oregon|Stanford|Auburn|Nebraska|Wisconsin|Iowa|Tennessee)\b/;
    for (const c of colleges) expect(c.name, c.name).not.toMatch(banned);
  });
});

describe('validateColleges error classes', () => {
  const regions = loadRegions();
  const expectError = (raw: unknown, pattern: RegExp): void => {
    expect(() => validateColleges(raw, regions)).toThrow(DataValidationError);
    expect(() => validateColleges(raw, regions)).toThrow(pattern);
  };

  it('rejects unknown regions', () => {
    const c = rawColleges();
    c[4]!['region'] = 'moon';
    expectError(c, /colleges\[4\]\.region: unknown region "moon"/);
  });

  it('rejects duplicate names and blank names', () => {
    const c = rawColleges();
    c[3]!['name'] = c[0]!['name'];
    expectError(c, /colleges\[3\]\.name: duplicate college/);
    const d = rawColleges();
    d[0]!['name'] = '   ';
    expectError(d, /colleges\[0\]\.name: expected a non-empty string/);
  });

  it('rejects malformed roots and entries', () => {
    expectError('nope', /colleges: expected an array/);
    expectError([], /at least one college/);
    expectError([42], /colleges\[0\]: expected an object/);
  });
});
