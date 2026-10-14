import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createGameState } from '@/game/game-state';
import { buildHudData, drawScoreBug, drawSituation, scoreBugRect, splitSituation } from '@/ui/game/hud';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { createTheme } from '@/ui/theme';
import { makeSetup } from '../../game/fixtures';
import { createFakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const setup = makeSetup();
const palettes = resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, 'none');

describe('score bug (slab look)', () => {
  it('carries each team emblem seed and resolved colours', () => {
    const hud = buildHudData(createGameState(setup), setup, { palettes });
    expect(hud.home.logoSeed).toBe(setup.home.team.logoSeed);
    expect(hud.away.colors).toEqual(palettes.away);
  });

  it('draws team tabs, gold timeout pips (spent ones as empty slots) and stays inside its rect', () => {
    const state = createGameState(setup);
    state.timeouts = { home: 1, away: 3 };
    const ctx = createFakeCtx();
    const r = drawScoreBug(ctx, theme, buildHudData(state, setup, { palettes }), 480, 3);
    expect(r).toEqual(scoreBugRect(theme, 480));
    expect(ctx.fillsWith(palettes.home.primary).length).toBeGreaterThan(5);
    expect(ctx.fillsWith(palettes.away.primary).length).toBeGreaterThan(5);
    // 1 + 3 lit pips (the clock is stopped, so gold appears nowhere else but the pips).
    const pips = ctx.fillsWith(theme.colors.accent).filter((f) => f.w === 4);
    expect(pips).toHaveLength(4);
    for (const f of ctx.fills) {
      expect(f.x).toBeGreaterThanOrEqual(r.x - 0.01);
      expect(f.x + f.w).toBeLessThanOrEqual(r.x + r.w + 1.01);
      expect(f.y + f.h).toBeLessThanOrEqual(r.y + r.h + 1.01);
    }
  });

  it('marks possession with a football on the team row that has the ball', () => {
    const state = createGameState(setup);
    const brown = (side: 'home' | 'away'): number[] => {
      state.possession = side;
      const ctx = createFakeCtx();
      drawScoreBug(ctx, theme, buildHudData(state, setup, { palettes }), 480);
      return ctx.fillsWith('#8a4b22').map((f) => f.y);
    };
    const away = brown('away');
    const home = brown('home');
    expect(away.length).toBeGreaterThan(0);
    expect(Math.min(...home)).toBeGreaterThan(Math.max(...away));
  });

  it('turns the play clock red in its last 5 seconds and splits the situation line', () => {
    expect(splitSituation('2ND & 7 · OPP 34')).toEqual({ main: '2ND & 7', spot: 'OPP 34' });
    expect(splitSituation('KICKOFF')).toEqual({ main: 'KICKOFF', spot: null });
    const hud = { ...buildHudData(createGameState(setup), setup, { palettes }), playClock: 4 };
    const bug = scoreBugRect(theme, 480);
    const hot = createFakeCtx();
    drawSituation(hot, theme, hud, bug);
    expect(hot.fillsWith(theme.colors.danger).length).toBeGreaterThan(3);
    const calm = createFakeCtx();
    drawSituation(calm, theme, { ...hud, playClock: 25 }, bug);
    expect(calm.fillsWith(theme.colors.danger)).toHaveLength(0);
  });
});
