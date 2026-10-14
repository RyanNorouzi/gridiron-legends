import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { createGameState } from '@/game/game-state';
import type { PenaltyInfo } from '@/game/play-events';
import { buildHudData } from '@/ui/game/hud';
import { createDefaultPlaycaller } from '@/ui/game/playcaller';
import { buildPlaycallRequest, penaltyAcceptText, situationSummary, spotText } from '@/ui/game/session-flow';
import { createWatchPolicy, situationTitle } from '@/ui/game/watch-policy';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { makeSetup, situation } from '../../game/fixtures';
import { makeSession } from './fixtures';

describe('field position read from the user side of the ball', () => {
  it('spotText flips OWN / OPP for the defense and keeps midfield', () => {
    expect(spotText(14)).toBe('OWN 14');
    expect(spotText(14, true)).toBe('OPP 14');
    expect(spotText(80)).toBe('OPP 20');
    expect(spotText(80, true)).toBe('OWN 20');
    expect(spotText(50, true)).toBe('50');
    expect(spotText(49.6, true)).toBe('50');
    // Never a goal line: a spot short of it reads as the 1.
    expect(spotText(99.5)).toBe('OPP 1');
    expect(spotText(0.047)).toBe('OWN 1');
    expect(spotText(99.6, true)).toBe('OWN 1');
  });

  it('situationSummary reads the spot from the viewer (offense view for spectators)', () => {
    const s = { kickoffPending: null, patPending: null, down: 2, distance: 7, ballOn: 14, phase: 'playcall' as const, possession: 'away' as const };
    expect(situationSummary(s)).toBe('2ND & 7 · OWN 14');
    expect(situationSummary(s, 'away')).toBe('2ND & 7 · OWN 14');
    expect(situationSummary(s, 'home')).toBe('2ND & 7 · OPP 14');
  });

  it('the defensive play call, the HUD and the watch prompt say OPP 14 while the user defends at the offense own 14', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    const setup = f.setup;
    const clock = { quarter: 4, secondsRemaining: 100, running: false, playClock: 40, playClockRunning: false };
    const st = situation(setup, { possession: 'away', down: 3, distance: 6, ballOn: 14, clock });
    const def = buildPlaycallRequest(st, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(def.unit).toBe('defense');
    expect(def.summary).toBe('3RD & 6 · OPP 14');
    const off = buildPlaycallRequest(st, setup, 'away', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(off.summary).toBe('3RD & 6 · OWN 14');
    const palettes = resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, 'none');
    expect(buildHudData({ ...st, userSide: 'home' }, setup, { palettes }).situation).toBe('3RD & 6 · OPP 14');
    expect(buildHudData({ ...st, userSide: null }, setup, { palettes }).situation).toBe('3RD & 6 · OWN 14');
    // Watching (nobody at the controls on the user's side): the offense's own 14 is not the "OPP 14".
    expect(buildHudData({ ...st, userSide: 'home', controllers: { home: 'ai', away: 'ai' } }, setup, { palettes }).situation).toBe('3RD & 6 · OWN 14');
    expect(situationTitle(st, 'home')).toBe('3RD & 6 · OPP 14');
    const tied = { ...st, score: { home: 7, away: 7 } };
    expect(createWatchPolicy().shouldPrompt(tied, 'home')?.title).toBe('3RD & 6 · OPP 14');
  });

  it('penalty wording names the spot from the deciding side', () => {
    const dpi: PenaltyInfo = {
      foul: 'passInterferenceDefense', side: 'defense', yards: 0, playerId: null, automaticFirstDown: true, lossOfDown: false,
      enforcement: 'spotOfFoul', spotBallOn: 88, deadBall: false, replayDown: true, accepted: false,
    };
    expect(penaltyAcceptText(dpi)).toContain('OPP 12');
    expect(penaltyAcceptText(dpi, true)).toContain('OWN 12');
  });

  it('a game state with no user side keeps the offense view', () => {
    const setup = makeSetup();
    const state = createGameState(setup);
    expect(state.userSide).toBeNull();
    expect(situationSummary({ ...state, phase: 'playcall', kickoffPending: null, ballOn: 30, possession: 'home' }, state.userSide)).toContain('OWN 30');
  });
});
