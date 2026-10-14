import { describe, expect, it, vi } from 'vitest';
import { DevController, autoCall, driveKey } from '@/tools/dev-controller';
import { overlayLabel } from '@/tools/dev-state';
import { DevConsoleScreen } from '@/ui/screens/dev-console';
import { devBadgeY, GameScreen } from '@/ui/screens/game';
import { PlayCallScreen } from '@/ui/screens/playcall';
import { PromptScreen } from '@/ui/screens/watch';
import type { GameSession } from '@/ui/game/session-types';
import { buildPlayState } from '../fixtures/play-state';
import { makeInput, pointerAt } from '../ui/render/fake-ctx';
import { autoplay, makeSession, makeUi } from '../ui/game/fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

/** Pixels of the DEV status badge (warning colour, top-right text row). */
const badgeFills = (ui: ReturnType<typeof makeUi>): number => {
  const t = ui.rc.theme;
  const y = devBadgeY(t);
  return ui.ctx.fills.filter((f) => f.color === t.colors.warning && f.x > ui.rc.width / 2 && f.y >= y && f.y < y + t.glyphH + 1).length;
};

/** Session at the user's first live snap, with a Game screen on the stack. */
const liveGame = (settings: Parameters<typeof makeUi>[0], search = '') => {
  const ui = makeUi(settings);
  const f = makeSession({ setup: { ...human, seed: 7 }, ticksToDead: 30 });
  autoplay(f.session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.offense === 'home' && !s.stage.meta.spectating, coinToss: 'receive' });
  const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn(), locationSearch: () => search });
  ui.stack.push(screen);
  return { ui, f, screen };
};

describe('developer mode is unreachable when off', () => {
  it('no console, no overlays and no engine hooks without the setting or ?dev=1', () => {
    for (const search of ['', '?dev=0', '?devmode=1']) {
      const { ui, f, screen } = liveGame({}, search);
      const setHooks = vi.spyOn(f.session as Required<GameSession>, 'setDevHooks');
      ui.stack.update(1 / 60, makeInput({ pressed: ['devOverlayCycle'] }));
      ui.stack.update(1 / 60, makeInput({ pressed: ['devToggle'] }));
      expect(ui.stack.top).toBe(screen);
      expect(screen.devController).toBeNull();
      expect(screen.openDevConsole(ui.services)).toBe(false);
      expect(ui.stack.all.some((s) => s instanceof DevConsoleScreen)).toBe(false);
      expect(setHooks).not.toHaveBeenCalled();
      expect(ui.toast).not.toHaveBeenCalled();
      ui.ctx.reset();
      screen.render(ui.rc);
      expect(badgeFills(ui)).toBe(0);
      autoplay(f.session, { until: () => f.plays.length >= 3 });
      expect(f.plays.length).toBeGreaterThanOrEqual(3);
      for (const p of f.plays) expect(p.opts.dev).toBeUndefined();
    }
  });

  it('a console built on a disabled controller closes itself', () => {
    const { ui, f } = liveGame({});
    const dev = new DevController(false);
    const consoleScreen = new DevConsoleScreen({ controller: dev, session: f.session, game: () => f.session.state, play: () => null, live: () => false, cursor: () => null });
    ui.stack.push(consoleScreen);
    expect(ui.stack.top).not.toBe(consoleScreen);
    expect(dev.queue({ type: 'forceTurnover' })).toBe(false);
    dev.toggleCheat('godMode');
    expect(dev.hooks.godMode).toBe(false);
  });
});

