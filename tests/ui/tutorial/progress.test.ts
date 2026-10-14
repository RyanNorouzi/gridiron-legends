import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import { createMemoryStorage } from '@/save/storage';
import {
  TUTORIAL_KEY, TutorialProgressController, createTutorialStore, emptyProgress, parseProgress, resumeIndex, shouldOfferTutorial,
} from '@/ui/tutorial/progress';

const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, audio: { ...DEFAULT_SETTINGS.audio }, camera: {}, bindings: {}, keyboardMap: {}, ...o });

describe('first-launch rule', () => {
  it('offers the tutorial only when progress is known and it was never completed, skipped or dismissed', () => {
    expect(DEFAULT_SETTINGS.tutorialCompleted).toBe(false);
    expect(shouldOfferTutorial(settings(), null)).toBe(false);
    expect(shouldOfferTutorial(settings(), emptyProgress())).toBe(true);
    expect(shouldOfferTutorial(settings({ tutorialCompleted: true }), emptyProgress())).toBe(false);
    expect(shouldOfferTutorial(settings(), { ...emptyProgress(), completed: true })).toBe(false);
    expect(shouldOfferTutorial(settings(), { ...emptyProgress(), skipped: true })).toBe(false);
    expect(shouldOfferTutorial(settings(), { ...emptyProgress(), dismissed: true })).toBe(false);
    // Older settings records without the field count as "not completed".
    const old = settings();
    delete old.tutorialCompleted;
    expect(shouldOfferTutorial(old, emptyProgress())).toBe(true);
  });

  it('resumes at the first unfinished step', () => {
    const ids = ['a', 'b', 'c'];
    expect(resumeIndex(ids, null)).toBe(0);
    expect(resumeIndex(ids, { ...emptyProgress(), completedSteps: ['a'] })).toBe(1);
    expect(resumeIndex(ids, { ...emptyProgress(), completedSteps: ['a', 'b', 'c'] })).toBe(0);
    expect(resumeIndex(ids, { ...emptyProgress(), completed: true, completedSteps: ['a'] })).toBe(0);
  });
});

describe('tutorial progress persistence', () => {
  it('parses forgivingly and round-trips through the storage adapter', async () => {
    expect(parseProgress('junk')).toEqual(emptyProgress());
    expect(parseProgress({ completed: 'yes', completedSteps: ['a', 3], lastStepId: 'a' })).toEqual({ ...emptyProgress(), completedSteps: ['a'], lastStepId: 'a' });
    const storage = createMemoryStorage();
    const store = createTutorialStore(storage);
    expect(await store.load()).toEqual(emptyProgress());
    await store.save({ ...emptyProgress(), completedSteps: ['movement'] });
    expect(await storage.keys()).toEqual([TUTORIAL_KEY]);
    expect((await store.load()).completedSteps).toEqual(['movement']);
    await storage.setItem(TUTORIAL_KEY, '{nope');
    expect(await store.load()).toEqual(emptyProgress());
  });

  it('the controller answers the menu, records steps and completion (settings flag + persistSettings)', async () => {
    const storage = createMemoryStorage();
    const s = settings();
    const persist = vi.fn();
    const c = new TutorialProgressController(createTutorialStore(storage), s, persist);
    expect(c.shouldOffer()).toBe(false);
    await c.ready;
    expect(c.shouldOffer()).toBe(true);
    c.decline(false);
    expect(c.shouldOffer()).toBe(false);
    expect(await storage.getItem(TUTORIAL_KEY)).toBeNull();
    c.markStep('movement');
    c.markStep('movement');
    c.markStep('passing');
    await Promise.resolve();
    expect(JSON.parse((await storage.getItem(TUTORIAL_KEY))!).completedSteps).toEqual(['movement', 'passing']);
    // A new launch (fresh controller) still offers it and resumes after the finished steps.
    const next = new TutorialProgressController(createTutorialStore(storage), settings(), persist);
    await next.ready;
    expect(next.shouldOffer()).toBe(true);
    expect(next.progress?.completedSteps).toEqual(['movement', 'passing']);
    next.complete(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0].tutorialCompleted).toBe(true);
    await Promise.resolve();
    const again = new TutorialProgressController(createTutorialStore(storage), settings(), persist);
    await again.ready;
    expect(again.shouldOffer()).toBe(false);
    expect(again.progress?.completed).toBe(true);
  });

  it('"don\'t ask again" is stored; a completed settings flag wins over a missing record; storage failures never throw', async () => {
    const storage = createMemoryStorage();
    const c = new TutorialProgressController(createTutorialStore(storage), settings());
    await c.ready;
    c.decline(true);
    await Promise.resolve();
    const later = new TutorialProgressController(createTutorialStore(storage), settings());
    await later.ready;
    expect(later.shouldOffer()).toBe(false);
    const done = new TutorialProgressController(createTutorialStore(createMemoryStorage()), settings({ tutorialCompleted: true }));
    await done.ready;
    expect(done.progress?.completed).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = new TutorialProgressController({ load: () => Promise.reject(new Error('io')), save: () => Promise.reject(new Error('io')) }, settings());
    await broken.ready;
    expect(broken.shouldOffer()).toBe(true);
    broken.complete(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(broken.progress).toMatchObject({ completed: true, skipped: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
