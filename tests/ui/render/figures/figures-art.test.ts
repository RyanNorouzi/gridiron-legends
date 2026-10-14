import { describe, expect, it } from 'vitest';
import { clipTiming, FIGURE_BUILDS, frameKey, makeKit, painterFor, type FigureBuild, type FrameRequest } from '@/ui/render/anim';
import { CORE_ANIM_IDS, LINE_ANIM_IDS, TACKLE_ANIM_IDS } from '@/ui/render/anim-ids';
import { FIGURE_PAINTER, installFigures } from '@/ui/render/figures/install';
import { hasPoses } from '@/ui/render/figures/anims';
import { buildLut, kitColors, Mat, px, Tone } from '@/ui/render/figures/materials';
import { accessoryBits, createFigurePainter, GEOM_CACHE_MAX, type FigureFrame } from '@/ui/render/figures/painter';
import { digitsOf, numberPixels } from '@/ui/render/figures/numbers';
import { DECALS, decalFor } from '@/ui/render/figures/decals';
import { AWAY_JERSEY, contrastRatio, relativeLuminance, resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';
import { FACINGS, type Facing8 } from '@/ui/render/sprites';
import { NUMBER_MIN_VISIBLE } from '@/ui/render/figures/raster-geom';
import { TIER_SCALE, type FigureTier } from '@/ui/render/world-layer';

installFigures();
const pal = resolveTeamPalettes({ primary: '#b3202a', secondary: '#1c1c22', accent: '#f2c14e', helmet: '#b3202a' }, { primary: '#1f4e9c', secondary: '#c8a24a', accent: '#ffffff', helmet: '#1f4e9c' }, 'none');
const u = teamUniforms(pal);
const home = makeKit('home', pal.home, u.home);
const away = makeKit('away', pal.away, u.away);
const req = (over: Partial<FrameRequest> = {}): FrameRequest => ({
  clip: 'idle', frame: 0, facing: 's', build: 'bigO', bodyVar: 1, tier: 1, kit: home, skin: 2, number: 72, ball: false, accessory: 0, lighting: 'day', ...over,
});

/** Opaque, non-outline bounds of a painted geometry frame. */
const bodyBounds = (p: ReturnType<typeof createFigurePainter>, r: FrameRequest): { h: number; w: number; feetGap: number } => {
  const g = p.geometry(p.normalize?.(r) ?? r);
  if (!g) throw new Error('no geometry');
  let y0 = 1e9; let y1 = -1; let x0 = 1e9; let x1 = -1;
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const v = g.idx[y * g.width + x] as number;
    if (v && (v & 7) !== Tone.Outline) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  }
  return { h: y1 - y0 + 1, w: x1 - x0 + 1, feetGap: g.ay - y1 };
};

/** Retro look: standing heights (art px, no outline) on the one 480x270 grid; linemen ~25 px with the outline. */
const HEIGHT: Readonly<Record<FigureBuild, number>> = { bigO: 24, bigD: 24, power: 24, back: 22, qb: 24, slim: 24, kick: 22 };

