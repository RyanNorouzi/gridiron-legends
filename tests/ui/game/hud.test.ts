import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createGameState } from '@/game/game-state';
import { outcomeAt } from '@/game/outcome-factory';
import { loadDefaultProfile } from '@/ui/input/schemes';
import { BANNER_SECONDS, BannerQueue, audioEventFor, bannerForGameEvent, bannerForSummary, drawBanner } from '@/ui/game/banners';
import { buildHudData, drawHud, scoreBugRect } from '@/ui/game/hud';
import { accuracyQuality, drawKickMeter } from '@/ui/game/kick-meter-view';
import { hiddenUnderScoreBug, receiverGlyphs, shouldShowTouch, touchLabelsFor } from '@/ui/game/touch-overlay';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { createTheme } from '@/ui/theme';
import { makeSetup } from '../../game/fixtures';
import { buildPlayState } from '../../fixtures/play-state';
import { createFakeCtx } from '../render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const setup = makeSetup();
const palettes = resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, 'none');

describe('HUD data and drawing', () => {
  it('projects the state into the score bug and situation text', () => {
    const state = createGameState(setup);
    state.score = { home: 14, away: 10 };
    state.timeouts = { home: 2, away: 3 };
    state.clock = { quarter: 3, secondsRemaining: 125, running: true, playClock: 40, playClockRunning: false };
    state.possession = 'away';
    state.down = 2;
    state.distance = 7;
    state.ballOn = 66;
    const hud = buildHudData(state, setup, { palettes, resultText: 'PASS +12', pbpLine: 'x' });
    expect(hud.home).toMatchObject({ abbr: 'HAR', score: 14, timeouts: 2 });
    expect(hud.away.score).toBe(10);
    expect(hud.possession).toBe('away');
    expect(hud.period).toBe('Q3');
    expect(hud.clock).toBe('2:05');
    expect(hud.situation).toBe('2ND & 7 · OPP 34');
    expect(hud.playClock).toBeNull();
    expect(hud.clockRunning).toBe(true);
    state.kickoffPending = 'home';
    expect(buildHudData(state, setup, { palettes }).situation).toBe('KICKOFF');
    state.kickoffPending = null;
    state.patPending = 'home';
    expect(buildHudData(state, setup, { palettes }).situation).toBe('POINT AFTER');
    state.overtime = { period: 2, possessions: { home: 1, away: 1 }, firstPossessionResult: null, suddenDeath: true };
    expect(buildHudData(state, setup, { palettes }).period).toBe('OT2');
    state.phase = 'final';
    expect(buildHudData(state, setup, { palettes }).final).toBe(true);
  });

  it('hides the play-by-play caption (bottom sideline) while the ball is live, shows it pre-snap and after', () => {
    const state = createGameState(setup);
    const play = buildPlayState().state;
    play.phase = 'presnap';
    expect(buildHudData(state, setup, { palettes, play, pbpLine: 'LAST PLAY' }).pbpLine).toBe('LAST PLAY');
    play.phase = 'live';
    expect(buildHudData(state, setup, { palettes, play, pbpLine: 'LAST PLAY' }).pbpLine).toBeNull();
    play.phase = 'dead';
    expect(buildHudData(state, setup, { palettes, play, pbpLine: 'LAST PLAY' }).pbpLine).toBe('LAST PLAY');
    expect(buildHudData(state, setup, { palettes, pbpLine: 'LAST PLAY' }).pbpLine).toBe('LAST PLAY');
  });

  it('draws the bug in team colours with pips and text, scaling with large text', () => {
    const state = createGameState(setup);
    const ctx = createFakeCtx();
    drawHud(ctx, theme, buildHudData(state, setup, { palettes, resultText: 'RUN +4', pbpLine: 'A long line of play by play text that should be truncated when it grows too long for the screen' }), 480, 270);
    expect(ctx.fillsWith(palettes.home.primary).length).toBeGreaterThanOrEqual(1);
    expect(ctx.fillsWith(palettes.away.primary).length).toBeGreaterThanOrEqual(1);
    expect(ctx.fillsWith(theme.colors.accent).length).toBeGreaterThan(3);
    expect(ctx.fills.length).toBeGreaterThan(80);
    const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
    expect(scoreBugRect(large, 480).h).toBeGreaterThan(scoreBugRect(theme, 480).h);
    const bigCtx = createFakeCtx();
    drawHud(bigCtx, large, buildHudData(state, setup, { palettes }), 480, 270);
    expect(bigCtx.fills.length).toBeGreaterThan(40);
  });
});

