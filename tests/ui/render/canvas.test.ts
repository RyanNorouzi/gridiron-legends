import { describe, expect, it } from 'vitest';
import { createPixelCanvas, integerScaleFor } from '@/ui/render/canvas';
import { createFakeCanvas, fakeSurfaceFactory } from './fake-ctx';

const setup = (viewport = { width: 1000, height: 600, dpr: 1 }) => {
  const fc = createFakeCanvas();
  const surface = fakeSurfaceFactory();
  const pixel = createPixelCanvas(fc.canvas, 480, 270, { createSurface: surface.create, viewport: () => viewport });
  return { ...fc, surface, pixel };
};

describe('integerScaleFor', () => {
  it('floors to the largest integer that fits and never drops below 1', () => {
    expect(integerScaleFor(480, 270, 1000, 600)).toBe(2);
    expect(integerScaleFor(480, 270, 1920, 1080)).toBe(4);
    expect(integerScaleFor(480, 270, 300, 200)).toBe(1);
    expect(integerScaleFor(480, 270, 1000, 600, 2)).toBe(4);
    expect(integerScaleFor(480, 270, 960, 300)).toBe(1);
  });
});

describe('createPixelCanvas', () => {
  it('validates the logical size', () => {
    const fc = createFakeCanvas();
    expect(() => createPixelCanvas(fc.canvas, 0, 270, { createSurface: fakeSurfaceFactory().create })).toThrow(/positive integers/);
    expect(() => createPixelCanvas(fc.canvas, 480.5, 270, { createSurface: fakeSurfaceFactory().create })).toThrow();
  });

  it('draws to a logical surface with smoothing disabled', () => {
    const s = setup();
    expect(s.pixel.ctx).toBe(s.surface.ctx);
    expect(s.surface.ctx.imageSmoothingEnabled).toBe(false);
    expect(s.pixel.logicalW).toBe(480);
    expect(s.pixel.logicalH).toBe(270);
  });

  it('resizes the visible canvas to an integer multiple keeping aspect', () => {
    const s = setup();
    s.pixel.resize();
    expect(s.pixel.scale).toBe(2);
    expect(s.canvas.width).toBe(960);
    expect(s.canvas.height).toBe(540);
    expect(s.canvas.style.width).toBe('960px');
    expect(s.canvas.style.height).toBe('540px');
    s.pixel.resize(300, 200);
    expect(s.pixel.scale).toBe(1);
    expect(s.canvas.width).toBe(480);
  });

  it('uses device pixels on HiDPI screens but sizes CSS in CSS pixels', () => {
    const s = setup({ width: 1000, height: 600, dpr: 2 });
    s.pixel.resize();
    expect(s.pixel.scale).toBe(4);
    expect(s.canvas.width).toBe(1920);
    expect(s.canvas.style.width).toBe('960px');
    expect(s.canvas.style.height).toBe('540px');
  });

  it('maps client coordinates into logical pixels via the bounding rect', () => {
    const s = setup();
    s.pixel.resize();
    s.rect.left = 20;
    s.rect.top = 10;
    s.rect.width = 960;
    s.rect.height = 540;
    expect(s.pixel.toLogical(20 + 480, 10 + 270)).toEqual({ x: 240, y: 135 });
    expect(s.pixel.toLogical(20, 10)).toEqual({ x: 0, y: 0 });
    expect(s.pixel.toLogical(20 + 959, 10 + 539)).toEqual({ x: 479, y: 269 });
    s.rect.width = 0;
    s.rect.height = 0;
    expect(s.pixel.toLogical(20 + 960, 10 + 540)).toEqual({ x: 480, y: 270 });
  });

  it('presents the surface scaled onto the visible canvas without smoothing', () => {
    const s = setup();
    s.pixel.resize();
    s.ctx.imageSmoothingEnabled = true;
    s.pixel.present();
    const draw = s.ctx.callsNamed('drawImage');
    expect(draw).toHaveLength(1);
    expect(draw[0]!.args.slice(1)).toEqual([0, 0, 480, 270, 0, 0, 960, 540]);
    expect(s.ctx.imageSmoothingEnabled).toBe(false);
  });
});
