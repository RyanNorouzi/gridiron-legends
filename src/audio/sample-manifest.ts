/**
 * Recorded-sample catalogue (public/audio/manifest.json): the CC0 field recordings layered on top of the
 * procedural synth. This module is pure data + validation; loading lives in sample-bank.ts and playback in
 * sample-output.ts. Paths in the manifest are relative to the /audio/ folder of the deployed site.
 */

/** Output bus a sample plays on; maps onto the AudioLevels sfx / crowd sliders. */
export type SampleBus = 'sfx' | 'crowd';

/** Every sample id the game triggers. The manifest may carry more; missing ones fall back to the synth. */
export const SAMPLE_IDS = [
  'sfx.tackle_light', 'sfx.tackle_solid', 'sfx.tackle_big', 'sfx.pad_clatter', 'sfx.turf', 'sfx.helmet_clack',
  'sfx.grunt_hit', 'sfx.grunt_effort', 'sfx.whistle_short', 'sfx.whistle_long', 'sfx.catch', 'sfx.kick', 'sfx.snap',
  'sfx.stomp', 'sfx.footstep_grass',
  'crowd.bed_murmur', 'crowd.bed_engaged', 'crowd.bed_loud', 'crowd.cheer', 'crowd.roar', 'crowd.swell', 'crowd.groan',
  'crowd.oooh', 'crowd.boo', 'crowd.applause', 'crowd.defense_build', 'crowd.horn', 'crowd.drum',
] as const;

/** Id of a recording the game triggers ('sfx.tackle_big', 'crowd.roar', ...). */
export type SampleId = (typeof SAMPLE_IDS)[number];

/** The three looping crowd beds, quietest first. */
export const CROWD_BED_IDS = ['crowd.bed_murmur', 'crowd.bed_engaged', 'crowd.bed_loud'] as const satisfies readonly SampleId[];

/** Type guard for SampleId. */
export const isSampleId = (v: unknown): v is SampleId => typeof v === 'string' && (SAMPLE_IDS as readonly string[]).includes(v);

/** Sample ids on one bus (the SFX set loads on the first user gesture, the crowd set when a game starts). */
export const sampleIdsFor = (bus: SampleBus): SampleId[] => SAMPLE_IDS.filter((id) => id.startsWith(`${bus}.`));

/** One recorded take of a sound. */
export interface SampleVariant {
  /** Path relative to the audio base URL, e.g. 'sfx/tackle_big_3.m4a'. */
  file: string;
  /** Seconds. */
  duration: number;
  /** Loop points in seconds (beds only). */
  loopStart?: number;
  loopEnd?: number;
}

/** A validated manifest sound: its bus, suggested gain and takes. */
export interface SampleEntry {
  id: string;
  bus: SampleBus;
  /** Suggested linear playback gain from the sourcing pass. */
  gain: number;
  variants: readonly SampleVariant[];
  /** Looping bed (loopStart/loopEnd on every variant). */
  loop: boolean;
}

/** Validated manifest, entries keyed by id. */
export interface SampleManifest {
  version: number;
  entries: ReadonlyMap<string, SampleEntry>;
}

/** Result of parseSampleManifest. */
export interface ManifestParse {
  manifest: SampleManifest;
  /** Why entries were dropped; empty when the manifest is clean. */
  errors: string[];
}

/** Largest gain a manifest entry may ask for (anything louder is a data error). */
export const MAX_SAMPLE_GAIN = 1.5;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A safe relative asset path: no scheme, no absolute root, no parent segments, audio extension only. */
export const isSafeSamplePath = (file: unknown): file is string =>
  typeof file === 'string' && file.length > 0 && file.length < 200 && !file.startsWith('/') && !file.includes('\\') &&
  !file.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(file) && /^[A-Za-z0-9_/.-]+\.(m4a|mp3|ogg|wav|webm)$/.test(file);

const parseVariant = (raw: unknown, loop: boolean, where: string, errors: string[]): SampleVariant | null => {
  if (!isRec(raw)) return (errors.push(`${where}: variant is not an object`), null);
  if (!isSafeSamplePath(raw.file)) return (errors.push(`${where}: unsafe or missing file '${String(raw.file)}'`), null);
  if (!finite(raw.duration) || raw.duration <= 0) return (errors.push(`${where}: bad duration`), null);
  const v: SampleVariant = { file: raw.file, duration: raw.duration };
  if (loop) {
    const s = raw.loopStart;
    const e = raw.loopEnd;
    if (!finite(s) || !finite(e) || s < 0 || e <= s || e > raw.duration + 1e-6) return (errors.push(`${where}: bad loop points`), null);
    v.loopStart = s;
    v.loopEnd = e;
  }
  return v;
};

const parseEntry = (raw: unknown, index: number, errors: string[]): SampleEntry | null => {
  if (!isRec(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return (errors.push(`sounds[${index}]: missing id`), null);
  const id = raw.id;
  const bus = raw.category;
  if (bus !== 'sfx' && bus !== 'crowd') return (errors.push(`${id}: unknown category '${String(bus)}'`), null);
  if (!id.startsWith(`${bus}.`)) return (errors.push(`${id}: id does not match category '${bus}'`), null);
  const gain = raw.gain;
  if (!finite(gain) || gain <= 0 || gain > MAX_SAMPLE_GAIN) return (errors.push(`${id}: gain out of range`), null);
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) return (errors.push(`${id}: no variants`), null);
  const loop = isRec(raw.loop);
  const variants: SampleVariant[] = [];
  raw.variants.forEach((v: unknown, i: number) => {
    const parsed = parseVariant(v, loop, `${id}[${i}]`, errors);
    if (parsed) variants.push(parsed);
  });
  if (variants.length === 0) return null;
  return { id, bus, gain, variants, loop };
};

/**
 * Lenient validation of the fetched manifest (a system boundary): malformed entries are dropped and reported,
 * duplicates keep the first entry. Never throws; a garbage document yields an empty manifest.
 */
export const parseSampleManifest = (raw: unknown): ManifestParse => {
  const errors: string[] = [];
  const entries = new Map<string, SampleEntry>();
  if (!isRec(raw) || !Array.isArray(raw.sounds)) {
    errors.push('manifest has no sounds[] array');
    return { manifest: { version: 0, entries }, errors };
  }
  raw.sounds.forEach((s: unknown, i: number) => {
    const entry = parseEntry(s, i, errors);
    if (!entry) return;
    if (entries.has(entry.id)) {
      errors.push(`${entry.id}: duplicate id`);
      return;
    }
    entries.set(entry.id, entry);
  });
  return { manifest: { version: finite(raw.version) ? raw.version : 0, entries }, errors };
};

/** Ids the game needs that the manifest lacks (those cues silently fall back to the synth). */
export const missingSampleIds = (manifest: SampleManifest): SampleId[] => SAMPLE_IDS.filter((id) => !manifest.entries.has(id));
