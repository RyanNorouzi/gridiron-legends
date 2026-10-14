import type { Settings } from '@/core/settings';
import type { League } from '@/franchise/types';
import type { GameState } from '@/game/types';
import { saveSettings } from './settings-store';
import type { SaveSlotMeta, SlotStore } from './slots';
import type { StorageAdapter } from './storage';

/**
 * Debounced autosave. Franchise code calls `mark(reason)` after every important event; bursts of marks
 * (a trade followed by three signings) collapse into ONE slot write once `debounceMs` of quiet has passed,
 * and `maxWaitMs` guarantees a write even under continuous activity. `flush()` forces a save immediately
 * (e.g. before the tab hides). Clock and scheduler are injected so tests run without timers.
 *
 * 'edit' marks management changes (facility upgrades, ticket prices, event choices, depth-chart and roster fixes):
 * they are saved too, after `editDebounceMs` of quiet (default 2 x debounceMs), so a run of small edits is one
 * write and a browser closed shortly after an edit does not lose it. Any other pending reason uses `debounceMs`.
 * 'gameProgress' marks a finished play of a franchise game in progress: the source's `game()` state is written with
 * the league, so a reload resumes that game at the same score instead of replaying it from kickoff.
 * `hold(reason)` records a pending reason WITHOUT arming the timer: a caller that flushes on its own schedule (a
 * multi-week league sim checkpointing every few weeks) keeps the timer from re-saving the whole League every week,
 * while the next flush() (page hide, the caller's own) still writes it.
 */
export const AUTOSAVE_REASONS = ['weekAdvance', 'gameEnd', 'trade', 'signing', 'draftPick', 'settings', 'phaseChange', 'edit', 'gameProgress'] as const;
export type AutosaveReason = (typeof AUTOSAVE_REASONS)[number];

/** Schedules `cb` after `delayMs`; returns a cancel function. */
export type Scheduler = (cb: () => void, delayMs: number) => () => void;

export interface AutosaveSource {
  /** Current franchise state; called at save time so the latest data is written. */
  league: () => League;
  /** Mid-game state to persist alongside the league, or null. */
  game?: () => GameState | null;
}

export interface AutosaverOptions {
  enabled: boolean;
  /** Quiet period after the last mark before saving. */
  debounceMs: number;
  /** Upper bound on how long marks may keep postponing a save (default 5 × debounceMs). */
  maxWaitMs?: number;
  /** Quiet period before a save when only 'edit' marks are pending (default 2 × debounceMs). */
  editDebounceMs?: number;
  now?: () => number;
  schedule?: Scheduler;
  /** Slot written by autosaves. */
  slot: string;
  source: AutosaveSource;
  /** When present, a 'settings' mark also persists the current settings under gl:settings. */
  settings?: { storage: StorageAdapter; get: () => Settings };
  onSaved?: (meta: SaveSlotMeta, reasons: readonly AutosaveReason[]) => void;
  /** Receives failures from timer-triggered saves (flush() rejects instead). */
  onError?: (err: unknown) => void;
}

export interface AutosaveStatus {
  enabled: boolean;
  pending: readonly AutosaveReason[];
  saving: boolean;
  saveCount: number;
  lastSavedAt: number | null;
  lastError: unknown;
}

export interface Autosaver {
  /** Records that something worth saving happened; schedules a debounced save. Ignored while disabled. */
  mark(reason: AutosaveReason): void;
  /** Records a pending reason without scheduling a save (the next flush() or timer-driven save writes it). */
  hold(reason: AutosaveReason): void;
  /** Saves now if anything is pending (waits for an in-flight save first). Resolves null when nothing was pending. */
  flush(): Promise<SaveSlotMeta | null>;
  setEnabled(enabled: boolean): void;
  status(): AutosaveStatus;
  /** Cancels any scheduled save and disables the autosaver. Pending marks are dropped. */
  dispose(): void;
}

