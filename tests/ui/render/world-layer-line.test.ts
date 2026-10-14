import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { Camera } from '@/ui/camera';
import { sceneFromPlay, type FieldViewOptions } from '@/ui/game/field-view';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import {
  CARRIER_NEAR, FAN_FAR, FAN_INNER, FAN_OUTER, LINE_FAN, lineFanYd, lineSpacingYd, neutralZonePushYd, NZ_EASE, NZ_PUSH, spacingCarrier,
  type LineSpacingContext, type SpacedAthlete,
} from '@/ui/render/world-layer-line';
import { drawWorldScene } from '@/ui/render/world-layer-scene';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx } from './fake-ctx';

const ctxOf = (over: Partial<LineSpacingContext> = {}): LineSpacingContext => ({ tier: 1, losY: 40, snapX: 26, sinceSnap: null, carrier: null, controlledId: null, ...over });
const body = (over: Partial<SpacedAthlete> = {}): SpacedAthlete => ({ id: 'off:RT', side: 'offense', position: 'OT', hasBall: false, x: 28.3, y: 39.4, ...over });

describe('line spacing: the fan across the line of scrimmage', () => {
  it('spreads the two halves of the line apart, grows with the distance from the ball and is off at the ball', () => {
    expect(lineFanYd(0, 0)).toBe(0);
    expect(lineFanYd(1.15, 0)).toBeCloseTo(LINE_FAN * 1.15);
    expect(lineFanYd(-1.15, 0)).toBeCloseTo(-LINE_FAN * 1.15);
    expect(lineFanYd(2.3, 0)).toBeGreaterThan(lineFanYd(1.15, 0));
    // gone for the wide receivers and far up / down the field
    expect(lineFanYd(FAN_OUTER + 1, 0)).toBe(0);
    expect(lineFanYd(2, FAN_FAR + 0.5)).toBe(0);
  });

  it('is continuous everywhere (a body moving through the line never pops)', () => {
    let worst = 0;
    for (let v = -7; v <= 7; v += 0.25) {
      let prev = lineFanYd(-12, v);
      for (let u = -12; u <= 12; u += 0.01) {
        const cur = lineFanYd(u, v);
        worst = Math.max(worst, Math.abs(cur - prev));
        prev = cur;
      }
    }
    // 0.01 yd steps move the drawn spot by well under a hundredth of a yard of extra offset
    expect(worst).toBeLessThan(0.01 * (LINE_FAN + 0.2));
    // never flips a body across the ball, and stays small (under a yard) past the tackles
    for (let u = 0; u <= 12; u += 0.1) expect(lineFanYd(u, 0)).toBeGreaterThanOrEqual(0);
    expect(lineFanYd(FAN_INNER, 0)).toBeLessThan(1);
  });

  it('moves only interior linemen and linebackers, never receivers, passers, the ball carrier or the controlled athlete', () => {
    const c = ctxOf();
    expect(lineSpacingYd(c, body()).dx).toBeGreaterThan(0.4);
    expect(lineSpacingYd(c, body({ position: 'OLB', side: 'defense', y: 43 })).dx).toBeGreaterThan(0);
    for (const position of ['WR', 'TE', 'RB', 'FB', 'QB', 'CB', 'SS', 'K']) expect(lineSpacingYd(c, body({ position })), position).toEqual({ dx: 0, dy: 0 });
    expect(lineSpacingYd(c, body({ hasBall: true }))).toEqual({ dx: 0, dy: 0 });
    expect(lineSpacingYd(ctxOf({ controlledId: 'off:RT' }), body())).toEqual({ dx: 0, dy: 0 });
    // no line of scrimmage (between plays), or the small whole-field tiers: nothing moves
    expect(lineSpacingYd(ctxOf({ losY: null }), body())).toEqual({ dx: 0, dy: 0 });
    expect(lineSpacingYd(ctxOf({ tier: 3 }), body())).toEqual({ dx: 0, dy: 0 });
  });

  it('fades out next to a runner (a tackler meets him where he is drawn) but not around the passer or the snapper', () => {
    const at = { x: 28.3, y: 39.4 };
    expect(lineSpacingYd(ctxOf({ carrier: at }), body()).dx).toBe(0);
    expect(lineSpacingYd(ctxOf({ carrier: { x: 28.3, y: 39.4 - CARRIER_NEAR - 0.5 } }), body()).dx).toBeGreaterThan(0);
    expect(lineSpacingYd(ctxOf({ carrier: { x: 28.3, y: 35 } }), body()).dx).toBeCloseTo(lineSpacingYd(ctxOf(), body()).dx);
    expect(spacingCarrier([body({ position: 'QB', hasBall: true })])).toBeNull();
    expect(spacingCarrier([body({ position: 'C', hasBall: true })])).toBeNull();
    expect(spacingCarrier([body({ position: 'RB', hasBall: true, x: 25, y: 36 })])).toEqual({ x: 25, y: 36 });
  });
});

