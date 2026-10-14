/**
 * Sound catalogue: every SoundId maps to an ORIGINAL synthesised recipe (no audio files). Recipes are pure
 * data; src/audio/synth.ts turns them into WebAudio graphs. Categories map 1:1 onto AudioLevels buses.
 */
export type SoundCategory = 'sfx' | 'crowd' | 'music' | 'commentary';
export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';
export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';
export type SweepCurve = 'linear' | 'exponential';

/** ADSR in seconds; `sustain` is a 0..1 fraction of the peak. Loops use only attack/release. */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Biquad filter on the voice output; `endHz` sweeps the cutoff over the sound's duration. */
export interface FilterSpec {
  kind: FilterKind;
  hz: number;
  q: number;
  endHz?: number;
}

/** Low-frequency modulation of the voice amplitude (tremolo / crowd swell). `depth` is 0..1. */
export interface Modulation {
  rateHz: number;
  depth: number;
}

export interface SynthRecipe {
  category: SoundCategory;
  waveform: Waveform;
  envelope: Envelope;
  /** Oscillator start / end frequency in Hz; the sweep spans `duration`. Ignored when waveform is 'noise'. */
  startHz: number;
  endHz: number;
  sweep: SweepCurve;
  /** 0..1 blend of white noise into the voice; a 'noise' waveform is always fully noise. */
  noiseMix: number;
  /** Seconds. One-shots stop here; loops use it as the sweep period only. */
  duration: number;
  /** Base linear gain 0..1 before category/master scaling. */
  gain: number;
  /** Extra partial gains for 2x, 3x, ... the fundamental (tone voices only). */
  harmonics?: readonly number[];
  filter?: FilterSpec;
  modulation?: Modulation;
  /** Sustained voice managed by startLoop/stopLoop instead of a one-shot. */
  loop?: boolean;
}

export const SOUND_CATEGORIES: readonly SoundCategory[] = ['sfx', 'crowd', 'music', 'commentary'];

export const SOUND_IDS = [
  'crowdAmbient', 'crowdCheer', 'crowdGroan', 'crowdRoar', 'tackle', 'bigHit', 'catch', 'throw', 'kickoff', 'punt',
  'fieldGoal', 'whistle', 'touchdown', 'turnover', 'firstDown', 'menuMove', 'menuSelect', 'menuBack', 'snap',
  'incomplete', 'sack', 'fumble', 'interception', 'twoMinute', 'gameOver', 'penaltyFlag', 'hitStick',
  'boothExcited', 'boothWhoa', 'boothAww', 'paChime',
] as const;

export type SoundId = (typeof SOUND_IDS)[number];

const env = (attack: number, decay: number, sustain: number, release: number): Envelope => ({ attack, decay, sustain, release });

type RecipeOverrides = Partial<SynthRecipe> & Pick<SynthRecipe, 'duration' | 'gain'>;

const voice = (category: SoundCategory, waveform: Waveform, o: RecipeOverrides): SynthRecipe => ({
  category,
  waveform,
  envelope: env(0.005, 0.05, 0.5, 0.1),
  startHz: 440,
  endHz: 440,
  sweep: 'exponential',
  noiseMix: waveform === 'noise' ? 1 : 0,
  ...o,
});

/**
 * The catalogue. Naming guide for the kicks: 'kickoff' is the deep tee boot (also used for FG/XP contact),
 * 'punt' the hollow drop-kick thump and 'fieldGoal' the "kick is good" chime.
 */
