import { createRng, type Rng } from '@/core/rng';
import { SOUND_CATEGORIES, type Envelope, type SoundCategory, type SweepCurve, type SynthRecipe } from './sounds';

/**
 * Synth backends. `createWebAudioBackend` builds oscillator/noise voices through WebAudio (browser);
 * `createNullBackend` records every call for Node tests and headless runs. Category buses apply the
 * AudioLevels gains so level changes affect voices that are already sounding (crowd loop included).
 */
export interface AudioBackend {
  readonly kind: 'webaudio' | 'null';
  /** True once the underlying context exists and is running (always true for the null backend). */
  readonly ready: boolean;
  /** One-shot voice. `gain` is the per-instance linear gain (recipe.gain × volume); the category bus is applied on top. */
  play(recipe: SynthRecipe, gain: number): void;
  /** Sustained voice keyed by `id`; starting an existing id replaces it. Pending until the context is running. */
  startLoop(id: string, recipe: SynthRecipe, gain: number): void;
  stopLoop(id: string): void;
  /** Retarget a running loop's gain, ramped over `rampSec` (default 0.25 s). */
  setLoopGain(id: string, gain: number, rampSec?: number): void;
  /** Category bus gain 0..1 (master × level, computed by the AudioManager). */
  setGain(category: SoundCategory, v: number): void;
  /** Create/unlock the context; call from a user gesture. Resolves once running (or immediately when unsupported). */
  resume(): Promise<void>;
  /** Stop everything and release the context. */
  dispose(): void;
}

/* ------------------------------ pure automation helpers ------------------------------ */

export interface AutomationPoint {
  t: number;
  v: number;
  ramp: 'set' | 'linear' | 'exponential';
}

/** Shortest attack applied by the WebAudio path so voices never click. */
export const MIN_ATTACK_SEC = 0.002;
const EXP_FLOOR = 0.0001;

/** ADSR gain schedule for a one-shot of `duration` seconds starting at `t0`; the schedule always ends at 0. */
export const envelopePoints = (env: Envelope, peak: number, t0: number, duration: number): AutomationPoint[] => {
  const a = Math.min(Math.max(env.attack, MIN_ATTACK_SEC), duration);
  const d = Math.min(Math.max(env.decay, 0), Math.max(0, duration - a));
  const r = Math.min(Math.max(env.release, 0), Math.max(0, duration - a - d));
  const level = d > 0 ? peak * env.sustain : peak;
  const pts: AutomationPoint[] = [{ t: t0, v: 0, ramp: 'set' }, { t: t0 + a, v: peak, ramp: 'linear' }];
  if (d > 0) pts.push({ t: t0 + a + d, v: level, ramp: 'linear' });
  const releaseStart = t0 + duration - r;
  if (releaseStart > t0 + a + d + 1e-9) pts.push({ t: releaseStart, v: level, ramp: 'linear' });
  pts.push({ t: t0 + duration, v: 0, ramp: 'linear' });
  return pts;
};

/** Attack-only schedule for a loop (holds at `peak` until released). */
export const loopAttackPoints = (env: Envelope, peak: number, t0: number): AutomationPoint[] => [
  { t: t0, v: 0, ramp: 'set' },
  { t: t0 + Math.max(env.attack, MIN_ATTACK_SEC), v: peak, ramp: 'linear' },
];

/** Release schedule from `current` down to silence. */
export const loopReleasePoints = (current: number, t: number, release: number): AutomationPoint[] => [
  { t, v: current, ramp: 'set' },
  { t: t + Math.max(release, MIN_ATTACK_SEC), v: 0, ramp: 'linear' },
];

/** Frequency schedule; exponential ramps fall back to linear when either end is not positive. */
export const sweepPoints = (startHz: number, endHz: number, curve: SweepCurve, t0: number, duration: number): AutomationPoint[] => {
  const pts: AutomationPoint[] = [{ t: t0, v: startHz, ramp: 'set' }];
  if (endHz !== startHz && duration > 0) {
    const exp = curve === 'exponential' && startHz > 0 && endHz > 0;
    pts.push({ t: t0 + duration, v: endHz, ramp: exp ? 'exponential' : 'linear' });
  }
  return pts;
};

