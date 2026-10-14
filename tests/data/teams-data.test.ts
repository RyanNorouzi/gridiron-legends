import { describe, expect, it } from 'vitest';
import teamsJson from '@/data/teams.json';
import {
  ATMOSPHERE_RANGE,
  CONFERENCE_COUNT,
  DIVISIONS_PER_CONFERENCE,
  DataValidationError,
  LEAGUE_TEAM_COUNT,
  MIN_DIVISION_COLOR_DISTANCE,
  MIN_JERSEY_CONTRAST,
  STADIUM_CAPACITY_RANGE,
  TEAMS_PER_DIVISION,
  colorDistance,
  findTeamTemplate,
  loadRegions,
  loadTeamData,
  loadTeamDataset,
  parseHexColor,
  validateTeamDataset,
  type TeamTemplate,
} from '@/teams/data';

type RawTeam = Record<string, unknown> & { stadium: Record<string, unknown>; colors: Record<string, unknown> };
interface RawDataset {
  conferences: { name: string; divisions: string[] }[];
  teams: RawTeam[];
}

/** Deep copy of the shipped JSON, loosely typed so tests can corrupt individual fields. */
const rawCopy = (): RawDataset => structuredClone(teamsJson) as unknown as RawDataset;
const regions = loadRegions();
const validate = (raw: unknown): TeamTemplate[] => validateTeamDataset(raw, regions).teams;
const expectError = (raw: unknown, pattern: RegExp): void => {
  expect(() => validate(raw)).toThrow(DataValidationError);
  expect(() => validate(raw)).toThrow(pattern);
};

