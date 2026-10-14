import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { loadPlaybookData } from '@/playbook/loader';
import { ART_INNER_YARDS, GAP_X, artProjector, artProjectorRaw, describeDefense, markScale, describeOffense, drawDefensiveArt, drawOffensiveArt, drawPlayArt } from '@/ui/game/play-art';
import { createTheme } from '@/ui/theme';
import { createFakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const box = { x: 10, y: 10, w: 200, h: 120 };
const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });

describe('play art', () => {
  const registry = loadPlaybookData();

  it('draws every bundled offensive play without throwing, inside the box', () => {
    for (const play of Object.values(registry.offensePlays)) {
      const ctx = createFakeCtx();
      expect(drawOffensiveArt(ctx, play, registry, box, { theme })).toBe(true);
      expect(ctx.fills.length).toBeGreaterThan(20);
      for (const f of ctx.fills) {
        expect(f.x + f.w).toBeGreaterThanOrEqual(box.x - 4);
        expect(f.x).toBeLessThanOrEqual(box.x + box.w + 4);
      }
      if (play.type === 'run') expect(ctx.fillsWith(theme.colors.warning).length).toBeGreaterThan(0);
      if (play.type === 'pass' && Object.values(play.assignments).some((a) => a.type === 'route')) expect(ctx.fillsWith(theme.colors.accent2).length).toBeGreaterThan(0);
    }
  });

  it('draws every bundled defensive play with zone blobs or man ties', () => {
    for (const play of Object.values(registry.defensePlays)) {
      const ctx = createFakeCtx();
      expect(drawDefensiveArt(ctx, play, registry, box, { theme })).toBe(true);
      expect(ctx.fills.length).toBeGreaterThan(10);
      const zone = Object.values(play.assignments).some((a) => a.type === 'zone');
      const man = Object.values(play.assignments).some((a) => a.type === 'manCover');
      if (zone) expect(ctx.fillsWith(theme.colors.accent2).length).toBeGreaterThan(0);
      if (man) expect(ctx.fillsWith(theme.colors.warning).length).toBeGreaterThan(0);
      if (play.blitz !== 'none') expect(ctx.fillsWith(theme.colors.danger).length).toBeGreaterThan(0);
    }
  });

  it('dispatches by play kind and falls back for unknown formations', () => {
    const off = Object.values(registry.offensePlays)[0]!;
    const def = Object.values(registry.defensePlays)[0]!;
    expect(drawPlayArt(createFakeCtx(), off, registry, box, { theme })).toBe(true);
    expect(drawPlayArt(createFakeCtx(), def, registry, box, { theme })).toBe(true);
    const ctx = createFakeCtx();
    expect(drawPlayArt(ctx, { ...off, formation: 'nope' }, registry, box, { theme })).toBe(false);
    expect(ctx.fills.length).toBeGreaterThan(0);
    expect(drawPlayArt(createFakeCtx(), { ...def, formation: 'nope' }, registry, box, { theme })).toBe(false);
  });

  it('projects the play-local frame horizontally (downfield right, offense\'s right down) and describes plays', () => {
    const project = artProjector(box, { theme });
    const los = project({ x: 0, y: 0 });
    const deep = project({ x: 0, y: 10 });
    const right = project({ x: 10, y: 0 });
    expect(deep.x).toBeGreaterThan(los.x);
    expect(deep.y).toBeCloseTo(los.y);
    expect(right.y).toBeGreaterThan(los.y);
    expect(right.x).toBeCloseTo(los.x);
    expect(GAP_X['A-left']).toBeLessThan(0);
    expect(GAP_X['D-right']).toBeGreaterThan(GAP_X['C-right']);
    const off = Object.values(registry.offensePlays).find((p) => p.type === 'playAction')!;
    expect(describeOffense(off)).toBe('PLAY ACTION');
    const def = Object.values(registry.defensePlays).find((p) => p.blitz === 'lb')!;
    expect(describeDefense(def)).toContain('LB BLITZ');
  });

  it('spreads the interior so five linemen are separate marks, and still fits the wide splits', () => {
    // The play-call card's board (about 190 x 170 lpx) and a smaller one.
    for (const b of [{ x: 0, y: 0, w: 190, h: 170 }, box, { x: 0, y: 0, w: 165, h: 85 }]) {
      const raw = artProjectorRaw(b, { theme: large });
      const ys = [-2.3, -1.15, 0, 1.15, 2.3].map((x) => raw({ x, y: -0.6 }).y);
      // A lineman's square is 2 * (textScale + 1) + 1 lpx wide: at least a pixel of board between neighbours.
      const mark = 2 * (markScale(large, b) + 1) + 1;
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(mark + 1);
      // Monotone across the field, continuous at the band edge, and the full width still spans the box height.
      let prev = -Infinity;
      for (let x = -27; x <= 27; x += 0.5) {
        const y = raw({ x, y: 0 }).y;
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
      expect(raw({ x: ART_INNER_YARDS + 1e-6, y: 0 }).y).toBeCloseTo(raw({ x: ART_INNER_YARDS, y: 0 }).y, 3);
      expect(raw({ x: -27, y: 0 }).y).toBeCloseTo(b.y, 5);
      expect(raw({ x: 27, y: 0 }).y).toBeCloseTo(b.y + b.h, 5);
    }
  });
});
