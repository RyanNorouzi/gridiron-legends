import { describe, expect, it } from 'vitest';
import { SaveError, isCompressed, leagueFromRaw, leagueToDiskForm, stableStringify } from '@/save/serialize';
import { CURRENT_SAVE_VERSION } from '@/save/migrations';
import { EXPORT_FORMAT, SLOT_KEY_PREFIX, createSlotStore, gameKey, leagueKey, metaKey, type SlotStore } from '@/save/slots';
import { createMemoryStorage, type StorageAdapter } from '@/save/storage';
import { makeGame, makeLeague } from './fixtures';

const clock = (start = 1_700_000_000_000) => {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => { t += ms; return t; } };
};

const setup = (opts: { compress?: boolean } = {}): { storage: StorageAdapter; store: SlotStore; clock: ReturnType<typeof clock> } => {
  const storage = createMemoryStorage();
  const c = clock();
  return { storage, store: createSlotStore(storage, { now: c.now, compress: opts.compress }), clock: c };
};

const rejectsSaveError = async (p: Promise<unknown>, code: SaveError['code']): Promise<void> => {
  await expect(p).rejects.toBeInstanceOf(SaveError);
  await expect(p).rejects.toMatchObject({ code });
};

describe('SlotStore.save / load', () => {
  it('writes namespaced keys and builds metadata from the league', async () => {
    const { storage, store, clock: c } = setup();
    const league = makeLeague();
    const meta = await store.save('main', league);
    expect(meta).toEqual({
      id: 'main', name: 'Harbor Gulls 2026', teamName: 'Harbor Gulls', year: 2026, phase: 'regularSeason', week: 1,
      createdAt: c.now(), updatedAt: c.now(), version: 1, sizeBytes: meta.sizeBytes, hasGameInProgress: false,
    });
    expect(meta.sizeBytes).toBeGreaterThan(1000);
    expect(await storage.keys(SLOT_KEY_PREFIX)).toEqual([metaKey('main'), leagueKey('main')].sort());
    expect(await storage.getItem(gameKey('main'))).toBeNull();
    const loaded = await store.load('main');
    expect(loaded.league).toEqual(league);
    expect(loaded.game).toBeNull();
    expect(loaded.meta).toEqual(meta);
  });

  it('stores and restores a mid-game state and clears it on the next game-less save', async () => {
    const { storage, store } = setup();
    const league = makeLeague();
    const game = makeGame(league);
    const withGame = await store.save('main', league, game);
    expect(withGame.hasGameInProgress).toBe(true);
    expect(await storage.getItem(gameKey('main'))).not.toBeNull();
    expect((await store.load('main')).game).toEqual(game);
    const finished = await store.save('main', league, { ...game, phase: 'final' });
    expect(finished.hasGameInProgress).toBe(false);
    const cleared = await store.save('main', league);
    expect(cleared.hasGameInProgress).toBe(false);
    expect(await storage.getItem(gameKey('main'))).toBeNull();
    expect((await store.load('main')).game).toBeNull();
  });

  it('keeps createdAt and the custom name across re-saves, bumps updatedAt from the injected clock', async () => {
    const { store, clock: c } = setup();
    const league = makeLeague();
    const first = await store.save('main', league, null, { name: '  Dynasty run  ' });
    expect(first.name).toBe('Dynasty run');
    c.tick(5000);
    const second = await store.save('main', { ...league, year: 2027 });
    expect(second.name).toBe('Dynasty run');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(first.updatedAt + 5000);
    expect(second.year).toBe(2027);
  });

  it('uses "No team" when the league has no user team', async () => {
    const { store } = setup();
    const meta = await store.save('spectate', { ...makeLeague(), userTeamId: null });
    expect(meta.teamName).toBe('No team');
    expect(meta.name).toBe('No team 2026');
  });

  it('rejects invalid slot ids and blank names', async () => {
    const { store } = setup();
    await rejectsSaveError(store.save('bad slot!', makeLeague()), 'slot');
    await rejectsSaveError(store.save('a:b', makeLeague()), 'slot');
    await rejectsSaveError(store.save('', makeLeague()), 'slot');
    await rejectsSaveError(store.save('ok', makeLeague(), null, { name: '   ' }), 'slot');
    await rejectsSaveError(store.load('bad slot!'), 'slot');
  });

  it('refuses to save an inconsistent league before touching storage', async () => {
    const { storage, store } = setup();
    const league = makeLeague();
    league.players['p_qb1' as never]!.teamId = null;
    await expect(store.save('main', league)).rejects.toBeInstanceOf(SaveError);
    expect(await storage.keys()).toEqual([]);
  });

  it('load reports missing slots and missing payloads', async () => {
    const { storage, store } = setup();
    await rejectsSaveError(store.load('ghost'), 'notFound');
    await store.save('main', makeLeague());
    await storage.removeItem(leagueKey('main'));
    await rejectsSaveError(store.load('main'), 'notFound');
  });

  it('still loads the league when the stored game payload is corrupt or from a newer version', async () => {
    const { storage, store } = setup();
    const league = makeLeague();
    const game = makeGame(league);
    await store.save('main', league, game);
    await storage.setItem(gameKey('main'), '{not json');
    const corrupt = await store.load('main');
    expect(corrupt.league).toEqual(league);
    expect(corrupt.game).toBeNull();
    expect(corrupt.gameError).toBeInstanceOf(SaveError);
    expect(corrupt.gameError?.code).toBe('parse');
    await storage.setItem(gameKey('main'), JSON.stringify({ ...game, version: 99 }));
    expect((await store.load('main')).gameError?.code).toBe('version');
    // storage failures are not swallowed
    const failing = createSlotStore({ ...storage, getItem: async (k) => { if (k === gameKey('main')) throw new Error('io'); return storage.getItem(k); } }, { now: () => 0 });
    await expect(failing.load('main')).rejects.toThrow('io');
  });

  it('compresses payloads when the store is configured to, and per call', async () => {
    const { storage, store } = setup({ compress: true });
    const league = makeLeague();
    await store.save('main', league, makeGame(league));
    expect(isCompressed((await storage.getItem(leagueKey('main')))!)).toBe(true);
    expect(isCompressed((await storage.getItem(gameKey('main')))!)).toBe(true);
    expect((await store.load('main')).league).toEqual(league);
    await store.save('plain', league, null, { compress: false });
    expect(isCompressed((await storage.getItem(leagueKey('plain')))!)).toBe(false);
  });
});

