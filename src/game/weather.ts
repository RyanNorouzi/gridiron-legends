import weatherJson from '@/data/weather.json';
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { Stadium } from '@/teams/types';
import type { WeatherState, WeatherType } from './types';

/**
 * Weather generation. Parameter ranges per WeatherType and per-climate week bands live in
 * src/data/weather.json; everything here is deterministic given the injected Rng.
 */
export const WEATHER_TYPES: readonly WeatherType[] = ['clear', 'rain', 'heavyRain', 'snow', 'wind', 'extremeCold', 'heat'];
export type Climate = Stadium['climate'];
export type Roof = Stadium['roof'];
export const CLIMATES: readonly Climate[] = ['temperate', 'cold', 'warm', 'desert', 'coastal'];

/** Types that close a retractable roof (the game is then played indoors). */
const ROOF_CLOSING_TYPES: readonly WeatherType[] = ['heavyRain', 'snow', 'extremeCold'];

type Range = readonly [number, number];
interface TypeRanges { windMph: Range; temperatureF: Range; precipitation: Range; visibility: Range; fieldSlick: Range }
interface WeekBand { fromWeek: number; toWeek: number; weights: Record<WeatherType, number> }
interface WeatherData { indoorTemperatureF: number; types: Record<WeatherType, TypeRanges>; climates: Record<Climate, WeekBand[]> }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const range = (obj: Record<string, unknown>, key: string, lo: number, hi: number, where: string): Range => {
  const v = obj[key];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${where}: "${key}" must be a [min, max] number pair`);
  }
  const [a, b] = v as [number, number];
  if (a > b) throw new Error(`${where}: "${key}" min ${a} exceeds max ${b}`);
  if (a < lo || b > hi) throw new Error(`${where}: "${key}" must lie within [${lo}, ${hi}]`);
  return [a, b];
};

const parseTypeRanges = (raw: unknown, where: string): TypeRanges => {
  if (!isRecord(raw)) throw new Error(`${where}: expected an object`);
  return {
    windMph: range(raw, 'windMph', 0, 80, where),
    temperatureF: range(raw, 'temperatureF', -40, 130, where),
    precipitation: range(raw, 'precipitation', 0, 1, where),
    visibility: range(raw, 'visibility', 0, 1, where),
    fieldSlick: range(raw, 'fieldSlick', 0, 1, where),
  };
};

const parseBand = (raw: unknown, where: string): WeekBand => {
  if (!isRecord(raw)) throw new Error(`${where}: expected an object`);
  const fromWeek = raw['fromWeek'];
  const toWeek = raw['toWeek'];
  if (typeof fromWeek !== 'number' || typeof toWeek !== 'number' || fromWeek < 1 || toWeek < fromWeek) {
    throw new Error(`${where}: fromWeek/toWeek must satisfy 1 <= fromWeek <= toWeek`);
  }
  const w = raw['weights'];
  if (!isRecord(w)) throw new Error(`${where}: "weights" must be an object`);
  const weights = {} as Record<WeatherType, number>;
  let total = 0;
  for (const t of WEATHER_TYPES) {
    const v = w[t];
    if (typeof v !== 'number' || v < 0) throw new Error(`${where}: weight "${t}" must be a non-negative number`);
    weights[t] = v;
    total += v;
  }
  if (total <= 0) throw new Error(`${where}: weights must not all be zero`);
  return { fromWeek, toWeek, weights };
};

let cache: WeatherData | null = null;

/** Parses and validates src/data/weather.json (cached). */
export const loadWeatherData = (): WeatherData => {
  if (cache) return cache;
  const root: unknown = weatherJson;
  if (!isRecord(root)) throw new Error('weather.json: expected an object');
  const indoor = root['indoorTemperatureF'];
  if (typeof indoor !== 'number') throw new Error('weather.json: "indoorTemperatureF" must be a number');
  const typesRaw = root['types'];
  const climatesRaw = root['climates'];
  if (!isRecord(typesRaw) || !isRecord(climatesRaw)) throw new Error('weather.json: expected "types" and "climates" objects');
  const types = {} as Record<WeatherType, TypeRanges>;
  for (const t of WEATHER_TYPES) types[t] = parseTypeRanges(typesRaw[t], `weather.json types.${t}`);
  const climates = {} as Record<Climate, WeekBand[]>;
  for (const c of CLIMATES) {
    const bands = climatesRaw[c];
    if (!Array.isArray(bands) || bands.length === 0) throw new Error(`weather.json: climate "${c}" needs at least one week band`);
    climates[c] = bands.map((b, i) => parseBand(b, `weather.json climates.${c}[${i}]`));
  }
  cache = { indoorTemperatureF: indoor, types, climates };
  return cache;
};

/** Perfect conditions (used for domes, practice and tests). */
export const clearWeather = (temperatureF = 68): WeatherState => ({
  type: 'clear', windDir: 0, windMph: 0, temperatureF, precipitation: 0, visibility: 1, fieldSlick: 0,
});

const sample = (rng: Rng, r: Range): number => (r[0] === r[1] ? r[0] : rng.range(r[0], r[1]));

/** Samples every parameter of a weather type from its data range, keeping them mutually consistent. */
export const sampleWeather = (rng: Rng, type: WeatherType): WeatherState => {
  const ranges = loadWeatherData().types[type];
  const windMph = Math.round(sample(rng, ranges.windMph));
  const windDir = rng.range(0, Math.PI * 2);
  const temperatureF = Math.round(sample(rng, ranges.temperatureF));
  const precipitation = clamp(Math.round(sample(rng, ranges.precipitation) * 100) / 100, 0, 1);
  const visibility = clamp(Math.round(sample(rng, ranges.visibility) * 100) / 100, 0, 1);
  const fieldSlick = clamp(Math.round(sample(rng, ranges.fieldSlick) * 100) / 100, 0, 1);
  return { type, windDir, windMph, temperatureF, precipitation, visibility, fieldSlick };
};

/** The week band that covers `week` for a climate (weeks past the last band reuse it). */
export const weekBandFor = (climate: Climate, week: number): WeekBand => {
  const bands = loadWeatherData().climates[climate];
  const w = Math.max(1, Math.floor(week));
  const found = bands.find((b) => w >= b.fromWeek && w <= b.toWeek);
  return found ?? (bands[bands.length - 1] as WeekBand);
};

/** Rolls a weather type for a climate/week from the data weights. */
export const rollWeatherType = (rng: Rng, climate: Climate, week: number): WeatherType => {
  const band = weekBandFor(climate, week);
  return rng.weighted(WEATHER_TYPES, WEATHER_TYPES.map((t) => band.weights[t]));
};

/**
 * Generates the game weather. Domes always play in clear indoor conditions; a retractable roof closes
 * for heavy rain, snow and extreme cold. Everything else is sampled from the climate's week band.
 */
export const generateWeather = (rng: Rng, climate: Climate, week: number, roof: Roof): WeatherState => {
  const indoor = loadWeatherData().indoorTemperatureF;
  if (roof === 'dome') return clearWeather(indoor);
  const type = rollWeatherType(rng, climate, week);
  if (roof === 'retractable' && ROOF_CLOSING_TYPES.includes(type)) return clearWeather(indoor);
  return sampleWeather(rng, type);
};

/** True when the weather meaningfully affects play (traction, ball flight or visibility). */
export const isAdverseWeather = (w: WeatherState): boolean =>
  w.type !== 'clear' || w.windMph >= 15 || w.fieldSlick >= 0.2 || w.visibility < 0.9;
