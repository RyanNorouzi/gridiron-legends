import { describe, expect, it } from 'vitest';
import { clipTiming, makeKit, type FrameRequest } from '@/ui/render/anim';
import type { AnimId } from '@/ui/render/anim-ids';
import { installFigures } from '@/ui/render/figures/install';
import { DRIVE_SPEED, ENGAGE_GAP, LEVERAGE_SHIFT, leverageShift, PUNCH_SURGE } from '@/ui/render/figures/look-contact';
import { buildLut, helmetColors, HELMET_JERSEY_MIN_DE, kitColors, Mat, px, Tone } from '@/ui/render/figures/materials';
import { createFigurePainter } from '@/ui/render/figures/painter';
import { AWAY_JERSEY, colorDistance, resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';
import type { TeamColors } from '@/teams/types';
import { athlete, frameAt, memory, place } from './contact-fixture';

installFigures();

describe('helmet vs jersey contrast', () => {
  const rust: TeamColors = { primary: '#B7410E', secondary: '#F2D16B', accent: '#2B2B2B', helmet: '#B7410E' };
  const whiteLid: TeamColors = { primary: '#D62839', secondary: '#FFFFFF', accent: '#101820', helmet: '#FFFFFF' };
  const darkLid: TeamColors = { primary: '#D7263D', secondary: '#2B2B2B', accent: '#F9A825', helmet: '#2B2B2B' };

  it('darkens a coloured helmet that matches its jersey and rings it, keeps a distinct helmet as it is', () => {
    const home = kitColors('home', rust);
    expect(home.helmetRim).toBe(true);
    expect(colorDistance(home.helmet, home.jersey)).toBeGreaterThanOrEqual(HELMET_JERSEY_MIN_DE - 5);
    // the stripe and the mask still read against the new shell
    expect(colorDistance(home.stripe, home.helmet)).toBeGreaterThanOrEqual(15);
    expect(home.mask).not.toBe(home.helmet);
    const plain = kitColors('home', darkLid);
    expect(plain.helmetRim).toBe(false);
    expect(plain.helmet).toBe(darkLid.helmet);
  });

  it('keeps a white helmet white over the away white but rings it in a darker edge tone', () => {
    const away = kitColors('away', whiteLid);
    expect(away.jersey).toBe(AWAY_JERSEY);
    expect(away.helmetRim).toBe(true);
    expect(away.helmet).toBe(whiteLid.helmet);
    const lum = (lut: Uint8ClampedArray, t: number): number => { const i = px(Mat.Helmet, t) * 4; return 0.3 * (lut[i] ?? 0) + 0.59 * (lut[i + 1] ?? 0) + 0.11 * (lut[i + 2] ?? 0); };
    const ringed = buildLut(away, '#c98d63', 'day');
    const plain = buildLut({ ...away, helmetRim: false }, '#c98d63', 'day');
    expect(lum(ringed, Tone.Shadow)).toBeLessThan(lum(plain, Tone.Shadow) - 20);
    // the tone ladder stays ordered: outline < deep < shadow < base
    expect(lum(ringed, Tone.Outline)).toBeLessThan(lum(ringed, Tone.Deep));
    expect(lum(ringed, Tone.Deep)).toBeLessThan(lum(ringed, Tone.Shadow));
    expect(lum(ringed, Tone.Shadow)).toBeLessThan(lum(ringed, Tone.Base));
    // the home kit's coloured jersey against a white helmet needs nothing
    expect(helmetColors(whiteLid, '#D62839').helmetRim).toBe(false);
  });
});

describe('squat line stances', () => {
  const pal = resolveTeamPalettes({ primary: '#b3202a', secondary: '#1c1c22', accent: '#f2c14e', helmet: '#b3202a' }, { primary: '#1f4e9c', secondary: '#c8a24a', accent: '#ffffff', helmet: '#1f4e9c' }, 'none');
  const kit = makeKit('home', pal.home, teamUniforms(pal).home);
  const painter = createFigurePainter();
  const geom = (clip: AnimId, frame: number, facing: 'e' | 'w', build: 'bigO' | 'bigD') => {
    const req: FrameRequest = { clip, frame, facing, build, bodyVar: 1, tier: 1, kit, skin: 2, number: 72, ball: false, accessory: 0, lighting: 'day' };
    const g = painter.geometry(painter.normalize?.(req) ?? req);
    if (!g) throw new Error(clip);
    return g;
  };
  const LOCKED: readonly AnimId[] = ['punch', 'handFight', 'driveBlock', 'bullRush', 'doubleTeam', 'splitDouble'];

  it('keeps engaged linemen low: the helmet no higher than 17 art px, well under a standing man', () => {
    for (const build of ['bigO', 'bigD'] as const) for (const facing of ['e', 'w'] as const) {
      const standing = -geom('idle', 0, facing, build).attach.helmetTop.y;
      for (const clip of LOCKED) for (let f = 0; f < clipTiming(clip).frames; f++) {
        const top = -geom(clip, f, facing, build).attach.helmetTop.y;
        expect(top, `${build} ${clip} ${facing} ${f}`).toBeLessThanOrEqual(17);
        expect(standing - top, `${build} ${clip} ${facing} ${f}`).toBeGreaterThanOrEqual(6);
      }
      // the pass set sits down too, and the three-point stance never hangs a hand into the row in front
      for (let f = 0; f < clipTiming('passSet').frames; f++) expect(-geom('passSet', f, facing, build).attach.helmetTop.y).toBeLessThanOrEqual(19);
      const s = geom('stance3', 0, facing, build);
      expect(s.height - s.ay, `${build} stance3 ${facing}`).toBeLessThanOrEqual(3);
    }
  });
});

describe('line-play beats', () => {
  const OG = 'off:LG';
  const DT = 'def:DT1';
  const pair = (bWy: number, dWy: number) => [
    place(athlete({ id: OG, engagedWith: DT }), 26, bWy),
    place(athlete({ id: DT, side: 'defense', position: 'DT', role: 'DT1', engagedWith: OG, facing: -Math.PI / 2 }), 26, dWy),
  ];

  it('leans a pair toward the side winning it, continuously, and a stalemate one way by a stable hash', () => {
    expect(leverageShift(DRIVE_SPEED, 'k')).toBeCloseTo(LEVERAGE_SHIFT);
    expect(leverageShift(-5, 'k')).toBeCloseTo(-LEVERAGE_SHIFT);
    expect(Math.abs(leverageShift(0, 'k'))).toBeCloseTo(LEVERAGE_SHIFT);
    expect(leverageShift(0, 'k')).toBe(leverageShift(0, 'k'));
    let prev = leverageShift(-2, 'a|b');
    for (let v = -2; v <= 2; v += 0.01) {
      const cur = leverageShift(v, 'a|b');
      expect(Math.abs(cur - prev)).toBeLessThan(0.1);
      expect(Math.abs(cur)).toBeLessThanOrEqual(LEVERAGE_SHIFT + 1e-9);
      prev = cur;
    }
    // some pairs lean each way in a stalemate
    const sides = new Set(['LT|DE1', 'LG|DT1', 'C|DT2', 'RG|NT', 'RT|DE2', 'TE|OLB'].map((k) => Math.sign(leverageShift(0, k))));
    expect(sides.size).toBe(2);
  });

  it('lands the punch as a surge: the two bodies close in at the strike and settle back to the gap', () => {
    expect(PUNCH_SURGE).toBeGreaterThan(0);
    const mem = memory();
    frameAt(mem, 90, [place(athlete({ id: OG, state: 'moving', engagedWith: null }), 26, 39.5)]);
    const gapAt = (tick: number): { clip: string; gap: number } => {
      const l = frameAt(mem, tick, pair(40, 41.1));
      const b = l.get(OG); const d = l.get(DT);
      return { clip: b?.clip ?? '', gap: Math.round(41.1 * 22 + (d?.dx ?? 0)) - Math.round(40 * 22 + (b?.dx ?? 0)) };
    };
    const gaps: { clip: string; gap: number }[] = [];
    for (let t = 100; t <= 150; t++) gaps.push(gapAt(t));
    const punch = gaps.filter((g) => g.clip === 'punch');
    const settled = gaps[gaps.length - 1] as { clip: string; gap: number };
    expect(punch.length).toBeGreaterThan(3);
    expect(settled.clip).toBe('handFight');
    expect(Math.min(...punch.map((g) => g.gap))).toBeLessThan(settled.gap);
    expect(Math.abs(settled.gap - ENGAGE_GAP)).toBeLessThanOrEqual(3);
  });
});
