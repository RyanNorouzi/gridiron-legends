import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { Camera, CLOSE_MIN_ZOOM } from '@/ui/camera';
import { arrowTip, drawEdgeArrow, drawEdgePointer, EDGE_ARROW, EDGE_PAD, offEdge, pinBox, type ScreenEdge } from '@/ui/game/edge-marker';
import { drawPlayState } from '@/ui/game/field-view';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx, type FakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const options = (over: Partial<Parameters<typeof drawPlayState>[5]> = {}): Parameters<typeof drawPlayState>[5] => ({
  theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home', ...over,
});

/** The retro close view at its pre-snap floor, centred across the field on the ball. */
const closeOn = (x: number, y: number): Camera => {
  const c = new Camera(480, 270);
  c.target.x = x;
  c.target.y = y;
  c.zoom = CLOSE_MIN_ZOOM;
  return c;
};

/** Filled rows (h = 1) of `color` fully inside the 480x270 view. */
const rowsOf = (ctx: FakeCtx, color: string): { x: number; y: number; w: number }[] =>
  ctx.fillsWith(color).filter((f) => f.h === 1 && f.x >= 0 && f.y >= 0 && f.x + f.w <= 480 && f.y < 270).map((f) => ({ x: f.x, y: f.y, w: f.w }));

/**
 * Edge arrows of `color` (outlined in the theme shadow) fully on screen: a 1-px tip, then 3 and 5 px across on the
 * next lines (or columns), over a 9-px shadow base.
 */
const arrowsOf = (ctx: FakeCtx, color: string): { x: number; y: number }[] => {
  const col = ctx.fillsWith(color);
  const sh = ctx.fillsWith(theme.colors.shadow);
  const has = (list: typeof col, x: number, y: number, w: number, h: number): boolean => list.some((f) => f.x === x && f.y === y && f.w === w && f.h === h);
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < 480 && y < 270;
  return col.filter((t) => t.w === 1 && t.h === 1 && on(t.x, t.y) && [1, -1].some((d) =>
    (has(col, t.x - 1, t.y + d, 3, 1) && has(col, t.x - 2, t.y + 2 * d, 5, 1) && has(sh, t.x - 4, t.y + 2 * d, 9, 1)) ||
    (has(col, t.x + d, t.y - 1, 1, 3) && has(col, t.x + 2 * d, t.y - 2, 1, 5) && has(sh, t.x + 2 * d, t.y - 4, 1, 9)))).map((t) => ({ x: t.x, y: t.y }));
};

describe('edge markers (pure layout)', () => {
  it('tells which edge an athlete is beyond, allowing cut-off feet at the bottom', () => {
    expect(offEdge(240, 135, 110, 480, 270)).toBeNull();
    expect(offEdge(240, 274, 248, 480, 270)).toBeNull();
    expect(offEdge(240, 290, 264, 480, 270)).toBe('bottom');
    expect(offEdge(240, 20, -6, 480, 270)).toBe('top');
    expect(offEdge(-3, 135, 110, 480, 270)).toBe('left');
    expect(offEdge(490, 135, 110, 480, 270)).toBe('right');
  });

  it('pins a box inside the view with room for the arrow on its edge side', () => {
    const room = EDGE_ARROW + EDGE_PAD;
    expect(pinBox(100, 80, 8, 10, 480, 270, null)).toEqual({ x: 100, y: 80 });
    expect(pinBox(100, 400, 8, 10, 480, 270, 'bottom')).toEqual({ x: 100, y: 270 - 10 - room });
    expect(pinBox(100, -50, 8, 10, 480, 270, 'top')).toEqual({ x: 100, y: room });
    expect(pinBox(-40, 80, 8, 10, 480, 270, 'left')).toEqual({ x: room, y: 80 });
    expect(pinBox(600, 80, 8, 10, 480, 270, 'right')).toEqual({ x: 480 - 8 - room, y: 80 });
  });

  it('draws a chunky outlined arrow whose tip points at the edge, and keeps every pixel on screen', () => {
    const ctx = createFakeCtx();
    drawEdgeArrow(ctx, 'bottom', 100, 50, '#ff0000', '#000000');
    const red = rowsOf(ctx, '#ff0000').sort((a, b) => b.y - a.y);
    expect(red.map((r) => [r.y, r.w])).toEqual([[49, 1], [48, 3], [47, 5]]);
    expect(rowsOf(ctx, '#000000').map((r) => r.w).sort((a, b) => a - b)).toEqual([3, 5, 7, 9]);
    for (const edge of ['top', 'bottom', 'left', 'right'] as ScreenEdge[]) {
      const c = createFakeCtx();
      drawEdgePointer(c, edge, edge === 'left' ? -80 : 900, edge === 'top' ? -80 : 900, 480, 270, '#ff0000', '#000000');
      expect(c.fills.length).toBe(7);
      for (const f of c.fills) {
        expect(f.x).toBeGreaterThanOrEqual(0);
        expect(f.y).toBeGreaterThanOrEqual(0);
        expect(f.x + f.w).toBeLessThanOrEqual(480);
        expect(f.y + f.h).toBeLessThanOrEqual(270);
      }
    }
    const box = { x: 100, y: 200 };
    expect(arrowTip('bottom', box, 8, 10)).toEqual({ x: 104, y: 210 + EDGE_ARROW - 1 });
    expect(arrowTip('top', box, 8, 10)).toEqual({ x: 104, y: 200 - EDGE_ARROW });
  });
});

