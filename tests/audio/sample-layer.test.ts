import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { AudioLevels } from '@/core/settings';
import type { PlayEvent } from '@/game/play-events';
import { createAudio } from '@/audio/index';
import { AudioManager, CROWD_LOOP_ID } from '@/audio/manager';
import { SampleBank } from '@/audio/sample-bank';
import type { AudioScene } from '@/audio/sample-cues';
import { CONTACT_BOOST, GAIN_SPREAD, SampleLayer } from '@/audio/sample-layer';
import { IMPACT_DUCK, IMPACT_DUCK_BIG } from '@/audio/crowd-engine';
import { sampleIdsFor } from '@/audio/sample-manifest';
import { createRecordingSampleOutput } from '@/audio/sample-output';
import { createNullBackend } from '@/audio/synth';
import type { CrowdSituation } from '@/audio/crowd-model';
import { LAYERED_UNDER, SYNTH_UNDER_SAMPLES } from '@/audio/crowd-cues';
import type { GameEvent } from '@/game/game-controller';
import { audioEventFor } from '@/ui/game/banners';

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/audio/manifest.json', import.meta.url)), 'utf8')) as unknown;
const LEVELS: AudioLevels = { master: 0.5, sfx: 0.8, music: 0.6, crowd: 1, commentary: 0.4 };

const ev = <T extends PlayEvent['type']>(type: T, extra: Omit<Extract<PlayEvent, { type: T }>, 'type' | 'tick'>): PlayEvent =>
  ({ type, tick: 0, ...extra }) as PlayEvent;

const make = (opts: { fail?: (file: string) => boolean; manifest?: () => Promise<unknown>; seed?: number; crowdNoise?: 'max' | 'reactive' } = {}) => {
  let t = 1000;
  const backend = createNullBackend();
  const output = createRecordingSampleOutput<string>();
  const bank = new SampleBank<string>(
    (file) => (opts.fail?.(file) ? Promise.reject(new Error('404')) : Promise.resolve(`buf:${file}`)),
    opts.manifest ?? (() => Promise.resolve(MANIFEST)),
  );
  const layer = new SampleLayer({ bank, output, rng: createRng(opts.seed ?? 11), now: () => t });
  // The reactive crowd by default here: most tests below check how it follows the game ('max' has its own test).
  const audio = new AudioManager(backend, LEVELS, { now: () => t, samples: layer, crowdNoise: opts.crowdNoise ?? 'reactive' });
  return { audio, backend, output, bank, layer, advance: (ms: number) => (t += ms) };
};

const synthIds = (backend: ReturnType<typeof createNullBackend>) => backend.plays().map((p) => p.recipe);
const sampleIds = (output: ReturnType<typeof createRecordingSampleOutput<string>>) => output.plays().map((p) => p.buffer.replace(/^buf:/, '').replace(/_\d+\.m4a$/, ''));

const situation = (over: Partial<CrowdSituation> = {}): CrowdSituation => ({
  offense: 'away', down: 1, distance: 10, ballOn: 40, quarter: 2, clockRemaining: 600, scoreDiff: 0, special: 'none', crowdFactor: 0.8, ...over,
});

