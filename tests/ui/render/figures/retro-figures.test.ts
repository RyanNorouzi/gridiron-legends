import { describe, expect, it } from 'vitest';
import { makeKit, type FrameRequest } from '@/ui/render/anim';
import { helmetViewFor, STAMP_H, STAMP_W, stampHelmet } from '@/ui/render/figures/helmet-stamp';
import { installFigures } from '@/ui/render/figures/install';
import { DRIVE_GAP, ENGAGE_GAP } from '@/ui/render/figures/look-contact';
import { buildLut, kitColors, Mat, px, Tone } from '@/ui/render/figures/materials';
import { createFigurePainter, FACING_ANGLE, RETRO_TURN, RETRO_TWIST, retroView } from '@/ui/render/figures/painter';
import { Target } from '@/ui/render/figures/raster-prims';
import { buildDims, BUILDS, RETRO_K } from '@/ui/render/figures/rig';
import { resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';

installFigures();
const pal = resolveTeamPalettes({ primary: '#b3202a', secondary: '#1c1c22', accent: '#f2c14e', helmet: '#b3202a' }, { primary: '#1f4e9c', secondary: '#c8a24a', accent: '#ffffff', helmet: '#1f4e9c' }, 'none');
const u = teamUniforms(pal);
const home = makeKit('home', pal.home, u.home);
const req = (over: Partial<FrameRequest> = {}): FrameRequest => ({
  clip: 'idle', frame: 0, facing: 's', build: 'bigO', bodyVar: 1, tier: 1, kit: home, skin: 2, number: 72, ball: false, accessory: 0, lighting: 'day', ...over,
});

/** Stamps one helmet into a fresh target and returns its painted pixels as "x,y" -> [mat, level]. */
const stamp = (hf: readonly [number, number, number], cage = false, visor = false): Map<string, [number, number]> => {
  const t = new Target();
  stampHelmet(t, { x: 40, y: 40, d: 0 }, hf, cage, visor, 6);
  const out = new Map<string, [number, number]>();
  for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) {
    const m = t.at(x, y);
    if (m !== 255) out.set(`${x},${y}`, [m, t.lvl[y * 80 + x] as number]);
  }
  return out;
};

describe('hand-drawn helmet stamps', () => {
  it('picks the side, 3/4 and square views from the head direction, mirrored for the left-facing half', () => {
    expect(helmetViewFor([1, 0, 0])).toEqual({ view: 'side', mirror: false });
    expect(helmetViewFor([-1, 0, 0])).toEqual({ view: 'side', mirror: true });
    expect(helmetViewFor([0.5, 0, 0.5]).view).toBe('front34');
    expect(helmetViewFor([0.02, 0, 1]).view).toBe('front');
    expect(helmetViewFor([0.5, 0, -0.5]).view).toBe('back34');
    expect(helmetViewFor([0.02, 0, -1]).view).toBe('back');
  });

  it('stamps an 8x7 template: shell ramp, centre stripe, facemask and a face in the opening', () => {
    const side = stamp([1, 0, 0]);
    expect(STAMP_W).toBe(8);
    expect(STAMP_H).toBe(7);
    const xs = [...side.keys()].map((k) => Number(k.split(',')[0]));
    const ys = [...side.keys()].map((k) => Number(k.split(',')[1]));
    expect(Math.max(...xs) - Math.min(...xs) + 1).toBeLessThanOrEqual(STAMP_W);
    expect(Math.max(...ys) - Math.min(...ys) + 1).toBeLessThanOrEqual(STAMP_H);
    const mats = new Set([...side.values()].map(([m]) => m));
    for (const m of [Mat.Helmet, Mat.Stripe, Mat.Mask, Mat.Skin]) expect(mats.has(m), `mat ${m}`).toBe(true);
    // a 3-tone shell lit from the upper left plus the specular glint
    const shell = new Set([...side.values()].filter(([m]) => m === Mat.Helmet).map(([, l]) => l));
    expect(shell.size).toBeGreaterThanOrEqual(4);
    // the back view shows no face and no mask
    const back = stamp([0.02, 0, -1]);
    expect([...back.values()].some(([m]) => m === Mat.Skin || m === Mat.Mask)).toBe(false);
  });

  it('mirrors the left-facing views pixel for pixel and adds the lineman cage and the visor', () => {
    const r = stamp([1, 0, 0]);
    const l = stamp([-1, 0, 0]);
    expect(l.size).toBe(r.size);
    // the template's column c lands at ox + c facing right and at ox + 7 - c facing left (ox = 36)
    for (const [k, v] of r) {
      const [x, y] = k.split(',').map(Number) as [number, number];
      expect(l.get(`${36 + 36 + STAMP_W - 1 - x},${y}`), k).toEqual(v);
    }
    const open = [...stamp([0.02, 0, 1]).values()].filter(([m]) => m === Mat.Mask).length;
    const cage = [...stamp([0.02, 0, 1], true).values()].filter(([m]) => m === Mat.Mask).length;
    expect(cage).toBeGreaterThan(open);
    const visor = stamp([1, 0, 0], false, true);
    const tinted = [...visor.values()].filter(([m]) => m === Mat.Visor);
    expect(tinted.length).toBeGreaterThan(0);
    expect(tinted.some(([, lv]) => lv === 4)).toBe(true);
  });

  it('is what an upright full-size figure wears (never more than the 8x7 template)', () => {
    const p = createFigurePainter();
    const helmetPx = (r: FrameRequest): number => {
      const g = p.geometry(p.normalize?.(r) ?? r);
      return [...(g?.idx ?? [])].filter((v) => v !== 0 && (v >> 3 === Mat.Helmet || v >> 3 === Mat.Stripe)).length;
    };
    // the stamp is at most 8x7: an upright head at tier 1 stays inside it
    expect(helmetPx(req({ facing: 'e' }))).toBeLessThanOrEqual(STAMP_W * STAMP_H);
    expect(helmetPx(req({ facing: 'e' }))).toBeGreaterThan(20);
  });
});

