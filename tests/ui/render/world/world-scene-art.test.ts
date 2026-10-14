import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createReplayStore } from '@/game/replay';
import type { WeatherState } from '@/game/types';
import { Camera, CLOSE_ZOOM } from '@/ui/camera';
import { sceneFromPlay, type FieldViewOptions } from '@/ui/game/field-view';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { drawWorldScene } from '@/ui/render/world-layer-scene';
import { installWorldArt } from '@/ui/render/world/install';
import { breathEmitters, drawEffects, drawEmitter, driveEmitters, effectSortedObjects, GROUND_EFFECTS, LIFETIME, puff, sceneEmitters } from '@/ui/render/world/effects';
import { effectiveLighting } from '@/ui/render/world/lighting';
import { rainCount } from '@/ui/render/world/weather-hi';
import { WD } from '@/ui/render/world-layer';
import { sceneFromReplay } from '@/ui/screens/replay';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../../fixtures/play-state';
import { build } from '../../../game/engine/helpers';
import { createFakeCtx, type FakeCtx } from '../fake-ctx';

installWorldArt();
const theme = createTheme(DEFAULT_SETTINGS);
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const layer = (): WorldLayer & { ctx: FakeCtx } => ({ ctx: createFakeCtx(), width: 480, height: 270, used: false });
const stadium = { name: 'TEST FIELD', roof: 'open' as const, attendancePct: 0.8, homeColor: '#c02020', awayColor: '#2040c0' };
const options = (over: Partial<FieldViewOptions> = {}): FieldViewOptions => ({
  theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home', stadium, ...over,
});
const weather = (type: WeatherState['type'], temperatureF = 60): WeatherState => ({ type, windDir: 1, windMph: 12, temperatureF, precipitation: 0.7, visibility: 0.6, fieldSlick: 0.1 });
const camAt = (x: number, y: number, zoom: number): Camera => {
  const c = new Camera(480, 270);
  c.target.x = x;
  c.target.y = y;
  c.zoom = zoom;
  return c;
};

