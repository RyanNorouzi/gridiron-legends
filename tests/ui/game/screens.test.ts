import { describe, expect, it, vi } from 'vitest';
import type { ReplayRecording } from '@/game/play-types';
import { buildPostGame } from '@/ui/game/box-score';
import { GameScreen, emptyScene } from '@/ui/screens/game';
import { PauseScreen } from '@/ui/screens/pause';
import { COACH_PICK_LABEL, PlayCallScreen, coachPickBadge } from '@/ui/screens/playcall';
import { PostGameScreen } from '@/ui/screens/post-game';
import { REPLAY_SPEEDS, ReplayScreen, sceneFromReplay } from '@/ui/screens/replay';
import { PromptScreen } from '@/ui/screens/watch';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { makeInput } from '../render/fake-ctx';
import { pid } from '../../game/fixtures';
import { autoplay, makeSession, makeUi } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('GameScreen', () => {
  it('starts the session, routes decisions and play calls to overlay screens and ticks the live play', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const onQuit = vi.fn();
    const screen = new GameScreen(f.session, { onQuit, onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    expect(f.session.stage.kind).not.toBe('pregame');
    const step = (n = 1): void => {
      for (let i = 0; i < n; i++) ui.stack.update(1 / 60, makeInput());
    };
    step();
    let top = ui.stack.top;
    if (top instanceof PromptScreen) {
      expect(top.list.items.map((i) => i.id)).toEqual(['receive', 'kick', 'defer']);
      top.choose('receive');
    }
    for (let i = 0; i < 400 && !(ui.stack.top instanceof PlayCallScreen); i++) step();
    top = ui.stack.top;
    if (!(top instanceof PlayCallScreen)) throw new Error('expected the play-call screen');
    expect(top.request.unit).toBe('offense');
    screen.render(ui.rc);
    top.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(300);
    top.activate('pass-curl');
    expect(ui.stack.top).toBe(screen);
    expect(f.session.stage.kind).toBe('live');
    step();
    const live = f.plays[f.plays.length - 1]!;
    expect(live.inputs.length).toBe(1);
    expect(live.inputs[0]!.home).toBeDefined();
    step(10);
    expect(f.session.stage.kind).toBe('postPlay');
    ui.ctx.reset();
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(100);
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(f.session.stage.kind).not.toBe('postPlay');
  });

  it('opens the pause overlay, replays and quits', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const onQuit = vi.fn();
    const screen = new GameScreen(f.session, { onQuit, onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    ui.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    const pause = ui.stack.top;
    if (!(pause instanceof PauseScreen)) throw new Error('expected pause');
    expect(pause.list.items.find((i) => i.id === 'replay')?.disabled).toBe(true);
    expect(pause.warning).toBeNull();
    pause.activate('quit');
    expect(onQuit).not.toHaveBeenCalled();
    expect(pause.warning).toBe('UNSAVED GAME WILL BE LOST');
    pause.render(ui.rc);
    pause.activate('quit');
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(ui.stack.top).toBe(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && !s.stage.summary.simulated, coinToss: 'receive' });
    ui.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    const again = ui.stack.top as PauseScreen;
    expect(again.list.items.find((i) => i.id === 'replay')?.disabled).toBe(false);
    again.activate('replay');
    expect(ui.stack.top).toBeInstanceOf(ReplayScreen);
    ui.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(ui.stack.top).toBe(screen);
  });

  it('shows the caller\'s quit warning in the pause menu', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    ui.stack.push(new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn(), quitWarning: 'Leaving lets you sim the rest' }));
    ui.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    const pause = ui.stack.top as PauseScreen;
    pause.activate('quit');
    expect(pause.warning).toBe('LEAVING LETS YOU SIM THE REST');
  });

  it('replaces itself with the post-game screen at the final whistle and renders an empty field before the first snap', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { seed: 2, ruleset: { quarterLengthSec: 60 } } });
    const onPlayAgain = vi.fn();
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain });
    ui.stack.push(screen);
    const scene = emptyScene(f.session.state);
    expect(scene.athletes).toHaveLength(0);
    screen.render(ui.rc);
    for (let i = 0; i < 5000 && !(ui.stack.top instanceof PostGameScreen); i++) ui.stack.update(0.5, makeInput());
    const post = ui.stack.top;
    if (!(post instanceof PostGameScreen)) throw new Error('expected post game');
    expect(post.data.score).toEqual(f.session.state.score);
    post.render(ui.rc);
    post.update(1 / 60, makeInput({ pressed: ['confirm'] }), ui.services);
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });
});

