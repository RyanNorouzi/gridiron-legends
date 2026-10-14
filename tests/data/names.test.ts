import { describe, expect, it } from 'vitest';
import namesJson from '@/data/names.json';
import collegesJson from '@/data/colleges.json';
import { createRng } from '@/core/rng';
import type { NameSource } from '@/players/generator';
import { createNamePool, isWellFormedName, loadCollegeNames, loadNameLists, sanitizeNameList } from '@/players/names';

describe('names.json content', () => {
  it('ships at least 400 first names and 700 last names', () => {
    expect(namesJson.first.length).toBeGreaterThanOrEqual(400);
    expect(namesJson.last.length).toBeGreaterThanOrEqual(700);
  });

  it('contains no duplicates, blanks or oddly formed names', () => {
    for (const list of [namesJson.first, namesJson.last]) {
      expect(new Set(list).size).toBe(list.length);
      for (const n of list) {
        expect(n, n).toBe(n.trim());
        expect(isWellFormedName(n), n).toBe(true);
      }
    }
  });

  it('draws on a broad mix of naming traditions', () => {
    // A handful of markers from different backgrounds; the pool should not be monocultural.
    const last = new Set(namesJson.last);
    const markers = ['Nguyen', 'Garcia', 'Okafor', 'Tanaka', 'Patel', 'Fifita', 'Kealoha', 'Schmidt', 'Murphy', 'Washington'];
    for (const m of markers) expect(last, m).toContain(m);
  });

  it('loadNameLists returns fresh sanitised copies', () => {
    const a = loadNameLists();
    expect(a.first.length).toBe(namesJson.first.length);
    expect(a.last.length).toBe(namesJson.last.length);
    a.first.push('Mutant');
    expect(loadNameLists().first).not.toContain('Mutant');
  });
});

describe('sanitizeNameList', () => {
  it('trims, drops blanks and duplicates while keeping order', () => {
    expect(sanitizeNameList([' Ada ', 'Ben', '', 'Ada', '  ', 'Cy'], 'x')).toEqual(['Ada', 'Ben', 'Cy']);
  });

  it('throws descriptive errors for non-arrays and non-strings', () => {
    expect(() => sanitizeNameList('Ada', 'first')).toThrow(/first: expected an array/);
    expect(() => sanitizeNameList(['Ada', 7], 'first')).toThrow(/first\[1\]: expected a string, got number/);
  });

  it('isWellFormedName accepts apostrophes and hyphens but rejects junk', () => {
    for (const ok of ["O'Neal", 'Al-Amin', 'McKay', 'Jo']) expect(isWellFormedName(ok), ok).toBe(true);
    for (const bad of ['ada', 'J', 'John Smith', 'Smith-', '4ever', '']) expect(isWellFormedName(bad), bad).toBe(false);
  });
});

