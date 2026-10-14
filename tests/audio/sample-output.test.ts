import { describe, expect, it } from 'vitest';
import { LIMITER, VOICE_CAPS, createWebSampleOutput } from '@/audio/sample-output';
import { createSharedContext } from '@/audio/sample-web';
import { FakeAudioContext, FakeBuffer, FakeCompressor, FakeConvolver, FakeGain, FakePanner } from './fake-audio-context';

const setup = () => {
  const fake = new FakeAudioContext();
  const shared = createSharedContext(() => fake.asContext());
  const out = createWebSampleOutput(shared.current);
  const buf = new FakeBuffer(100, 8000) as unknown as AudioBuffer;
  return { fake, shared, out, buf };
};

const req = { bus: 'sfx' as const, gain: 0.8, rate: 1.04, pan: 0.3, delaySec: 0.1 };

describe('createWebSampleOutput', () => {
  it('stays silent until the shared context exists and runs', async () => {
    const { fake, shared, out, buf } = setup();
    expect(out.ready).toBe(false);
    expect(out.play(buf, req)).toBeNull();
    shared.get();
    expect(out.play(buf, req)).toBeNull();
    await fake.resume();
    expect(out.ready).toBe(true);
    expect(out.play(buf, req)).not.toBeNull();
    const src = fake.bufferSources()[0]!;
    expect(src.playbackRate.value).toBeCloseTo(1.04);
    expect(src.started[0]).toBeCloseTo(0.1);
  });

  it('caps concurrent voices per bus and frees them when they end', async () => {
    const { fake, shared, out, buf } = setup();
    shared.get();
    await fake.resume();
    for (let i = 0; i < VOICE_CAPS.sfx; i++) expect(out.play(buf, req)).not.toBeNull();
    expect(out.play(buf, req)).toBeNull();
    expect(out.play(buf, { ...req, bus: 'crowd' })).not.toBeNull();
    fake.bufferSources()[0]!.fireEnded();
    expect(out.play(buf, req)).not.toBeNull();
    expect(out.play(buf, { ...req, gain: 0 })).toBeNull();
  });

  it('routes bus gains, loops beds between their loop points and fades them out', async () => {
    const { fake, shared, out, buf } = setup();
    shared.get();
    await fake.resume();
    out.setBusGain('crowd', 0.35);
    out.startBed('crowd.bed_loud', buf, { start: 0.5, end: 30.5 }, 0.6, 2);
    expect(out.hasBed('crowd.bed_loud')).toBe(true);
    const bed = fake.bufferSources()[0]!;
    expect(bed.loop).toBe(true);
    expect(bed.loopStart).toBe(0.5);
    expect(bed.loopEnd).toBe(30.5);
    expect(bed.offsets[0]).toBe(0.5);
    const gains = fake.gains();
    expect(gains.some((g: FakeGain) => g.gain.value === 0.35)).toBe(true);
    out.stopBed('crowd.bed_loud', 1);
    expect(out.hasBed('crowd.bed_loud')).toBe(false);
    expect(bed.stopped.length).toBe(1);
    out.dispose();
    expect(fake.gains().filter((g) => g.disconnected).length).toBeGreaterThan(0);
  });

  it('drops voices on a silent bus (mute / slider at 0) instead of building nodes', async () => {
    const { fake, shared, out, buf } = setup();
    shared.get();
    await fake.resume();
    out.setBusGain('sfx', 0);
    expect(out.play(buf, req)).toBeNull();
    expect(fake.bufferSources()).toHaveLength(0);
    expect(out.play(buf, { ...req, bus: 'crowd' })).not.toBeNull();
  });

  it('pans through a stereo panner, sends domes to a reverb and limits everything before the speakers', async () => {
    const fake = new FakeAudioContext().enableAdvancedNodes();
    const shared = createSharedContext(() => fake.asContext());
    const out = createWebSampleOutput(shared.current);
    const buf = new FakeBuffer(100, 8000) as unknown as AudioBuffer;
    shared.get();
    await fake.resume();
    out.setReverb(0.28);
    expect(out.play(buf, { ...req, pan: 5 })).not.toBeNull();
    const nodes = fake.nodes;
    const panner = nodes.find((n): n is FakePanner => n instanceof FakePanner);
    expect(panner?.pan.value).toBe(1);
    const limiter = nodes.find((n): n is FakeCompressor => n instanceof FakeCompressor);
    expect(limiter?.threshold.value).toBe(LIMITER.threshold);
    expect(limiter?.connections).toEqual([fake.destination]);
    // Only the limiter feeds the destination: sfx bus, crowd duck and reverb return all go through it.
    expect(nodes.filter((n) => n !== limiter && n.connections.includes(fake.destination))).toHaveLength(0);
    expect(nodes.some((n) => n instanceof FakeConvolver)).toBe(true);
    // A centred voice skips the panner; a finished voice is fully disconnected.
    out.play(buf, { ...req, pan: 0 });
    expect(nodes.filter((n) => n instanceof FakePanner)).toHaveLength(1);
    const src = fake.bufferSources()[0]!;
    src.fireEnded();
    expect(src.disconnected).toBe(true);
    expect(panner?.disconnected).toBe(true);
    out.dispose();
    expect(limiter?.disconnected).toBe(true);
  });
});