describe('world art on the scene compositor', () => {
  it('paints the field, the LOS in its colour and the stands, in every weather and lighting, without throwing', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    for (const [w, lighting] of [[null, 'day'], [weather('rain'), 'overcast'], [weather('snow', 20), 'overcast'], [weather('clear'), 'night'], [null, 'indoor']] as const) {
      const world = layer();
      const scene = { ...sceneFromPlay(f.state, null, 0), lighting };
      drawWorldScene(world, camAt(26.65, f.state.losY, CLOSE_ZOOM.standard), scene, options({ weather: w }), new Map());
      expect(world.used).toBe(true);
      expect(world.ctx.fillsWith(theme.colors.los).length).toBeGreaterThan(0);
    }
    // the whole-field view reaches the stands, walls and posts
    const wide = layer();
    drawWorldScene(wide, camAt(26.65, 60, 3.7), sceneFromPlay(f.state, null, 0), options(), new Map());
    expect(wide.ctx.fills.length).toBeGreaterThan(1000);
    expect(wide.ctx.fillsWith('#f2d33c').length).toBeGreaterThan(0);
  });

  it('derives impact effects from a recorded play at the spot of the tackle, identically on every pass', () => {
    const store = createReplayStore('lastPlay');
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 11, recordFrames: true }, {}, { recordFrames: true, replayStore: store });
    const rec = store.get(engine.run().replayId as string);
    if (!rec) throw new Error('no recording');
    // the helper's play has no tackle: add one mid-play, the carrier being the first athlete of that frame
    const mid = rec.frames[Math.floor(rec.frames.length / 2)];
    const carrier = mid?.athletes[0];
    const tackler = mid?.athletes[1];
    if (!mid || !carrier || !tackler) throw new Error('fixture');
    const withTackle = { ...rec, events: [...rec.events, { type: 'tackle' as const, tick: mid.tick, tackler: tackler.id, carrier: carrier.id, kind: 'hitStick' as const, assists: [] }] };
    const scene = sceneFromReplay(withTackle, rec.frames.length - 1);
    const a = sceneEmitters(camAt(26.65, 60, 11), scene, 'none', true);
    const b = sceneEmitters(camAt(26.65, 60, 11), scene, 'none', true);
    expect(a).toEqual(b);
    const dust = a.find((e) => e.kind === 'dust');
    expect(dust).toBeDefined();
    expect(Math.hypot((dust?.x ?? 99) - carrier.x, (dust?.y ?? 99) - carrier.y)).toBeLessThan(0.01);
    expect(a.some((e) => e.kind === 'sweatSpray')).toBe(true);
    const ctx = createFakeCtx();
    for (const e of a) for (const t of [0, LIFETIME[e.kind] / 2]) drawEmitter(ctx, e, t, 100, 100, 1, true, '#c8c09a', 11);
    expect(ctx.fills.length).toBeGreaterThan(0);
  });

  it('draws puffs as round pixel discs with one even alpha (no overlapping rects, no square corners)', () => {
    for (const r of [2, 3, 4, 6]) {
      const ctx = createFakeCtx();
      puff(ctx, 50, 50, r);
      const covered = new Map<string, number>();
      for (const f of ctx.fills) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) covered.set(`${x},${y}`, (covered.get(`${x},${y}`) ?? 0) + 1);
      expect(Math.max(...covered.values())).toBe(1);
      // the corners of the bounding square stay empty (a disc, not a box), the centre rows are full width
      expect(covered.has(`${50 - r},${50 - r}`)).toBe(false);
      expect(covered.has(`${50 + r - 1},${50 + r - 1}`)).toBe(false);
      expect(covered.has(`${50 - r},50`)).toBe(true);
      expect(covered.has(`${50 + r - 1},${49}`)).toBe(true);
    }
    // breath in the cold is a small puff: never wider than 6 px at the close tier
    const ctx = createFakeCtx();
    for (const t of [0, 0.2, 0.4, 0.59]) drawEmitter(ctx, { kind: 'breath', x: 0, y: 0, lift: 1.55, tick: 0, seed: 3 }, t, 100, 100, 1, true, '#c8c09a', 10.5);
    for (const f of ctx.fills) expect(f.w).toBeLessThanOrEqual(6);
  });

  it('puffs dust from engaged linemen every 0.4 s and breath every 2-3 s', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const scene = sceneFromPlay(f.state, null, 0);
    const lineman = { ...scene.athletes.find((a) => a.side === 'defense'), state: 'engaged' as const };
    const starts = new Set<number>();
    for (let t = 0; t < 240; t++) for (const e of driveEmitters([lineman as (typeof scene.athletes)[number]], t)) starts.add(e.tick);
    expect(starts.size).toBeGreaterThanOrEqual(9);
    expect(starts.size).toBeLessThanOrEqual(11);
    let breaths = 0;
    for (let t = 0; t < 600; t += 6) breaths += breathEmitters(scene.athletes, t).length;
    expect(breaths).toBeGreaterThan(0);
  });

  it('draws ground-level dust in the sorted pass just in front of the feet it rises from, never over the bodies', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const base = sceneFromPlay(f.state, null, 0);
    const d = base.athletes.find((a) => a.side === 'defense');
    if (!d) throw new Error('fixture');
    const scene = { ...base, tick: 400, athletes: base.athletes.map((a) => (a.id === d.id ? { ...a, state: 'engaged' as const } : a)) };
    const camera = camAt(d.x, d.y, CLOSE_ZOOM.standard);
    const dust = '#d9cda6';
    // find a tick where the lineman's periodic puff is alive
    let tick = 400;
    while (!driveEmitters([{ ...d, state: 'engaged' }], tick).some((e) => (tick - e.tick) / 60 < LIFETIME.dust * 0.5)) tick++;
    const ctx = createFakeCtx();
    const args = { ctx, camera, scene: { ...scene, tick }, opts: options(), wd: WD, tier: 1 as const, tierScale: 1, animate: true, figures: [] };
    const objs = effectSortedObjects(args, { dust, grass: true });
    const feetY = Math.round(camera.worldToScreen({ x: d.x, y: d.y }).y * WD);
    expect(objs.length).toBeGreaterThan(0);
    expect(objs.some((o) => Math.abs(o.y - (feetY + 0.1)) < 1e-6)).toBe(true);
    // the airborne pass leaves the dust to the sorted pass
    drawEffects(args, { dust, grass: true });
    expect(ctx.fillsWith(dust)).toHaveLength(0);
    for (const o of objs) o.draw();
    const puffs = ctx.fillsWith(dust);
    expect(puffs.length).toBeGreaterThan(0);
    // a ground puff stays at the feet: within 8 art px above the ground spot, never up at the torso
    for (const p of puffs) expect(p.y).toBeGreaterThan(feetY - 12);
    expect([...GROUND_EFFECTS].sort()).toEqual(['chalkPuff', 'dust', 'kickPuff', 'rainSplash']);
  });

  it('treats a downpour as overcast and grows the rain with the precipitation', () => {
    expect(effectiveLighting('day', 'heavyRain')).toBe('overcast');
    expect(effectiveLighting('night', 'heavyRain')).toBe('overcast');
    expect(effectiveLighting('indoor', 'heavyRain')).toBe('indoor');
    expect(effectiveLighting('night', 'clear')).toBe('night');
    expect(effectiveLighting(undefined, null)).toBe('day');
    const w = (type: WeatherState['type'], precipitation: number): WeatherState => ({ ...weather(type), precipitation });
    expect(rainCount(w('clear', 1))).toBe(0);
    expect(rainCount(w('rain', 0.55))).toBeGreaterThanOrEqual(150);
    expect(rainCount(w('rain', 0.9))).toBeGreaterThan(rainCount(w('rain', 0.3)));
    expect(rainCount(w('heavyRain', 0.9))).toBeGreaterThan(rainCount(w('rain', 0.9)));
    expect(rainCount(w('heavyRain', 1))).toBeLessThanOrEqual(300);
  });
});
