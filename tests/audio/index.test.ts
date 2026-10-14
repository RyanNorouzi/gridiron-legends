import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { AudioManager, SOUNDS, createAudio, createAudioBackend, createNullBackend, hasWebAudio } from '@/audio';
import { FakeAudioContext } from './fake-audio-context';

const g = globalThis as unknown as { window?: unknown; AudioContext?: unknown };

afterEach(() => {
  delete g.window;
  delete g.AudioContext;
});

describe('createAudio', () => {
  it('falls back to the null backend under Node and accepts full Settings', () => {
    expect(hasWebAudio()).toBe(false);
    const audio = createAudio(DEFAULT_SETTINGS);
    expect(audio).toBeInstanceOf(AudioManager);
    expect(audio.backend.kind).toBe('null');
    expect(audio.getLevels()).toEqual(DEFAULT_SETTINGS.audio);
    expect(audio.play('menuSelect')).toBe(true);
  });

  it('accepts bare AudioLevels, manager options and an explicit backend', () => {
    const backend = createNullBackend();
    let t = 0;
    const audio = createAudio({ master: 1, sfx: 0.5, music: 0.5, crowd: 0.5, commentary: 0.5 }, { backend, crowdSide: 'away', now: () => t });
    expect(audio.backend).toBe(backend);
    expect(audio.getCrowdSide()).toBe('away');
    expect(backend.gains).toEqual({ sfx: 0.5, crowd: 0.5, music: 0.5, commentary: 0.5 });
    audio.play('snap');
    expect(audio.play('snap')).toBe(false);
    t = 100;
    expect(audio.play('snap')).toBe(true);
    expect(backend.plays()[0]?.recipe).toBe(SOUNDS.snap);
  });

  it('picks the WebAudio backend when a browser context is available', async () => {
    const fake = new FakeAudioContext();
    g.window = {};
    g.AudioContext = function AudioContext() {
      return fake;
    };
    expect(hasWebAudio()).toBe(true);
    const backend = createAudioBackend();
    expect(backend.kind).toBe('webaudio');
    const audio = createAudio(DEFAULT_SETTINGS, { webAudio: { createContext: () => fake.asContext() } });
    expect(audio.backend.kind).toBe('webaudio');
    expect(audio.backend.ready).toBe(false);
    await audio.resume();
    expect(audio.backend.ready).toBe(true);
    expect(fake.buses()[0]?.gain.value).toBeCloseTo(DEFAULT_SETTINGS.audio.master * DEFAULT_SETTINGS.audio.sfx);
  });
});
