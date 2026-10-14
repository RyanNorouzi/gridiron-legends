/**
 * App shell. Boots the pixel canvas, settings, input, camera, sprite cache and the screen stack (starting on
 * the main menu), then drives everything from the fixed-timestep GameLoop: the input manager samples once per
 * frame (before any tick), each tick consumes one InputState and updates the top screen, and each frame
 * renders and presents. The browser input layer is loaded on demand; until it arrives (or if it fails) a
 * no-op manager keeps the loop running so the app never hangs on a missing device.
 * Main-menu wiring lives in app-modes.ts: every mode's screens load lazily (code split from the boot chunk).
 */
import { createAudio, type AudioManager } from '@/audio/index';
import { GameLoop, type LoopOptions } from '@/core/loop';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import { vec2 } from '@/core/vec2';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { GameSetup } from '@/game/types';
import { createSaveSystem, type SaveSystem } from '@/save/index';
import { FrameStats, perfNow, setActiveFrameStats } from '@/tools/frame-stats';
import { browserLocationSearch, isDevModeEnabled } from '@/tools/dev-state';
import { createAccessStore, defaultAccess } from './accessibility';
import { createModeActions } from './app-modes';
import { Camera } from './camera';
import type { GameSession } from './game/session-types';
import type { Action, ControlScheme, DeviceMap, InputManager, InputState } from './input/types';
import { createPixelCanvas, type PixelCanvas, type PixelCanvasOptions } from './render/canvas';
import { SpriteCache } from './render/sprites';
import { worldTimingLabel } from './render/world-layer';
import { drawText } from './render/text';
import { beginTouchFrame, endTouchFrame } from './input/touch-frame';
import { MainMenuScreen, type MainMenuActions } from './screens/main-menu';
import type { RenderContext, ScreenServices } from './screens/screen';
import { SettingsScreen } from './screens/settings';
import { createGameplayStore, defaultGameplay } from './gameplay-prefs';
import { musicForScreens } from '@/audio/music';
import { ScreenStack } from './screens/stack';
import { createTheme, type Theme } from './theme';
import { createTutorialStore, TutorialProgressController } from './tutorial/progress';
import { CaptionTrack } from './widgets/captions';
import { createToast, drawToast, showToast, updateToast } from './widgets/panel';

/** What the input factory hands back: a manager plus an optional teardown. */
export interface InputHandle {
  manager: InputManager;
  detach?: () => void;
}

export interface AppDeps {
  settings: Settings;
  /** Builds the input manager; may be async. Defaults to the browser input layer loaded on demand. */
  input: (canvas: HTMLCanvasElement, settings: Settings, logical: { width: number; height: number }) => InputHandle | Promise<InputHandle>;
  actions: MainMenuActions;
  logicalW: number;
  logicalH: number;
  loop: LoopOptions;
  canvasOptions: PixelCanvasOptions;
  /** Where 'resize' events come from; null disables. Defaults to window when present. */
  resizeTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** Start the loop immediately (default true). */
  autoStart: boolean;
  version: string;
  /** Sound output; omitted = createAudio(settings), null = no audio. */
  audio: AudioManager | null;
  /** Persists settings edited on the Settings screen; defaults to the save system's settings store. */
  persistSettings: (settings: Settings) => void | Promise<unknown>;
  /** Builds the game session for a setup; defaults to the real executors (session-defaults.ts). */
  createSession: (setup: GameSetup) => GameSession;
  /** Seed of the quick-game league (default 7). */
  leagueSeed: number;
  /** Persistence for franchise saves and settings (default: the browser save system). */
  saveSystem: SaveSystem;
  /** League simulator for franchise / season / playoff weeks (default: the real whole-game simulator). */
  leagueSimulator: GameSimulator;
}

export interface AppHandle {
  pixel: PixelCanvas;
  loop: GameLoop;
  stack: ScreenStack;
  camera: Camera;
  theme: Theme;
  services: ScreenServices;
  /** The input manager currently in use (swapped once the real one loads). */
  input(): InputManager;
  /** Resolves once the input factory has finished (with the real manager or the no-op fallback). */
  ready: Promise<InputManager>;
  stop(): void;
}

const EMPTY_ACTIONS: ReadonlySet<Action> = new Set<Action>();
const emptyState = (): InputState => ({ axis: vec2(0, 0), down: EMPTY_ACTIONS, justPressed: EMPTY_ACTIONS, justReleased: EMPTY_ACTIONS, pointer: null, lastDevice: 'keyboard' });
/** A scheme with no bindings for any action (a Proxy so no action list needs duplicating here). */
const emptyScheme = (): ControlScheme => new Proxy({} as ControlScheme, { get: () => [] as string[] });

