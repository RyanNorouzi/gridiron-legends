/**
 * Playback of decoded samples. `createWebSampleOutput` builds WebAudio graphs (buffer source -> gain ->
 * stereo panner -> bus); `createRecordingSampleOutput` records every call for Node tests. Buses carry the
 * master x level gain; the crowd bus also has a duck stage (under commentary) and an optional reverb send
 * (domes). One-shot voices are capped per bus so a pile-up can never machine-gun the mixer.
 */
import { createRng } from '@/core/rng';
import type { SampleBus } from './sample-manifest';

/** How to play one one-shot. */
export interface VoiceRequest {
  bus: SampleBus;
  /** Linear gain for this voice (entry gain x cue gain x variation). */
  gain: number;
  /** Playback rate (pitch); 1 = as recorded. */
  rate: number;
  /** Stereo position -1 (left) .. 1 (right). */
  pan: number;
  /** Seconds from now. */
  delaySec: number;
}

/** Opaque id of a playing one-shot (for stopVoice). */
export type VoiceHandle = number;

/** Loop points of a bed in seconds. */
export interface BedLoop {
  start: number;
  end: number;
}

/** Where decoded samples are played (WebAudio in the browser, a recorder in tests). */
export interface SampleOutput<B> {
  /** True once the context runs (always true for the recorder). */
  readonly ready: boolean;
  /** One-shot; null when dropped (not ready, silent voice or bus, voice cap). */
  play(buffer: B, req: VoiceRequest): VoiceHandle | null;
  /** Fades a one-shot out (cut a swell on the snap). */
  stopVoice(handle: VoiceHandle, fadeSec: number): void;
  /** Starts (or replaces) a looping bed on the crowd bus at `gain`, faded in over `fadeSec`. */
  startBed(key: string, buffer: B, loop: BedLoop, gain: number, fadeSec: number): void;
  setBedGain(key: string, gain: number, rampSec: number): void;
  stopBed(key: string, fadeSec: number): void;
  hasBed(key: string): boolean;
  /** Bus gain 0..1 (master x level, 0 when muted). */
  setBusGain(bus: SampleBus, v: number): void;
  /** Crowd duck multiplier 0..1 (1 = no ducking), ramped. */
  setDuck(multiplier: number, rampSec: number): void;
  /** Crowd reverb send 0..1 (domes). */
  setReverb(wet: number): void;
  dispose(): void;
}

/** Concurrent one-shot caps per bus. */
export const VOICE_CAPS: Readonly<Record<SampleBus, number>> = Object.freeze({ sfx: 32, crowd: 6 });

const clampPan = (p: number): number => (Number.isFinite(p) ? Math.max(-1, Math.min(1, p)) : 0);
const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

/* ----------------------------------- recorder ----------------------------------- */

/** One call recorded by the test output. */
export type OutputCall<B> =
  | { kind: 'play'; handle: VoiceHandle; buffer: B; req: VoiceRequest }
  | { kind: 'stopVoice'; handle: VoiceHandle; fadeSec: number }
  | { kind: 'startBed'; key: string; buffer: B; loop: BedLoop; gain: number }
  | { kind: 'setBedGain'; key: string; gain: number }
  | { kind: 'stopBed'; key: string }
  | { kind: 'setBusGain'; bus: SampleBus; value: number }
  | { kind: 'setDuck'; value: number }
  | { kind: 'setReverb'; value: number };

/** Recording output with inspectable state; `ready` is writable to simulate a locked context. */
export interface RecordingSampleOutput<B> extends SampleOutput<B> {
  readonly calls: OutputCall<B>[];
  readonly busGains: Record<SampleBus, number>;
  readonly beds: Map<string, { buffer: B; gain: number }>;
  plays(): Extract<OutputCall<B>, { kind: 'play' }>[];
  ready: boolean;
}