describe('PlayCallScreen', () => {
  it('lists special shortcuts first on fourth down and carries the control role for the defense', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'defense', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const ui = makeUi();
    const onCall = vi.fn();
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall, defaultRole: 'SS' });
    ui.stack.push(screen);
    expect(screen.controlRole).toBe('SS');
    expect(screen.list.items[0]?.id).toBe('__control');
    expect(screen.list.selected?.id).toBe('cover3');
    screen.update(1 / 60, makeInput({ pressed: ['menuUp'] }), ui.services);
    expect(screen.list.selected?.id).toBe('__control');
    screen.update(1 / 60, makeInput({ pressed: ['menuRight'] }), ui.services);
    expect(screen.controlRole).toBe('MLB');
    screen.update(1 / 60, makeInput({ pressed: ['menuLeft'] }), ui.services);
    expect(screen.controlRole).toBe('SS');
    screen.update(1 / 60, makeInput({ pressed: ['menuRight'] }), ui.services);
    screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), ui.services);
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), ui.services);
    expect(onCall).toHaveBeenCalledWith({ defensivePlayId: 'cover3', controlRole: 'MLB' });
    expect(ui.stack.size).toBe(0);
  });

  it('offense: formation tabs, coach suggestion and special options', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.stage.request.situation.kind === 'kickoff', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const ui = makeUi();
    const onCall = vi.fn();
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall });
    ui.stack.push(screen);
    expect(screen.tab.id).toBe('__special');
    expect(screen.list.items.map((i) => i.id)).toEqual(expect.arrayContaining(['special:kickoff', 'special:onside']));
    // A kickoff offers only the kick units (a scrimmage play here made the defense field a scrimmage unit, H2-03).
    screen.switchTab(1);
    expect(screen.tab.id).toBe('__special');
    screen.render(ui.rc);
    screen.activate('special:onside');
    expect(onCall).toHaveBeenCalledWith({ offensivePlayId: 'onside' });
    // A scrimmage down has the formation tabs with the coach's suggestion starred.
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.stage.request.situation.kind === 'scrimmage', coinToss: 'kick' });
    const down = f.session.stage;
    if (down.kind !== 'playcall') throw new Error('expected playcall');
    const call = new PlayCallScreen(down.request, f.session.registry, { onCall });
    ui.stack.push(call);
    call.switchTab(call.tab.id === '__special' ? 1 : 0);
    expect(call.tab.id).not.toBe('__special');
    expect(down.request.offensePlays.length).toBeGreaterThan(0);
    // The coach-pick badge keeps its words on a roomy card and shrinks to the star on a small one (large text).
    expect(coachPickBadge(48, 190)).toBe(COACH_PICK_LABEL);
    expect(coachPickBadge(96, 165)).toBe('★');
    const big = makeUi({ textSize: 'large' });
    const large = new PlayCallScreen(down.request, f.session.registry, { onCall });
    big.stack.push(large);
    large.render(big.rc);
    expect(big.ctx.fills.length).toBeGreaterThan(50);
  });
});

