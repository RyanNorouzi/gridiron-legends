import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { vec2, type Vec2 } from '@/core/vec2';
import { FIELD_LENGTH, MIDDLE_X } from '@/game/types';
import { AIM_ZOOM, CAMERA_ZOOM, CLOSE_MIN_ZOOM, CLOSE_ZOOM, Camera, ROT_LEFT, ROT_RIGHT, WIDE_FACTOR, type CameraFocus, type CameraFrameContext } from '@/ui/camera';
import { createCameraDirector, type DirectorFrame } from '@/ui/game/camera-director';

const ctxFor = (over: Partial<CameraFrameContext> = {}): CameraFrameContext => ({
  userSide: 'home', offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 40), controlledPos: vec2(MIDDLE_X, 38), losY: 40, ...over,
});
const frame = (over: Partial<DirectorFrame> = {}): DirectorFrame => ({
  context: 'offense', userSide: 'home', offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 40), controlledPos: vec2(MIDDLE_X, 38), losY: 40, ...over,
});
const focus = (over: Partial<CameraFocus> = {}): CameraFocus => ({ presnap: false, spreadX: null, aimSpot: null, ...over });

const closeCam = (): Camera => {
  const cam = new Camera(480, 270);
  cam.preset = 'close';
  return cam;
};

/** Frames `ctx` in `mode` and snaps straight to it. */
const frameNow = (cam: Camera, mode: 'standard' | 'defensive', ctx: CameraFrameContext): void => {
  cam.setMode(mode, ctx);
  cam.snap();
};

/** On screen with `px` pixels to spare at every edge. */
const onScreen = (cam: Camera, p: Vec2, px = 0): boolean => {
  const s = cam.worldToScreen(p);
  return s.x >= px && s.x <= cam.width - px && s.y >= px && s.y <= cam.height - px;
};

