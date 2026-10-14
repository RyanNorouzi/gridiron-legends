import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { SOUNDS } from '@/audio/sounds';
import {
  MIN_ATTACK_SEC, createNullBackend, createWebAudioBackend, envelopePoints, fillNoise, generateNoise, loopAttackPoints,
  loopReleasePoints, sweepPoints,
} from '@/audio/synth';
import { FakeAudioContext, FakeGain, FakeOscillator } from './fake-audio-context';

describe('automation helpers', () => {
  it('envelopePoints builds a full ADSR that starts and ends at silence', () => {
    const pts = envelopePoints({ attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.1 }, 0.8, 2, 0.5);
    expect(pts[0]).toEqual({ t: 2, v: 0, ramp: 'set' });
    expect(pts[1]).toEqual({ t: 2.01, v: 0.8, ramp: 'linear' });
    expect(pts[2]?.v).toBeCloseTo(0.4);
    expect(pts[2]?.t).toBeCloseTo(2.06);
    expect(pts[3]).toEqual({ t: 2.4, v: 0.4, ramp: 'linear' });
    expect(pts[pts.length - 1]).toEqual({ t: 2.5, v: 0, ramp: 'linear' });
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThanOrEqual(pts[i - 1]!.t);
  });

  it('envelopePoints clamps stages that do not fit the duration and enforces a minimum attack', () => {
    const pts = envelopePoints({ attack: 0, decay: 1, sustain: 0.2, release: 1 }, 1, 0, 0.1);
    expect(pts[1]?.t).toBe(MIN_ATTACK_SEC);
    expect(pts[pts.length - 1]).toEqual({ t: 0.1, v: 0, ramp: 'linear' });
    expect(pts.every((p) => p.t <= 0.1 + 1e-12)).toBe(true);
    // zero decay holds at the peak rather than jumping to the sustain level
    const hold = envelopePoints({ attack: 0.01, decay: 0, sustain: 0.1, release: 0.01 }, 1, 0, 0.2);
    expect(hold.map((p) => p.v)).toEqual([0, 1, 1, 0]);
  });

  it('loop attack/release schedules', () => {
    expect(loopAttackPoints({ attack: 1.5, decay: 0, sustain: 1, release: 1 }, 0.3, 5)).toEqual([
      { t: 5, v: 0, ramp: 'set' },
      { t: 6.5, v: 0.3, ramp: 'linear' },
    ]);
    expect(loopReleasePoints(0.25, 3, 0)).toEqual([
      { t: 3, v: 0.25, ramp: 'set' },
      { t: 3 + MIN_ATTACK_SEC, v: 0, ramp: 'linear' },
    ]);
  });

  it('sweepPoints picks exponential only for positive ends and skips flat sweeps', () => {
    expect(sweepPoints(120, 45, 'exponential', 1, 0.2)).toEqual([
      { t: 1, v: 120, ramp: 'set' },
      { t: 1.2, v: 45, ramp: 'exponential' },
    ]);
    expect(sweepPoints(0, 200, 'exponential', 0, 1)[1]?.ramp).toBe('linear');
    expect(sweepPoints(440, 440, 'exponential', 0, 1)).toHaveLength(1);
    expect(sweepPoints(200, 100, 'linear', 0, 1)[1]?.ramp).toBe('linear');
  });

  it('noise is deterministic per seed and bounded', () => {
    const a = generateNoise(createRng(7), 512);
    const b = generateNoise(createRng(7), 512);
    const c = generateNoise(createRng(8), 512);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(a.every((v) => v >= -1 && v < 1)).toBe(true);
    const target = new Float32Array(4);
    expect(fillNoise(createRng(1), target)).toBe(target);
    expect(generateNoise(createRng(1), -3)).toHaveLength(0);
  });
});

