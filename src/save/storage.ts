/**
 * Storage adapters: the only place in save/ that touches browser globals, always behind guards.
 * Every adapter exposes the same tiny async key/value surface so slots, settings and autosave
 * are storage-agnostic and fully testable against `createMemoryStorage()` in Node.
 */
export type StorageKind = 'memory' | 'localStorage' | 'indexedDb';

export interface StorageAdapter {
  /** Which backend this adapter wraps (diagnostics / UI hints). */
  readonly kind: StorageKind;
  /** Resolves to the stored string or null when the key is absent. */
  getItem(key: string): Promise<string | null>;
  /** Writes (or overwrites) a string; rejects with StorageError on quota or backend failure. */
  setItem(key: string, value: string): Promise<void>;
  /** Removes a key; resolves even when the key was absent. */
  removeItem(key: string): Promise<void>;
  /** All keys starting with `prefix` (empty prefix = every key), sorted. */
  keys(prefix?: string): Promise<string[]>;
  /**
   * Optional batch write: every entry is written (string) or removed (null) in ONE atomic backend operation that is
   * started synchronously when the backend is ready, so a save begun from a `pagehide` handler is queued before the
   * page unloads (IndexedDB). Adapters without it get sequential setItem / removeItem calls.
   */
  setItems?(entries: readonly (readonly [string, string | null])[]): Promise<void>;
}

export type SaveErrorCode =
  | 'invalidValue' | 'parse' | 'validation' | 'version' | 'migration' | 'notFound' | 'format' | 'compression' | 'slot';

/**
 * Error raised by serialization, validation, migration and slot logic. `path` points at the offending
 * value (e.g. `$.teams.t_abc.rosterIds[2]`) so the UI can explain a corrupt save. Defined here because
 * storage.ts is the leaf of save/ and every other file (including migrations) needs it.
 */
export class SaveError extends Error {
  readonly code: SaveErrorCode;
  readonly path: string;
  constructor(code: SaveErrorCode, path: string, message: string, cause?: unknown) {
    super(`${message} (at ${path})`, cause === undefined ? undefined : { cause });
    this.name = 'SaveError';
    this.code = code;
    this.path = path;
  }
}

export type StorageErrorCode = 'unavailable' | 'quota' | 'backend';

/** Thrown by adapters; `code` lets the UI distinguish "out of space" from "storage broken". */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

/** Structural subset of the DOM `Storage` interface so tests can inject a fake. */
export interface WebStorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

/* --------------------------------- memory --------------------------------- */

/** In-memory adapter (tests, fallback when nothing else is available). Keys are copied from `initial`. */
export const createMemoryStorage = (initial: Readonly<Record<string, string>> = {}): StorageAdapter => {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    kind: 'memory',
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      if (typeof value !== 'string') throw new StorageError('backend', `memory storage: value for "${key}" must be a string`);
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
    keys: async (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
};

/* ------------------------------- localStorage ------------------------------- */

const isQuotaError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
};

/** The browser's localStorage when it exists and is usable (private mode / sandboxed frames may throw). */
const detectLocalStorage = (): WebStorageLike | null => {
  try {
    if (typeof window === 'undefined') return null;
    const ls: unknown = window.localStorage;
    if (!ls || typeof (ls as WebStorageLike).getItem !== 'function') return null;
    return ls as WebStorageLike;
  } catch {
    return null;
  }
};

/**
 * Adapter over `localStorage` (or any injected `WebStorageLike`). Returns null when no storage is
 * available so callers can fall back instead of crashing in headless / private contexts.
 */
export const createLocalStorageAdapter = (storage: WebStorageLike | null = detectLocalStorage()): StorageAdapter | null => {
  if (!storage) return null;
  const ls = storage;
  const wrap = <T>(fn: () => T, what: string): T => {
    try {
      return fn();
    } catch (err) {
      if (isQuotaError(err)) throw new StorageError('quota', `localStorage: quota exceeded while ${what}`, err);
      throw new StorageError('backend', `localStorage: failed while ${what}`, err);
    }
  };
  return {
    kind: 'localStorage',
    getItem: async (key) => wrap(() => ls.getItem(key), `reading "${key}"`),
    setItem: async (key, value) => {
      wrap(() => ls.setItem(key, value), `writing "${key}"`);
    },
    removeItem: async (key) => {
      wrap(() => ls.removeItem(key), `removing "${key}"`);
    },
    keys: async (prefix = '') =>
      wrap(() => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null && k.startsWith(prefix)) out.push(k);
        }
        return out.sort();
      }, 'listing keys'),
  };
};

