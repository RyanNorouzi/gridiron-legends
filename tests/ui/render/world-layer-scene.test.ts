import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createReplayStore } from '@/game/replay';
import { Camera, CLOSE_ZOOM } from '@/ui/camera';
import { drawScene, pileLifts, sceneFromPlay, type FieldScene, type FieldViewOptions } from '@/ui/game/field-view';
import { MAX_RENDER_OFFSET, painterFor, registerPainter } from '@/ui/render/anim';
import { registerLookOverride } from '@/ui/render/anim-select';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { drawWorldScene, registerSortedObjects, setWorldPass, viewMemory, type PlacedFigure } from '@/ui/render/world-layer-scene';
import { WD } from '@/ui/render/world-layer';
import { sceneFromReplay } from '@/ui/screens/replay';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { build } from '../../game/engine/helpers';
import { createFakeCtx, type FakeCtx } from './fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const layer = (): WorldLayer & { ctx: FakeCtx } => ({ ctx: createFakeCtx(), width: 480, height: 270, used: false });
const options = (over: Partial<FieldViewOptions> = {}): FieldViewOptions => ({
  theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home', ...over,
});
const closeCamera = (y: number): Camera => {
  const c = new Camera(480, 270);
  c.target.x = 26.65;
  c.target.y = y;
  c.zoom = CLOSE_ZOOM.standard;
  return c;
};
const lookKey = (f: PlacedFigure): string => `${f.scene.id}:${f.look.clip}:${f.look.frame}:${f.look.facing}`;

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** A real engine play (default AI), recorded. */
const recordedPlay = () => {
  const store = createReplayStore('lastPlay');
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 11, recordFrames: true }, {}, { recordFrames: true, replayStore: store });
  const o = engine.run();
  const rec = store.get(o.replayId as string);
  if (!rec) throw new Error('no recording');
  return rec;
};

