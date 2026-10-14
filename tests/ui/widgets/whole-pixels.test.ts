/**
 * The UI draws on the one chunky 480x270 grid: every rectangle must land on whole art pixels (a fractional fillRect
 * is blended by the canvas into soft, half-pixel edges). Covers the draws a browser audit caught off the grid: the
 * title backdrop's perspective field / crowd / light beams, the score bug's timeout pips and the banner sweep; plus
 * the touch buttons' long labels, which must stay on screen.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createGameState } from '@/game/game-state';
import { drawBanner } from '@/ui/game/banners';
import { buildHudData, drawHud } from '@/ui/game/hud';
import { drawTouchOverlay } from '@/ui/game/touch-overlay';
import type { TouchLayout } from '@/ui/input/touch';
import { UI_SLAB, resolveTeamPalettes } from '@/ui/render/palette';
import { hasGlyph } from '@/ui/render/text';
import { createTheme } from '@/ui/theme';
import { drawTitleBackdrop } from '@/ui/widgets/title-backdrop';
import { makeSetup } from '../../game/fixtures';
import { createFakeCtx, type RecordedFill } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const offGrid = (fills: readonly RecordedFill[]): RecordedFill[] =>
  fills.filter((f) => ![f.x, f.y, f.w, f.h].every((v) => Number.isInteger(v)));

describe('UI fills land on whole pixels', () => {
  it('title backdrop (static layers, rolling field, flashbulbs and beams) at several moments', () => {
    for (const t of [0, 0.37, 1.9, 7.25]) {
      const ctx = createFakeCtx();
      drawTitleBackdrop(ctx, theme, 480, 270, t);
      expect(ctx.fills.length).toBeGreaterThan(200);
      expect(offGrid(ctx.fills)).toEqual([]);
    }
  });

  it('HUD score bug, timeout pips, situation, wind and result caption', () => {
    const setup = makeSetup();
    const palettes = resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, 'none');
    const state = createGameState(setup);
    state.timeouts = { home: 2, away: 3 };
    state.weather = { ...state.weather, windMph: 14 };
    for (const large of [false, true]) {
      const th = createTheme({ ...DEFAULT_SETTINGS, textSize: large ? 'large' : 'normal' });
      const ctx = createFakeCtx();
      drawHud(ctx, th, buildHudData(state, setup, { palettes, resultText: 'PASS +12', pbpLine: 'ATL: PASS COMPLETE FOR 12 YARDS.' }), 480, 270);
      expect(offGrid(ctx.fills)).toEqual([]);
    }
  });

  it('banner during its light sweep', () => {
    for (const remaining of [2.1, 1.95, 1.8, 1.7]) {
      const ctx = createFakeCtx();
      drawBanner(ctx, theme, { type: 'touchdown', text: 'TOUCHDOWN', sub: 'ATL · 7-0', tone: 'good', remaining, total: 2.2 } as Parameters<typeof drawBanner>[2], 480, 270);
      expect(offGrid(ctx.fills)).toEqual([]);
    }
  });
});

describe('touch button labels', () => {
  const layout = (x: number): TouchLayout => ({
    width: 480, height: 270,
    stick: { zone: { x: 0, y: 135, w: 240, h: 135 }, radius: 22, active: false, origin: null, knob: null },
    buttons: [{ button: 'b', label: 'B', x, y: 226, r: 11, pressed: false }],
  });

  it('a word wider than its disc is chipped in the small face and kept on screen', () => {
    const ctx = createFakeCtx();
    drawTouchOverlay(ctx, theme, layout(474), { b: 'SWITCH' });
    const chip = ctx.fillsWith(UI_SLAB.ink).filter((f) => f.y >= 215 && f.y <= 237);
    expect(chip.length).toBeGreaterThan(0);
    for (const f of chip) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(480);
    }
    expect(offGrid(chip)).toEqual([]);
  });

  it('a short label still sits on its disc in the Chunky font (no chip)', () => {
    const ctx = createFakeCtx();
    drawTouchOverlay(ctx, theme, layout(400), { b: 'OK' });
    expect(ctx.fillsWith(UI_SLAB.ink).filter((f) => f.y >= 215 && f.y <= 237 && f.x > 380)).toEqual([]);
    const ink = ctx.fillsWith(theme.colors.text).filter((f) => f.x > 380 && f.y >= 223 && f.y <= 229 && f.w <= 5);
    expect(ink.length).toBeGreaterThan(3);
    for (const f of ink) expect(Math.abs(f.x - 400)).toBeLessThanOrEqual(11);
  });
});

describe('font', () => {
  it('has the replay pause bars glyph', () => {
    expect(hasGlyph('▮')).toBe(true);
  });
});
