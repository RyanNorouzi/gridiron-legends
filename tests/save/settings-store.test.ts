import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_SPEED, DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import { CROWD_MAX_DEFAULT_VERSION, GAME_SPEED_DEFAULT_VERSION, SETTINGS_KEY, defaultSettings, loadSettings, loadSettingsDetailed, mergeSettings, saveSettings } from '@/save/settings-store';
import { createMemoryStorage } from '@/save/storage';

describe('mergeSettings', () => {
  it('returns defaults for missing or non-object input', () => {
    expect(mergeSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, issues: [] });
    expect(mergeSettings(null).issues).toEqual([]);
    const bad = mergeSettings('nope');
    expect(bad.settings).toEqual(DEFAULT_SETTINGS);
    expect(bad.issues).toHaveLength(1);
  });

  it('merges a partial record over the defaults', () => {
    const { settings, issues } = mergeSettings({ textSize: 'large', audio: { music: 0.2 }, camera: { offense: 'zoomed' }, simSpeed: 8 });
    expect(issues).toEqual([]);
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS, textSize: 'large', audio: { ...DEFAULT_SETTINGS.audio, music: 0.2 }, camera: { offense: 'zoomed' }, simSpeed: 8,
    });
  });

  it('falls back per field on wrong types, unknown enum values and out-of-range numbers', () => {
    const { settings, issues } = mergeSettings({
      textSize: 'huge', colorblind: 3, reducedMotion: 'yes', showTouchControls: 'maybe', replayRetention: 'forever',
      simSpeed: -2, gameSpeed: 'fast', defenseMode: 'nap', playbookComplexity: 'pro', animations: false, devMode: true,
      audio: { master: 1.5, sfx: 'loud', crowd: 0.3 }, camera: { offense: 'sideways', kitchen: 'standard', defense: 'defensive' },
      bindings: { sprint: ['rb', 'rt'], juke: 'x', dive: [1] }, keyboardMap: { KeyW: 'up', KeyS: 7 }, version: 42, mystery: true,
    });
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS, animations: false, devMode: true, audio: { ...DEFAULT_SETTINGS.audio, crowd: 0.3 },
      camera: { defense: 'defensive' }, bindings: { sprint: ['rb', 'rt'] }, keyboardMap: { KeyW: 'up' },
    });
    const fields = issues.map((i) => i.split(':')[0]);
    expect(fields).toEqual(expect.arrayContaining([
      'textSize', 'colorblind', 'reducedMotion', 'showTouchControls', 'replayRetention', 'simSpeed', 'gameSpeed', 'defenseMode',
      'playbookComplexity', 'audio.master', 'audio.sfx', 'camera.offense', 'camera.kitchen', 'bindings.juke', 'bindings.dive', 'keyboardMap.KeyS', 'mystery',
    ]));
    expect(fields).not.toContain('animations');
    expect(fields).not.toContain('audio.crowd');
  });

  it('rejects non-object audio/camera/bindings/keyboardMap as a whole', () => {
    const { settings, issues } = mergeSettings({ audio: 3, camera: [], bindings: null, keyboardMap: 'x' });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(issues.map((i) => i.split(':')[0]).sort()).toEqual(['audio', 'bindings', 'camera', 'keyboardMap']);
  });

  it('defaultSettings() returns an independent deep copy', () => {
    const a = defaultSettings();
    a.audio.master = 0;
    a.bindings.sprint = ['a'];
    a.camera.kick = 'kick';
    expect(defaultSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.audio.master).toBe(0.8);
  });
});

describe('loadSettings / saveSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    const storage = createMemoryStorage();
    expect(await loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(await loadSettingsDetailed(storage)).toEqual({ settings: DEFAULT_SETTINGS, issues: [], found: false });
  });

  it('round-trips under the gl:settings key with sorted keys, canonicalising on save', async () => {
    const storage = createMemoryStorage();
    const custom: Settings = { ...DEFAULT_SETTINGS, colorblind: 'deuteranopia', bindings: { throw1: ['a'] }, keyboardMap: { KeyQ: 'lb' } };
    const written = await saveSettings(storage, { ...custom, simSpeed: Number.NaN } as Settings);
    expect(written).toEqual(custom);
    const text = (await storage.getItem(SETTINGS_KEY))!;
    expect(text.startsWith('{"animations":')).toBe(true);
    expect(await storage.keys()).toEqual([SETTINGS_KEY]);
    const detailed = await loadSettingsDetailed(storage);
    expect(detailed).toEqual({ settings: custom, issues: [], found: true });
  });

  it('survives corrupt or partial stored data', async () => {
    const storage = createMemoryStorage({ [SETTINGS_KEY]: '{broken' });
    const corrupt = await loadSettingsDetailed(storage);
    expect(corrupt.settings).toEqual(DEFAULT_SETTINGS);
    expect(corrupt.found).toBe(true);
    expect(corrupt.issues).toHaveLength(1);
    await storage.setItem(SETTINGS_KEY, JSON.stringify({ textSize: 'large', audio: { master: 5 } }));
    const partial = await loadSettingsDetailed(storage);
    expect(partial.settings).toEqual({ ...DEFAULT_SETTINGS, textSize: 'large' });
    expect(partial.issues).toEqual(['audio.master: expected a number in [0, 1]; using default']);
  });
});

