import type { Settings } from '@/core/settings';
import { createAutosaver, realClock, realScheduler, type Autosaver, type AutosaverOptions, type Scheduler } from './autosave';
import { loadSettings, loadSettingsDetailed, saveSettings, type LoadedSettings } from './settings-store';
import { createSlotStore, type SlotStore } from './slots';
import { pickBrowserStorage, type StorageAdapter } from './storage';

export * from './storage';
export * from './serialize';
export * from './migrations';
export * from './slots';
export * from './settings-store';
export * from './autosave';

/**
 * Composition root for persistence: one storage backend shared by save slots, settings and autosave.
 * Everything below this file is pure and injectable; this is the only place wall-clock defaults are bound.
 */
export interface SaveSystemDeps {
  now?: () => number;
  schedule?: Scheduler;
  /** Compress slot payloads by default. Recommended for localStorage; harmless for IndexedDB. */
  compress?: boolean;
}

export interface SaveSystem {
  storage: StorageAdapter;
  slots: SlotStore;
  loadSettings(): Promise<Settings>;
  loadSettingsDetailed(): Promise<LoadedSettings>;
  saveSettings(settings: Settings): Promise<Settings>;
  /** Autosaver bound to this system's slot store, settings storage and clock. */
  createAutosaver(opts: Omit<AutosaverOptions, 'now' | 'schedule' | 'settings'> & { settings?: () => Settings }): Autosaver;
}

/** Builds the save system over `storage` (default: best browser backend, memory when headless). */
export const createSaveSystem = (storage: StorageAdapter = pickBrowserStorage(), deps: SaveSystemDeps = {}): SaveSystem => {
  const now = deps.now ?? realClock;
  const schedule = deps.schedule ?? realScheduler;
  const compress = deps.compress ?? storage.kind === 'localStorage';
  const slots = createSlotStore(storage, { now, compress });
  return {
    storage,
    slots,
    loadSettings: () => loadSettings(storage),
    loadSettingsDetailed: () => loadSettingsDetailed(storage),
    saveSettings: (settings) => saveSettings(storage, settings),
    createAutosaver: ({ settings, ...opts }) =>
      createAutosaver(slots, { ...opts, now, schedule, settings: settings ? { storage, get: settings } : undefined }),
  };
};
