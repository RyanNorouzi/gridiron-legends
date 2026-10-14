import { describe, expect, it, vi } from 'vitest';

const drawn: string[] = [];
vi.mock('@/ui/render/text', async (orig) => {
  const m = await orig<typeof import('@/ui/render/text')>();
  return { ...m, drawText: (...a: Parameters<typeof m.drawText>) => { drawn.push(String(a[1])); return m.drawText(...a); } };
});

import { DEFAULT_SETTINGS } from '@/core/settings';
import { buildHudData, drawHud, windText } from '@/ui/game/hud';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { createTheme } from '@/ui/theme';
import { makeSetup, situation } from '../../game/fixtures';
import { createFakeCtx } from '../render/fake-ctx';

describe('wind readout in games (H2-20)', () => {
  it('names the wind relative to the team with the ball', () => {
    // windDir is where the air moves; +pi/2 blows toward y=120, the way an offense with direction +1 attacks.
    expect(windText({ windDir: Math.PI / 2, windMph: 31 }, 1)).toBe('WIND 31 MPH · TAILWIND');
    expect(windText({ windDir: Math.PI / 2, windMph: 31 }, -1)).toBe('WIND 31 MPH · HEADWIND');
    expect(windText({ windDir: 0, windMph: 12 }, 1)).toBe('WIND 12 MPH · CROSSWIND');
    expect(windText({ windDir: 0, windMph: 3 }, 1)).toBeNull();
  });

  it('the HUD shows it under the down and distance on a windy day, and nothing when calm', () => {
    const setup = makeSetup();
    const palettes = resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, 'none');
    const theme = createTheme(DEFAULT_SETTINGS);
    const windy = situation(setup, { possession: 'home', down: 4, distance: 5, ballOn: 70 });
    windy.weather = { ...windy.weather, type: 'wind', windMph: 31, windDir: -Math.PI / 2 };
    const hud = buildHudData(windy, setup, { palettes });
    expect(hud.wind).toMatch(/^WIND 31 MPH/);
    drawn.length = 0;
    drawHud(createFakeCtx(), theme, hud, 480, 270);
    expect(drawn).toContain(hud.wind);
    const calm = situation(setup, { possession: 'home' });
    calm.weather = { ...calm.weather, windMph: 0 };
    expect(buildHudData(calm, setup, { palettes }).wind).toBeNull();
  });
});
