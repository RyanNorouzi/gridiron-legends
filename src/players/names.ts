/**
 * Name pools for generated players and prospects. Backed by src/data/names.json (first/last
 * names) and src/data/colleges.json (college names). Every pick flows through an Rng so a
 * league's rosters are reproducible from its seed.
 *
 * players/ sits below teams/ in the import order, so this module reads colleges.json directly
 * with a light check; the full college validation (regions etc.) lives in src/teams/data.ts.
 */
import namesJson from '@/data/names.json';
import collegesJson from '@/data/colleges.json';
import type { Rng } from '@/core/rng';

export interface NamePool {
  /** Random first name. Uses `rng`, falling back to the pool's default rng when omitted. */
  pickFirst(rng?: Rng): string;
  /** Random last name. Uses `rng`, falling back to the pool's default rng when omitted. */
  pickLast(rng?: Rng): string;
  /** Random college name. Absent when the pool was created without colleges. */
  pickCollege?(rng?: Rng): string;
  /** Independent first + last pick (two rng draws). */
  pickFullName(rng?: Rng): { firstName: string; lastName: string };
  readonly firstNames: readonly string[];
  readonly lastNames: readonly string[];
  readonly colleges: readonly string[];
}

export interface NamePoolOptions {
  /** Replaces the first names from names.json. */
  first?: readonly string[];
  /** Replaces the last names from names.json. */
  last?: readonly string[];
  /** Replaces the colleges from colleges.json; `null` or `[]` creates a pool without pickCollege. */
  colleges?: readonly string[] | null;
}

/**
 * Full names the generator must never produce: famous real pro-football players and coaches whose first and last
 * names both appear in the pools. Stored lower-case as "first last".
 */
const RESERVED_FULL_NAMES: ReadonlySet<string> = new Set([
  'jerry rice', 'barry sanders', 'jim brown', 'john madden', 'tom landry', 'josh allen', 'lawrence taylor', 'steve young',
  'randy moss', 'jim kelly', 'warren moon', 'reggie white', 'bruce smith', 'ray lewis', 'tony gonzalez', 'calvin johnson',
  'adrian peterson', 'earl campbell', 'ronnie lott', 'jack lambert', 'joe greene', 'tim brown', 'marvin harrison',
  'terrell owens', 'larry fitzgerald', 'andy reid', 'pete carroll', 'paul brown', 'joe gibbs', 'russell wilson', 'matt ryan',
  'philip rivers', 'cam newton', 'lamar jackson', 'derrick henry', 'justin jefferson', 'julio jones', 'antonio brown',
  'kyler murray', 'derek carr', 'randall cunningham', 'bo jackson', 'doug williams', 'eddie george', 'curtis martin',
  'marcus allen', 'andre reed', 'raymond berry', 'mike webster', 'anthony munoz', 'walter jones', 'larry allen',
  'bruce matthews', 'randall mcdaniel', 'derrick thomas', 'richard sherman', 'sean taylor', 'kenny easley', 'justin tucker',
  'devin hester', 'chris johnson', 'steve smith', 'mike evans', 'chris carter', 'cris carter', 'mike williams', 'josh jacobs',
  'josh gordon', 'ryan clark', 'kevin greene', 'keith jackson', 'dan campbell', 'mike mccarthy', 'dan quinn', 'jimmy johnson',
  'jason garrett', 'rex ryan', 'jim caldwell', 'dennis green', 'tom flores', 'john robinson', 'mike smith', 'ron rivera',
  'tom brady', 'peyton manning', 'joe montana', 'dan marino', 'john elway', 'walter payton', 'emmitt smith', 'troy aikman',
  'deion sanders', 'michael irvin', 'bill walsh', 'don shula', 'mike ditka', 'tony dungy', 'ed reed', 'aaron donald',
]);

/** True when first + last is a reserved real-person name (case-insensitive). */
export const isReservedFullName = (firstName: string, lastName: string): boolean => RESERVED_FULL_NAMES.has(`${firstName} ${lastName}`.toLowerCase());

/**
 * Returns `lastName`, or a redrawn last name when first + last would be a reserved real-person name. `redraw` is only
 * called in that case, so ordinary picks consume exactly the same random draws as before.
 */