describe('retro figure constants', () => {
  it('scales the 2x-authored builds to the 1x grid with chunkier 16-bit proportions', () => {
    expect(RETRO_K).toBe(0.8);
    const d = buildDims('slim', 1, 1);
    const b = BUILDS.slim;
    expect(d.torso).toBeLessThan(b.torso);
    expect(d.padR / b.padR).toBeGreaterThan(RETRO_K);
    // limbs never thinner than 3 px across (radius >= 1.3) at full size
    for (const build of Object.keys(BUILDS) as (keyof typeof BUILDS)[]) {
      const x = buildDims(build, 0, 1);
      expect(x.armR, build).toBeGreaterThanOrEqual(1.3);
      expect(x.shinR, build).toBeGreaterThanOrEqual(1.35);
      expect(x.thighR, build).toBeGreaterThanOrEqual(1.6);
    }
  });

  it('turns side facings a little toward the camera (3/4 view) and leaves square facings alone', () => {
    expect(RETRO_TURN).toBe(0.3);
    expect(RETRO_TWIST).toBe(0.45);
    expect(retroView(FACING_ANGLE.e)).toBeCloseTo(FACING_ANGLE.e + RETRO_TURN * Math.cos(FACING_ANGLE.e) * (Math.sin(FACING_ANGLE.e) < -0.05 ? 0.6 : 1));
    expect(Math.abs(retroView(FACING_ANGLE.e) - FACING_ANGLE.e)).toBeGreaterThan(0.1);
    expect(retroView(FACING_ANGLE.s)).toBeCloseTo(FACING_ANGLE.s);
    expect(retroView(FACING_ANGLE.n)).toBeCloseTo(FACING_ANGLE.n);
  });

  it('spaces engaged linemen for ~24-px figures and draws a strong near-black outline with a 3-tone ramp', () => {
    expect(ENGAGE_GAP).toBe(17);
    expect(DRIVE_GAP).toBe(15);
    const lut = buildLut(kitColors('home', pal.home), '#c98d63', 'day');
    const rgb = (m: number, t: number): [number, number, number] => { const i = px(m, t) * 4; return [lut[i] ?? 0, lut[i + 1] ?? 0, lut[i + 2] ?? 0]; };
    const lum = ([r, g, b]: [number, number, number]): number => 0.3 * r + 0.59 * g + 0.11 * b;
    for (const m of [Mat.Jersey, Mat.Pants, Mat.Skin]) expect(lum(rgb(m, Tone.Outline)), `mat ${m}`).toBeLessThan(60);
    // the jersey keeps no specular: its highlight is the plain light tone
    expect(rgb(Mat.Jersey, Tone.Highlight)).not.toEqual(rgb(Mat.Jersey, Tone.Base));
  });
});
