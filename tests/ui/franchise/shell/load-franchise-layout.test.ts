import { describe, expect, it, vi } from 'vitest';

const log: string[] = [];
vi.mock('@/ui/render/text', async (orig) => {
  const m = await orig<typeof import('@/ui/render/text')>();
  return { ...m, drawText: (...a: Parameters<typeof m.drawText>) => { log.push(String(a[1])); return m.drawText(...a); } };
});

import type { SaveSlotMeta, SlotStore } from '@/save/slots';
import { createHeadlessServices } from '@/ui/franchise/context';
import { TextEntryDialog } from '@/ui/franchise/kit/dialogs';
import { LoadFranchiseScreen } from '@/ui/franchise/load-franchise';
import { SAVE_NAME_MAX, fitSaveName, modeSaveName } from '@/ui/franchise/shell/save-model';
import { rcFor } from './helpers';

const meta = (id: string, name: string, mode?: SaveSlotMeta['mode'], inGame = false): SaveSlotMeta => ({
  id, name, teamName: 'New Orleans Revelers', year: 2026, phase: 'regularSeason', week: 2, createdAt: 0, updatedAt: Date.UTC(2026, 8, 24, 12),
  version: 1, sizeBytes: 3_100_000, hasGameInProgress: inGame, ...(mode ? { mode } : {}),
});

const render = async (textSize: 'normal' | 'large'): Promise<{ texts: string[]; screen: LoadFranchiseScreen; services: ReturnType<typeof createHeadlessServices> }> => {
  const slots = { list: async () => [meta('a', 'New Orleans Revelers Rn', 'season'), meta('b', 'New Orleans Revelers', undefined, true), meta('c', 'My Playoff Run', 'playoffs')] } as unknown as SlotStore;
  const services = createHeadlessServices({ textSize });
  const screen = new LoadFranchiseScreen({ slots, onLoad: () => undefined, files: { download: () => '', pick: async () => null } });
  services.stack.push(screen);
  await screen.refresh();
  log.length = 0;
  screen.render(rcFor(services));
  return { texts: [...log], screen, services };
};

describe('Load Franchise list readability (APP2-06 / APP2-12)', () => {
  it('normal text: whole save names, the mode in its own column, the in-game save marked', async () => {
    const { texts } = await render('normal');
    expect(texts).toContain('New Orleans Revelers Rn');
    expect(texts).toContain('New Orleans Revelers');
    expect(texts).toEqual(expect.arrayContaining(['Season', 'Franchise', 'Playoffs', '2026 Week 2 ●']));
    expect(texts.some((t) => t.startsWith('New Orleans Revelers Rn · Season'))).toBe(true);
  });

  it('large text: side columns drop so names stay readable (no 1-letter cells)', async () => {
    const { texts } = await render('large');
    expect(texts).toContain('New Orleans Revelers');
    expect(texts).toContain('My Playoff Run');
    expect(texts.filter((t) => /^.{1,3}\.\.\.$/.test(t))).toEqual([]);
  });

  it('Rename pre-fills a whole-word name and default mode names fit the dialog', async () => {
    const { screen, services } = await render('normal');
    expect(fitSaveName('New Orleans Revelers 2026 season')).toBe('New Orleans Revelers');
    expect(modeSaveName({ name: 'Revelers' }, 2026, 'season')).toBe('Revelers 2026 season');
    expect(modeSaveName({ name: 'Revelers' }, 2026, 'playoffs').length).toBeLessThanOrEqual(SAVE_NAME_MAX);
    screen.table.selectById('b');
    screen.update(1 / 60, { axis: { x: 0, y: 0 }, down: new Set(), justPressed: new Set(['confirm']), justReleased: new Set(), pointer: null, lastDevice: 'keyboard' });
    const choice = services.stack.top as { choose?: (id: string) => void };
    choice.choose?.('rename');
    const dialog = services.stack.top;
    expect(dialog).toBeInstanceOf(TextEntryDialog);
    expect((dialog as TextEntryDialog).model.text).toBe('New Orleans Revelers');
  });
});
