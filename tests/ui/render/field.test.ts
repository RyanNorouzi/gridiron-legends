import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { MIDDLE_X, type WeatherState } from '@/game/types';
import { Camera } from '@/ui/camera';
import { GOAL_POST_COLOR, drawField, drawWeatherOverlay, hash01, worldRect, type FieldDrawOptions } from '@/ui/render/field';
import { UI_COLORS, fieldGreens } from '@/ui/render/palette';
import { createFakeCtx } from './fake-ctx';

const weather = (type: WeatherState['type'], visibility = 1): WeatherState => ({
  type, windDir: 0.3, windMph: 12, temperatureF: 45, precipitation: type === 'clear' ? 0 : 0.8, visibility, fieldSlick: 0.2,
});

const opts = (over: Partial<FieldDrawOptions> = {}): FieldDrawOptions => ({
  weather: null, fieldType: 'grass', endZoneColors: { home: '#c00000', away: '#1030c0' }, homeAbbr: 'HOM', awayAbbr: 'AWY',
  losY: 60, firstDownY: 68, dir: 1, ...over,
});

const camAt = (y: number, zoom = 6, rotation = 0): Camera => {
  const cam = new Camera(480, 270);
  cam.target.x = MIDDLE_X;
  cam.target.y = y;
  cam.zoom = zoom;
  cam.setRotation(rotation);
  return cam;
};

describe('drawField mid-field', () => {
  const greens = fieldGreens('grass', null);
  it('draws alternating bands, yard lines, hashes, markers and numbers only where visible', () => {
    const ctx = createFakeCtx();
    drawField(ctx, camAt(60), opts());
    expect(ctx.fillsWith(greens.stripeA).length).toBeGreaterThanOrEqual(4);
    expect(ctx.fillsWith(greens.stripeB).length).toBeGreaterThanOrEqual(4);
    // horizontal field: yard lines are vertical screen lines spanning the field's width, ordered left to right
    const yardLines = ctx.fillsWith(greens.line).filter((f) => f.h > 300 && f.w <= 2);
    expect(yardLines.length).toBe(17);
    expect(ctx.fillsWith(greens.hash).length).toBeGreaterThan(30);
    expect(ctx.fillsWith(UI_COLORS.los)).toHaveLength(1);
    expect(ctx.fillsWith(UI_COLORS.firstDown)).toHaveLength(1);
    expect(ctx.fillsWith('#c00000')).toHaveLength(0);
    expect(ctx.fillsWith('#1030c0')).toHaveLength(0);
    expect(ctx.fillsWith(GOAL_POST_COLOR)).toHaveLength(0);
    // yard numbers are drawn upright (no rotation) and readable
    expect(ctx.callsNamed('rotate')).toHaveLength(0);
    expect(ctx.fillsWith(greens.numbers).length).toBeGreaterThan(20);
  });

  it('draws the line of scrimmage as a vertical line right of centre (not flipped) and left of it when flipped', () => {
    const right = createFakeCtx();
    drawField(right, camAt(55), opts({ losY: 60 }));
    const los = right.fillsWith(UI_COLORS.los)[0]!;
    expect(los.x).toBeGreaterThan(240);
    expect(los.h).toBeGreaterThan(los.w);
    const flipped = createFakeCtx();
    drawField(flipped, camAt(55, 6, Math.PI), opts({ losY: 60 }));
    expect(flipped.fillsWith(UI_COLORS.los)[0]!.x).toBeLessThan(240);
  });

  it('hides the line to gain when it is goal to go and markers when null', () => {
    const ctx = createFakeCtx();
    drawField(ctx, camAt(100), opts({ losY: 100, firstDownY: 112, dir: 1 }));
    expect(ctx.fillsWith(UI_COLORS.firstDown)).toHaveLength(0);
    expect(ctx.fillsWith(UI_COLORS.los)).toHaveLength(1);
    const none = createFakeCtx();
    drawField(none, camAt(60), opts({ losY: null, firstDownY: null }));
    expect(none.fillsWith(UI_COLORS.los)).toHaveLength(0);
    expect(none.fillsWith(UI_COLORS.firstDown)).toHaveLength(0);
  });

  it('draws the end zone, its text and goal posts when looking at an end', () => {
    const ctx = createFakeCtx();
    drawField(ctx, camAt(6), opts({ losY: 20, firstDownY: 30 }));
    expect(ctx.fillsWith('#c00000').length).toBeGreaterThanOrEqual(1);
    expect(ctx.fillsWith('#1030c0')).toHaveLength(0);
    expect(ctx.fillsWith(GOAL_POST_COLOR).length).toBe(4);
    // the end zone name is turned to face midfield (yard numbers are upright)
    expect(ctx.callsNamed('rotate').length).toBeGreaterThanOrEqual(1);
    const north = createFakeCtx();
    drawField(north, camAt(114), opts());
    expect(north.fillsWith('#1030c0').length).toBeGreaterThanOrEqual(1);
    expect(north.fillsWith('#c00000')).toHaveLength(0);
  });

  it('skips hashes and numbers when zoomed far out', () => {
    const ctx = createFakeCtx();
    // The horizontal whole-field view is ~3.8 px/yd (it keeps numbers); a narrow viewport is truly far out.
    const cam = new Camera(300, 150);
    cam.setMode('simulation', { userSide: null, direction: 1, ballPos: vec2(MIDDLE_X, 60), controlledPos: null });
    expect(cam.zoom).toBeLessThan(3);
    drawField(ctx, cam, opts());
    expect(ctx.fillsWith(greens.hash)).toHaveLength(0);
    expect(ctx.callsNamed('rotate')).toHaveLength(0);
    expect(ctx.fillsWith(greens.stripeA).length + ctx.fillsWith(greens.stripeB).length).toBe(20);
  });
});

