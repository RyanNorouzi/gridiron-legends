import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage, leagueKey, metaKey } from '@/save/index';
import type { League } from '@/franchise/types';
import type { SaveSlotMeta } from '@/save/slots';
import { createHeadlessServices } from '@/ui/franchise/context';
import { ChoiceDialog, ConfirmDialog, TextEntryDialog } from '@/ui/franchise/kit/dialogs';
import { FranchiseMenuScreen, LoadFranchiseScreen, type FileBridge } from '@/ui/franchise/load-franchise';
import { downloadText, exportFileName, formatBytes, nextSlotId, pickTextFile, slotRows } from '@/ui/franchise/shell/save-model';
import { makeInput } from '../../render/fake-ctx';
import { leagueAt, memorySaves, rcFor } from './helpers';

const bridge = (): FileBridge & { downloads: { name: string; text: string }[]; next: string | null } => {
  const b = {
    downloads: [] as { name: string; text: string }[],
    next: null as string | null,
    download: (name: string, text: string) => { b.downloads.push({ name, text }); return text; },
    pick: async () => b.next,
  };
  return b;
};

describe('save model', () => {
  it('formats slot rows and allocates ids', () => {
    const meta: SaveSlotMeta = { id: 'franchise-1', name: 'My Run', teamName: 'Boston Ironsides', year: 2027, phase: 'regularSeason', week: 5, createdAt: 0, updatedAt: Date.UTC(2026, 8, 24, 12, 0), version: 1, sizeBytes: 5_300_000, hasGameInProgress: false };
    const [row] = slotRows([meta]);
    expect(row).toMatchObject({ id: 'franchise-1', name: 'My Run', team: 'Boston Ironsides', when: '2027 Week 5', size: '5.1 MB' });
    expect(row?.updated).toMatch(/^Sep 2[45] \d\d:\d\d$/);
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(nextSlotId([{ id: 'franchise-1' }, { id: 'franchise-3' }])).toBe('franchise-2');
    expect(exportFileName('  My Run! ')).toBe('gridiron-my-run.json');
  });
});

describe('browser file bridges', () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeDom = () => {
    const log: string[] = [];
    const timers: (() => void)[] = [];
    const el = { href: '', download: '', type: '', accept: '', onchange: null as (() => void) | null, oncancel: null as (() => void) | null, files: null, click: () => log.push('click') };
    vi.stubGlobal('document', { createElement: () => el });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:1', revokeObjectURL: (u: string) => log.push(`revoke ${u}`) });
    vi.stubGlobal('Blob', class { constructor(readonly parts: string[]) {} });
    vi.stubGlobal('setTimeout', (cb: () => void) => { timers.push(cb); return 0; });
    return { log, timers, el };
  };

  it('downloads through a Blob link and revokes the URL only after the click has started the download', () => {
    const { log, timers, el } = fakeDom();
    expect(downloadText('gridiron-x.json', '{"a":1}')).toBe('{"a":1}');
    expect(el.download).toBe('gridiron-x.json');
    expect(log).toEqual(['click']);
    timers.forEach((t) => t());
    expect(log).toEqual(['click', 'revoke blob:1']);
  });

  it('resolves null when the file picker is closed without a file', async () => {
    const { el } = fakeDom();
    const picked = pickTextFile();
    el.oncancel?.();
    await expect(picked).resolves.toBeNull();
  });
});