/** Fills `out` with deterministic white noise in [-1, 1) from the injected rng and returns it. */
export const fillNoise = <T extends { length: number; [i: number]: number }>(rng: Rng, out: T): T => {
  for (let i = 0; i < out.length; i++) out[i] = rng.range(-1, 1);
  return out;
};

/** Convenience: a fresh noise buffer of `samples` floats. */
export const generateNoise = (rng: Rng, samples: number): Float32Array => fillNoise(rng, new Float32Array(Math.max(0, Math.floor(samples))));

export const applyAutomation = (param: AudioParam, points: readonly AutomationPoint[]): void => {
  for (const p of points) {
    if (p.ramp === 'set') param.setValueAtTime(p.v, p.t);
    else if (p.ramp === 'linear') param.linearRampToValueAtTime(p.v, p.t);
    else param.exponentialRampToValueAtTime(Math.max(p.v, EXP_FLOOR), p.t);
  }
};

/* ------------------------------------ null backend ------------------------------------ */

export type BackendCall =
  | { kind: 'play'; recipe: SynthRecipe; gain: number; effectiveGain: number }
  | { kind: 'startLoop'; id: string; recipe: SynthRecipe; gain: number }
  | { kind: 'stopLoop'; id: string }
  | { kind: 'setLoopGain'; id: string; gain: number; rampSec: number }
  | { kind: 'setGain'; category: SoundCategory; value: number }
  | { kind: 'resume' }
  | { kind: 'dispose' };

export interface NullAudioBackend extends AudioBackend {
  readonly kind: 'null';
  readonly calls: readonly BackendCall[];
  readonly gains: Readonly<Record<SoundCategory, number>>;
  readonly loops: ReadonlyMap<string, { recipe: SynthRecipe; gain: number }>;
  readonly resumeCount: number;
  plays(): Extract<BackendCall, { kind: 'play' }>[];
  reset(): void;
}

const unitGains = (): Record<SoundCategory, number> => ({ sfx: 1, crowd: 1, music: 1, commentary: 1 });
const clampGain = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
/** Voice gains are unbounded above (recipe × volume) but must be finite and non-negative before reaching an AudioParam. */
const safeGain = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

export const createNullBackend = (): NullAudioBackend => {
  const calls: BackendCall[] = [];
  const gains = unitGains();
  const loops = new Map<string, { recipe: SynthRecipe; gain: number }>();
  let resumeCount = 0;
  return {
    kind: 'null',
    ready: true,
    calls,
    gains,
    loops,
    get resumeCount() {
      return resumeCount;
    },
    play(recipe, gain) {
      calls.push({ kind: 'play', recipe, gain, effectiveGain: gain * gains[recipe.category] });
    },
    startLoop(id, recipe, gain) {
      loops.set(id, { recipe, gain });
      calls.push({ kind: 'startLoop', id, recipe, gain });
    },
    stopLoop(id) {
      loops.delete(id);
      calls.push({ kind: 'stopLoop', id });
    },
    setLoopGain(id, gain, rampSec = 0.25) {
      const loop = loops.get(id);
      if (loop) loop.gain = gain;
      calls.push({ kind: 'setLoopGain', id, gain, rampSec });
    },
    setGain(category, v) {
      gains[category] = clampGain(v);
      calls.push({ kind: 'setGain', category, value: gains[category] });
    },
    resume() {
      resumeCount++;
      calls.push({ kind: 'resume' });
      return Promise.resolve();
    },
    dispose() {
      loops.clear();
      calls.push({ kind: 'dispose' });
    },
    plays() {
      return calls.filter((c): c is Extract<BackendCall, { kind: 'play' }> => c.kind === 'play');
    },
    reset() {
      calls.length = 0;
    },
  };
};

/* ---------------------------------- WebAudio backend ---------------------------------- */

export interface WebAudioOptions {
  /** Source of the noise texture; defaults to a fixed seed so the buffer is reproducible. */
  rng?: Rng;
  /** Concurrent one-shot voice cap (extra plays are dropped). Default 24. */
  maxVoices?: number;
  /** Context factory (tests inject a fake; browsers default to `new AudioContext()`). Null = unsupported. */
  createContext?: () => AudioContext | null;
  /** Length of the shared noise buffer. Default 2 s. */
  noiseSeconds?: number;
}

