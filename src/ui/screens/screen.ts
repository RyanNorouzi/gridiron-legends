/**
 * Screen contract for the UI stack. A screen owns its own widgets and state; the stack delivers input to the
 * topmost screen only and renders the topmost opaque screen plus every overlay above it.
 */
import type { AudioManager } from '@/audio/index';
import type { GameplayPrefs } from '../gameplay-prefs';
import type { AccessPrefs } from '../accessibility';
import type { Settings } from '@/core/settings';
import type { Camera } from '../camera';
import type { InputManager, InputState } from '../input/types';
import type { WorldLayer } from '../render/canvas';
import type { SpriteCache } from '../render/sprites';
import type { Theme } from '../theme';
import type { ScreenStack } from './stack';

/** Shared services handed to screens on enter/update. Mutable fields are refreshed by the app each frame. */
export interface ScreenServices {
  stack: ScreenStack;
  settings: Settings;
  theme: Theme;
  camera: Camera;
  input: InputManager;
  sprites: SpriteCache;
  /** Logical canvas size. */
  width: number;
  height: number;
  /** Seconds since boot (frame clock). */
  time: number;
  /** Shows a transient message above every screen. */
  toast(message: string, seconds?: number): void;
  /** Sound output (menu sounds, game events); absent in headless tests. */
  audio?: AudioManager;
  /**
   * Persists `settings` through the save system (the same store the Settings screen writes). Screens that change
   * a setting outside the Settings screen (the Defense option of the game-day card, Quick Game, Custom Game) call
   * it so the choice survives a reload. Absent in headless tests unless a test installs a spy.
   */
  persistSettings?(): void;
  /** Accessibility preferences outside Settings (captions, sprint toggle); absent = defaults (all off). */
  access?: AccessPrefs;
  /** Persists `access` (the Settings screen calls it after a change). */
  persistAccess?(): void;
  /** Gameplay preferences outside Settings (play style, difficulty + tuning, quarter length, rule switches) that
   *  new game setups start from; absent = defaults. */
  gameplay?: GameplayPrefs;
  /** Persists `gameplay` (the Settings screen calls it after a change). */
  persistGameplay?(): void;
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Interpolation factor between the last two ticks (0..1). */
  alpha: number;
  theme: Theme;
  settings: Settings;
  camera: Camera;
  sprites: SpriteCache;
  /** Seconds since boot (frame clock). */
  time: number;
  /**
   * The world layer under `ctx` (same 480x270 art grid), or null / absent on the classic path (tests, `?lores=1`). The
   * field view draws the ground, stadium and figures there (world-layer.ts `claimWorld`); everything else stays on `ctx`.
   */
  world?: WorldLayer | null;
}

export interface Screen {
  readonly id: string;
  /** Overlays render on top of the screen beneath them (pause menu, dialogs). */
  overlay?: boolean;
  enter(services: ScreenServices): void;
  exit(services: ScreenServices): void;
  /** Called when a screen above this one is popped. */
  resume?(services: ScreenServices): void;
  /** Called when another screen is pushed above this one. */
  pause?(services: ScreenServices): void;
  update(dt: number, input: InputState, services: ScreenServices): void;
  render(rc: RenderContext): void;
}
