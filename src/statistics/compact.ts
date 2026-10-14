/**
 * Compact stat lines for saves. A PlayerStatLine has ~90 numeric fields and most are zero for any one player
 * (a guard never throws a pass), so saves store only the non-zero fields: `compactStatLine` drops zero fields
 * and all-zero category buckets, `expandStatLine` rebuilds the full line from emptyPlayerStatLine(). The pair
 * round-trips every line exactly (apart from -0, which JSON cannot keep anyway).
 *
 * `compactLeagueStatLines` / `expandLeagueStatLines` apply this to every PlayerStatLine inside raw League JSON
 * (season and playoff tables, per-game box scores in the schedule, career seasons/totals, Hall of Fame careers).
 * They work on plain JSON data (the save layer's raw objects), copy on write and never mutate their input.
 */
import { emptyPlayerStatLine } from './empty';
import type { PlayerStatLine } from './types';

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stat line with zero fields (and all-zero buckets) omitted. */
export type CompactStatLine = { [K in keyof PlayerStatLine]?: PlayerStatLine[K] extends number ? number : Partial<PlayerStatLine[K]> };

/** Drops zero-valued fields and empty buckets (any nested object is handled the same way). */
const compactObject = (o: Raw): Raw => {
  const out: Raw = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') {
      if (v !== 0) out[k] = v;
    } else if (isRecord(v)) {
      const inner = compactObject(v);
      if (Object.keys(inner).length > 0) out[k] = inner;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
};

/** Deep-merges `src` onto `dst` (numbers and other values replace, objects merge). */
const mergeInto = (dst: Raw, src: Raw): Raw => {
  for (const [k, v] of Object.entries(src)) dst[k] = isRecord(v) && isRecord(dst[k]) ? mergeInto({ ...(dst[k] as Raw) }, v) : v;
  return dst;
};

/** A stat line without its zero fields (all-zero buckets removed). */
export const compactStatLine = (line: PlayerStatLine): CompactStatLine => compactObject(line as unknown as Raw) as CompactStatLine;

/** The full stat line for a compact (or already full) one: emptyPlayerStatLine() with its fields laid over. */
export const expandStatLine = (compact: CompactStatLine | Raw): PlayerStatLine =>
  mergeInto(emptyPlayerStatLine() as unknown as Raw, compact as Raw) as unknown as PlayerStatLine;

/* ------------------------------------------------------------ raw League JSON */

type LineFn = (line: Raw) => Raw;

const mapTable = (table: unknown, fn: LineFn): unknown => {
  if (!isRecord(table)) return table;
  const out: Raw = {};
  for (const [id, line] of Object.entries(table)) out[id] = isRecord(line) ? fn(line) : line;
  return out;
};

const mapSeason = (season: unknown, fn: LineFn): unknown => {
  if (!isRecord(season)) return season;
  const out: Raw = { ...season, stats: mapTable(season.stats, fn), playoffStats: mapTable(season.playoffStats, fn) };
  if (Array.isArray(season.schedule)) {
    out.schedule = season.schedule.map((g: unknown) => {
      if (!isRecord(g) || !isRecord(g.result) || !isRecord(g.result.stats)) return g;
      return { ...g, result: { ...g.result, stats: { ...g.result.stats, players: mapTable(g.result.stats.players, fn) } } };
    });
  }
  for (const k of ['stats', 'playoffStats'] as const) if (season[k] === undefined) delete out[k];
  return out;
};

const mapCareers = (careers: unknown, fn: LineFn): unknown => {
  if (!isRecord(careers)) return careers;
  const out: Raw = {};
  for (const [id, c] of Object.entries(careers)) {
    if (!isRecord(c)) { out[id] = c; continue; }
    const seasons = Array.isArray(c.seasons)
      ? c.seasons.map((s: unknown) => (isRecord(s) ? { ...s, line: isRecord(s.line) ? fn(s.line) : s.line, playoffLine: isRecord(s.playoffLine) ? fn(s.playoffLine) : s.playoffLine } : s))
      : c.seasons;
    out[id] = { ...c, seasons, totals: isRecord(c.totals) ? fn(c.totals) : c.totals };
  }
  return out;
};

const mapLeague = (raw: Raw, fn: LineFn): Raw => {
  const out: Raw = { ...raw };
  if (raw.season !== undefined) out.season = mapSeason(raw.season, fn);
  if (raw.careerStats !== undefined) out.careerStats = mapCareers(raw.careerStats, fn);
  if (Array.isArray(raw.hallOfFame)) out.hallOfFame = raw.hallOfFame.map((h: unknown) => (isRecord(h) && isRecord(h.careerStats) ? { ...h, careerStats: fn(h.careerStats) } : h));
  return out;
};

/** Raw League JSON with every PlayerStatLine compacted (see the module header for where they live). */
export const compactLeagueStatLines = (raw: Raw): Raw => mapLeague(raw, compactObject);

/** Raw League JSON with every (compact or full) PlayerStatLine expanded back to a full line. */
export const expandLeagueStatLines = (raw: Raw): Raw => mapLeague(raw, (line) => expandStatLine(line) as unknown as Raw);
