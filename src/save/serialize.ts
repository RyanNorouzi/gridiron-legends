import type { Settings } from '@/core/settings';
import { SEASON_PHASE_ORDER, type League, type SeasonPhase } from '@/franchise/types';
import type { GamePhase, GameState } from '@/game/types';
import { compactLeagueStatLines, expandLeagueStatLines } from '@/statistics/compact';
import { CURRENT_GAME_SAVE_VERSION, CURRENT_SAVE_VERSION, LEAGUE_DATA_VERSION, migrate } from './migrations';
import { SaveError } from './storage';

export { SaveError, type SaveErrorCode } from './storage';

/**
 * Serialization for League (franchise saves), GameState (mid-game autosave) and Settings.
 * Output is canonical JSON: keys sorted at every level, no whitespace, so two saves of the same state
 * are byte-identical and diffable. Functions, undefined, symbols, bigints, non-finite numbers and class
 * instances are rejected with a SaveError carrying the JSON path. Branded ids are plain strings and
 * RngState is a 4-number array, so nothing needs custom encoding.
 */
type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const sub = (base: string, key: string | number): string =>
  typeof key === 'number' ? `${base}[${key}]` : IDENT.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

/* ------------------------------ stable JSON ------------------------------ */

/** JSON.stringify with sorted keys and strict value checking (see module doc). */
export const stableStringify = (value: unknown, path = '$'): string => {
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new SaveError('invalidValue', path, `non-finite number ${value} cannot be saved`);
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) return `[${value.map((v: unknown, i) => stableStringify(v, sub(path, i))).join(',')}]`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new SaveError('invalidValue', path, 'class instances cannot be saved; use plain objects');
      const obj = value as Raw;
      const parts: string[] = [];
      for (const k of Object.keys(obj).sort()) parts.push(`${JSON.stringify(k)}:${stableStringify(obj[k], sub(path, k))}`);
      return `{${parts.join(',')}}`;
    }
    case 'undefined': throw new SaveError('invalidValue', path, 'undefined cannot be saved; use null');
    default: throw new SaveError('invalidValue', path, `${typeof value} values cannot be saved`);
  }
};

/* ------------------------------ LZW packer ------------------------------ */
/**
 * String packer (LZW variant) tuned for JSON text and for localStorage, which counts UTF-16 code units:
 *   - every emitted token is ONE code unit: `BASE + code` where code < MAX_CODE, so all tokens sit in
 *     U+0100..U+D6FF (never a surrogate, never a control character);
 *   - codes 0..255 are literal code units, 256 = ESCAPE (the following code unit is a raw character
 *     >= 256 seen for the first time, which then becomes a dictionary entry), 257 = CLEAR (dictionary reset,
 *     emitted when the table is full), 258.. = learned phrases;
 *   - the header `GLZ1:<originalLength>:` lets `unpackString` verify the decoded length.
 * Typical league JSON shrinks 3-5x in code units. The packer is deterministic and dependency-free.
 * Escaped raw characters may be lone surrogate halves, so packed text is safe in UTF-16 stores (localStorage,
 * IndexedDB) but must NOT be UTF-8 encoded (files, network); exports therefore stay uncompressed.
 */
const BASE = 0x100;
const ESCAPE = 256;
const CLEAR = 257;
const FIRST_CODE = 258;
const MAX_CODE = 0xd800 - BASE;
export const COMPRESSED_PREFIX = 'GLZ1:';
const CHUNK = 8192;

const unitsToString = (units: number[]): string => {
  let s = '';
  for (let i = 0; i < units.length; i += CHUNK) s += String.fromCharCode(...units.slice(i, i + CHUNK));
  return s;
};

/** Compresses any string; `unpackString` restores it exactly. */
export const packString = (text: string): string => {
  const units: number[] = [];
  const dict = new Map<number, number>();
  const singles = new Map<number, number>();
  let next = FIRST_CODE;
  const reset = (): void => { dict.clear(); singles.clear(); next = FIRST_CODE; };
  const emit = (code: number): void => { units.push(BASE + code); };
  const addPhrase = (w: number, c: number): void => {
    if (next >= MAX_CODE) { emit(CLEAR); reset(); } else dict.set(w * 0x10000 + c, next++);
  };
  const escape = (c: number): void => {
    if (next >= MAX_CODE) { emit(CLEAR); reset(); }
    emit(ESCAPE);
    units.push(c);
    singles.set(c, next++);
  };
  let w = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const single = c < 256 ? c : singles.get(c);
    if (single === undefined) {
      if (w !== -1) { emit(w); addPhrase(w, c); w = -1; }
      escape(c);
      continue;
    }
    if (w === -1) { w = single; continue; }
    const found = dict.get(w * 0x10000 + c);
    if (found !== undefined) { w = found; continue; }
    emit(w);
    addPhrase(w, c);
    const again = c < 256 ? c : singles.get(c); // a reset inside addPhrase may have dropped the single
    if (again === undefined) { w = -1; escape(c); } else w = again;
  }
  if (w !== -1) emit(w);
  return `${COMPRESSED_PREFIX}${text.length}:${unitsToString(units)}`;
};

