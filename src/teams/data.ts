/**
 * Loaders for the league's static data: fictional teams (src/data/teams.json), US regions
 * (src/data/regions.json) and fictional colleges (src/data/colleges.json).
 *
 * Validation happens here, at the data boundary. Every loader returns freshly built objects
 * (never references into the JSON module) and throws a DataValidationError whose message names
 * the offending path, so a bad edit to the JSON fails loudly at startup instead of mid-season.
 */
import teamsJson from '@/data/teams.json';
import regionsJson from '@/data/regions.json';
import collegesJson from '@/data/colleges.json';
import type { Stadium, TeamColors } from '@/teams/types';

/* ---------------------------------------------------------------- types */

export type MarketSize = 'small' | 'medium' | 'large';
export type Climate = Stadium['climate'];
export type FieldType = Stadium['fieldType'];
export type RoofType = Stadium['roof'];

/** Static stadium description; franchise creation turns it into a `Stadium` with an id and level. */
export interface StadiumTemplate {
  name: string;
  capacity: number;
  fieldType: FieldType;
  roof: RoofType;
  climate: Climate;
  /** Home-field crowd factor, 40..95. */
  atmosphere: number;
  yearBuilt: number;
}

/** One league team as authored in teams.json. Franchise creation turns it into a `Team`. */
export interface TeamTemplate {
  city: string;
  name: string;
  /** Three uppercase letters, unique league-wide. */
  abbr: string;
  conference: string;
  division: string;
  colors: TeamColors;
  /** Procedural logo generation seed. */
  logoSeed: number;
  /** Region id from regions.json; shared with Player.homeRegion. */
  region: string;
  marketSize: MarketSize;
  stadium: StadiumTemplate;
  /** 1..2 abbreviations of teams in the same division. */
  rivalAbbrs: string[];
}

export interface ConferenceTemplate {
  name: string;
  divisions: string[];
}

export interface TeamDataset {
  conferences: ConferenceTemplate[];
  teams: TeamTemplate[];
}

/** A US region used for player home regions and free-agency location preference. */
export interface Region {
  id: string;
  name: string;
  /** Two-letter state codes. */
  states: string[];
  cities: string[];
  /** Stadium climates that make sense for this region. */
  climates: Climate[];
}

export interface College {
  name: string;
  /** Region id from regions.json. */
  region: string;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/* ------------------------------------------------------------ constants */

export const LEAGUE_TEAM_COUNT = 32;
export const CONFERENCE_COUNT = 2;
export const DIVISIONS_PER_CONFERENCE = 4;
export const TEAMS_PER_DIVISION = 4;
export const STADIUM_CAPACITY_RANGE: readonly [number, number] = [45000, 82000];
export const ATMOSPHERE_RANGE: readonly [number, number] = [40, 95];
export const YEAR_BUILT_RANGE: readonly [number, number] = [1900, 2100];
/** Minimum RGB distance between two primary colours in the same division. */
export const MIN_DIVISION_COLOR_DISTANCE = 60;
/** Minimum RGB distance between a team's primary and secondary (jersey vs numbers). */
export const MIN_JERSEY_CONTRAST = 60;
/** Reference grass colour; primaries must stay clearly distinguishable from it. */
export const FIELD_GREEN = '#2E7D32';
export const MIN_FIELD_COLOR_DISTANCE = 70;

const CLIMATES: readonly Climate[] = ['temperate', 'cold', 'warm', 'desert', 'coastal'];
const FIELD_TYPES: readonly FieldType[] = ['grass', 'turf'];
const ROOF_TYPES: readonly RoofType[] = ['open', 'dome', 'retractable'];
const MARKET_SIZES: readonly MarketSize[] = ['small', 'medium', 'large'];
const COLOR_KEYS: readonly (keyof TeamColors)[] = ['primary', 'secondary', 'accent', 'helmet'];

/* --------------------------------------------------------------- errors */

/** Thrown by every validator; `path` points at the offending JSON location (e.g. `teams[3].abbr`). */
export class DataValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'DataValidationError';
    this.path = path;
  }
}

const fail = (path: string, message: string): never => {
  throw new DataValidationError(path, message);
};

/* ------------------------------------------------------- field readers */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const record = (v: unknown, path: string): Record<string, unknown> => (isRecord(v) ? v : fail(path, 'expected an object'));

const array = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : fail(path, 'expected an array'));

