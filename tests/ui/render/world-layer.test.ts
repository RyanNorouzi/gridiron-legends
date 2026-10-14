import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { AIM_ZOOM, Camera, CAMERA_ZOOM, CLOSE_MIN_ZOOM, CLOSE_ZOOM, KICK_MIN_ZOOM } from '@/ui/camera';
import type { WorldLayer } from '@/ui/render/canvas';
import {
  artLine, claimWorld, FIGURE_HEIGHT_ART, figureHeightLpx, hashStr, lightingFor, recordWorldTiming, TIER_MIN_ZOOM, TIER_SCALE, tierForZoom, toArt, torsoLiftLpx, WD,
  withLogical, WORLD_TIMING, worldTimingLabel,
} from '@/ui/render/world-layer';
import { createFakeCtx } from './fake-ctx';

const layer = (): WorldLayer & { ctx: ReturnType<typeof createFakeCtx> } => ({ ctx: createFakeCtx(), width: 480, height: 270, used: false });

describe('world layer coordinates', () => {
  it('projects world points to whole art pixels at WD per logical pixel', () => {
    const cam = new Camera(480, 270);
    cam.zoom = CLOSE_ZOOM.standard;
    cam.target.x = 20.3;
    cam.target.y = 40.7;
    for (const p of [vec2(20.3, 40.7), vec2(21.17, 43.05), vec2(3, 60)]) {
      const a = toArt(cam, p);
      const s = cam.worldToScreen(p);
      expect(Number.isInteger(a.x) && Number.isInteger(a.y)).toBe(true);
      expect(Math.abs(a.x - s.x * WD)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(a.y - s.y * WD)).toBeLessThanOrEqual(0.5);
    }
    // field lines are placed from the origin, never accumulated
    expect(artLine(100, 5, 11)).toBe(155);
    expect(artLine(100, 5, 11, -1)).toBe(45);
  });

  it('draws world and UI on one chunky grid: one art pixel per logical pixel', () => {
    expect(WD).toBe(1);
    expect(TIER_SCALE).toEqual({ 1: 1, 2: 0.86, 3: 0.7, 4: 0.55 });
    expect(TIER_MIN_ZOOM).toEqual([8.5, 5.5, 4.2]);
    expect(FIGURE_HEIGHT_ART).toBe(26);
    // the retro camera presets land on the intended tiers: CLOSE and STANDARD full size, AIM / kicks tier 2
    expect(tierForZoom(CLOSE_ZOOM.standard)).toBe(1);
    expect(tierForZoom(CLOSE_MIN_ZOOM)).toBe(1);
    expect(tierForZoom(CAMERA_ZOOM.standard)).toBe(1);
    expect(tierForZoom(AIM_ZOOM)).toBe(2);
    expect(tierForZoom(CAMERA_ZOOM.kick)).toBe(2);
    expect(tierForZoom(KICK_MIN_ZOOM)).toBe(2);
  });

  it('steps figure size down in four tiers as the view zooms out, with hysteresis at the boundaries', () => {
    expect(tierForZoom(11)).toBe(1);
    expect(tierForZoom(7)).toBe(2);
    expect(tierForZoom(4.5)).toBe(3);
    expect(tierForZoom(3)).toBe(4);
    // hovering just under a boundary keeps the previous (bigger) tier until past the band
    expect(tierForZoom(8.4, 1)).toBe(1);
    expect(tierForZoom(8.2, 1)).toBe(2);
    expect(tierForZoom(8.6, 2)).toBe(2);
    expect(tierForZoom(8.8, 2)).toBe(1);
    expect(tierForZoom(4.1, 3)).toBe(3);
    expect(tierForZoom(3.9, 3)).toBe(4);
    // big jumps change at once
    expect(tierForZoom(11, 4)).toBe(1);
    expect(tierForZoom(3, 1)).toBe(4);
    // a zoom sweep switches tiers exactly once per boundary each way
    let tier = tierForZoom(11);
    let changes = 0;
    for (let z = 11; z >= 3; z -= 0.01) {
      const t = tierForZoom(z + Math.sin(z * 50) * 0.1, tier);
      if (t !== tier) changes++;
      tier = t;
    }
    expect(changes).toBe(3);
  });

  it('sizes figures in logical pixels per tier (tallest 26 lpx at CLOSE) for tap targets and prompts', () => {
    expect(figureHeightLpx(1)).toBe(26);
    expect(figureHeightLpx(4)).toBeCloseTo(26 * TIER_SCALE[4]);
    expect(torsoLiftLpx(1)).toBeCloseTo(14.3);
  });

  it('claims the layer once per frame: identity transform, background fill, used flag', () => {
    const l = layer();
    claimWorld(l, '#123456');
    claimWorld(l, '#123456');
    expect(l.used).toBe(true);
    expect(l.ctx.fillsWith('#123456')).toHaveLength(1);
    expect(l.ctx.fillsWith('#123456')[0]).toMatchObject({ x: 0, y: 0, w: 480, h: 270 });
    expect(l.ctx.callsNamed('setTransform')[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('runs logical-pixel painters under the WD transform (identity on the 1x grid) and restores identity', () => {
    const l = layer();
    let inside = false;
    withLogical(l.ctx, () => {
      inside = true;
    });
    expect(inside).toBe(true);
    const t = l.ctx.callsNamed('setTransform').map((c) => c.args);
    expect(t).toEqual([[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0]]);
  });

  it('picks lighting deterministically from the roof, the weather and the game', () => {
    expect(lightingFor('dome', 'rain', 'g1')).toBe('indoor');
    expect(lightingFor('open', 'snow', 'g1')).toBe('overcast');
    const modes = new Set(Array.from({ length: 64 }, (_, i) => lightingFor('open', 'clear', `game${i}`)));
    expect(modes).toEqual(new Set(['day', 'night']));
    expect(lightingFor('open', 'clear', 'game7')).toBe(lightingFor('open', 'clear', 'game7'));
    expect(hashStr('abc')).toBe(hashStr('abc'));
    expect(hashStr('abc')).not.toBe(hashStr('abd'));
  });

  it('keeps a world draw timing ring and a cached readout label', () => {
    WORLD_TIMING.reset();
    for (let i = 0; i < 40; i++) recordWorldTiming(1 + (i % 2));
    const label = worldTimingLabel();
    expect(label).toMatch(/^WORLD \d+\.\dms P95 \d+\.\d/);
    expect(WORLD_TIMING.summary().frames).toBe(40);
  });
});
