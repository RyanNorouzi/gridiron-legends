import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import type { League } from '@/franchise/types';
import { AUTOSAVE_REASONS, createAutosaver, type AutosaveReason, type AutosaverOptions, type Scheduler } from '@/save/autosave';
import { SETTINGS_KEY } from '@/save/settings-store';
import { createSlotStore, metaKey, type SaveSlotMeta } from '@/save/slots';
import { createMemoryStorage, type StorageAdapter } from '@/save/storage';
import { makeGame, makeLeague, settle } from './fixtures';

/** Virtual clock + scheduler: timers fire only when the test advances time, then promise chains settle. */
const fakeTimers = () => {
  let t = 10_000;
  let nextId = 0;
  const timers: { id: number; at: number; cb: () => void }[] = [];
  const schedule: Scheduler = (cb, delayMs) => {
    const id = nextId++;
    timers.push({ id, at: t + delayMs, cb });
    return () => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  const advance = async (ms: number): Promise<void> => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      t = next.at;
      timers.shift();
      next.cb();
      await settle();
    }
    t = end;
  };
  return { now: () => t, schedule, advance, pendingTimers: () => timers.length };
};

interface Harness {
  storage: StorageAdapter;
  timers: ReturnType<typeof fakeTimers>;
  league: League;
  saves: { meta: SaveSlotMeta; reasons: readonly AutosaveReason[] }[];
  errors: unknown[];
  autosaver: ReturnType<typeof createAutosaver>;
  settings: Settings;
}

const harness = (overrides: Partial<AutosaverOptions> = {}, storage: StorageAdapter = createMemoryStorage()): Harness => {
  const timers = fakeTimers();
  const store = createSlotStore(storage, { now: timers.now });
  const league = makeLeague();
  const saves: Harness['saves'] = [];
  const errors: unknown[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, textSize: 'large' };
  const h: Partial<Harness> = { storage, timers, league, saves, errors, settings };
  h.autosaver = createAutosaver(store, {
    enabled: true, debounceMs: 100, slot: 'auto', now: timers.now, schedule: timers.schedule,
    source: { league: () => h.league!, game: () => null },
    settings: { storage, get: () => settings },
    onSaved: (meta, reasons) => saves.push({ meta, reasons }),
    onError: (err) => errors.push(err),
    ...overrides,
  });
  return h as Harness;
};