describe('figure art (chain A)', () => {
  it('stands at the retro heights per build (±1 px at tier 1) and shrinks with the tier, feet on the ground', () => {
    const p = createFigurePainter();
    for (const build of FIGURE_BUILDS) {
      const t1 = bodyBounds(p, req({ build }));
      expect(Math.abs(t1.h - HEIGHT[build]), build).toBeLessThanOrEqual(1);
      expect(t1.feetGap, build).toBe(0);
      for (const tier of [2, 3, 4] as FigureTier[]) {
        const t = bodyBounds(p, req({ build, tier }));
        expect(Math.abs(t.h - HEIGHT[build] * TIER_SCALE[tier]), `${build} T${tier}`).toBeLessThanOrEqual(tier === 2 ? 1.6 : 2);
        expect(t.feetGap).toBeLessThanOrEqual(2);
      }
    }
    // chunky 16-bit proportions: a lineman is ~20 art px wide with the outline; linemen are wider than receivers
    const ol = bodyBounds(p, req({ build: 'bigO' }));
    expect(ol.w + 2).toBeGreaterThanOrEqual(18);
    expect(ol.w + 2).toBeLessThanOrEqual(22);
    expect(ol.w).toBeGreaterThan(bodyBounds(p, req({ build: 'slim' })).w);
  });

  it('paints every core clip in every facing and build; the painter covers the core clips and backs every other clip', () => {
    const p = createFigurePainter();
    for (const clip of CORE_ANIM_IDS) {
      expect(hasPoses(clip), clip).toBe(true);
      expect(painterFor(clip), clip).toBe(FIGURE_PAINTER);
      for (const build of FIGURE_BUILDS) for (const facing of FACINGS) for (let f = 0; f < clipTiming(clip).frames; f++) {
        const fr = p.paint(p.normalize?.(req({ clip, build, facing, frame: f, ball: true })) ?? req());
        expect(fr.width * fr.height, `${clip} ${build} ${facing} ${f}`).toBeGreaterThan(40);
        expect(fr.rgba?.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
      }
    }
    for (const clip of [...LINE_ANIM_IDS, ...TACKLE_ANIM_IDS]) expect(hasPoses(clip), clip).toBe(true);
  });

  it('is pure: the same request paints the same pixels; equivalent requests share one cache key', () => {
    const a = createFigurePainter();
    const b = createFigurePainter();
    const r = req({ clip: 'run', frame: 3, facing: 'se', build: 'slim', ball: true });
    expect(a.paint(a.normalize?.(r) ?? r).rgba).toEqual(b.paint(b.normalize?.(r) ?? r).rgba);
    // numbers are stamped at draw time, day / night / indoor share the day LUT, accessories fold to their bits
    expect(frameKey(a, req({ number: 1 }))).toBe(frameKey(a, req({ number: 99 })));
    expect(frameKey(a, req({ lighting: 'night' }))).toBe(frameKey(a, req({ lighting: 'indoor' })));
    expect(frameKey(a, req({ lighting: 'overcast' }))).not.toBe(frameKey(a, req()));
    expect(frameKey(a, req({ frame: 2 }))).toBe(frameKey(a, req({ frame: 0 })));
    expect(accessoryBits('bigO', 12345) & 3).toBe(0);
    expect(frameKey(a, req({ accessory: 0 }))).toBe(frameKey(a, req({ accessory: 100 })));
    // a clip that never shows the ball drops the ball flag
    expect(frameKey(a, req({ clip: 'kickoff', frame: 3, ball: true }))).toBe(frameKey(a, req({ clip: 'kickoff', frame: 3, ball: false })));
    expect(GEOM_CACHE_MAX).toBe(4000);
  });

  it('carries the ball in the camera-side arm and reports attachments', () => {
    const p = createFigurePainter();
    const east = p.paint(p.normalize?.(req({ clip: 'carry', frame: 1, facing: 'e', build: 'back', ball: true })) ?? req());
    const west = p.paint(p.normalize?.(req({ clip: 'carry', frame: 1, facing: 'w', build: 'back', ball: true })) ?? req());
    expect(east.attach?.ball).toBeDefined();
    expect(west.attach?.ball).toBeDefined();
    // camera side = screen down: the tucked ball sits at or below the torso centre in both directions
    for (const fr of [east, west]) expect((fr.attach?.ball?.y ?? -99)).toBeGreaterThanOrEqual((fr.attach?.torsoCentre?.y ?? 0) - 3);
    expect(Math.sign(east.attach?.ball?.x ?? 0)).toBe(1);
    expect(Math.sign(west.attach?.ball?.x ?? 0)).toBe(-1);
    const idle = p.paint(req());
    expect(idle.attach?.helmetTop?.y).toBeLessThan(-20);
    expect(idle.attach?.helmetTop?.y).toBeGreaterThan(-26);
    expect(idle.attach?.feet).toHaveLength(2);
    expect(idle.attach?.ball).toBeUndefined();
  });

  it('finds room for the jersey number on the chest and back at the near tiers only (whole digits only)', () => {
    const p = createFigurePainter();
    // the retro 3/4 view turns a side-on lineman's chest toward the camera: the number shows on it
    for (const facing of ['se', 'e'] as const) {
      const front = p.paint(req({ number: 72, facing })) as FigureFrame;
      expect(front.numberSpot?.one, facing).toBe(true);
      expect(front.numberSpot?.back, facing).toBe(false);
    }
    const back = p.paint(p.normalize?.(req({ clip: 'run', facing: 'n' })) ?? req()) as FigureFrame;
    expect(back.numberSpot?.two).toBe(true);
    expect(back.numberSpot?.back).toBe(true);
    expect((p.paint(req({ tier: 3 })) as FigureFrame).numberSpot).toBeNull();
    expect((p.paint(req({ tier: 3, facing: 'e' })) as FigureFrame).numberSpot).toBeNull();
    expect(NUMBER_MIN_VISIBLE).toBe(0.85);
    expect(digitsOf(7)).toEqual([7]);
    expect(digitsOf(172)).toEqual([7, 2]);
    const ink = numberPixels(88, { x: 0, y: 0, one: true, two: true, back: false, shade: 2, mask: [511, 511, 511, 511, 511, 511] }).filter(([, , s]) => !s);
    const xs = ink.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs) + 1).toBe(7);
  });

  it('keeps number counters clear: ink only on visible jersey, the shadow is one row under the digits', () => {
    const full = [511, 511, 511, 511, 511, 511];
    const px88 = numberPixels(88, { x: 0, y: 0, one: true, two: true, back: false, shade: 2, mask: full });
    const shadow = px88.filter(([, , s]) => s);
    // the 1-px holes of an 8 and the gap between the digits stay jersey (no drop shadow inside the digit rows)
    expect(shadow.length).toBeGreaterThan(0);
    for (const [, y] of shadow) expect(y).toBe(5);
    expect(px88.some(([x, y]) => x === -1 && y === 1)).toBe(false);
    expect(px88.some(([x, y]) => x === 1 && y < 5)).toBe(false);
    // an arm across the right of the box hides those ink pixels only
    const cut = numberPixels(88, { x: 0, y: 0, one: true, two: true, back: false, shade: 2, mask: full.map((m) => m & ~0b111) });
    expect(cut.every(([x]) => x < 4)).toBe(true);
    expect(cut.filter(([, , s]) => !s).length).toBeGreaterThan(8);
  });

  it('shows a lineman\'s number from behind in every running frame (no flicker) and the carried ball in every facing', () => {
    const p = createFigurePainter();
    const noAcc = 50 + (50 << 8) + (50 << 16);
    for (const build of ['bigO', 'power', 'back', 'slim'] as FigureBuild[]) for (const clip of ['run', 'carry', 'jog'] as const) {
      const spots = [];
      for (let f = 0; f < 8; f++) {
        const r = p.normalize?.(req({ clip, frame: f, facing: 'n', build, ball: clip === 'carry', accessory: noAcc })) ?? req();
        spots.push((p.paint(r) as FigureFrame).numberSpot);
      }
      // the wide lineman back always fits both digits in the run cycle; narrower backs show them when they fit
      if (build === 'bigO' && clip !== 'jog') expect(spots.every((s) => s?.two), `${build} ${clip}`).toBe(true);
      const ys = spots.filter((s) => s !== null).map((s) => s?.y ?? 0);
      if (ys.length > 0) expect(Math.max(...ys) - Math.min(...ys), `${build} ${clip} number bob`).toBeLessThanOrEqual(3);
    }
    for (const build of FIGURE_BUILDS) for (const clip of ['carry', 'carrySprint'] as const) for (const facing of FACINGS) {
      for (let f = 0; f < clipTiming(clip).frames; f++) {
        const g = p.geometry(p.normalize?.(req({ clip, frame: f, facing, build, ball: true })) ?? req());
        const balls = [...(g?.idx ?? [])].filter((v) => v >> 3 === Mat.Ball).length;
        expect(balls, `${build} ${clip} ${facing} ${f}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('builds kits with the light / dark inversion and the contrast rules', () => {
    const h = kitColors('home', pal.home);
    const a = kitColors('away', pal.away);
    expect(a.jersey).toBe(AWAY_JERSEY);
    expect(relativeLuminance(h.pants)).toBeGreaterThan(relativeLuminance(h.jersey));
    expect(relativeLuminance(a.pants)).toBeLessThan(relativeLuminance(a.jersey));
    expect(contrastRatio(h.jersey, AWAY_JERSEY)).toBeGreaterThanOrEqual(2.2);
    expect(contrastRatio(h.number, h.jersey)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(a.number, a.jersey)).toBeGreaterThanOrEqual(3);
    // a pale home colour darkens until it separates from the away white; a low-contrast accent falls back
    const pale = kitColors('home', { primary: '#f0ead0', secondary: '#202020', accent: '#f8f4e0', helmet: '#f0ead0' });
    expect(contrastRatio(pale.jersey, AWAY_JERSEY)).toBeGreaterThanOrEqual(2.2);
    expect(contrastRatio(pale.number, pale.jersey)).toBeGreaterThanOrEqual(3);
    // the facemask reads against the helmet
    expect(kitColors('home', { ...pal.home, helmet: '#f4f4f4' }).mask).not.toBe(kitColors('home', { ...pal.home, helmet: '#101010' }).mask);
  });

  it('colours through a LUT: transparent index 0, ramps from deep to highlight, a darker sel-out outline', () => {
    const lut = buildLut(kitColors('home', pal.home), '#c98d63', 'day');
    expect(lut[3]).toBe(0);
    const lum = (m: number, t: number): number => { const i = px(m, t) * 4; return 0.3 * (lut[i] ?? 0) + 0.59 * (lut[i + 1] ?? 0) + 0.11 * (lut[i + 2] ?? 0); };
    for (const m of [Mat.Jersey, Mat.Helmet, Mat.Skin, Mat.Pants]) {
      expect(lum(m, Tone.Outline)).toBeLessThan(lum(m, Tone.Deep));
      expect(lum(m, Tone.Deep)).toBeLessThan(lum(m, Tone.Shadow));
      expect(lum(m, Tone.Shadow)).toBeLessThan(lum(m, Tone.Base));
      expect(lum(m, Tone.Base)).toBeLessThan(lum(m, Tone.Highlight));
    }
    const over = buildLut(kitColors('home', pal.home), '#c98d63', 'overcast');
    const i = px(Mat.Helmet, Tone.Highlight) * 4;
    expect(over[i]).toBeLessThanOrEqual(lut[i] as number);
  });

  it('gives each team one of the eight original decals, the same on both kits', () => {
    expect(DECALS).toHaveLength(8);
    for (const g of DECALS) expect(g).toHaveLength(4);
    expect(decalFor(home)).toBe(decalFor(makeKit('away', pal.home, u.home)));
    expect(decalFor(home)).toBeGreaterThanOrEqual(0);
    expect(decalFor(away)).toBeLessThan(8);
  });

  it('turns the spin through the facings and lifts the hurdle within the bible limits', () => {
    const p = createFigurePainter();
    const shapes = new Set<string>();
    for (let f = 0; f < clipTiming('spin').frames; f++) {
      const fr = p.paint(req({ clip: 'spin', frame: f, facing: 'e' as Facing8, build: 'back', ball: true }));
      shapes.add(`${fr.width}x${fr.height}`);
    }
    expect(shapes.size).toBeGreaterThan(2);
    const ground = bodyBounds(p, req({ clip: 'hurdle', frame: 0, build: 'back' }));
    const peak = bodyBounds(p, req({ clip: 'hurdle', frame: 2, build: 'back' }));
    expect(peak.feetGap - ground.feetGap).toBeGreaterThanOrEqual(3);
    expect(peak.feetGap - ground.feetGap).toBeLessThanOrEqual(10);
  });
});
