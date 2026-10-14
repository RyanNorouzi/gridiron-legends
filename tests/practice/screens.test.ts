import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import type { LivePlayFactory } from '@/game/engine-api';
import { outcomeAt } from '@/game/outcome-factory';
import { drillsIn, getDrill, DEFAULT_DRILL_OPTIONS } from '@/game/practice';
import { PracticeGameScreen, RESULT_SECONDS } from '@/ui/screens/practice-game';
import { buildDrillHud, drillHints, multiplierText } from '@/ui/screens/practice-hud';
import { HANDOFF_HOLD_SECONDS, PracticePlayView, steadyHandoff, steadyKicker } from '@/ui/screens/practice-view';
import { idlePlayInput, buildDrillScenario, DrillRep } from '@/game/practice';
import { vec2 } from '@/core/vec2';
import { PracticeMenuScreen, PracticeSetupScreen, categoriesFor, practiceTitle } from '@/ui/screens/practice';
import { PracticeSummaryScreen, summaryRows } from '@/ui/screens/practice-summary';
import { PromptScreen } from '@/ui/screens/watch';
import type { InputManager } from '@/ui/input/types';
import { createNullInput } from '@/ui/app';
import { makeInput } from '../ui/render/fake-ctx';
import { FakeLivePlay, makeUi } from '../ui/game/fixtures';

registerAll();

/** Engine double: the play dies after `ticks` ticks with a run of `yards`. */
const fakeEngine = (yards: number, ticks = 4): LivePlayFactory => (ctx, opts) => new FakeLivePlay(ctx, ticks, () => outcomeAt(ctx.ballOn, { result: 'run', yards }), opts);
const tick = (ui: ReturnType<typeof makeUi>, n = 1, input = makeInput()): void => {
  for (let i = 0; i < n; i++) ui.stack.update(1 / 60, input);
};

describe('practice picker', () => {
  it('Offense / Defense Practice lock the picker to their category; Practice shows every tab', () => {
    expect(categoriesFor('offense')).toEqual(['offense']);
    expect(categoriesFor(null)).toEqual(['offense', 'defense', 'specialTeams']);
    expect(practiceTitle('defense')).toBe('DEFENSE PRACTICE');
    const ui = makeUi();
    const offense = new PracticeMenuScreen({ filter: 'offense' });
    ui.stack.push(offense);
    expect(offense.list.items.map((i) => i.id)).toEqual(drillsIn('offense').map((d) => d.id));
    tick(ui, 1, makeInput({ pressed: ['menuTabRight'] }));
    expect(offense.category).toBe('offense');
    const all = new PracticeMenuScreen();
    ui.stack.push(all);
    tick(ui, 1, makeInput({ pressed: ['menuTabRight'] }));
    expect(all.category).toBe('defense');
    expect(all.list.items.map((i) => i.id)).toEqual(['coverage', 'zoneCoverage', 'tackling']);
    tick(ui, 1, makeInput({ pressed: ['menuTabLeft'] }));
    tick(ui, 1, makeInput({ pressed: ['menuTabLeft'] }));
    expect(all.category).toBe('specialTeams');
    all.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(100);
    tick(ui, 1, makeInput({ pressed: ['back'] }));
    expect(ui.stack.top).toBe(offense);
  });

  it('a drill opens its setup; options cycle; START replaces the setup with the practice game', () => {
    const ui = makeUi();
    const menu = new PracticeMenuScreen({ repDeps: { engine: fakeEngine(6) }, seed: 4 });
    ui.stack.push(menu);
    menu.switchTab(1);
    menu.switchTab(1);
    tick(ui, 1, makeInput({ pressed: ['confirm'] }));
    const setup = ui.stack.top;
    if (!(setup instanceof PracticeSetupScreen)) throw new Error('expected the setup screen');
    expect(setup.def.id).toBe('fieldGoal');
    expect(setup.list.items.map((i) => i.id)).toEqual(['difficulty', 'kickDistance', 'hash', 'wind', 'windMph', 'start', 'back']);
    tick(ui, 1, makeInput({ pressed: ['menuRight'] }));
    expect(setup.options.difficulty).toBe('allPro');
    tick(ui, 1, makeInput({ pressed: ['menuDown'] }));
    tick(ui, 1, makeInput({ pressed: ['menuLeft'] }));
    expect(setup.options.kickDistance).toBe(33);
    expect(menu.optionsFor('fieldGoal').kickDistance).toBe(33);
    setup.render(ui.rc);
    setup.list.select(setup.list.items.findIndex((i) => i.id === 'start'));
    tick(ui, 1, makeInput({ pressed: ['confirm'] }));
    const game = ui.stack.top;
    expect(game).toBeInstanceOf(PracticeGameScreen);
    expect(ui.stack.all).toEqual([menu, game]);
    expect((game as PracticeGameScreen).options).toMatchObject({ difficulty: 'allPro', kickDistance: 33 });
  });
});

