import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { vec2 } from '@/core/vec2';
import { MIDDLE_X } from '@/game/types';
import { Camera, CAMERA_ZOOM, CLOSE_ZOOM, ROT_LEFT, ROT_RIGHT } from '@/ui/camera';
import { CYCLE_MODES, DEFAULT_MODES, createCameraDirector, modeForContext, nextMode, type DirectorFrame } from '@/ui/game/camera-director';

const frame = (over: Partial<DirectorFrame> = {}): DirectorFrame => ({
  context: 'offense', userSide: 'home', offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 40), controlledPos: vec2(MIDDLE_X, 38), losY: 40, ...over,
});

describe('camera modes by context', () => {
  it('uses the defaults unless the settings override a context', () => {
    expect(modeForContext('offense', DEFAULT_SETTINGS)).toBe('standard');
    expect(modeForContext('defense', DEFAULT_SETTINGS)).toBe('defensive');
    expect(modeForContext('kick', DEFAULT_SETTINGS)).toBe('kick');
    expect(modeForContext('punt', DEFAULT_SETTINGS)).toBe('kick');
    expect(modeForContext('watch', DEFAULT_SETTINGS)).toBe('simulation');
    expect(modeForContext('replay', { camera: { offense: 'zoomed' } })).toBe('replay');
    expect(modeForContext('offense', { camera: { offense: 'playerFollow' } })).toBe('playerFollow');
    for (const ctx of Object.keys(DEFAULT_MODES) as (keyof typeof DEFAULT_MODES)[]) expect(CYCLE_MODES[ctx][0]).toBe(DEFAULT_MODES[ctx]);
  });

  it('cycles through the context list and wraps', () => {
    expect(nextMode('offense', 'standard')).toBe('playerFollow');
    expect(nextMode('offense', 'defensive')).toBe('standard');
    expect(nextMode('kick', 'replay')).toBe('kick');
  });
});

describe('director', () => {
  it('sets the camera mode for the context, turns the view so the offense attacks right and follows the ball', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, DEFAULT_SETTINGS);
    d.update(1 / 60, frame());
    expect(d.mode).toBe('standard');
    expect(cam.mode).toBe('standard');
    // The default zoom preset is the dynamic CLOSE view (camera-zoom.test.ts covers STANDARD and WIDE).
    expect(cam.zoom).toBe(CLOSE_ZOOM.standard);
    expect(cam.rotation).toBe(ROT_RIGHT);
    expect(cam.target.y).toBeGreaterThan(40);
    // horizontal field: the offense always attacks to the right, whoever has the ball
    d.update(1 / 60, frame({ context: 'defense', offense: 'away', direction: -1 }));
    expect(d.mode).toBe('defensive');
    expect(cam.rotation).toBe(ROT_LEFT);
    d.update(1 / 60, frame({ context: 'offense', offense: 'home', direction: -1 }));
    expect(cam.rotation).toBe(ROT_LEFT);
    d.update(1 / 60, frame({ context: 'kick', offense: 'home', direction: 1 }));
    expect(d.mode).toBe('kick');
    expect(cam.zoom).toBeLessThan(CAMERA_ZOOM.standard);
    d.update(1 / 60, frame({ context: 'watch', userSide: null }));
    expect(d.mode).toBe('simulation');
    expect(cam.rotation).toBe(ROT_RIGHT);
  });

  it('honours settings overrides, cycles per context and forgets cycles on reset', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, { camera: { defense: 'zoomed' }, reducedMotion: true });
    d.update(1 / 60, frame({ context: 'defense', offense: 'away' }));
    expect(d.mode).toBe('zoomed');
    expect(d.cycle()).toBe('defensive');
    d.update(1 / 60, frame({ context: 'defense', offense: 'away' }));
    expect(cam.mode).toBe('defensive');
    d.update(1 / 60, frame({ context: 'offense' }));
    expect(cam.mode).toBe('standard');
    d.update(1 / 60, frame({ context: 'defense', offense: 'away' }));
    expect(cam.mode).toBe('defensive');
    d.reset();
    d.update(1 / 60, frame({ context: 'defense', offense: 'away' }));
    expect(cam.mode).toBe('zoomed');
  });

  it('follows smoothly over time and snaps under reduced motion', () => {
    const smooth = new Camera(480, 270);
    const ds = createCameraDirector(smooth, DEFAULT_SETTINGS);
    ds.update(1 / 60, frame({ context: 'offense', ballPos: vec2(MIDDLE_X, 40) }));
    ds.update(1 / 60, frame({ context: 'offense', ballPos: vec2(MIDDLE_X, 70) }));
    expect(smooth.target.y).toBeLessThan(smooth.desiredTarget.y);
    const snappy = new Camera(480, 270);
    const dr = createCameraDirector(snappy, { camera: {}, reducedMotion: true });
    dr.update(1 / 60, frame({ context: 'offense', ballPos: vec2(MIDDLE_X, 40) }));
    dr.update(1 / 60, frame({ context: 'offense', ballPos: vec2(MIDDLE_X, 70) }));
    expect(snappy.target.y).toBeCloseTo(snappy.desiredTarget.y);
  });

  it('replay context frees the camera on the ball', () => {
    const cam = new Camera(480, 270);
    const d = createCameraDirector(cam, DEFAULT_SETTINGS);
    d.update(1 / 60, frame({ context: 'replay', ballPos: vec2(10, 90), replayTarget: vec2(10, 90) }));
    expect(d.mode).toBe('replay');
    expect(cam.desiredTarget).toEqual(vec2(10, 90));
  });
});

describe('director after a replay drove the shared camera', () => {
  it('re-frames the live play at once instead of staying where the replay left the camera', () => {
    const cam = new Camera(480, 270);
    const game = createCameraDirector(cam, DEFAULT_SETTINGS);
    const live = frame({ ballPos: vec2(MIDDLE_X, 12), losY: 12 });
    game.update(1 / 60, live);
    const framedY = cam.target.y;
    // The replay viewer runs its own director on the same camera and pans far downfield.
    const replay = createCameraDirector(cam, DEFAULT_SETTINGS);
    for (let i = 0; i < 240; i++) replay.update(1 / 60, frame({ context: 'replay', ballPos: vec2(MIDDLE_X, 90), replayTarget: vec2(MIDDLE_X, 90) }));
    expect(Math.abs(cam.target.y - framedY)).toBeGreaterThan(20);
    // Without invalidate the mode mismatch alone must still hand the camera back.
    game.update(1 / 60, live);
    expect(cam.mode).toBe('standard');
    for (let i = 0; i < 240; i++) replay.update(1 / 60, frame({ context: 'replay', ballPos: vec2(MIDDLE_X, 90), replayTarget: vec2(MIDDLE_X, 90) }));
    game.invalidate();
    game.update(1 / 60, live);
    expect(cam.target.y).toBeCloseTo(framedY, 5);
  });
});