describe('weather overlay', () => {
  it('adds rain streaks and a darkening tint, heavier for heavy rain', () => {
    const clear = createFakeCtx();
    drawField(clear, camAt(60), opts({ weather: weather('clear') }));
    const rain = createFakeCtx();
    drawField(rain, camAt(60), opts({ weather: weather('rain'), time: 1.5 }));
    const heavy = createFakeCtx();
    drawField(heavy, camAt(60), opts({ weather: weather('heavyRain'), time: 1.5 }));
    expect(rain.fills.length).toBeGreaterThan(clear.fills.length + 100);
    expect(heavy.fills.length).toBeGreaterThan(rain.fills.length);
    const tint = heavy.fillsWith('#0a1424').find((f) => f.w === 480 && f.h === 270);
    expect(tint?.alpha).toBeCloseTo(0.28);
    expect(rain.fillsWith('#0a1424').find((f) => f.w === 480)?.alpha).toBeCloseTo(0.12);
  });
  it('draws snow flakes, fog for low visibility and leaves alpha restored', () => {
    const ctx = createFakeCtx();
    ctx.globalAlpha = 0.7;
    drawWeatherOverlay(ctx, 480, 270, weather('snow', 0.5), 2);
    expect(ctx.fillsWith('#ffffff').length).toBe(90);
    expect(ctx.fillsWith('#d8dee6')[0]?.alpha).toBeCloseTo(0.25);
    expect(ctx.globalAlpha).toBe(0.7);
  });
  it('is deterministic for a given time and animates over time', () => {
    const a = createFakeCtx();
    const b = createFakeCtx();
    const c = createFakeCtx();
    drawWeatherOverlay(a, 480, 270, weather('rain'), 1);
    drawWeatherOverlay(b, 480, 270, weather('rain'), 1);
    drawWeatherOverlay(c, 480, 270, weather('rain'), 1.2);
    expect(a.fills).toEqual(b.fills);
    expect(a.fills).not.toEqual(c.fills);
  });
  it('keeps rain streaks on screen whichever way the wind blows', () => {
    for (const windDir of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const ctx = createFakeCtx();
      drawWeatherOverlay(ctx, 480, 270, { ...weather('heavyRain'), windDir, windMph: 25 }, 7.3);
      const streaks = ctx.fillsWith('#cfe2ff');
      expect(streaks.length).toBeGreaterThan(100);
      const onScreen = streaks.filter((f) => f.x >= 0 && f.x < 480 && f.y >= 0 && f.y < 270).length;
      expect(onScreen).toBeGreaterThan(streaks.length * 0.7);
    }
  });
  it('hash01 is stable and in range', () => {
    for (let i = 0; i < 500; i++) {
      const v = hash01(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hash01(i)).toBe(v);
    }
    expect(hash01(1)).not.toBe(hash01(2));
  });
});

describe('worldRect', () => {
  it('normalises corners and keeps at least one pixel', () => {
    const cam = camAt(60, 6, Math.PI);
    const r = worldRect(cam, 10, 50, 5, 5);
    expect(r.w).toBe(30);
    expect(r.h).toBe(30);
    const thin = worldRect(camAt(60, 1.5), 0, 0, 0.1, 0.1);
    expect(thin.w).toBe(1);
    expect(thin.h).toBe(1);
  });
});