describe('teams.json content', () => {
  const teams = loadTeamData();
  const dataset = loadTeamDataset();

  it('loads exactly 32 teams with unique three-letter abbreviations', () => {
    expect(teams).toHaveLength(LEAGUE_TEAM_COUNT);
    const abbrs = new Set(teams.map((t) => t.abbr));
    expect(abbrs.size).toBe(LEAGUE_TEAM_COUNT);
    for (const t of teams) expect(t.abbr).toMatch(/^[A-Z]{3}$/);
  });

  it('has two conferences of four divisions of four teams', () => {
    expect(dataset.conferences).toHaveLength(CONFERENCE_COUNT);
    for (const conf of dataset.conferences) {
      expect(conf.divisions).toHaveLength(DIVISIONS_PER_CONFERENCE);
      for (const div of conf.divisions) {
        const members = teams.filter((t) => t.conference === conf.name && t.division === div);
        expect(members, `${conf.name}/${div}`).toHaveLength(TEAMS_PER_DIVISION);
      }
    }
    for (const t of teams) {
      const conf = dataset.conferences.find((c) => c.name === t.conference);
      expect(conf, t.abbr).toBeDefined();
      expect(conf!.divisions).toContain(t.division);
    }
  });

  it('uses unique city + nickname combinations and non-empty names', () => {
    const full = new Set(teams.map((t) => `${t.city} ${t.name}`));
    expect(full.size).toBe(LEAGUE_TEAM_COUNT);
    const nicknames = new Set(teams.map((t) => t.name));
    expect(nicknames.size).toBe(LEAGUE_TEAM_COUNT);
    for (const t of teams) {
      expect(t.city.length).toBeGreaterThan(1);
      expect(t.name.length).toBeGreaterThan(2);
    }
  });

  it('never reuses a well-known real pro or college nickname', () => {
    const banned = new Set(
      [
        'Patriots', 'Giants', 'Eagles', 'Bills', 'Ravens', 'Steelers', 'Browns', 'Bengals', 'Jets', 'Dolphins', 'Jaguars',
        'Titans', 'Texans', 'Colts', 'Chiefs', 'Raiders', 'Chargers', 'Broncos', 'Cowboys', 'Commanders', 'Redskins', 'Lions',
        'Packers', 'Bears', 'Vikings', 'Falcons', 'Panthers', 'Saints', 'Buccaneers', '49ers', 'Seahawks', 'Rams', 'Cardinals',
        'Bulldogs', 'Tigers', 'Wildcats', 'Wolverines', 'Buckeyes', 'Longhorns', 'Sooners', 'Trojans', 'Ducks', 'Huskies',
        'Gators', 'Seminoles', 'Hurricanes', 'Volunteers', 'Aggies', 'Badgers', 'Hawkeyes', 'Cornhuskers', 'Spartans',
        'Statesmen', 'Tarpons', 'Archers', 'Bighorns', 'Steelheads', 'Warriors', 'Knights', 'Cougars', 'Mustangs', 'Pirates',
      ].map((n) => n.toLowerCase()),
    );
    for (const t of teams) expect(banned.has(t.name.toLowerCase()), `${t.city} ${t.name}`).toBe(false);
  });

  it('ships colours that parse as #RRGGBB and stay distinguishable inside each division', () => {
    for (const t of teams) {
      for (const key of ['primary', 'secondary', 'accent', 'helmet'] as const) {
        const rgb = parseHexColor(t.colors[key]);
        expect(rgb, `${t.abbr}.${key}`).not.toBeNull();
        for (const ch of [rgb!.r, rgb!.g, rgb!.b]) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
      const contrast = colorDistance(parseHexColor(t.colors.primary)!, parseHexColor(t.colors.secondary)!);
      expect(contrast, t.abbr).toBeGreaterThanOrEqual(MIN_JERSEY_CONTRAST);
    }
    for (const conf of dataset.conferences) {
      for (const div of conf.divisions) {
        const members = teams.filter((t) => t.conference === conf.name && t.division === div);
        for (let a = 0; a < members.length; a++) {
          for (let b = a + 1; b < members.length; b++) {
            const d = colorDistance(parseHexColor(members[a]!.colors.primary)!, parseHexColor(members[b]!.colors.primary)!);
            expect(d, `${members[a]!.abbr} vs ${members[b]!.abbr}`).toBeGreaterThanOrEqual(MIN_DIVISION_COLOR_DISTANCE);
          }
        }
      }
    }
  });

  it('keeps stadium values inside the documented ranges and climates consistent with the region', () => {
    for (const t of teams) {
      const s = t.stadium;
      expect(s.capacity).toBeGreaterThanOrEqual(STADIUM_CAPACITY_RANGE[0]);
      expect(s.capacity).toBeLessThanOrEqual(STADIUM_CAPACITY_RANGE[1]);
      expect(s.atmosphere).toBeGreaterThanOrEqual(ATMOSPHERE_RANGE[0]);
      expect(s.atmosphere).toBeLessThanOrEqual(ATMOSPHERE_RANGE[1]);
      expect(['grass', 'turf']).toContain(s.fieldType);
      expect(['open', 'dome', 'retractable']).toContain(s.roof);
      expect(s.yearBuilt).toBeGreaterThan(1900);
      const region = regions.find((r) => r.id === t.region);
      expect(region, t.abbr).toBeDefined();
      expect(region!.climates, `${t.abbr} climate`).toContain(s.climate);
      expect(region!.cities, `${t.abbr} city`).toContain(t.city);
      if (s.roof === 'dome') expect(s.fieldType).toBe('turf');
    }
    const stadiumNames = new Set(teams.map((t) => t.stadium.name));
    expect(stadiumNames.size).toBe(LEAGUE_TEAM_COUNT);
  });

  it('lists 1..2 rivals per team, all from the same division and never itself', () => {
    for (const t of teams) {
      expect(t.rivalAbbrs.length).toBeGreaterThanOrEqual(1);
      expect(t.rivalAbbrs.length).toBeLessThanOrEqual(2);
      for (const r of t.rivalAbbrs) {
        expect(r).not.toBe(t.abbr);
        const other = teams.find((x) => x.abbr === r);
        expect(other, `${t.abbr} rival ${r}`).toBeDefined();
        expect(other!.conference).toBe(t.conference);
        expect(other!.division).toBe(t.division);
      }
    }
  });

  it('covers every market size and every region at least once', () => {
    const markets = new Set(teams.map((t) => t.marketSize));
    expect([...markets].sort()).toEqual(['large', 'medium', 'small']);
    const used = new Set(teams.map((t) => t.region));
    for (const r of regions) expect(used, r.id).toContain(r.id);
    const seeds = new Set(teams.map((t) => t.logoSeed));
    expect(seeds.size).toBe(LEAGUE_TEAM_COUNT);
  });

  it('returns fresh objects on every load', () => {
    const a = loadTeamData();
    a[0]!.abbr = 'ZZZ';
    a[0]!.rivalAbbrs.push('QQQ');
    const b = loadTeamData();
    expect(b[0]!.abbr).not.toBe('ZZZ');
    expect(b[0]!.rivalAbbrs).not.toContain('QQQ');
  });

  it('findTeamTemplate is case-insensitive and undefined for unknown abbrs', () => {
    const first = teams[0]!;
    expect(findTeamTemplate(first.abbr.toLowerCase())?.city).toBe(first.city);
    expect(findTeamTemplate('???')).toBeUndefined();
  });
});

describe('parseHexColor', () => {
  it('parses upper and lower case and rejects malformed input', () => {
    expect(parseHexColor('#FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHexColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHexColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    for (const bad of ['FF8000', '#FFF', '#GG0000', '#FF80001', 'red', '', '#ff 000']) {
      expect(parseHexColor(bad), bad).toBeNull();
    }
  });

  it('colorDistance is symmetric and zero for identical colours', () => {
    const a = { r: 10, g: 20, b: 30 };
    const b = { r: 13, g: 24, b: 30 };
    expect(colorDistance(a, a)).toBe(0);
    expect(colorDistance(a, b)).toBeCloseTo(5);
    expect(colorDistance(a, b)).toBe(colorDistance(b, a));
  });
});

describe('validateTeamDataset error classes', () => {
  it('accepts the shipped data', () => {
    expect(validate(rawCopy())).toHaveLength(LEAGUE_TEAM_COUNT);
  });

  it('rejects a league that is not exactly 32 teams', () => {
    const fewer = rawCopy();
    fewer.teams.pop();
    expectError(fewer, /expected exactly 32 teams, got 31/);
    const more = rawCopy();
    more.teams.push(structuredClone(more.teams[0]!));
    expectError(more, /expected exactly 32 teams, got 33/);
  });

  it('rejects duplicate abbreviations', () => {
    const c = rawCopy();
    c.teams[5]!.abbr = c.teams[0]!.abbr;
    expectError(c, /teams\[5\]\.abbr: duplicate abbr/);
  });

  it('rejects abbreviations that are not three uppercase letters', () => {
    for (const bad of ['bos', 'BO', 'BOST', 'B0S']) {
      const c = rawCopy();
      c.teams[0]!.abbr = bad;
      expectError(c, /three uppercase letters/);
    }
  });

  it('rejects malformed hex colours in any colour slot', () => {
    for (const [key, bad] of [['primary', '#12G45Z'], ['secondary', 'red'], ['accent', '#FFF'], ['helmet', 123]] as const) {
      const c = rawCopy();
      c.teams[3]!.colors[key] = bad;
      expectError(c, new RegExp(`teams\\[3\\]\\.colors\\.${key}: malformed hex colour`));
    }
  });

  it('rejects unbalanced divisions', () => {
    const c = rawCopy();
    // Move a team from its division into a sibling division of the same conference.
    const t = c.teams[0]!;
    const conf = c.conferences.find((x) => x.name === t['conference'])!;
    t['division'] = conf.divisions.find((d) => d !== t['division'])!;
    expectError(c, /unbalanced divisions/);
  });

  it('rejects a division that its conference does not declare', () => {
    const c = rawCopy();
    c.teams[0]!['division'] = 'Nowhere';
    expectError(c, /division "Nowhere" is not declared for conference/);
  });

  it('rejects an unknown conference', () => {
    const c = rawCopy();
    c.teams[0]!['conference'] = 'Galactic';
    expectError(c, /unknown conference "Galactic"/);
  });

  it('rejects an unknown region and a city outside its region', () => {
    const c = rawCopy();
    c.teams[7]!['region'] = 'atlantis';
    expectError(c, /teams\[7\]\.region: unknown region "atlantis"/);
    const d = rawCopy();
    d.teams[7]!['city'] = 'Nowhere Falls';
    expectError(d, /teams\[7\]\.city: "Nowhere Falls" is not listed under region/);
  });

  it('rejects rivals outside the division, unknown rivals, self-rivalry and bad counts', () => {
    const c = rawCopy();
    const t = c.teams[0]!;
    const outsider = c.teams.find((x) => x['division'] !== t['division'])!;
    t['rivalAbbrs'] = [outsider['abbr']];
    expectError(c, /rival ".*" is not in the same division/);

    const d = rawCopy();
    d.teams[0]!['rivalAbbrs'] = ['QQQ'];
    expectError(d, /rival "QQQ" does not exist/);

    const e = rawCopy();
    e.teams[0]!['rivalAbbrs'] = [e.teams[0]!['abbr']];
    expectError(e, /cannot rival itself/);

    const f = rawCopy();
    f.teams[0]!['rivalAbbrs'] = [];
    expectError(f, /rivalAbbrs: expected 1\.\.2 entries/);

    const g = rawCopy();
    const sameDiv = c.teams.filter((x) => x['division'] === t['division'] && x['abbr'] !== t['abbr']).map((x) => x['abbr'] as string);
    g.teams[0]!['rivalAbbrs'] = sameDiv.slice(0, 3);
    expectError(g, /rivalAbbrs: expected 1\.\.2 entries/);

    const h = rawCopy();
    h.teams[0]!['rivalAbbrs'] = [sameDiv[0]!, sameDiv[0]!];
    expectError(h, /rivals must be unique/);
  });

  it('rejects stadium values outside their ranges', () => {
    const cases: [string, unknown, RegExp][] = [
      ['capacity', 30000, /capacity: 30000 is outside/],
      ['capacity', 99000, /capacity: 99000 is outside/],
      ['capacity', 'big', /capacity: expected an integer/],
      ['atmosphere', 12, /atmosphere: 12 is outside/],
      ['atmosphere', 99, /atmosphere: 99 is outside/],
      ['yearBuilt', 1850, /yearBuilt: 1850 is outside/],
      ['roof', 'tent', /roof: expected one of open, dome, retractable/],
      ['fieldType', 'dirt', /fieldType: expected one of grass, turf/],
      ['climate', 'tropical', /climate: expected one of/],
    ];
    for (const [key, value, pattern] of cases) {
      const c = rawCopy();
      c.teams[2]!.stadium[key] = value;
      expectError(c, pattern);
    }
  });

  it('rejects a climate that is inconsistent with the region', () => {
    const c = rawCopy();
    const t = c.teams.find((x) => x['region'] === 'northeast')!;
    t.stadium['climate'] = 'desert';
    expectError(c, /climate: "desert" is not consistent with region "northeast"/);
  });

  it('rejects primaries that would be indistinguishable inside a division', () => {
    const c = rawCopy();
    const t = c.teams[0]!;
    const mate = c.teams.find((x) => x !== t && x['division'] === t['division'] && x['conference'] === t['conference'])!;
    mate.colors['primary'] = t.colors['primary'];
    expectError(c, /primary colours of .* are too similar/);
  });

  it('rejects a kit whose secondary cannot be read against its primary, or a grass-coloured primary', () => {
    const c = rawCopy();
    c.teams[1]!.colors['secondary'] = c.teams[1]!.colors['primary'];
    expectError(c, /primary and secondary are too similar/);
    const d = rawCopy();
    d.teams[1]!.colors['primary'] = '#2E7D32';
    expectError(d, /too close to the field green/);
  });

  it('rejects malformed roots, conferences and market sizes', () => {
    expectError(null, /teams\.json: expected an object/);
    expectError([], /teams\.json: expected an object/);
    expectError({ conferences: [], teams: [] }, /expected exactly 2 conferences/);
    const c = rawCopy();
    c.conferences[0]!.divisions = c.conferences[0]!.divisions.slice(0, 3);
    expectError(c, /divisions: expected 4\.\.4 entries/);
    const d = rawCopy();
    d.conferences[1]!.name = d.conferences[0]!.name;
    expectError(d, /duplicate conference/);
    const e = rawCopy();
    e.teams[0]!['marketSize'] = 'huge';
    expectError(e, /marketSize: expected one of small, medium, large/);
    const f = rawCopy();
    f.teams[0]!['logoSeed'] = 1.5;
    expectError(f, /logoSeed: expected an integer/);
  });

  it('reports the offending path on the error object', () => {
    const c = rawCopy();
    c.teams[9]!['region'] = 'mars';
    try {
      validate(c);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DataValidationError);
      expect((err as DataValidationError).path).toBe('teams[9].region');
      expect((err as DataValidationError).name).toBe('DataValidationError');
    }
  });
});
