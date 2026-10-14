import { describe, expect, it } from 'vitest';
import { createLeague } from '@/franchise/league';
import { simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { userGameThisWeek } from '@/franchise/week';
import { createMemoryStorage, createSaveSystem } from '@/save/index';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { GameDayScreen } from '@/ui/franchise/game-day';
import type { ScreenServices } from '@/ui/screens/screen';
import { CustomGameScreen } from '@/ui/screens/custom-game';
import { QuickGameSetupScreen, quickGameLeague } from '@/ui/screens/quick-game-setup';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from './fixtures';

/** Wires services.persistSettings to a real (memory) save system, as the app does. */
const persistTo = (services: ScreenServices): { saves: ReturnType<typeof createSaveSystem>; writes: () => number } => {
  const saves = createSaveSystem(createMemoryStorage());
  let writes = 0;
  services.persistSettings = () => {
    writes++;
    void saves.saveSettings(services.settings);
  };
  return { saves, writes: () => writes };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('Defense option persistence', () => {
  it('the game-day card saves the Defense setting through the save system', async () => {
    const league = simulateToPhase(createLeague({ seed: 71, userTeamAbbr: 'BOS' }), 'regularSeason', { simulator: fallbackSimulator, autoFix: true }).league;
    const game = userGameThisWeek(league);
    if (!game) throw new Error('no user game');
    const fc = createTestFranchiseContext(league);
    const { saves, writes } = persistTo(fc.services);
    const day = new GameDayScreen(fc, game.id, { simulator: fallbackSimulator });
    fc.push(day);
    const idx = day.list.items.findIndex((i) => i.id === 'defense');
    day.list.select(idx);
    const before = fc.services.settings.defenseMode;
    fc.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
    expect(fc.services.settings.defenseMode).not.toBe(before);
    expect(writes()).toBe(1);
    await flush();
    expect((await saves.loadSettings()).defenseMode).toBe(fc.services.settings.defenseMode);
  }, 30000);

  it('Quick Game persists a changed Defense on start, and skips the write when unchanged', async () => {
    const ui = makeUi();
    const { saves, writes } = persistTo(ui.services);
    const league = quickGameLeague(7);
    const screen = new QuickGameSetupScreen({ onStart: () => undefined, league, seed: () => 5, mode: 'play' });
    ui.stack.push(screen);
    screen.start();
    expect(writes()).toBe(0);
    screen.change('defense', 1);
    screen.start();
    expect(writes()).toBe(1);
    await flush();
    expect((await saves.loadSettings()).defenseMode).toBe(screen.choice.defenseMode);
  });

  it('Custom Game persists a changed Defense when a human side plays', async () => {
    const ui = makeUi();
    const { saves, writes } = persistTo(ui.services);
    const screen = new CustomGameScreen({ onStart: () => undefined, league: quickGameLeague(7), seed: () => 5 });
    ui.stack.push(screen);
    screen.change('defenseMode', 1);
    screen.start();
    expect(writes()).toBe(1);
    await flush();
    expect((await saves.loadSettings()).defenseMode).toBe(ui.settings.defenseMode);
    expect(ui.settings.defenseMode).not.toBe('control');
  });
});
