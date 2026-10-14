import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { MIDDLE_X } from '@/game/types';
import {
  AIM_ZOOM, CAMERA_ZOOM, Camera, CLOSE_MIN_ZOOM, CLOSE_ZOOM, KICK_ACROSS, KICK_MIN_ZOOM, LEAD_MAX_PX, leadYards, MAX_ZOOM_SPEED, tapRadiusFor, TAP_RADIUS_MIN,
  WIDE_FACTOR, type CameraFrameContext,
} from '@/ui/camera';
import { figureHeightLpx, tierForZoom } from '@/ui/render/world-layer';

const ctxFor = (o: Partial<CameraFrameContext> = {}): CameraFrameContext => ({ userSide: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 50), controlledPos: null, ...o });

describe('field scale (retro: one 480x270 grid, big chunky figures)', () => {
  it('CLOSE shows 40-50 yards across the 480-px screen with full-size ~24-26 px figures', () => {
    const across = 480 / CLOSE_ZOOM.standard;
    expect(across).toBeGreaterThan(40);
    expect(across).toBeLessThan(50);
    expect(CLOSE_ZOOM.standard).toBeGreaterThanOrEqual(10);
    expect(CLOSE_ZOOM.standard).toBeLessThanOrEqual(12);
    expect(480 / CLOSE_ZOOM.defensive).toBeLessThan(50);
    // the chosen retro look: the tallest figure is ~26 logical px at CLOSE (about 2.5 yd of field)
    const tall = figureHeightLpx(tierForZoom(CLOSE_ZOOM.standard));
    expect(tall).toBeGreaterThanOrEqual(22);
    expect(tall).toBeLessThanOrEqual(26);
    expect(tall / CLOSE_ZOOM.standard).toBeLessThan(2.6);
    // the pre-snap view never eases out below CLOSE_MIN_ZOOM, where figures are still full size
    expect(CLOSE_MIN_ZOOM).toBe(9);
    expect(tierForZoom(CLOSE_MIN_ZOOM)).toBe(1);
  });

  it('orders the presets and keeps the aim and kick views wide enough to see the play', () => {
    expect(AIM_ZOOM).toBeLessThan(CLOSE_ZOOM.standard);
    expect(CAMERA_ZOOM.standard).toBeLessThan(CLOSE_ZOOM.standard);
    expect(CAMERA_ZOOM.playerFollow).toBeGreaterThan(CAMERA_ZOOM.zoomed);
    const cam = new Camera(480, 270);
    cam.setMode('kick', ctxFor({ losY: 35, ballPos: vec2(MIDDLE_X, 35) }));
    expect(cam.zoom).toBeGreaterThanOrEqual(KICK_MIN_ZOOM);
    expect(cam.zoom).toBeLessThanOrEqual(CAMERA_ZOOM.kick);
    expect(cam.zoom).toBeLessThanOrEqual(270 / KICK_ACROSS + 1e-9);
    cam.setMode('simulation', ctxFor());
    expect(tierForZoom(cam.zoom)).toBe(4);
    // STANDARD and WIDE stay distinct and ordered under CLOSE
    expect(CAMERA_ZOOM.standard * WIDE_FACTOR).toBeLessThan(CAMERA_ZOOM.standard);
    expect(tierForZoom(CAMERA_ZOOM.standard)).toBe(1);
  });

  it('caps every lead on screen so the offense stays clear of the score bug at the higher zooms', () => {
    expect(leadYards(12, 5)).toBe(12);
    expect(leadYards(12, 11)).toBeCloseTo(LEAD_MAX_PX / 11);
    const cam = new Camera(480, 270);
    cam.preset = 'close';
    cam.setMode('standard', ctxFor());
    expect(cam.worldToScreen(vec2(MIDDLE_X, 50)).x).toBeCloseTo(240 - LEAD_MAX_PX, 5);
  });

  it('eases the zoom no faster than MAX_ZOOM_SPEED, and snaps with infinite smoothing', () => {
    const cam = new Camera(480, 270);
    cam.zoom = CLOSE_ZOOM.standard;
    cam.desiredZoom = AIM_ZOOM;
    cam.update(1 / 60, 50, 50);
    expect(CLOSE_ZOOM.standard - cam.zoom).toBeCloseTo(MAX_ZOOM_SPEED / 60, 6);
    cam.update(1 / 60, Infinity, Infinity);
    expect(cam.zoom).toBe(AIM_ZOOM);
  });

  it('grows the tap radius with the zoom (0.9 yd) but never below the minimum', () => {
    expect(tapRadiusFor(5)).toBe(TAP_RADIUS_MIN);
    expect(tapRadiusFor(CLOSE_ZOOM.standard)).toBe(TAP_RADIUS_MIN);
    expect(tapRadiusFor(16)).toBeCloseTo(14.4);
  });
});