const str = (obj: Record<string, unknown>, key: string, path: string): string => {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim().length === 0) return fail(`${path}.${key}`, 'expected a non-empty string');
  return v;
};

const int = (obj: Record<string, unknown>, key: string, path: string, lo: number, hi: number): number => {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) return fail(`${path}.${key}`, 'expected an integer');
  if (v < lo || v > hi) return fail(`${path}.${key}`, `${v} is outside the allowed range ${lo}..${hi}`);
  return v;
};

const enumOf = <T extends string>(obj: Record<string, unknown>, key: string, path: string, allowed: readonly T[]): T => {
  const v = obj[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    return fail(`${path}.${key}`, `expected one of ${allowed.join(', ')}; got ${JSON.stringify(v)}`);
  }
  return v as T;
};

const strArray = (obj: Record<string, unknown>, key: string, path: string, min: number, max = Infinity): string[] => {
  const p = `${path}.${key}`;
  const items = array(obj[key], p);
  if (items.length < min || items.length > max) {
    return fail(p, `expected ${max === Infinity ? `at least ${min}` : `${min}..${max}`} entries, got ${items.length}`);
  }
  return items.map((it, i) => (typeof it === 'string' && it.trim().length > 0 ? it : fail(`${p}[${i}]`, 'expected a non-empty string')));
};

/* -------------------------------------------------------------- colours */

/** Parses `#RRGGBB` (case-insensitive) into channels 0..255; null when malformed. */
export const parseHexColor = (hex: string): RgbColor | null => {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
};

/** Euclidean distance in RGB space (0..~441). Good enough to keep kits distinguishable in pixel art. */
export const colorDistance = (a: RgbColor, b: RgbColor): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

const hexColor = (obj: Record<string, unknown>, key: string, path: string): string => {
  const v = obj[key];
  if (typeof v !== 'string' || parseHexColor(v) === null) {
    return fail(`${path}.${key}`, `malformed hex colour ${JSON.stringify(v)} (expected #RRGGBB)`);
  }
  return v.toUpperCase();
};

const rgbOf = (hex: string): RgbColor => parseHexColor(hex) ?? fail('colour', `malformed hex colour ${hex}`);

/* -------------------------------------------------------------- regions */

/** Validates raw regions.json content. */
export const validateRegions = (raw: unknown): Region[] => {
  const items = array(raw, 'regions');
  if (items.length === 0) fail('regions', 'expected at least one region');
  const ids = new Set<string>();
  const cityOwner = new Map<string, string>();
  const stateOwner = new Map<string, string>();
  return items.map((item, i) => {
    const path = `regions[${i}]`;
    const obj = record(item, path);
    const id = str(obj, 'id', path);
    if (ids.has(id)) fail(`${path}.id`, `duplicate region id "${id}"`);
    ids.add(id);
    const region: Region = {
      id,
      name: str(obj, 'name', path),
      states: strArray(obj, 'states', path, 1),
      cities: strArray(obj, 'cities', path, 1),
      climates: strArray(obj, 'climates', path, 1).map((c, k) =>
        (CLIMATES as readonly string[]).includes(c) ? (c as Climate) : fail(`${path}.climates[${k}]`, `unknown climate "${c}"`),
      ),
    };
    for (const city of region.cities) {
      const owner = cityOwner.get(city);
      if (owner !== undefined) fail(`${path}.cities`, `city "${city}" is already listed under region "${owner}"`);
      cityOwner.set(city, id);
    }
    for (const state of region.states) {
      if (!/^[A-Z]{2}$/.test(state)) fail(`${path}.states`, `"${state}" is not a two-letter state code`);
      const owner = stateOwner.get(state);
      if (owner !== undefined) fail(`${path}.states`, `state "${state}" is already listed under region "${owner}"`);
      stateOwner.set(state, id);
    }
    return region;
  });
};

/* ------------------------------------------------------------- colleges */

/** Validates raw colleges.json content against the known regions. */
export const validateColleges = (raw: unknown, regions: readonly Region[]): College[] => {
  const items = array(raw, 'colleges');
  if (items.length === 0) fail('colleges', 'expected at least one college');
  const regionIds = new Set(regions.map((r) => r.id));
  const names = new Set<string>();
  return items.map((item, i) => {
    const path = `colleges[${i}]`;
    const obj = record(item, path);
    const name = str(obj, 'name', path);
    if (names.has(name)) fail(`${path}.name`, `duplicate college "${name}"`);
    names.add(name);
    const region = str(obj, 'region', path);
    if (!regionIds.has(region)) fail(`${path}.region`, `unknown region "${region}"`);
    return { name, region };
  });
};