/** True when `text` was produced by `packString`. */
export const isCompressed = (text: string): boolean => text.startsWith(COMPRESSED_PREFIX);

const corrupt = (detail: string): SaveError => new SaveError('compression', '$', `compressed save is corrupt: ${detail}`);

/** Inverse of `packString`; throws SaveError('compression') on malformed input. */
export const unpackString = (packed: string): string => {
  if (!isCompressed(packed)) throw corrupt('missing header');
  const sep = packed.indexOf(':', COMPRESSED_PREFIX.length);
  const expected = Number(packed.slice(COMPRESSED_PREFIX.length, sep));
  if (sep < 0 || !Number.isInteger(expected) || expected < 0) throw corrupt('bad length header');
  const phrases: (string | undefined)[] = [];
  let next = FIRST_CODE;
  const reset = (): void => {
    phrases.length = 0;
    for (let i = 0; i < 256; i++) phrases[i] = String.fromCharCode(i);
    next = FIRST_CODE;
  };
  reset();
  const chunks: string[] = [];
  let prev = '';
  for (let i = sep + 1; i < packed.length; ) {
    const code = packed.charCodeAt(i++) - BASE;
    if (code === CLEAR) { reset(); prev = ''; continue; }
    if (code === ESCAPE) {
      if (i >= packed.length) throw corrupt('escape at end of stream');
      const ch = packed.charAt(i++);
      chunks.push(ch);
      if (prev && next < MAX_CODE) phrases[next++] = prev + ch;
      if (next >= MAX_CODE) throw corrupt('dictionary overflow');
      phrases[next++] = ch;
      prev = '';
      continue;
    }
    if (code < 0 || code >= MAX_CODE) throw corrupt(`code ${code} out of range`);
    let entry = phrases[code];
    if (entry === undefined) {
      if (code === next && prev) entry = prev + prev.charAt(0);
      else throw corrupt(`unknown code ${code}`);
    }
    chunks.push(entry);
    if (prev && next < MAX_CODE) phrases[next++] = prev + entry.charAt(0);
    prev = entry;
  }
  const out = chunks.join('');
  if (out.length !== expected) throw corrupt(`decoded length ${out.length}, header says ${expected}`);
  return out;
};

/**
 * Storage footprint of a serialized string in bytes. 'utf16' (default) is what localStorage / IndexedDB
 * charge (2 bytes per code unit); 'utf8' is the on-disk size of an exported file.
 */
export const estimateSize = (text: string, encoding: 'utf16' | 'utf8' = 'utf16'): number => {
  if (encoding === 'utf16') return text.length * 2;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
};

/* ------------------------------ validators ------------------------------ */

type Kind = 'string' | 'number' | 'boolean' | 'record' | 'array' | 'string?' | 'record?';
const fail = (path: string, msg: string): never => { throw new SaveError('validation', path, msg); };
const rec = (v: unknown, path: string): Raw => (isRecord(v) ? v : fail(path, 'expected an object'));
const arr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : fail(path, 'expected an array'));
const str = (v: unknown, path: string): string => (typeof v === 'string' ? v : fail(path, 'expected a string'));
const num = (v: unknown, path: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(path, 'expected a finite number'));
const has = (table: Raw, id: string): boolean => Object.prototype.hasOwnProperty.call(table, id);

const shape = (obj: Raw, path: string, spec: Record<string, Kind>): void => {
  for (const [k, kind] of Object.entries(spec)) {
    const v = obj[k];
    const p = sub(path, k);
    if (kind.endsWith('?') && v === null) continue;
    const base = kind.replace('?', '');
    if (base === 'record') rec(v, p);
    else if (base === 'array') arr(v, p);
    else if (base === 'number') num(v, p);
    else if (typeof v !== base) fail(p, `expected ${kind === base ? 'a ' + base : base + ' or null'}`);
  }
};