export const SOUNDS: Readonly<Record<SoundId, SynthRecipe>> = Object.freeze({
  crowdAmbient: voice('crowd', 'noise', {
    envelope: env(1.5, 0, 1, 1.5), duration: 4, gain: 0.35, loop: true,
    filter: { kind: 'bandpass', hz: 900, q: 0.5 }, modulation: { rateHz: 0.13, depth: 0.35 },
  }),
  crowdCheer: voice('crowd', 'noise', {
    envelope: env(0.08, 0.3, 0.6, 0.6), duration: 1.4, gain: 0.5,
    filter: { kind: 'bandpass', hz: 1200, q: 0.7, endHz: 800 }, modulation: { rateHz: 6, depth: 0.2 },
  }),
  crowdGroan: voice('crowd', 'sawtooth', {
    envelope: env(0.12, 0.4, 0.5, 0.8), startHz: 220, endHz: 140, noiseMix: 0.6, duration: 1.6, gain: 0.4,
    filter: { kind: 'lowpass', hz: 700, q: 0.8, endHz: 400 },
  }),
  crowdRoar: voice('crowd', 'noise', {
    envelope: env(0.05, 0.5, 0.8, 1.2), duration: 2.6, gain: 0.7,
    filter: { kind: 'bandpass', hz: 1000, q: 0.4, endHz: 1600 }, modulation: { rateHz: 4, depth: 0.25 },
  }),
  tackle: voice('sfx', 'sine', {
    envelope: env(0.003, 0.08, 0.2, 0.1), startHz: 120, endHz: 45, noiseMix: 0.5, duration: 0.22, gain: 0.6,
    filter: { kind: 'lowpass', hz: 900, q: 0.7 },
  }),
  bigHit: voice('sfx', 'square', {
    envelope: env(0.002, 0.12, 0.3, 0.2), startHz: 90, endHz: 30, noiseMix: 0.6, duration: 0.4, gain: 0.85,
    harmonics: [0.4], filter: { kind: 'lowpass', hz: 1200, q: 0.9, endHz: 300 },
  }),
  catch: voice('sfx', 'triangle', {
    envelope: env(0.002, 0.05, 0.1, 0.05), startHz: 700, endHz: 500, noiseMix: 0.35, duration: 0.12, gain: 0.5,
    filter: { kind: 'bandpass', hz: 1500, q: 1 },
  }),
  throw: voice('sfx', 'noise', {
    envelope: env(0.04, 0.1, 0.4, 0.15), duration: 0.35, gain: 0.35,
    filter: { kind: 'bandpass', hz: 2500, q: 1.2, endHz: 900 },
  }),
  kickoff: voice('sfx', 'sine', {
    envelope: env(0.002, 0.1, 0.25, 0.15), startHz: 140, endHz: 50, noiseMix: 0.45, duration: 0.3, gain: 0.75,
    filter: { kind: 'lowpass', hz: 1500, q: 0.7, endHz: 400 },
  }),
  punt: voice('sfx', 'triangle', {
    envelope: env(0.003, 0.09, 0.2, 0.12), startHz: 110, endHz: 60, noiseMix: 0.55, duration: 0.26, gain: 0.65,
    filter: { kind: 'lowpass', hz: 1100, q: 0.7, endHz: 500 },
  }),
  fieldGoal: voice('sfx', 'sine', {
    envelope: env(0.005, 0.25, 0.4, 0.45), startHz: 880, endHz: 880, duration: 0.9, gain: 0.45, harmonics: [0.3, 0.15],
  }),
  whistle: voice('sfx', 'sine', {
    envelope: env(0.01, 0.05, 0.9, 0.08), startHz: 2400, endHz: 2450, sweep: 'linear', noiseMix: 0.15, duration: 0.55,
    gain: 0.35, harmonics: [0.25], filter: { kind: 'bandpass', hz: 2400, q: 2 }, modulation: { rateHz: 28, depth: 0.35 },
  }),
  touchdown: voice('music', 'triangle', {
    envelope: env(0.01, 0.15, 0.7, 0.4), startHz: 392, endHz: 784, duration: 1.2, gain: 0.4, harmonics: [0.3, 0.1],
  }),
  turnover: voice('sfx', 'sawtooth', {
    envelope: env(0.01, 0.2, 0.5, 0.3), startHz: 660, endHz: 165, duration: 0.7, gain: 0.4,
    filter: { kind: 'lowpass', hz: 2500, q: 0.7, endHz: 800 },
  }),
  firstDown: voice('sfx', 'square', {
    envelope: env(0.005, 0.1, 0.5, 0.15), startHz: 660, endHz: 990, duration: 0.35, gain: 0.35,
  }),
  menuMove: voice('sfx', 'square', {
    envelope: env(0.002, 0.03, 0.2, 0.03), startHz: 900, endHz: 900, duration: 0.08, gain: 0.25,
  }),
  menuSelect: voice('sfx', 'square', {
    envelope: env(0.002, 0.06, 0.3, 0.06), startHz: 660, endHz: 1320, duration: 0.16, gain: 0.3,
  }),
  menuBack: voice('sfx', 'square', {
    envelope: env(0.002, 0.06, 0.3, 0.06), startHz: 880, endHz: 440, duration: 0.16, gain: 0.3,
  }),
  snap: voice('sfx', 'triangle', {
    envelope: env(0.002, 0.04, 0.1, 0.04), startHz: 300, endHz: 180, noiseMix: 0.4, duration: 0.1, gain: 0.45,
  }),
  incomplete: voice('sfx', 'sine', {
    envelope: env(0.002, 0.07, 0.1, 0.08), startHz: 200, endHz: 80, noiseMix: 0.5, duration: 0.18, gain: 0.4,
    filter: { kind: 'lowpass', hz: 800, q: 0.7 },
  }),
  sack: voice('sfx', 'square', {
    envelope: env(0.002, 0.15, 0.3, 0.25), startHz: 100, endHz: 40, noiseMix: 0.5, duration: 0.45, gain: 0.8,
    harmonics: [0.5], filter: { kind: 'lowpass', hz: 1000, q: 0.8, endHz: 250 },
  }),
  fumble: voice('sfx', 'triangle', {
    envelope: env(0.002, 0.1, 0.4, 0.2), startHz: 260, endHz: 130, noiseMix: 0.3, duration: 0.5, gain: 0.5,
    modulation: { rateHz: 9, depth: 0.5 },
  }),
  interception: voice('sfx', 'sawtooth', {
    envelope: env(0.01, 0.1, 0.6, 0.25), startHz: 330, endHz: 990, duration: 0.6, gain: 0.4, harmonics: [0.2],
    filter: { kind: 'lowpass', hz: 3000, q: 0.7 },
  }),
  twoMinute: voice('sfx', 'sawtooth', {
    envelope: env(0.05, 0.1, 0.8, 0.3), startHz: 196, endHz: 196, duration: 1, gain: 0.4, harmonics: [0.5, 0.3, 0.2],
    filter: { kind: 'lowpass', hz: 1200, q: 0.7 },
  }),
  gameOver: voice('music', 'square', {
    envelope: env(0.02, 0.3, 0.6, 0.6), startHz: 784, endHz: 262, duration: 1.8, gain: 0.4, harmonics: [0.3],
  }),
  penaltyFlag: voice('sfx', 'square', {
    envelope: env(0.002, 0.04, 0.6, 0.04), startHz: 1500, endHz: 1500, duration: 0.14, gain: 0.35,
    modulation: { rateHz: 40, depth: 0.9 },
  }),
  hitStick: voice('sfx', 'noise', {
    envelope: env(0.03, 0.08, 0.3, 0.1), duration: 0.25, gain: 0.4,
    filter: { kind: 'bandpass', hz: 600, q: 1.5, endHz: 2400 },
  }),
  // Commentary bus: the broadcast booth's reactions as vowel-like formant sweeps (no speech samples) and the
  // stadium PA chime that precedes announcements.
  boothExcited: voice('commentary', 'sawtooth', {
    envelope: env(0.03, 0.25, 0.7, 0.35), startHz: 180, endHz: 300, sweep: 'linear', noiseMix: 0.08, duration: 0.9, gain: 0.35,
    harmonics: [0.5, 0.25], filter: { kind: 'bandpass', hz: 700, q: 3, endHz: 1200 }, modulation: { rateHz: 6, depth: 0.15 },
  }),
  boothWhoa: voice('commentary', 'sawtooth', {
    envelope: env(0.02, 0.2, 0.6, 0.3), startHz: 240, endHz: 170, sweep: 'linear', noiseMix: 0.06, duration: 0.7, gain: 0.3,
    harmonics: [0.4], filter: { kind: 'bandpass', hz: 900, q: 3, endHz: 550 },
  }),
  boothAww: voice('commentary', 'sawtooth', {
    envelope: env(0.04, 0.3, 0.6, 0.4), startHz: 200, endHz: 130, sweep: 'linear', noiseMix: 0.05, duration: 0.95, gain: 0.28,
    harmonics: [0.35], filter: { kind: 'bandpass', hz: 800, q: 3.5, endHz: 450 },
  }),
  paChime: voice('commentary', 'sine', {
    envelope: env(0.005, 0.2, 0.5, 0.35), startHz: 988, endHz: 740, sweep: 'linear', duration: 0.7, gain: 0.3, harmonics: [0.2],
  }),
});