describe('practice game screen', () => {
  const start = (yards: number, input?: InputManager) => {
    const ui = makeUi();
    if (input) ui.services.input = input;
    const menu = new PracticeMenuScreen({ filter: 'offense' });
    ui.stack.push(menu);
    const game = new PracticeGameScreen(getDrill('running'), { ...DEFAULT_DRILL_OPTIONS }, { onChangeDrill: () => ui.stack.popTo(menu), onQuit: () => ui.stack.clear(), repDeps: { engine: fakeEngine(yards) }, seed: 3 });
    ui.stack.push(game);
    return { ui, menu, game };
  };

  it('runs reps, records verdicts with the streak multiplier, shows the result and starts the next rep', () => {
    const { ui, game } = start(7);
    const firstRep = game.view.rep;
    expect(firstRep).not.toBeNull();
    tick(ui, 5);
    expect(game.session.reps).toBe(1);
    expect(game.showingResult).toBe(true);
    expect(game.bannerQueue.current?.text).toBe('RUN +7');
    expect(game.lastResult?.verdict.success).toBe(true);
    tick(ui, 1, makeInput({ pressed: ['confirm'] }));
    expect(game.showingResult).toBe(false);
    expect(game.view.rep).not.toBe(firstRep);
    tick(ui, 5);
    expect(game.session.reps).toBe(2);
    expect(game.lastResult?.multiplier).toBe(1.25);
    // The result times out on its own too.
    tick(ui, Math.ceil(RESULT_SECONDS * 60) + 1);
    expect(game.session.reps).toBe(2);
    expect(game.showingResult).toBe(false);
    const hud = buildDrillHud(game.session, game.lastResult);
    expect(hud).toMatchObject({ rep: 3, reps: 2, successes: 2, ratePct: 100, streak: 2 });
    expect(multiplierText(hud.multiplier)).toBe('X1.5');
    game.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(200);
  });

  it('pause menu: reset re-runs the rep without recording it; end drill shows the summary; change drill returns to the picker', () => {
    const { ui, menu, game } = start(1);
    tick(ui, 5);
    expect(game.lastResult?.verdict.success).toBe(false);
    tick(ui, 1, makeInput({ pressed: ['pause'] }));
    let top = ui.stack.top;
    if (!(top instanceof PromptScreen)) throw new Error('expected the pause prompt');
    const before = game.session.attemptCount;
    top.choose('reset');
    expect(ui.stack.top).toBe(game);
    expect(game.session.attemptCount).toBe(before + 1);
    expect(game.session.reps).toBe(1);
    tick(ui, 1, makeInput({ pressed: ['pause'] }));
    (ui.stack.top as PromptScreen).choose('end');
    top = ui.stack.top;
    if (!(top instanceof PracticeSummaryScreen)) throw new Error('expected the summary');
    expect(top.summary.reps).toBe(1);
    expect(summaryRows(top.summary)[0]).toEqual(['SUCCESS', '0/1  0%']);
    top.render(ui.rc);
    top.activate('change');
    expect(ui.stack.top).toBe(menu);
  });

  it('button hints follow the play context and use the live glyphs', () => {
    const glyphs: InputManager = { ...createNullInput(), glyph: (a) => `<${a}>` };
    const def = getDrill('passZone');
    const qb = drillHints(def, 'qb', (a) => glyphs.glyph(a));
    expect(qb.map((h) => h.glyph)).toContain('<throw1>');
    expect(qb[qb.length - 1]).toEqual({ glyph: '<pause>', label: 'MENU' });
    expect(drillHints(getDrill('tackling'), 'defense', (a) => glyphs.glyph(a)).map((h) => h.label)).toContain('TACKLE');
    expect(drillHints(def, 'presnapOffense', (a) => glyphs.glyph(a)).map((h) => h.label)).toEqual(['SNAP', 'ROUTES', 'MENU']);
    expect(drillHints(getDrill('fieldGoal'), 'kick', (a) => glyphs.glyph(a))[0]).toEqual({ glyph: '<kick>', label: 'KICK METER' });
  });

  it('with the real engine the snap button starts the rep through play-input', () => {
    const ui = makeUi();
    const game = new PracticeGameScreen(getDrill('passRoutes'), { ...DEFAULT_DRILL_OPTIONS }, { onChangeDrill: () => undefined, onQuit: () => undefined, seed: 9 });
    ui.stack.push(game);
    expect(game.view.rep?.state.phase).toBe('presnap');
    tick(ui, 1, makeInput({ pressed: ['snap'] }));
    tick(ui, 3);
    expect(game.view.rep?.state.phase).toBe('live');
    expect(game.view.lastInput).not.toBeNull();
    game.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(300);
  });

  it('punting through the screen: aim is held back until the punter has the ball, then steers the punt to the called side', () => {
    const rep = new DrillRep(buildDrillScenario(getDrill('punting'), { ...DEFAULT_DRILL_OPTIONS }, 2));
    const aimed = { ...idlePlayInput(), move: vec2(1, 0) };
    expect(steadyKicker(aimed, rep.state, 'home').move.x).toBe(0);
    rep.state.ball.phase = 'held';
    rep.state.ball.carrierId = rep.state.controlledIds.home ?? null;
    expect(steadyKicker(aimed, rep.state, 'home').move.x).toBe(1);

    const ui = makeUi();
    const game = new PracticeGameScreen(getDrill('punting'), { ...DEFAULT_DRILL_OPTIONS, difficulty: 'rookie', puntTarget: 'right' }, { onChangeDrill: () => undefined, onQuit: () => undefined, seed: 12 });
    ui.stack.push(game);
    for (let t = 0; t < 900 && game.session.reps === 0; t++) {
      const m = game.view.rep?.state.kickMeter;
      const press = !!m && ((m.phase === 'idle' && t > 5) || (m.phase === 'power' && m.cursor >= 0.9) || (m.phase === 'accuracy' && m.cursor > 0.95));
      // Horizontal field: the punting team attacks to the right, so its right-hand side is DOWN the screen.
      ui.stack.update(1 / 60, makeInput({ axis: { x: 0, y: 0.6 }, pressed: press ? ['kick'] : [] }));
    }
    expect(game.session.reps).toBe(1);
    const v = game.lastResult!.verdict;
    expect(v.detail).toContain('RIGHT');
    expect(v.success).toBe(true);
  });

  it('play events of the rep reach the audio mapper', () => {
    const ui = makeUi();
    const heard: string[] = [];
    ui.services.audio = { onGameEvent: (e: { type: string }) => { heard.push(e.type); return []; } } as unknown as NonNullable<typeof ui.services.audio>;
    const game = new PracticeGameScreen(getDrill('running'), { ...DEFAULT_DRILL_OPTIONS }, { onChangeDrill: () => undefined, onQuit: () => undefined, repDeps: { engine: fakeEngine(5) }, seed: 1 });
    ui.stack.push(game);
    tick(ui, 3);
    expect(heard.slice(0, 2)).toEqual(['possession', 'snap']);
    expect(heard.filter((t) => t === 'possession')).toHaveLength(1);
  });

  it('large-text mode drops the picker summaries and still lays every practice screen out on screen', () => {
    const ui = makeUi({ textSize: 'large' });
    const menu = new PracticeMenuScreen({ repDeps: { engine: fakeEngine(6) }, seed: 2 });
    ui.stack.push(menu);
    expect(menu.list.items.every((i) => i.subLabel === undefined)).toBe(true);
    // The shared night-field backdrop scrolls bands in from above the screen; everything else must be on screen.
    const BACKDROP = new Set(['#0f1a12', '#0c150f', '#1b2a1e']);
    const offscreen = (): number => ui.ctx.fills.filter((f) => !BACKDROP.has(f.color.toLowerCase()) && (f.x > 480 || f.y > 270 || f.x + f.w < 0 || f.y + f.h < 0 || f.x + f.w > 481)).length;
    const check = (render: () => void): void => {
      ui.ctx.reset();
      render();
      expect(ui.ctx.fills.length).toBeGreaterThan(100);
      expect(offscreen()).toBe(0);
    };
    check(() => menu.render(ui.rc));
    menu.openSetup(getDrill('punting'));
    const setup = ui.stack.top as PracticeSetupScreen;
    check(() => setup.render(ui.rc));
    menu.startDrill(getDrill('punting'), setup.options);
    const game = ui.stack.top as PracticeGameScreen;
    tick(ui, 6);
    ui.ctx.reset();
    game.render(ui.rc);
    // The field view may paint turf past the edges; the HUD itself stays on screen.
    expect(ui.ctx.fills.length).toBeGreaterThan(100);
    game.endDrill();
    check(() => (ui.stack.top as PracticeSummaryScreen).render(ui.rc));
  });
});

