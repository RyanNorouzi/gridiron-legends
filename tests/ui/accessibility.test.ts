import { describe, expect, it, vi } from 'vitest';
import { AudioManager, createNullBackend } from '@/audio/index';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createMemoryStorage } from '@/save/index';
import { ACCESS_KEY, createAccessStore, defaultAccess, parseAccess } from '@/ui/accessibility';
import { drawBanner } from '@/ui/game/banners';
import { GameSpeedGate } from '@/ui/game/game-speed';
import { ToggleLatch } from '@/ui/input/hold-toggle';
import { GameScreen } from '@/ui/screens/game';
import { SettingsScreen } from '@/ui/screens/settings';
import { createTheme } from '@/ui/theme';
import { CaptionTrack } from '@/ui/widgets/captions';
import { createFakeCtx, makeInput } from './render/fake-ctx';
import { autoplay, makeSession, makeUi } from './game/fixtures';

describe('game speed', () => {
  it('runs half the play ticks at 0.5x and carries skipped presses; 1x passes through; 2x runs two ticks', () => {
    const gate = new GameSpeedGate();
    const counts = Array.from({ length: 6 }, (_, i) => gate.step(0.5, makeInput(i === 0 ? { pressed: ['tackle'] } : {})));
    expect(counts.map((c) => c.length)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(counts[1]?.[0]?.justPressed.has('tackle')).toBe(true);
    expect(counts[3]?.[0]?.justPressed.has('tackle')).toBe(false);
    const one = makeInput({ pressed: ['snap'] });
    expect(new GameSpeedGate().step(1, one)).toEqual([one]);
    const two = new GameSpeedGate().step(2, makeInput({ pressed: ['snap'], down: ['sprint'] }));
    expect(two).toHaveLength(2);
    expect(two[1]?.justPressed.size).toBe(0);
    expect(two[1]?.down.has('sprint')).toBe(true);
    const g15 = new GameSpeedGate();
    expect(Array.from({ length: 4 }, () => g15.step(1.5, makeInput()).length)).toEqual([1, 2, 1, 2]);
  });

  it('the game screen runs fewer live ticks at 0.5x (same plays, slower pacing)', () => {
    const run = (gameSpeed: number): number => {
      const ui = makeUi({ gameSpeed });
      const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 }, ticksToDead: 400 });
      ui.stack.push(new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() }));
      autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.userSide === 'home', coinToss: 'receive' });
      const play = f.plays[f.plays.length - 1];
      const before = play?.inputs.length ?? 0;
      for (let i = 0; i < 40; i++) ui.stack.update(1 / 60, makeInput());
      return (play?.inputs.length ?? 0) - before;
    };
    expect(run(1)).toBe(40);
    expect(run(0.5)).toBe(20);
    expect(run(2)).toBe(80);
  });
});

describe('hold vs toggle', () => {
  it('latches sprint on a press until the next press or reset', () => {
    const latch = new ToggleLatch();
    expect(latch.apply(makeInput({ pressed: ['sprint'] })).down.has('sprint')).toBe(true);
    expect(latch.apply(makeInput()).down.has('sprint')).toBe(true);
    expect(latch.apply(makeInput({ pressed: ['sprint'] })).down.has('sprint')).toBe(false);
    expect(latch.apply(makeInput({ down: ['sprint'] })).down.has('sprint')).toBe(false);
    latch.apply(makeInput({ pressed: ['defSprint'] }));
    latch.reset();
    expect(latch.isOn('defSprint')).toBe(false);
    const plain = makeInput({ down: ['tackle'] });
    expect(latch.apply(plain)).toBe(plain);
  });

  it('the game screen latches sprint for the human carrier when the option is on', () => {
    const ui = makeUi();
    ui.services.access = { ...defaultAccess(), sprintToggle: true };
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 }, ticksToDead: 400 });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.userSide === 'home', coinToss: 'receive' });
    ui.stack.update(1 / 60, makeInput({ pressed: ['sprint'] }));
    for (let i = 0; i < 5; i++) ui.stack.update(1 / 60, makeInput());
    expect(screen.sprintLatched).toBe(true);
    ui.stack.update(1 / 60, makeInput({ pressed: ['sprint'] }));
    expect(screen.sprintLatched).toBe(false);
    ui.services.access = defaultAccess();
    ui.stack.update(1 / 60, makeInput({ pressed: ['sprint'] }));
    expect(screen.sprintLatched).toBe(false);
  });
});

