import { describe, expect, it } from 'vitest';
import {
  StorageError, createIndexedDbAdapter, createLocalStorageAdapter, createMemoryStorage, pickBrowserStorage, type WebStorageLike,
} from '@/save/storage';

/* ------------------------------ fake Web Storage ------------------------------ */

const fakeWebStorage = (opts: { quotaAt?: number; brokenGet?: boolean } = {}): WebStorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    getItem: (k) => {
      if (opts.brokenGet) throw new Error('SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (opts.quotaAt !== undefined && v.length > opts.quotaAt) {
        const err = new Error('quota') as Error & { name: string; code: number };
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      }
      data.set(k, v);
    },
    removeItem: (k) => { data.delete(k); },
    key: (i) => [...data.keys()][i] ?? null,
  };
};

/* -------------------------------- fake IndexedDB -------------------------------- */

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onupgradeneeded: ((ev: unknown) => void) | null = null;
  onblocked: ((ev: unknown) => void) | null = null;
}

const settle = <T>(fn: () => T): FakeRequest<T> => {
  const req = new FakeRequest<T>();
  queueMicrotask(() => {
    try {
      req.result = fn();
      req.onsuccess?.({});
    } catch (err) {
      req.error = err;
      req.onerror?.({});
    }
  });
  return req;
};

class FakeObjectStore {
  constructor(private readonly data: Map<IDBValidKey, unknown>, private readonly failOps: Set<string>) {}
  private guard(op: string): void {
    if (this.failOps.has(op)) throw new Error(`fail ${op}`);
  }
  get(key: IDBValidKey) { return settle(() => { this.guard('get'); return this.data.get(key); }); }
  put(value: unknown, key: IDBValidKey) { return settle(() => { this.guard('put'); this.data.set(key, value); return key; }); }
  delete(key: IDBValidKey) { return settle(() => { this.guard('delete'); this.data.delete(key); return undefined; }); }
  getAllKeys() { return settle(() => { this.guard('getAllKeys'); return [...this.data.keys()]; }); }
}

class FakeDb {
  stores = new Map<string, Map<IDBValidKey, unknown>>();
  failOps = new Set<string>();
  closed = 0;
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  objectStoreNames = { contains: (n: string): boolean => this.stores.has(n) };
  close(): void { this.closed++; }
  createObjectStore(n: string): void { this.stores.set(n, new Map()); }
  transaction(name: string, _mode: string) {
    const data = this.stores.get(name);
    if (!data) throw new Error(`no store ${name}`);
    return { objectStore: () => new FakeObjectStore(data, this.failOps) };
  }
}

class FakeFactory {
  db = new FakeDb();
  opens = 0;
  failOpen = false;
  open(_name: string, _version: number): FakeRequest<FakeDb> {
    this.opens++;
    const req = new FakeRequest<FakeDb>();
    queueMicrotask(() => {
      if (this.failOpen) { req.error = new Error('denied'); req.onerror?.({}); return; }
      req.result = this.db;
      req.onupgradeneeded?.({});
      req.onsuccess?.({});
    });
    return req;
  }
}

const asFactory = (f: FakeFactory): IDBFactory => f as unknown as IDBFactory;

/* ------------------------------------ tests ------------------------------------ */

describe('createMemoryStorage', () => {
  it('stores, lists by prefix (sorted) and removes', async () => {
    const s = createMemoryStorage({ 'gl:settings': '{}' });
    expect(s.kind).toBe('memory');
    await s.setItem('gl:slot:b', '1');
    await s.setItem('gl:slot:a', '2');
    await s.setItem('other', '3');
    expect(await s.getItem('gl:slot:a')).toBe('2');
    expect(await s.getItem('missing')).toBeNull();
    expect(await s.keys('gl:slot:')).toEqual(['gl:slot:a', 'gl:slot:b']);
    expect(await s.keys()).toEqual(['gl:settings', 'gl:slot:a', 'gl:slot:b', 'other']);
    await s.removeItem('gl:slot:a');
    await s.removeItem('never-there');
    expect(await s.keys('gl:slot:')).toEqual(['gl:slot:b']);
  });

  it('does not share state between instances or leak the initial record', async () => {
    const initial = { k: 'v' };
    const a = createMemoryStorage(initial);
    const b = createMemoryStorage(initial);
    await a.setItem('k', 'changed');
    expect(await b.getItem('k')).toBe('v');
    expect(initial.k).toBe('v');
  });
});