describe('camera zoom presets', () => {
  it('STANDARD keeps the fixed framing, WIDE scales it, CLOSE sits in close on the play', () => {
    const std = new Camera(480, 270);
    std.setMode('standard', ctxFor());
    expect(std.zoom).toBe(CAMERA_ZOOM.standard);
    const wide = new Camera(480, 270);
    wide.preset = 'wide';
    wide.setMode('standard', ctxFor());
    expect(wide.zoom).toBeCloseTo(CAMERA_ZOOM.standard * WIDE_FACTOR);
    wide.setMode('defensive', ctxFor());
    expect(wide.zoom).toBeCloseTo(CAMERA_ZOOM.defensive * WIDE_FACTOR);
    const close = closeCam();
    close.setMode('standard', ctxFor());
    expect(close.zoom).toBe(CLOSE_ZOOM.standard);
    close.setMode('defensive', ctxFor());
    expect(close.zoom).toBe(CLOSE_ZOOM.defensive);
    expect(new Camera().replayZoom()).toBe(CAMERA_ZOOM.replay);
    expect(close.replayZoom()).toBe(CLOSE_ZOOM.replay);
    expect(wide.replayZoom()).toBeCloseTo(CAMERA_ZOOM.replay * WIDE_FACTOR);
  });

  it('CLOSE follows the ball along and across and keeps the ball on screen near either sideline', () => {
    const cam = closeCam();
    for (const dir of [1, -1] as const) {
      for (const ball of [vec2(3, 30), vec2(50, 70), vec2(MIDDLE_X, 55), vec2(10, 95)]) {
        frameNow(cam, 'standard', ctxFor({ direction: dir, ballPos: ball, losY: ball.y }));
        expect(cam.rotation).toBe(dir === 1 ? ROT_RIGHT : ROT_LEFT);
        expect(onScreen(cam, ball, 20)).toBe(true);
        // The view leads the ball toward the end zone being attacked (the ball sits left of centre).
        expect(cam.worldToScreen(ball).x).toBeLessThan(cam.width / 2);
      }
    }
  });

  it('CLOSE eases out for the pre-snap read only when the formation is too wide to show, never below 9 px/yd', () => {
    const cam = closeCam();
    cam.focus = focus({ presnap: true, spreadX: { min: 20, max: 33 } });
    cam.setMode('standard', ctxFor());
    expect(cam.zoom).toBe(CLOSE_ZOOM.standard);
    cam.focus = focus({ presnap: true, spreadX: { min: 16, max: 37 } });
    frameNow(cam, 'standard', ctxFor());
    expect(cam.zoom).toBeLessThan(CLOSE_ZOOM.standard);
    expect(cam.zoom).toBeGreaterThan(CLOSE_MIN_ZOOM);
    expect(onScreen(cam, vec2(16, 40))).toBe(true);
    expect(onScreen(cam, vec2(37, 40))).toBe(true);
    // A sideline-to-sideline spread stops at the floor: the wide splits go off the edge (the field view pins an
    // edge arrow to them) rather than shrinking the figures.
    cam.focus = focus({ presnap: true, spreadX: { min: 4, max: 49 } });
    frameNow(cam, 'standard', ctxFor());
    expect(cam.zoom).toBe(CLOSE_MIN_ZOOM);
    expect(onScreen(cam, vec2(MIDDLE_X, 40))).toBe(true);
    // After the snap the spread no longer counts: back in close.
    cam.focus = focus({ presnap: false, spreadX: null });
    cam.track(ctxFor());
    expect(cam.desiredZoom).toBe(CLOSE_ZOOM.standard);
  });

  it('CLOSE eases out to the aim zoom while a pull-back throw is aimed and keeps the spot on screen', () => {
    const cam = closeCam();
    const qb = vec2(20, 33);
    for (const spot of [vec2(5, 85), vec2(48, 90), vec2(26, 45), vec2(50, 60)]) {
      cam.focus = focus({ aimSpot: spot });
      frameNow(cam, 'standard', ctxFor({ ballPos: qb }));
      expect(cam.zoom).toBeLessThanOrEqual(AIM_ZOOM);
      expect(onScreen(cam, spot, 8)).toBe(true);
      expect(onScreen(cam, qb, 8)).toBe(true);
    }
  });

  it('CLOSE fits a deep ball in the air and its target, then closes back in once the ball is caught', () => {
    const cam = closeCam();
    cam.focus = focus();
    const target = vec2(12, 95);
    cam.setMode('standard', ctxFor({ ballPos: vec2(26, 33), kickLandingPos: target }));
    expect(cam.zoom).toBeLessThanOrEqual(AIM_ZOOM);
    expect(onScreen(cam, target, 8)).toBe(true);
    expect(onScreen(cam, vec2(26, 33), 8)).toBe(true);
    // Ease back in continuously as the ball closes on the target: the zoom only grows along the flight.
    let prev = 0;
    for (let y = 33; y <= 95; y += 0.5) {
      cam.track(ctxFor({ ballPos: vec2(26 + (12 - 26) * ((y - 33) / 62), y), kickLandingPos: target }));
      expect(cam.desiredZoom).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(cam.desiredZoom - prev < 0.1 || prev === 0).toBe(true);
      prev = cam.desiredZoom;
    }
    expect(prev).toBe(CLOSE_ZOOM.standard);
    // A short pass fits at the close zoom already.
    cam.track(ctxFor({ ballPos: vec2(26, 33), kickLandingPos: vec2(22, 42) }));
    expect(cam.desiredZoom).toBe(CLOSE_ZOOM.standard);
    // Caught: no target any more.
    cam.track(ctxFor({ ballPos: target, kickLandingPos: null }));
    expect(cam.desiredZoom).toBe(CLOSE_ZOOM.standard);
  });

  it('CLOSE keeps the athlete the user moves pre-snap in view (a practice / tutorial receiver), not just the passer', () => {
    const cam = closeCam();
    const qb = vec2(MIDDLE_X, 40);
    const me = vec2(3, 44);
    cam.focus = focus({ presnap: true, spreadX: { min: 3, max: MIDDLE_X } });
    frameNow(cam, 'standard', ctxFor({ ballPos: qb, controlledPos: me }));
    expect(cam.zoom).toBeGreaterThanOrEqual(CLOSE_MIN_ZOOM);
    expect(onScreen(cam, me, 8)).toBe(true);
    // after the snap the ball leads again (the controlled QB is the ball in a real game)
    cam.focus = focus();
    frameNow(cam, 'standard', ctxFor({ ballPos: qb, controlledPos: qb }));
    expect(onScreen(cam, qb, 20)).toBe(true);
  });

  it('CLOSE defensive view keeps the defender the user controls in view as far as the zoom floor allows', () => {
    const cam = closeCam();
    cam.focus = focus();
    const near = vec2(22, 45);
    cam.setMode('defensive', ctxFor({ ballPos: vec2(40, 35), controlledPos: near }));
    expect(onScreen(cam, near, 4)).toBe(true);
    expect(onScreen(cam, vec2(40, 35), 4)).toBe(true);
    // a defender across the field: the view stops at CLOSE_MIN_ZOOM (the field view points an edge arrow at him)
    frameNow(cam, 'defensive', ctxFor({ ballPos: vec2(40, 35), controlledPos: vec2(4, 62) }));
    expect(cam.zoom).toBeGreaterThanOrEqual(CLOSE_MIN_ZOOM);
    expect(onScreen(cam, vec2(40, 35), 4)).toBe(true);
  });

  it('never leaves the field plus its apron and stands, even framing an end zone', () => {
    const cam = closeCam();
    cam.focus = focus();
    for (const y of [0, 3, FIELD_LENGTH - 2, FIELD_LENGTH]) {
      frameNow(cam, 'standard', ctxFor({ ballPos: vec2(MIDDLE_X, y), losY: y }));
      const t = cam.clampTarget(cam.desiredTarget, cam.desiredZoom);
      expect(cam.desiredTarget.x).toBeCloseTo(t.x, 9);
      expect(cam.desiredTarget.y).toBeCloseTo(t.y, 9);
    }
  });
});