describe('null backend', () => {
  it('records calls, applies category gains to effective play gain and tracks loops', () => {
    const b = createNullBackend();
    expect(b.kind).toBe('null');
    expect(b.ready).toBe(true);
    b.setGain('sfx', 0.5);
    b.setGain('crowd', 2);
    b.setGain('music', Number.NaN);
    b.play(SOUNDS.tackle, 0.4);
    b.startLoop('bed', SOUNDS.crowdAmbient, 0.2);
    b.setLoopGain('bed', 0.3);
    b.stopLoop('bed');
    expect(b.gains).toEqual({ sfx: 0.5, crowd: 1, music: 0, commentary: 1 });
    expect(b.plays()[0]).toMatchObject({ gain: 0.4, effectiveGain: 0.2 });
    expect(b.calls.map((c) => c.kind)).toEqual(['setGain', 'setGain', 'setGain', 'play', 'startLoop', 'setLoopGain', 'stopLoop']);
    expect(b.loops.size).toBe(0);
    b.reset();
    expect(b.calls).toHaveLength(0);
  });

  it('resume resolves and counts', async () => {
    const b = createNullBackend();
    await b.resume();
    await b.resume();
    expect(b.resumeCount).toBe(2);
    b.startLoop('x', SOUNDS.crowdAmbient, 1);
    b.dispose();
    expect(b.loops.size).toBe(0);
  });
});

const setup = (opts: { maxVoices?: number } = {}) => {
  const fakes: FakeAudioContext[] = [new FakeAudioContext()];
  let created = 0;
  const backend = createWebAudioBackend({
    rng: createRng(3),
    maxVoices: opts.maxVoices,
    noiseSeconds: 0.01,
    createContext: () => {
      created++;
      if (created > 1) fakes.push(new FakeAudioContext());
      return fakes[fakes.length - 1]!.asContext();
    },
  });
  return { fake: fakes[0]!, backend, created: () => created, latest: () => fakes[fakes.length - 1]! };
};