/** Wall-clock and setTimeout-based defaults for the browser; tests inject fakes. */
export const realClock = (): number => Date.now();
export const realScheduler: Scheduler = (cb, delayMs) => {
  const handle = setTimeout(cb, delayMs);
  return () => clearTimeout(handle);
};

const isReason = (r: string): r is AutosaveReason => (AUTOSAVE_REASONS as readonly string[]).includes(r);

export const createAutosaver = (store: SlotStore, opts: AutosaverOptions): Autosaver => {
  if (!(opts.debounceMs >= 0)) throw new Error('createAutosaver: debounceMs must be >= 0');
  if (opts.editDebounceMs !== undefined && !(opts.editDebounceMs >= 0)) throw new Error('createAutosaver: editDebounceMs must be >= 0');
  const now = opts.now ?? realClock;
  const schedule = opts.schedule ?? realScheduler;
  const maxWaitMs = opts.maxWaitMs ?? opts.debounceMs * 5;
  const editDebounceMs = opts.editDebounceMs ?? opts.debounceMs * 2;
  let enabled = opts.enabled;
  const pending = new Set<AutosaveReason>();
  let firstMarkAt: number | null = null;
  let cancelTimer: (() => void) | null = null;
  let inFlight: Promise<SaveSlotMeta | null> | null = null;
  let saveCount = 0;
  let lastSavedAt: number | null = null;
  let lastError: unknown = null;

  const clearTimer = (): void => {
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
  };

  const performSave = async (): Promise<SaveSlotMeta | null> => {
    // Serialise writes: wait for every in-flight save (a new one may start while we wait); failures are already reported.
    while (inFlight) await inFlight.catch(() => undefined);
    if (pending.size === 0) return null;
    const reasons = [...pending];
    pending.clear();
    firstMarkAt = null;
    const run = (async (): Promise<SaveSlotMeta | null> => {
      const meta = await store.save(opts.slot, opts.source.league(), opts.source.game?.() ?? null);
      if (reasons.includes('settings') && opts.settings) await saveSettings(opts.settings.storage, opts.settings.get());
      saveCount++;
      lastSavedAt = now();
      lastError = null;
      opts.onSaved?.(meta, reasons);
      return meta;
    })();
    inFlight = run;
    try {
      return await run;
    } catch (err) {
      lastError = err;
      for (const r of reasons) pending.add(r); // keep the marks so the next flush retries
      throw err;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  };

  const fireFromTimer = (): void => {
    cancelTimer = null;
    performSave().catch((err: unknown) => {
      opts.onError?.(err);
    });
  };

  const mark = (reason: AutosaveReason): void => {
    if (!isReason(reason)) throw new Error(`autosave: unknown reason "${String(reason)}"`);
    if (!enabled) return;
    pending.add(reason);
    const t = now();
    if (firstMarkAt === null) firstMarkAt = t;
    clearTimer();
    const waited = t - firstMarkAt;
    const quiet = [...pending].every((r) => r === 'edit') ? editDebounceMs : opts.debounceMs;
    const delay = Math.max(0, Math.min(quiet, maxWaitMs - waited));
    cancelTimer = schedule(fireFromTimer, delay);
  };

  const hold = (reason: AutosaveReason): void => {
    if (!isReason(reason)) throw new Error(`autosave: unknown reason "${String(reason)}"`);
    if (!enabled) return;
    pending.add(reason);
    if (firstMarkAt === null) firstMarkAt = now();
  };

  const flush = async (): Promise<SaveSlotMeta | null> => {
    clearTimer();
    return performSave();
  };

  return {
    mark,
    hold,
    flush,
    setEnabled: (value) => {
      enabled = value;
      if (!value) {
        clearTimer();
        pending.clear();
        firstMarkAt = null;
      }
    },
    status: () => ({ enabled, pending: [...pending], saving: inFlight !== null, saveCount, lastSavedAt, lastError }),
    dispose: () => {
      enabled = false;
      clearTimer();
      pending.clear();
      firstMarkAt = null;
    },
  };
};