/** Input manager that never reports input: the headless / pre-load fallback. */
export const createNullInput = (): InputManager => {
  let scheme = emptyScheme();
  let deviceMap: DeviceMap = { keyboard: {}, mouse: {}, gamepadDeadzone: 0.2 };
  let last = emptyState();
  return {
    update: () => undefined,
    consumeTick: () => {
      last = emptyState();
      return last;
    },
    state: () => last,
    setScheme: (s) => {
      scheme = s;
    },
    getScheme: () => scheme,
    setDeviceMap: (m) => {
      deviceMap = m;
    },
    getDeviceMap: () => deviceMap,
    isDown: () => false,
    justPressed: () => false,
    axis: () => vec2(0, 0),
    glyph: () => '?',
  };
};

/** Loads the browser input layer on demand so this module stays importable without a DOM. */
const browserInputFactory: AppDeps['input'] = async (canvas, settings, logical) => {
  const mod = await import('./input/index');
  const profile = mod.profileFromSettings(settings);
  const browser = mod.createBrowserInput(canvas, { profile, logical });
  return { manager: browser.manager, detach: browser.detach };
};

const defaultResizeTarget = (): AppDeps['resizeTarget'] => {
  const g = globalThis as { window?: Window };
  return g.window ?? null;
};

/** A mutable copy of frozen settings (DEFAULT_SETTINGS is frozen; the Settings screen edits in place). */
const mutableSettings = (base: Settings): Settings =>
  Object.isFrozen(base) ? { ...base, audio: { ...base.audio }, camera: { ...base.camera }, bindings: { ...base.bindings }, keyboardMap: { ...base.keyboardMap } } : base;