describe('running drill through the live view', () => {
  it('a stick held from the snap no longer steals the handoff: every rotation hands off and the user runs it', () => {
    const def = getDrill('running');
    for (let rotation = 0; rotation < def.offensePlays.length; rotation++) {
      const ui = makeUi();
      const view = new PracticePlayView();
      view.attach(ui.services);
      const rep = new DrillRep(buildDrillScenario(def, { ...DEFAULT_DRILL_OPTIONS, difficulty: 'rookie' }, 30 + rotation, rotation));
      view.setRep(rep);
      view.step(makeInput({ pressed: ['snap'] }), ui.services);
      for (let t = 0; t < 2400 && !rep.finished; t++) view.step(makeInput({ axis: { x: 0.2, y: -1 }, down: ['sprint'] }), ui.services);
      const handoff = rep.state.events.find((e) => e.type === 'handoff' || e.type === 'pitch');
      expect(handoff, rep.state.ctx.offensivePlay.id).toBeDefined();
      const runner = handoff && (handoff.type === 'handoff' || handoff.type === 'pitch') ? handoff.to : null;
      // Control followed the ball to the runner, and the verdict is about his run.
      expect(rep.userIds).toContain(runner);
      expect(rep.verdict).not.toBeNull();
    }
  });

  it('steadyHandoff only holds a human quarterback on a designed run before the exchange', () => {
    const rep = new DrillRep(buildDrillScenario(getDrill('running'), { ...DEFAULT_DRILL_OPTIONS }, 3));
    const pushed = { ...idlePlayInput(), move: vec2(0, 1), sprint: true };
    // Pre-snap motion is untouched.
    expect(steadyHandoff(pushed, rep.state, 'home').move.y).toBe(1);
    rep.tick({ ...idlePlayInput(), snap: true });
    rep.tick(null);
    expect(rep.state.phase).toBe('live');
    const held = steadyHandoff(pushed, rep.state, 'home');
    expect(held.move).toEqual(vec2(0, 0));
    expect(held.sprint).toBe(false);
    // Not the offense's side, or past the hold window: pass through.
    expect(steadyHandoff(pushed, rep.state, 'away').move.y).toBe(1);
    rep.state.tick = rep.state.snapTick + Math.ceil(HANDOFF_HOLD_SECONDS * 60) + 1;
    expect(steadyHandoff(pushed, rep.state, 'home').move.y).toBe(1);
    // Pass plays are never held.
    const pass = new DrillRep(buildDrillScenario(getDrill('passRoutes'), { ...DEFAULT_DRILL_OPTIONS }, 3));
    pass.tick({ ...idlePlayInput(), snap: true });
    pass.tick(null);
    expect(steadyHandoff(pushed, pass.state, 'home').move.y).toBe(1);
  });
});