describe('edge markers in the field view', () => {
  it('pins the glyph of a receiver split off the close view to the edge with an arrow at him', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const wr = f.byRole('offense', 'WR3');
    const cam = closeOn(f.state.ball.pos.x, f.state.losY);
    const opts = options({ receiverSlots: ['WR3'], receiverGlyphs: ['A'] });
    // the glyphs show while the user's QB holds the ball
    const qb = f.byRole('offense', 'QB');
    f.state.phase = 'live';
    qb.hasBall = true;
    f.state.ball.carrierId = qb.id;
    f.state.ball.phase = 'held';
    wr.pos.x = f.state.ball.pos.x;
    const inView = createFakeCtx();
    drawPlayState(inView, cam, f.state, null, 0, opts);
    expect(arrowsOf(inView, theme.colors.accent)).toHaveLength(0);
    for (const x of [1, 52]) {
      wr.pos.x = x;
      const ctx = createFakeCtx();
      drawPlayState(ctx, cam, f.state, null, 0, opts);
      const glyphBox = ctx.fillsWith(theme.colors.shadow).find((q) => q.h === 8 * theme.textScale + 2);
      expect(glyphBox, `x ${x}`).toBeDefined();
      expect(glyphBox!.y).toBeGreaterThanOrEqual(0);
      expect(glyphBox!.y + glyphBox!.h).toBeLessThanOrEqual(270);
      expect(arrowsOf(ctx, theme.colors.accent), `x ${x}`).toHaveLength(1);
    }
  });

  it('points at the athlete the user controls whenever he is out of view (any position)', () => {
    const f = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    f.state.phase = 'live';
    const me = f.byRole('defense', 'FS');
    const cam = closeOn(f.state.ball.pos.x, f.state.losY);
    me.pos.x = f.state.ball.pos.x;
    me.pos.y = f.state.losY + 5;
    const seen = createFakeCtx();
    drawPlayState(seen, cam, f.state, null, 0, options({ userSide: 'away' }));
    expect(arrowsOf(seen, theme.colors.accent)).toHaveLength(0);
    for (const [x, dy] of [[1, 5], [52, 5], [f.state.ball.pos.x, 40]] as const) {
      me.pos.x = x;
      me.pos.y = f.state.losY + dy;
      const ctx = createFakeCtx();
      drawPlayState(ctx, cam, f.state, null, 0, options({ userSide: 'away' }));
      expect(arrowsOf(ctx, theme.colors.accent), `${x} ${dy}`).toHaveLength(1);
    }
  });
});