describe('developer mode on', () => {
  it('Settings.devMode hands the shared hooks to every engine and devOverlayCycle cycles the overlays', () => {
    const ui = makeUi({ devMode: true });
    const f = makeSession({ setup: { ...human, seed: 7 }, ticksToDead: 30 });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn(), locationSearch: () => '' });
    ui.stack.push(screen);
    const dev = screen.devController!;
    expect(dev).not.toBeNull();
    expect(dev.hooks.side).toBe('home');
    autoplay(f.session, { until: () => f.plays.length >= 2, coinToss: 'receive' });
    for (const p of f.plays) expect(p.opts.dev).toBe(dev.hooks);
    ui.stack.update(1 / 60, makeInput({ pressed: ['devOverlayCycle'] }));
    expect(overlayLabel(dev.state)).toBe('HITBOXES');
    expect(ui.toast).toHaveBeenLastCalledWith('OVERLAYS HITBOXES', 1.2);
    // Same frame drawn without and with the ball overlay (the fake play has no athletes, so hitboxes draw nothing).
    const lineColor = ui.rc.theme.colors.firstDown;
    ui.ctx.reset();
    screen.render(ui.rc);
    const plain = ui.ctx.fillsWith(lineColor).length;
    for (let i = 0; i < 6; i++) dev.cycleOverlays();
    expect(overlayLabel(dev.state)).toBe('BALL PATH');
    ui.ctx.reset();
    screen.render(ui.rc);
    expect(ui.ctx.fillsWith(lineColor).length).toBeGreaterThan(plain + 10);
    expect(badgeFills(ui)).toBeGreaterThan(20);
  });

  it('?dev=1 enables it too; devToggle opens the console whose items drive the controller', () => {
    const { ui, f, screen } = liveGame({}, '?dev=1');
    const dev = screen.devController!;
    expect(dev.hooks.side).toBe('home');
    ui.stack.update(1 / 60, makeInput({ pointer: pointerAt(240, 135), device: 'mouse' }));
    ui.stack.update(1 / 60, makeInput({ pressed: ['devToggle'] }));
    const con = ui.stack.top;
    if (!(con instanceof DevConsoleScreen)) throw new Error('expected the dev console');
    expect(con.list.items.map((i) => i.id)).toContain('forceTurnover');
    con.activate('cheat:godMode');
    con.activate('cheat:infiniteStamina');
    con.activate('ovl:coverage');
    expect(dev.hooks).toMatchObject({ godMode: true, infiniteStamina: true, freezeAi: false });
    // Engines created from now on share the hooks (the play already live was created before the screen).
    const livePlays = f.plays.length;
    autoplay(f.session, { until: () => f.plays.length > livePlays });
    expect(f.plays[f.plays.length - 1]!.opts.dev?.godMode).toBe(true);
    expect(dev.state.overlays.has('coverage')).toBe(true);
    expect(con.list.items.find((i) => i.id === 'cheat:godMode')?.value).toBe('ON');
    ui.ctx.reset();
    con.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(200);
    const pages = con.inspectorPage.pageCount;
    expect(pages).toBeGreaterThan(1);
    con.update(1 / 60, makeInput({ pressed: ['menuTabRight'] }), ui.services);
    expect(con.inspectorPage.page).toBe(1);
    expect(con.inspectorPage.rows.length).toBeGreaterThan(0);
    // Confirming on the inspector row steps forward and wraps back to the first page.
    for (let i = 1; i < pages; i++) con.activate('inspector');
    expect(con.inspectorPage.page).toBe(0);
    con.activate('inspector');
    expect(con.inspectorPage.page).toBe(1);
    // The fake play has nobody under control, so player commands are disabled; forcing a turnover is not.
    expect(con.list.items.find((i) => i.id === 'tpLos')?.disabled).toBe(true);
    con.activate('forceTurnover');
    expect(ui.stack.top).toBe(screen);
    expect(dev.pendingCommands).toEqual([{ type: 'forceTurnover' }]);
    ui.stack.update(1 / 60, makeInput({ pressed: ['devToggle'] }));
    ui.stack.update(1 / 60, makeInput({ pressed: ['devToggle'] }));
    expect(ui.stack.top).toBe(screen);
  });

  it('fast sim finishes the drive through the session and then switches itself off', () => {
    const ui = makeUi({ devMode: true });
    const f = makeSession({ setup: { ...human, seed: 7 }, ticksToDead: 30 });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.state.possession === 'home' && !s.state.kickoffPending, coinToss: 'receive' });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    const dev = screen.devController!;
    const key = driveKey(f.session.state);
    const livePlays = f.plays.length;
    dev.toggleCheat('fastSim', f.session);
    expect(dev.state.cheats.fastSim).toBe(true);
    for (let i = 0; i < 400 && dev.state.cheats.fastSim; i++) {
      ui.stack.update(0.5, makeInput());
      const top = ui.stack.top;
      if (top instanceof PromptScreen) top.choose(top.list.items[0]!.id);
      expect(top).not.toBeInstanceOf(PlayCallScreen);
    }
    expect(dev.state.cheats.fastSim).toBe(false);
    expect(f.fastSim.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(f.plays.length).toBe(livePlays);
    expect(driveKey(f.session.state) !== key || f.session.state.drive.result !== null).toBe(true);
  });
});