describe('settings version 2: the faster default game speed', () => {
  it('replaces the old stored 1x default once, keeping a speed the user chose', () => {
    expect(DEFAULT_SETTINGS.version).toBeGreaterThanOrEqual(GAME_SPEED_DEFAULT_VERSION);
    expect(GAME_SPEED_DEFAULT_VERSION).toBe(2);
    expect(DEFAULT_SETTINGS.gameSpeed).toBe(DEFAULT_GAME_SPEED);
    // Version 1 (and unversioned) records holding the old 1x default get the new default.
    expect(mergeSettings({ version: 1, gameSpeed: 1 }).settings.gameSpeed).toBe(DEFAULT_GAME_SPEED);
    expect(mergeSettings({ gameSpeed: 1 }).settings.gameSpeed).toBe(DEFAULT_GAME_SPEED);
    // Any other speed stored under version 1 was picked by the user.
    expect(mergeSettings({ version: 1, gameSpeed: 1.5 }).settings.gameSpeed).toBe(1.5);
    expect(mergeSettings({ version: 1, gameSpeed: 0.75 }).settings.gameSpeed).toBe(0.75);
    // From version 2 on, 1x is the user's own choice and stays.
    expect(mergeSettings({ version: 2, gameSpeed: 1 }).settings.gameSpeed).toBe(1);
  });

  it('migrates a stored version 1 record once: saved back as the current version, a later 1x pick survives reloads', async () => {
    const storage = createMemoryStorage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, version: 1, gameSpeed: 1 }) });
    const loaded = await loadSettings(storage);
    expect(loaded.gameSpeed).toBe(DEFAULT_GAME_SPEED);
    expect(loaded.version).toBe(DEFAULT_SETTINGS.version);
    await saveSettings(storage, loaded);
    expect(JSON.parse((await storage.getItem(SETTINGS_KEY))!).version).toBe(DEFAULT_SETTINGS.version);
    await saveSettings(storage, { ...loaded, gameSpeed: 1 });
    expect((await loadSettings(storage)).gameSpeed).toBe(1);
  });
});

describe('settings version 3: the crowd at 100% by default', () => {
  it('replaces the old stored 0.8 crowd default once, keeping a level the user chose', () => {
    expect(DEFAULT_SETTINGS.version).toBe(CROWD_MAX_DEFAULT_VERSION);
    expect(DEFAULT_SETTINGS.audio.crowd).toBe(1);
    // Version 2 (and older / unversioned) records holding the old 0.8 default get the full-volume crowd.
    expect(mergeSettings({ version: 2, audio: { crowd: 0.8 } }).settings.audio.crowd).toBe(1);
    expect(mergeSettings({ audio: { crowd: 0.8 } }).settings.audio.crowd).toBe(1);
    // Any other level stored under version 2 was picked by the user.
    expect(mergeSettings({ version: 2, audio: { crowd: 0.3 } }).settings.audio.crowd).toBe(0.3);
    expect(mergeSettings({ version: 2, audio: { crowd: 0 } }).settings.audio.crowd).toBe(0);
    // From version 3 on, 0.8 is the user's own choice and stays.
    expect(mergeSettings({ version: 3, audio: { crowd: 0.8 } }).settings.audio.crowd).toBe(0.8);
  });

  it('migrates a stored version 2 record once and a later 0.8 pick survives reloads', async () => {
    const storage = createMemoryStorage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, version: 2, audio: { ...DEFAULT_SETTINGS.audio, crowd: 0.8 } }) });
    const loaded = await loadSettings(storage);
    expect(loaded.audio.crowd).toBe(1);
    expect(loaded.version).toBe(3);
    await saveSettings(storage, { ...loaded, audio: { ...loaded.audio, crowd: 0.8 } });
    expect((await loadSettings(storage)).audio.crowd).toBe(0.8);
  });
});

describe('crowd noise mode', () => {
  it('is absent by default (max roar), keeps a valid stored mode and rejects a bad one', () => {
    expect(DEFAULT_SETTINGS.crowdNoise ?? 'max').toBe('max');
    expect(mergeSettings({ crowdNoise: 'reactive' }).settings.crowdNoise).toBe('reactive');
    expect(mergeSettings({ crowdNoise: 'max' }).settings.crowdNoise).toBe('max');
    const bad = mergeSettings({ crowdNoise: 'deafening' });
    expect(bad.settings.crowdNoise ?? 'max').toBe('max');
    expect(bad.issues.some((i) => i.startsWith('crowdNoise'))).toBe(true);
  });
});

describe('camera zoom preset', () => {
  it('defaults to CLOSE, keeps a valid stored preset and repairs a bad one', () => {
    expect(DEFAULT_SETTINGS.cameraZoom).toBe('close');
    expect(mergeSettings({ cameraZoom: 'wide' }).settings.cameraZoom).toBe('wide');
    expect(mergeSettings({ cameraZoom: 'standard' }).settings.cameraZoom).toBe('standard');
    const bad = mergeSettings({ cameraZoom: 'huge' });
    expect(bad.settings.cameraZoom).toBe('close');
    expect(bad.issues).toEqual(['cameraZoom: expected one of close|standard|wide; using default']);
  });

  it('migrates records saved before the preset existed to CLOSE and persists a choice across reloads', async () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    delete legacy.cameraZoom;
    const storage = createMemoryStorage({ [SETTINGS_KEY]: JSON.stringify(legacy) });
    const loaded = await loadSettingsDetailed(storage);
    expect(loaded.settings.cameraZoom).toBe('close');
    expect(loaded.issues).toEqual([]);
    await saveSettings(storage, { ...loaded.settings, cameraZoom: 'standard' });
    expect((await loadSettings(storage)).cameraZoom).toBe('standard');
  });
});
