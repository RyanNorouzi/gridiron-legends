import { describe, expect, it, vi } from 'vitest';
import type { PlayContext, PlayOutcome, ReplayRecording } from '@/game/play-types';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayLogEntry } from '@/game/types';
import { bannerForGameEvent } from '@/ui/game/banners';
import { HighlightReel, highlightKind, isGoAheadLate } from '@/ui/game/highlights';
import { postPlayControls, recordingFor } from '@/ui/game/postplay-controls';
import { touchLabelsFor } from '@/ui/game/touch-overlay';
import { loadDefaultProfile } from '@/ui/input/schemes';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { GameScreen } from '@/ui/screens/game';
import { HighlightsScreen } from '@/ui/screens/highlights';
import { PauseScreen } from '@/ui/screens/pause';
import { REPLAY_CAMERA_NAMES, ReplayScreen, replayTime } from '@/ui/screens/replay';
import { layoutHintButtons } from '@/ui/widgets/hint-buttons';
import { makeInput, pointerAt } from '../render/fake-ctx';
import { pid } from '../../game/fixtures';
import { autoplay, baseScript, makeSession, makeUi } from './fixtures';

const rec = (frames = 30, id = 'r'): ReplayRecording => ({
  id, playIndex: 0, tickRate: 60, snapTick: 2, direction: 1, losY: 40, firstDownY: 50,
  athletes: [{ id: 'off:QB', playerId: pid('p1'), teamSide: 'home', position: 'QB', number: 7, name: 'Q' }, { id: 'def:FS', playerId: pid('p2'), teamSide: 'away', position: 'FS', number: 21, name: 'F' }],
  frames: Array.from({ length: frames }, (_, i) => ({ tick: i, athletes: [{ id: 'off:QB', x: 26, y: 35 + i * 0.2, facing: 1.57, state: 'moving' as const, hasBall: true }, { id: 'def:FS', x: 30, y: 55 - i * 0.2, facing: -1.57, state: 'moving' as const, hasBall: false }], ball: { x: 26, y: 35 + i * 0.2, z: 0, phase: 'held' as const } })),
  events: [],
});
const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
const view = { palettes, fieldType: 'grass' as const, weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', userSide: 'home' as const };
const centreOf = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });

describe('replay controls', () => {
  it('every control is a tappable button (touch and mouse), camera angles cycle and are named', () => {
    const ui = makeUi();
    const screen = new ReplayScreen(rec(), view);
    ui.stack.push(screen);
    screen.render(ui.rc);
    const ids = screen.buttonRects.map((b) => b.id);
    expect(ids).toEqual(['play', 'slow', 'fast', 'back1', 'fwd1', 'camera', 'close']);
    const tap = (id: string, device: 'touch' | 'mouse' = 'touch') => {
      const r = screen.buttonRects.find((b) => b.id === id);
      if (!r) throw new Error(`no ${id}`);
      const c = centreOf(r);
      // A mouse click also raises confirm / play-pause (button a), like the real input map.
      screen.update(1 / 60, makeInput({ pointer: pointerAt(c.x, c.y, true), device, pressed: device === 'mouse' ? ['confirm', 'replayPlayPause'] : [] }), ui.services);
      screen.render(ui.rc);
    };
    expect(screen.isPlaying).toBe(true);
    tap('play', 'mouse');
    expect(screen.isPlaying).toBe(false);
    tap('slow');
    tap('slow');
    expect(screen.speed).toBe(0.25);
    tap('fast', 'mouse');
    expect(screen.speed).toBe(0.5);
    expect(screen.isPlaying).toBe(false);
    tap('fwd1');
    tap('fwd1');
    expect(screen.position).toBe(2);
    tap('back1');
    expect(screen.position).toBe(1);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      seen.add(screen.cameraMode ?? '');
      tap('camera');
    }
    expect([...seen].sort()).toEqual(Object.keys(REPLAY_CAMERA_NAMES).sort());
    tap('close');
    expect(ui.stack.size).toBe(0);
  });

  it('a click on the field toggles play once; holding a step key scrubs; buttons wrap inside the screen in large text', () => {
    const ui = makeUi({ textSize: 'large' });
    const screen = new ReplayScreen(rec(120), view);
    ui.stack.push(screen);
    screen.render(ui.rc);
    for (const r of screen.buttonRects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(480);
      expect(r.y + r.h).toBeLessThanOrEqual(270);
    }
    expect(new Set(screen.buttonRects.map((r) => r.y)).size).toBeGreaterThan(1);
    screen.update(1 / 60, makeInput({ pointer: pointerAt(240, 60, true), device: 'mouse', pressed: ['confirm', 'replayPlayPause'] }), ui.services);
    expect(screen.isPlaying).toBe(false);
    const start = screen.position;
    for (let i = 0; i < 60; i++) screen.update(1 / 60, makeInput({ down: ['replayStepForward'] }), ui.services);
    expect(screen.position).toBeGreaterThan(start + 10);
  });

  it('a quick click or tap on the scrubber seeks there (press and release inside one frame), a drag follows the pointer', () => {
    const ui = makeUi();
    const screen = new ReplayScreen(rec(101), view);
    ui.stack.push(screen);
    screen.render(ui.rc);
    const t = ui.services.theme;
    const barY = Math.min(...screen.buttonRects.map((b) => b.y)) - t.gap - 3 * t.textScale;
    const quick = { x: 240, y: barY, down: false, justDown: true, justUp: true, drag: null };
    screen.update(1 / 60, makeInput({ pointer: quick, device: 'mouse', pressed: ['confirm', 'replayPlayPause'] }), ui.services);
    expect(screen.isPlaying).toBe(false);
    expect(screen.position).toBeGreaterThan(40);
    expect(screen.position).toBeLessThan(60);
    screen.update(1 / 60, makeInput({ pointer: { ...quick, x: 60 }, device: 'touch' }), ui.services);
    expect(screen.position).toBeLessThan(15);
    screen.update(1 / 60, makeInput({ pointer: pointerAt(240, barY, true), device: 'touch' }), ui.services);
    screen.update(1 / 60, makeInput({ pointer: { x: 400, y: barY - 30, down: true, justDown: false, justUp: false, drag: null }, device: 'touch' }), ui.services);
    expect(screen.position).toBeGreaterThan(80);
  });

  it('reads position and length in one format with tenths', () => {
    expect([replayTime(6.64), replayTime(10.6), replayTime(0), replayTime(62.46), replayTime(59.97)]).toEqual(['6.6', '10.6', '0.0', '1:02.5', '1:00.0']);
  });

  it('offers the challenge flag while the window is open (LT / C or the button) and closes on success', () => {
    const ui = makeUi();
    let open = true;
    const onChallenge = vi.fn(() => true);
    const screen = new ReplayScreen(rec(), { ...view, challenge: { available: () => open, onChallenge, secondsLeft: () => 4.2 } });
    ui.stack.push(screen);
    screen.render(ui.rc);
    expect(screen.controls(ui.services).find((c) => c.id === 'flag')?.label).toBe('CHALLENGE 5s');
    screen.update(1 / 60, makeInput({ pressed: ['callTimeout'] }), ui.services);
    expect(onChallenge).toHaveBeenCalledTimes(1);
    expect(ui.stack.size).toBe(0);
    open = false;
    const again = new ReplayScreen(rec(), { ...view, challenge: { available: () => open, onChallenge } });
    ui.stack.push(again);
    again.render(ui.rc);
    expect(again.buttonRects.some((b) => b.id === 'flag')).toBe(false);
  });

  it('lays hint buttons out right-aligned, wrapping upward', () => {
    const ui = makeUi();
    const hints = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, glyph: 'X', label: 'LONGER LABEL' }));
    const rects = layoutHintButtons(ui.services.theme, hints, 480, 250);
    expect(rects).toHaveLength(12);
    expect(Math.max(...rects.map((r) => r.y))).toBe(250);
    expect(rects.every((r) => r.x >= 0 && r.x + r.w <= 480)).toBe(true);
  });
});