/* -------------------------------- IndexedDB -------------------------------- */

const detectIndexedDb = (): IDBFactory | null => {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') return null;
    return indexedDB;
  } catch {
    return null;
  }
};

export interface IndexedDbOptions {
  /** Injectable factory (tests use a fake); defaults to the global `indexedDB`. */
  factory?: IDBFactory | null;
  /** Object store name inside the database. */
  storeName?: string;
}

const requestToPromise = <T>(req: IDBRequest<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('backend', `IndexedDB: ${what} failed`, req.error));
  });

/**
 * Adapter over IndexedDB, used for large saves (no ~5MB localStorage ceiling). One object store of
 * string values keyed by the storage key. The database is opened lazily on first use and reused.
 * Returns null when IndexedDB is not available.
 */
export const createIndexedDbAdapter = (dbName = 'gridiron-legends', opts: IndexedDbOptions = {}): StorageAdapter | null => {
  const factory = opts.factory === undefined ? detectIndexedDb() : opts.factory;
  if (!factory) return null;
  const storeName = opts.storeName ?? 'kv';
  let dbPromise: Promise<IDBDatabase> | null = null;
  /** The open connection once `open()` resolved (lets a batch start its transaction without waiting a microtask). */
  let dbReady: IDBDatabase | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(dbName, 1);
      } catch (err) {
        reject(new StorageError('unavailable', `IndexedDB: cannot open "${dbName}"`, err));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading/deleting the database closes this connection; drop it so the next call reopens.
        db.onversionchange = () => { db.close(); dbPromise = null; dbReady = null; };
        db.onclose = () => { dbPromise = null; dbReady = null; };
        dbReady = db;
        resolve(db);
      };
      req.onerror = () => reject(new StorageError('unavailable', `IndexedDB: opening "${dbName}" failed`, req.error));
      req.onblocked = () => reject(new StorageError('unavailable', `IndexedDB: opening "${dbName}" is blocked`));
    }).catch((err: unknown) => {
      dbPromise = null; // allow a retry on the next call
      throw err;
    });
    return dbPromise;
  };

  const run = async <T>(mode: IDBTransactionMode, what: string, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    let req: IDBRequest<T>;
    try {
      req = fn(db.transaction(storeName, mode).objectStore(storeName));
    } catch (err) {
      throw new StorageError('backend', `IndexedDB: ${what} failed`, err);
    }
    return requestToPromise(req, what);
  };

  /** One readwrite transaction for every entry; resolves when it committed, rejects (nothing written) on failure. */
  const writeBatch = (db: IDBDatabase, entries: readonly (readonly [string, string | null])[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const fail = (cause: unknown): void => {
        if (isQuotaError(cause)) reject(new StorageError('quota', 'IndexedDB: quota exceeded while writing a batch', cause));
        else reject(new StorageError('backend', 'IndexedDB: writing a batch failed', cause));
      };
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
        const store = tx.objectStore(storeName);
        for (const [key, value] of entries) {
          if (value === null) store.delete(key);
          else store.put(value, key);
        }
      } catch (err) {
        fail(err);
      }
    });

  return {
    kind: 'indexedDb',
    setItems: (entries) => (dbReady ? writeBatch(dbReady, entries) : open().then((db) => writeBatch(db, entries))),
    getItem: async (key) => {
      const v = await run<unknown>('readonly', `reading "${key}"`, (s) => s.get(key));
      return typeof v === 'string' ? v : null;
    },
    setItem: async (key, value) => {
      try {
        await run('readwrite', `writing "${key}"`, (s) => s.put(value, key));
      } catch (err) {
        const cause = err instanceof StorageError ? err.cause : err;
        if (isQuotaError(cause)) throw new StorageError('quota', `IndexedDB: quota exceeded while writing "${key}"`, cause);
        throw err;
      }
    },
    removeItem: async (key) => {
      await run('readwrite', `removing "${key}"`, (s) => s.delete(key));
    },
    keys: async (prefix = '') => {
      const all = await run<IDBValidKey[]>('readonly', 'listing keys', (s) => s.getAllKeys());
      return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)).sort();
    },
  };
};

/* --------------------------------- picking --------------------------------- */

/**
 * Best available backend for this environment: IndexedDB (large saves) → localStorage → memory.
 * Never throws; a headless environment gets memory storage.
 */
export const pickBrowserStorage = (): StorageAdapter =>
  createIndexedDbAdapter() ?? createLocalStorageAdapter() ?? createMemoryStorage();