describe('SlotStore.list / delete / rename / exists', () => {
  it('lists metadata newest first, ignoring payload keys, with corrupt metadata listed last as damaged entries', async () => {
    const { storage, store, clock: c } = setup();
    const league = makeLeague();
    await store.save('older', league);
    c.tick();
    await store.save('newer', league);
    await storage.setItem(metaKey('corrupt'), '{oops');
    await storage.setItem(metaKey('wrong-shape'), JSON.stringify({ id: 'wrong-shape' }));
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(['newer', 'older', 'corrupt', 'wrong-shape']);
    expect(list.slice(0, 2).every((m) => m.damaged === undefined)).toBe(true);
    const [corrupt, shape] = list.slice(2);
    expect(corrupt).toMatchObject({ id: 'corrupt', name: 'corrupt', teamName: 'Damaged save', updatedAt: 0, hasGameInProgress: false });
    expect(corrupt!.damaged).toMatch(/not valid JSON/);
    expect(shape!.damaged).toMatch(/wrong shape/);
    expect(await store.exists('older')).toBe(true);
    expect(await store.exists('ghost')).toBe(false);
  });

  it('damaged slots can be deleted and are never reused by an import', async () => {
    const { storage, store } = setup();
    await storage.setItem(metaKey('slot-1'), '{oops');
    await storage.setItem(leagueKey('slot-1'), 'still here');
    const imported = await store.import(JSON.stringify(makeLeague()));
    expect(imported.id).toBe('slot-2');
    expect(await storage.getItem(leagueKey('slot-1'))).toBe('still here');
    await rejectsSaveError(store.load('slot-1'), 'parse');
    await store.delete('slot-1');
    expect((await store.list()).map((m) => m.id)).toEqual(['slot-2']);
    expect(await storage.getItem(leagueKey('slot-1'))).toBeNull();
  });

  it('delete removes every key and is idempotent', async () => {
    const { storage, store } = setup();
    const league = makeLeague();
    await store.save('main', league, makeGame(league));
    await store.delete('main');
    expect(await storage.keys()).toEqual([]);
    await expect(store.delete('main')).resolves.toBeUndefined();
    await rejectsSaveError(store.load('main'), 'notFound');
  });

  it('rename updates the name only', async () => {
    const { store, clock: c } = setup();
    const before = await store.save('main', makeLeague());
    c.tick();
    const after = await store.rename('main', 'Renamed');
    expect(after).toEqual({ ...before, name: 'Renamed' });
    expect((await store.list())[0]!.name).toBe('Renamed');
    await rejectsSaveError(store.rename('main', ''), 'slot');
    await rejectsSaveError(store.rename('ghost', 'x'), 'notFound');
  });
});