const entry = (o: Partial<PlayOutcome>, e: Partial<PlayLogEntry> = {}): PlayLogEntry => ({
  index: 3, quarter: 2, clock: 400, possession: 'home', down: 1, distance: 10, ballOn: 30, ballX: 26, offensivePlayId: null, defensivePlayId: null,
  outcome: outcomeAt(30, { result: 'run', yards: 3, timeElapsed: 5, ...o }, 'home'), scoreAfter: { home: 0, away: 0 }, review: null, ...e,
});

describe('highlights', () => {
  it('classifies touchdowns, turnovers, long gains, sacks, big hits and late go-ahead scores', () => {
    expect(highlightKind(entry({ touchdown: true, yards: 5 }).outcome)).toBe('touchdown');
    expect(highlightKind(entry({ result: 'interception', turnover: true, turnoverType: 'interception' }).outcome)).toBe('interception');
    expect(highlightKind(entry({ result: 'run', yards: 24 }).outcome)).toBe('longRun');
    expect(highlightKind(entry({ result: 'pass', yards: 30 }).outcome)).toBe('longCatch');
    expect(highlightKind(entry({ result: 'sack', yards: -7 }).outcome)).toBe('sack');
    expect(highlightKind(entry({ events: [{ type: 'tackle', tick: 40, tackler: 'def:LB1', carrier: 'off:RB', kind: 'hitStick', assists: [] }] }).outcome)).toBe('bigHit');
    expect(highlightKind(entry({ result: 'run', yards: 4 }).outcome)).toBeNull();
    const late = entry({ result: 'fieldGoal', points: 3, scoringSide: 'home' }, { quarter: 4, clock: 30, scoreAfter: { home: 20, away: 18 } });
    expect(isGoAheadLate(late)).toBe(true);
    expect(highlightKind(late.outcome, late)).toBe('gameWinner');
    expect(isGoAheadLate({ ...late, quarter: 3 })).toBe(false);
    expect(isGoAheadLate({ ...late, scoreAfter: { home: 30, away: 18 } })).toBe(false);
  });

  it('keeps recordings of highlight plays, dropping the least important when full', () => {
    const reel = new HighlightReel(2);
    expect(reel.offer(entry({ result: 'run', yards: 3 }), rec(5, 'a'))).toBeNull();
    expect(reel.offer(entry({ result: 'sack', yards: -5 }), rec(5, 'b'))?.title).toBe('SACK');
    expect(reel.offer(entry({ result: 'sack', yards: -5 }), rec(5, 'b'))).toBeNull();
    expect(reel.offer(entry({ touchdown: true }), rec(5, 'c'))?.kind).toBe('touchdown');
    expect(reel.offer(entry({ result: 'pass', yards: 40 }), rec(5, 'd'))?.kind).toBe('longCatch');
    expect(reel.list.map((h) => h.id)).toEqual(['c', 'd']);
    expect(reel.offer(entry({ result: 'sack', yards: -5 }), rec(5, 'e'))).toBeNull();
    expect(reel.offer(entry({ touchdown: true }), null)).toBeNull();
  });
});