describe('SampleLayer + AudioManager', () => {
  it('falls back to the synth until the recordings are decoded', () => {
    const { audio, backend, output } = make();
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual(['whistle']);
    expect(output.plays()).toHaveLength(0);
    expect(backend.plays()).toHaveLength(1);
  });

  it('after the unlock gesture, a real whistle replaces the synth one and captions still fire', async () => {
    const { audio, backend, output, layer } = make();
    const captions: string[] = [];
    audio.onCaption((c) => captions.push(c));
    void audio.resume();
    await layer.unlock();
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual([]);
    expect(sampleIds(output)).toEqual(['sfx/whistle_short']);
    expect(synthIds(backend)).toHaveLength(0);
    expect(captions).toEqual(['[WHISTLE]']);
    const req = output.plays()[0]!.req;
    expect(req.bus).toBe('sfx');
    expect(req.rate).toBeGreaterThan(0.97);
    expect(req.rate).toBeLessThan(1.03);
  });

  it('layers real hits on top of a softened synth hit, with a crowd oooh once the crowd is loaded', async () => {
    const { audio, backend, output, bank, layer } = make();
    await layer.unlock();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    audio.setPossession('away');
    const scene: AudioScene = {
      ctx: { direction: 1 }, ball: { pos: { x: 26, y: 50 } },
      athletes: [
        { id: 'def:MLB', pos: { x: 26, y: 50 }, vel: { x: 0, y: -8 }, massLb: 245 },
        { id: 'off:RB', pos: { x: 26, y: 50 }, vel: { x: 0, y: 3 }, massLb: 215 },
      ],
    };
    audio.onGameEvent(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'hitStick', assists: [] }), scene);
    expect(sampleIds(output)).toEqual(['sfx/tackle_big', 'sfx/helmet_clack', 'sfx/pad_clatter', 'sfx/grunt_hit', 'sfx/turf', 'crowd/cheer', 'crowd/oooh']);
    const bigHit = backend.plays().find((p) => p.recipe.category === 'sfx');
    expect(bigHit).toBeDefined();
    expect(LAYERED_UNDER.has('bigHit')).toBe(true);
    // The synth big hit still plays, softened under the recordings.
    expect(bigHit!.gain).toBeCloseTo(bigHit!.recipe.gain * SYNTH_UNDER_SAMPLES);
    // The home crowd cheers the defense's hit: recorded, so the synth cheer steps aside.
    expect(backend.plays().filter((p) => p.recipe.category === 'crowd')).toHaveLength(0);
  });

  it('plays body hits boosted past the cue ceiling, sounds every block lock-up, and dips the crowd for an instant', async () => {
    const { audio, output, bank, layer, advance } = make({ crowdNoise: 'max' });
    await layer.unlock();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    const before = output.calls.length;
    audio.onGameEvent(ev('blockEngage', { blocker: 'off:LT', defender: 'def:DE1', kind: 'pass' }));
    const hit = output.plays().find((p) => p.buffer.includes('tackle_light'));
    expect(hit, 'a pass-set lock-up pops').toBeDefined();
    const base = bank.entry('sfx.tackle_light')?.gain ?? 0;
    expect(hit!.req.gain).toBeGreaterThan(base * GAIN_SPREAD[0] * CONTACT_BOOST * 0.99);
    const dips = output.calls.slice(before).filter((c): c is Extract<typeof c, { kind: 'setDuck' }> => c.kind === 'setDuck' && c.value < 1);
    expect(dips.map((c) => c.value)).toEqual([IMPACT_DUCK]);
    // A run block a moment later is a heavier thud.
    advance(120);
    audio.onGameEvent(ev('blockEngage', { blocker: 'off:RG', defender: 'def:DT1', kind: 'run' }));
    expect(sampleIds(output)).toContain('sfx/tackle_solid');
    // ... and the crowd roars straight back.
    for (let i = 0; i < 30; i++) { advance(1000 / 60); audio.updateMusic(1 / 60, null); }
    const last = output.calls.filter((c): c is Extract<typeof c, { kind: 'setDuck' }> => c.kind === 'setDuck').at(-1);
    expect(last?.value).toBe(1);
  });

  it('keeps the synth when a recording fails to load', async () => {
    const { audio, backend, output, layer } = make({ fail: (f) => f.includes('whistle') });
    await layer.unlock();
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual(['whistle']);
    expect(output.plays()).toHaveLength(0);
    expect(backend.plays()).toHaveLength(1);
  });

  it('keeps the synth when the manifest is unreachable', async () => {
    const { audio, backend, layer } = make({ manifest: () => Promise.reject(new Error('offline')) });
    await layer.unlock();
    expect(audio.onGameEvent(ev('snap', {}))).toEqual(['snap']);
    expect(backend.plays()[0]!.gain).toBeGreaterThan(0);
  });

  it('throttles repeats (no machine-gun whistles) and varies the variant', async () => {
    const { audio, output, layer, advance } = make();
    await layer.unlock();
    audio.onGameEvent(ev('whistle', { reason: 'tackle' }));
    advance(100);
    audio.onGameEvent(ev('whistle', { reason: 'tackle' }));
    expect(output.plays()).toHaveLength(1);
    advance(700);
    audio.onGameEvent(ev('whistle', { reason: 'tackle' }));
    const [a, b] = output.plays();
    expect(b).toBeDefined();
    expect(a!.buffer).not.toBe(b!.buffer);
  });

  it('keeps the synth whistle when the recording is dropped, but not while a real one is still ringing', async () => {
    const { audio, backend, output, layer, advance } = make();
    await layer.unlock();
    audio.setLevels({ ...LEVELS, sfx: 0 });
    // Silent sfx bus: the recording is dropped, so the synth stand-in is not replaced by silence.
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual(['whistle']);
    expect(output.plays()).toHaveLength(0);
    audio.setLevels(LEVELS);
    advance(100);
    const synthBefore = backend.plays().length;
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual([]);
    expect(output.plays()).toHaveLength(1);
    // A second whistle inside the cooldown: the real one is still sounding, the synth stays out.
    advance(200);
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual([]);
    expect(output.plays()).toHaveLength(1);
    expect(backend.plays()).toHaveLength(synthBefore);
  });

  it('boos a flag on the home team instead of the synth groan (no double reaction)', async () => {
    const { audio, backend, output, bank } = make();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    audio.setPossession('away');
    const penalty = { foul: 'holdingOffense', side: 'defense', yards: 10, playerId: null, automaticFirstDown: false, lossOfDown: false, enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: false } as const;
    const played = audio.onGameEvent(ev('penalty', { penalty }));
    expect(sampleIds(output)).toContain('crowd/boo');
    expect(played).not.toContain('crowdGroan');
    expect(backend.plays().filter((p) => p.recipe.category === 'crowd')).toHaveLength(0);
  });

  it('keeps the crowd phase in step while muted', async () => {
    const { audio, layer } = make();
    await layer.unlock();
    audio.crowd(0.5);
    audio.onGameEvent({ type: 'possession', offense: 'home', play: situation({ offense: 'home' }) });
    const huddle = layer.crowd.target();
    audio.mute();
    audio.onGameEvent(ev('snap', {}));
    for (let i = 0; i < 180; i++) audio.updateMusic(1 / 60, null);
    audio.unmute();
    expect(layer.crowd.target()).toBeGreaterThan(huddle + 0.1);
  });

  it('is deterministic for a given rng seed', async () => {
    const run = async (): Promise<string[]> => {
      const { audio, output, layer, advance } = make({ seed: 5 });
      await layer.unlock();
      for (let i = 0; i < 6; i++) {
        audio.onGameEvent(ev('snap', {}));
        advance(1000);
      }
      return output.plays().map((p) => `${p.buffer}@${p.req.rate.toFixed(4)}`);
    };
    expect(await run()).toEqual(await run());
  });

  it('drives the sample buses from master x level and mute', () => {
    const { audio, output } = make();
    expect(output.busGains.sfx).toBeCloseTo(0.4);
    expect(output.busGains.crowd).toBeCloseTo(0.5);
    audio.setLevels({ ...LEVELS, crowd: 0.2 });
    expect(output.busGains.crowd).toBeCloseTo(0.1);
    audio.mute();
    expect(output.busGains).toEqual({ sfx: 0, crowd: 0 });
    audio.unmute();
    expect(output.busGains.sfx).toBeCloseTo(0.4);
  });

  it('plays no recordings while muted', async () => {
    const { audio, output, layer } = make();
    await layer.unlock();
    audio.mute();
    audio.onGameEvent(ev('snap', {}));
    expect(output.plays()).toHaveLength(0);
  });

  it('runs the crowd beds: starts once decoded, takes over from the synth loop, gets loud on 3rd down, stops on leave', async () => {
    const { audio, backend, output, bank, layer } = make();
    audio.setCrowdSide('home');
    audio.crowd(0.5);
    expect(backend.loops.has(CROWD_LOOP_ID)).toBe(true);
    await bank.preload(sampleIdsFor('crowd'));
    audio.updateMusic(1 / 60, null);
    expect(layer.bedsActive).toBe(true);
    expect(backend.loops.get(CROWD_LOOP_ID)?.gain).toBe(0);
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 1 }), stadium: { capacity: 70000, roof: 'open' } });
    for (let i = 0; i < 180; i++) audio.updateMusic(1 / 60, null);
    const calm = layer.crowd.level;
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 3, distance: 9 }) });
    expect(sampleIds(output)).toContain('crowd/defense_build');
    for (let i = 0; i < 180; i++) audio.updateMusic(1 / 60, null);
    expect(layer.crowd.level).toBeGreaterThan(calm + 0.2);
    expect(output.beds.get('crowd.bed_loud')!.gain).toBeGreaterThan(0);
    // The snap cuts the build-up.
    audio.onGameEvent(ev('snap', {}));
    expect(output.calls.some((c) => c.kind === 'stopVoice')).toBe(true);
    audio.stop();
    expect(output.beds.size).toBe(0);
    expect(layer.bedsActive).toBe(false);
  });

  it('turns to the next snap between plays: a guessed 3rd-down stand builds while the play is being called', async () => {
    const { audio, output, bank, layer } = make();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    const tick = (sec: number) => { for (let i = 0; i < sec * 60; i++) audio.updateMusic(1 / 60, null); };
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 2, distance: 8 }) });
    audio.onGameEvent(ev('snap', {}));
    tick(1);
    audio.onGameEvent(ev('whistle', { reason: 'tackle' }));
    tick(1);
    const reacting = layer.crowd.level;
    expect(sampleIds(output)).not.toContain('crowd/defense_build');
    tick(2.5);
    // 2nd down -> guessed 3rd down against the home defense: loud, with the build-up clip.
    expect(layer.crowd.level).toBeGreaterThan(reacting + 0.2);
    expect(sampleIds(output).filter((id) => id === 'crowd/defense_build')).toHaveLength(1);
    // The real 3rd down arrives: the running build-up carries on (not restarted, not cut) until the snap.
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 3, distance: 6 }) });
    expect(sampleIds(output).filter((id) => id === 'crowd/defense_build')).toHaveLength(1);
    expect(output.calls.some((c) => c.kind === 'stopVoice')).toBe(false);
    audio.onGameEvent(ev('snap', {}));
    expect(output.calls.some((c) => c.kind === 'stopVoice')).toBe(true);
  });

  it('uses the applied result for the next down (no first-down play event, fast-simulated plays)', async () => {
    const { audio, output, bank, layer } = make();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    const applied = (firstDown: boolean, yards: number) =>
      audioEventFor({ type: 'playApplied', replaces: false, entry: { outcome: { firstDown, turnover: false, yards } } } as unknown as GameEvent);
    expect(applied(true, 12)).toEqual({ type: 'playResult', firstDown: true, turnover: false, yards: 12 });
    // 2nd down moved the chains by a spot that no live event reported: no false 3rd-down build-up.
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 2, distance: 3 }) });
    audio.onGameEvent(applied(true, 4)!);
    expect(audio.onGameEvent(applied(true, 4)!)).toEqual([]);
    for (let i = 0; i < 180; i++) audio.updateMusic(1 / 60, null);
    expect(sampleIds(output)).not.toContain('crowd/defense_build');
    // A fast-simulated 2nd down that came up short: the stand builds with the distance left.
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 2, distance: 10 }) });
    audio.onGameEvent(applied(false, 3)!);
    for (let i = 0; i < 180; i++) audio.updateMusic(1 / 60, null);
    expect(sampleIds(output)).toContain('crowd/defense_build');
    expect(layer.crowd.anticipated()).toMatchObject({ down: 3, distance: 7 });
  });

  it('does not anticipate a stand after the chains moved', async () => {
    const { audio, output, bank, layer } = make();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    audio.onGameEvent({ type: 'possession', offense: 'away', play: situation({ down: 2 }) });
    audio.onGameEvent(ev('snap', {}));
    audio.onGameEvent(ev('firstDown', {}));
    audio.onGameEvent(ev('whistle', { reason: 'tackle' }));
    for (let i = 0; i < 240; i++) audio.updateMusic(1 / 60, null);
    expect(sampleIds(output)).not.toContain('crowd/defense_build');
    expect(layer.crowd.target()).toBeLessThan(0.6);
  });

  it('holds a near-silent tension before a field goal and reverberates in a dome', async () => {
    const { audio, output, bank, layer } = make();
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    audio.onGameEvent({ type: 'possession', offense: 'home', play: situation({ offense: 'home', special: 'fieldGoal' }), stadium: { capacity: 65000, roof: 'dome' } });
    for (let i = 0; i < 240; i++) audio.updateMusic(1 / 60, null);
    expect(layer.crowd.level).toBeLessThan(0.1);
    expect(output.calls.filter((c) => c.kind === 'setReverb').pop()).toMatchObject({ value: expect.any(Number) });
    const reverb = output.calls.filter((c): c is Extract<typeof c, { kind: 'setReverb' }> => c.kind === 'setReverb').pop();
    expect(reverb!.value).toBeGreaterThan(0);
  });

  it('max-roar crowd (the default): full-intensity loud bed, boosted, a roar stacked every couple of seconds, never ducked', async () => {
    const { audio, output, bank, layer, advance } = make({ crowdNoise: 'max' });
    audio.crowd(0.5);
    await bank.preload(sampleIdsFor('crowd'));
    audio.onGameEvent({ type: 'possession', offense: 'home', play: situation({ down: 1 }), stadium: { capacity: 70000, roof: 'open' } });
    for (let i = 0; i < 60 * 12; i++) {
      advance(1000 / 60);
      audio.updateMusic(1 / 60, null);
    }
    expect(layer.crowd.maxRoar).toBe(true);
    expect(layer.crowd.level).toBe(1);
    expect(output.beds.get('crowd.bed_loud')!.gain).toBeGreaterThan(0);
    expect(output.beds.get('crowd.bed_murmur')?.gain ?? 0).toBe(0);
    // A roar (or a cheer while it cools down) keeps landing: several in 12 s.
    const layered = sampleIds(output).filter((id) => id === 'crowd/roar' || id === 'crowd/cheer');
    expect(layered.length).toBeGreaterThanOrEqual(4);
    // The booth never pushes it down (only the instant dip under a body hit does).
    const before = output.calls.length;
    audio.onGameEvent(ev('sack', { by: 'def:DE', assists: [], yardsLost: 7 }));
    const dips = output.calls.slice(before).filter((c): c is Extract<typeof c, { kind: 'setDuck' }> => c.kind === 'setDuck' && c.value < 1);
    expect(dips.every((c) => c.value === IMPACT_DUCK || c.value === IMPACT_DUCK_BIG)).toBe(true);
    // Switching to reactive lets it follow the game again.
    audio.setCrowdNoise('reactive');
    expect(layer.crowd.maxRoar).toBe(false);
  });

  it('ducks the crowd under the booth', async () => {
    const { audio, output, layer } = make();
    await layer.unlock();
    audio.onGameEvent(ev('sack', { by: 'def:DE', assists: [], yardsLost: 7 }));
    const ducks = output.calls.filter((c): c is Extract<typeof c, { kind: 'setDuck' }> => c.kind === 'setDuck');
    expect(ducks[0]?.value).toBeLessThan(1);
    for (let i = 0; i < 120; i++) audio.updateMusic(1 / 60, null);
    const after = output.calls.filter((c): c is Extract<typeof c, { kind: 'setDuck' }> => c.kind === 'setDuck');
    expect(after[after.length - 1]?.value).toBe(1);
  });
});

describe('createAudio outside the browser', () => {
  it('builds a synth-only manager in Node (no WebAudio, no fetch of samples)', () => {
    const audio = createAudio(LEVELS);
    expect(audio.backend.kind).toBe('null');
    expect(audio.onGameEvent(ev('snap', {}))).toEqual(['snap']);
    expect(() => audio.updateMusic(0.016, null)).not.toThrow();
  });
});