describe('DevController command helpers', () => {
  it('queues commands for the controlled athlete and refuses them on a dead play', () => {
    const dev = new DevController();
    dev.setFavouredSide('home');
    const f = buildPlayState({ seed: 3, userSide: 'home', controlRole: 'QB' });
    const play = f.state;
    expect(dev.teleportControlled(play, { x: 10, y: 40 })).toBe(true);
    expect(dev.teleportControlled(play, null)).toBe(false);
    expect(dev.teleportControlledToLos(play)).toBe(true);
    expect(dev.spawnBallAtControlled(play)).toBe(true);
    expect(dev.forceTouchdown(play)).toBe(true);
    expect(dev.forceTurnover(play)).toBe(true);
    expect(dev.pendingCommands).toEqual([
      { type: 'teleport', athleteId: 'off:QB', pos: { x: 10, y: 40 } },
      { type: 'teleport', athleteId: 'off:QB', pos: { x: play.snapX, y: play.losY - 1 } },
      { type: 'spawnBall', mode: 'toAthlete', athleteId: 'off:QB' },
      { type: 'forceTouchdown', side: 'home' },
      { type: 'forceTurnover' },
    ]);
    expect(dev.hooks.commandPlayIndex).toBe(play.ctx.playIndex);
    // A command for the next play replaces anything still waiting from this one.
    const next = buildPlayState({ seed: 4, userSide: 'home', controlRole: 'QB' }).state;
    next.ctx = { ...next.ctx, playIndex: play.ctx.playIndex + 1 };
    expect(dev.forceTouchdown(next)).toBe(true);
    expect(dev.pendingCommands).toEqual([{ type: 'forceTouchdown', side: 'home' }]);
    expect(dev.hooks.commandPlayIndex).toBe(play.ctx.playIndex + 1);
    play.phase = 'dead';
    expect(dev.forceTurnover(play)).toBe(false);
    dev.disable();
    expect(dev.pendingCommands).toHaveLength(0);
    expect(dev.enabled).toBe(false);
  });

  it('autoCall answers kicks, fourth downs and regular downs', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const req = stage.request;
    const call = autoCall(req)!;
    const expected = req.situation.kind === 'kickoff' ? req.special.find((o) => o.id === 'kickoff')?.playId : req.suggestion ?? req.offensePlays[0]?.id;
    expect(call.offensivePlayId).toBe(expected);
    const fourth = { ...req, situation: { ...req.situation, kind: 'scrimmage' as const, down: 4, ballOn: 30 }, special: [{ id: 'punt' as const, label: 'PUNT', playId: 'punt-std', detail: '' }] };
    expect(autoCall(fourth)).toEqual({ offensivePlayId: 'punt-std' });
    expect(autoCall({ ...req, unit: 'defense', defensePlays: [], suggestion: null })).toBeNull();
  });
});