describe('line spacing: the neutral-zone push', () => {
  it('draws the defensive front further off the ball before the snap and eases it out after', () => {
    expect(neutralZonePushYd('defense', 1, null)).toBeCloseTo(NZ_PUSH);
    expect(neutralZonePushYd('defense', -1, null)).toBeCloseTo(-NZ_PUSH);
    expect(neutralZonePushYd('offense', 1, null)).toBe(0);
    expect(neutralZonePushYd('defense', 5, null)).toBe(0);
    expect(Math.abs(neutralZonePushYd('defense', 1, NZ_EASE / 2))).toBeLessThan(NZ_PUSH);
    expect(neutralZonePushYd('defense', 1, NZ_EASE)).toBe(0);
    const dt = body({ id: 'def:DT1', side: 'defense', position: 'DT', y: 41 });
    expect(lineSpacingYd(ctxOf(), dt).dy).toBeCloseTo(NZ_PUSH);
    expect(lineSpacingYd(ctxOf(), body({ id: 'def:MLB', side: 'defense', position: 'MLB', y: 41 })).dy).toBe(0);
  });
});

describe('line spacing on the world layer', () => {
  const theme = createTheme(DEFAULT_SETTINGS);
  const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
  const options: FieldViewOptions = { theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home' };
  const layer = (): WorldLayer => ({ ctx: createFakeCtx(), width: 480, height: 270, used: false });

  it('gives each interior lineman more rows of his own at the pre-snap zoom, without moving anyone in the simulation', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = new Camera(480, 270);
    cam.target.x = 26.65;
    cam.target.y = f.state.losY;
    cam.zoom = 9;
    const scene = sceneFromPlay(f.state, null, 0);
    const before = scene.athletes.map((a) => `${a.id}:${a.x}:${a.y}`).join('|');
    const figures = drawWorldScene(layer(), cam, scene, options, new Map());
    expect(scene.athletes.map((a) => `${a.id}:${a.x}:${a.y}`).join('|')).toBe(before);
    const ol = figures.filter((q) => ['C', 'OG', 'OT'].includes(q.scene.position)).sort((p, q) => p.groundY - q.groundY);
    expect(ol).toHaveLength(5);
    for (let i = 1; i < ol.length; i++) {
      const drawn = (ol[i] as (typeof ol)[number]).groundY - (ol[i - 1] as (typeof ol)[number]).groundY;
      const simulated = Math.abs(cam.worldToScreen((ol[i] as (typeof ol)[number]).scene).y - cam.worldToScreen((ol[i - 1] as (typeof ol)[number]).scene).y);
      // 1.15 yd at 9 px / yd is ~10 px in the simulation; drawn a couple of pixels further apart
      expect(drawn, `row ${i}`).toBeGreaterThanOrEqual(Math.round(simulated) + 2);
    }
    // the defensive front stands further off the ball than simulated (toward its own side)
    const dl = figures.filter((q) => q.scene.position === 'DT' || q.scene.position === 'DE');
    expect(dl.length).toBeGreaterThan(0);
    const los = cam.worldToScreen({ x: 26, y: f.state.losY }).x;
    for (const q of dl) expect(Math.abs(q.x - los)).toBeGreaterThan(Math.abs(cam.worldToScreen(q.scene).x - los) + 1);
  });
});