describe('createLocalStorageAdapter', () => {
  it('returns null when no web storage is available (headless Node)', () => {
    expect(typeof window).toBe('undefined');
    expect(createLocalStorageAdapter()).toBeNull();
    expect(createLocalStorageAdapter(null)).toBeNull();
  });

  it('wraps an injected storage', async () => {
    const fake = fakeWebStorage();
    const s = createLocalStorageAdapter(fake)!;
    expect(s.kind).toBe('localStorage');
    await s.setItem('gl:slot:x', 'a');
    await s.setItem('gl:slot:w', 'b');
    await s.setItem('zzz', 'c');
    expect(await s.getItem('gl:slot:x')).toBe('a');
    expect(await s.getItem('nope')).toBeNull();
    expect(await s.keys('gl:slot:')).toEqual(['gl:slot:w', 'gl:slot:x']);
    await s.removeItem('gl:slot:x');
    expect(fake.data.has('gl:slot:x')).toBe(false);
  });

  it('maps quota and generic failures to StorageError codes', async () => {
    const quota = createLocalStorageAdapter(fakeWebStorage({ quotaAt: 3 }))!;
    await expect(quota.setItem('k', 'too long')).rejects.toMatchObject({ name: 'StorageError', code: 'quota' });
    await expect(quota.setItem('k', 'ok')).resolves.toBeUndefined();
    const broken = createLocalStorageAdapter(fakeWebStorage({ brokenGet: true }))!;
    await expect(broken.getItem('k')).rejects.toBeInstanceOf(StorageError);
    await expect(broken.getItem('k')).rejects.toMatchObject({ code: 'backend' });
  });
});

describe('createIndexedDbAdapter', () => {
  it('returns null without IndexedDB (headless Node) or with an explicit null factory', () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(createIndexedDbAdapter()).toBeNull();
    expect(createIndexedDbAdapter('x', { factory: null })).toBeNull();
  });

  it('creates the store once, then reads/writes/lists/removes through it', async () => {
    const factory = new FakeFactory();
    const s = createIndexedDbAdapter('gl-test', { factory: asFactory(factory) })!;
    expect(s.kind).toBe('indexedDb');
    await s.setItem('gl:slot:a', 'A');
    await s.setItem('gl:slot:b', 'B');
    await s.setItem('misc', 'M');
    expect(factory.opens).toBe(1);
    expect(factory.db.stores.has('kv')).toBe(true);
    expect(await s.getItem('gl:slot:a')).toBe('A');
    expect(await s.getItem('missing')).toBeNull();
    expect(await s.keys('gl:slot:')).toEqual(['gl:slot:a', 'gl:slot:b']);
    await s.removeItem('gl:slot:a');
    expect(await s.keys('gl:slot:')).toEqual(['gl:slot:b']);
    expect(factory.opens).toBe(1);
  });

  it('ignores non-string values and honours a custom store name', async () => {
    const factory = new FakeFactory();
    const s = createIndexedDbAdapter('gl-test', { factory: asFactory(factory), storeName: 'blobs' })!;
    await s.setItem('k', 'v');
    factory.db.stores.get('blobs')!.set('weird', 42);
    expect(await s.getItem('weird')).toBeNull();
    expect(await s.getItem('k')).toBe('v');
  });

  it('surfaces open failures as StorageError and retries the open afterwards', async () => {
    const factory = new FakeFactory();
    factory.failOpen = true;
    const s = createIndexedDbAdapter('gl-test', { factory: asFactory(factory) })!;
    await expect(s.getItem('k')).rejects.toMatchObject({ name: 'StorageError', code: 'unavailable' });
    factory.failOpen = false;
    await s.setItem('k', 'v');
    expect(await s.getItem('k')).toBe('v');
    expect(factory.opens).toBe(2);
  });

  it('reopens the database after another tab forces a version change or closes the connection', async () => {
    const factory = new FakeFactory();
    const s = createIndexedDbAdapter('gl-test', { factory: asFactory(factory) })!;
    await s.setItem('k', 'v');
    expect(factory.opens).toBe(1);
    factory.db.onversionchange!();
    expect(factory.db.closed).toBe(1);
    expect(await s.getItem('k')).toBe('v');
    expect(factory.opens).toBe(2);
    factory.db.onclose!();
    await s.setItem('k', 'w');
    expect(factory.opens).toBe(3);
    expect(await s.getItem('k')).toBe('w');
    expect(factory.opens).toBe(3);
  });

  it('surfaces request failures as backend errors', async () => {
    const factory = new FakeFactory();
    const s = createIndexedDbAdapter('gl-test', { factory: asFactory(factory) })!;
    await s.setItem('k', 'v');
    factory.db.failOps.add('get');
    await expect(s.getItem('k')).rejects.toMatchObject({ name: 'StorageError', code: 'backend' });
    factory.db.failOps.delete('get');
    factory.db.failOps.add('put');
    await expect(s.setItem('k', 'w')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('pickBrowserStorage', () => {
  it('falls back to memory storage when no browser backend exists', async () => {
    const s = pickBrowserStorage();
    expect(s.kind).toBe('memory');
    await s.setItem('k', 'v');
    expect(await s.getItem('k')).toBe('v');
  });
});