/* ---------------------------------------------------------------- teams */

const validateConferences = (raw: unknown): ConferenceTemplate[] => {
  const items = array(raw, 'conferences');
  if (items.length !== CONFERENCE_COUNT) fail('conferences', `expected exactly ${CONFERENCE_COUNT} conferences, got ${items.length}`);
  const names = new Set<string>();
  return items.map((item, i) => {
    const path = `conferences[${i}]`;
    const obj = record(item, path);
    const name = str(obj, 'name', path);
    if (names.has(name)) fail(`${path}.name`, `duplicate conference "${name}"`);
    names.add(name);
    const divisions = strArray(obj, 'divisions', path, DIVISIONS_PER_CONFERENCE, DIVISIONS_PER_CONFERENCE);
    if (new Set(divisions).size !== divisions.length) fail(`${path}.divisions`, 'division names must be unique');
    return { name, divisions };
  });
};

const validateStadium = (raw: unknown, path: string, region: Region): StadiumTemplate => {
  const obj = record(raw, path);
  const climate = enumOf(obj, 'climate', path, CLIMATES);
  if (!region.climates.includes(climate)) {
    fail(`${path}.climate`, `"${climate}" is not consistent with region "${region.id}" (allowed: ${region.climates.join(', ')})`);
  }
  return {
    name: str(obj, 'name', path),
    capacity: int(obj, 'capacity', path, STADIUM_CAPACITY_RANGE[0], STADIUM_CAPACITY_RANGE[1]),
    fieldType: enumOf(obj, 'fieldType', path, FIELD_TYPES),
    roof: enumOf(obj, 'roof', path, ROOF_TYPES),
    climate,
    atmosphere: int(obj, 'atmosphere', path, ATMOSPHERE_RANGE[0], ATMOSPHERE_RANGE[1]),
    yearBuilt: int(obj, 'yearBuilt', path, YEAR_BUILT_RANGE[0], YEAR_BUILT_RANGE[1]),
  };
};

const validateColors = (raw: unknown, path: string): TeamColors => {
  const obj = record(raw, path);
  const colors = {} as TeamColors;
  for (const key of COLOR_KEYS) colors[key] = hexColor(obj, key, path);
  const contrast = colorDistance(rgbOf(colors.primary), rgbOf(colors.secondary));
  if (contrast < MIN_JERSEY_CONTRAST) {
    fail(path, `primary and secondary are too similar (distance ${contrast.toFixed(0)} < ${MIN_JERSEY_CONTRAST})`);
  }
  const fromGrass = colorDistance(rgbOf(colors.primary), rgbOf(FIELD_GREEN));
  if (fromGrass < MIN_FIELD_COLOR_DISTANCE) {
    fail(`${path}.primary`, `too close to the field green (distance ${fromGrass.toFixed(0)} < ${MIN_FIELD_COLOR_DISTANCE})`);
  }
  return colors;
};

const validateTeam = (raw: unknown, i: number, regions: ReadonlyMap<string, Region>, conferences: readonly ConferenceTemplate[]): TeamTemplate => {
  const path = `teams[${i}]`;
  const obj = record(raw, path);
  const abbr = str(obj, 'abbr', path);
  if (!/^[A-Z]{3}$/.test(abbr)) fail(`${path}.abbr`, `"${abbr}" must be exactly three uppercase letters`);
  const conference = str(obj, 'conference', path);
  const conf = conferences.find((c) => c.name === conference) ?? fail(`${path}.conference`, `unknown conference "${conference}"`);
  const division = str(obj, 'division', path);
  if (!conf.divisions.includes(division)) fail(`${path}.division`, `division "${division}" is not declared for conference "${conference}"`);
  const regionId = str(obj, 'region', path);
  const region = regions.get(regionId) ?? fail(`${path}.region`, `unknown region "${regionId}"`);
  const city = str(obj, 'city', path);
  if (!region.cities.includes(city)) fail(`${path}.city`, `"${city}" is not listed under region "${regionId}"`);
  return {
    city,
    name: str(obj, 'name', path),
    abbr,
    conference,
    division,
    colors: validateColors(obj['colors'], `${path}.colors`),
    logoSeed: int(obj, 'logoSeed', path, 0, Number.MAX_SAFE_INTEGER),
    region: regionId,
    marketSize: enumOf(obj, 'marketSize', path, MARKET_SIZES),
    stadium: validateStadium(obj['stadium'], `${path}.stadium`, region),
    rivalAbbrs: strArray(obj, 'rivalAbbrs', path, 1, 2),
  };
};