/** Test/headless output: records calls, keeps bus gains and bed gains observable. */
export const createRecordingSampleOutput = <B>(): RecordingSampleOutput<B> => {
  const calls: OutputCall<B>[] = [];
  const busGains: Record<SampleBus, number> = { sfx: 1, crowd: 1 };
  const beds = new Map<string, { buffer: B; gain: number }>();
  let next = 1;
  return {
    ready: true,
    calls,
    busGains,
    beds,
    plays: () => calls.filter((c): c is Extract<OutputCall<B>, { kind: 'play' }> => c.kind === 'play'),
    play(buffer, req) {
      if (!(busGains[req.bus] > 0)) return null;
      const handle = next++;
      calls.push({ kind: 'play', handle, buffer, req });
      return handle;
    },
    stopVoice: (handle, fadeSec) => { calls.push({ kind: 'stopVoice', handle, fadeSec }); },
    startBed(key, buffer, loop, gain) {
      beds.set(key, { buffer, gain });
      calls.push({ kind: 'startBed', key, buffer, loop, gain });
    },
    setBedGain(key, gain) {
      const b = beds.get(key);
      if (b) b.gain = gain;
      calls.push({ kind: 'setBedGain', key, gain });
    },
    stopBed(key) {
      beds.delete(key);
      calls.push({ kind: 'stopBed', key });
    },
    hasBed: (key) => beds.has(key),
    setBusGain(bus, v) {
      busGains[bus] = v;
      calls.push({ kind: 'setBusGain', bus, value: v });
    },
    setDuck: (value) => { calls.push({ kind: 'setDuck', value }); },
    setReverb: (value) => { calls.push({ kind: 'setReverb', value }); },
    dispose: () => { beds.clear(); },
  };
};

/* ----------------------------------- WebAudio ----------------------------------- */

interface WebVoice {
  src: AudioBufferSourceNode;
  amp: GainNode;
  out: AudioNode;
  bus: SampleBus;
}

interface Graph {
  ctx: AudioContext;
  bus: Record<SampleBus, GainNode>;
  duck: GainNode;
  wet: GainNode | null;
  /** Safety limiter in front of the destination (stacked reactions + beds must never clip). */
  limiter: AudioNode;
}

/** Safety limiter settings: transparent below -3 dBFS, hard knee above (stacked roars never clip). */
export const LIMITER = Object.freeze({ threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });

const buildLimiter = (ctx: AudioContext): AudioNode => {
  if (typeof ctx.createDynamicsCompressor !== 'function') return ctx.destination;
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = LIMITER.threshold;
  c.knee.value = LIMITER.knee;
  c.ratio.value = LIMITER.ratio;
  c.attack.value = LIMITER.attack;
  c.release.value = LIMITER.release;
  c.connect(ctx.destination);
  return c;
};

/** Synthetic room impulse (decaying stereo noise) for the dome reverb send. */
const buildImpulse = (ctx: AudioContext, seconds: number): AudioBuffer => {
  const rng = createRng('gridiron-dome-ir');
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rng.range(-1, 1) * (1 - i / len) ** 2.5;
  }
  return ir;
};

/**
 * WebAudio sample output on the shared context from `getContext` (the synth backend's context, so one
 * user-gesture unlock covers both). Nothing is built until a context exists.
 */