/** Type guard for untrusted ids (settings files, dev console). */
export const isSoundId = (value: unknown): value is SoundId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOUNDS, value);

export const soundCategory = (id: SoundId): SoundCategory => SOUNDS[id].category;

/** New recipe with every frequency (oscillator and filter) multiplied by `factor` (1 = unchanged). */
export const transposeRecipe = (recipe: SynthRecipe, factor: number): SynthRecipe => {
  const f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  const filter = recipe.filter
    ? { ...recipe.filter, hz: recipe.filter.hz * f, ...(recipe.filter.endHz !== undefined ? { endHz: recipe.filter.endHz * f } : {}) }
    : undefined;
  return { ...recipe, startHz: recipe.startHz * f, endHz: recipe.endHz * f, ...(filter ? { filter } : {}) };
};

const inRange = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi;

/** Throws a descriptive error when a recipe is malformed; used by tests and by tools that load custom recipes. */
export const validateRecipe = (name: string, r: SynthRecipe): void => {
  const fail = (msg: string): never => {
    throw new Error(`Sound recipe '${name}': ${msg}`);
  };
  if (!SOUND_CATEGORIES.includes(r.category)) fail(`unknown category '${String(r.category)}'`);
  if (!['sine', 'square', 'sawtooth', 'triangle', 'noise'].includes(r.waveform)) fail(`unknown waveform '${String(r.waveform)}'`);
  const e = r.envelope;
  if (!inRange(e.attack, 0, 10) || !inRange(e.decay, 0, 10) || !inRange(e.release, 0, 10)) fail('envelope times must be 0..10s');
  if (!inRange(e.sustain, 0, 1)) fail('envelope.sustain must be 0..1');
  if (!inRange(r.duration, 0.01, 30)) fail('duration must be 0.01..30s');
  if (!r.loop && e.attack + e.decay + e.release > r.duration + 1e-9) fail('attack+decay+release exceeds duration');
  if (!inRange(r.gain, 0, 1)) fail('gain must be 0..1');
  if (!inRange(r.noiseMix, 0, 1)) fail('noiseMix must be 0..1');
  if (r.waveform !== 'noise' && (!inRange(r.startHz, 20, 20000) || !inRange(r.endHz, 20, 20000))) fail('startHz/endHz must be 20..20000');
  if (r.harmonics?.some((h) => !inRange(h, 0, 1))) fail('harmonics must each be 0..1');
  if (r.filter && (!inRange(r.filter.hz, 20, 20000) || !inRange(r.filter.q, 0.0001, 100))) fail('filter hz/q out of range');
  if (r.filter?.endHz !== undefined && !inRange(r.filter.endHz, 20, 20000)) fail('filter.endHz must be 20..20000');
  if (r.modulation && (!inRange(r.modulation.rateHz, 0.01, 200) || !inRange(r.modulation.depth, 0, 1))) fail('modulation out of range');
};