describe('challenge flow', () => {
  it('result banners say who wins and that an upheld challenge costs a timeout', () => {
    const f = makeSession();
    const upheld = bannerForGameEvent({ type: 'challengeResult', side: 'home', result: 'upheld', booth: false }, f.setup);
    expect(upheld?.text).toBe('CALL STANDS');
    expect(upheld?.sub).toBe(`${f.setup.home.team.abbr} LOSE A TIMEOUT`);
    expect(bannerForGameEvent({ type: 'challengeResult', side: 'away', result: 'overturned', booth: false }, f.setup)?.sub).toBe(`${f.setup.away.team.abbr} WIN THE CHALLENGE`);
    expect(bannerForGameEvent({ type: 'challengeResult', side: 'away', result: 'upheld', booth: true }, f.setup)?.sub).toBe('RULING CONFIRMED');
    expect(bannerForGameEvent({ type: 'challengeFlag', side: 'home', booth: false, call: { kind: 'catch', tick: 1, athleteId: null, confidence: 0.5 } }, f.setup)?.sub).toBe(`${f.setup.home.team.abbr} CHALLENGE THE CATCH`);
  });

  it('post-play buttons: CONTINUE, CHALLENGE with the ruling and countdown, REVIEW; touch shows FLAG and REPLAY', () => {
    const g = (a: string) => a.toUpperCase();
    const c = postPlayControls(g, { side: 'home', call: { kind: 'fumble', tick: 1, athleteId: null, confidence: 0.4 }, remainingSec: 3.2 }, true);
    expect(c.map((h) => `${h.id}:${h.label}`)).toEqual(['continue:CONTINUE', 'challenge:CHALLENGE FUMBLE 4s', 'replay:REVIEW']);
    expect(postPlayControls(g, null, false).map((h) => h.id)).toEqual(['continue']);
    const scheme = loadDefaultProfile().scheme;
    const labels = touchLabelsFor('postPlay', scheme, ['a', 'rb', 'x', 'lt', 'start']);
    expect(labels).toMatchObject({ a: 'OK', rb: 'FLAG', x: 'REPLAY' });
  });

  it('review from the card, throw the flag from the replay by touch, and the reel fills as plays end', () => {
    let reviewed = false;
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && !reviewed) {
        reviewed = true;
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 0 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const ui = makeUi();
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 }, script });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay') throw new Error('expected post-play');
    expect(recordingFor(stage.summary, f.session.lastReplay())).not.toBeNull();
    screen.render(ui.rc);
    // Tap REVIEW on the card: the replay opens with the flag available.
    ui.stack.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }));
    const replay = ui.stack.top;
    if (!(replay instanceof ReplayScreen)) throw new Error('expected the replay');
    replay.render(ui.rc);
    const flag = replay.buttonRects.find((b) => b.id === 'flag');
    if (!flag) throw new Error('no flag button');
    const c = centreOf(flag);
    ui.stack.update(1 / 60, makeInput({ pointer: pointerAt(c.x, c.y, true), device: 'touch' }));
    expect(ui.stack.top).toBe(screen);
    const after = f.session.stage;
    expect(after.kind === 'postPlay' && after.summary.resultText.includes('PASS +25')).toBe(true);
    expect(screen.highlights.list.some((h) => h.kind === 'longCatch')).toBe(true);
    // The pause menu lists the reel and plays an entry.
    ui.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    const pause = ui.stack.top as PauseScreen;
    expect(pause.list.items.find((i) => i.id === 'highlights')?.disabled).toBe(false);
    pause.activate('highlights');
    const list = ui.stack.top;
    if (!(list instanceof HighlightsScreen)) throw new Error('expected highlights');
    list.render(ui.rc);
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(ui.stack.top).toBeInstanceOf(ReplayScreen);
  });

  it('a mouse click on the CONTINUE button continues the game', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && !s.stage.summary.simulated, coinToss: 'receive' });
    const before = f.session.stage;
    screen.render(ui.rc);
    const rects = (screen as unknown as { hintRects: { id: string; x: number; y: number; w: number; h: number }[] }).hintRects;
    const cont = rects.find((r) => r.id === 'continue');
    if (!cont) throw new Error('no continue');
    const c = centreOf(cont);
    ui.stack.update(1 / 60, makeInput({ pointer: pointerAt(c.x, c.y, true), device: 'mouse', pressed: ['confirm'] }));
    expect(f.session.stage).not.toBe(before);
  });
});
