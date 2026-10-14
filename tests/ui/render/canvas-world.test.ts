import { describe, expect, it } from 'vitest';
import { createPixelCanvas } from '@/ui/render/canvas';
import { createFakeCanvas, createFakeCtx, type FakeCtx } from './fake-ctx';

/** Surface factory handing each surface its own recording context. */
const surfaces = (): { create: (w: number, h: number) => { width: number; height: number; getContext: () => FakeCtx }; made: { w: number; h: number; ctx: FakeCtx }[] } => {
  const made: { w: number; h: number; ctx: FakeCtx }[] = [];
  return {
    made,
    create: (w, h) => {
      const ctx = createFakeCtx();
      made.push({ w, h, ctx });
      return { width: w, height: h, getContext: () => ctx };
    },
  };
};

const setup = (viewport: { width: number; height: number; dpr: number }) => {
  const fc = createFakeCanvas();
  const s = surfaces();
  const pixel = createPixelCanvas(fc.canvas, 480, 270, { createSurface: s.create, viewport: () => viewport, world: true });
  pixel.resize();
  return { ...fc, s, pixel };
};

describe('pixel canvas with a world layer (one 480x270 grid for world and UI)', () => {
  it('gives the UI a 1x surface with no transform and creates a 1x world layer lazily', () => {
    const t = setup({ width: 960, height: 540, dpr: 1 });
    expect(t.pixel.hasWorld).toBe(true);
    expect(t.s.made[0]).toMatchObject({ w: 480, h: 270 });
    expect(t.s.made[0]!.ctx.callsNamed('setTransform')).toHaveLength(0);
    expect(t.s.made).toHaveLength(1);
    const w = t.pixel.world();
    expect(w).not.toBeNull();
    expect(w).toMatchObject({ width: 480, height: 270, used: false });
    expect(t.pixel.world()).toBe(w);
    expect(t.s.made).toHaveLength(2);
    // no backing surface anywhere is larger than the logical grid
    expect(t.s.made.every((m) => m.w === 480 && m.h === 270)).toBe(true);
  });

  it('clears the UI to transparent each frame at the identity transform', () => {
    const t = setup({ width: 960, height: 540, dpr: 1 });
    const ui = t.s.made[0]!.ctx;
    ui.reset();
    t.pixel.beginFrame();
    expect(ui.callsNamed('setTransform')[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(ui.callsNamed('clearRect')[0]?.args).toEqual([0, 0, 480, 270]);
  });

  it('composites the world under the UI only in frames that used it, else the background, nearest-neighbour', () => {
    const t = setup({ width: 960, height: 540, dpr: 1 });
    const w = t.pixel.world()!;
    t.pixel.present('#101010');
    expect(t.ctx.fillsWith('#101010')).toHaveLength(1);
    expect(t.ctx.callsNamed('drawImage')).toHaveLength(1);
    t.ctx.reset();
    w.used = true;
    t.pixel.present('#101010');
    const draws = t.ctx.callsNamed('drawImage');
    expect(draws).toHaveLength(2);
    expect(draws[0]!.args.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 960, 540]);
    expect(draws[1]!.args.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 960, 540]);
    expect(t.ctx.fillsWith('#101010')).toHaveLength(0);
    expect(t.ctx.imageSmoothingEnabled).toBe(false);
    expect(w.used).toBe(false);
  });

  it('blits straight to the visible canvas at every integer scale (no intermediate surface)', () => {
    const t = setup({ width: 1440, height: 810, dpr: 1 });
    expect(t.pixel.scale).toBe(3);
    t.pixel.world()!.used = true;
    t.pixel.present('#000');
    expect(t.s.made).toHaveLength(2);
    const vis = t.ctx.callsNamed('drawImage');
    expect(vis).toHaveLength(2);
    expect(vis[1]!.args.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 1440, 810]);
    expect(t.ctx.imageSmoothingEnabled).toBe(false);
  });

  it('keeps pointer mapping in logical pixels', () => {
    const t = setup({ width: 960, height: 540, dpr: 1 });
    t.rect.width = 960;
    t.rect.height = 540;
    expect(t.pixel.toLogical(480, 270)).toEqual({ x: 240, y: 135 });
  });

  it('has no world layer with an injected surface factory (tests) or world: false (?lores=1)', () => {
    for (const opts of [{}, { world: false }]) {
      const fc = createFakeCanvas();
      const s = surfaces();
      const pixel = createPixelCanvas(fc.canvas, 480, 270, { createSurface: s.create, viewport: () => ({ width: 960, height: 540, dpr: 1 }), ...opts });
      pixel.resize();
      expect(pixel.hasWorld).toBe(false);
      expect(pixel.world()).toBeNull();
      pixel.beginFrame();
      expect(s.made[0]!.ctx.callsNamed('clearRect')).toHaveLength(0);
      pixel.present('#000');
      expect(fc.ctx.callsNamed('drawImage')[0]!.args.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 960, 540]);
      expect(fc.ctx.fills).toHaveLength(0);
    }
  });
});