describe('projection stays exact at every zoom the presets use', () => {
  it('worldToScreen and screenToWorld are exact inverses mid-transition', () => {
    const cam = closeCam();
    cam.focus = focus();
    cam.setMode('standard', ctxFor());
    cam.focus = focus({ aimSpot: vec2(6, 90) });
    for (let i = 0; i < 40; i++) {
      cam.track(ctxFor());
      cam.update(1 / 60, 6, 3.5);
      for (const p of [vec2(0, 0), vec2(53.3, 120), vec2(12.25, 47.5)]) {
        const back = cam.screenToWorld(cam.worldToScreen(p));
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });
});

describe('director zoom transitions', () => {
  it('reads Settings.cameraZoom every tick; absent means CLOSE', () => {
    const cam = new Camera(480, 270);
    const settings: { camera: Record<string, never>; reducedMotion: boolean; cameraZoom?: 'close' | 'standard' | 'wide' } = { camera: {}, reducedMotion: true };
    const d = createCameraDirector(cam, settings);
    d.update(1 / 60, frame());
    expect(cam.preset).toBe('close');
    expect(cam.zoom).toBe(CLOSE_ZOOM.standard);
    settings.cameraZoom = 'standard';
    d.update(1 / 60, frame());
    expect(cam.zoom).toBe(CAMERA_ZOOM.standard);
    settings.cameraZoom = 'wide';
    d.update(1 / 60, frame());
    expect(cam.zoom).toBeCloseTo(CAMERA_ZOOM.standard * WIDE_FACTOR);
    expect(DEFAULT_SETTINGS.cameraZoom).toBe('close');
  });

  it('eases the zoom out and back in smoothly: monotonic, no overshoot, no jumps', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, DEFAULT_SETTINGS);
    cam.focus = focus();
    d.update(1 / 60, frame());
    expect(cam.zoom).toBe(CLOSE_ZOOM.standard);
    cam.focus = focus({ aimSpot: vec2(8, 92) });
    let prev = cam.zoom;
    for (let i = 0; i < 120; i++) {
      d.update(1 / 60, frame());
      expect(cam.zoom).toBeLessThanOrEqual(prev + 1e-12);
      expect(prev - cam.zoom).toBeLessThan(0.15);
      expect(cam.zoom).toBeGreaterThanOrEqual(cam.desiredZoom - 1e-9);
      prev = cam.zoom;
    }
    expect(cam.zoom).toBeCloseTo(cam.desiredZoom, 1);
    cam.focus = focus();
    for (let i = 0; i < 120; i++) {
      d.update(1 / 60, frame());
      expect(cam.zoom).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(cam.zoom - prev).toBeLessThan(0.15);
      prev = cam.zoom;
    }
    expect(cam.zoom).toBeCloseTo(CLOSE_ZOOM.standard, 1);
  });

  it('cuts straight to each framing under reduced motion', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, { camera: {}, reducedMotion: true });
    cam.focus = focus();
    d.update(1 / 60, frame());
    cam.focus = focus({ aimSpot: vec2(8, 92) });
    d.update(1 / 60, frame());
    expect(cam.zoom).toBe(cam.desiredZoom);
    expect(cam.zoom).toBeLessThanOrEqual(AIM_ZOOM);
  });

  it('replays follow at the preset replay zoom and the live view re-frames after', () => {
    const cam = new Camera(480, 270);
    const live = createCameraDirector(cam, DEFAULT_SETTINGS);
    live.update(1 / 60, frame());
    const replay = createCameraDirector(cam, DEFAULT_SETTINGS);
    for (let i = 0; i < 240; i++) replay.update(1 / 60, frame({ context: 'replay', replayTarget: vec2(MIDDLE_X, 80) }));
    expect(cam.zoom).toBeCloseTo(CLOSE_ZOOM.replay, 3);
    live.invalidate();
    live.update(1 / 60, frame());
    expect(cam.zoom).toBe(CLOSE_ZOOM.standard);
  });

  it('keeps the kick and watch framings wide whatever the preset', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, DEFAULT_SETTINGS);
    d.update(1 / 60, frame({ context: 'kick' }));
    expect(cam.zoom).toBeLessThanOrEqual(CAMERA_ZOOM.standard);
    d.update(1 / 60, frame({ context: 'watch', userSide: null }));
    expect(cam.zoom).toBeLessThan(CAMERA_ZOOM.standard);
  });
});

