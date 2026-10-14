import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import {
  CURRENT_SAVE_VERSION, SETTINGS_KEY, createLocalStorageAdapter, createMemoryStorage, createSaveSystem, deserializeLeague,
  isCompressed, leagueKey, type WebStorageLike,
} from '@/save';
import { makeLeague, settle } from './fixtures';

const fakeWebStorage = (): WebStorageLike => {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
    key: (i) => [...data.keys()][i] ?? null,
  };
};

describe('createSaveSystem', () => {
  it('wires slots, settings and autosave over one storage with an injected clock', async () => {
    const storage = createMemoryStorage();
    let t = 5_000;
    const scheduled: { cb: () => void; delay: number }[] = [];
    const system = createSaveSystem(storage, { now: () => t, schedule: (cb, delay) => { scheduled.push({ cb, delay }); return () => undefined; } });
    expect(system.storage).toBe(storage);
    expect(CURRENT_SAVE_VERSION).toBe(2);

    const league = makeLeague();
    const meta = await system.slots.save('one', league);
    expect(meta.createdAt).toBe(5_000);
    expect((await system.slots.list()).map((m) => m.id)).toEqual(['one']);
    expect((await system.slots.load('one')).league).toEqual(league);
    expect(isCompressed((await storage.getItem(leagueKey('one')))!)).toBe(false);

    expect(await system.loadSettings()).toEqual(DEFAULT_SETTINGS);
    await system.saveSettings({ ...DEFAULT_SETTINGS, devMode: true });
    expect((await system.loadSettingsDetailed()).settings.devMode).toBe(true);

    const settings = { ...DEFAULT_SETTINGS, textSize: 'large' as const };
    const auto = system.createAutosaver({ enabled: true, debounceMs: 250, slot: 'auto', source: { league: () => league }, settings: () => settings });
    t = 6_000;
    auto.mark('settings');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(250);
    scheduled[0]!.cb();
    await settle();
    expect(auto.status()).toMatchObject({ saveCount: 1, lastSavedAt: 6_000 });
    expect((await system.slots.load('auto')).meta.updatedAt).toBe(6_000);
    expect(JSON.parse((await storage.getItem(SETTINGS_KEY))!)).toMatchObject({ textSize: 'large' });
  });

  it('defaults to memory storage when headless and compresses by default on localStorage', async () => {
    const headless = createSaveSystem();
    expect(headless.storage.kind).toBe('memory');
    const ls = createSaveSystem(createLocalStorageAdapter(fakeWebStorage())!);
    const league = makeLeague();
    await ls.slots.save('s', league);
    const stored = (await ls.storage.getItem(leagueKey('s')))!;
    expect(isCompressed(stored)).toBe(true);
    expect(deserializeLeague(stored)).toEqual(league);
    const plain = createSaveSystem(createLocalStorageAdapter(fakeWebStorage())!, { compress: false });
    await plain.slots.save('s', league);
    expect(isCompressed((await plain.storage.getItem(leagueKey('s')))!)).toBe(false);
  });
});