describe('PromptScreen, ReplayScreen and PostGameScreen', () => {
  it('prompt chooses and pops, honours a countdown and back', () => {
    const ui = makeUi();
    const onChoose = vi.fn();
    let left = 2;
    const p = new PromptScreen({ title: 'T', lines: ['a line'], choices: [{ id: 'yes', label: 'YES' }, { id: 'no', label: 'NO' }], onChoose, countdown: () => left, timeoutChoice: 'no', backChoice: 'no' });
    ui.stack.push(p);
    p.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(50);
    p.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(onChoose).toHaveBeenCalledWith('yes');
    expect(ui.stack.size).toBe(0);
    const q = new PromptScreen({ title: 'T', choices: [{ id: 'yes', label: 'YES' }, { id: 'no', label: 'NO' }], onChoose, countdown: () => left, timeoutChoice: 'no' });
    ui.stack.push(q);
    left = 0;
    q.update(1 / 60, makeInput());
    expect(onChoose).toHaveBeenLastCalledWith('no');
  });

  it('replay seeks, steps, changes speed and renders frames', () => {
    const rec: ReplayRecording = {
      id: 'r', playIndex: 0, tickRate: 60, snapTick: 2, direction: 1, losY: 40, firstDownY: 50,
      athletes: [{ id: 'off:QB', playerId: pid('p1'), teamSide: 'home', position: 'QB', number: 7, name: 'Q' }, { id: 'def:FS', playerId: pid('p2'), teamSide: 'away', position: 'FS', number: 21, name: 'F' }],
      frames: Array.from({ length: 12 }, (_, i) => ({ tick: i, athletes: [{ id: 'off:QB', x: 26, y: 35 + i, facing: 1.57, state: 'moving' as const, hasBall: true }, { id: 'def:FS', x: 30, y: 55 - i, facing: -1.57, state: 'moving' as const, hasBall: false }], ball: { x: 26, y: 35 + i, z: 0, phase: 'held' as const } })),
      events: [],
    };
    const ui = makeUi();
    const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
    const screen = new ReplayScreen(rec, { palettes, fieldType: 'grass', weather: null, homeAbbr: 'HOM', awayAbbr: 'AWY', userSide: 'home' });
    ui.stack.push(screen);
    const mid = sceneFromReplay(rec, 2.5);
    expect(mid.athletes.find((a) => a.id === 'off:QB')?.y).toBeCloseTo(37.5);
    expect(mid.athletes.find((a) => a.id === 'def:FS')?.side).toBe('defense');
    expect(mid.presnap).toBe(false);
    screen.update(0.05, makeInput(), ui.services);
    expect(screen.position).toBeCloseTo(3);
    screen.update(1 / 60, makeInput({ pressed: ['replayPlayPause'] }), ui.services);
    expect(screen.isPlaying).toBe(false);
    screen.update(1 / 60, makeInput({ pressed: ['replayStepForward'] }), ui.services);
    expect(screen.position).toBe(4);
    screen.update(1 / 60, makeInput({ pressed: ['replayFast'] }), ui.services);
    expect(screen.speed).toBe(REPLAY_SPEEDS[3]);
    screen.seek(100);
    expect(screen.position).toBe(11);
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(100);
    screen.update(1 / 60, makeInput({ pressed: ['back'] }), ui.services);
    expect(ui.stack.size).toBe(0);
  });

  it('post-game tabs, scrolling and actions', () => {
    const f = makeSession({ setup: { seed: 2, ruleset: { quarterLengthSec: 60 } } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'final' });
    const data = buildPostGame(f.setup, f.session.state);
    const ui = makeUi();
    const onMenu = vi.fn();
    const screen = new PostGameScreen(data, { onPlayAgain: vi.fn(), onMenu });
    ui.stack.push(screen);
    expect(screen.tab).toBe('team');
    screen.update(1 / 60, makeInput({ pressed: ['menuTabRight'] }), ui.services);
    expect(screen.tab).toBe('leaders');
    screen.setTab(3);
    expect(screen.tab).toBe('log');
    screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), ui.services);
    expect(screen.scrollOffset).toBe(1);
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(200);
    screen.update(1 / 60, makeInput({ pressed: ['menuRight'] }), ui.services);
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), ui.services);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });
});

describe('GameScreen watch mode', () => {
  it('the jumpIn action hands the spectator control', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { controllers: { home: 'watch', away: 'ai' }, userSide: 'home', seed: 4 }, ticksToDead: 40 });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    for (let i = 0; i < 500 && f.session.stage.kind !== 'live'; i++) ui.stack.update(1 / 60, makeInput());
    expect(f.session.stage.kind).toBe('live');
    expect(f.session.watching).toBe(true);
    ui.stack.update(1 / 60, makeInput({ pressed: ['jumpIn'] }));
    expect(f.session.watching).toBe(false);
    expect(f.session.state.controllers.home).toBe('human');
  });
});