describe('captions', () => {
  it('the audio manager captions important cues even when muted, without repeats inside the window', () => {
    let t = 0;
    const audio = new AudioManager(createNullBackend(), DEFAULT_SETTINGS.audio, { now: () => t });
    audio.mute();
    const got: string[] = [];
    const off = audio.onCaption((c) => got.push(c));
    audio.onGameEvent({ type: 'whistle', tick: 5 });
    audio.onGameEvent({ type: 'whistle', tick: 6 });
    t = 2000;
    audio.onGameEvent({ type: 'whistle', tick: 7 });
    audio.onGameEvent({ type: 'snap', tick: 1 });
    audio.onGameEvent({ type: 'twoMinuteWarning' });
    expect(got).toEqual(['[WHISTLE]', '[WHISTLE]', '[TWO-MINUTE WARNING HORN]']);
    off();
    t = 5000;
    audio.onGameEvent({ type: 'whistle', tick: 8 });
    expect(got).toHaveLength(3);
  });

  it('the caption track merges repeats, expires and draws', () => {
    const track = new CaptionTrack();
    track.push('[WHISTLE]');
    track.push('[WHISTLE]');
    track.push('[CROWD ROARS]');
    expect(track.texts).toEqual(['[WHISTLE] x2', '[CROWD ROARS]']);
    const ctx = createFakeCtx();
    track.draw(ctx, createTheme(DEFAULT_SETTINGS), 480, 270);
    expect(ctx.fills.length).toBeGreaterThan(10);
    track.update(3);
    expect(track.texts).toEqual([]);
  });
});

describe('accessibility preferences', () => {
  it('round-trip through storage and survive garbage', async () => {
    const storage = createMemoryStorage();
    const store = createAccessStore(storage);
    expect(await store.load()).toEqual(defaultAccess());
    await store.save({ captions: true, sprintToggle: true });
    expect(await store.load()).toEqual({ captions: true, sprintToggle: true });
    await storage.setItem(ACCESS_KEY, '{nope');
    expect(await store.load()).toEqual(defaultAccess());
    expect(parseAccess({ captions: 'yes', sprintToggle: true })).toEqual({ captions: false, sprintToggle: true });
  });

  it('the settings screen toggles captions and sprint mode and persists them', () => {
    const ui = makeUi();
    ui.services.access = defaultAccess();
    const persistAccess = vi.fn();
    ui.services.persistAccess = persistAccess;
    const screen = new SettingsScreen(ui.settings);
    ui.stack.push(screen);
    screen.change('captions', 1);
    screen.change('sprintToggle', 1);
    expect(ui.services.access).toEqual({ captions: true, sprintToggle: true });
    expect(persistAccess).toHaveBeenCalledTimes(2);
    expect(screen.list.items.find((i) => i.id === 'sprintToggle')?.value).toBe('TOGGLE');
    expect(screen.list.items.find((i) => i.id === 'captions')?.value).toBe('ON');
  });

  it('reduced motion: banners neither slide nor fade', () => {
    // Two frames into the slam-in (the banner band grows over its first 6 frames); reduced motion shows it whole.
    const banner = { text: 'TOUCHDOWN', sub: 'HOM', tone: 'good' as const, remaining: 2.18, total: 2.2 };
    const xs = (reducedMotion: boolean): number => {
      const ctx = createFakeCtx();
      drawBanner(ctx, createTheme({ ...DEFAULT_SETTINGS, reducedMotion }), banner, 480, 270);
      return Math.min(...ctx.fills.map((f) => f.x));
    };
    expect(xs(true)).not.toBe(xs(false));
    const ctx = createFakeCtx();
    drawBanner(ctx, createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true }), { ...banner, remaining: 0.05 }, 480, 270);
    expect(ctx.globalAlpha).toBe(1);
  });
});