const ref = (id: unknown, path: string, table: Raw, what: string): string => {
  const s = str(id, path);
  return has(table, s) ? s : fail(path, `references unknown ${what} "${s}"`);
};
const refOrNull = (id: unknown, path: string, table: Raw, what: string): string | null => (id === null ? null : ref(id, path, table, what));
const refList = (v: unknown, path: string, table: Raw, what: string): string[] => arr(v, path).map((id, i) => ref(id, sub(path, i), table, what));
const refKeys = (v: unknown, path: string, table: Raw, what: string): Raw => {
  const r = rec(v, path);
  for (const k of Object.keys(r)) if (!has(table, k)) fail(sub(path, k), `key references unknown ${what} "${k}"`);
  return r;
};
const idMatches = (entry: Raw, key: string, path: string): void => {
  if (entry.id !== key) fail(sub(path, 'id'), `id "${String(entry.id)}" does not match its key "${key}"`);
};
const rngState = (v: unknown, path: string): void => {
  const a = arr(v, path);
  if (a.length !== 4) fail(path, 'rng state must have 4 entries');
  a.forEach((x, i) => num(x, sub(path, i)));
};

const LEAGUE_SHAPE: Record<string, Kind> = {
  id: 'string', name: 'string', settings: 'record', year: 'number', teams: 'record', players: 'record',
  retiredPlayers: 'record', coaches: 'record', stadiums: 'record', season: 'record', freeAgentIds: 'array',
  draft: 'record?', freeAgency: 'record?', pendingTrades: 'array', userTeamId: 'string?', history: 'array',
  records: 'array', hallOfFame: 'array', events: 'array', careerStats: 'record', customPlaybooks: 'array',
  customOffensePlays: 'array', customDefensePlays: 'array', playLogs: 'record', rngSeed: 'number', rngState: 'array',
};
const SEASON_SHAPE: Record<string, Kind> = {
  year: 'number', phase: 'string', week: 'number', schedule: 'array', standings: 'record', bracket: 'record?',
  champion: 'string?', awards: 'array', stats: 'record', playoffStats: 'record', teamStats: 'record',
};

const validateTeams = (L: Raw): Map<string, Set<string>> => {
  const teams = L.teams as Raw, players = L.players as Raw, coaches = L.coaches as Raw, stadiums = L.stadiums as Raw;
  const rosters = new Map<string, Set<string>>();
  for (const [tid, t0] of Object.entries(teams)) {
    const p = sub('$.teams', tid);
    const t = rec(t0, p);
    idMatches(t, tid, p);
    const roster = refList(t.rosterIds, `${p}.rosterIds`, players, 'player');
    const set = new Set<string>();
    roster.forEach((pid, i) => {
      const teamId = rec(players[pid], sub('$.players', pid)).teamId;
      if (teamId !== tid) fail(sub(`${p}.rosterIds`, i), `player "${pid}" is on the roster but has teamId ${JSON.stringify(teamId)}`);
      if (set.has(pid)) fail(sub(`${p}.rosterIds`, i), `player "${pid}" appears twice on the roster`);
      set.add(pid);
    });
    rosters.set(tid, set);
    ref(t.stadiumId, `${p}.stadiumId`, stadiums, 'stadium');
    refOrNull(t.headCoachId, `${p}.headCoachId`, coaches, 'coach');
    refList(t.staffIds, `${p}.staffIds`, coaches, 'coach');
    refList(t.rivalIds, `${p}.rivalIds`, teams, 'team');
    const depth = rec(t.depthChart, `${p}.depthChart`);
    for (const slot of Object.keys(depth)) {
      refList(depth[slot], sub(`${p}.depthChart`, slot), players, 'player').forEach((pid, i) => {
        if (!set.has(pid)) fail(sub(sub(`${p}.depthChart`, slot), i), `depth chart player "${pid}" is not on the roster`);
      });
    }
    arr(t.picks, `${p}.picks`).forEach((pk, i) => {
      const pick = rec(pk, sub(`${p}.picks`, i));
      ref(pick.originalTeamId, sub(`${p}.picks`, i) + '.originalTeamId', teams, 'team');
      ref(pick.ownerTeamId, sub(`${p}.picks`, i) + '.ownerTeamId', teams, 'team');
    });
  }
  return rosters;
};