describe('kick meter', () => {
  it('draws only while the meter runs and colours the accuracy cursor by quality', () => {
    const idle = createFakeCtx();
    drawKickMeter(idle, theme, null, 480, 270);
    drawKickMeter(idle, theme, { phase: 'idle', cursor: 0, power: null, accuracy: null }, 480, 270);
    expect(idle.fills).toHaveLength(0);
    const power = createFakeCtx();
    drawKickMeter(power, theme, { phase: 'power', cursor: 0.6, power: null, accuracy: null }, 480, 270);
    expect(power.fillsWith(theme.colors.accent).length).toBeGreaterThan(0);
    const done = createFakeCtx();
    drawKickMeter(done, theme, { phase: 'done', cursor: 0.5, power: 0.8, accuracy: 0.5 }, 480, 270);
    expect(done.fillsWith(theme.colors.success).length).toBeGreaterThan(1);
    const poor = createFakeCtx();
    drawKickMeter(poor, theme, { phase: 'done', cursor: 0.95, power: 0.8, accuracy: 0.95 }, 480, 270);
    expect(poor.fillsWith(theme.colors.danger).length).toBeGreaterThan(0);
    expect(accuracyQuality(0.5)).toBe(1);
    expect(accuracyQuality(0)).toBe(0);
  });

  it('keeps the kick meter labels on its slab at normal and large text', () => {
    for (const t of [theme, createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' })]) {
      const ctx = createFakeCtx();
      drawKickMeter(ctx, t, { phase: 'accuracy', cursor: 0.3, power: 0.7, accuracy: null }, 480, 270);
      const slab = ctx.fillsWith(t.colors.shadow).reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      const label = ctx.fillsWith(t.colors.accent);
      expect(label.length).toBeGreaterThan(0);
      for (const f of label) expect(f.x + f.w).toBeLessThanOrEqual(slab.x + slab.w);
    }
  });
});

describe('banners', () => {
  it('maps controller events and summaries to banners and audio', () => {
    const score = bannerForGameEvent({ type: 'score', side: 'home', kind: 'touchdown', points: 6, score: { home: 6, away: 0 } }, setup);
    expect(score).toEqual({ text: 'TOUCHDOWN', sub: 'HAR', tone: 'good' });
    expect(bannerForGameEvent({ type: 'turnover', from: 'home', to: 'away', kind: 'interception' }, setup)?.text).toBe('INTERCEPTION');
    expect(bannerForGameEvent({ type: 'firstDown', side: 'away' }, setup)).toEqual({ text: 'FIRST DOWN', sub: 'RDG', tone: 'good' });
    const flag = bannerForGameEvent({ type: 'penaltyFlag', side: 'home', accepted: true, penalty: { foul: 'holdingOffense', side: 'offense', yards: 10, playerId: null, automaticFirstDown: false, lossOfDown: false, enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: true } }, setup);
    expect(flag?.text).toBe('FLAG');
    expect(flag?.sub).toContain('HOLDING');
    expect(bannerForGameEvent({ type: 'twoMinute', half: 1 }, setup)?.text).toBe('TWO-MINUTE WARNING');
    expect(bannerForGameEvent({ type: 'halftime', score: { home: 7, away: 3 } }, setup)?.sub).toBe('HAR 7 · RDG 3');
    expect(bannerForGameEvent({ type: 'final', score: { home: 7, away: 3 }, winner: 'home' }, setup)?.sub).toBe('HAR WIN');
    expect(bannerForGameEvent({ type: 'challengeResult', side: 'home', result: 'upheld', booth: false }, setup)?.text).toBe('CALL STANDS');
    expect(bannerForGameEvent({ type: 'decision', decision: { side: 'home', kind: 'playCall', deadlineSec: null } }, setup)).toBeNull();
    const sack = bannerForSummary({ entry: {} as never, outcome: outcomeAt(40, { result: 'sack', yards: -7 }), resultText: '', pbp: [], replayId: null, bigPlay: false, simulated: false });
    expect(sack?.text).toBe('SACK');
    expect(bannerForSummary({ entry: {} as never, outcome: outcomeAt(40, { result: 'pass', yards: 30, bigPlay: true }), resultText: '', pbp: [], replayId: null, bigPlay: true, simulated: false })?.text).toBe('BIG PLAY');
    expect(audioEventFor({ type: 'score', side: 'away', kind: 'fieldGoal', points: 3, score: { home: 0, away: 3 } })).toEqual({ type: 'score', teamSide: 'away', points: 3 });
    expect(audioEventFor({ type: 'firstDown', side: 'home' })).toBeNull();
  });

  it('queues banners one at a time, collapses duplicates and draws the current one', () => {
    const q = new BannerQueue();
    q.push({ text: 'FIRST DOWN', sub: 'HAR', tone: 'good' });
    q.push({ text: 'FIRST DOWN', sub: 'HAR', tone: 'good' });
    q.push({ text: 'TOUCHDOWN', sub: null, tone: 'good' }, 1);
    expect(q.pending).toBe(2);
    expect(q.current?.text).toBe('FIRST DOWN');
    q.update(BANNER_SECONDS + 0.01);
    expect(q.current?.text).toBe('TOUCHDOWN');
    const ctx = createFakeCtx();
    drawBanner(ctx, theme, q.current, 480, 270);
    expect(ctx.fillsWith(theme.colors.success).length).toBeGreaterThan(2);
    q.update(2);
    expect(q.current).toBeNull();
    drawBanner(createFakeCtx(), theme, null, 480, 270);
  });
});

describe('touch overlay helpers', () => {
  it('labels buttons per context from the scheme and decides visibility', () => {
    const scheme = loadDefaultProfile().scheme;
    const carrier = touchLabelsFor('carrier', scheme, ['a', 'b', 'x', 'y', 'rt', 'lt']);
    expect(carrier).toMatchObject({ b: 'JUKE', x: 'SPIN', y: 'STIFF', rt: 'SPRINT', lt: 'DIVE' });
    expect(carrier.a).toBeUndefined();
    const defense = touchLabelsFor('defense', scheme, ['a', 'b', 'rb', 'y']);
    expect(defense).toMatchObject({ a: 'TACKLE', b: 'SWITCH', rb: 'HIT', y: 'SWAT' });
    expect(touchLabelsFor('kick', scheme, ['a', 'b']).a).toBe('KICK');
    expect(touchLabelsFor('presnapOffense', scheme, ['a', 'x', 'y']).a).toBe('SNAP');
    expect(shouldShowTouch('on', 'keyboard')).toBe(true);
    expect(shouldShowTouch('auto', 'touch')).toBe(true);
    expect(shouldShowTouch('auto', 'gamepad')).toBe(false);
    expect(shouldShowTouch('off', 'touch')).toBe(false);
    expect(receiverGlyphs('touch', () => 'A', 3)).toEqual(['1', '2', '3']);
    expect(receiverGlyphs('gamepad', (a) => a.toUpperCase(), 2)).toEqual(['THROW1', 'THROW2']);
    // An idle BACK button in the top-left corner is not drawn over the score bug; an active one, or one elsewhere, is.
    const back = { x: 16, y: 12, r: 9 };
    expect(hiddenUnderScoreBug(back, false, theme)).toBe(true);
    expect(hiddenUnderScoreBug(back, true, theme)).toBe(false);
    expect(hiddenUnderScoreBug({ x: 464, y: 12, r: 9 }, false, theme)).toBe(false);
    expect(hiddenUnderScoreBug({ x: 372, y: 250, r: 10 }, false, theme)).toBe(false);
  });
});
