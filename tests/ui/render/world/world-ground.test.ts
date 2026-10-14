import { describe, expect, it } from 'vitest';
import { Camera, CLOSE_ZOOM } from '@/ui/camera';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, HASH_LEFT, HASH_RIGHT } from '@/game/types';
import { WD } from '@/ui/render/world-layer';
import { apronRects, GROUND_TILE, groundColors, groundCover, paintGroundTile, tileNoise, tileSize, wearPatches, wearSpans } from '@/ui/render/world/ground';
import { lineArtX, paintAlpha, yardLinePx, zoomBand } from '@/ui/render/world/field-paint';
import { glyphOf, GLYPH_ROWS, paintStencil, rotatePx } from '@/ui/render/world/stencil';
import { alphaAt, artRect } from '@/ui/render/world/art';
import { EMBLEM_YD, paintEmblem } from '@/ui/render/world/emblem';

const cam = (y: number, zoom: number = CLOSE_ZOOM.standard): Camera => {
  const c = new Camera(480, 270);
  c.target.x = FIELD_WIDTH / 2;
  c.target.y = y;
  c.zoom = zoom;
  return c;
};

describe('world ground (art bible §10.1)', () => {
  it('paints opaque 64 px grass / turf tiles, a seamless 48 px hatch and see-through snow', () => {
    for (const kind of ['grassLight', 'grassDark', 'turfLight', 'apron', 'wear'] as const) {
      const px = paintGroundTile(kind, '#3e8e3b');
      expect(px.w).toBe(GROUND_TILE);
      for (let i = 3; i < px.data.length; i += 4) expect(px.data[i]).toBe(255);
    }
    const hatch = paintGroundTile('hatch', '#c02020');
    expect(hatch.w).toBe(tileSize('hatch'));
    expect(hatch.w % 6).toBe(0);
    const snow = paintGroundTile('snow', '#edf2f7');
    let holes = 0;
    for (let i = 3; i < snow.data.length; i += 4) if (snow.data[i] === 0) holes++;
    expect(holes).toBeGreaterThan(0);
    expect(holes).toBeLessThan(GROUND_TILE * GROUND_TILE * 0.2);
  });

  it('tiles its noise (the grain never shows a seam at the tile edge)', () => {
    for (let y = 0; y < 64; y += 7) expect(tileNoise(0, y, 64, 4, 3)).toBeCloseTo(tileNoise(64, y, 64, 4, 3), 9);
  });

  it('keeps the mowing bands apart, the apron darker and rain darker still', () => {
    const g = groundColors('grass', null);
    expect(g.light).not.toBe(g.dark);
    expect(g.turf).toBe(false);
    expect(groundColors('turf', null).turf).toBe(true);
    const wet = groundColors('grass', { type: 'rain', windDir: 0, windMph: 0, temperatureF: 50, precipitation: 0.5, visibility: 1, fieldSlick: 0.2 });
    expect(wet.light).not.toBe(g.light);
    expect(groundCover({ type: 'snow', windDir: 0, windMph: 0, temperatureF: 20, precipitation: 1, visibility: 1, fieldSlick: 0 }).snow).toBeLessThanOrEqual(0.45);
    expect(groundCover(null)).toEqual({ snow: 0, wet: 0 });
  });

  it('wears the middle between the hashes from 40 to 40 and in front of both posts', () => {
    const w = wearPatches();
    const middle = w.filter((p) => p.y >= 49 && p.y <= 71);
    expect(middle.length).toBeGreaterThanOrEqual(8);
    for (const p of middle) expect(p.x).toBeGreaterThan(HASH_LEFT - 2);
    for (const p of middle) expect(p.x).toBeLessThan(HASH_RIGHT + 2);
    expect(w.some((p) => p.y < END_ZONE_DEPTH + 6)).toBe(true);
    expect(w.some((p) => p.y > FIELD_LENGTH - END_ZONE_DEPTH - 6)).toBe(true);
    const spans = wearSpans(cam(60), w[0] as (typeof w)[number]);
    expect(spans.length).toBeGreaterThan(4);
    for (let i = 1; i < spans.length; i++) expect((spans[i]?.y ?? 0) - (spans[i - 1]?.y ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('field paint (art bible §10.2)', () => {
  it('puts 5-yd lines 5 x zoom art px apart at CLOSE (each projected once and rounded), 3 px thick (2 px zoomed out)', () => {
    const c = cam(60);
    expect(Math.abs(lineArtX(c, 65) - lineArtX(c, 60) - 5 * CLOSE_ZOOM.standard * WD)).toBeLessThanOrEqual(0.5);
    expect(Number.isInteger(lineArtX(c, 65))).toBe(true);
    expect(yardLinePx(CLOSE_ZOOM.standard)).toBe(3);
    expect(yardLinePx(6)).toBe(2);
    expect(zoomBand(10.8)).toBe(11);
    expect(paintAlpha(null)).toBe(1);
    expect(paintAlpha({ type: 'rain', windDir: 0, windMph: 0, temperatureF: 50, precipitation: 1, visibility: 1, fieldSlick: 0 })).toBeCloseTo(0.85);
  });

  it('rasterises stencil numerals at the asked height with chamfered corners, and turns them', () => {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const g = glyphOf(ch);
      expect(g).toHaveLength(GLYPH_ROWS);
      for (const row of g) expect(row.length).toBe(g[0]?.length);
    }
    const px = paintStencil({ text: '40', height: 44, color: '#ffffff' });
    expect(px.h).toBe(44);
    expect(alphaAt(px, 0, 0)).toBe(0);
    expect(alphaAt(px, 2, 22)).toBe(255);
    const turned = rotatePx(px, 1);
    expect(turned.w).toBe(px.h);
    expect(turned.h).toBe(px.w);
    const outlined = paintStencil({ text: 'ATL', height: 21, color: '#ffffff', outline: '#000000', shadow: '#000000' });
    expect(outlined.h).toBeGreaterThan(21);
  });

  it('paints the midfield emblem as a disc 8 yd across', () => {
    const d = Math.round(EMBLEM_YD * CLOSE_ZOOM.standard * WD);
    const px = paintEmblem({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffcc00', abbr: 'HOM' }, d);
    expect(px.w).toBe(d);
    expect(alphaAt(px, 0, 0)).toBe(0);
    expect(alphaAt(px, Math.round(d / 2), Math.round(d / 2))).toBe(255);
  });

  it('fills the apron only around the field: the screen minus the field, no gaps and no overlap', () => {
    const area = (rs: { w: number; h: number }[]): number => rs.reduce((a, r) => a + r.w * r.h, 0);
    for (const [y, zoom] of [[60, CLOSE_ZOOM.standard], [60, 3.7], [4, 11], [118, 6], [60, 1.5]] as const) {
      const c = cam(y, zoom);
      const f = artRect(c, 0, 0, FIELD_WIDTH, FIELD_LENGTH, WD);
      const rs = apronRects(f, 960, 540);
      const fx0 = Math.max(0, f.x);
      const fx1 = Math.min(960, f.x + f.w);
      const fy0 = Math.max(0, f.y);
      const fy1 = Math.min(540, f.y + f.h);
      const fieldOnScreen = Math.max(0, fx1 - fx0) * Math.max(0, fy1 - fy0);
      expect(area(rs) + fieldOnScreen).toBe(960 * 540);
      for (const r of rs) {
        // no apron rect reaches into the field
        const ix = Math.max(0, Math.min(r.x + r.w, fx1) - Math.max(r.x, fx0));
        const iy = Math.max(0, Math.min(r.y + r.h, fy1) - Math.max(r.y, fy0));
        expect(ix * iy).toBe(0);
      }
    }
    // a field entirely off screen: the whole screen is apron
    expect(apronRects({ x: 2000, y: 0, w: 10, h: 10 }, 960, 540)).toEqual([{ x: 0, y: 0, w: 960, h: 540 }]);
  });
});
