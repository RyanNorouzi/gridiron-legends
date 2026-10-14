import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { vec2 } from '@/core/vec2';
import { Camera } from '@/ui/camera';
import { drawPlayState, focusFromScene, sceneFromPlay, southTeamFor } from '@/ui/game/field-view';
import { SnapshotBuffer } from '@/ui/game/interp';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const options = (over: Partial<Parameters<typeof drawPlayState>[5]> = {}): Parameters<typeof drawPlayState>[5] => ({
  theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home', ...over,
});

const cameraOn = (y: number): Camera => {
  const c = new Camera(480, 270);
  c.target.x = 160 / 6;
  c.target.y = y;
  c.zoom = 6;
  return c;
};

describe('field view', () => {
  it('draws the field, both teams as sprites and the ball for a real play state', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const ctx = createFakeCtx();
    const scene = drawPlayState(ctx, cameraOn(f.state.losY), f.state, null, 0, options());
    expect(scene.athletes).toHaveLength(22);
    expect(ctx.fills.length).toBeGreaterThan(400);
    expect(ctx.fillsWith('rgb(192,32,32)').length).toBeGreaterThan(0);
    expect(ctx.fillsWith('rgb(32,64,192)').length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.los).length).toBeGreaterThan(1);
    expect(ctx.fillsWith(theme.colors.firstDown).length).toBeGreaterThan(1);
    expect(ctx.fillsWith(theme.colors.accent).length).toBeGreaterThan(0);
  });

  it('shows receiver glyphs when the controlled QB holds the ball and the route overlay pre-snap', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const qb = f.byRole('offense', 'QB');
    const plain = createFakeCtx();
    drawPlayState(plain, cameraOn(f.state.losY), f.state, null, 0, options({ receiverSlots: ['WR3', 'TE1'], receiverGlyphs: ['A', 'B'] }));
    const withArt = createFakeCtx();
    drawPlayState(withArt, cameraOn(f.state.losY), f.state, null, 0, options({ routes: f.routes, showPlayArt: true }));
    expect(withArt.fillsWith(theme.colors.accent2).length).toBeGreaterThan(plain.fillsWith(theme.colors.accent2).length);
    f.state.phase = 'live';
    qb.hasBall = true;
    f.state.ball.carrierId = qb.id;
    f.state.ball.phase = 'held';
    const held = createFakeCtx();
    drawPlayState(held, cameraOn(f.state.losY), f.state, null, 0, options({ receiverSlots: ['WR3', 'TE1'], receiverGlyphs: ['A', 'B'] }));
    expect(held.fillsWith(theme.colors.shadow).length).toBeGreaterThan(plain.fillsWith(theme.colors.shadow).length);
  });

  it('draws an airborne ball with a shadow and switch hints on defense', () => {
    const f = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    f.state.phase = 'live';
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'pass';
    f.state.ball.z = 4;
    const ctx = createFakeCtx();
    const scene = drawPlayState(ctx, cameraOn(f.state.losY), f.state, null, 0, options({ userSide: 'away', switchHints: true }));
    expect(scene.ball.phase).toBe('inAir');
    expect(ctx.fillsWith(theme.colors.shadow).length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.accent2).length).toBeGreaterThan(0);
  });

  it('interpolates athlete and ball positions between the last two ticks', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const buffer = new SnapshotBuffer();
    const qb = f.byRole('offense', 'QB');
    buffer.capture(f.state);
    expect(buffer.prev).toBeNull();
    f.state.tick = 1;
    qb.pos.x += 2;
    f.state.ball.pos.y += 4;
    buffer.capture(f.state);
    const half = sceneFromPlay(f.state, buffer, 0.5);
    const shown = half.athletes.find((a) => a.id === qb.id)!;
    expect(shown.x).toBeCloseTo(qb.pos.x - 1);
    expect(half.ball.y).toBeCloseTo(f.state.ball.pos.y - 2);
    expect(sceneFromPlay(f.state, buffer, 1).athletes.find((a) => a.id === qb.id)!.x).toBeCloseTo(qb.pos.x);
    f.state.tick = 0;
    buffer.capture(f.state);
    expect(buffer.prev).toBeNull();
    expect(buffer.ballPos({ x: 1, y: 2, z: 3 }, 0.5)).toEqual({ x: 1, y: 2, z: 3 });
    expect(buffer.athletePos('nope', { x: 1, y: 2, facing: 0 }, 0.5)).toEqual({ x: 1, y: 2, facing: 0 });
    expect(vec2(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('route overlay', () => {
  it('draws the leg from the athlete to the first waypoint (routes rarely start at the alignment)', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const ctx = createFakeCtx();
    const routes = { WR3: { id: 'go', type: 'go' as const, waypoints: [{ dx: 0, dy: 30 }], breakTime: 2, depth: 30, scramble: 'continue' as const } };
    drawPlayState(ctx, cameraOn(f.state.losY), f.state, null, 0, options({ routes, showPlayArt: true }));
    expect(ctx.fillsWith(theme.colors.accent2).length).toBeGreaterThan(5);
  });
});

describe('end zones follow the teams when they change ends', () => {
  it('the y = 0 end zone belongs to the team whose own goal line it is (swaps with the direction)', () => {
    expect(southTeamFor('home', 1)).toBe('home');
    expect(southTeamFor('home', -1)).toBe('away');
    expect(southTeamFor('away', 1)).toBe('away');
    expect(southTeamFor('away', -1)).toBe('home');
    const f = buildPlayState({ offense: 'home', direction: -1 });
    expect(sceneFromPlay(f.state, null, 1).southTeam).toBe('away');
    const g = buildPlayState({ offense: 'away', direction: -1 });
    expect(sceneFromPlay(g.state, null, 1).southTeam).toBe('home');
  });
});

describe('camera focus for the CLOSE zoom', () => {
  it('drawing a scene hands the camera the pre-snap spread of the offense (and no aim spot)', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = cameraOn(f.state.losY);
    const scene = drawPlayState(createFakeCtx(), cam, f.state, null, 0, options());
    expect(scene.aimSpot).toBeNull();
    expect(cam.focus).toEqual(focusFromScene(scene));
    const offense = scene.athletes.filter((a) => a.side === 'offense' && a.active).map((a) => a.x);
    if (scene.presnap) expect(cam.focus?.spreadX).toEqual({ min: Math.min(...offense), max: Math.max(...offense) });
    else expect(cam.focus?.spreadX).toBeNull();
  });

  it('passes an aim spot on after the snap only, and no spread then', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const scene = sceneFromPlay(f.state, null, 0);
    const spot = vec2(10, 80);
    expect(focusFromScene({ ...scene, presnap: false, aimSpot: spot })).toEqual({ presnap: false, spreadX: null, aimSpot: spot });
    expect(focusFromScene({ ...scene, presnap: true, aimSpot: spot }).aimSpot).toBeNull();
    expect(focusFromScene({ ...scene, presnap: true }).spreadX).not.toBeNull();
  });
});