describe('WebAudio backend', () => {
  it('creates the context lazily on resume, wires category buses and starts pending loops', async () => {
    const { fake, backend, created } = setup();
    expect(backend.kind).toBe('webaudio');
    expect(backend.ready).toBe(false);
    backend.setGain('crowd', 0.25);
    backend.play(SOUNDS.tackle, 0.5);
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.3);
    expect(created()).toBe(0);
    expect(fake.nodes).toHaveLength(0);
    await backend.resume();
    expect(created()).toBe(1);
    expect(backend.ready).toBe(true);
    expect(fake.resumeCalls).toBe(1);
    const buses = fake.buses();
    expect(buses).toHaveLength(4);
    expect(buses[1]?.gain.value).toBe(0.25);
    expect(fake.buffers[0]?.length).toBe(80);
    expect(fake.buffers[0]?.data.some((v) => v !== 0)).toBe(true);
    // the pending crowd loop is now sounding: looping noise source with an attack ramp and an LFO
    const noiseSources = fake.bufferSources();
    expect(noiseSources).toHaveLength(1);
    expect(noiseSources[0]?.loop).toBe(true);
    expect(noiseSources[0]?.started).toEqual([0]);
    expect(noiseSources[0]?.stopped).toEqual([]);
    expect(fake.oscillators().map((o) => o.frequency.value)).toEqual([SOUNDS.crowdAmbient.modulation?.rateHz]);
    await backend.resume();
    expect(created()).toBe(1);
    expect(fake.bufferSources()).toHaveLength(1);
  });

  it('builds tone + noise + filter voices routed to the right bus with an ADSR ending at silence', async () => {
    const { fake, backend } = setup();
    await backend.resume();
    fake.currentTime = 10;
    backend.play(SOUNDS.tackle, 0.6);
    const [osc] = fake.oscillators();
    expect(osc?.type).toBe('sine');
    expect(osc?.frequency.events).toEqual([
      { kind: 'set', v: 120, t: 10 },
      { kind: 'exp', v: 45, t: 10 + SOUNDS.tackle.duration },
    ]);
    const filter = fake.filters()[0];
    expect(filter?.type).toBe('lowpass');
    expect(filter?.connections[0]).toBe(fake.buses()[0]);
    const amp = fake.gains().find((g) => g.connections.includes(filter!));
    expect(amp).toBeDefined();
    const env = amp!.gain.events;
    expect(env[0]).toEqual({ kind: 'set', v: 0, t: 10 });
    expect(env[1]).toEqual({ kind: 'linear', v: 0.6, t: 10.003 });
    expect(env[env.length - 1]).toMatchObject({ kind: 'linear', v: 0 });
    expect(env[env.length - 1]?.t).toBeCloseTo(10 + SOUNDS.tackle.duration);
    for (const s of [...fake.oscillators(), ...fake.bufferSources()]) {
      expect(s.started).toEqual([10]);
      expect(s.stopped[0]).toBeCloseTo(10 + SOUNDS.tackle.duration + 0.05);
    }
  });

  it('adds harmonic partials, tremolo LFOs and linear sweeps as the recipe asks', async () => {
    const { fake, backend } = setup();
    await backend.resume();
    backend.play(SOUNDS.fieldGoal, 0.5);
    expect(fake.oscillators().map((o) => o.frequency.value)).toEqual([880, 1760, 2640]);
    expect(fake.bufferSources()).toHaveLength(0);
    fake.nodes.length = 0;
    backend.play(SOUNDS.whistle, 0.5);
    const oscs = fake.oscillators();
    const lfo = oscs.find((o) => o.frequency.value === 28);
    expect(lfo).toBeDefined();
    const lfoGain = lfo!.connections[0];
    expect(lfoGain).toBeInstanceOf(FakeGain);
    const tremolo = fake.gains().find((g) => (lfoGain as FakeGain).connections.includes(g.gain));
    // LFO of ±depth/2 around 1 - depth/2 keeps the amplitude inside [1 - depth, 1] (never negative)
    expect(tremolo?.gain.value).toBeCloseTo(1 - 0.35 / 2);
    expect((lfoGain as FakeGain).gain.value).toBeCloseTo(0.35 / 2);
    fake.nodes.length = 0;
    backend.play(SOUNDS.penaltyFlag, 0.5);
    const deepLfoGain = fake.oscillators().find((o) => o.frequency.value === 40)!.connections[0] as FakeGain;
    const deepTremolo = fake.gains().find((g) => deepLfoGain.connections.includes(g.gain))!;
    expect(deepTremolo.gain.value - deepLfoGain.gain.value).toBeGreaterThanOrEqual(0);
    expect(deepTremolo.gain.value + deepLfoGain.gain.value).toBeCloseTo(1);
    const fundamental = oscs.find((o) => o.frequency.events[0]?.v === 2400);
    expect(fundamental?.frequency.events[1]).toEqual({ kind: 'linear', v: 2450, t: SOUNDS.whistle.duration });
  });

  it('drops plays beyond maxVoices until a voice ends and drops silent plays', async () => {
    const { fake, backend } = setup({ maxVoices: 2 });
    await backend.resume();
    backend.play(SOUNDS.menuMove, 0.3);
    backend.play(SOUNDS.menuMove, 0.3);
    expect(fake.oscillators()).toHaveLength(2);
    backend.play(SOUNDS.menuMove, 0.3);
    expect(fake.oscillators()).toHaveLength(2);
    fake.oscillators()[0]!.fireEnded();
    expect(fake.oscillators()[0]?.disconnected).toBe(true);
    backend.play(SOUNDS.menuMove, 0.3);
    expect(fake.oscillators()).toHaveLength(3);
    backend.play(SOUNDS.menuMove, 0);
    backend.play(SOUNDS.menuMove, Number.NaN);
    backend.play(SOUNDS.menuMove, Number.POSITIVE_INFINITY);
    expect(fake.oscillators()).toHaveLength(3);
  });

  it('never lets a non-finite loop gain reach an AudioParam', async () => {
    const { fake, backend } = setup();
    await backend.resume();
    backend.startLoop('bed', SOUNDS.crowdAmbient, Number.NaN);
    const amp = fake.gains().find((g) => g.gain.events.length === 2)!;
    expect(amp.gain.events[1]?.v).toBe(0);
    backend.setLoopGain('bed', Number.POSITIVE_INFINITY, 0.5);
    backend.setLoopGain('bed', -2, 0.5);
    expect(amp.gain.events.every((e) => Number.isFinite(e.v) && e.v >= 0)).toBe(true);
    expect(amp.gain.events[amp.gain.events.length - 1]).toMatchObject({ kind: 'linear', v: 0 });
  });

  it('resolves resume() without throwing when the platform rejects it and retries on the next call', async () => {
    const { fake, backend } = setup();
    fake.resumeError = new Error('NotAllowedError');
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.2);
    await expect(backend.resume()).resolves.toBeUndefined();
    expect(backend.ready).toBe(false);
    expect(fake.bufferSources()).toHaveLength(0);
    fake.resumeError = null;
    await backend.resume();
    expect(backend.ready).toBe(true);
    expect(fake.bufferSources()).toHaveLength(1);
  });

  it('ramps loop gain, releases loops on stop and replaces loops with the same id', async () => {
    const { fake, backend } = setup();
    await backend.resume();
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.2);
    const src = fake.bufferSources()[0]!;
    const amp = fake.gains().find((g) => g.gain.events.some((e) => e.v === 0.2))!;
    fake.currentTime = 4;
    backend.setLoopGain('bed', 0.5, 1);
    expect(amp.gain.events.slice(-3)).toEqual([
      { kind: 'cancel', v: 0, t: 4 },
      { kind: 'set', v: 0.2, t: 4 },
      { kind: 'linear', v: 0.5, t: 5 },
    ]);
    backend.setLoopGain('missing', 1);
    fake.currentTime = 6;
    backend.stopLoop('bed');
    expect(amp.gain.events[amp.gain.events.length - 1]).toEqual({ kind: 'linear', v: 0, t: 6 + SOUNDS.crowdAmbient.envelope.release });
    expect(src.stopped[0]).toBeCloseTo(6 + SOUNDS.crowdAmbient.envelope.release + 0.05);
    src.fireEnded();
    expect(src.disconnected).toBe(true);
    backend.stopLoop('bed');
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.1);
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.15);
    const sources = fake.bufferSources();
    expect(sources).toHaveLength(3);
    expect(sources[1]?.stopped).toHaveLength(1);
    expect(sources[2]?.stopped).toHaveLength(0);
  });

  it('applies category gain changes to live buses with a short smoothing ramp', async () => {
    const { fake, backend } = setup();
    await backend.resume();
    fake.currentTime = 2;
    backend.setGain('sfx', 0.4);
    backend.setGain('music', -1);
    expect(fake.buses()[0]?.gain.events).toEqual([{ kind: 'target', v: 0.4, t: 2 }]);
    expect(fake.buses()[2]?.gain.events).toEqual([{ kind: 'target', v: 0, t: 2 }]);
  });

  it('stays inert when the platform has no AudioContext', async () => {
    const backend = createWebAudioBackend({ createContext: () => null });
    await expect(backend.resume()).resolves.toBeUndefined();
    expect(backend.ready).toBe(false);
    expect(() => backend.play(SOUNDS.tackle, 1)).not.toThrow();
    expect(() => backend.startLoop('x', SOUNDS.crowdAmbient, 1)).not.toThrow();
    expect(() => backend.stopLoop('x')).not.toThrow();
    expect(() => backend.dispose()).not.toThrow();
  });

  it('dispose closes the context and a later resume rebuilds a fresh one', async () => {
    const { fake, backend, created, latest } = setup();
    await backend.resume();
    backend.startLoop('bed', SOUNDS.crowdAmbient, 0.2);
    backend.play(SOUNDS.menuMove, 0.5);
    const oneShot = fake.oscillators().find((o) => o.stopped.length > 0)!;
    backend.dispose();
    expect(fake.closeCalls).toBe(1);
    expect(fake.state).toBe('closed');
    expect(backend.ready).toBe(false);
    expect(fake.gains().slice(0, 4).every((b) => b.disconnected)).toBe(true);
    expect(fake.bufferSources()[0]?.disconnected).toBe(true);
    // one-shots are released too, and a late 'ended' from the old context is harmless
    expect(oneShot.disconnected).toBe(true);
    expect(oneShot.onended).toBeNull();
    const nodesBefore = fake.nodes.length;
    backend.play(SOUNDS.tackle, 1);
    expect(fake.nodes).toHaveLength(nodesBefore);
    await backend.resume();
    expect(created()).toBe(2);
    expect(backend.ready).toBe(true);
    const fresh = latest();
    expect(fresh).not.toBe(fake);
    // loops were forgotten by dispose, so nothing restarts; the new context gets its own buses
    expect(fresh.buses()).toHaveLength(4);
    expect(fresh.bufferSources()).toHaveLength(0);
    backend.play(SOUNDS.menuMove, 0.5);
    expect(fresh.oscillators().filter((o) => o instanceof FakeOscillator && o.started.length > 0)).toHaveLength(1);
  });

  it('keeps the voice cap accurate across dispose and rebuild', async () => {
    const { backend, latest } = setup({ maxVoices: 2 });
    await backend.resume();
    backend.play(SOUNDS.menuMove, 0.3);
    backend.play(SOUNDS.menuMove, 0.3);
    backend.dispose();
    await backend.resume();
    const fresh = latest();
    backend.play(SOUNDS.menuMove, 0.3);
    backend.play(SOUNDS.menuMove, 0.3);
    backend.play(SOUNDS.menuMove, 0.3);
    expect(fresh.oscillators()).toHaveLength(2);
  });
});