export const startApp = (canvas: HTMLCanvasElement, deps: Partial<AppDeps> = {}): AppHandle => {
  const settings = mutableSettings(deps.settings ?? DEFAULT_SETTINGS);
  const logicalW = deps.logicalW ?? 480;
  const logicalH = deps.logicalH ?? 270;
  // `?lores=1` turns the world layer off (the classic sprite renderer) for A/B comparison of the figure art.
  const lores = /(?:^|[?&])lores=1(?:&|$)/.test(browserLocationSearch() ?? '');
  const pixel = createPixelCanvas(canvas, logicalW, logicalH, { ...(lores ? { world: false } : {}), ...deps.canvasOptions });
  pixel.resize();
  const theme = createTheme(settings);
  const camera = new Camera(logicalW, logicalH);
  const sprites = new SpriteCache();
  const stack = new ScreenStack({ fadeSeconds: settings.reducedMotion ? 0 : 0.25 });
  const toast = createToast();
  let input: InputManager = createNullInput();
  let detachInput: (() => void) | undefined;
  let clock = 0;

  const audio = deps.audio === null ? undefined : deps.audio ?? createAudio(settings);
  const saves = deps.saveSystem ?? createSaveSystem();
  const persist = deps.persistSettings ?? ((s: Settings) => saves.saveSettings(s).catch((err: unknown) => console.warn('settings not saved', err)));
  // Accessibility preferences outside Settings: defaults until the stored record arrives.
  const access = defaultAccess();
  const accessStore = createAccessStore(saves.storage);
  void accessStore.load().then((p) => Object.assign(access, p)).catch(() => undefined);
  // Gameplay preferences (style, difficulty, rule switches): defaults until the stored record arrives.
  const gameplay = defaultGameplay();
  const gameplayStore = createGameplayStore(saves.storage);
  void gameplayStore.load().then((p) => Object.assign(gameplay, p)).catch(() => undefined);
  const captions = new CaptionTrack();
  audio?.onCaption((text) => { if (access.captions) captions.push(text); });
  const services: ScreenServices = {
    stack, settings, theme, camera, input, sprites, width: logicalW, height: logicalH, time: 0,
    toast: (message, seconds) => showToast(toast, message, seconds),
    audio,
    persistSettings: () => { void persist(settings); },
    access,
    persistAccess: () => { void accessStore.save(access).catch((err: unknown) => console.warn('accessibility options not saved', err)); },
    gameplay,
    persistGameplay: () => { void gameplayStore.save(gameplay).catch((err: unknown) => console.warn('gameplay options not saved', err)); },
  };
  stack.attach(services);
  const openSettings = (): void => stack.push(new SettingsScreen(settings, { persist }));
  // Tutorial progress lives next to the settings in the save system's storage; it drives the first-launch offer.
  const tutorialProgress = new TutorialProgressController(createTutorialStore(saves.storage), settings, persist);
  const defaultActions = createModeActions({
    services, settings, audio, saves, tutorialProgress, openSettings, toMenu: () => stack.popTo(menu), leagueSeed: deps.leagueSeed ?? 7,
    ...(deps.createSession ? { createSession: deps.createSession } : {}), ...(deps.leagueSimulator ? { leagueSimulator: deps.leagueSimulator } : {}),
  });
  const menu = new MainMenuScreen({ ...defaultActions, ...deps.actions }, { ...(deps.version ? { version: deps.version } : {}), tutorialOffer: tutorialProgress });
  stack.push(menu);

  const rc: RenderContext = { ctx: pixel.ctx, width: logicalW, height: logicalH, alpha: 0, theme, settings, camera, sprites, time: 0, world: null };
  const loopOpts = deps.loop ?? {};
  const baseSchedule = loopOpts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  // Developer mode: main-thread milliseconds per frame (input + ticks + render), shown top-left.
  const devSearch = browserLocationSearch();
  let frameStats: FrameStats | null = null;
  const syncFrameStats = (): FrameStats | null => {
    const on = isDevModeEnabled(settings, devSearch);
    if (on && !frameStats) setActiveFrameStats((frameStats = new FrameStats()));
    else if (!on && frameStats) setActiveFrameStats((frameStats = null));
    return frameStats;
  };
  const loop = new GameLoop(
    {
      tick: (dt) => {
        const state = input.consumeTick();
        services.time = clock;
        stack.update(dt, state);
        // Background music follows the screen stack (menu loop, game loop under play).
        audio?.updateMusic(dt, musicForScreens(stack.all.map((sc) => sc.id)));
        updateToast(toast, dt);
        captions.update(dt);
      },
      render: (alpha, frameDt) => {
        clock += frameDt;
        services.time = clock;
        rc.time = clock;
        rc.alpha = alpha;
        // The Settings screen may rebuild the theme (text size / colorblind mode); every frame reads the live one.
        rc.theme = services.theme;
        const ctx = pixel.ctx;
        // With a world layer the UI starts transparent and `present` puts the world layer (when a screen drew it) or
        // the theme background beneath it. Without one the UI surface is filled with the background.
        pixel.beginFrame();
        rc.world = pixel.world();
        if (!rc.world) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = rc.theme.colors.bg;
          ctx.fillRect(0, 0, logicalW, logicalH);
        }
        beginTouchFrame();
        stack.render(rc);
        endTouchFrame();
        if (access.captions) captions.draw(ctx, rc.theme, logicalW, logicalH);
        if (frameStats) drawText(ctx, `${frameStats.label()} ${rc.world?.used ? worldTimingLabel() : ''}`, 2, logicalH - 8, { color: rc.theme.colors.warning, size: 1, shadow: rc.theme.colors.shadow });
        drawToast(ctx, rc.theme, toast, logicalW, logicalH);
        pixel.present(rc.theme.colors.bg);
      },
    },
    {
      ...loopOpts,
      schedule: (cb) => baseSchedule(() => {
        const stats = syncFrameStats();
        const t0 = stats ? perfNow() : 0;
        input.update();
        cb();
        stats?.record(perfNow() - t0);
      }),
    },
  );

  const resizeTarget = deps.resizeTarget === undefined ? defaultResizeTarget() : deps.resizeTarget;
  const onResize = (): void => pixel.resize();
  resizeTarget?.addEventListener('resize', onResize);

  const factory = deps.input ?? browserInputFactory;
  const ready: Promise<InputManager> = Promise.resolve()
    .then(() => factory(canvas, settings, { width: logicalW, height: logicalH }))
    .then((handle) => {
      input = handle.manager;
      services.input = handle.manager;
      detachInput = handle.detach;
      return handle.manager;
    })
    .catch((err: unknown) => {
      console.warn('startApp: input layer unavailable, continuing without input', err);
      return input;
    });

  if (deps.autoStart !== false) loop.start();

  return {
    pixel, loop, stack, camera, theme, services, ready,
    input: () => input,
    stop: () => {
      loop.stop();
      resizeTarget?.removeEventListener('resize', onResize);
      detachInput?.();
      audio?.stop();
    },
  };
};