const validatePeople = (L: Raw, rosters: Map<string, Set<string>>): void => {
  const teams = L.teams as Raw, players = L.players as Raw, retired = L.retiredPlayers as Raw, coaches = L.coaches as Raw;
  for (const [pid, p0] of Object.entries(players)) {
    const p = sub('$.players', pid);
    const pl = rec(p0, p);
    idMatches(pl, pid, p);
    if (has(retired, pid)) fail(p, `player "${pid}" is both active and retired`);
    const tid = refOrNull(pl.teamId, `${p}.teamId`, teams, 'team');
    if (tid !== null && !rosters.get(tid)?.has(pid)) fail(`${p}.teamId`, `player has teamId "${tid}" but is not on that team's roster`);
  }
  for (const [pid, p0] of Object.entries(retired)) idMatches(rec(p0, sub('$.retiredPlayers', pid)), pid, sub('$.retiredPlayers', pid));
  for (const [cid, c0] of Object.entries(coaches)) {
    const p = sub('$.coaches', cid);
    const c = rec(c0, p);
    idMatches(c, cid, p);
    refOrNull(c.teamId, `${p}.teamId`, teams, 'team');
  }
  for (const [sid, s0] of Object.entries(L.stadiums as Raw)) idMatches(rec(s0, sub('$.stadiums', sid)), sid, sub('$.stadiums', sid));
  refList(L.freeAgentIds, '$.freeAgentIds', players, 'player').forEach((pid, i) => {
    if ((players[pid] as Raw).teamId !== null) fail(sub('$.freeAgentIds', i), `free agent "${pid}" still has a teamId`);
  });
};

const validateSeasonAndHistory = (L: Raw): void => {
  const teams = L.teams as Raw, coaches = L.coaches as Raw;
  const anyPlayer: Raw = { ...(L.retiredPlayers as Raw), ...(L.players as Raw) };
  const s = rec(L.season, '$.season');
  shape(s, '$.season', SEASON_SHAPE);
  if (!SEASON_PHASE_ORDER.includes(s.phase as SeasonPhase)) fail('$.season.phase', `unknown season phase "${String(s.phase)}"`);
  arr(s.schedule, '$.season.schedule').forEach((g0, i) => {
    const p = sub('$.season.schedule', i);
    const g = rec(g0, p);
    shape(g, p, { id: 'string', week: 'number', isPlayoff: 'boolean', isPreseason: 'boolean', result: 'record?' });
    ref(g.home, `${p}.home`, teams, 'team');
    ref(g.away, `${p}.away`, teams, 'team');
  });
  const standings = refKeys(s.standings, '$.season.standings', teams, 'team');
  for (const tid of Object.keys(standings)) {
    if (rec(standings[tid], sub('$.season.standings', tid)).teamId !== tid) fail(sub('$.season.standings', tid) + '.teamId', 'standing teamId does not match its key');
  }
  refOrNull(s.champion, '$.season.champion', teams, 'team');
  refKeys(s.stats, '$.season.stats', anyPlayer, 'player');
  refKeys(s.playoffStats, '$.season.playoffStats', anyPlayer, 'player');
  refKeys(s.teamStats, '$.season.teamStats', teams, 'team');
  refOrNull(L.userTeamId, '$.userTeamId', teams, 'team');
  arr(L.history, '$.history').forEach((h0, i) => {
    const p = sub('$.history', i);
    const h = rec(h0, p);
    num(h.year, `${p}.year`);
    ref(h.champion, `${p}.champion`, teams, 'team');
    ref(h.runnerUp, `${p}.runnerUp`, teams, 'team');
    refOrNull(h.mvp, `${p}.mvp`, anyPlayer, 'player');
  });
  arr(L.records, '$.records').forEach((r0, i) => {
    const p = sub('$.records', i);
    const r = rec(r0, p);
    shape(r, p, { key: 'string', label: 'string', scope: 'string', value: 'number', holderName: 'string', year: 'number' });
    refOrNull(r.holderPlayerId, `${p}.holderPlayerId`, anyPlayer, 'player');
    refOrNull(r.holderTeamId, `${p}.holderTeamId`, teams, 'team');
  });
  arr(L.hallOfFame, '$.hallOfFame').forEach((h0, i) => {
    const p = sub('$.hallOfFame', i);
    const h = rec(h0, p);
    shape(h, p, { inductedYear: 'number', name: 'string', position: 'string', careerStats: 'record', awards: 'array' });
    ref(h.playerId, `${p}.playerId`, anyPlayer, 'player');
    refList(h.teams, `${p}.teams`, teams, 'team');
  });
  arr(L.events, '$.events').forEach((e0, i) => {
    const p = sub('$.events', i);
    const e = rec(e0, p);
    shape(e, p, { id: 'string', year: 'number', week: 'number', type: 'string', title: 'string', choices: 'array', read: 'boolean' });
    ref(e.teamId, `${p}.teamId`, teams, 'team');
    refOrNull(e.playerId, `${p}.playerId`, anyPlayer, 'player');
    refOrNull(e.coachId, `${p}.coachId`, coaches, 'coach');
  });
  const careers = refKeys(L.careerStats, '$.careerStats', anyPlayer, 'player');
  for (const pid of Object.keys(careers)) {
    const c = rec(careers[pid], sub('$.careerStats', pid));
    if (c.playerId !== pid) fail(sub('$.careerStats', pid) + '.playerId', 'career stats playerId does not match its key');
  }
  arr(L.pendingTrades, '$.pendingTrades').forEach((t0, i) => {
    const p = sub('$.pendingTrades', i);
    const t = rec(t0, p);
    ref(t.fromTeam, `${p}.fromTeam`, teams, 'team');
    ref(t.toTeam, `${p}.toTeam`, teams, 'team');
  });
  if (L.draft !== null) {
    shape(rec(L.draft, '$.draft'), '$.draft', { year: 'number', order: 'array', currentPickIndex: 'number', prospects: 'array', selections: 'array', reports: 'record', scouting: 'record', userBoard: 'array', complete: 'boolean' });
  }
  if (L.freeAgency !== null) shape(rec(L.freeAgency, '$.freeAgency'), '$.freeAgency', { round: 'number', maxRounds: 'number', offers: 'array', signings: 'array' });
};