describe('LoadFranchiseScreen', () => {
  it('lists, loads, renames, exports, imports and deletes saves in memory storage', async () => {
    const league = leagueAt(51);
    const storage = createMemoryStorage();
    const saves = memorySaves(storage);
    await saves.slots.save('franchise-1', league, null, { name: 'First' });
    await saves.slots.save('franchise-2', { ...league, name: 'Second league' }, null, { name: 'Second' });
    const loaded: { league: League; meta: SaveSlotMeta }[] = [];
    const files = bridge();
    const services = createHeadlessServices();
    const screen = new LoadFranchiseScreen({ slots: saves.slots, files, onLoad: (l, meta) => loaded.push({ league: l, meta }) });
    services.stack.push(screen);
    await screen.refresh();
    expect(screen.table.rows.map((r) => r.name).sort()).toEqual(['First', 'Second']);
    screen.render(rcFor(services));

    expect(await screen.load('franchise-1')).toBe(true);
    expect(loaded[0]?.meta.id).toBe('franchise-1');
    expect(loaded[0]?.league.season.schedule.length).toBe(league.season.schedule.length);

    expect(await screen.rename('franchise-1', 'Renamed')).toBe(true);
    expect(screen.table.rows.some((r) => r.name === 'Renamed')).toBe(true);

    const text = await screen.exportSlot('franchise-2');
    expect(text).toContain('gridiron-legends-save');
    expect(files.downloads[0]?.name).toBe('gridiron-second.json');

    files.next = text;
    const imported = await screen.importFile();
    expect(imported?.name).toBe('Second');
    expect(screen.slots).toHaveLength(3);
    expect(screen.table.selected?.id).toBe(imported?.id);
    const round = await saves.slots.load(imported?.id ?? '');
    expect(round.league.name).toBe('Second league');

    files.next = null;
    expect(await screen.importFile()).toBeNull();
    expect(await screen.importText('{"nope": true}')).toBeNull();

    expect(await screen.remove('franchise-2')).toBe(true);
    expect(screen.slots.map((m) => m.id)).not.toContain('franchise-2');
  });

  it('marks a corrupt save as damaged and keeps the others usable', async () => {
    const league = leagueAt(51);
    const storage = createMemoryStorage();
    const saves = memorySaves(storage);
    await saves.slots.save('good', league, null, { name: 'Good' });
    await saves.slots.save('bad', league, null, { name: 'Bad' });
    await storage.setItem(leagueKey('bad'), '{"broken": ');
    const toasts: string[] = [];
    const services = createHeadlessServices({}, (m) => toasts.push(m));
    const loaded: string[] = [];
    const screen = new LoadFranchiseScreen({ slots: saves.slots, files: bridge(), onLoad: (_l, meta) => loaded.push(meta.id) });
    services.stack.push(screen);
    await screen.refresh();
    expect(await screen.load('bad')).toBe(false);
    expect(toasts.at(-1)).toMatch(/Loading failed/);
    expect(screen.table.rows.find((r) => r.id === 'bad')?.damaged).toMatch(/Loading failed/);
    expect(await screen.load('good')).toBe(true);
    expect(loaded).toEqual(['good']);
    screen.table.selectById('bad');
    screen.render(rcFor(services));
  });

  it('lists saves with unreadable metadata as damaged and lets the player delete them', async () => {
    const storage = createMemoryStorage();
    const saves = memorySaves(storage);
    await saves.slots.save('good', leagueAt(51), null, { name: 'Good' });
    await storage.setItem(metaKey('wreck'), '{"id": ');
    await storage.setItem(leagueKey('wreck'), 'payload');
    const services = createHeadlessServices();
    const screen = new LoadFranchiseScreen({ slots: saves.slots, files: bridge(), onLoad: () => undefined });
    services.stack.push(screen);
    await screen.refresh();
    const row = screen.table.rows.find((r) => r.id === 'wreck');
    expect(row).toMatchObject({ when: 'Unreadable', size: '?' });
    expect(row?.damaged).toMatch(/not valid JSON/);
    expect(slotRows(screen.slots).find((r) => r.id === 'good')?.damaged).toBeNull();
    screen.table.selectById('wreck');
    screen.render(rcFor(services));
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    const actions = services.stack.top as ChoiceDialog;
    expect(actions).toBeInstanceOf(ChoiceDialog);
    actions.choose('delete');
    (services.stack.top as ConfirmDialog).choose(true);
    await vi.waitFor(async () => expect(await storage.getItem(leagueKey('wreck'))).toBeNull());
    expect(screen.slots.map((m) => m.id)).toEqual(['good']);
    // The Franchise menu never offers a damaged save as Continue.
    await storage.setItem(metaKey('wreck2'), 'x');
    const menu = new FranchiseMenuScreen({ slots: saves.slots, onNew: () => undefined, onLoadList: () => undefined, onContinue: () => undefined });
    await menu.refresh();
    expect(menu.newest?.id).toBe('good');
  });

  it('drives the slot actions through dialogs (keyboard) and supports large text', async () => {
    const saves = memorySaves();
    await saves.slots.save('franchise-1', leagueAt(51), null, { name: 'Only' });
    const services = createHeadlessServices({ textSize: 'large' });
    const screen = new LoadFranchiseScreen({ slots: saves.slots, files: bridge(), onLoad: () => undefined });
    services.stack.push(screen);
    await screen.refresh();
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    const actions = services.stack.top as ChoiceDialog;
    expect(actions).toBeInstanceOf(ChoiceDialog);
    actions.choose('rename');
    expect(services.stack.top).toBeInstanceOf(TextEntryDialog);
    (services.stack.top as TextEntryDialog).cancel();
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    (services.stack.top as ChoiceDialog).choose('delete');
    const confirm = services.stack.top as ConfirmDialog;
    expect(confirm).toBeInstanceOf(ConfirmDialog);
    confirm.choose(false);
    expect(await saves.slots.exists('franchise-1')).toBe(true);
    screen.render(rcFor(services));
  });
});

describe('FranchiseMenuScreen', () => {
  it('offers continue / new / load based on the saves', async () => {
    const saves = memorySaves();
    const calls: string[] = [];
    const services = createHeadlessServices();
    const menu = new FranchiseMenuScreen({ slots: saves.slots, onNew: () => calls.push('new'), onLoadList: () => calls.push('load'), onContinue: (m) => calls.push(`continue:${m.id}`) });
    services.stack.push(menu);
    await menu.refresh();
    expect(menu.menu.items.map((i) => i.id)).toEqual(['new', 'load', 'back']);
    expect(menu.menu.items.find((i) => i.id === 'load')?.disabled).toBe(true);
    await saves.slots.save('franchise-1', leagueAt(51), null, { name: 'Run' });
    await menu.refresh();
    expect(menu.menu.items[0]?.id).toBe('continue');
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    menu.menu.select(1);
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    menu.menu.select(2);
    services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(calls).toEqual(['continue:franchise-1', 'new', 'load']);
    menu.render(rcFor(services));
  });
});