describe('createNamePool', () => {
  it('is deterministic for the same seed and varies across seeds', () => {
    const pool = createNamePool();
    const draw = (seed: number): string[] => {
      const rng = createRng(seed);
      return Array.from({ length: 40 }, () => `${pool.pickFirst(rng)} ${pool.pickLast(rng)}`);
    };
    expect(draw(1234)).toEqual(draw(1234));
    expect(draw(1234)).not.toEqual(draw(4321));
  });

  it('only ever returns names from its lists', () => {
    const pool = createNamePool();
    const rng = createRng(99);
    const first = new Set(pool.firstNames);
    const last = new Set(pool.lastNames);
    for (let i = 0; i < 2000; i++) {
      expect(first.has(pool.pickFirst(rng))).toBe(true);
      expect(last.has(pool.pickLast(rng))).toBe(true);
      const full = pool.pickFullName(rng);
      expect(first.has(full.firstName)).toBe(true);
      expect(last.has(full.lastName)).toBe(true);
    }
  });

  it('spreads picks across the whole pool rather than a few names', () => {
    const pool = createNamePool();
    const rng = createRng(7);
    const seenFirst = new Set<string>();
    const seenLast = new Set<string>();
    for (let i = 0; i < 8000; i++) {
      seenFirst.add(pool.pickFirst(rng));
      seenLast.add(pool.pickLast(rng));
    }
    expect(seenFirst.size / pool.firstNames.length).toBeGreaterThan(0.9);
    expect(seenLast.size / pool.lastNames.length).toBeGreaterThan(0.9);
  });

  it('exposes pickCollege backed by colleges.json by default', () => {
    const pool = createNamePool();
    expect(pool.pickCollege).toBeDefined();
    expect(pool.colleges.length).toBeGreaterThanOrEqual(80);
    const known = new Set(collegesJson.map((c) => c.name));
    const rng = createRng(5);
    for (let i = 0; i < 300; i++) expect(known.has(pool.pickCollege!(rng))).toBe(true);
    expect(loadCollegeNames()).toEqual([...known]);
  });

  it('omits pickCollege when created without colleges', () => {
    expect(createNamePool(undefined, { colleges: null }).pickCollege).toBeUndefined();
    expect(createNamePool(undefined, { colleges: [] }).pickCollege).toBeUndefined();
    const custom = createNamePool(createRng(1), { colleges: ['Only U'] });
    expect(custom.pickCollege!()).toBe('Only U');
  });

  it('uses the default rng when a pick omits one, and throws when there is none', () => {
    const withDefault = createNamePool(createRng(42));
    const expected = createNamePool(createRng(42));
    const rng = createRng(42);
    expect(withDefault.pickFirst()).toBe(expected.pickFirst(rng));
    expect(withDefault.pickLast()).toBe(expected.pickLast(rng));

    const bare = createNamePool();
    expect(() => bare.pickFirst()).toThrow(/NamePool\.pickFirst: no Rng supplied/);
    expect(() => bare.pickLast()).toThrow(/NamePool\.pickLast: no Rng supplied/);
    expect(() => bare.pickFullName()).toThrow(/NamePool\.pickFullName: no Rng supplied/);
    expect(() => bare.pickCollege!()).toThrow(/NamePool\.pickCollege: no Rng supplied/);
  });

  it('an explicit rng always wins over the default rng', () => {
    const pool = createNamePool(createRng(1));
    const a = pool.pickFirst(createRng(77));
    const b = createNamePool().pickFirst(createRng(77));
    expect(a).toBe(b);
  });

  it('honours custom lists and rejects empty ones', () => {
    const pool = createNamePool(undefined, { first: ['Ada', 'Ada', ' Bo '], last: ['Lovelace'] });
    expect(pool.firstNames).toEqual(['Ada', 'Bo']);
    expect(pool.lastNames).toEqual(['Lovelace']);
    const rng = createRng(3);
    for (let i = 0; i < 20; i++) expect(['Ada', 'Bo']).toContain(pool.pickFirst(rng));
    expect(pool.pickLast(rng)).toBe('Lovelace');
    expect(() => createNamePool(undefined, { first: [] })).toThrow(/first-name list is empty/);
    expect(() => createNamePool(undefined, { last: ['', '  '] })).toThrow(/last-name list is empty/);
    expect(() => createNamePool(undefined, { first: ['Ada', 3 as unknown as string] })).toThrow(/options\.first\[1\]/);
  });

  it('satisfies the player generator NameSource contract', () => {
    // Compile-time check: the pool must be usable wherever generatePlayer expects a NameSource.
    const source: NameSource = createNamePool();
    const rng = createRng(11);
    expect(source.pickFirst(rng)).toBe(createNamePool().pickFirst(createRng(11)));
    expect(typeof source.pickLast(rng)).toBe('string');
  });

  it('a forked rng per player keeps name draws independent of other systems', () => {
    const pool = createNamePool();
    const league = createRng('league-seed');
    const p1 = pool.pickFullName(league.fork('player:1'));
    const p2 = pool.pickFullName(league.fork('player:2'));
    const again = createRng('league-seed');
    expect(pool.pickFullName(again.fork('player:1'))).toEqual(p1);
    expect(pool.pickFullName(again.fork('player:2'))).toEqual(p2);
  });
});