/**
 * Structural validation of an in-memory league (full stat lines, version LEAGUE_DATA_VERSION): required keys and types, Team.rosterIds
 * ↔ Player.teamId agreement (both directions), free agents unattached, active/retired disjoint, and every
 * referenced id (stadiums, coaches, rivals, picks, depth charts, schedule, standings, stats, history,
 * records, HOF, events, career stats, trades) resolving. Deeper per-field checks belong to the loaders.
 */
export const validateLeague = (raw: unknown): League => {
  const L = rec(raw, '$');
  if (L.version !== LEAGUE_DATA_VERSION) throw new SaveError('version', '$.version', `expected league version ${LEAGUE_DATA_VERSION}, got ${String(L.version)}`);
  shape(L, '$', LEAGUE_SHAPE);
  // Optional (older saves have none): compact play-by-play of games without a full log.
  if (L.playSummaries !== undefined) rec(L.playSummaries, '$.playSummaries');
  rngState(L.rngState, '$.rngState');
  validatePeople(L, validateTeams(L));
  validateSeasonAndHistory(L);
  return L as unknown as League;
};

const GAME_PHASES: ReadonlySet<string> = new Set<GamePhase>([
  'pregame', 'coinToss', 'kickoff', 'playcall', 'presnap', 'live', 'deadball', 'pat', 'twoMinute', 'halftime', 'timeout', 'challenge', 'final',
]);
const GAME_SHAPE: Record<string, Kind> = {
  id: 'string', home: 'string', away: 'string', possession: 'string', direction: 'number', down: 'number', distance: 'number',
  ballOn: 'number', ballX: 'number', score: 'record', clock: 'record', timeouts: 'record', challenges: 'record', phase: 'string',
  pendingDecision: 'record?', twoMinuteWarningGiven: 'record', drive: 'record', playLog: 'array', stats: 'record', weather: 'record',
  ruleset: 'record', difficulty: 'record', overtimePeriods: 'number', overtime: 'record?', isPlayoff: 'boolean',
  receivedOpeningKickoff: 'string?', kickoffPending: 'string?', patPending: 'string?', seed: 'number', rngState: 'array',
  userSide: 'string?', controllers: 'record', lastOutcome: 'record?', fatigue: 'record', injuries: 'array',
};