export const avoidReservedName = (firstName: string, lastName: string, redraw: () => string): string => {
  let last = lastName;
  for (let i = 0; i < 8 && isReservedFullName(firstName, last); i++) last = redraw();
  return last;
};

/** Accepts capitalised names with inner apostrophes/hyphens (e.g. "O'Neal", "Al-Amin"). */
const NAME_PATTERN = /^[A-Z][a-zA-Z'-]*[a-zA-Z]$/;

/**
 * Turns a raw JSON list into a clean name list: entries must be strings; whitespace is trimmed,
 * blanks and duplicates dropped. Throws a descriptive error for non-string entries.
 */
export const sanitizeNameList = (raw: unknown, label: string): string[] => {
  if (!Array.isArray(raw)) throw new Error(`${label}: expected an array of names`);
  const entries: readonly unknown[] = raw;
  const seen = new Set<string>();
  const out: string[] = [];
  entries.forEach((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`${label}[${i}]: expected a string, got ${typeof entry}`);
    const name = entry.trim();
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out;
};

/** True when a name looks like a plausible person name for the pools (used by tests and tooling). */
export const isWellFormedName = (name: string): boolean => NAME_PATTERN.test(name);

/** Validated, deduplicated first/last lists from names.json. Fresh arrays on every call. */
export const loadNameLists = (): { first: string[]; last: string[] } => {
  const raw: unknown = namesJson;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('names.json: expected an object');
  const obj = raw as Record<string, unknown>;
  const first = sanitizeNameList(obj['first'], 'names.json.first');
  const last = sanitizeNameList(obj['last'], 'names.json.last');
  if (first.length === 0) throw new Error('names.json.first: no usable names');
  if (last.length === 0) throw new Error('names.json.last: no usable names');
  return { first, last };
};

/** College names from colleges.json (unvalidated beyond shape; see teams/data.ts for the full check). */
export const loadCollegeNames = (): string[] => {
  const raw: unknown = collegesJson;
  if (!Array.isArray(raw)) throw new Error('colleges.json: expected an array');
  const entries: readonly unknown[] = raw;
  const names = entries.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`colleges.json[${i}]: expected an object`);
    const name = (entry as Record<string, unknown>)['name'];
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error(`colleges.json[${i}].name: expected a non-empty string`);
    return name.trim();
  });
  return sanitizeNameList(names, 'colleges.json');
};

/**
 * Creates a NamePool. `defaultRng` is used by the pick methods when the caller passes no rng;
 * without it, every pick must supply one (a pick with neither throws). Deterministic: the same
 * rng state yields the same sequence of names.
 */
export const createNamePool = (defaultRng?: Rng, options: NamePoolOptions = {}): NamePool => {
  const defaults = options.first === undefined || options.last === undefined ? loadNameLists() : { first: [], last: [] };
  const firstNames = options.first === undefined ? defaults.first : sanitizeNameList(options.first, 'options.first');
  const lastNames = options.last === undefined ? defaults.last : sanitizeNameList(options.last, 'options.last');
  const colleges =
    options.colleges === undefined ? loadCollegeNames() : options.colleges === null ? [] : sanitizeNameList(options.colleges, 'options.colleges');
  if (firstNames.length === 0) throw new Error('createNamePool: first-name list is empty');
  if (lastNames.length === 0) throw new Error('createNamePool: last-name list is empty');

  const resolve = (method: string, rng: Rng | undefined): Rng => {
    const r = rng ?? defaultRng;
    if (!r) throw new Error(`NamePool.${method}: no Rng supplied and the pool has no default rng`);
    return r;
  };

  const pool: NamePool = {
    firstNames,
    lastNames,
    colleges,
    pickFirst: (rng) => resolve('pickFirst', rng).pick(firstNames),
    pickLast: (rng) => resolve('pickLast', rng).pick(lastNames),
    pickFullName: (rng) => {
      const r = resolve('pickFullName', rng);
      const firstName = r.pick(firstNames);
      return { firstName, lastName: avoidReservedName(firstName, r.pick(lastNames), () => r.pick(lastNames)) };
    },
  };
  if (colleges.length > 0) pool.pickCollege = (rng) => resolve('pickCollege', rng).pick(colleges);
  return pool;
};
