import { describe, expect, it } from 'vitest';
import type { PaintedFrame } from '@/ui/render/anim';
import { drawAtlasFrame, SpriteAtlas } from '@/ui/render/atlas';
import { createFakeCtx } from './fake-ctx';

const frame = (w = 4, h = 6): PaintedFrame => ({ width: w, height: h, ax: 2, ay: 5, rgba: new Uint8ClampedArray(w * h * 4) });

/** A clock the test advances: each paint costs `cost` ms. */
const clocked = (cost: number): { now: () => number; paint: () => PaintedFrame; count: () => number } => {
  let t = 0;
  let n = 0;
  return { now: () => t, paint: () => { t += cost; n++; return frame(); }, count: () => n };
};

describe('sprite atlas', () => {
  it('paints a frame once and serves it from the cache after', () => {
    const c = clocked(0.1);
    const atlas = new SpriteAtlas({ now: c.now });
    atlas.beginFrame();
    const a = atlas.get('k1', c.paint);
    const b = atlas.get('k1', c.paint);
    expect(a).toBe(b);
    expect(c.count()).toBe(1);
    expect(atlas.stats).toMatchObject({ hits: 1, misses: 1, painted: 1, size: 1 });
    // Node: no DOM, so the frame keeps its pixels and has no surface
    expect(a?.image).toBeNull();
    expect(a?.rgba?.length).toBe(4 * 6 * 4);
  });

  it('evicts the least recently used frame past its cap', () => {
    const c = clocked(0);
    const atlas = new SpriteAtlas({ maxEntries: 3, now: c.now });
    for (const k of ['a', 'b', 'c']) atlas.get(k, c.paint);
    atlas.get('a', c.paint);
    atlas.get('d', c.paint);
    expect(atlas.has('a')).toBe(true);
    expect(atlas.has('b')).toBe(false);
    expect(atlas.size).toBe(3);
    expect(atlas.stats.evicted).toBe(1);
  });

  it('defers misses past the frame paint budget (queued), unless forced', () => {
    const c = clocked(1);
    const atlas = new SpriteAtlas({ frameBudgetMs: 1.5, now: c.now });
    atlas.beginFrame();
    expect(atlas.get('a', c.paint)).not.toBeNull();
    expect(atlas.get('b', c.paint)).not.toBeNull();
    expect(atlas.get('c', c.paint)).toBeNull();
    expect(atlas.stats.deferred).toBe(1);
    expect(atlas.pending).toBe(1);
    expect(atlas.get('d', c.paint, true)).not.toBeNull();
    atlas.beginFrame();
    expect(atlas.get('c', c.paint)).not.toBeNull();
  });

  it('prerenders queued jobs in time slices, skipping cached and duplicate keys', () => {
    const c = clocked(1);
    const atlas = new SpriteAtlas({ now: c.now });
    atlas.get('x', c.paint, true);
    atlas.prerender(['x', 'p1', 'p2', 'p2', 'p3', 'p4'].map((key) => ({ key, paint: c.paint })));
    expect(atlas.pending).toBe(4);
    expect(atlas.pump(2)).toBe(2);
    expect(atlas.pending).toBe(2);
    atlas.pump(100);
    expect(atlas.pending).toBe(0);
    expect(['p1', 'p2', 'p3', 'p4'].every((k) => atlas.has(k))).toBe(true);
  });

  it('draws a frame with its anchor on the given art pixel', () => {
    const atlas = new SpriteAtlas({ createSurface: () => ({ getContext: () => createFakeCtx() }) });
    const f = atlas.get('k', () => ({ width: 8, height: 10, ax: 4, ay: 9, draw: () => undefined }), true)!;
    expect(f.image).not.toBeNull();
    const ctx = createFakeCtx();
    drawAtlasFrame(ctx, f, 100.4, 50);
    expect(ctx.callsNamed('drawImage')[0]!.args.slice(1)).toEqual([96, 41]);
  });
});