describe('createAutosaver', () => {
  it('exposes every important-event reason', () => {
    expect([...AUTOSAVE_REASONS]).toEqual(['weekAdvance', 'gameEnd', 'trade', 'signing', 'draftPick', 'settings', 'phaseChange', 'edit', 'gameProgress']);
  });

  it('persists management edits after the edit debounce, collapsing a run of edits into one write', async () => {
    const h = harness({ editDebounceMs: 300 });
    h.autosaver.mark('edit');
    await h.timers.advance(200);
    h.autosaver.mark('edit');
    await h.timers.advance(200);
    expect(h.saves).toHaveLength(0);
    await h.timers.advance(100);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.reasons).toEqual(['edit']);
    // An important reason joining pending edits saves on the normal (shorter) debounce.
    h.autosaver.mark('edit');
    h.autosaver.mark('trade');
    await h.timers.advance(100);
    expect(h.saves).toHaveLength(2);
    expect([...h.saves[1]!.reasons].sort()).toEqual(['edit', 'trade']);
    // Edits default to twice the normal debounce.
    const d = harness();
    d.autosaver.mark('edit');
    await d.timers.advance(199);
    expect(d.saves).toHaveLength(0);
    await d.timers.advance(1);
    expect(d.saves).toHaveLength(1);
    expect(() => harness({ editDebounceMs: -1 })).toThrow(/editDebounceMs/);
  });

  it('writes an edit with the real scheduler under fake timers (a tab closed seconds later keeps it)', async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const store = createSlotStore(storage, { now: () => Date.now() });
      let league = makeLeague();
      const saver = createAutosaver(store, { enabled: true, debounceMs: 1500, slot: 'auto', source: { league: () => league } });
      league = { ...league, name: 'Edited name' };
      saver.mark('edit');
      await vi.advanceTimersByTimeAsync(2999);
      expect(await storage.getItem(metaKey('auto'))).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => expect((await store.load('auto')).league.name).toBe('Edited name'));
      saver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses a burst of marks into a single save after the quiet period', async () => {
    const h = harness();
    h.autosaver.mark('trade');
    await h.timers.advance(50);
    h.autosaver.mark('signing');
    await h.timers.advance(50);
    h.autosaver.mark('signing');
    expect(h.saves).toHaveLength(0);
    expect(h.autosaver.status().pending).toEqual(['trade', 'signing']);
    await h.timers.advance(99);
    expect(h.saves).toHaveLength(0);
    await h.timers.advance(1);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.reasons).toEqual(['trade', 'signing']);
    expect(h.saves[0]!.meta.id).toBe('auto');
    expect(h.autosaver.status()).toMatchObject({ pending: [], saving: false, saveCount: 1, lastSavedAt: h.timers.now(), lastError: null });
    expect(await h.storage.getItem('gl:slot:auto')).not.toBeNull();
  });

  it('saves separately when marks are far apart', async () => {
    const h = harness();
    h.autosaver.mark('weekAdvance');
    await h.timers.advance(100);
    h.autosaver.mark('weekAdvance');
    await h.timers.advance(100);
    expect(h.saves.map((s) => s.reasons)).toEqual([['weekAdvance'], ['weekAdvance']]);
  });

  it('flush() saves immediately, cancels the timer and returns null when idle', async () => {
    const h = harness();
    expect(await h.autosaver.flush()).toBeNull();
    h.autosaver.mark('gameEnd');
    expect(h.timers.pendingTimers()).toBe(1);
    const meta = await h.autosaver.flush();
    expect(meta?.id).toBe('auto');
    expect(h.timers.pendingTimers()).toBe(0);
    expect(h.saves).toHaveLength(1);
    await h.timers.advance(1000);
    expect(h.saves).toHaveLength(1);
  });

  it('reads the latest league at save time', async () => {
    const h = harness();
    h.autosaver.mark('phaseChange');
    h.league = { ...h.league, year: 2031 };
    await h.timers.advance(100);
    expect(h.saves[0]!.meta.year).toBe(2031);
  });

  it('persists a game in progress when the source provides one', async () => {
    const h = harness({ source: { league: () => makeLeague(), game: () => makeGame() } });
    h.autosaver.mark('gameEnd');
    await h.timers.advance(100);
    expect(h.saves[0]!.meta.hasGameInProgress).toBe(true);
    expect(await h.storage.getItem('gl:slot:auto:game')).not.toBeNull();
  });

  it('ignores marks while disabled and drops pending marks on disable', async () => {
    const h = harness({ enabled: false });
    h.autosaver.mark('trade');
    await h.timers.advance(500);
    expect(h.saves).toHaveLength(0);
    expect(await h.autosaver.flush()).toBeNull();
    h.autosaver.setEnabled(true);
    h.autosaver.mark('trade');
    h.autosaver.setEnabled(false);
    expect(h.autosaver.status().pending).toEqual([]);
    expect(h.timers.pendingTimers()).toBe(0);
    h.autosaver.setEnabled(true);
    h.autosaver.mark('trade');
    await h.timers.advance(100);
    expect(h.saves).toHaveLength(1);
  });

  it('never postpones past maxWaitMs under continuous activity', async () => {
    const h = harness({ debounceMs: 100, maxWaitMs: 250 });
    for (let i = 0; i < 10; i++) {
      h.autosaver.mark('draftPick');
      await h.timers.advance(60);
    }
    expect(h.saves.length).toBeGreaterThanOrEqual(2);
    expect(h.saves[0]!.meta.updatedAt - 10_000).toBeLessThanOrEqual(250);
    expect(h.saves[0]!.meta.updatedAt - 10_000).toBeGreaterThanOrEqual(240);
  });

  it('also writes settings when a settings mark is included', async () => {
    const h = harness();
    h.autosaver.mark('settings');
    await h.timers.advance(100);
    const stored = JSON.parse((await h.storage.getItem(SETTINGS_KEY))!) as Settings;
    expect(stored.textSize).toBe('large');
    h.autosaver.mark('trade');
    await h.storage.removeItem(SETTINGS_KEY);
    await h.timers.advance(100);
    expect(await h.storage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it('reports timer-triggered failures, keeps the marks, and lets flush() retry', async () => {
    let failures = 1;
    const base = createMemoryStorage();
    const flaky: StorageAdapter = {
      ...base,
      setItem: async (k, v) => {
        if (failures > 0) { failures--; throw new Error('disk full'); }
        return base.setItem(k, v);
      },
    };
    const h = harness({}, flaky);
    h.autosaver.mark('trade');
    await h.timers.advance(100);
    expect(h.errors).toHaveLength(1);
    expect(h.saves).toHaveLength(0);
    expect(h.autosaver.status().pending).toEqual(['trade']);
    expect(h.autosaver.status().lastError).toBeInstanceOf(Error);
    const meta = await h.autosaver.flush();
    expect(meta?.id).toBe('auto');
    expect(h.saves).toHaveLength(1);
    expect(h.autosaver.status().lastError).toBeNull();
  });

  it('flush() rejects on failure instead of swallowing', async () => {
    const broken: StorageAdapter = { ...createMemoryStorage(), setItem: async () => { throw new Error('nope'); } };
    const h = harness({}, broken);
    h.autosaver.mark('trade');
    await expect(h.autosaver.flush()).rejects.toThrow('nope');
    expect(h.errors).toHaveLength(0);
  });

  it('serialises overlapping saves and re-saves marks made during a save', async () => {
    const base = createMemoryStorage();
    let release: (() => void) | null = null;
    const slow: StorageAdapter = {
      ...base,
      setItem: async (k, v) => {
        if (release === null) await new Promise<void>((resolve) => { release = resolve; });
        return base.setItem(k, v);
      },
    };
    const h = harness({}, slow);
    h.autosaver.mark('trade');
    const first = h.autosaver.flush();
    await settle();
    expect(h.autosaver.status().saving).toBe(true);
    h.autosaver.mark('signing');
    const second = h.autosaver.flush();
    release!();
    await first;
    await second;
    expect(h.saves.map((s) => s.reasons)).toEqual([['trade'], ['signing']]);
  });

  it('rejects unknown reasons, validates options, and dispose() cancels everything', async () => {
    const h = harness();
    expect(() => h.autosaver.mark('coffee' as AutosaveReason)).toThrow(/unknown reason/);
    expect(() => createAutosaver(createSlotStore(createMemoryStorage(), { now: () => 0 }), { enabled: true, debounceMs: -1, slot: 'x', source: { league: makeLeague } })).toThrow(/debounceMs/);
    h.autosaver.mark('trade');
    h.autosaver.dispose();
    expect(h.timers.pendingTimers()).toBe(0);
    expect(h.autosaver.status()).toMatchObject({ enabled: false, pending: [] });
    h.autosaver.mark('trade');
    await h.timers.advance(500);
    expect(h.saves).toHaveLength(0);
  });
});