/** Cross-team checks: unique abbrs, 4 teams per declared division, rivals inside the division, distinct kits. */
const validateLeagueStructure = (teams: readonly TeamTemplate[], conferences: readonly ConferenceTemplate[]): void => {
  const byAbbr = new Map<string, number>();
  teams.forEach((t, i) => {
    const prev = byAbbr.get(t.abbr);
    if (prev !== undefined) fail(`teams[${i}].abbr`, `duplicate abbr "${t.abbr}" (already used by teams[${prev}])`);
    byAbbr.set(t.abbr, i);
  });
  const divisionKey = (t: TeamTemplate): string => `${t.conference}/${t.division}`;
  const groups = new Map<string, TeamTemplate[]>();
  for (const c of conferences) for (const d of c.divisions) groups.set(`${c.name}/${d}`, []);
  for (const t of teams) groups.get(divisionKey(t))?.push(t);
  for (const [key, members] of groups) {
    if (members.length !== TEAMS_PER_DIVISION) {
      fail('teams', `unbalanced divisions: ${key} has ${members.length} teams (expected ${TEAMS_PER_DIVISION})`);
    }
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const d = colorDistance(rgbOf(members[a]!.colors.primary), rgbOf(members[b]!.colors.primary));
        if (d < MIN_DIVISION_COLOR_DISTANCE) {
          fail('teams', `primary colours of ${members[a]!.abbr} and ${members[b]!.abbr} (${key}) are too similar (distance ${d.toFixed(0)} < ${MIN_DIVISION_COLOR_DISTANCE})`);
        }
      }
    }
  }
  teams.forEach((t, i) => {
    t.rivalAbbrs.forEach((r, k) => {
      const path = `teams[${i}].rivalAbbrs[${k}]`;
      if (r === t.abbr) fail(path, `${t.abbr} cannot rival itself`);
      const idx = byAbbr.get(r) ?? fail(path, `rival "${r}" does not exist`);
      const other = teams[idx]!;
      if (divisionKey(other) !== divisionKey(t)) {
        fail(path, `rival "${r}" is not in the same division (${divisionKey(t)} vs ${divisionKey(other)})`);
      }
    });
    if (new Set(t.rivalAbbrs).size !== t.rivalAbbrs.length) fail(`teams[${i}].rivalAbbrs`, 'rivals must be unique');
  });
};

/** Validates raw teams.json content against the known regions. */
export const validateTeamDataset = (raw: unknown, regions: readonly Region[]): TeamDataset => {
  const root = record(raw, 'teams.json');
  const conferences = validateConferences(root['conferences']);
  const items = array(root['teams'], 'teams');
  if (items.length !== LEAGUE_TEAM_COUNT) fail('teams', `expected exactly ${LEAGUE_TEAM_COUNT} teams, got ${items.length}`);
  const regionMap = new Map(regions.map((r) => [r.id, r] as const));
  const teams = items.map((item, i) => validateTeam(item, i, regionMap, conferences));
  validateLeagueStructure(teams, conferences);
  return { conferences, teams };
};

/* -------------------------------------------------------------- loaders */

/** All US regions, validated. Fresh objects on every call. */
export const loadRegions = (): Region[] => validateRegions(regionsJson);

/** All fictional colleges, validated against the regions. */
export const loadColleges = (): College[] => validateColleges(collegesJson, loadRegions());

/** Conference structure plus the 32 validated team templates. */
export const loadTeamDataset = (): TeamDataset => validateTeamDataset(teamsJson, loadRegions());

/** The 32 validated team templates in authored order (conference, then division). */
export const loadTeamData = (): TeamTemplate[] => loadTeamDataset().teams;

/** Looks a template up by abbreviation (case-insensitive). */
export const findTeamTemplate = (abbr: string, teams: readonly TeamTemplate[] = loadTeamData()): TeamTemplate | undefined => {
  const key = abbr.toUpperCase();
  return teams.find((t) => t.abbr === key);
};

/** Colleges located in one region (empty when the region has none). */
export const collegesInRegion = (regionId: string, colleges: readonly College[] = loadColleges()): College[] =>
  colleges.filter((c) => c.region === regionId);
