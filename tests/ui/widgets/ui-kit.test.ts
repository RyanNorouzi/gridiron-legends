import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { BANNER_SLAM_FRAMES, bannerCellSize, drawBanner } from '@/ui/game/banners';
import { drawTeamLogo, teamLogo } from '@/ui/render/logo';
import { UI_SLAB } from '@/ui/render/palette';
import { createTheme } from '@/ui/theme';
import { drawSlabButton, drawVersusBadge } from '@/ui/widgets/headers';
import { drawPanel } from '@/ui/widgets/panel';
import { drawScreenBackdrop, drawTitleBackdrop } from '@/ui/widgets/title-backdrop';
import { artEllipse, artLine, drawKeycap, drawSlab, drawTab } from '@/ui/widgets/ui-art';
import { createFakeCtx, type FakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const inside = (ctx: FakeCtx, x: number, y: number, w: number, h: number): boolean =>
  ctx.fills.every((f) => f.x >= x - 0.01 && f.y >= y - 0.01 && f.x + f.w <= x + w + 0.01 && f.y + f.h <= y + h + 0.01);

describe('slab primitives', () => {
  it('draws a slab with a 1-px bevel and shadow inside its rect (whole pixels only)', () => {
    const ctx = createFakeCtx();
    drawSlab(ctx, 10, 20, 50, 30, { fill: '#123456', outline: '#000001', texture: false });
    expect(inside(ctx, 10, 20, 50, 30)).toBe(true);
    const bevel = ctx.fillsWith(UI_SLAB.bevel);
    expect(bevel).toHaveLength(1);
    expect(bevel[0]).toMatchObject({ y: 21, h: 1 });
    expect(ctx.fillsWith(UI_SLAB.edge)[0]).toMatchObject({ y: 48, h: 1 });
    expect(ctx.fillsWith('#000001')).toHaveLength(4);
    for (const f of ctx.fills) expect([f.x, f.y, f.w, f.h].every(Number.isInteger)).toBe(true);
  });

  it('cuts tab edges row by row and keeps keycaps inside their box', () => {
    const ctx = createFakeCtx();
    drawTab(ctx, 0, 0, 20, 10, '#884422', { cut: 4 });
    const rows = ctx.fillsWith('#884422');
    expect(rows).toHaveLength(10);
    expect(rows[0]!.w).toBe(16);
    expect(rows[9]!.w).toBe(20);
    const key = createFakeCtx();
    drawKeycap(key, 5, 5, 20, 11, '#335577');
    expect(inside(key, 5, 5, 20, 11)).toBe(true);
  });

  it('draws pixel-grid lines and ellipses', () => {
    const ctx = createFakeCtx();
    artLine(ctx, 0, 0, 10, 5, '#ff0000');
    const px = ctx.fillsWith('#ff0000');
    expect(px).toHaveLength(11);
    expect(px[0]).toMatchObject({ x: 0, y: 0, w: 1 });
    expect(px[px.length - 1]).toMatchObject({ x: 10, y: 5 });
    const e = createFakeCtx();
    artEllipse(e, 50, 50, 6, 3, '#00ff00', true);
    expect(inside(e, 44, 47, 13, 7)).toBe(true);
  });
});

describe('title backdrop', () => {
  it('stays on screen and freezes under reduced motion', () => {
    const ctx = createFakeCtx();
    drawScreenBackdrop(ctx, theme, 480, 270, 3.3);
    expect(ctx.fills.length).toBeGreaterThan(300);
    expect(inside(ctx, 0, 0, 480.5, 270.5)).toBe(true);
    const still = createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true });
    const a = createFakeCtx();
    const b = createFakeCtx();
    drawTitleBackdrop(a, still, 480, 270, 1);
    drawTitleBackdrop(b, still, 480, 270, 9);
    expect(b.fills).toEqual(a.fills);
    const moving = createFakeCtx();
    drawTitleBackdrop(moving, theme, 480, 270, 9);
    expect(moving.fills).not.toEqual(a.fills);
  });
});