describe('world scene compositor', () => {
  it('draws on the world layer only, and the field view keeps just the overlays on the UI surface', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const world = layer();
    const ui = createFakeCtx();
    const cam = closeCamera(f.state.losY);
    drawScene(ui, cam, sceneFromPlay(f.state, null, 0), options({ world, routes: f.routes, showPlayArt: true }));
    expect(world.used).toBe(true);
    expect(world.ctx.fills.length).toBeGreaterThan(200);
    // route art stays on the logical surface; no field paint there
    expect(ui.fillsWith(theme.colors.accent2).length).toBeGreaterThan(0);
    expect(ui.fills.filter((r) => r.w >= 480 && r.h >= 270)).toHaveLength(0);
    expect(ui.fillsWith(theme.colors.los)).toHaveLength(0);
    // the controlled-player ring is on the ground, under the figures
    expect(world.ctx.fillsWith('#ffd23f').length).toBeGreaterThan(20);
  });

  it('shows a chunky retro runner (about 1.5 yd wide, under 30 px tall) at the CLOSE zoom', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = closeCamera(f.state.losY);
    const figures = drawWorldScene(layer(), cam, sceneFromPlay(f.state, null, 0), options(), new Map());
    // the CLOSE view shows ~46 yd x 26 yd: the wide receivers split out by the sidelines may be off screen
    expect(figures.length).toBeGreaterThanOrEqual(18);
    // an upright receiver running across the screen at the CLOSE tier: the retro 3/4 view shows his chest and both
    // pads, so he spans about a yard and a half of field on the one 480x270 grid
    const wr = figures.find((q) => q.scene.position === 'WR') ?? figures[0];
    const painter = wr ? painterFor('run') : null;
    const frame = wr && painter ? painter.paint({ ...wr.req, build: 'slim', clip: 'run', frame: 0, facing: 'e' }) : undefined;
    expect(frame?.rgba).toBeDefined();
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = 0; y < (frame?.height ?? 0); y++) {
      for (let x = 0; x < (frame?.width ?? 0); x++) {
        if ((frame?.rgba?.[(y * (frame?.width ?? 0) + x) * 4 + 3] ?? 0) > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      }
    }
    const widthYd = (maxX - minX + 1) / (CLOSE_ZOOM.standard * WD);
    expect(widthYd).toBeGreaterThan(1.1);
    expect(widthYd).toBeLessThan(1.8);
    expect(frame?.height).toBeLessThanOrEqual(30);
    const presnap = figures.find((q) => q.scene.position === 'OT');
    expect(presnap?.look.clip).toBe('stance3');
  });

  it('clamps any render offset to MAX_RENDER_OFFSET and lets passes and sorted objects plug in', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = closeCamera(f.state.losY);
    cleanups.push(registerLookOverride((_ctx, core) => new Map([...core].map(([id, l]) => [id, { ...l, dx: 100, dy: -100 }]))));
    let ground = 0;
    setWorldPass('ground', () => { ground++; });
    cleanups.push(() => setWorldPass('ground', null));
    let drawn = 0;
    cleanups.push(registerSortedObjects(() => [{ y: 0, draw: () => { drawn++; } }]));
    const figures = drawWorldScene(layer(), cam, sceneFromPlay(f.state, null, 0), options(), new Map());
    for (const q of figures) {
      expect(Math.abs(q.x - q.p.x)).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
      expect(Math.abs(q.y - q.p.y)).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
    }
    expect(ground).toBe(1);
    expect(drawn).toBe(1);
  });

  it('draws a body lifted onto a pile over the body beneath it, with its shadow and ring on the ground', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = closeCamera(f.state.losY);
    const scene = sceneFromPlay(f.state, null, 0);
    const [under, over] = scene.athletes.filter((a) => a.side === 'defense');
    if (!under || !over) throw new Error('fixture');
    // two bodies down 0.1 yd apart: the lower one on screen is lifted 2 lpx (2 art px on the 1x grid) onto the other
    Object.assign(under, { x: 20, y: f.state.losY + 2, state: 'down' });
    Object.assign(over, { x: 20.1, y: f.state.losY + 2, state: 'down' });
    const lifts = pileLifts([under, over]);
    expect(lifts.get(over.id)).toBe(2);
    const order: number[] = [];
    cleanups.push(registerPainter({ id: 'order', paint: () => ({ width: 1, height: 1, ax: 0, ay: 0 }), decorate: (_c, _f, r) => { order.push(r.number); } }));
    const figures = drawWorldScene(layer(), cam, scene, options(), lifts);
    const fo = figures.find((q) => q.scene.id === over.id);
    const fu = figures.find((q) => q.scene.id === under.id);
    expect(fo && fo.groundY - fo.y).toBe(2);
    expect(fu && fu.groundY - fu.y).toBe(0);
    expect(order.indexOf(over.number)).toBeGreaterThan(order.indexOf(under.number));
  });

  it('never resets the animation memory while a play stands still (paused, dead ball) and runs the dead-ball clock on', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = closeCamera(f.state.losY);
    const buffer = { athletePos: (_id: string, p: { x: number; y: number; facing: number }) => p, ballPos: (p: { x: number; y: number; z: number }) => p } as never;
    const mem = viewMemory(cam);
    drawWorldScene(layer(), cam, sceneFromPlay(f.state, buffer, 0.9, { time: 0 }), options(), new Map());
    const resets = mem.resets;
    // the loop alpha keeps wrapping while the sim tick stands still
    for (let k = 1; k <= 40; k++) drawWorldScene(layer(), cam, sceneFromPlay(f.state, buffer, (k % 4) / 4, { time: k / 60, paused: true }), options(), new Map());
    expect(mem.resets).toBe(resets);
    const held = mem.tick;
    f.state.phase = 'dead';
    const at = (time: number, paused = false): number => sceneFromPlay(f.state, buffer, 0.5, { time, paused }).tick ?? Number.NaN;
    expect(at(0.8)).toBeCloseTo(held + 8, 5);
    expect(at(0.9, true)).toBeCloseTo(held + 8, 5);
    expect(at(1)).toBeCloseTo(held + 14, 5);
    // a long hitch catches up at most SCENE_CLOCK_MAX_GAP (0.25 s)
    expect(at(9)).toBeCloseTo(held + 29, 5);
  });

  it('gives a replay the same looks as playing it through, and a seek the same looks as getting there', () => {
    const rec = recordedPlay();
    const last = rec.frames.length - 1;
    const sample = (cam: Camera, i: number): string[] => {
      const scene: FieldScene = sceneFromReplay(rec, i);
      cam.target.y = scene.ball.y;
      return drawWorldScene(layer(), cam, scene, options(), new Map()).map(lookKey).sort();
    };
    const camA = closeCamera(rec.losY);
    const camB = closeCamera(rec.losY);
    const through: string[][] = [];
    for (let i = 0; i <= last; i++) through.push(sample(camA, i));
    // an identical second viewing (slow motion: half-frame steps) shows identical looks on every whole frame
    for (let i = 0; i <= last; i++) {
      expect(sample(camB, i)).toEqual(through[i]);
      if (i < last) sample(camB, i + 0.5);
    }
    // seeking straight to a late frame (memory rebuilt) matches for the event- and state-driven looks
    const camC = closeCamera(rec.losY);
    const k = Math.floor(last * 0.8);
    const seek = sample(camC, k);
    const same = seek.filter((s, j) => s === through[k]?.[j]).length;
    expect(same / seek.length).toBeGreaterThan(0.85);
  });
});
