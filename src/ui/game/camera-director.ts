/**
 * Camera director: picks the CameraMode for the current context (offense / defense / kick / punt / watch /
 * replay) honouring the user's per-context overrides in Settings.camera, follows the ball or the controlled
 * athlete with smoothing, turns the horizontal view so the offense always attacks to the right (the Camera's
 * rotationFor), applies the Settings.cameraZoom preset (CLOSE: the dynamic close view, its zoom eased more gently than
 * the pan) and cycles modes on request. Pure logic over the Camera; no DOM.
 */
import type { CameraContext, CameraMode, Settings } from '@/core/settings';
import type { Vec2 } from '@/core/vec2';
import type { Direction, TeamSide } from '@/game/types';
import { Camera, type CameraFrameContext } from '../camera';

export { tapRadiusFor } from '../camera';

export type DirectorContext = CameraContext | 'replay';

/** Default mode per context. */
export const DEFAULT_MODES: Readonly<Record<DirectorContext, CameraMode>> = Object.freeze({
  offense: 'standard', defense: 'defensive', kick: 'kick', punt: 'kick', watch: 'simulation', replay: 'replay',
});

/** Modes the cycle action walks through, per context (the default first). */
export const CYCLE_MODES: Readonly<Record<DirectorContext, readonly CameraMode[]>> = Object.freeze({
  offense: ['standard', 'playerFollow', 'zoomed', 'defensive'],
  defense: ['defensive', 'standard', 'playerFollow', 'zoomed'],
  kick: ['kick', 'standard', 'playerFollow'],
  punt: ['kick', 'standard', 'playerFollow'],
  watch: ['simulation', 'standard', 'defensive', 'zoomed'],
  replay: ['replay', 'standard', 'zoomed', 'playerFollow'],
});

export interface DirectorFrame {
  context: DirectorContext;
  userSide: TeamSide | null;
  offense: TeamSide;
  direction: Direction;
  ballPos: Vec2;
  controlledPos: Vec2 | null;
  losY: number | null;
  kickLandingPos?: Vec2 | null;
  /** A kickoff or punt is being played (see CameraFrameContext.kickReturn). */
  kickReturn?: boolean;
  /** Replay only: free framing target. */
  replayTarget?: Vec2 | null;
}

/** Mode for a context after user overrides (replay never reads settings). */
export const modeForContext = (context: DirectorContext, settings: Pick<Settings, 'camera'>): CameraMode => {
  if (context === 'replay') return DEFAULT_MODES.replay;
  return settings.camera[context] ?? DEFAULT_MODES[context];
};

/** Next mode in the context's cycle after `current` (wraps; unknown modes restart the cycle). */
export const nextMode = (context: DirectorContext, current: CameraMode): CameraMode => {
  const list = CYCLE_MODES[context];
  const i = list.indexOf(current);
  return list[(i + 1) % list.length] as CameraMode;
};

export interface CameraDirector {
  readonly mode: CameraMode;
  readonly context: DirectorContext | null;
  /** Recomputes the framing for this tick; switches mode when the context changed or was cycled. */
  update(dt: number, frame: DirectorFrame): void;
  /** Cycles the mode for the current context; returns the new mode. */
  cycle(): CameraMode;
  /** Drops the per-context cycle overrides (e.g. after the settings screen changes a camera). */
  reset(): void;
  /**
   * Forgets the current framing: the next update re-applies this director's mode and snaps straight to it. Call
   * when another director (the replay viewer) has been driving the shared camera.
   */
  invalidate(): void;
}

/** Follow smoothing per mode (rate per second). */
export const SMOOTHING: Readonly<Record<CameraMode, number>> = Object.freeze({
  standard: 6, defensive: 5, playerFollow: 9, zoomed: 8, kick: 4, replay: 7, simulation: 3,
});

/** Zoom easing rate (per second) of the CLOSE preset's dynamic framing: gentler than the pan, so zooming never pops. */
export const CLOSE_ZOOM_SMOOTHING = 3.5;

export const createCameraDirector = (camera: Camera, settings: Pick<Settings, 'camera' | 'reducedMotion' | 'cameraZoom'>): CameraDirector => {
  let context: DirectorContext | null = null;
  const overrides = new Map<DirectorContext, CameraMode>();
  let mode: CameraMode = 'standard';
  let cycled = false;
  let stale = false;

  const frameCtx = (f: DirectorFrame): CameraFrameContext => ({
    userSide: f.userSide, offense: f.offense, direction: f.direction, ballPos: f.ballPos, controlledPos: f.controlledPos,
    losY: f.losY ?? undefined, kickLandingPos: f.kickLandingPos ?? null, kickReturn: f.kickReturn === true,
  });

  const update = (dt: number, f: DirectorFrame): void => {
    const wanted = overrides.get(f.context) ?? modeForContext(f.context, settings);
    // Someone else (a replay) may have switched the shared camera's mode behind this director's back.
    const changed = cycled || stale || f.context !== context || wanted !== mode || camera.mode !== wanted;
    const snap = stale;
    cycled = false;
    stale = false;
    context = f.context;
    mode = wanted;
    const fc = frameCtx(f);
    // Settings.cameraZoom (absent = the dynamic CLOSE default) is read every tick, so a change applies at once.
    camera.preset = settings.cameraZoom ?? 'close';
    if (changed) camera.setMode(mode, fc);
    else camera.track(fc);
    if (snap) camera.snap();
    if (mode === 'replay') {
      const target = f.replayTarget ?? f.ballPos;
      camera.setFree(target, camera.replayZoom());
    }
    // Reduced motion: no easing at all (the view cuts to each framing, as it always has).
    const rate = settings.reducedMotion ? Number.POSITIVE_INFINITY : SMOOTHING[mode];
    const dynamic = !settings.reducedMotion && camera.preset === 'close' && (mode === 'standard' || mode === 'defensive');
    camera.update(dt, rate, dynamic ? CLOSE_ZOOM_SMOOTHING : rate);
  };

  const cycle = (): CameraMode => {
    if (!context) return mode;
    const next = nextMode(context, mode);
    overrides.set(context, next);
    mode = next;
    cycled = true;
    return next;
  };

  return {
    get mode() { return mode; },
    get context() { return context; },
    update,
    cycle,
    reset: () => overrides.clear(),
    invalidate: () => { stale = true; },
  };
};