describe('panels, buttons and badges', () => {
  it('keeps the panel content rect of the old look and draws inside the panel (plus a 1-px drop shadow)', () => {
    const ctx = createFakeCtx();
    const r = drawPanel(ctx, theme, 20, 30, 200, 100, { title: 'TEAM', style: 'raised' });
    expect(r).toEqual({ x: 20 + theme.border + theme.pad, y: 30 + 7 + theme.gap * 2, w: 200 - 2 * (theme.border + theme.pad), h: 30 + 100 - theme.border - theme.gap - (30 + 7 + theme.gap * 2) });
    expect(inside(ctx, 20, 30, 201, 101)).toBe(true);
    expect(ctx.fillsWith(theme.colors.accent).length).toBeGreaterThan(0);
  });

  it('draws slab buttons (selection colour when selected) and the VS badge', () => {
    const on = createFakeCtx();
    const rect = drawSlabButton(on, theme, 'PLAY AGAIN', 100, 50, true);
    expect(on.fillsWith(theme.colors.selection)).toHaveLength(1);
    expect(rect.w).toBeGreaterThan(40);
    const off = createFakeCtx();
    drawSlabButton(off, theme, 'MENU', 100, 50, false);
    expect(off.fillsWith(theme.colors.selection)).toHaveLength(0);
    const vs = createFakeCtx();
    drawVersusBadge(vs, theme, 240, 60);
    expect(vs.fillsWith(theme.colors.accent).length).toBeGreaterThan(5);
  });
});

describe('team emblems on the chunky grid', () => {
  it('paint one emblem pixel per logical pixel in whole-pixel runs inside the square', () => {
    const colors = { primary: '#1a3fb0', secondary: '#f2f2f2', accent: '#ffcc33', helmet: '#0d2260' };
    const ctx = createFakeCtx();
    drawTeamLogo(ctx, 5, colors, 12, 100, 50);
    expect(inside(ctx, 100, 50, 12, 12)).toBe(true);
    expect(ctx.fills.every((f) => f.h === 1)).toBe(true);
    const buf = teamLogo(5, colors, 12);
    let opaque = 0;
    for (let i = 3; i < buf.data.length; i += 4) if (buf.data[i] === 255) opaque++;
    expect(ctx.fills.reduce((a, f) => a + f.w, 0)).toBe(opaque);
  });
});

describe('banner slam-in', () => {
  const banner = (elapsed: number) => ({ text: 'SACK', sub: '-7 YDS', tone: 'bad' as const, remaining: 2.2 - elapsed, total: 2.2 });
  const width = (ctx: FakeCtx): number => Math.max(...ctx.fills.filter((f) => f.color === theme.colors.shadow).map((f) => f.w));

  it('grows the band over its first frames and draws the headline in the display text', () => {
    const early = createFakeCtx();
    drawBanner(early, theme, banner(1 / 60), 480, 270);
    const late = createFakeCtx();
    drawBanner(late, theme, banner((BANNER_SLAM_FRAMES + 1) / 60), 480, 270);
    expect(width(early)).toBeLessThan(width(late));
    expect(late.fillsWith(theme.colors.danger).length).toBeGreaterThan(2);
    expect(bannerCellSize(late, 'SACK', 480, theme)).toBe(3);
    expect(bannerCellSize(late, 'THIS HEADLINE IS FAR TOO LONG', 480, theme)).toBe(2);
    const still = createFakeCtx();
    drawBanner(still, createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true }), banner(1 / 60), 480, 270);
    expect(width(still)).toBe(width(late));
  });
});

describe('menu selection transition', () => {
  it('glides the selection bar to the new row with a clock, snaps without one or with reduced motion', async () => {
    const { MenuList } = await import('@/ui/widgets/menu');
    const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
    const barY = (ctx: FakeCtx): number => ctx.fillsWith(theme.colors.selection)[0]!.y;
    const m = new MenuList(items);
    m.draw(createFakeCtx(), theme, 0, 0, 100, { time: 1 });
    m.move(1);
    const mid = createFakeCtx();
    m.draw(mid, theme, 0, 0, 100, { time: 1.016 });
    expect(barY(mid)).toBeGreaterThan(0);
    expect(barY(mid)).toBeLessThan(theme.lineHeight);
    const end = createFakeCtx();
    m.draw(end, theme, 0, 0, 100, { time: 2 });
    expect(barY(end)).toBe(theme.lineHeight);
    const still = new MenuList(items);
    const reduced = createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true });
    still.draw(createFakeCtx(), reduced, 0, 0, 100, { time: 1 });
    still.move(1);
    const snap = createFakeCtx();
    still.draw(snap, reduced, 0, 0, 100, { time: 1.016 });
    expect(barY(snap)).toBe(reduced.lineHeight);
  });
});