/** Structural validation of a parsed GameState at the current game-state version. */
export const validateGameState = (raw: unknown): GameState => {
  const G = rec(raw, '$');
  if (G.version !== CURRENT_GAME_SAVE_VERSION) throw new SaveError('version', '$.version', `expected game version ${CURRENT_GAME_SAVE_VERSION}, got ${String(G.version)}`);
  shape(G, '$', GAME_SHAPE);
  if (G.home === G.away) fail('$.away', 'home and away must differ');
  if (G.possession !== 'home' && G.possession !== 'away') fail('$.possession', 'expected "home" or "away"');
  if (G.direction !== 1 && G.direction !== -1) fail('$.direction', 'expected 1 or -1');
  if (!GAME_PHASES.has(G.phase as string)) fail('$.phase', `unknown game phase "${String(G.phase)}"`);
  for (const k of ['score', 'timeouts', 'challenges'] as const) {
    const r = rec(G[k], `$.${k}`);
    num(r.home, `$.${k}.home`);
    num(r.away, `$.${k}.away`);
  }
  const clock = rec(G.clock, '$.clock');
  num(clock.quarter, '$.clock.quarter');
  num(clock.secondsRemaining, '$.clock.secondsRemaining');
  rngState(G.rngState, '$.rngState');
  const stats = rec(G.stats, '$.stats');
  rec(stats.players, '$.stats.players');
  const ts = rec(stats.teams, '$.stats.teams');
  rec(ts.home, '$.stats.teams.home');
  rec(ts.away, '$.stats.teams.away');
  return G as unknown as GameState;
};

/* -------------------------------- public API -------------------------------- */

export interface SerializeOptions {
  /** Pack the JSON with `packString` (default false). Deserializers auto-detect. */
  compress?: boolean;
  /** Run the structural validator before writing (default true) so an inconsistent state is never persisted. */
  validate?: boolean;
  /**
   * Sorted-key canonical JSON (default true; exports, backups, golden tests). False writes the same data with plain
   * JSON.stringify (about 3x faster on a large League; used by slot autosaves). Non-finite numbers throw either way.
   */
  canonical?: boolean;
}

/** Plain JSON.stringify that refuses non-finite numbers (which it would silently turn into null). */
const fastStringify = (value: unknown): string =>
  JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new SaveError('invalidValue', `$..${key}`, `non-finite number ${v} cannot be saved`);
    return v;
  });

const toJson = (value: unknown, opts: SerializeOptions): string => (opts.canonical === false ? fastStringify(value) : stableStringify(value));

const finish = (json: string, opts: SerializeOptions): string => (opts.compress ? packString(json) : json);

/** Unpacks (if compressed) and parses save text into raw JSON data. */
export const parseSaveText = (text: string): unknown => {
  const json = isCompressed(text) ? unpackString(text) : text;
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    throw new SaveError('parse', '$', 'save is not valid JSON', err);
  }
};

/** A League in the current file format (v2: compact stat lines, `version: CURRENT_SAVE_VERSION`) as raw JSON data;
 *  validated first unless `validate` is false. What serializeLeague writes and what exports embed. */
export const leagueToDiskForm = (league: League, validate = true): Record<string, unknown> => {
  if (validate) validateLeague(league);
  return { ...compactLeagueStatLines(league as unknown as Raw), version: CURRENT_SAVE_VERSION };
};

/** JSON (canonical unless `canonical: false`; optionally packed) for a League in the current file format (v2: compact stat lines). */
export const serializeLeague = (league: League, opts: SerializeOptions = {}): string =>
  finish(toJson(leagueToDiskForm(league, opts.validate ?? true), opts), opts);
/** Migrates raw parsed data to the current file format, expands the stat lines and validates the League. */
export const leagueFromRaw = (raw: unknown): League =>
  validateLeague({ ...expandLeagueStatLines(migrate(raw, { kind: 'league' }).data), version: LEAGUE_DATA_VERSION });
/** Inverse of `serializeLeague`: unpack → parse → migrate → validate. */
export const deserializeLeague = (text: string): League => leagueFromRaw(parseSaveText(text));

/** Canonical JSON (optionally packed) for a mid-game GameState. */
export const serializeGameState = (game: GameState, opts: SerializeOptions = {}): string => {
  if (opts.validate ?? true) validateGameState(game);
  return finish(toJson(game, opts), opts);
};
/** Migrates raw parsed game data to the current version and validates it. */
export const gameStateFromRaw = (raw: unknown): GameState => validateGameState(migrate(raw, { kind: 'game' }).data);
/** Inverse of `serializeGameState`. */
export const deserializeGameState = (text: string): GameState => gameStateFromRaw(parseSaveText(text));

/** Canonical JSON for Settings (parsing/merging lives in settings-store.ts). */
export const serializeSettings = (settings: Settings): string => stableStringify(settings);
