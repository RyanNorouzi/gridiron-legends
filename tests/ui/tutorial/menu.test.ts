/**
 * Main-menu wiring: the first-launch tutorial offer, and the app's Practice / Offense Practice / Defense Practice /
 * Tutorial actions pushing the right screens (headless services, fake canvas).
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createNullInput, startApp } from '@/ui/app';
import { MainMenuScreen, TUTORIAL_OFFER_DELAY, type MainMenuTutorialOffer } from '@/ui/screens/main-menu';
import { PracticeMenuScreen } from '@/ui/screens/practice';
import { TutorialScreen } from '@/ui/screens/tutorial';
import { PromptScreen } from '@/ui/screens/watch';
import type { InputState } from '@/ui/input/types';
import { createFakeCanvas, fakeSurfaceFactory, makeInput } from '../render/fake-ctx';
import { makeUi } from '../game/fixtures';

const offer = (should = true): MainMenuTutorialOffer & { decline: ReturnType<typeof vi.fn> } => ({ shouldOffer: () => should, decline: vi.fn() });

const menuWith = (o: MainMenuTutorialOffer | undefined, tutorial = vi.fn()) => {
  const ui = makeUi();
  const menu = new MainMenuScreen({ tutorial, quickGame: vi.fn() }, { tutorialOffer: o });
  ui.stack.push(menu);
  const tick = (n = 1, input: InputState = makeInput()): void => {
    for (let i = 0; i < n; i++) ui.stack.update(1 / 60, input);
  };
  return { ui, menu, tick, tutorial };
};

describe('first-launch tutorial offer', () => {
  it('appears once the menu has settled, never before, and only once', () => {
    const o = offer();
    const { ui, menu, tick } = menuWith(o);
    tick(Math.floor(TUTORIAL_OFFER_DELAY * 60) - 2);
    expect(ui.stack.top).toBe(menu);
    tick(3);
    const prompt = ui.stack.top;
    if (!(prompt instanceof PromptScreen)) throw new Error('expected the offer');
    expect(prompt.list.items.map((i) => i.id)).toEqual(['yes', 'later', 'never']);
    prompt.choose('later');
    expect(o.decline).toHaveBeenCalledWith(false);
    tick(120);
    expect(ui.stack.top).toBe(menu);
  });

  it('accepting runs the tutorial action; "don\'t ask again" declines for good', () => {
    const a = menuWith(offer());
    a.tick(60);
    (a.ui.stack.top as PromptScreen).choose('yes');
    expect(a.tutorial).toHaveBeenCalledTimes(1);
    const o = offer();
    const b = menuWith(o);
    b.tick(60);
    (b.ui.stack.top as PromptScreen).choose('never');
    expect(o.decline).toHaveBeenCalledWith(true);
  });

  it('is not offered when the offer says no, or without an offer at all', () => {
    const no = menuWith(offer(false));
    no.tick(120);
    expect(no.ui.stack.top).toBe(no.menu);
    const none = menuWith(undefined);
    none.tick(120);
    expect(none.ui.stack.top).toBe(none.menu);
    // Pressing confirm right away still reaches the menu (the offer never eats a quick key press).
    const quick = menuWith(offer());
    quick.tick(1, makeInput({ pressed: ['confirm'] }));
    expect(quick.ui.stack.top).toBe(quick.menu);
  });
});

describe('app main-menu actions', () => {
  const boot = () => {
    const fc = createFakeCanvas();
    const surface = fakeSurfaceFactory();
    const pending: (() => void)[] = [];
    let clock = 0;
    const handle = startApp(fc.canvas, {
      input: () => ({ manager: createNullInput() }),
      canvasOptions: { createSurface: surface.create, viewport: () => ({ width: 960, height: 540, dpr: 1 }) },
      loop: { now: () => clock, schedule: (cb) => pending.push(cb) },
      resizeTarget: null,
      audio: null,
      settings: { ...DEFAULT_SETTINGS },
      persistSettings: () => undefined,
    });
    const frame = (ms: number): void => {
      clock += ms;
      pending.shift()?.();
    };
    const menu = handle.stack.top as MainMenuScreen;
    return { handle, menu, frame };
  };

  it('Practice, Offense Practice and Defense Practice open the drill picker with the right filter', { timeout: 20000 }, async () => {
    const { handle, menu } = boot();
    await handle.ready;
    expect(menu).toBeInstanceOf(MainMenuScreen);
    const services = handle.services;
    expect(menu.activate('practice', services)).toBe(true);
    // Practice and the tutorial load lazily (code split); later opens use the cached bundle synchronously.
    await vi.waitFor(() => expect(handle.stack.top).toBeInstanceOf(PracticeMenuScreen), { timeout: 15000 });
    const all = handle.stack.top;
    expect((all as PracticeMenuScreen).categories).toEqual(['offense', 'defense', 'specialTeams']);
    handle.stack.popTo(menu);
    menu.activate('offensePractice', services);
    expect((handle.stack.top as PracticeMenuScreen).categories).toEqual(['offense']);
    handle.stack.popTo(menu);
    menu.activate('defensePractice', services);
    expect((handle.stack.top as PracticeMenuScreen).categories).toEqual(['defense']);
    handle.stack.popTo(menu);
    menu.activate('tutorial', services);
    const tut = handle.stack.top;
    expect(tut).toBeInstanceOf(TutorialScreen);
    expect((tut as TutorialScreen).step?.id).toBe('welcome');
    handle.stop();
  });

  it('offers the tutorial on a first launch once the menu has been up for a moment', { timeout: 20000 }, async () => {
    const { handle, menu, frame } = boot();
    await handle.ready;
    // Let the tutorial progress load (memory storage in Node: nothing stored = first launch).
    await new Promise((r) => setTimeout(r, 0));
    frame(0);
    for (let i = 0; i < 60 && handle.stack.top === menu; i++) frame(1000 / 60);
    const top = handle.stack.top;
    if (!(top instanceof PromptScreen)) throw new Error('expected the first-launch offer');
    top.choose('yes');
    await vi.waitFor(() => expect(handle.stack.top).toBeInstanceOf(TutorialScreen), { timeout: 15000 });
    handle.stop();
  });
});