export const createWebSampleOutput = (getContext: () => AudioContext | null): SampleOutput<AudioBuffer> => {
  let graph: Graph | null = null;
  const busGain: Record<SampleBus, number> = { sfx: 1, crowd: 1 };
  let reverb = 0;
  let handleSeq = 1;
  const voices = new Map<VoiceHandle, WebVoice>();
  const beds = new Map<string, WebVoice>();

  const ensure = (): Graph | null => {
    const ctx = getContext();
    if (!ctx || ctx.state === 'closed') return null;
    if (graph && graph.ctx === ctx) return graph;
    const mk = (v: number): GainNode => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const bus = { sfx: mk(busGain.sfx), crowd: mk(busGain.crowd) };
    const duck = mk(1);
    const limiter = buildLimiter(ctx);
    bus.sfx.connect(limiter);
    bus.crowd.connect(duck);
    duck.connect(limiter);
    let wet: GainNode | null = null;
    if (typeof ctx.createConvolver === 'function') {
      const conv = ctx.createConvolver();
      conv.buffer = buildImpulse(ctx, 2.2);
      wet = mk(reverb);
      duck.connect(conv);
      conv.connect(wet);
      wet.connect(limiter);
    }
    graph = { ctx, bus, duck, wet, limiter };
    return graph;
  };

  const running = (): boolean => { const g = ensure(); return g !== null && g.ctx.state === 'running'; };

  const build = (g: Graph, buffer: AudioBuffer, bus: SampleBus, gain: number, rate: number, pan: number): WebVoice => {
    const src = g.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate > 0 && Number.isFinite(rate) ? rate : 1;
    const amp = g.ctx.createGain();
    amp.gain.value = gain;
    src.connect(amp);
    let out: AudioNode = amp;
    if (pan !== 0 && typeof g.ctx.createStereoPanner === 'function') {
      const p = g.ctx.createStereoPanner();
      p.pan.value = pan;
      amp.connect(p);
      out = p;
    }
    out.connect(g.bus[bus]);
    return { src, amp, out, bus };
  };

  const release = (v: WebVoice): void => {
    v.src.onended = null;
    v.src.disconnect();
    v.amp.disconnect();
    if (v.out !== v.amp) v.out.disconnect();
  };

  const fadeOut = (v: WebVoice, fadeSec: number): void => {
    const g = graph;
    if (!g) return release(v);
    const t = g.ctx.currentTime;
    const f = Math.max(0.01, fadeSec);
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setValueAtTime(v.amp.gain.value, t);
    v.amp.gain.linearRampToValueAtTime(0, t + f);
    try { v.src.stop(t + f + 0.02); } catch { release(v); }
  };

  const ramp = (param: AudioParam, target: number, sec: number): void => {
    const g = graph;
    if (!g) return;
    const t = g.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(target, t + Math.max(0.01, sec));
  };

  return {
    get ready() { return running(); },
    play(buffer, req) {
      const gain = safe(req.gain);
      if (gain <= 0 || !(busGain[req.bus] > 0) || !running() || !graph) return null;
      let count = 0;
      for (const v of voices.values()) if (v.bus === req.bus) count++;
      if (count >= VOICE_CAPS[req.bus]) return null;
      const v = build(graph, buffer, req.bus, gain, req.rate, clampPan(req.pan));
      const handle = handleSeq++;
      voices.set(handle, v);
      v.src.onended = () => { voices.delete(handle); release(v); };
      v.src.start(graph.ctx.currentTime + Math.max(0, req.delaySec));
      return handle;
    },
    stopVoice(handle, fadeSec) {
      const v = voices.get(handle);
      if (v) fadeOut(v, fadeSec);
    },
    startBed(key, buffer, loop, gain, fadeSec) {
      const old = beds.get(key);
      if (old) { beds.delete(key); fadeOut(old, fadeSec); }
      const g = ensure();
      if (!g) return;
      const v = build(g, buffer, 'crowd', 0, 1, 0);
      v.src.loop = true;
      v.src.loopStart = loop.start;
      v.src.loopEnd = loop.end;
      v.src.onended = () => release(v);
      v.src.start(g.ctx.currentTime, loop.start);
      ramp(v.amp.gain, safe(gain), fadeSec);
      beds.set(key, v);
    },
    setBedGain(key, gain, rampSec) {
      const v = beds.get(key);
      if (v) ramp(v.amp.gain, safe(gain), rampSec);
    },
    stopBed(key, fadeSec) {
      const v = beds.get(key);
      if (!v) return;
      beds.delete(key);
      fadeOut(v, fadeSec);
    },
    hasBed: (key) => beds.has(key),
    setBusGain(bus, v) {
      busGain[bus] = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
      if (graph) graph.bus[bus].gain.setTargetAtTime(busGain[bus], graph.ctx.currentTime, 0.02);
    },
    setDuck(multiplier, rampSec) {
      if (graph) ramp(graph.duck.gain, Math.max(0, Math.min(1, multiplier)), rampSec);
    },
    setReverb(wet) {
      reverb = Math.max(0, Math.min(1, Number.isFinite(wet) ? wet : 0));
      if (graph?.wet) ramp(graph.wet.gain, reverb, 0.5);
    },
    dispose() {
      for (const v of voices.values()) release(v);
      for (const v of beds.values()) { try { v.src.stop(); } catch { /* never started */ } release(v); }
      voices.clear();
      beds.clear();
      if (graph) {
        graph.bus.sfx.disconnect();
        graph.bus.crowd.disconnect();
        graph.duck.disconnect();
        graph.wet?.disconnect();
        if (graph.limiter !== graph.ctx.destination) graph.limiter.disconnect();
      }
      graph = null;
    },
  };
};