describe('SlotStore.export / import', () => {
  it('keeps the game mode of a Season / Playoffs export (APP2-03)', async () => {
    const a = setup();
    const league = makeLeague();
    await a.store.save('season-1', league, null, { name: 'My season', mode: 'season' });
    await a.store.save('po-1', league, null, { name: 'My playoffs', mode: 'playoffs' });
    const b = setup();
    const season = await b.store.import(await a.store.export('season-1'));
    expect(season.mode).toBe('season');
    expect((await b.store.list()).find((m) => m.id === season.id)?.mode).toBe('season');
    expect((await b.store.import(await a.store.export('po-1'))).mode).toBe('playoffs');
    // A franchise export (no mode) stays a franchise, even when imported over a season slot.
    await a.store.save('fr', league, null, { name: 'Franchise' });
    expect((await b.store.import(await a.store.export('fr'), { slot: season.id })).mode).toBeUndefined();
  });

  it('exports a readable envelope and imports it into a free slot on another store', async () => {
    const a = setup();
    const league = makeLeague();
    const game = makeGame(league);
    await a.store.save('main', league, game, { name: 'Road trip' });
    const text = await a.store.export('main');
    const env = JSON.parse(text) as { format: string; meta: { name: string }; league: unknown; game: unknown; exportedAt: number };
    expect(env.format).toBe(EXPORT_FORMAT);
    expect(env.meta.name).toBe('Road trip');
    // The league travels in the compact file format (v2), exactly what the slot stores, and expands back losslessly.
    expect(env.league).toEqual(leagueToDiskForm(league));
    expect((env.league as { version: number }).version).toBe(CURRENT_SAVE_VERSION);
    expect(leagueFromRaw(env.league)).toEqual(league);
    expect(env.game).toEqual(game);
    expect(env.exportedAt).toBe(a.clock.now());

    const b = setup();
    const imported = await b.store.import(text);
    expect(imported.id).toBe('slot-1');
    expect(imported.name).toBe('Road trip');
    expect(imported.hasGameInProgress).toBe(true);
    const loaded = await b.store.load('slot-1');
    expect(loaded.league).toEqual(league);
    expect(loaded.game).toEqual(game);
    expect((await b.store.import(text)).id).toBe('slot-2');
    expect((await b.store.import(text, { slot: 'custom', name: 'Mine' })).name).toBe('Mine');
    expect((await b.store.load('custom')).meta.id).toBe('custom');
  });

  it('imports a bare league JSON (no envelope) and re-exports identically', async () => {
    const { store } = setup();
    const league = makeLeague();
    const meta = await store.import(JSON.stringify(league));
    expect(meta.name).toBe('Harbor Gulls 2026');
    expect(meta.hasGameInProgress).toBe(false);
    expect((await store.load(meta.id)).league).toEqual(league);
    const again = await store.export(meta.id);
    expect(leagueFromRaw(JSON.parse(again).league)).toEqual(league);
  });

  it('exports compact leagues (smaller than the full form) and still imports full-form v1 exports', async () => {
    const { store } = setup();
    const league = makeLeague();
    await store.save('main', league, null, { name: 'Compact' });
    const text = await store.export('main');
    const env = JSON.parse(text) as Record<string, unknown>;
    const fullForm = stableStringify({ ...env, league });
    expect(text.length).toBeLessThan(fullForm.length);
    // An export written before compaction (full stat lines, league version 1) imports to the same league.
    const legacy = await store.import(fullForm, { slot: 'legacy' });
    expect(legacy.name).toBe('Compact');
    expect((await store.load('legacy')).league).toEqual(league);
    // Round trip: export -> import -> export is stable.
    const back = await store.import(text, { slot: 'back' });
    expect((await store.load(back.id)).league).toEqual(league);
    const text2 = JSON.parse(await store.export('back')) as Record<string, unknown>;
    expect(text2.league).toEqual(env.league);
  });

  it('rejects unsupported envelope versions, corrupt text and invalid leagues', async () => {
    const { store } = setup();
    await rejectsSaveError(store.import(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 2, league: makeLeague(), game: null })), 'format');
    await rejectsSaveError(store.import('garbage'), 'parse');
    await rejectsSaveError(store.import(JSON.stringify({ ...makeLeague(), teams: {} })), 'validation');
    await rejectsSaveError(store.import(JSON.stringify(makeLeague()), { slot: 'no spaces' }), 'slot');
    expect(await store.list()).toEqual([]);
  });
});