interface Voice {
  amp: GainNode;
  tail: AudioNode;
  sources: AudioScheduledSourceNode[];
}

interface LoopEntry {
  recipe: SynthRecipe;
  gain: number;
  voice: Voice | null;
}

type Buses = Record<SoundCategory, GainNode>;

const defaultContextFactory = (): AudioContext | null => {
  const g = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? new Ctor() : null;
};

const disposeVoice = (voice: Voice): void => {
  for (const s of voice.sources) {
    s.onended = null;
    s.disconnect();
  }
  voice.amp.disconnect();
  voice.tail.disconnect();
};

/** Runs `onDone` exactly once when any of the voice's sources ends (they all stop at the same time). */
const whenEnded = (voice: Voice, onDone: () => void): void => {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone();
  };
  for (const s of voice.sources) s.onended = finish;
};

export const createWebAudioBackend = (opts: WebAudioOptions = {}): AudioBackend => {
  const rng = opts.rng ?? createRng('gridiron-audio-noise');
  const maxVoices = Math.max(1, opts.maxVoices ?? 24);
  const createContext = opts.createContext ?? defaultContextFactory;
  const gains = unitGains();
  const loops = new Map<string, LoopEntry>();
  let ctx: AudioContext | null = null;
  let buses: Buses | null = null;
  let noise: AudioBuffer | null = null;
  const oneShots = new Set<Voice>();

  const running = (): boolean => ctx !== null && ctx.state === 'running';

  const ensureContext = (): AudioContext | null => {
    if (ctx) return ctx;
    const created = createContext();
    if (!created) return null;
    ctx = created;
    const bus = (c: SoundCategory): GainNode => {
      const g = created.createGain();
      g.gain.value = gains[c];
      g.connect(created.destination);
      return g;
    };
    buses = { sfx: bus('sfx'), crowd: bus('crowd'), music: bus('music'), commentary: bus('commentary') };
    const samples = Math.max(1, Math.floor(created.sampleRate * (opts.noiseSeconds ?? 2)));
    noise = created.createBuffer(1, samples, created.sampleRate);
    fillNoise(rng, noise.getChannelData(0));
    return ctx;
  };

  const buildVoice = (c: AudioContext, out: Buses, recipe: SynthRecipe, gain: number, loop: boolean): Voice => {
    const t0 = c.currentTime;
    const dur = recipe.duration;
    const amp = c.createGain();
    let tail: AudioNode = amp;
    if (recipe.filter) {
      const f = c.createBiquadFilter();
      f.type = recipe.filter.kind;
      f.Q.value = recipe.filter.q;
      applyAutomation(f.frequency, sweepPoints(recipe.filter.hz, recipe.filter.endHz ?? recipe.filter.hz, 'exponential', t0, dur));
      amp.connect(f);
      tail = f;
    }
    tail.connect(out[recipe.category]);
    // Tremolo stage sits before the envelope so modulation never leaks through a closed envelope.
    let mix: AudioNode = amp;
    const sources: AudioScheduledSourceNode[] = [];
    if (recipe.modulation && recipe.modulation.depth > 0) {
      // LFO swings ±half around (1 - half) so the amplitude stays within [1 - depth, 1] and never inverts phase.
      const half = Math.min(1, recipe.modulation.depth) / 2;
      const trem = c.createGain();
      trem.gain.value = 1 - half;
      const lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = recipe.modulation.rateHz;
      const lfoGain = c.createGain();
      lfoGain.gain.value = half;
      lfo.connect(lfoGain);
      lfoGain.connect(trem.gain);
      trem.connect(amp);
      mix = trem;
      sources.push(lfo);
    }
    const wave = recipe.waveform;
    const noiseMix = wave === 'noise' ? 1 : Math.min(1, Math.max(0, recipe.noiseMix));
    const toneMix = 1 - noiseMix;
    if (wave !== 'noise' && toneMix > 0) {
      const partials = [1, ...(recipe.harmonics ?? [])];
      for (let i = 0; i < partials.length; i++) {
        const pg = partials[i] ?? 0;
        if (pg <= 0) continue;
        const osc = c.createOscillator();
        osc.type = wave;
        const mult = i + 1;
        applyAutomation(osc.frequency, sweepPoints(recipe.startHz * mult, recipe.endHz * mult, recipe.sweep, t0, dur));
        const g = c.createGain();
        g.gain.value = toneMix * pg;
        osc.connect(g);
        g.connect(mix);
        sources.push(osc);
      }
    }
    if (noiseMix > 0 && noise) {
      const src = c.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const g = c.createGain();
      g.gain.value = noiseMix;
      src.connect(g);
      g.connect(mix);
      sources.push(src);
    }
    applyAutomation(amp.gain, loop ? loopAttackPoints(recipe.envelope, gain, t0) : envelopePoints(recipe.envelope, gain, t0, dur));
    for (const s of sources) {
      s.start(t0);
      if (!loop) s.stop(t0 + dur + 0.05);
    }
    return { amp, tail, sources };
  };

  const startLoopVoice = (entry: LoopEntry): void => {
    if (!ctx || !buses || entry.voice) return;
    entry.voice = buildVoice(ctx, buses, entry.recipe, entry.gain, true);
  };

  const startPendingLoops = (): void => {
    if (!running()) return;
    for (const entry of loops.values()) startLoopVoice(entry);
  };

  const releaseVoice = (voice: Voice, release: number): void => {
    if (!ctx) return;
    const t = ctx.currentTime;
    const rel = Math.max(release, MIN_ATTACK_SEC);
    voice.amp.gain.cancelScheduledValues(t);
    applyAutomation(voice.amp.gain, loopReleasePoints(voice.amp.gain.value, t, rel));
    whenEnded(voice, () => disposeVoice(voice));
    for (const s of voice.sources) s.stop(t + rel + 0.05);
  };

  return {
    kind: 'webaudio',
    get ready() {
      return running();
    },
    play(recipe, gain) {
      const g = safeGain(gain);
      if (!ctx || !buses || !running() || g <= 0 || oneShots.size >= maxVoices) return;
      const voice = buildVoice(ctx, buses, recipe, g, false);
      if (voice.sources.length === 0) {
        disposeVoice(voice);
        return;
      }
      oneShots.add(voice);
      whenEnded(voice, () => {
        oneShots.delete(voice);
        disposeVoice(voice);
      });
    },
    startLoop(id, recipe, gain) {
      const existing = loops.get(id);
      if (existing?.voice) releaseVoice(existing.voice, existing.recipe.envelope.release);
      const entry: LoopEntry = { recipe, gain: safeGain(gain), voice: null };
      loops.set(id, entry);
      if (running()) startLoopVoice(entry);
    },
    stopLoop(id) {
      const entry = loops.get(id);
      if (!entry) return;
      loops.delete(id);
      if (entry.voice) releaseVoice(entry.voice, entry.recipe.envelope.release);
    },
    setLoopGain(id, gain, rampSec = 0.25) {
      const entry = loops.get(id);
      if (!entry) return;
      entry.gain = safeGain(gain);
      if (!entry.voice || !ctx) return;
      const t = ctx.currentTime;
      const p = entry.voice.amp.gain;
      p.cancelScheduledValues(t);
      applyAutomation(p, [{ t, v: p.value, ramp: 'set' }, { t: t + Math.max(rampSec, MIN_ATTACK_SEC), v: entry.gain, ramp: 'linear' }]);
    },
    setGain(category, v) {
      gains[category] = clampGain(v);
      if (ctx && buses) buses[category].gain.setTargetAtTime(gains[category], ctx.currentTime, 0.02);
    },
    async resume() {
      const c = ensureContext();
      if (!c || c.state === 'closed') return;
      if (c.state !== 'running') {
        try {
          await c.resume();
        } catch {
          return; // autoplay policy / closed context: stay silent, a later gesture retries
        }
      }
      startPendingLoops();
    },
    dispose() {
      for (const entry of loops.values()) if (entry.voice) disposeVoice(entry.voice);
      loops.clear();
      for (const voice of oneShots) disposeVoice(voice);
      oneShots.clear();
      if (buses) for (const c of SOUND_CATEGORIES) buses[c].disconnect();
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
      ctx = null;
      buses = null;
      noise = null;
    },
  };
};
