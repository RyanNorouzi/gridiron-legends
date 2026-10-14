/**
 * The tutorial screen end to end on the real engine and AI: prompts use the injected input manager's glyphs,
 * info pages advance on confirm, the movement step completes when the player moves 10 yards, the passing step
 * refuses a throw to the wrong receiver and completes on a throw to the primary, and pause can skip.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerAll } from '@/ai/register';
import type { InputState } from '@/ui/input/types';
import type { InputManager } from '@/ui/input/types';
import { createNullInput } from '@/ui/app';
import { FEEDBACK_SECONDS, TutorialScreen } from '@/ui/screens/tutorial';
import { PromptScreen } from '@/ui/screens/watch';
import { emptyProgress, type TutorialProgress, type TutorialProgressSink } from '@/ui/tutorial/progress';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from '../game/fixtures';

registerAll();

const glyphInput = (): InputManager => {
  const state = makeInput({ device: 'gamepad' });
  return { ...createNullInput(), state: () => state, glyph: (a) => `<${a}>` };
};

const sink = (progress: TutorialProgress | null = emptyProgress()): TutorialProgressSink & { markStep: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } => ({
  progress, markStep: vi.fn(), complete: vi.fn(),
});

const setup = (progress = sink()) => {
  const ui = makeUi();
  ui.services.input = glyphInput();
  const onExit = vi.fn();
  const screen = new TutorialScreen({ progress, onExit, seed: 5 });
  ui.stack.push(screen);
  const tick = (input: InputState = makeInput(), n = 1): void => {
    for (let i = 0; i < n; i++) ui.stack.update(1 / 60, input);
  };
  const waitFeedback = (): void => tick(makeInput(), Math.ceil(FEEDBACK_SECONDS * 60) + 2);
  return { ui, screen, onExit, progress, tick, waitFeedback };
};

describe('TutorialScreen', () => {
  it('shows prompts with the current glyphs and pages through info steps on confirm', () => {
    const { ui, screen, tick } = setup();
    expect(screen.step?.id).toBe('welcome');
    expect(screen.instructionLines().join(' ')).toContain('Press [<pause>] at any time');
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(200);
    tick(makeInput({ pressed: ['confirm'] }));
    expect(screen.step?.id).toBe('movement');
    expect(screen.instructionLines()).toContain('Move with [L-STICK]. Hold [<sprint>] to sprint.');
    expect(screen.view.rep?.puppetId).toBe('off:WR2');
  });

  it('movement completes after 10 yards; the step is recorded and the tutorial moves on', () => {
    const { screen, tick, waitFeedback, progress } = setup(sink({ ...emptyProgress(), completedSteps: ['welcome'] }));
    expect(screen.step?.id).toBe('movement');
    tick(makeInput(), 30);
    expect(screen.lastObservation!.travel).toBe(0);
    tick(makeInput({ axis: { x: 1, y: 0 } }), 30);
    expect(screen.holding).toBe(false);
    expect(screen.lastObservation!.travel).toBeGreaterThan(0);
    for (let i = 0; i < 400 && !screen.holding; i++) tick(makeInput({ axis: { x: 0, y: -1 }, down: ['sprint'] }));
    expect(screen.holding).toBe(true);
    expect(screen.lastObservation!.travel).toBeGreaterThanOrEqual(10);
    expect(screen.step?.id).toBe('movement');
    waitFeedback();
    expect(progress.markStep).toHaveBeenCalledWith('movement');
    expect(screen.step?.id).toBe('passing');
  });

  it('passing: a throw to another receiver restarts the attempt; the primary completes the step', () => {
    const { screen, tick, waitFeedback, progress } = setup(sink({ ...emptyProgress(), completedSteps: ['welcome', 'movement'] }));
    expect(screen.step?.id).toBe('passing');
    const throwWith = (action: 'throw1' | 'throw2'): void => {
      tick(makeInput({ pressed: ['snap'] }));
      tick(makeInput(), 75);
      expect(screen.view.context()).toBe('qb');
      tick(makeInput({ pressed: [action] }));
      tick(makeInput({ released: [action] }));
    };
    throwWith('throw2');
    expect(screen.holding).toBe(true);
    const firstRep = screen.view.rep;
    waitFeedback();
    expect(screen.step?.id).toBe('passing');
    expect(screen.machine.attempts).toBe(1);
    expect(screen.view.rep).not.toBe(firstRep);
    expect(progress.markStep).not.toHaveBeenCalled();
    throwWith('throw1');
    expect(screen.holding).toBe(true);
    waitFeedback();
    expect(progress.markStep).toHaveBeenCalledWith('passing');
    // The passing lesson continues with the pull-back pass.
    expect(screen.step?.id).toBe('pullBack');
  });

  it('pull-back pass: a mouse drag back from the field throws to a spot and completes the step', () => {
    const { ui, screen, tick, waitFeedback, progress } = setup(sink({ ...emptyProgress(), completedSteps: ['welcome', 'movement', 'passing'] }));
    expect(screen.step?.id).toBe('pullBack');
    tick(makeInput({ pressed: ['snap'] }));
    tick(makeInput(), 75);
    expect(screen.view.context()).toBe('qb');
    const rep = screen.view.rep!;
    const cam = ui.services.camera;
    const qb = rep.state.athletes.find((a) => a.controlled && a.side === 'offense')!;
    const wr = rep.state.athletes.find((a) => a.id === rep.focusId) ?? rep.state.athletes.find((a) => a.role === 'WR1')!;
    const a = cam.worldToScreen(qb.pos);
    const b = cam.worldToScreen(wr.pos);
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const start = { x: 240, y: 135 };
    const end = { x: start.x - ((b.x - a.x) / l) * 50, y: start.y - ((b.y - a.y) / l) * 50 };
    const ptr = (x: number, y: number, down: boolean, justDown = false, justUp = false) => ({ x, y, down, justDown, justUp, drag: null });
    tick(makeInput({ device: 'mouse', pointer: ptr(start.x, start.y, true, true), pressed: ['throw1'] }));
    tick(makeInput({ device: 'mouse', pointer: ptr(end.x, end.y, true), down: ['throw1'] }), 3);
    ui.ctx.reset();
    screen.render(ui.rc);
    const withAim = ui.ctx.fills.length;
    expect(withAim).toBeGreaterThan(0);
    expect(rep.state.events.some((e) => e.type === 'throw')).toBe(false);
    tick(makeInput({ device: 'mouse', pointer: ptr(end.x, end.y, false, false, true), released: ['throw1'] }));
    expect(rep.state.events.some((e) => e.type === 'throw')).toBe(true);
    expect(screen.lastObservation!.spotThrow).toBe(true);
    expect(screen.holding).toBe(true);
    waitFeedback();
    expect(progress.markStep).toHaveBeenCalledWith('pullBack');
    expect(screen.step?.id).toBe('catching');
  });

  it('pause skips a step (not recorded) or the whole tutorial, which completes it and exits', () => {
    const { ui, screen, tick, progress, onExit } = setup(sink({ ...emptyProgress(), completedSteps: ['welcome'] }));
    tick(makeInput({ pressed: ['pause'] }));
    const prompt = ui.stack.top;
    if (!(prompt instanceof PromptScreen)) throw new Error('expected the pause prompt');
    prompt.choose('skip');
    expect(screen.step?.id).toBe('passing');
    expect(progress.markStep).not.toHaveBeenCalled();
    tick(makeInput({ pressed: ['pause'] }));
    (ui.stack.top as PromptScreen).choose('skipAll');
    expect(progress.complete).toHaveBeenCalledWith(true);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('finishing the last page completes the tutorial (not skipped)', () => {
    const all = ['welcome', 'movement', 'passing', 'pullBack', 'catching', 'running', 'tackling', 'switch', 'coverage', 'playcalling', 'clock', 'franchise'];
    const { screen, tick, progress, onExit, ui } = setup(sink({ ...emptyProgress(), completedSteps: all }));
    expect(screen.step?.id).toBe('finish');
    screen.render(ui.rc);
    tick(makeInput({ pressed: ['confirm'] }));
    expect(progress.markStep).toHaveBeenCalledWith('finish');
    expect(progress.complete).toHaveBeenCalledWith(false);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('info pages go back with back and render their illustrations', () => {
    const { ui, screen, tick } = setup(sink({ ...emptyProgress(), completedSteps: ['welcome', 'movement', 'passing', 'pullBack', 'catching', 'running', 'tackling', 'switch', 'coverage'] }));
    expect(screen.step?.id).toBe('playcalling');
    tick(makeInput({ pressed: ['confirm'] }));
    expect(screen.machine.page).toBe(1);
    ui.ctx.reset();
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(300);
    tick(makeInput({ pressed: ['back'] }));
    expect(screen.machine.page).toBe(0);
  });

  it('large text: every info page and the interactive header stay on screen', () => {
    const ui = makeUi({ textSize: 'large' });
    ui.services.input = glyphInput();
    const screen = new TutorialScreen({ progress: sink(), onExit: vi.fn(), seed: 2 });
    ui.stack.push(screen);
    const BACKDROP = new Set(['#0f1a12', '#0c150f', '#1b2a1e']);
    const offscreen = (): number => ui.ctx.fills.filter((f) => !BACKDROP.has(f.color.toLowerCase()) && (f.x > 480 || f.y > 270 || f.x + f.w < 0 || f.y + f.h < 0 || f.x + f.w > 481)).length;
    let pages = 0;
    for (let guard = 0; guard < 80 && screen.step; guard++) {
      const step = screen.step;
      ui.ctx.reset();
      screen.render(ui.rc);
      if (step.kind === 'info') {
        expect(offscreen(), `${step.id} page ${screen.machine.page}`).toBe(0);
        pages += 1;
        ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
      } else {
        // The field may paint turf past the edges; the instruction panel and its text may not.
        const ui2 = [ui.rc.theme.colors.text, ui.rc.theme.colors.panel, ui.rc.theme.colors.panelBorder].map((c) => c.toLowerCase());
        const bad = ui.ctx.fills.filter((f) => ui2.includes(f.color.toLowerCase()) && (f.y > 270 || f.y + f.h < 0 || f.x + f.w > 481 || f.x < -1));
        expect(bad.length, step.id).toBe(0);
        screen.machine.skipStep();
      }
    }
    expect(pages).toBe(14);
  });
});
