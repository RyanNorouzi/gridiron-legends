import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { Camera } from '@/ui/camera';
import { sceneFromPlay, type FieldViewOptions } from '@/ui/game/field-view';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { buildRimMask, OverlapRims, paintRimRuns, RIM_INK, rimMaskOf } from '@/ui/render/world-layer-rim';
import { drawWorldScene, sortBackToFront, type SortedObject } from '@/ui/render/world-layer-scene';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx, type FakeCtx } from './fake-ctx';

/** A w x h frame with an opaque w-2 x h-2 block inside a transparent border, anchored at its bottom centre. */
const block = (w: number, h: number): { width: number; height: number; ax: number; ay: number; rgba: Uint8ClampedArray } => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) rgba[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, ax: Math.floor(w / 2), ay: h - 1, rgba };
};

describe('overlap rims', () => {
  it('rings a silhouette with the pixels just outside it (4-way), never inside', () => {
    const m = buildRimMask(block(6, 6));
    expect(m).not.toBeNull();
    if (!m) return;
    const solid = new Set<string>();
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) if (m.solid[y * 6 + x]) solid.add(`${x},${y}`);
    expect(solid.size).toBe(16);
    const ring: string[] = [];
    for (let i = 0; i < m.ring.length; i += 2) ring.push(`${m.ring[i]},${m.ring[i + 1]}`);
    // a 4x4 block's 4-way ring: 4 sides of 4 pixels, no corners
    expect(ring).toHaveLength(16);
    for (const k of ring) {
      expect(solid.has(k)).toBe(false);
      const [x, y] = k.split(',').map(Number) as [number, number];
      expect([`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`].some((n) => solid.has(n))).toBe(true);
    }
    // cached per frame object; no RGBA buffer, no mask
    const f = block(4, 4);
    expect(rimMaskOf(f)).toBe(rimMaskOf(f));
    expect(buildRimMask({ width: 4, height: 4, ax: 0, ay: 0 })).toBeNull();
  });

  it('draws a rim only where a figure overlaps one drawn before it, merged into runs, and never on the grass', () => {
    const rims = new OverlapRims(40, 30);
    const m = buildRimMask(block(8, 8)) as NonNullable<ReturnType<typeof buildRimMask>>;
    // the first figure has nothing under it
    expect(rims.rimRuns(m, 10, 10)).toEqual([]);
    rims.cover(m, 10, 10);
    // the next one, 3 px lower and 2 px right: its ring crosses the first body
    const runs = rims.rimRuns(m, 12, 13);
    expect(runs.length).toBeGreaterThan(0);
    for (let i = 0; i < runs.length; i += 3) {
      for (let k = 0; k < (runs[i + 2] as number); k++) expect(rims.covered((runs[i] as number) + k, runs[i + 1] as number)).toBe(true);
    }
    // the top edge of the lower figure is one horizontal run
    expect(runs.some((_, i) => i % 3 === 2 && (runs[i] as number) >= 4)).toBe(true);
    // one far away touches nothing
    expect(rims.rimRuns(m, 34, 28)).toEqual([]);
    rims.reset();
    expect(rims.rimRuns(m, 12, 13)).toEqual([]);
    const ctx = createFakeCtx();
    paintRimRuns(ctx, [3, 4, 5]);
    expect(ctx.fillsWith(RIM_INK)).toEqual([{ x: 3, y: 4, w: 5, h: 1, color: RIM_INK, alpha: 1 }]);
  });
});

describe('back-to-front order', () => {
  it('sorts strictly by feet y, then left to right, then by insertion (the same scene always draws the same way)', () => {
    const log: string[] = [];
    const o = (id: string, y: number, x?: number): SortedObject => ({ y, ...(x === undefined ? {} : { x }), draw: () => { log.push(id); } });
    const list = [o('c', 5, 3), o('a', 2), o('d', 5, 3), o('b', 5, -1), o('e', 9, 0)];
    sortBackToFront(list);
    for (const q of list) q.draw();
    expect(log).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('overlap rims on the world layer', () => {
  const theme = createTheme(DEFAULT_SETTINGS);
  const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
  const options: FieldViewOptions = { theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home' };
  const draw = (zoom: number): FakeCtx => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = new Camera(480, 270);
    cam.target.x = 26.65;
    cam.target.y = f.state.losY;
    cam.zoom = zoom;
    const layer: WorldLayer & { ctx: FakeCtx } = { ctx: createFakeCtx(), width: 480, height: 270, used: false };
    drawWorldScene(layer, cam, sceneFromPlay(f.state, null, 0), options, new Map());
    return layer.ctx;
  };

  it('separates the stacked linemen at the pre-snap zoom, and leaves the small whole-field figures alone', () => {
    const close = draw(9).fillsWith(RIM_INK);
    expect(close.length).toBeGreaterThan(10);
    for (const r of close) expect(r.h).toBe(1);
    expect(draw(3.8).fillsWith(RIM_INK)).toHaveLength(0);
  });
});
