import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { Camera, CLOSE_ZOOM } from '@/ui/camera';
import { drawScene, sceneFromPlay, type FieldViewOptions } from '@/ui/game/field-view';
import type { WorldLayer } from '@/ui/render/canvas';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { worldGameInfo } from '@/ui/render/world/game-info';
import { createTheme } from '@/ui/theme';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx } from './fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const options = (over: Partial<FieldViewOptions>): FieldViewOptions => ({
  theme, sprites: new SpriteCache(), palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', time: 0.5, userSide: 'home', ...over,
});

describe('world game info (down box, scoreboard, turf wear)', () => {
  it('is published by the world-layer field view each frame and cleared by a view without it', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const cam = new Camera(480, 270);
    cam.target.x = 26.65;
    cam.target.y = f.state.losY;
    cam.zoom = CLOSE_ZOOM.standard;
    const world = (): WorldLayer => ({ ctx: createFakeCtx() as unknown as CanvasRenderingContext2D, width: 480, height: 270, used: false });
    const scene = sceneFromPlay(f.state, null, 0);
    const info = { down: 3, quarter: 2, homeScore: 14, awayScore: 7 };
    drawScene(createFakeCtx(), cam, scene, options({ world: world(), gameInfo: info }));
    expect(worldGameInfo()).toEqual(info);
    // a replay or practice view passes none: the stale game's facts do not linger
    drawScene(createFakeCtx(), cam, scene, options({ world: world() }));
    expect(worldGameInfo()).toBeNull();
  });
});
