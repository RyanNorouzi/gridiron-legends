/**
 * Code splitting: every main-menu mode lives in a lazily imported bundle. Each bundle must load and expose the
 * screens the app opens; the loader shows a toast when loading is slow and reports a failed load.
 */
import { describe, expect, it, vi } from 'vitest';
import { franchiseBundle, gameBundle, practiceBundle } from '@/ui/app-modes';
import { lazyBundle, withBundle } from '@/ui/lazy/loader';

describe('lazy mode bundles', () => {
  it('load the game, franchise and practice screens', { timeout: 30000 }, async () => {
    const game = await gameBundle.load();
    expect(typeof game.GameScreen).toBe('function');
    expect(typeof game.QuickGameSetupScreen).toBe('function');
    expect(typeof game.CustomGameScreen).toBe('function');
    expect(gameBundle.loaded).toBe(game);
    const franchise = await franchiseBundle.load();
    expect(typeof franchise.FranchiseHubScreen).toBe('function');
    expect(typeof franchise.startSeasonMode).toBe('function');
    const practice = await practiceBundle.load();
    expect(typeof practice.PracticeMenuScreen).toBe('function');
    expect(typeof practice.TutorialScreen).toBe('function');
  });

  it('runs synchronously once loaded, loads once, runs only the latest waiting request, and toasts a failure', async () => {
    const importer = vi.fn(async () => ({ value: 42 }));
    const b = lazyBundle(importer);
    const seen: number[] = [];
    // Two presses while the chunk loads (the menu stays live): the mode opens once, for the latest choice.
    withBundle(b, () => undefined, (m) => seen.push(m.value));
    withBundle(b, () => undefined, (m) => seen.push(m.value + 100));
    await vi.waitFor(() => expect(seen).toEqual([142]));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(seen).toEqual([142]);
    expect(importer).toHaveBeenCalledTimes(1);
    withBundle(b, () => undefined, (m) => seen.push(m.value + 1));
    withBundle(b, () => undefined, (m) => seen.push(m.value + 2));
    expect(seen).toEqual([142, 43, 44]);
    const toasts: string[] = [];
    const bad = lazyBundle<{ value: number }>(() => Promise.reject(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    withBundle(bad, (m) => toasts.push(m), () => undefined);
    await vi.waitFor(() => expect(toasts.some((t) => t.startsWith('Could not load'))).toBe(true));
  });
});
